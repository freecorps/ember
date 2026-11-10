/**
 * The email component (PLAN §16): install with `defineApp().use(email, { config })`.
 *
 * Sending — `lib:send` is a mutation: called from an app mutation it writes the email row and schedules its
 * delivery in the caller's transaction (all or nothing), at `sendAt` or now. Idempotency keys (per project),
 * suppressions (per project, filled by hard bounces and complaints), and a per-project rate limit (the nested
 * `rateLimit` component, same transaction) are checked there. Delivery (`lib:deliver`, an action) claims the row,
 * renders a stored template if any, and calls Email Service (the `send_email` binding, or the REST API).
 *
 * Events — the component owns a Queue (`events`); an Email Service event subscription on the sending domain points
 * at it, and each delivered/bounced/complained/... event updates the email's status (reactively), deduplicated by
 * eventId, forward-only.
 *
 * Inbound — the component hooks the Worker's `email()` handler: the recipient is routed to a mailbox (support@,
 * privacy@, plus-addressed thread tokens), the raw .eml and attachments go to files (R2), the message is parsed
 * (postal-mime) and threaded, and the app's `onInbound` hook runs in the same transaction (tickets, push).
 *
 * All the component's state lives in ONE shard (`config.shard`, default `global:main`): the queue and email()
 * hooks write there, so app code that calls `send` must run on that shard too.
 */
import { componentBuilders, cronJobs, defineComponent, EmberError, v, type GenericId } from "@freecorps/ember-server";
import { rateLimit } from "@freecorps/ember-rate-limit";
import {
  bareMessageId,
  domainOf,
  isNoReplySender,
  parseAddress,
  parseAddressList,
  replySubject,
  splitPlus,
  subjectKey,
  normalizeMessageId,
  withPlus,
  type EmailAddress,
} from "./address.ts";
import { nextStatus, parseDeliveryEvent, type DeliveryEvent, type EmailStatus } from "./events.ts";
import { parseInbound, snippetOf } from "./mime.ts";
import { addressV, emailSchema, errorV } from "./schema.ts";
import { checkTemplate, emailLayout, escapeHtml, htmlToText, renderStored, renderTemplate, textToHtml, type LayoutOptions, type StoredTemplate } from "./template.ts";
import { bindingTransport, restTransport, TransportError, type OutboundAttachment, type OutboundMessage, type Transport } from "./transport.ts";

export type EmailInstallConfig = {
  /** The shard holding the component's state (default "global:main"). */
  shard?: string;
  /** "binding" (default): the `send_email` binding; "rest": the Email Sending REST API (token + account id env). */
  transport?: "binding" | "rest";
  /** Binding name (default "EMAIL"); deploy adds it. */
  binding?: string;
  /** Restricts the binding to these senders (send_email `allowed_sender_addresses`). */
  allowedSenders?: string[];
  /** Env vars of the REST transport (defaults CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN). */
  restAccountEnv?: string;
  restTokenEnv?: string;
  /** Inbound domains this install owns (its email() hook only matches them; empty = any address with a mailbox). */
  domains?: string[];
  /** Inbound size cap in bytes (default 25 MiB, the Email Routing limit). */
  maxInboundBytes?: number;
  /** Keep the raw .eml in files (default true; needs the files bucket). */
  storeRaw?: boolean;
  /** Per-project send limit (token bucket). */
  rateLimit?: { rate: number; period: number; capacity?: number };
  /** Delivery attempts before an email fails (default 5). */
  maxAttempts?: number;
  /** Inbound messages per sender per hour before a new thread is filed as spam (default 20). */
  spamPerHour?: number;
  /** Function handles (`createFunctionHandle(internal.x.y)`) of app mutations called in the same transaction. */
  hooks?: { onInbound?: string; onEvent?: string };
  /** Default layout for stored templates without one. */
  layout?: LayoutOptions;
  /**
   * Put the thread's token in the Reply-To of inbox replies, composed emails and auto-replies (`support+t_…@`).
   * Default false: the email goes with no Reply-To, and the answer joins the thread by the Message-ID the provider
   * gave the sent email (In-Reply-To / References), else by contact + subject. A token in an old email's Reply-To
   * still threads either way.
   */
  replyToken?: boolean;
};

const configV = v.optional(
  v.object({
    shard: v.optional(v.string()),
    transport: v.optional(v.union(v.literal("binding"), v.literal("rest"))),
    binding: v.optional(v.string()),
    allowedSenders: v.optional(v.array(v.string())),
    restAccountEnv: v.optional(v.string()),
    restTokenEnv: v.optional(v.string()),
    domains: v.optional(v.array(v.string())),
    maxInboundBytes: v.optional(v.number()),
    storeRaw: v.optional(v.boolean()),
    rateLimit: v.optional(v.object({ rate: v.number(), period: v.number(), capacity: v.optional(v.number()) })),
    maxAttempts: v.optional(v.number()),
    spamPerHour: v.optional(v.number()),
    hooks: v.optional(v.object({ onInbound: v.optional(v.string()), onEvent: v.optional(v.string()) })),
    layout: v.optional(v.any()),
    replyToken: v.optional(v.boolean()),
  }),
);

const { query, mutation, internalQuery, internalMutation, internalAction } = componentBuilders<typeof emailSchema, EmailInstallConfig | undefined>();

const MAX_RECIPIENTS = 50;
const MAX_INBOUND = 25 * 1024 * 1024;
const LEASE_MS = 10 * 60_000;
const DAY = 86_400_000;

type Ctx = { db: any; now: number; component: { config: EmailInstallConfig | undefined }; random(): number; scheduler: any; runMutation: any; runQuery: any };
type EmailDoc = Record<string, any> & { _id: GenericId<"emails"> };

const cfg = (ctx: { component: { config: EmailInstallConfig | undefined } }): EmailInstallConfig => ctx.component.config ?? {};
const fail = (code: string, message: string): never => {
  throw new EmberError(code as any, message);
};

// ------------------------------------------------------------------------------------------------ sending

const sendArgs = {
  project: v.optional(v.string()),
  from: v.union(v.string(), addressV),
  to: v.union(v.string(), addressV, v.array(v.union(v.string(), addressV))),
  cc: v.optional(v.union(v.string(), addressV, v.array(v.union(v.string(), addressV)))),
  bcc: v.optional(v.union(v.string(), addressV, v.array(v.union(v.string(), addressV)))),
  replyTo: v.optional(v.union(v.string(), addressV)),
  subject: v.optional(v.string()),
  html: v.optional(v.string()),
  text: v.optional(v.string()),
  headers: v.optional(v.record(v.string())),
  /** Files already stored in this shard (`ctx.storage`). */
  attachments: v.optional(
    v.array(v.object({ filename: v.string(), contentType: v.string(), file: v.file(), contentId: v.optional(v.string()), inline: v.optional(v.boolean()) })),
  ),
  /** A stored template (`upsertTemplate`) and its data: fills subject/html/text at delivery. */
  template: v.optional(v.object({ name: v.string(), data: v.optional(v.any()) })),
  tags: v.optional(v.record(v.string())),
  idempotencyKey: v.optional(v.string()),
  /** Send at this time (ms) instead of now. */
  sendAt: v.optional(v.number()),
  threadId: v.optional(v.string()),
};

export type SendInput = {
  project?: string;
  from: string | EmailAddress;
  to: string | EmailAddress | Array<string | EmailAddress>;
  cc?: string | EmailAddress | Array<string | EmailAddress>;
  bcc?: string | EmailAddress | Array<string | EmailAddress>;
  replyTo?: string | EmailAddress;
  subject?: string;
  html?: string;
  text?: string;
  headers?: Record<string, string>;
  attachments?: Array<{ filename: string; contentType: string; file: string; contentId?: string; inline?: boolean }>;
  template?: { name: string; data?: unknown };
  tags?: Record<string, string>;
  idempotencyKey?: string;
  sendAt?: number;
  threadId?: string;
};
export type SendResult = { id: string; status: EmailStatus; duplicate?: true; suppressed?: string[] };

const HEADER_NAME = /^[A-Za-z0-9-]{1,100}$/;
/**
 * Files already stored in this shard, for an inbox reply or a composed email. `link: true`: too large to attach; the
 * caller puts a download link in the text, the email carries no MIME part, and the message still holds the file.
 */
const inboxAttachmentsV = v.optional(v.array(v.object({ filename: v.string(), contentType: v.string(), file: v.file(), link: v.optional(v.boolean()) })));
type InboxAttachment = { filename: string; contentType: string; file: string; link?: boolean };

/** The Reply-To of an email in a thread: the token address only when the install asks for it (`replyToken`). */
const threadReplyTo = (ctx: Ctx, mb: { address: string }, thread: { token: string }) => (cfg(ctx).replyToken ? { replyTo: withPlus(mb.address, `t_${thread.token}`) } : {});

/** The MIME attachments of the email: every file not sent as a link. */
const mimeParts = (list: InboxAttachment[] | undefined) => (list ?? []).filter((a) => !a.link).map(({ filename, contentType, file }) => ({ filename, contentType, file }));

/** The stored message's attachment rows (size from the file's metadata when known). */
/** The most messages one Sent page reads past its cursor's millisecond (no mailbox sends this many in one ms). */
const SENT_MAX_FETCH = 10_000;

/** The Sent view's cursor: a message's time and id (`<at>:<id>`), opaque to callers. */
function sentCursor(m: { at: number; _id: string }): string {
  return `${m.at}:${m._id}`;
}
function parseSentCursor(raw: string | undefined): { at: number; id: string } | null {
  if (raw === undefined) return null;
  const k = raw.indexOf(":");
  const at = Number(raw.slice(0, k));
  if (k <= 0 || !Number.isFinite(at) || k === raw.length - 1) fail("ValidationError", "before: not a cursor this query gave");
  return { at, id: raw.slice(k + 1) };
}
/** Whether message `x` comes after `m` in the by_sender order (time, then creation, then id). */
function isAfter(x: { at: number; _creationTime: number; _id: string }, m: { at: number; _creationTime: number; _id: string }): boolean {
  if (x.at !== m.at) return x.at > m.at;
  if (x._creationTime !== m._creationTime) return x._creationTime > m._creationTime;
  return x._id > m._id;
}

function attachmentRows(ctx: Ctx, list: InboxAttachment[] | undefined) {
  return (list ?? []).map((a) => {
    const meta = (ctx as any).storage?.getMetadata?.(a.file) as { size: number | null } | null | undefined;
    return { filename: a.filename, contentType: a.contentType, file: a.file, ...(meta?.size != null ? { size: meta.size } : {}), ...(a.link ? { link: true } : {}) };
  });
}

const RESERVED_HEADERS = new Set(["from", "to", "cc", "bcc", "subject", "reply-to", "content-type", "mime-version", "content-transfer-encoding"]);

function doSend(ctx: Ctx, a: SendInput): SendResult {
  const project = a.project ?? "default";
  if (a.idempotencyKey !== undefined) {
    if (!a.idempotencyKey || a.idempotencyKey.length > 256) fail("ValidationError", "idempotencyKey must be 1..256 characters");
    const prev = ctx.db.query("emails").withIndex("by_project_key", (q: any) => q.eq("project", project).eq("idempotencyKey", a.idempotencyKey)).first();
    if (prev) return { id: prev._id, status: prev.status, duplicate: true };
  }
  let from: EmailAddress, to: EmailAddress[], cc: EmailAddress[], bcc: EmailAddress[], replyTo: EmailAddress | undefined;
  try {
    from = parseAddress(a.from);
    to = parseAddressList(a.to);
    cc = parseAddressList(a.cc);
    bcc = parseAddressList(a.bcc);
    replyTo = a.replyTo ? parseAddress(a.replyTo) : undefined;
  } catch (e) {
    return fail("ValidationError", (e as Error).message);
  }
  if (!to.length) fail("ValidationError", "to: at least one recipient");
  if (to.length + cc.length + bcc.length > MAX_RECIPIENTS) fail("ValidationError", `at most ${MAX_RECIPIENTS} recipients (to + cc + bcc)`);
  if (!a.template && !a.subject) fail("ValidationError", "subject is required (or a template)");
  if (!a.template && a.html === undefined && a.text === undefined) fail("ValidationError", "html or text is required (or a template)");
  if ((a.subject ?? "").length > 998) fail("ValidationError", "subject: at most 998 characters");
  for (const [k, val] of Object.entries(a.headers ?? {})) {
    if (!HEADER_NAME.test(k) || RESERVED_HEADERS.has(k.toLowerCase())) fail("ValidationError", `header ${k}: use the API field instead`);
    if (/[\r\n]/.test(val) || val.length > 2048) fail("ValidationError", `header ${k}: invalid value`);
  }
  if (a.template && !ctx.db.query("templates").withIndex("by_project_name", (q: any) => q.eq("project", project).eq("name", a.template!.name)).first()) {
    fail("ValidationError", `template ${a.template.name} not found`);
  }
  // Suppressions: drop suppressed recipients; a suppressed address is never stored in a field that is delivered.
  // Every To suppressed: the remaining Cc become the To (they were visible recipients already). Bcc are never
  // promoted (that would show them to each other), so with only Bcc left — or nobody — the email is "suppressed"
  // (not sent, not counted).
  const { to: toK, cc: ccK, bcc: bccK, dropped } = withoutSuppressed(ctx, project, to, cc, bcc);
  const allSuppressed = toK.length === 0;
  const c = cfg(ctx);
  if (c.rateLimit && !allSuppressed) {
    const r = ctx.runMutation("@rateLimit/lib:limit", {
      name: "send",
      key: project,
      config: { kind: "token bucket", rate: c.rateLimit.rate, period: c.rateLimit.period, ...(c.rateLimit.capacity !== undefined ? { capacity: c.rateLimit.capacity } : {}) },
    }) as { ok: boolean; retryAfter?: number };
    if (!r.ok) throw new EmberError("RateLimited" as any, `rate limit for project ${project}: retry after ${Math.ceil((r.retryAfter ?? 0) / 1000)} s`);
  }
  const sendAt = Math.max(ctx.now, a.sendAt ?? ctx.now);
  const status: EmailStatus = allSuppressed ? "suppressed" : sendAt > ctx.now ? "scheduled" : "queued";
  const id = ctx.db.insert("emails", {
    project,
    from,
    to: toK,
    ...(ccK.length ? { cc: ccK } : {}),
    ...(bccK.length ? { bcc: bccK } : {}),
    ...(replyTo ? { replyTo } : {}),
    subject: a.subject ?? "",
    ...(a.html !== undefined ? { html: a.html } : {}),
    ...(a.text !== undefined ? { text: a.text } : {}),
    ...(a.headers && Object.keys(a.headers).length ? { headers: a.headers } : {}),
    ...(a.attachments?.length ? { attachments: a.attachments } : {}),
    ...(a.template ? { template: { name: a.template.name, data: a.template.data ?? {} } } : {}),
    ...(a.tags ? { tags: a.tags } : {}),
    ...(a.idempotencyKey !== undefined ? { idempotencyKey: a.idempotencyKey } : {}),
    ...(dropped.length ? { suppressed: dropped } : {}),
    ...(a.threadId ? { threadId: a.threadId } : {}),
    status,
    sendAt,
    attempts: 0,
  });
  if (!allSuppressed) {
    const jobId = ctx.scheduler.runAt(sendAt, "lib:deliver", { emailId: id });
    ctx.db.patch(id, { jobId });
  }
  return { id, status, ...(dropped.length ? { suppressed: dropped } : {}) };
}

/** Builds the provider message from an email row (template rendered, attachments read). */
async function outbound(ctx: any, e: EmailDoc): Promise<OutboundMessage> {
  let subject = e.subject as string;
  let html = e.html as string | undefined;
  let text = e.text as string | undefined;
  if (e.template) {
    const t = (await ctx.runQuery("lib:templateFor", { project: e.project, name: e.template.name })) as (StoredTemplate & { layout?: LayoutOptions }) | null;
    if (!t) throw new TransportError(`template ${e.template.name} not found`, "E_TEMPLATE", true);
    const layout = t.layout ?? cfg(ctx).layout;
    const r = renderStored({ ...t, ...(layout ? { layout } : {}) }, (e.template.data ?? {}) as Record<string, unknown>);
    subject = subject || r.subject;
    html = r.html;
    text = r.text;
  } else if (html !== undefined && text === undefined) text = htmlToText(html);
  const attachments: OutboundAttachment[] = [];
  for (const a of (e.attachments ?? []) as Array<{ filename: string; contentType: string; file: string; contentId?: string; inline?: boolean }>) {
    const f = await ctx.storage.get(a.file);
    if (!f) throw new TransportError(`attachment ${a.filename} is not stored`, "E_ATTACHMENT", true);
    const bytes = new Uint8Array(await new Response(f.body).arrayBuffer());
    attachments.push({ filename: a.filename, contentType: a.contentType, content: base64(bytes), disposition: a.inline ? "inline" : "attachment", ...(a.contentId ? { contentId: a.contentId } : {}) });
  }
  return {
    from: e.from,
    to: e.to,
    ...(e.cc?.length ? { cc: e.cc } : {}),
    ...(e.bcc?.length ? { bcc: e.bcc } : {}),
    ...(e.replyTo ? { replyTo: e.replyTo } : {}),
    subject,
    ...(html !== undefined ? { html } : {}),
    ...(text !== undefined ? { text } : {}),
    ...(e.headers ? { headers: e.headers } : {}),
    ...(attachments.length ? { attachments } : {}),
  };
}

function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** The transport of this install (tests and apps can override it with `setEmailTransport`). */
let transportOverride: ((ctx: { env: Record<string, unknown>; component: { config: EmailInstallConfig | undefined } }) => Transport) | null = null;
/** Replaces the outbound transport (tests, local development without Email Service). `null` restores the default. */
export function setEmailTransport(t: typeof transportOverride): void {
  transportOverride = t;
}

function transportFor(ctx: { env: Record<string, unknown>; component: { config: EmailInstallConfig | undefined } }): Transport {
  if (transportOverride) return transportOverride(ctx);
  const c = cfg(ctx);
  if (c.transport === "rest") {
    const accountId = ctx.env[c.restAccountEnv ?? "CLOUDFLARE_ACCOUNT_ID"];
    const apiToken = ctx.env[c.restTokenEnv ?? "CLOUDFLARE_API_TOKEN"];
    if (typeof accountId !== "string" || typeof apiToken !== "string") throw new TransportError("REST transport: account id / API token env vars are not set", "E_CONFIG", true);
    return restTransport({ accountId, apiToken });
  }
  const b = ctx.env[c.binding ?? "EMAIL"] as { send?: unknown } | undefined;
  if (!b || typeof b.send !== "function") throw new TransportError(`no send_email binding ${c.binding ?? "EMAIL"} on the Worker`, "E_CONFIG", true);
  return bindingTransport(b as never);
}

/** Headers Email Service refuses are dropped on the retry: threading and X- headers are kept first. */
function fallbackHeaders(h: Record<string, string> | undefined, round: number): Record<string, string> | undefined {
  if (!h) return undefined;
  if (round >= 2) return undefined;
  const keep = Object.entries(h).filter(([k]) => /^(x-|in-reply-to$|references$)/i.test(k));
  return keep.length ? Object.fromEntries(keep) : undefined;
}

/**
 * Recipients minus this project's suppressions. Every To suppressed: the remaining Cc become the To (they were
 * visible recipients already); Bcc are never promoted (that would show them to each other). An empty `to` means
 * nobody may receive the email. Used at send time and again when a delivery claims the email, so an address that
 * bounced or complained while the email waited (scheduled, or in retry backoff) is not sent to.
 */
function withoutSuppressed(ctx: any, project: string, to: EmailAddress[], cc: EmailAddress[], bcc: EmailAddress[]) {
  const isSuppressed = (e: string) => !!ctx.db.query("suppressions").withIndex("by_project_email", (q: any) => q.eq("project", project).eq("email", e)).first();
  const dropped: string[] = [];
  const keep = (list: EmailAddress[]) => list.filter((x) => (isSuppressed(x.email) ? (dropped.push(x.email), false) : true));
  let toK = keep(to);
  let ccK = keep(cc);
  const bccK = keep(bcc);
  if (!toK.length && ccK.length) [toK, ccK] = [ccK, []];
  return { to: toK, cc: ccK, bcc: bccK, dropped };
}

async function deliver(ctx: any, emailId: string) {
  const e = (await ctx.runMutation("lib:claim", { emailId })) as EmailDoc | null;
  if (!e) return { skipped: true };
  const max = cfg(ctx).maxAttempts ?? 5;
  let msg: OutboundMessage;
  try {
    msg = await outbound(ctx, e);
  } catch (err) {
    const t = err instanceof TransportError ? err : new TransportError((err as Error).message, "E_RENDER", true);
    await ctx.runMutation("lib:finish", { emailId, outcome: "failed", error: { code: t.code, message: t.message } });
    return { failed: t.code };
  }
  const transport = transportFor(ctx);
  const dropped: string[] = [];
  for (let round = 0; ; round++) {
    try {
      const r = await transport.send(msg);
      await ctx.runMutation("lib:finish", { emailId, outcome: "sent", messageId: r.messageId, ...(dropped.length ? { droppedHeaders: dropped } : {}) });
      return { messageId: r.messageId };
    } catch (err) {
      const t = err instanceof TransportError ? err : new TransportError((err as Error)?.message ?? String(err), "E_UNKNOWN", false);
      if (/^E_HEADER/.test(t.code) && msg.headers && round < 2) {
        const next = fallbackHeaders(msg.headers, round + 1);
        dropped.push(...Object.keys(msg.headers).filter((k) => !next || !(k in next)));
        msg = { ...msg, ...(next ? { headers: next } : {}) };
        if (!next) delete (msg as { headers?: unknown }).headers;
        continue;
      }
      const error = { code: t.code, message: t.message.slice(0, 500) };
      if (t.permanent || e.attempts >= max) await ctx.runMutation("lib:finish", { emailId, outcome: "failed", error });
      else await ctx.runMutation("lib:finish", { emailId, outcome: "retry", error, retryInMs: Math.min(3_600_000, 30_000 * 2 ** (e.attempts - 1)) });
      return { error };
    }
  }
}

// ------------------------------------------------------------------------------------------------ events

function applyEvent(ctx: Ctx, ev: DeliveryEvent) {
  const seen = ctx.db.query("events").withIndex("by_event", (q: any) => q.eq("eventId", ev.eventId)).first();
  if (seen) {
    ctx.db.patch(seen._id, { duplicates: (seen.duplicates ?? 0) + 1 });
    return { duplicate: true };
  }
  const e = ctx.db.query("emails").withIndex("by_message_id", (q: any) => q.eq("messageId", ev.messageId)).first() as EmailDoc | null;
  ctx.db.insert("events", {
    eventId: ev.eventId,
    ...(e ? { emailId: e._id } : {}),
    messageId: ev.messageId,
    type: ev.type,
    ...(ev.recipient ? { recipient: ev.recipient } : {}),
    terminal: ev.terminal,
    at: ev.at,
    receivedAt: ctx.now,
    ...(ev.reason ? { reason: ev.reason } : {}),
    ...(ev.bounceType ? { bounceType: ev.bounceType } : {}),
    ...(ev.smtpStatus ? { smtpStatus: ev.smtpStatus } : {}),
    raw: ev.raw,
  });
  if (!e) return { unknown: true };
  return { status: applyToEmail(ctx, e, ev) };
}

type LinkedEvent = Pick<DeliveryEvent, "type" | "recipient" | "at" | "bounceType">;

/**
 * What an event does to its email: status (forward-only), suppression on a hard bounce or complaint, and the app's
 * onEvent hook. Shared by `applyEvent` and by `finish` for events that arrived before the send was recorded, so a
 * racing bounce or complaint still suppresses the address.
 */
function applyToEmail(ctx: Ctx, e: EmailDoc, ev: LinkedEvent): EmailStatus {
  const status = nextStatus(e.status as EmailStatus, ev.type);
  ctx.db.patch(e._id, { status, lastEventAt: Math.max(e.lastEventAt ?? 0, ev.at) });
  // Hard bounces and complaints suppress the recipient for this project.
  const hard = (ev.type === "bounced" && ev.bounceType !== "soft") || ev.type === "complained";
  if (hard && ev.recipient) {
    const reason = ev.type === "complained" ? "complaint" : "hard_bounce";
    const prev = ctx.db.query("suppressions").withIndex("by_project_email", (q: any) => q.eq("project", e.project).eq("email", ev.recipient)).first();
    if (!prev) ctx.db.insert("suppressions", { project: e.project, email: ev.recipient, reason, source: e._id, at: ctx.now });
  }
  const hook = cfg(ctx).hooks?.onEvent;
  if (hook) {
    try {
      ctx.runMutation(hook, { emailId: e._id, project: e.project, type: ev.type, status, recipient: ev.recipient, tags: e.tags ?? {} });
    } catch (err) {
      console.error(`ember email: onEvent hook failed for ${e._id}: ${(err as Error).message}`);
    }
  }
  return status;
}

// ------------------------------------------------------------------------------------------------ inbound

const THREAD_WINDOW = 30 * DAY;

/** The catch-all mailbox of `domain`, if one is set. */
function catchAllOf(ctx: Ctx, domain: string): { name: string; address: string } | null {
  return (ctx.db.query("mailboxes").collect() as Array<{ name: string; address: string; catchAll?: boolean }>).find((m) => m.catchAll && domainOf(m.address) === domain) ?? null;
}

function routeOf(ctx: Ctx, to: string): { mailbox: string; tag: string | null } | null {
  const { base, tag } = splitPlus(to.toLowerCase());
  const m = ctx.db.query("mailboxes").withIndex("by_address", (q: any) => q.eq("address", base)).first();
  if (m) return { mailbox: m.name, tag };
  // No mailbox has that address: its domain's catch-all takes it (the address it was sent to stays in its To).
  const all = catchAllOf(ctx, domainOf(base));
  return all ? { mailbox: all.name, tag: null } : null;
}

function token(ctx: Ctx): string {
  const abc = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 12; i++) s += abc[Math.floor(ctx.random() * abc.length)];
  return s;
}

type IngestArgs = {
  mailbox: string;
  tag?: string;
  envelopeFrom: string;
  messageId?: string;
  inReplyTo?: string;
  references: string[];
  /** As written (see `messages.messageIdRaw`); older callers omit them and the lowercased ids are used. */
  messageIdRaw?: string;
  referencesRaw?: string[];
  from: EmailAddress;
  replyTo?: EmailAddress;
  to: EmailAddress[];
  cc: EmailAddress[];
  subject: string;
  text: string;
  html?: string;
  truncated: boolean;
  raw?: string;
  attachments: Array<{ filename: string; contentType: string; file: string; size?: number; contentId?: string; inline?: boolean }>;
  droppedAttachments: number;
  auth: { spf: string; dkim: string; dmarc: string };
  autoSubmitted: boolean;
  date?: number;
};

function ingest(ctx: Ctx, a: IngestArgs) {
  const mb = ctx.db.query("mailboxes").withIndex("by_name", (q: any) => q.eq("name", a.mailbox)).first();
  if (!mb) fail("NotFound", `mailbox ${a.mailbox} not found`);
  // Redelivery of the same message: nothing new.
  if (a.messageId) {
    const dup = ctx.db.query("messages").withIndex("by_message_id", (q: any) => q.eq("mailbox", a.mailbox).eq("messageIdHeader", a.messageId)).first();
    if (dup) return { duplicate: true, threadId: dup.threadId, messageId: dup._id };
  }
  const contact = (a.replyTo ?? a.from).email;
  const key = subjectKey(a.subject);
  // Threading, in order: (1) the plus-address token (trusted from any sender); (2) In-Reply-To/References when
  // DMARC passed and the sender is the thread's contact; (3) same contact + subject, recent, not closed/spam.
  let thread: any = null;
  if (a.tag?.startsWith("t_")) thread = ctx.db.query("threads").withIndex("by_token", (q: any) => q.eq("token", a.tag!.slice(2))).first();
  if (thread && thread.mailbox !== a.mailbox) thread = null;
  if (!thread) {
    for (const ref of [a.inReplyTo, ...a.references.slice().reverse()].filter(Boolean) as string[]) {
      const m = ctx.db.query("messages").withIndex("by_message_id", (q: any) => q.eq("mailbox", a.mailbox).eq("messageIdHeader", ref)).first();
      if (!m) continue;
      const t = ctx.db.get(m.threadId);
      if (!t) continue;
      // An answer to an email this mailbox sent: its Message-ID went only to that email's recipients, so it joins
      // when the sender is the contact or one of them, DMARC or not (forwarders break DMARC). A reference to an
      // inbound message is public (anyone in the conversation has it): DMARC must pass and the From be the contact.
      // Who sent it is the From address, never the Reply-To: anyone writes a Reply-To, and DMARC vouches for the
      // From's domain only.
      const sender = a.from.email;
      const sentTo = m.direction === "outbound" ? [...(m.to ?? []), ...(m.cc ?? [])].map((x: EmailAddress) => x.email) : [];
      const ok = m.direction === "outbound" ? sender === t.contact || sentTo.includes(sender) : a.auth.dmarc === "pass" && sender === t.contact;
      // Otherwise keep looking (an older reference may be this contact's own thread).
      if (ok) {
        thread = t;
        break;
      }
    }
  }
  if (!thread && key) {
    const t = ctx.db
      .query("threads")
      .withIndex("by_contact_subject", (q: any) => q.eq("mailbox", a.mailbox).eq("contact", contact).eq("subjectKey", key))
      .order("desc")
      .first();
    if (t && t.status !== "closed" && t.status !== "spam" && ctx.now - t.lastMessageAt < THREAD_WINDOW) thread = t;
  }
  // Spam: too many messages from this sender in the last hour.
  const recent = ctx.db
    .query("messages")
    .withIndex("by_sender", (q: any) => q.eq("mailbox", a.mailbox).eq("fromEmail", a.from.email).gt("at", ctx.now - 3_600_000))
    .take((cfg(ctx).spamPerHour ?? 20) + 1).length;
  const spam = recent >= (cfg(ctx).spamPerHour ?? 20);
  const snippet = snippetOf(a.text);
  const isNew = !thread;
  if (!thread) {
    const number = mb.nextNumber;
    ctx.db.patch(mb._id, { nextNumber: number + 1 });
    const id = ctx.db.insert("threads", {
      mailbox: a.mailbox,
      number,
      subject: a.subject || "(no subject)",
      subjectKey: key,
      contact,
      ...((a.replyTo ?? a.from).name ? { contactName: (a.replyTo ?? a.from).name } : {}),
      status: spam ? "spam" : "open",
      activityAt: ctx.now,
      token: token(ctx),
      messageCount: 0,
      unreadCount: 0,
      lastMessageAt: ctx.now,
      snippet,
    });
    thread = ctx.db.get(id);
  }
  // The Message-ID as written, when it is the same id as the lookup one.
  const idRaw = a.messageId && a.messageIdRaw?.toLowerCase() === a.messageId ? a.messageIdRaw : undefined;
  const msgId = ctx.db.insert("messages", {
    threadId: thread._id,
    mailbox: a.mailbox,
    direction: "inbound",
    ...(a.messageId ? { messageIdHeader: a.messageId } : {}),
    ...(a.inReplyTo ? { inReplyTo: a.inReplyTo } : {}),
    references: a.references.slice(-100),
    ...(idRaw ? { messageIdRaw: idRaw } : {}),
    ...(a.referencesRaw?.length ? { referencesRaw: a.referencesRaw.slice(-100) } : {}),
    from: a.from,
    fromEmail: a.from.email,
    to: a.to,
    cc: a.cc,
    subject: a.subject,
    text: a.text,
    ...(a.html ? { html: a.html } : {}),
    snippet,
    searchText: `${a.subject}\n${a.from.name ?? ""} ${a.from.email}\n${a.text}`.slice(0, 100_000),
    ...(a.truncated ? { truncated: true } : {}),
    ...(a.raw ? { raw: a.raw } : {}),
    attachments: a.attachments,
    ...(a.droppedAttachments ? { droppedAttachments: a.droppedAttachments } : {}),
    auth: a.auth,
    autoSubmitted: a.autoSubmitted,
    at: ctx.now,
  });
  // A new message reopens a waiting/closed conversation (spam stays spam).
  const status = thread.status === "spam" ? "spam" : "open";
  ctx.db.patch(thread._id, {
    status,
    activityAt: ctx.now,
    messageCount: thread.messageCount + 1,
    unreadCount: thread.unreadCount + 1,
    lastMessageAt: ctx.now,
    lastInboundAt: ctx.now,
    snippet,
  });
  // Auto-reply: new conversations only, never to automated mail, no-reply senders or spam.
  let autoReplyId: string | null = null;
  if (mb.autoReply && isNew && !spam && !a.autoSubmitted && !isNoReplySender(contact)) {
    const data = { number: thread.number, subject: thread.subject, name: (a.replyTo ?? a.from).name ?? "", mailbox: mb.displayName ?? mb.address };
    const text = renderTemplateSafe(mb.autoReply.text, data, false);
    // In a savepoint, and never fatal: a rate-limited or invalid auto-reply must not lose the inbound message.
    try {
      autoReplyId = (ctx.runMutation("lib:send", {
      project: `mailbox:${a.mailbox}`,
      from: { email: mb.address, ...(mb.displayName ? { name: mb.displayName } : {}) },
      to: contact,
      ...threadReplyTo(ctx as unknown as Ctx, mb, thread),
      subject: renderTemplateSafe(mb.autoReply.subject, data, false),
      text,
      html: mb.autoReply.html ? emailLayout(renderTemplateSafe(mb.autoReply.html, data, true)) : emailLayout(textToHtml(text)),
      headers: { "Auto-Submitted": "auto-replied", ...(a.messageId ? { "In-Reply-To": `<${idRaw ?? a.messageId}>`, References: `<${idRaw ?? a.messageId}>` } : {}) },
      threadId: thread._id,
    }) as SendResult).id;
    } catch (e) {
      console.warn(`ember email: auto-reply for thread ${thread._id} skipped: ${(e as Error).message}`);
    }
  }
  const event = {
    threadId: thread._id,
    messageId: msgId,
    mailbox: a.mailbox,
    number: thread.number,
    newThread: isNew,
    status,
    from: a.from,
    subject: a.subject,
    snippet,
    autoSubmitted: a.autoSubmitted,
  };
  // The app's hook runs in a savepoint of this transaction; if it throws, its writes are undone and logged, but
  // the message stays filed (an app bug must not bounce customer mail).
  const hook = cfg(ctx).hooks?.onInbound;
  if (hook) {
    try {
      ctx.runMutation(hook, event);
    } catch (e) {
      console.error(`ember email: onInbound hook failed for thread ${thread._id}: ${(e as Error).message}`);
    }
  }
  return { ...event, autoReplyId };
}

/** A message's Message-ID as its sender wrote it (the lowercased one for messages stored before 0.5.9). */
function citedId(m: { messageIdHeader?: string; messageIdRaw?: string }): string | null {
  return m.messageIdRaw ?? m.messageIdHeader ?? null;
}

/** A message's References as written, when they were kept for every id (else the lowercased ones). */
function citedRefs(m: { references: string[]; referencesRaw?: string[] }): string[] {
  const raw = m.referencesRaw;
  return raw && raw.length === m.references.length && raw.every((r, i) => r.toLowerCase() === m.references[i]) ? raw : m.references;
}

function renderTemplateSafe(src: string, data: Record<string, unknown>, escape: boolean) {
  try {
    return renderTemplate(src, data, { escape });
  } catch {
    return src;
  }
}

function appendOutbound(ctx: Ctx, thread: any, mb: any, a: { text: string; html?: string; emailId?: string; author?: string; note?: boolean; to: EmailAddress[]; cc?: EmailAddress[]; attachments?: ReturnType<typeof attachmentRows> }) {
  const from: EmailAddress = { email: mb.address, ...(mb.displayName ? { name: mb.displayName } : {}) };
  const snippet = snippetOf(a.text);
  const id = ctx.db.insert("messages", {
    threadId: thread._id,
    mailbox: thread.mailbox,
    direction: a.note ? "note" : "outbound",
    references: [],
    from,
    fromEmail: from.email,
    to: a.to,
    cc: a.cc ?? [],
    subject: thread.subject,
    text: a.text,
    ...(a.html ? { html: a.html } : {}),
    snippet,
    searchText: `${thread.subject}\n${a.author ?? ""}\n${a.text}${(a.attachments ?? []).map((x) => `\n${x.filename}`).join("")}`.slice(0, 100_000),
    attachments: a.attachments ?? [],
    autoSubmitted: false,
    ...(a.emailId ? { emailId: a.emailId } : {}),
    ...(a.author ? { author: a.author } : {}),
    at: ctx.now,
  });
  ctx.db.patch(thread._id, {
    messageCount: thread.messageCount + 1,
    lastMessageAt: ctx.now,
    activityAt: ctx.now,
    ...(a.note ? {} : { status: thread.status === "spam" ? "spam" : "waiting", snippet }),
  });
  return id;
}

const DAY_MS = 86_400_000;
const MAX_RETENTION_DAYS = 36_500;
/** Rows (messages and threads) one purge transaction deletes before it schedules the rest. */
const PURGE_BUDGET = 500;
/** Candidates one purge run looks at per mailbox and status (some may not be due yet: see `purgeExpired`). */
const PURGE_SCAN = 200;

function retentionOf(r: { closedDays?: number; spamDays?: number }) {
  const out: { closedDays?: number; spamDays?: number } = {};
  for (const k of ["closedDays", "spamDays"] as const) {
    const d = r[k];
    if (d === undefined) continue;
    if (!Number.isInteger(d) || d < 1 || d > MAX_RETENTION_DAYS) fail("ValidationError", `retention.${k}: a whole number of days in 1..${MAX_RETENTION_DAYS}`);
    out[k] = d;
  }
  return out.closedDays === undefined && out.spamDays === undefined ? undefined : out;
}

/**
 * One purge pass: the closed and spam threads whose latest status change or message (`activityAt`) is older than
 * their mailbox's retention, straight from the `by_mailbox_status_activity` index (every candidate is due, so a
 * thread kept longer never blocks the ones behind it). Threads from before `activityAt` (absent, first in the index)
 * get it from `lastMessageAt` when they are not due yet, so they leave the head of the index.
 */
function purgeExpired(ctx: Ctx) {
  let budget = PURGE_BUDGET;
  let threads = 0;
  let messages = 0;
  let more = false;
  for (const mb of ctx.db.query("mailboxes").collect()) {
    for (const [status, days] of [
      ["closed", mb.retention?.closedDays],
      ["spam", mb.retention?.spamDays],
    ] as const) {
      if (!days || more) continue;
      const cutoff = ctx.now - days * DAY_MS;
      const due = ctx.db
        .query("threads")
        .withIndex("by_mailbox_status_activity", (q: any) => q.eq("mailbox", mb.name).eq("status", status).lte("activityAt", cutoff))
        .take(PURGE_SCAN);
      for (const t of due) {
        if (budget <= 0) {
          more = true;
          break;
        }
        if (t.activityAt === undefined && t.lastMessageAt > cutoff) {
          ctx.db.patch(t._id, { activityAt: t.lastMessageAt });
          budget--;
          continue;
        }
        const batch = ctx.db.query("messages").withIndex("by_thread", (q: any) => q.eq("threadId", t._id)).take(budget);
        for (const m of batch) ctx.db.delete(m._id);
        messages += batch.length;
        budget -= batch.length;
        if (budget <= 0) {
          more = true; // the thread goes on the next run, once its last messages are gone
          break;
        }
        ctx.db.delete(t._id);
        threads++;
        budget--;
      }
      if (due.length === PURGE_SCAN) more = true;
    }
  }
  if (more) ctx.scheduler.runAfter(0, "lib:purge" as any, {});
  return { threads, messages, more };
}

/** Deletes up to PURGE_BUDGET messages of a (deleted) thread; true when some may be left. */
function dropMessages(ctx: Ctx, threadId: string): boolean {
  const batch = ctx.db.query("messages").withIndex("by_thread", (q: any) => q.eq("threadId", threadId)).take(PURGE_BUDGET);
  for (const m of batch) ctx.db.delete(m._id);
  return batch.length === PURGE_BUDGET;
}

// ------------------------------------------------------------------------------------------------ functions

const pageV = v.optional(v.object({ numItems: v.number(), cursor: v.union(v.string(), v.null()) }));

export const emailFunctions = {
  lib: {
    // ---------------------------------------------------------------- send
    /** Queues an email (atomic with the calling mutation). See `SendInput`. */
    send: mutation({ args: sendArgs, handler: (ctx, a) => doSend(ctx as unknown as Ctx, a as SendInput) }),
    /** Several emails in one transaction (all or nothing). */
    sendBatch: mutation({
      args: { emails: v.array(v.object(sendArgs)) },
      handler: (ctx, a) => {
        if (a.emails.length > 100) fail("ValidationError", "at most 100 emails per batch");
        return a.emails.map((e) => doSend(ctx as unknown as Ctx, e as SendInput));
      },
    }),
    /** Cancels a scheduled/queued email. */
    cancel: mutation({
      args: { id: v.id("emails") },
      handler: (ctx, { id }) => {
        const e = ctx.db.get(id);
        if (!e) return fail("NotFound", "email not found");
        if (e.status !== "scheduled" && e.status !== "queued") return { ok: false, status: e.status };
        if (e.jobId) ctx.scheduler.cancel(e.jobId);
        ctx.db.patch(id, { status: "canceled" });
        return { ok: true, status: "canceled" };
      },
    }),
    /** Re-queues a failed email (same row, attempts reset). */
    retry: mutation({
      args: { id: v.id("emails") },
      handler: (ctx, { id }) => {
        const e = ctx.db.get(id);
        if (!e) return fail("NotFound", "email not found");
        if (e.status !== "failed") return { ok: false, status: e.status };
        const jobId = ctx.scheduler.runAfter(0, "lib:deliver" as any, { emailId: id });
        ctx.db.patch(id, { status: "queued", attempts: 0, jobId, error: undefined, claimedAt: undefined } as any);
        return { ok: true, status: "queued" };
      },
    }),
    get: query({ args: { id: v.string() }, handler: (ctx, { id }) => {
      const nid = ctx.db.normalizeId("emails", id);
      return nid ? ctx.db.get(nid) : null;
    } }),
    list: query({
      args: { project: v.optional(v.string()), paginationOpts: pageV },
      handler: (ctx, a) =>
        ctx.db
          .query("emails")
          .withIndex("by_project", (q) => q.eq("project", a.project ?? "default"))
          .order("desc")
          .paginate(a.paginationOpts ?? { numItems: 50, cursor: null }),
    }),
    events: query({ args: { id: v.id("emails") }, handler: (ctx, { id }) => ctx.db.query("events").withIndex("by_email", (q) => q.eq("emailId", id)).collect() }),
    /** Counts per status for a project (aggregate, O(statuses)). */
    stats: query({
      args: { project: v.optional(v.string()) },
      handler: (ctx, a) => {
        const rows = ctx.db.aggregate("emails", "by_project_status").range((q: any) => q.eq("project", a.project ?? "default"));
        return Object.fromEntries(rows.map((r: any) => [r.group[1], r.count]));
      },
    }),
    /** Every event received for a provider message id (R11 measurements, unknown ids included). */
    eventsByMessage: query({ args: { messageId: v.string() }, handler: (ctx, { messageId }) => ctx.db.query("events").withIndex("by_message", (q) => q.eq("messageId", messageId)).collect() }),

    claim: internalMutation({
      args: { emailId: v.id("emails") },
      handler: (ctx, { emailId }) => {
        const e = ctx.db.get(emailId);
        if (!e || (e.status !== "queued" && e.status !== "scheduled")) return null; // canceled, already sent, or a duplicate job
        // Suppressions are checked again here: one may have arrived while the email was scheduled or backing off.
        const r = withoutSuppressed(ctx, e.project, e.to, e.cc ?? [], e.bcc ?? []);
        if (r.dropped.length) {
          const suppressed = [...new Set([...(e.suppressed ?? []), ...r.dropped])];
          if (!r.to.length) {
            // Same stored shape as a send that was suppressed up front: no suppressed address left in a delivered field.
            ctx.db.patch(emailId, { status: "suppressed", suppressed, jobId: undefined, to: r.to, cc: r.cc.length ? r.cc : undefined, bcc: r.bcc.length ? r.bcc : undefined } as any);
            return null;
          }
          ctx.db.patch(emailId, { to: r.to, cc: r.cc.length ? r.cc : undefined, bcc: r.bcc.length ? r.bcc : undefined, suppressed } as any);
        }
        ctx.db.patch(emailId, { status: "sending", attempts: e.attempts + 1, claimedAt: ctx.now });
        return { ...ctx.db.get(emailId)!, attempts: e.attempts + 1 };
      },
    }),
    finish: internalMutation({
      args: {
        emailId: v.id("emails"),
        outcome: v.union(v.literal("sent"), v.literal("failed"), v.literal("retry")),
        messageId: v.optional(v.string()),
        error: v.optional(errorV),
        retryInMs: v.optional(v.number()),
        droppedHeaders: v.optional(v.array(v.string())),
      },
      handler: (ctx, a) => {
        const e = ctx.db.get(a.emailId);
        if (!e || e.status !== "sending") return null;
        const extra = a.droppedHeaders?.length ? { droppedHeaders: a.droppedHeaders } : {};
        if (a.outcome === "sent") {
          ctx.db.patch(a.emailId, { status: "sent", messageId: a.messageId!, sentAt: ctx.now, error: undefined, ...extra } as any);
          // The provider's id is the email's Message-ID: the thread's outbound message records it, so an answer
          // (In-Reply-To / References) finds its thread without a token in the Reply-To.
          const mid = normalizeMessageId(a.messageId);
          if (e.threadId && mid) {
            const out = ctx.db
              .query("messages")
              .withIndex("by_thread", (q) => q.eq("threadId", e.threadId as any))
              .order("desc")
              .filter((q) => q.eq(q.field("emailId"), a.emailId))
              .first();
            if (out && !out.messageIdHeader) ctx.db.patch(out._id, { messageIdHeader: mid, messageIdRaw: bareMessageId(a.messageId)! });
          }
          // Events can arrive before `finish` commits (the provider is fast): apply the ones already stored, exactly
          // as `applyEvent` would have (status, suppression, onEvent hook).
          for (const ev of ctx.db.query("events").withIndex("by_message", (q) => q.eq("messageId", a.messageId!)).collect()) {
            if (ev.emailId) continue;
            ctx.db.patch(ev._id, { emailId: a.emailId });
            applyToEmail(ctx as unknown as Ctx, ctx.db.get(a.emailId)! as EmailDoc, {
              type: ev.type as DeliveryEvent["type"],
              recipient: ev.recipient ?? null,
              at: ev.at,
              ...(ev.bounceType ? { bounceType: ev.bounceType as "soft" | "hard" } : {}),
            });
          }
        } else if (a.outcome === "failed") ctx.db.patch(a.emailId, { status: "failed", ...(a.error ? { error: a.error } : {}), ...extra });
        else {
          const jobId = ctx.scheduler.runAfter(a.retryInMs ?? 30_000, "lib:deliver" as any, { emailId: a.emailId });
          ctx.db.patch(a.emailId, { status: "queued", jobId, ...(a.error ? { error: a.error } : {}) });
        }
        return null;
      },
    }),
    deliver: internalAction({ args: { emailId: v.id("emails") }, handler: (ctx, { emailId }) => deliver(ctx, emailId) }),
    templateFor: internalQuery({
      args: { project: v.string(), name: v.string() },
      handler: (ctx, a) => ctx.db.query("templates").withIndex("by_project_name", (q) => q.eq("project", a.project).eq("name", a.name)).first(),
    }),
    /** Cron: a send claimed more than LEASE_MS ago never finished (Worker died mid-send): fail it, never resend blind. */
    sweep: internalMutation({
      args: {},
      handler: (ctx) => {
        let n = 0;
        for (const e of ctx.db.query("emails").withIndex("by_status", (q) => q.eq("status", "sending")).take(200)) {
          if ((e.claimedAt ?? 0) > ctx.now - LEASE_MS) continue;
          ctx.db.patch(e._id, { status: "failed", error: { code: "E_DELIVERY_UNKNOWN", message: "the delivery did not finish; retry it if it never arrived" } });
          n++;
        }
        return n;
      },
    }),

    /**
     * Daily: deletes the closed and spam conversations past their mailbox's retention (with their messages; the
     * messages' files are then collected by file GC). Bounded per run; schedules itself again while there is more.
     */
    purge: internalMutation({
      args: {},
      handler: (ctx) => purgeExpired(ctx as unknown as Ctx),
    }),

    // ---------------------------------------------------------------- events
    applyEvents: internalMutation({
      args: { events: v.array(v.any()) },
      handler: (ctx, a) => a.events.map((ev) => applyEvent(ctx as unknown as Ctx, ev as DeliveryEvent)),
    }),

    // ---------------------------------------------------------------- suppressions
    suppress: mutation({
      args: { project: v.optional(v.string()), email: v.string(), reason: v.optional(v.string()) },
      handler: (ctx, a) => {
        const project = a.project ?? "default";
        const email = parseAddress(a.email).email;
        const prev = ctx.db.query("suppressions").withIndex("by_project_email", (q) => q.eq("project", project).eq("email", email)).first();
        if (prev) return prev._id;
        return ctx.db.insert("suppressions", { project, email, reason: a.reason ?? "manual", at: ctx.now });
      },
    }),
    unsuppress: mutation({
      args: { project: v.optional(v.string()), email: v.string() },
      handler: (ctx, a) => {
        const row = ctx.db.query("suppressions").withIndex("by_project_email", (q) => q.eq("project", a.project ?? "default").eq("email", a.email.toLowerCase())).first();
        if (row) ctx.db.delete(row._id);
        return !!row;
      },
    }),
    suppressions: query({
      args: { project: v.optional(v.string()), paginationOpts: pageV },
      handler: (ctx, a) => ctx.db.query("suppressions").withIndex("by_project_email", (q) => q.eq("project", a.project ?? "default")).paginate(a.paginationOpts ?? { numItems: 100, cursor: null }),
    }),

    // ---------------------------------------------------------------- templates
    upsertTemplate: mutation({
      args: { project: v.optional(v.string()), name: v.string(), subject: v.string(), html: v.string(), text: v.optional(v.string()), layout: v.optional(v.any()) },
      handler: (ctx, a) => {
        const project = a.project ?? "default";
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(a.name)) fail("ValidationError", "template name: [A-Za-z0-9._-], max 64");
        try {
          checkTemplate(a.subject);
          checkTemplate(a.html);
          if (a.text) checkTemplate(a.text);
        } catch (e) {
          fail("ValidationError", (e as Error).message);
        }
        const doc = { project, name: a.name, subject: a.subject, html: a.html, ...(a.text ? { text: a.text } : {}), ...(a.layout ? { layout: a.layout } : {}), updatedAt: ctx.now };
        const prev = ctx.db.query("templates").withIndex("by_project_name", (q) => q.eq("project", project).eq("name", a.name)).first();
        if (prev) {
          ctx.db.replace(prev._id, doc);
          return prev._id;
        }
        return ctx.db.insert("templates", doc);
      },
    }),
    removeTemplate: mutation({
      args: { project: v.optional(v.string()), name: v.string() },
      handler: (ctx, a) => {
        const row = ctx.db.query("templates").withIndex("by_project_name", (q) => q.eq("project", a.project ?? "default").eq("name", a.name)).first();
        if (row) ctx.db.delete(row._id);
        return !!row;
      },
    }),
    templates: query({ args: { project: v.optional(v.string()) }, handler: (ctx, a) => ctx.db.query("templates").withIndex("by_project_name", (q) => q.eq("project", a.project ?? "default")).collect() }),
    /** Renders a stored template with data (previews). */
    render: query({
      args: { project: v.optional(v.string()), name: v.string(), data: v.optional(v.any()) },
      handler: (ctx, a) => {
        const t = ctx.db.query("templates").withIndex("by_project_name", (q) => q.eq("project", a.project ?? "default").eq("name", a.name)).first();
        if (!t) return null;
        const layout = (t.layout as LayoutOptions | undefined) ?? cfg(ctx).layout;
        return renderStored({ subject: t.subject, html: t.html, ...(t.text ? { text: t.text } : {}), ...(layout ? { layout } : {}) }, (a.data ?? {}) as Record<string, unknown>);
      },
    }),

    // ---------------------------------------------------------------- mailboxes
    upsertMailbox: mutation({
      args: {
        name: v.string(),
        address: v.string(),
        /** Absent: keeps the stored one; null: clears it. */
        displayName: v.optional(v.union(v.null(), v.string())),
        /** Absent: keeps the stored one; null: clears it. */
        autoReply: v.optional(v.union(v.null(), v.object({ subject: v.string(), text: v.string(), html: v.optional(v.string()) }))),
        /** The domain's catch-all (one per domain). Absent: keeps the stored value; false or null: clears it. */
        catchAll: v.optional(v.union(v.null(), v.boolean())),
        /**
         * Days closed and spam conversations are kept (whole days, 1..36500; a missing kind is kept forever).
         * Absent: keeps the stored policy; null: clears it (kept forever).
         */
        retention: v.optional(v.union(v.null(), v.object({ closedDays: v.optional(v.number()), spamDays: v.optional(v.number()) }))),
      },
      handler: (ctx, a) => {
        if (!/^[a-z][a-z0-9_-]{0,39}$/.test(a.name)) fail("ValidationError", "mailbox name: [a-z][a-z0-9_-]*");
        const address = parseAddress(a.address).email;
        if (address.includes("+")) fail("ValidationError", "mailbox address cannot contain '+' (it carries thread tokens)");
        const taken = ctx.db.query("mailboxes").withIndex("by_address", (q) => q.eq("address", address)).first();
        if (taken && taken.name !== a.name) fail("ValidationError", `${address} already belongs to mailbox ${taken.name}`);
        const prev = ctx.db.query("mailboxes").withIndex("by_name", (q) => q.eq("name", a.name)).first();
        // Patch semantics: an absent field keeps its stored value, null clears it.
        const displayName = a.displayName === null ? undefined : (a.displayName ?? prev?.displayName);
        const autoReply = a.autoReply === null ? undefined : (a.autoReply ?? prev?.autoReply);
        const catchAll = a.catchAll === undefined ? !!prev?.catchAll : !!a.catchAll;
        const retention = a.retention === null ? undefined : a.retention === undefined ? prev?.retention : retentionOf(a.retention);
        if (catchAll) {
          const other = catchAllOf(ctx as unknown as Ctx, domainOf(address));
          if (other && other.name !== a.name) fail("ValidationError", `${domainOf(address)} already has a catch-all: mailbox ${other.name}`);
        }
        const doc = {
          name: a.name,
          address,
          ...(displayName ? { displayName } : {}),
          ...(autoReply ? { autoReply } : {}),
          ...(catchAll ? { catchAll: true } : {}),
          ...(retention ? { retention } : {}),
          nextNumber: prev?.nextNumber ?? 1,
          createdAt: prev?.createdAt ?? ctx.now,
        };
        if (prev) {
          ctx.db.replace(prev._id, doc);
          return prev._id;
        }
        return ctx.db.insert("mailboxes", doc);
      },
    }),
    removeMailbox: mutation({
      args: { name: v.string() },
      handler: (ctx, { name }) => {
        const m = ctx.db.query("mailboxes").withIndex("by_name", (q) => q.eq("name", name)).first();
        if (m) ctx.db.delete(m._id);
        return !!m;
      },
    }),
    mailboxes: query({ args: {}, handler: (ctx) => ctx.db.query("mailboxes").collect() }),
    route: query({ args: { to: v.string() }, handler: (ctx, { to }) => routeOf(ctx as unknown as Ctx, to) }),

    // ---------------------------------------------------------------- threads (inbox, mobile client)
    threads: query({
      args: { mailbox: v.string(), status: v.optional(v.string()), paginationOpts: pageV },
      handler: (ctx, a) => {
        const page = a.paginationOpts ?? { numItems: 30, cursor: null };
        const q =
          a.status === undefined
            ? ctx.db.query("threads").withIndex("by_mailbox_last", (q) => q.eq("mailbox", a.mailbox))
            : ctx.db.query("threads").withIndex("by_mailbox_status", (q) => q.eq("mailbox", a.mailbox).eq("status", a.status!));
        return q.order("desc").paginate(page);
      },
    }),
    thread: query({
      args: { threadId: v.string() },
      handler: (ctx, { threadId }) => {
        const id = ctx.db.normalizeId("threads", threadId);
        const thread = id ? ctx.db.get(id) : null;
        if (!thread) return null;
        const messages = ctx.db.query("messages").withIndex("by_thread", (q) => q.eq("threadId", thread._id)).collect();
        return { thread, messages };
      },
    }),
    /**
     * The conversations the mailbox wrote in (its Sent view): threads with a reply or a new conversation sent from it,
     * by its latest one, newest first. `before` (the answer's `next`, an opaque cursor) goes on to older ones. Internal
     * notes and auto-replies are not sent mail here (a note is no message out; an auto-reply is no message of the
     * thread).
     */
    sent: query({
      args: { mailbox: v.string(), limit: v.optional(v.number()), before: v.optional(v.string()) },
      handler: (ctx, a) => {
        const mb = ctx.db.query("mailboxes").withIndex("by_name", (q) => q.eq("name", a.mailbox)).first();
        if (!mb) return { page: [], next: null };
        const limit = Math.min(Math.max(Math.trunc(a.limit ?? 30), 1), 100);
        // The cursor is the last message looked at: its time and id. The next page starts at that time (`lte`) and
        // skips up to and including that message, in the index's order (time, then creation, then id), so messages
        // sharing its millisecond are neither lost nor seen twice.
        const cursor = parseSentCursor(a.before);
        // Messages from the mailbox's address, newest first; a thread counts at its newest outbound message only, so a
        // later page never lists it again for an older one.
        const scan = limit * 4 + 20;
        const fetch = (n: number) =>
          ctx.db
            .query("messages")
            .withIndex("by_sender", (q) => {
              const r = q.eq("mailbox", a.mailbox).eq("fromEmail", mb.address);
              return cursor ? r.lte("at", cursor.at) : r;
            })
            .order("desc")
            .take(n);
        // Past the messages sharing the cursor's millisecond: fetched until the cursor and a full window after it are in
        // hand (or there is nothing more), so a burst in one millisecond never ends the paging early.
        let n = scan + (cursor ? scan : 0);
        let rows = fetch(n);
        let start = 0;
        for (;;) {
          if (cursor) {
            const k = rows.findIndex((m) => m._id === cursor.id);
            // The cursor's message is gone (deleted): start after every message of its millisecond.
            start = k >= 0 ? k + 1 : rows.findIndex((m) => m.at < cursor.at);
            if (start < 0) start = rows.length;
          }
          if (rows.length < n || rows.length - start >= scan || n >= SENT_MAX_FETCH) break;
          n = Math.min(n * 2, SENT_MAX_FETCH);
          rows = fetch(n);
        }
        const window = rows.slice(start, start + scan);
        const page: any[] = [];
        const seen = new Set<string>();
        let next: string | null = null;
        for (const m of window) {
          if (m.direction !== "outbound" || seen.has(m.threadId)) continue;
          seen.add(m.threadId);
          const newer = ctx.db
            .query("messages")
            .withIndex("by_thread", (q) => q.eq("threadId", m.threadId).gte("at", m.at))
            .collect()
            .some((x) => x._id !== m._id && x.direction === "outbound" && x.fromEmail === mb.address && isAfter(x, m));
          if (newer) continue;
          const thread = ctx.db.get(m.threadId);
          if (!thread) continue;
          page.push({ ...thread, lastSentAt: m.at });
          if (page.length === limit) {
            next = sentCursor(m);
            break;
          }
        }
        // A full window that did not fill the page: older messages may still hold sent threads.
        if (next === null && window.length === scan) next = sentCursor(window[window.length - 1]!);
        return { page, next };
      },
    }),
    /** Unread messages and thread counts per mailbox (aggregate: O(mailboxes)). */
    unread: query({
      args: { mailboxes: v.optional(v.array(v.string())) },
      handler: (ctx, a) => {
        const names = a.mailboxes ?? ctx.db.query("mailboxes").collect().map((m) => m.name);
        const out: Record<string, { unread: number; threads: number }> = {};
        for (const n of names) {
          const g = ctx.db.aggregate("threads", "unread").get([n]);
          out[n] = { unread: Number(g.sum.unreadCount ?? 0), threads: g.count };
        }
        return out;
      },
    }),
    search: query({
      args: { query: v.string(), mailbox: v.optional(v.string()), limit: v.optional(v.number()) },
      handler: (ctx, a) => {
        const rows = (ctx.db.query("messages") as any)
          .withSearchIndex("search", (s: any) => {
            const b = s.search("searchText", a.query);
            return a.mailbox === undefined ? b : b.eq("mailbox", a.mailbox);
          })
          .take(Math.min(50, a.limit ?? 20));
        return rows.map((m: any) => ({ messageId: m._id, threadId: m.threadId, mailbox: m.mailbox, direction: m.direction, subject: m.subject, from: m.from, snippet: m.snippet, at: m.at }));
      },
    }),
    markRead: mutation({
      args: { threadId: v.id("threads") },
      handler: (ctx, { threadId }) => {
        const t = ctx.db.get(threadId);
        if (t && t.unreadCount) ctx.db.patch(threadId, { unreadCount: 0 });
        return !!t;
      },
    }),
    setStatus: mutation({
      args: { threadId: v.id("threads"), status: v.union(v.literal("open"), v.literal("waiting"), v.literal("closed"), v.literal("spam")) },
      handler: (ctx, a) => {
        const t = ctx.db.get(a.threadId);
        if (!t) return fail("NotFound", "thread not found");
        if (t.status !== a.status) ctx.db.patch(a.threadId, { status: a.status, activityAt: ctx.now });
        return a.status;
      },
    }),
    /**
     * Deletes a conversation now, whatever its status: the thread and its messages (notes included); file GC then
     * collects their `.eml` and attachments. The send log (`emails`) keeps the emails it sent. A very long thread's
     * messages go in batches, after the thread is already gone. Unknown id: `{ deleted: false }`.
     */
    deleteThread: mutation({
      args: { threadId: v.string() },
      handler: (ctx, a) => {
        const id = ctx.db.normalizeId("threads", a.threadId);
        const t = id ? ctx.db.get(id) : null;
        if (!t) return { deleted: false };
        ctx.db.delete(t._id);
        if (dropMessages(ctx as unknown as Ctx, t._id)) ctx.scheduler.runAfter(0, "lib:dropMessages" as any, { threadId: t._id });
        return { deleted: true, mailbox: t.mailbox };
      },
    }),
    dropMessages: internalMutation({
      args: { threadId: v.string() },
      handler: (ctx, a) => {
        if (dropMessages(ctx as unknown as Ctx, a.threadId)) ctx.scheduler.runAfter(0, "lib:dropMessages" as any, a);
        return null;
      },
    }),
    /** Replies from the inbox: sent from the mailbox address, Reply-To carries the thread token, threading headers set. */
    reply: mutation({
      args: {
        threadId: v.id("threads"),
        text: v.string(),
        html: v.optional(v.string()),
        author: v.optional(v.string()),
        cc: v.optional(v.array(v.string())),
        sendAt: v.optional(v.number()),
        attachments: inboxAttachmentsV,
      },
      handler: (ctx, a) => {
        const thread = ctx.db.get(a.threadId);
        if (!thread) return fail("NotFound", "thread not found");
        if (thread.status === "spam") return fail("ValidationError", "cannot reply to spam");
        if (!a.text.trim()) return fail("ValidationError", "text is required");
        if (a.text.length > 50_000) return fail("ValidationError", "text: at most 50k characters");
        const mb = ctx.db.query("mailboxes").withIndex("by_name", (q) => q.eq("name", thread.mailbox)).first();
        if (!mb) return fail("NotFound", `mailbox ${thread.mailbox} not found`);
        const last = ctx.db
          .query("messages")
          .withIndex("by_thread", (q) => q.eq("threadId", thread._id))
          .order("desc")
          .filter((q) => q.eq(q.field("direction"), "inbound"))
          .first();
        // Cited as written: Gmail threads a reply only when In-Reply-To / References match the Message-ID exactly.
        const cited = last ? citedId(last) : null;
        const refs = last && cited ? [...citedRefs(last).slice(-20), cited] : [];
        const headers: Record<string, string> = refs.length ? { "In-Reply-To": `<${cited}>`, References: refs.map((r) => `<${r}>`).join(" ") } : {};
        const quote = last ? `\n\n${new Date(last.at).toUTCString()}, ${last.from.name ?? last.from.email}:\n${last.text.split("\n").slice(0, 40).map((l) => `> ${l}`).join("\n")}` : "";
        const html = a.html ?? emailLayout(textToHtml(a.text) + (last ? `<blockquote style="margin:16px 0 0 0;padding-left:12px;border-left:3px solid #dee2e6;color:#868e96">${textToHtml(last.text.split("\n").slice(0, 40).join("\n"))}</blockquote>` : ""));
        const to = [{ email: thread.contact, ...(thread.contactName ? { name: thread.contactName } : {}) }];
        const sent = doSend(ctx as unknown as Ctx, {
          project: `mailbox:${thread.mailbox}`,
          from: { email: mb.address, ...(mb.displayName ? { name: mb.displayName } : {}) },
          to,
          ...(a.cc?.length ? { cc: a.cc } : {}),
          ...threadReplyTo(ctx as unknown as Ctx, mb, thread),
          subject: replySubject(thread.subject),
          text: a.text + quote,
          html,
          headers,
          threadId: thread._id,
          ...(a.sendAt ? { sendAt: a.sendAt } : {}),
          ...(mimeParts(a.attachments).length ? { attachments: mimeParts(a.attachments) } : {}),
        });
        const files = attachmentRows(ctx as unknown as Ctx, a.attachments);
        const messageId = appendOutbound(ctx as unknown as Ctx, thread, mb, { text: a.text, ...(a.html ? { html: a.html } : {}), emailId: sent.id, ...(a.author ? { author: a.author } : {}), to, ...(a.cc?.length ? { cc: parseAddressList(a.cc) } : {}), attachments: files });
        return { emailId: sent.id, messageId, status: sent.status };
      },
    }),
    /** Marks a thread unread again (one unread message; the aggregate follows). */
    markUnread: mutation({
      args: { threadId: v.id("threads") },
      handler: (ctx, { threadId }) => {
        const t = ctx.db.get(threadId);
        if (t && !t.unreadCount) ctx.db.patch(threadId, { unreadCount: 1 });
        return !!t;
      },
    }),
    /** Assigns a thread to a member (`assignee` = app user id), or clears it with `null`. */
    assign: mutation({
      args: { threadId: v.id("threads"), assignee: v.union(v.string(), v.null()), assigneeName: v.optional(v.string()) },
      handler: (ctx, a) => {
        const t = ctx.db.get(a.threadId);
        if (!t) return fail("NotFound", "thread not found");
        ctx.db.patch(a.threadId, (a.assignee === null ? { assignee: undefined, assigneeName: undefined } : { assignee: a.assignee, assigneeName: a.assigneeName ?? undefined }) as any);
        return a.assignee;
      },
    }),
    /**
     * A new conversation started from the inbox: a thread (next number, token) whose contact is the first `to`,
     * the email sent from the mailbox address with the token in Reply-To (answers join the thread), status `waiting`.
     */
    compose: mutation({
      args: {
        mailbox: v.string(),
        to: v.array(v.string()),
        cc: v.optional(v.array(v.string())),
        subject: v.string(),
        text: v.string(),
        html: v.optional(v.string()),
        author: v.optional(v.string()),
        attachments: inboxAttachmentsV,
      },
      handler: (ctx, a) => {
        const mb = ctx.db.query("mailboxes").withIndex("by_name", (q) => q.eq("name", a.mailbox)).first();
        if (!mb) return fail("NotFound", `mailbox ${a.mailbox} not found`);
        if (!a.text.trim()) return fail("ValidationError", "text is required");
        if (a.text.length > 50_000) return fail("ValidationError", "text: at most 50k characters");
        let to: EmailAddress[];
        try {
          to = parseAddressList(a.to);
        } catch (e) {
          return fail("ValidationError", (e as Error).message);
        }
        if (!to.length) return fail("ValidationError", "to: at least one recipient");
        const subject = a.subject.trim() || "(no subject)";
        const number = mb.nextNumber;
        ctx.db.patch(mb._id, { nextNumber: number + 1 });
        const threadId = ctx.db.insert("threads", {
          mailbox: a.mailbox,
          number,
          subject,
          subjectKey: subjectKey(subject),
          contact: to[0]!.email,
          ...(to[0]!.name ? { contactName: to[0]!.name } : {}),
          status: "waiting",
          token: token(ctx as unknown as Ctx),
          messageCount: 0,
          unreadCount: 0,
          lastMessageAt: ctx.now,
          activityAt: ctx.now,
          snippet: snippetOf(a.text),
        });
        const thread = ctx.db.get(threadId)!;
        const sent = doSend(ctx as unknown as Ctx, {
          project: `mailbox:${a.mailbox}`,
          from: { email: mb.address, ...(mb.displayName ? { name: mb.displayName } : {}) },
          to,
          ...(a.cc?.length ? { cc: a.cc } : {}),
          ...threadReplyTo(ctx as unknown as Ctx, mb, thread),
          subject,
          text: a.text,
          html: a.html ?? emailLayout(textToHtml(a.text)),
          threadId,
          ...(mimeParts(a.attachments).length ? { attachments: mimeParts(a.attachments) } : {}),
        });
        const files = attachmentRows(ctx as unknown as Ctx, a.attachments);
        const messageId = appendOutbound(ctx as unknown as Ctx, thread, mb, { text: a.text, ...(a.html ? { html: a.html } : {}), emailId: sent.id, ...(a.author ? { author: a.author } : {}), to, ...(a.cc?.length ? { cc: parseAddressList(a.cc) } : {}), attachments: files });
        return { threadId, emailId: sent.id, messageId, status: sent.status, number };
      },
    }),
    /**
     * The latest threads of some mailboxes with all their messages (complete documents): what an offline client
     * keeps subscribed so its replica (and its local full-text search) covers recent mail.
     */
    recent: query({
      args: { mailboxes: v.array(v.string()), threads: v.optional(v.number()) },
      handler: (ctx, a) => {
        const n = Math.max(1, Math.min(200, a.threads ?? 50));
        const threads = a.mailboxes.flatMap((mailbox) => ctx.db.query("threads").withIndex("by_mailbox_last", (q) => q.eq("mailbox", mailbox)).order("desc").take(n));
        const messages = threads.flatMap((t) => ctx.db.query("messages").withIndex("by_thread", (q) => q.eq("threadId", t._id)).collect());
        return { threads, messages };
      },
    }),
    /** An internal note on a thread (never sent). */
    note: mutation({
      args: { threadId: v.id("threads"), text: v.string(), author: v.optional(v.string()) },
      handler: (ctx, a) => {
        const thread = ctx.db.get(a.threadId);
        if (!thread) return fail("NotFound", "thread not found");
        const mb = ctx.db.query("mailboxes").withIndex("by_name", (q) => q.eq("name", thread.mailbox)).first();
        return appendOutbound(ctx as unknown as Ctx, thread, mb ?? { address: thread.mailbox }, { text: a.text, note: true, to: [], ...(a.author ? { author: a.author } : {}) });
      },
    }),
    ingest: internalMutation({ args: { message: v.any() }, handler: (ctx, a) => ingest(ctx as unknown as Ctx, a.message as IngestArgs) }),
  },
};

// ------------------------------------------------------------------------------------------------ hooks

async function onEmail(ctx: any, message: import("@freecorps/ember-server").InboundEmailMessage) {
  const c: EmailInstallConfig = ctx.component.config ?? {};
  if (message.rawSize > (c.maxInboundBytes ?? MAX_INBOUND)) {
    message.setReject("Message too large");
    return;
  }
  const route = (await ctx.runQuery("lib:route", { to: message.to })) as { mailbox: string; tag: string | null } | null;
  if (!route) {
    message.setReject("Address not found");
    return;
  }
  const bytes = new Uint8Array(await new Response(message.raw).arrayBuffer());
  const p = await parseInbound(bytes);
  const canStore = !!ctx.env.EMBER_FILES;
  const raw = canStore && c.storeRaw !== false ? await ctx.storage.store(bytes, { contentType: "message/rfc822" }) : undefined;
  const attachments = [];
  if (canStore) {
    for (const a of p.attachments) {
      const file = await ctx.storage.store(a.content, { contentType: a.contentType });
      attachments.push({ filename: a.filename, contentType: a.contentType, file, size: a.content.length, ...(a.contentId ? { contentId: a.contentId } : {}), ...(a.inline ? { inline: true } : {}) });
    }
  }
  const from = p.from ?? { email: message.from.toLowerCase() };
  const args: IngestArgs = {
    mailbox: route.mailbox,
    ...(route.tag ? { tag: route.tag } : {}),
    envelopeFrom: message.from,
    ...(p.messageId ? { messageId: p.messageId } : {}),
    ...(p.inReplyTo ? { inReplyTo: p.inReplyTo } : {}),
    references: p.references,
    ...(p.messageIdRaw ? { messageIdRaw: p.messageIdRaw } : {}),
    ...(p.referencesRaw.length ? { referencesRaw: p.referencesRaw } : {}),
    from,
    ...(p.replyTo ? { replyTo: p.replyTo } : {}),
    to: p.to,
    cc: p.cc,
    subject: p.subject,
    text: p.text,
    ...(p.html ? { html: p.html } : {}),
    truncated: p.truncated,
    ...(raw ? { raw } : {}),
    attachments,
    droppedAttachments: p.droppedAttachments + (canStore ? 0 : p.attachments.length),
    auth: p.auth,
    autoSubmitted: p.autoSubmitted,
    ...(p.date ? { date: p.date } : {}),
  };
  await ctx.runMutation("lib:ingest", { message: args });
}

async function onEvents(ctx: any, batch: import("@freecorps/ember-server").ComponentQueueBatch) {
  const parsed: Array<{ ev: DeliveryEvent; msg: (typeof batch.messages)[number] }> = [];
  for (const m of batch.messages) {
    const ev = parseDeliveryEvent(m.body);
    if (!ev) {
      console.warn(`ember email: ignoring a message on ${batch.queue} that is not an Email Service event`);
      m.ack();
      continue;
    }
    parsed.push({ ev, msg: m });
  }
  if (!parsed.length) return;
  // One transaction per batch (events of a batch commit together; a failure retries the batch).
  await ctx.runMutation("lib:applyEvents", { events: parsed.map((p) => p.ev) });
  for (const p of parsed) p.msg.ack();
}

/**
 * The component. Install it once per app:
 *
 *   export default defineApp().use(email, { config: { domains: ["example.com"], rateLimit: { rate: 100, period: MINUTE } } });
 */
export const email = defineComponent({
  name: "email",
  schema: emailSchema,
  config: configV,
  functions: emailFunctions,
  bindings: (config) =>
    (config?.transport ?? "binding") === "binding"
      ? [{ type: "send_email" as const, name: config?.binding ?? "EMAIL", ...(config?.allowedSenders?.length ? { allowed_sender_addresses: config.allowedSenders } : {}) }]
      : [],
  crons: (config) =>
    cronJobs({ shard: config?.shard ?? "global:main" }).interval("sweep", { minutes: 10 }, "lib:sweep").daily("purge", { hour: 4 }, "lib:purge"),
  queues: {
    events: { shard: (config) => config?.shard ?? "global:main", consumer: { maxBatchSize: 100, maxBatchTimeoutSeconds: 2, maxRetries: 10 }, handler: onEvents },
  },
  email: {
    match: (to, config) => !config?.domains?.length || config.domains.some((d) => domainOf(to) === d.toLowerCase()),
    shard: (config) => config?.shard ?? "global:main",
    handler: onEmail,
  },
}).use(rateLimit);


