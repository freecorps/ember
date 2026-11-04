import { describe, expect, it, vi } from "vitest";
import {
  EXPO_PUSH_URL,
  EXPO_RECEIPTS_URL,
  checkPushReceipts,
  expoPushProvider,
  isExpoPushToken,
  sendPush,
  toExpoMessage,
  type PushTicket,
} from "../src/index.ts";

const tok = (i: number) => `ExponentPushToken[tok${i}]`;
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** A fake Expo endpoint: tickets `ok` with id `id-<token>`, except tokens listed in `bad`. */
function fakeExpo(opts: { bad?: Record<string, string>; receipts?: Record<string, unknown> } = {}) {
  const calls: Array<{ url: string; body: any; headers: Record<string, string> }> = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ url: String(url), body, headers: init?.headers as Record<string, string> });
    if (String(url) === EXPO_PUSH_URL) {
      return json({
        data: body.map((m: any) =>
          opts.bad?.[m.to]
            ? { status: "error", message: `"${m.to}" is not registered`, details: { error: opts.bad[m.to] } }
            : { status: "ok", id: `id-${m.to}` },
        ),
      });
    }
    if (String(url) === EXPO_RECEIPTS_URL) {
      const data: Record<string, unknown> = {};
      for (const id of body.ids) if (opts.receipts && id in opts.receipts) data[id] = opts.receipts[id];
      return json({ data });
    }
    return json({ errors: [{ code: "NOT_FOUND", message: "?" }] }, 404);
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

const noSleep = { sleep: async () => {}, retryDelayMs: 1 };

describe("token format", () => {
  it("accepts Expo tokens and rejects the rest", () => {
    expect(isExpoPushToken("ExponentPushToken[abcdefgh]")).toBe(true);
    expect(isExpoPushToken("ExpoPushToken[abcdefgh]")).toBe(true);
    expect(isExpoPushToken("12345678-abcd-abcd-abcd-1234567890ab")).toBe(true);
    expect(isExpoPushToken("ExponentPushToken[]")).toBe(false);
    expect(isExpoPushToken("apns-hex-token")).toBe(false);
    expect(isExpoPushToken(42)).toBe(false);
  });

  it("maps contentAvailable to _contentAvailable and drops undefined fields", () => {
    expect(toExpoMessage({ to: tok(1), title: "hi", body: undefined as unknown as string, contentAvailable: true, data: { a: 1 } })).toEqual({
      to: tok(1),
      title: "hi",
      data: { a: 1 },
      _contentAvailable: true,
    });
  });
});

describe("sendPush", () => {
  it("batches 100 per request, dedups tokens, keeps ticket order and reports unregistered tokens", async () => {
    const tokens = Array.from({ length: 250 }, (_, i) => tok(i));
    const { fetch, calls } = fakeExpo({ bad: { [tok(7)]: "DeviceNotRegistered", [tok(201)]: "MessageRateExceeded" } });
    const r = await sendPush([...tokens, tok(3), "not-a-token"], { title: "New message", body: "hi", data: { channel: "general" } }, {
      fetch,
      accessToken: "secret",
      ratePerSecond: 1e9,
      ...noSleep,
    });
    expect(calls.map((c) => c.body.length)).toEqual([100, 100, 50]);
    expect(calls[0]!.headers.authorization).toBe("Bearer secret");
    expect(calls[0]!.body[0]).toEqual({ to: tok(0), title: "New message", body: "hi", data: { channel: "general" } });
    expect(r.tickets).toHaveLength(251);
    expect(r.tickets[0]).toEqual({ token: tok(0), status: "ok", id: `id-${tok(0)}` });
    expect(r.tickets[7]).toMatchObject({ status: "error", error: "DeviceNotRegistered" });
    expect(r.tickets[201]).toMatchObject({ status: "error", error: "MessageRateExceeded" });
    expect(r.tickets[250]).toMatchObject({ token: "not-a-token", status: "error", error: "InvalidToken" });
    expect(r.unregisteredTokens.sort()).toEqual([tok(7), "not-a-token"].sort());
  });

  it("refuses payloads over 4 KiB without sending them", async () => {
    const { fetch, calls } = fakeExpo();
    const r = await sendPush([tok(1)], { body: "x".repeat(5000) }, { fetch, ...noSleep });
    expect(calls).toHaveLength(0);
    expect(r.tickets[0]).toMatchObject({ status: "error", error: "MessageTooBig" });
    expect(r.unregisteredTokens).toEqual([]);
  });

  it("paces batches to ratePerSecond", async () => {
    let clock = 0;
    const sleeps: number[] = [];
    const { fetch } = fakeExpo();
    await sendPush(
      Array.from({ length: 300 }, (_, i) => tok(i)),
      { body: "x" },
      { fetch, ratePerSecond: 100, now: () => clock, sleep: async (ms) => void (sleeps.push(ms), (clock += ms)) },
    );
    // 3 batches of 100 at 100/s: the 2nd waits 1 s, the 3rd another 1 s.
    expect(sleeps).toEqual([1000, 1000]);
  });

  it("retries 429/5xx (honoring Retry-After) and network errors, then gives up with error tickets", async () => {
    const sleeps: number[] = [];
    let n = 0;
    const fetch = vi.fn(async (_u: unknown, init?: RequestInit) => {
      n++;
      if (n === 1) return json({}, 429, { "retry-after": "2" });
      if (n === 2) throw new Error("socket hang up");
      return json({ data: JSON.parse(String(init!.body)).map(() => ({ status: "ok", id: "x" })) });
    }) as unknown as typeof globalThis.fetch;
    const r = await sendPush([tok(1)], { body: "hi" }, { fetch, retries: 2, retryDelayMs: 10, sleep: async (ms) => void sleeps.push(ms) });
    expect(sleeps).toEqual([2000, 20]);
    expect(r.tickets[0]).toEqual({ token: tok(1), status: "ok", id: "x" });

    const down = vi.fn(async () => json({}, 503)) as unknown as typeof globalThis.fetch;
    const r2 = await sendPush([tok(1), tok(2)], { body: "hi" }, { fetch: down, retries: 1, ...noSleep });
    expect(down).toHaveBeenCalledTimes(2);
    expect(r2.tickets.every((t) => t.status === "error" && t.error === "RequestFailed")).toBe(true);
    expect(r2.unregisteredTokens).toEqual([]);
  });

  it("turns a request-level error into error tickets for that batch only", async () => {
    let n = 0;
    const fetch = vi.fn(async (_u: unknown, init?: RequestInit) => {
      n++;
      if (n === 2) return json({ errors: [{ code: "PUSH_TOO_MANY_EXPERIENCE_IDS", message: "mixed projects" }] }, 400);
      return json({ data: JSON.parse(String(init!.body)).map(() => ({ status: "ok", id: "x" })) });
    }) as unknown as typeof globalThis.fetch;
    const r = await sendPush(
      Array.from({ length: 150 }, (_, i) => tok(i)),
      { body: "hi" },
      { fetch, ratePerSecond: 1e9, ...noSleep },
    );
    expect(r.tickets.slice(0, 100).every((t) => t.status === "ok")).toBe(true);
    expect(r.tickets.slice(100).every((t) => t.status === "error" && t.error === "MismatchSenderId")).toBe(true);
  });
});

describe("checkPushReceipts", () => {
  it("collects receipts, keeps missing ids pending and reports DeviceNotRegistered", async () => {
    const tickets: PushTicket[] = [
      { token: tok(1), status: "ok", id: "a" },
      { token: tok(2), status: "ok", id: "b" },
      { token: tok(3), status: "ok", id: "c" },
      { token: tok(4), status: "error", message: "gone", error: "DeviceNotRegistered" },
    ];
    const { fetch, calls } = fakeExpo({
      receipts: { a: { status: "ok" }, b: { status: "error", message: "not registered", details: { error: "DeviceNotRegistered" } } },
    });
    const r = await checkPushReceipts(tickets, { fetch, ...noSleep });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toEqual({ ids: ["a", "b", "c"] });
    expect(r.receipts).toEqual([
      { token: tok(1), id: "a", status: "ok" },
      { token: tok(2), id: "b", status: "error", message: "not registered", error: "DeviceNotRegistered" },
    ]);
    expect(r.pending).toEqual([{ token: tok(3), id: "c" }]);
    expect(r.unregisteredTokens.sort()).toEqual([tok(2), tok(4)]);
  });

  it("chunks ids by 1000 and leaves a failed chunk pending", async () => {
    let n = 0;
    const fetch = vi.fn(async (_u: unknown, init?: RequestInit) => {
      n++;
      if (n === 2) return json({}, 400);
      const ids: string[] = JSON.parse(String(init!.body)).ids;
      return json({ data: Object.fromEntries(ids.map((id) => [id, { status: "ok" }])) });
    }) as unknown as typeof globalThis.fetch;
    const tickets: PushTicket[] = Array.from({ length: 1500 }, (_, i) => ({ token: tok(i), status: "ok", id: `r${i}` }));
    const r = await expoPushProvider({ fetch, ...noSleep }).checkReceipts!(tickets);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(r.receipts).toHaveLength(1000);
    expect(r.pending).toHaveLength(500);
  });
});
