/**
 * Expo Push Service client (plain HTTPS + JSON, so it runs in a Worker action). Facts (docs.expo.dev, checked in
 * CLOUDFLARE.md §8): 100 messages per request, 600 notifications/s per project, 4096-byte payload, receipts kept
 * 24 h, optional access token ("enhanced push security").
 */
import type {
  AddressedPushMessage,
  PushMessage,
  PushProvider,
  PushReceipt,
  PushTicket,
  ReceiptCheck,
  SendPushResult,
} from "./types.ts";

export const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
export const EXPO_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts";
/** Messages per `send` request. */
export const EXPO_SEND_CHUNK = 100;
/** Ids per `getReceipts` request. */
export const EXPO_RECEIPTS_CHUNK = 1000;
/** Max payload of one notification, in bytes. */
export const EXPO_MAX_PAYLOAD = 4096;

export interface ExpoPushOptions {
  /** Expo access token, required when the project enforces push security. Keep it in a Worker secret. */
  accessToken?: string;
  fetch?: typeof fetch;
  /** Notifications per second across this call (default 600, the per-project limit). */
  ratePerSecond?: number;
  /** Retries of a whole request on 429 / 5xx / network errors (default 2), with exponential backoff. */
  retries?: number;
  /** First retry delay in ms (default 1000); doubles each time. A `Retry-After` header wins. */
  retryDelayMs?: number;
  /** Override endpoints (tests, proxies). */
  sendUrl?: string;
  receiptsUrl?: string;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** `ExponentPushToken[...]` / `ExpoPushToken[...]` (or the older bare UUID form). */
export function isExpoPushToken(token: unknown): token is string {
  if (typeof token !== "string") return false;
  return (
    /^Expo(?:nent)?PushToken\[[^\]]+\]$/.test(token) ||
    /^[a-z\d]{8}-[a-z\d]{4}-[a-z\d]{4}-[a-z\d]{4}-[a-z\d]{12}$/i.test(token)
  );
}

/**
 * The JSON Expo expects for one message. `collapseId`, `threadId` and `interruptionLevel` are Expo fields too and go
 * as they are; `collapseId` is also Expo's Android `tag` (unless one is set) so an Android notification already shown
 * is replaced, as with direct FCM. Fields only the direct transports understand (`urgency`, `encryption`, `voip`,
 * `environment`, `sealed`) are not sent; `urgency` becomes Expo's `priority` when that is not set (`low` → `normal`,
 * else `high`).
 */
export function toExpoMessage(m: AddressedPushMessage): Record<string, unknown> {
  const { contentAvailable, urgency, encryption, voip, environment, sealed, payload, ...rest } = m;
  void payload; // the app's own APNs/FCM payload: Expo builds its own
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(rest)) if (val !== undefined) out[k] = val;
  if (contentAvailable) out._contentAvailable = true;
  if (urgency && out.priority === undefined) out.priority = urgency === "low" ? "normal" : "high";
  if (typeof out.collapseId === "string" && out.tag === undefined) out.tag = out.collapseId;
  return out;
}

const utf8Length = (s: string) => new TextEncoder().encode(s).length;

/** Payload size Expo checks against 4096 B: the notification fields plus `data`. */
export function payloadSize(m: PushMessage): number {
  const { title, subtitle, body, data } = m;
  return utf8Length(JSON.stringify({ title, subtitle, body, data }));
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function chunks<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

class Transport {
  private readonly fetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  /** Earliest time the next batch may start, so the overall rate stays under `ratePerSecond`. */
  private nextAt = 0;
  constructor(private readonly o: ExpoPushOptions) {
    const f = o.fetch ?? globalThis.fetch;
    if (!f) throw new Error("@freecorps/ember-push: no fetch available; pass options.fetch");
    this.fetch = f.bind(globalThis);
    this.sleep = o.sleep ?? defaultSleep;
    this.now = o.now ?? Date.now;
  }

  /** Waits until `count` more notifications fit in the rate budget. */
  async pace(count: number): Promise<void> {
    const rate = this.o.ratePerSecond ?? 600;
    const t = this.now();
    if (this.nextAt > t) await this.sleep(this.nextAt - t);
    this.nextAt = Math.max(this.nextAt, t) + (count / rate) * 1000;
  }

  /** POSTs JSON; retries 429/5xx/network errors. Returns the parsed body or throws with a message. */
  async post(url: string, body: unknown): Promise<any> {
    const retries = this.o.retries ?? 2;
    let delay = this.o.retryDelayMs ?? 1000;
    const headers: Record<string, string> = {
      accept: "application/json",
      "accept-encoding": "gzip, deflate",
      "content-type": "application/json",
    };
    if (this.o.accessToken) headers.authorization = `Bearer ${this.o.accessToken}`;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
      } catch (e) {
        if (attempt >= retries) throw new Error(`request failed: ${(e as Error).message}`);
        await this.sleep(delay);
        delay *= 2;
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const ra = Number(res.headers.get("retry-after"));
        await this.sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : delay);
        delay *= 2;
        continue;
      }
      const text = await res.text();
      let json: any;
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        json = undefined;
      }
      if (!res.ok || !json || json.errors) {
        const err = json?.errors?.[0];
        const msg = err ? `${err.code ?? "error"}: ${err.message ?? ""}`.trim() : `HTTP ${res.status}`;
        throw Object.assign(new Error(msg), { code: err?.code as string | undefined, status: res.status });
      }
      return json;
    }
  }
}

/**
 * Sends `messages` through Expo in chunks of 100, paced to `ratePerSecond`. Never throws for message failures: a
 * malformed token, an oversized payload or a failed request becomes an error ticket for the affected messages.
 */
export async function sendExpoMessages(messages: AddressedPushMessage[], opts: ExpoPushOptions = {}): Promise<PushTicket[]> {
  const transport = new Transport(opts);
  const tickets: PushTicket[] = new Array(messages.length);
  const sendable: Array<{ i: number; m: AddressedPushMessage }> = [];
  messages.forEach((m, i) => {
    if (!isExpoPushToken(m.to)) tickets[i] = { token: String(m.to), status: "error", error: "InvalidToken", message: "not an Expo push token" };
    else if (payloadSize(m) > EXPO_MAX_PAYLOAD)
      tickets[i] = { token: m.to, status: "error", error: "MessageTooBig", message: `payload over ${EXPO_MAX_PAYLOAD} bytes` };
    else sendable.push({ i, m });
  });
  for (const batch of chunks(sendable, EXPO_SEND_CHUNK)) {
    await transport.pace(batch.length);
    try {
      const json = await transport.post(opts.sendUrl ?? EXPO_PUSH_URL, batch.map((b) => toExpoMessage(b.m)));
      const data: any[] = Array.isArray(json.data) ? json.data : [];
      batch.forEach(({ i, m }, k) => {
        const t = data[k];
        if (t?.status === "ok" && typeof t.id === "string") tickets[i] = { token: m.to, status: "ok", id: t.id };
        else if (t?.status === "error") {
          const ticket: PushTicket = { token: m.to, status: "error", message: String(t.message ?? "error") };
          if (t.details?.error) ticket.error = t.details.error;
          tickets[i] = ticket;
        } else tickets[i] = { token: m.to, status: "error", error: "RequestFailed", message: "no ticket in response" };
      });
    } catch (e) {
      const err = e as Error & { code?: string };
      for (const { i, m } of batch) {
        const ticket: PushTicket = { token: m.to, status: "error", error: "RequestFailed", message: err.message };
        if (err.code === "PUSH_TOO_MANY_EXPERIENCE_IDS") ticket.error = "MismatchSenderId";
        tickets[i] = ticket;
      }
    }
  }
  return tickets;
}

const unregistered = (xs: Array<{ status: string; token: string; error?: string }>) => [
  ...new Set(xs.filter((t) => t.status === "error" && (t.error === "DeviceNotRegistered" || t.error === "InvalidToken")).map((t) => t.token)),
];

/**
 * Sends the same `message` to every token (duplicates removed). `unregisteredTokens` lists tokens to delete now;
 * keep the `ok` tickets and call `checkPushReceipts` ~15 min later for the final outcome.
 */
export async function sendPush(tokens: string | Iterable<string>, message: PushMessage, opts: ExpoPushOptions = {}): Promise<SendPushResult> {
  const list = typeof tokens === "string" ? [tokens] : [...new Set(tokens)];
  const tickets = await sendExpoMessages(
    list.map((to) => ({ ...message, to })),
    opts,
  );
  return { tickets, unregisteredTokens: unregistered(tickets) };
}

/**
 * Reads receipts for the `ok` tickets (1000 ids per request). Error tickets count toward `unregisteredTokens`
 * when they say DeviceNotRegistered. A failed receipts request leaves its ids in `pending`.
 */
export async function checkPushReceipts(tickets: PushTicket[], opts: ExpoPushOptions = {}): Promise<ReceiptCheck> {
  const transport = new Transport(opts);
  const ok = tickets.filter((t): t is Extract<PushTicket, { status: "ok" }> => t.status === "ok");
  const receipts: PushReceipt[] = [];
  const pending: Array<{ token: string; id: string }> = [];
  for (const batch of chunks(ok, EXPO_RECEIPTS_CHUNK)) {
    let data: Record<string, any> = {};
    try {
      const json = await transport.post(opts.receiptsUrl ?? EXPO_RECEIPTS_URL, { ids: batch.map((t) => t.id) });
      data = json.data && typeof json.data === "object" ? json.data : {};
    } catch {
      data = {};
    }
    for (const t of batch) {
      const r = data[t.id];
      if (!r) pending.push({ token: t.token, id: t.id });
      else if (r.status === "ok") receipts.push({ token: t.token, id: t.id, status: "ok" });
      else {
        const receipt: PushReceipt = { token: t.token, id: t.id, status: "error", message: String(r.message ?? "error") };
        if (r.details?.error) receipt.error = r.details.error;
        receipts.push(receipt);
      }
    }
  }
  return { receipts, pending, unregisteredTokens: unregistered([...tickets, ...receipts]) };
}

/** Expo Push as a `PushProvider`. */
export function expoPushProvider(opts: ExpoPushOptions = {}): PushProvider {
  return {
    name: "expo",
    isToken: isExpoPushToken,
    send: (messages) => sendExpoMessages(messages, opts),
    checkReceipts: (tickets) => checkPushReceipts(tickets, opts),
  };
}
