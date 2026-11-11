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
import { addressV, emailSchema, errorV, TAG_COLORS, type TagColor } from "./schema.ts";
import { sanitizeEmailHtml } from "./sanitize.ts";
import { checkTemplate, conversationEmail, conversationLayout, defaultQuoteHeader, escapeHtml, htmlToText, renderStored, renderTemplate, textToHtml, type EmailQuote, type EmailSignature, type LayoutOptions, type StoredTemplate } from "./template.ts";
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
  deliveryEvent(ctx, e, e.status, status, { ...(ev.recipient ? { recipient: ev.recipient } : {}), ...(ev.bounceType ? { bounceType: ev.bounceType } : {}) });
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
      const sentTo = m.direction === "outbound" ? [...(m.to ?? []), ...(m.cc ?? []), ...(m.bcc ?? [])].map((x: EmailAddress) => x.email) : [];
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
      hasUnread: false,
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
  writeThread(ctx, thread, {
    ...(thread.snoozed ? wakePatch(ctx, thread, "inbound") : {}),
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
      html: conversationLayout(mb.autoReply.html ? renderTemplateSafe(mb.autoReply.html, data, true) : textToHtml(text, { autolink: true })),
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

/** Args `reply` and `compose` share for the body a person wrote (besides `text`, the text/plain part, and `html`). */
const conversationArgs = {
  /** The composer's rich body: an HTML fragment, sanitized to a small allowlist (see `sanitizeEmailHtml`). */
  bodyHtml: v.optional(v.string()),
  signature: v.optional(v.object({ text: v.string(), html: v.optional(v.string()) })),
};

/**
 * The text and HTML parts of an email a person writes from the inbox: `conversationLayout` (no card), body, signature,
 * quote. A full-document `html` from the caller is used as is (the text part still gets the signature and quote).
 * `stored` is the HTML kept on the thread's message: the caller's `html`, or the sanitized `bodyHtml`.
 */
function conversationalBody(a: { text: string; html?: string; bodyHtml?: string; signature?: EmailSignature; quoteHeader?: string }, quote?: EmailQuote): { text: string; html: string; stored?: string } {
  if (a.html !== undefined && a.bodyHtml !== undefined) return fail("ValidationError", "pass html (a whole document) or bodyHtml (a fragment), not both");
  if (a.bodyHtml !== undefined && a.bodyHtml.length > 200_000) return fail("ValidationError", "bodyHtml: at most 200k characters");
  if (a.signature && a.signature.text.length > 5_000) return fail("ValidationError", "signature.text: at most 5k characters");
  if (a.signature?.html !== undefined && a.signature.html.length > 20_000) return fail("ValidationError", "signature.html: at most 20k characters");
  if (a.quoteHeader !== undefined && a.quoteHeader.length > 1_000) return fail("ValidationError", "quoteHeader: at most 1000 characters");
  const bodyHtml = a.bodyHtml !== undefined ? sanitizeEmailHtml(a.bodyHtml) : "";
  const signature = a.signature ? { text: a.signature.text, ...(a.signature.html !== undefined ? { html: sanitizeEmailHtml(a.signature.html) } : {}) } : undefined;
  const built = conversationEmail({ text: a.text, ...(bodyHtml.trim() ? { bodyHtml } : {}), ...(signature ? { signature } : {}), ...(quote ? { quote } : {}) });
  if (a.html !== undefined) return { text: built.text, html: a.html, stored: a.html };
  return { ...built, ...(bodyHtml.trim() ? { stored: bodyHtml } : {}) };
}

/** Most addresses a thread remembers as blind-copied (older ones are dropped first). */
const BLIND_MAX = 500;

/**
 * The thread's blind-copied addresses after an outbound email: its Bcc join (unless also To/Cc or the contact), its
 * To/Cc leave (they are visible now). `undefined` when nothing changes.
 */
function blindAfter(thread: { contact: string; blind?: string[] }, a: { to: EmailAddress[]; cc?: EmailAddress[]; bcc?: EmailAddress[] }): string[] | undefined {
  const visible = new Set([...a.to, ...(a.cc ?? [])].map((r) => r.email.toLowerCase()));
  const next = (thread.blind ?? []).filter((x) => !visible.has(x));
  for (const r of a.bcc ?? []) {
    const e = r.email.toLowerCase();
    if (!visible.has(e) && e !== thread.contact.toLowerCase() && !next.includes(e)) next.push(e);
  }
  const capped = next.slice(-BLIND_MAX);
  const same = capped.length === (thread.blind ?? []).length && capped.every((x, i) => x === thread.blind![i]);
  return same ? undefined : capped;
}

function appendOutbound(ctx: Ctx, thread: any, mb: any, a: { text: string; html?: string; emailId?: string; author?: string; note?: boolean; to: EmailAddress[]; cc?: EmailAddress[]; bcc?: EmailAddress[]; attachments?: ReturnType<typeof attachmentRows> }) {
  const email = a.emailId ? (ctx.db.get(a.emailId) as EmailDoc | null) : null;
  const scheduledFor = email?.status === "scheduled" ? (email.sendAt as number) : undefined;
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
    // Blind copies: kept for the mailbox's own view; they went in the envelope only (never a header).
    ...(a.bcc?.length ? { bcc: a.bcc } : {}),
    subject: thread.subject,
    text: a.text,
    ...(a.html ? { html: a.html } : {}),
    snippet,
    searchText: `${thread.subject}\n${a.author ?? ""}\n${a.text}${(a.attachments ?? []).map((x) => `\n${x.filename}`).join("")}`.slice(0, 100_000),
    attachments: a.attachments ?? [],
    autoSubmitted: false,
    ...(a.emailId ? { emailId: a.emailId } : {}),
    ...(a.author ? { author: a.author } : {}),
    ...(scheduledFor !== undefined ? { scheduledFor } : {}),
    at: ctx.now,
  });
  if (scheduledFor !== undefined) recordEvent(ctx, thread, "scheduled", { emailId: a.emailId, messageId: id, sendAt: scheduledFor }, a.author);
  const blind = a.note ? undefined : blindAfter(thread, a);
  writeThread(
    ctx,
    thread,
    {
      messageCount: thread.messageCount + 1,
      lastMessageAt: ctx.now,
      activityAt: ctx.now,
      ...(a.note ? {} : { status: thread.status === "spam" ? "spam" : "waiting", snippet }),
      ...(blind ? { blind: blind.length ? blind : undefined } : {}),
    },
    a.author,
  );
  // Suppressed at send time (every recipient on the suppression list): the timeline says so, as it does when the
  // suppression is found later.
  if (a.emailId) {
    const e = ctx.db.get(a.emailId as any) as EmailDoc | null;
    if (e?.status === "suppressed") deliveryEvent(ctx, e, "queued", "suppressed");
  }
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
  let sideBudget = 2 * PURGE_BUDGET;
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
        if (budget <= 0 || sideBudget <= 0) {
          more = true;
          break;
        }
        if (t.activityAt === undefined && t.lastMessageAt > cutoff) {
          ctx.db.patch(t._id, { activityAt: t.lastMessageAt });
          budget--;
          continue;
        }
        // Its tag rows and timeline first (their own budget, so the message budget stays as it was).
        const side = dropChildren(ctx, t._id, ["threadTags", "presence", "threadEvents"], sideBudget);
        sideBudget -= side.deleted;
        if (side.more) {
          more = true;
          break;
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

/** Rows that hang off a thread, deleted with it: its tag rows first (counts follow at once), then the rest. */
const THREAD_CHILDREN = ["threadTags", "presence", "messages", "threadEvents"] as const;

/** Deletes up to `budget` rows hanging off a (deleted) thread; true when some may be left. */
function dropMessages(ctx: Ctx, threadId: string, budget = PURGE_BUDGET): boolean {
  return dropChildren(ctx, threadId, THREAD_CHILDREN, budget).more;
}

function dropChildren(ctx: Ctx, threadId: string, tables: readonly string[], budget: number): { deleted: number; more: boolean } {
  let deleted = 0;
  for (const table of tables) {
    const batch = ctx.db.query(table).withIndex("by_thread", (q: any) => q.eq("threadId", threadId)).take(budget - deleted);
    for (const r of batch) ctx.db.delete(r._id);
    deleted += batch.length;
    if (deleted >= budget) return { deleted, more: true };
  }
  return { deleted, more: false };
}

// ------------------------------------------------------------------------------------------------ conversation state

const MAX_TAGS_PER_MAILBOX = 100;
const MAX_TAGS_PER_THREAD = 20;
/** Threads one `deleteTag` transaction untags before it schedules the rest. */
const TAG_CASCADE_BUDGET = 200;
/** Old threads `lib:maintain` fills `hasUnread` in on per run. */
const MAINTAIN_BUDGET = 500;

type ThreadDoc = Record<string, any> & { _id: string; mailbox: string };

/** Appends an entry to a thread's activity timeline (`threadEvents`). */
function recordEvent(ctx: Ctx, t: { _id: string; mailbox: string }, kind: string, data?: Record<string, unknown>, author?: string) {
  ctx.db.insert("threadEvents", { threadId: t._id, mailbox: t.mailbox, kind, at: ctx.now, ...(author ? { author } : {}), ...(data ? { data } : {}) });
}

/** The thread fields a `threadTags` row copies (lists and counts by tag read them). */
function tagRowView(t: ThreadDoc) {
  return {
    mailbox: t.mailbox,
    status: t.status,
    lastMessageAt: t.lastMessageAt,
    unreadCount: t.unreadCount,
    hasUnread: t.unreadCount > 0,
    ...(t.assignee ? { assignee: t.assignee } : {}),
    ...(t.snoozed ? { snoozed: true } : {}),
  };
}
const VIEW_FIELDS = ["mailbox", "status", "lastMessageAt", "unreadCount", "assignee", "snoozed"] as const;

/** Makes the thread's `threadTags` rows match its `tags` and its current list fields. */
function syncTagRows(ctx: Ctx, t: ThreadDoc) {
  const rows = ctx.db.query("threadTags").withIndex("by_thread", (q: any) => q.eq("threadId", t._id)).collect();
  const want = new Set<string>(t.tags ?? []);
  const view = tagRowView(t);
  for (const r of rows) {
    if (!want.has(r.tag)) {
      ctx.db.delete(r._id);
      continue;
    }
    want.delete(r.tag);
    const same =
      r.mailbox === view.mailbox && r.status === view.status && r.lastMessageAt === view.lastMessageAt && r.unreadCount === view.unreadCount && r.assignee === view.assignee && r.snoozed === view.snoozed;
    if (!same) ctx.db.replace(r._id, { threadId: t._id, tag: r.tag, ...view });
  }
  for (const tag of want) ctx.db.insert("threadTags", { threadId: t._id, tag, ...view });
}

const sameList = (a: readonly string[] | undefined, b: readonly string[] | undefined) => (a ?? []).length === (b ?? []).length && (a ?? []).every((x, i) => x === b![i]);

/**
 * Every write of a thread's list fields goes through here: it keeps `hasUnread` equal to `unreadCount > 0`, the
 * thread's `threadTags` rows in step, and records status changes and assignments in the timeline (`author` = who).
 * A field set to `undefined` in `patch` is removed. Returns the thread as written.
 */
function writeThread(ctx: Ctx, t: ThreadDoc, patch: Record<string, unknown>, author?: string): ThreadDoc {
  const next: ThreadDoc = { ...t, ...patch };
  for (const [k, val] of Object.entries(patch)) if (val === undefined) delete next[k];
  const hasUnread = next.unreadCount > 0;
  if (t.hasUnread !== hasUnread) patch = { ...patch, hasUnread };
  next.hasUnread = hasUnread;
  ctx.db.patch(t._id, patch);
  if (next.status !== t.status) recordEvent(ctx, t, "status", { from: t.status, to: next.status }, author);
  if (next.assignee !== t.assignee) {
    recordEvent(
      ctx,
      t,
      "assigned",
      { from: t.assignee ?? null, ...(t.assigneeName ? { fromName: t.assigneeName } : {}), to: next.assignee ?? null, ...(next.assigneeName ? { toName: next.assigneeName } : {}) },
      author,
    );
  }
  const tagged = !!(t.tags?.length || next.tags?.length);
  if (tagged && (!sameList(t.tags, next.tags) || VIEW_FIELDS.some((k) => t[k] !== next[k]))) syncTagRows(ctx, next);
  return next;
}

function threadOf(ctx: Ctx, id: string): ThreadDoc {
  const nid = ctx.db.normalizeId("threads", id);
  const t = nid ? ctx.db.get(nid) : null;
  return t ?? fail("NotFound", "thread not found");
}

/** Sets a thread's tags (ids of its mailbox's tags) and records each one added or removed. */
function setThreadTags(ctx: Ctx, t: ThreadDoc, ids: string[], author?: string): string[] {
  const tags: Array<{ _id: string; name: string; color: string }> = [];
  const prev: string[] = t.tags ?? [];
  for (const raw of ids) {
    const id = ctx.db.normalizeId("tags", raw);
    const tag = id ? ctx.db.get(id) : null;
    // A tag deleted a moment ago may still be on the thread (`deleteTag` untags in batches): it is just dropped.
    if (!tag && prev.includes(raw)) continue;
    if (!tag || tag.mailbox !== t.mailbox) fail("ValidationError", `tag ${raw} is not a tag of mailbox ${t.mailbox}`);
    if (!tags.some((x) => x._id === tag._id)) tags.push(tag);
  }
  if (tags.length > MAX_TAGS_PER_THREAD) fail("ValidationError", `at most ${MAX_TAGS_PER_THREAD} tags per thread`);
  const next = tags.map((x) => x._id);
  if (sameList(prev, next)) return prev;
  writeThread(ctx, t, { tags: next.length ? next : undefined }, author);
  for (const x of tags) if (!prev.includes(x._id)) recordEvent(ctx, t, "tag_added", { tag: x._id, name: x.name, color: x.color }, author);
  for (const id of prev) {
    if (next.includes(id)) continue;
    const x = ctx.db.get(id);
    recordEvent(ctx, t, "tag_removed", { tag: id, ...(x ? { name: x.name, color: x.color } : {}) }, author);
  }
  return next;
}

function tagName(name: string): { name: string; nameKey: string } {
  const n = name.trim().replace(/\s+/g, " ");
  if (!n || n.length > 40) fail("ValidationError", "tag name: 1..40 characters");
  return { name: n, nameKey: n.toLowerCase() };
}
function tagColor(color: string): TagColor {
  if (!(TAG_COLORS as readonly string[]).includes(color)) fail("ValidationError", `tag color: one of ${TAG_COLORS.join(", ")}`);
  return color as TagColor;
}

/** Untags up to TAG_CASCADE_BUDGET threads of a deleted tag; true when some may be left. */
function untagThreads(ctx: Ctx, mailbox: string, tag: string): boolean {
  const rows = ctx.db.query("threadTags").withIndex("by_tag", (q: any) => q.eq("mailbox", mailbox).eq("tag", tag)).take(TAG_CASCADE_BUDGET);
  for (const r of rows) {
    const t = ctx.db.get(r.threadId) as ThreadDoc | null;
    if (!t) {
      ctx.db.delete(r._id);
      continue;
    }
    const left = (t.tags ?? []).filter((x: string) => x !== tag);
    writeThread(ctx, t, { tags: left.length ? left : undefined });
  }
  return rows.length === TAG_CASCADE_BUDGET;
}

/** The thread message that sent email `emailId` (none for auto-replies). */
function threadMessageOf(ctx: Ctx, threadId: string, emailId: string): Record<string, any> | null {
  return ctx.db
    .query("messages")
    .withIndex("by_thread", (q: any) => q.eq("threadId", threadId))
    .order("desc")
    .filter((q: any) => q.eq(q.field("emailId"), emailId))
    .first();
}

/** An email left `scheduled`: its thread message is no longer "scheduled for". */
function clearScheduled(ctx: Ctx, e: EmailDoc) {
  if (e.status !== "scheduled" || !e.threadId) return;
  const tid = ctx.db.normalizeId("threads", e.threadId);
  const m = tid ? threadMessageOf(ctx, tid, e._id) : null;
  if (m?.scheduledFor !== undefined) ctx.db.patch(m._id, { scheduledFor: undefined });
}

const MAX_SNOOZE_MS = 366 * DAY;

/**
 * Wakes a snoozed thread. `time` (its snooze ran out): it comes back as new, like Gmail: on top of the lists
 * (`lastMessageAt` = now), unread (at least one), and `open` unless it is spam. `inbound` (an answer arrived) and
 * `manual` only clear the snooze (the answer itself moves it). Returns the patch, for callers that write more.
 */
function wakePatch(ctx: Ctx, t: ThreadDoc, reason: "time" | "inbound" | "manual", author?: string): Record<string, unknown> {
  if (t.snoozeJob && reason !== "time") ctx.scheduler.cancel(t.snoozeJob);
  recordEvent(ctx, t, "unsnoozed", { reason, until: t.snoozedUntil ?? null }, author);
  const patch: Record<string, unknown> = { snoozed: undefined, snoozedUntil: undefined, snoozeJob: undefined };
  if (reason === "time") Object.assign(patch, { lastMessageAt: ctx.now, activityAt: ctx.now, unreadCount: Math.max(1, t.unreadCount), status: t.status === "spam" ? "spam" : "open" });
  return patch;
}

const PRESENCE_TTL = 30_000;

/** The email statuses a thread's timeline records (`delivery` events). */
const TIMELINE_STATUSES = new Set<string>(["sent", "delivery_delayed", "delivered", "bounced", "complained", "failed", "suppressed", "canceled"]);

/** Records an outbound email's status change on its thread's timeline (`delivery`), when it has one. */
function deliveryEvent(ctx: Ctx, e: EmailDoc, from: string, to: string, extra: Record<string, unknown> = {}) {
  if (from === to || !e.threadId || !TIMELINE_STATUSES.has(to)) return;
  const tid = ctx.db.normalizeId("threads", e.threadId);
  const t = tid ? (ctx.db.get(tid) as ThreadDoc | null) : null;
  if (!t) return;
  const m = threadMessageOf(ctx, t._id, e._id);
  recordEvent(ctx, t, "delivery", { emailId: e._id, status: to, previous: from, ...(m ? { messageId: m._id } : {}), ...extra });
}

export type CountBlock = { threads: number; unread: number; unreadThreads: number };
/** `all` and `byStatus` leave snoozed threads out; `snoozed` counts them (any status). */
export type CountsByStatus = { all: CountBlock; byStatus: Record<string, CountBlock>; snoozed: CountBlock };
const STATUSES = ["open", "waiting", "closed", "spam"] as const;
const block = (): CountBlock => ({ threads: 0, unread: 0, unreadThreads: 0 });
const byStatus = (): CountsByStatus => ({ all: block(), byStatus: Object.fromEntries(STATUSES.map((s) => [s, block()])), snoozed: block() });
/** Adds one aggregate group (`[..., snoozed, status, hasUnread]`) to `c`. */
function addGroup(c: CountsByStatus, snoozed: unknown, status: string, hasUnread: unknown, row: { count: number; sum: Record<string, number | bigint> }) {
  const unread = Number(row.sum.unreadCount ?? 0);
  for (const b of snoozed === true ? [c.snoozed] : [c.all, (c.byStatus[status] ??= block())]) {
    b.threads += row.count;
    b.unread += unread;
    if (hasUnread === true) b.unreadThreads += row.count;
  }
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
        clearScheduled(ctx as unknown as Ctx, e as EmailDoc);
        ctx.db.patch(id, { status: "canceled" });
        deliveryEvent(ctx as unknown as Ctx, e as EmailDoc, e.status, "canceled");
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
            clearScheduled(ctx as unknown as Ctx, e as EmailDoc);
            ctx.db.patch(emailId, { status: "suppressed", suppressed, jobId: undefined, to: r.to, cc: r.cc.length ? r.cc : undefined, bcc: r.bcc.length ? r.bcc : undefined } as any);
            deliveryEvent(ctx as unknown as Ctx, e as EmailDoc, e.status, "suppressed");
            return null;
          }
          ctx.db.patch(emailId, { to: r.to, cc: r.cc.length ? r.cc : undefined, bcc: r.bcc.length ? r.bcc : undefined, suppressed } as any);
        }
        clearScheduled(ctx as unknown as Ctx, e as EmailDoc);
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
          deliveryEvent(ctx as unknown as Ctx, e as EmailDoc, e.status, "sent");
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
        } else if (a.outcome === "failed") {
          ctx.db.patch(a.emailId, { status: "failed", ...(a.error ? { error: a.error } : {}), ...extra });
          deliveryEvent(ctx as unknown as Ctx, e as EmailDoc, e.status, "failed", a.error ? { error: a.error } : {});
        }
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
          const error = { code: "E_DELIVERY_UNKNOWN", message: "the delivery did not finish; retry it if it never arrived" };
          ctx.db.patch(e._id, { status: "failed", error });
          deliveryEvent(ctx as unknown as Ctx, e as EmailDoc, e.status, "failed", { error });
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
    /**
     * A mailbox's threads, newest message first, paginated. Filters, each exact (index-backed; with several, the
     * most selective one is the index and the others filter its range): `status`; `assignee` (an app user id, or
     * `null` for unassigned); `unread` (true: threads with unread messages, false: none); `tag` (a tag id).
     * Snoozed threads are left out; `snoozed: true` lists only them, soonest to wake first (with `tag`: newest first).
     */
    threads: query({
      args: {
        mailbox: v.string(),
        status: v.optional(v.string()),
        assignee: v.optional(v.union(v.string(), v.null())),
        unread: v.optional(v.boolean()),
        tag: v.optional(v.string()),
        snoozed: v.optional(v.boolean()),
        paginationOpts: pageV,
      },
      handler: (ctx, a) => {
        const page = a.paginationOpts ?? { numItems: 30, cursor: null };
        const snoozed = a.snoozed === true;
        // Unassigned = no `assignee`: in the index order (and in filters) a missing field sorts before every string.
        const assignee = a.assignee === null ? undefined : a.assignee;
        const byAssignee = (q: any) => (a.assignee === undefined ? q : a.assignee === null ? q.lt(q.field("assignee"), "") : q.eq(q.field("assignee"), a.assignee));
        const filters: Array<(q: any) => unknown> = [snoozed ? (q) => q.eq(q.field("snoozed"), true) : (q) => q.neq(q.field("snoozed"), true)];
        if (a.tag !== undefined) {
          const tag = ctx.db.normalizeId("tags", a.tag);
          if (!tag) return { page: [], isDone: true, continueCursor: "e" };
          if (a.assignee !== undefined) filters.push(byAssignee);
          if (a.unread !== undefined) filters.push((q) => q.eq(q.field("hasUnread"), a.unread));
          let q: any =
            a.status === undefined
              ? ctx.db.query("threadTags").withIndex("by_tag", (q) => q.eq("mailbox", a.mailbox).eq("tag", tag))
              : ctx.db.query("threadTags").withIndex("by_tag_status", (q) => q.eq("mailbox", a.mailbox).eq("tag", tag).eq("status", a.status!));
          for (const f of filters) q = q.filter(f);
          const r = q.order("desc").paginate(page);
          return { ...r, page: r.page.map((x: any) => ctx.db.get(x.threadId)).filter((t: unknown) => t !== null) };
        }
        let q: any;
        if (snoozed) {
          // The snoozed list: soonest to wake first.
          filters.length = 0;
          if (a.status !== undefined) filters.push((q) => q.eq(q.field("status"), a.status));
          if (a.assignee !== undefined) filters.push(byAssignee);
          if (a.unread !== undefined) filters.push((q) => q.eq(q.field("hasUnread"), a.unread));
          q = ctx.db.query("threads").withIndex("by_mailbox_snoozed", (q) => q.eq("mailbox", a.mailbox).gt("snoozedUntil", null as any));
          for (const f of filters) q = q.filter(f);
          return q.order("asc").paginate(page);
        }
        if (a.assignee !== undefined) {
          q =
            a.status === undefined
              ? ctx.db.query("threads").withIndex("by_mailbox_assignee", (q) => q.eq("mailbox", a.mailbox).eq("assignee", assignee))
              : ctx.db.query("threads").withIndex("by_mailbox_assignee_status", (q) => q.eq("mailbox", a.mailbox).eq("assignee", assignee).eq("status", a.status!));
          if (a.unread !== undefined) filters.push((q) => q.eq(q.field("hasUnread"), a.unread));
        } else if (a.unread !== undefined) {
          q =
            a.status === undefined
              ? ctx.db.query("threads").withIndex("by_mailbox_unread", (q) => q.eq("mailbox", a.mailbox).eq("hasUnread", a.unread))
              : ctx.db.query("threads").withIndex("by_mailbox_unread_status", (q) => q.eq("mailbox", a.mailbox).eq("hasUnread", a.unread).eq("status", a.status!));
        } else {
          q =
            a.status === undefined
              ? ctx.db.query("threads").withIndex("by_mailbox_last", (q) => q.eq("mailbox", a.mailbox))
              : ctx.db.query("threads").withIndex("by_mailbox_status", (q) => q.eq("mailbox", a.mailbox).eq("status", a.status!));
        }
        for (const f of filters) q = q.filter(f);
        return q.order("desc").paginate(page);
      },
    }),
    /**
     * A mailbox's counts, from aggregates the writes keep (a few group reads, no thread scan): threads, unread
     * messages and unread threads, in all and by status; the same for one `assignee` (user id, or `null` =
     * unassigned) when given; and per tag of the mailbox. Snoozed threads are counted apart (`snoozed`), not in
     * `all` / `byStatus`.
     */
    counts: query({
      args: { mailbox: v.string(), assignee: v.optional(v.union(v.string(), v.null())) },
      handler: (ctx, a) => {
        const mailbox = byStatus();
        for (const r of ctx.db.aggregate("threads", "by_status").range((q: any) => q.eq("mailbox", a.mailbox))) addGroup(mailbox, r.group[1], String(r.group[2]), r.group[3], r);
        let assignee: CountsByStatus | undefined;
        if (a.assignee !== undefined) {
          assignee = byStatus();
          const who = a.assignee ?? undefined;
          for (const r of ctx.db.aggregate("threads", "by_assignee").range((q: any) => q.eq("mailbox", a.mailbox).eq("assignee", who))) addGroup(assignee, r.group[2], String(r.group[3]), r.group[4], r);
        }
        const tags: Record<string, CountsByStatus> = {};
        for (const t of ctx.db.query("tags").withIndex("by_mailbox", (q) => q.eq("mailbox", a.mailbox)).collect()) tags[t._id] = byStatus();
        for (const r of ctx.db.aggregate("threadTags", "counts").range((q: any) => q.eq("mailbox", a.mailbox))) {
          const c = tags[String(r.group[1])];
          if (c) addGroup(c, r.group[2], String(r.group[3]), r.group[4], r);
        }
        return { ...mailbox, ...(assignee ? { assignee } : {}), tags };
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
        if (t && (t.unreadCount || t.hasUnread !== false)) writeThread(ctx as unknown as Ctx, t, { unreadCount: 0 });
        return !!t;
      },
    }),
    setStatus: mutation({
      args: { threadId: v.id("threads"), status: v.union(v.literal("open"), v.literal("waiting"), v.literal("closed"), v.literal("spam")), author: v.optional(v.string()) },
      handler: (ctx, a) => {
        const t = ctx.db.get(a.threadId);
        if (!t) return fail("NotFound", "thread not found");
        if (t.status !== a.status) writeThread(ctx as unknown as Ctx, t, { status: a.status, activityAt: ctx.now }, a.author);
        return a.status;
      },
    }),
    /**
     * Deletes a conversation now, whatever its status: the thread and its messages (notes included); file GC then
     * collects their `.eml` and attachments. The send log (`emails`) keeps the emails it sent; the thread's emails still
     * queued or scheduled are canceled (`canceled`: how many). A very long thread's messages go in batches, after the
     * thread is already gone. Unknown id: `{ deleted: false }`.
     */
    deleteThread: mutation({
      args: { threadId: v.string() },
      handler: (ctx, a) => {
        const id = ctx.db.normalizeId("threads", a.threadId);
        const t = id ? ctx.db.get(id) : null;
        if (!t) return { deleted: false };
        // A reply or new conversation still waiting to go (queued, scheduled) goes no more: its thread is gone.
        let canceled = 0;
        for (const status of ["queued", "scheduled"] as const) {
          for (const e of ctx.db.query("emails").withIndex("by_status", (q) => q.eq("status", status)).filter((q) => q.eq(q.field("threadId"), t._id)).collect()) {
            if (e.jobId) ctx.scheduler.cancel(e.jobId);
            ctx.db.patch(e._id, { status: "canceled" });
            canceled++;
          }
        }
        if (t.snoozeJob) ctx.scheduler.cancel(t.snoozeJob);
        ctx.db.delete(t._id);
        if (dropMessages(ctx as unknown as Ctx, t._id)) ctx.scheduler.runAfter(0, "lib:dropMessages" as any, { threadId: t._id });
        return { deleted: true, mailbox: t.mailbox, canceled };
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
        ...conversationArgs,
        quoteHeader: v.optional(v.string()),
        author: v.optional(v.string()),
        cc: v.optional(v.array(v.string())),
        /** Blind copies: in the envelope only, never in a header the recipients see; stored on the thread message. */
        bcc: v.optional(v.array(v.string())),
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
        // The message answered and quoted: the latest inbound one, except from someone the thread only ever
        // blind-copied (`thread.blind`, kept on every send; quoting or citing their answer would show the contact who
        // was copied).
        const blind = new Set(thread.blind ?? []);
        const last =
          ctx.db
            .query("messages")
            .withIndex("by_thread", (q) => q.eq("threadId", thread._id))
            .order("desc")
            .filter((q) => q.eq(q.field("direction"), "inbound"))
            // Bounded: past this many blind-copied answers in a row the reply goes out without a quote or citation
            // (never with one from a blind-copied sender).
            .take(blind.size ? 500 : 1)
            .find((m) => !blind.has(m.from.email.toLowerCase())) ?? null;
        // Cited as written: Gmail threads a reply only when In-Reply-To / References match the Message-ID exactly.
        const cited = last ? citedId(last) : null;
        const refs = last && cited ? [...citedRefs(last).slice(-20), cited] : [];
        const headers: Record<string, string> = refs.length ? { "In-Reply-To": `<${cited}>`, References: refs.map((r) => `<${r}>`).join(" ") } : {};
        const quote = last ? { header: a.quoteHeader?.trim() || defaultQuoteHeader(last.at, last.from), text: last.text.split("\n").slice(0, 40).join("\n") } : undefined;
        const body = conversationalBody(a, quote);
        const to = [{ email: thread.contact, ...(thread.contactName ? { name: thread.contactName } : {}) }];
        const sent = doSend(ctx as unknown as Ctx, {
          project: `mailbox:${thread.mailbox}`,
          from: { email: mb.address, ...(mb.displayName ? { name: mb.displayName } : {}) },
          to,
          ...(a.cc?.length ? { cc: a.cc } : {}),
          ...(a.bcc?.length ? { bcc: a.bcc } : {}),
          ...threadReplyTo(ctx as unknown as Ctx, mb, thread),
          subject: replySubject(thread.subject),
          text: body.text,
          html: body.html,
          headers,
          threadId: thread._id,
          ...(a.sendAt ? { sendAt: a.sendAt } : {}),
          ...(mimeParts(a.attachments).length ? { attachments: mimeParts(a.attachments) } : {}),
        });
        const files = attachmentRows(ctx as unknown as Ctx, a.attachments);
        const messageId = appendOutbound(ctx as unknown as Ctx, thread, mb, { text: a.text, ...(body.stored ? { html: body.stored } : {}), emailId: sent.id, ...(a.author ? { author: a.author } : {}), to, ...(a.cc?.length ? { cc: parseAddressList(a.cc) } : {}), ...(a.bcc?.length ? { bcc: parseAddressList(a.bcc) } : {}), attachments: files });
        return { emailId: sent.id, messageId, status: sent.status };
      },
    }),
    /** Marks a thread unread again (one unread message; the aggregate follows). */
    markUnread: mutation({
      args: { threadId: v.id("threads") },
      handler: (ctx, { threadId }) => {
        const t = ctx.db.get(threadId);
        if (t && (!t.unreadCount || t.hasUnread !== true)) writeThread(ctx as unknown as Ctx, t, { unreadCount: t.unreadCount || 1 });
        return !!t;
      },
    }),
    /** Assigns a thread to a member (`assignee` = app user id), or clears it with `null`. */
    assign: mutation({
      args: { threadId: v.id("threads"), assignee: v.union(v.string(), v.null()), assigneeName: v.optional(v.string()), author: v.optional(v.string()) },
      handler: (ctx, a) => {
        const t = ctx.db.get(a.threadId);
        if (!t) return fail("NotFound", "thread not found");
        writeThread(ctx as unknown as Ctx, t, a.assignee === null ? { assignee: undefined, assigneeName: undefined } : { assignee: a.assignee, assigneeName: a.assigneeName ?? undefined }, a.author);
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
        /** Blind copies (see `reply`). */
        bcc: v.optional(v.array(v.string())),
        subject: v.string(),
        text: v.string(),
        html: v.optional(v.string()),
        ...conversationArgs,
        author: v.optional(v.string()),
        /** Send at this time (ms) instead of now (`scheduled`; see `scheduled` and `cancelScheduled`). */
        sendAt: v.optional(v.number()),
        attachments: inboxAttachmentsV,
      },
      handler: (ctx, a) => {
        const mb = ctx.db.query("mailboxes").withIndex("by_name", (q) => q.eq("name", a.mailbox)).first();
        if (!mb) return fail("NotFound", `mailbox ${a.mailbox} not found`);
        if (!a.text.trim()) return fail("ValidationError", "text is required");
        if (a.text.length > 50_000) return fail("ValidationError", "text: at most 50k characters");
        const body = conversationalBody(a);
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
          hasUnread: false,
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
          ...(a.bcc?.length ? { bcc: a.bcc } : {}),
          ...threadReplyTo(ctx as unknown as Ctx, mb, thread),
          subject,
          text: body.text,
          html: body.html,
          threadId,
          ...(a.sendAt ? { sendAt: a.sendAt } : {}),
          ...(mimeParts(a.attachments).length ? { attachments: mimeParts(a.attachments) } : {}),
        });
        const files = attachmentRows(ctx as unknown as Ctx, a.attachments);
        const messageId = appendOutbound(ctx as unknown as Ctx, thread, mb, { text: a.text, ...(body.stored ? { html: body.stored } : {}), emailId: sent.id, ...(a.author ? { author: a.author } : {}), to, ...(a.cc?.length ? { cc: parseAddressList(a.cc) } : {}), ...(a.bcc?.length ? { bcc: parseAddressList(a.bcc) } : {}), attachments: files });
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

    // ---------------------------------------------------------------- tags
    /** A mailbox's tags, in their order. */
    tags: query({
      args: { mailbox: v.string() },
      handler: (ctx, a) => ctx.db.query("tags").withIndex("by_mailbox", (q) => q.eq("mailbox", a.mailbox)).collect(),
    }),
    /** A new tag of a mailbox: `name` unique in it (ignoring case), `color` from TAG_COLORS (default gray), `order` (default: last). */
    createTag: mutation({
      args: { mailbox: v.string(), name: v.string(), color: v.optional(v.string()), order: v.optional(v.number()) },
      handler: (ctx, a) => {
        if (!ctx.db.query("mailboxes").withIndex("by_name", (q) => q.eq("name", a.mailbox)).first()) return fail("NotFound", `mailbox ${a.mailbox} not found`);
        const { name, nameKey } = tagName(a.name);
        if (ctx.db.query("tags").withIndex("by_mailbox_name", (q) => q.eq("mailbox", a.mailbox).eq("nameKey", nameKey)).first()) return fail("ValidationError", `mailbox ${a.mailbox} already has a tag ${name}`);
        const all = ctx.db.query("tags").withIndex("by_mailbox", (q) => q.eq("mailbox", a.mailbox)).take(MAX_TAGS_PER_MAILBOX + 1);
        if (all.length >= MAX_TAGS_PER_MAILBOX) return fail("ValidationError", `at most ${MAX_TAGS_PER_MAILBOX} tags per mailbox`);
        if (a.order !== undefined && !Number.isFinite(a.order)) return fail("ValidationError", "order: a finite number");
        const order = a.order ?? (all.length ? all[all.length - 1]!.order + 1 : 0);
        return ctx.db.insert("tags", { mailbox: a.mailbox, name, nameKey, color: tagColor(a.color ?? "gray"), order, createdAt: ctx.now });
      },
    }),
    /** Renames, recolors or moves a tag (absent fields are kept). The threads keep it (they hold its id). */
    updateTag: mutation({
      args: { tagId: v.string(), name: v.optional(v.string()), color: v.optional(v.string()), order: v.optional(v.number()) },
      handler: (ctx, a) => {
        const id = ctx.db.normalizeId("tags", a.tagId);
        const t = id ? ctx.db.get(id) : null;
        if (!t) return fail("NotFound", "tag not found");
        const patch: Record<string, unknown> = {};
        if (a.name !== undefined) {
          const { name, nameKey } = tagName(a.name);
          const other = ctx.db.query("tags").withIndex("by_mailbox_name", (q) => q.eq("mailbox", t.mailbox).eq("nameKey", nameKey)).first();
          if (other && other._id !== t._id) return fail("ValidationError", `mailbox ${t.mailbox} already has a tag ${name}`);
          Object.assign(patch, { name, nameKey });
        }
        if (a.color !== undefined) patch.color = tagColor(a.color);
        if (a.order !== undefined) {
          if (!Number.isFinite(a.order)) return fail("ValidationError", "order: a finite number");
          patch.order = a.order;
        }
        if (Object.keys(patch).length) ctx.db.patch(t._id, patch as any);
        return t._id;
      },
    }),
    /**
     * Deletes a tag and takes it off every thread (no timeline entry for that). Up to 200 threads in this
     * transaction, the rest in `lib:untag` jobs: until then those threads still list its id (clients skip ids that
     * are not in `tags`). Unknown id: `{ deleted: false }`.
     */
    deleteTag: mutation({
      args: { tagId: v.string() },
      handler: (ctx, a) => {
        const id = ctx.db.normalizeId("tags", a.tagId);
        const t = id ? ctx.db.get(id) : null;
        if (!t) return { deleted: false };
        ctx.db.delete(t._id);
        if (untagThreads(ctx as unknown as Ctx, t.mailbox, t._id)) ctx.scheduler.runAfter(0, "lib:untag" as any, { mailbox: t.mailbox, tag: t._id });
        return { deleted: true };
      },
    }),
    untag: internalMutation({
      args: { mailbox: v.string(), tag: v.string() },
      handler: (ctx, a) => {
        if (untagThreads(ctx as unknown as Ctx, a.mailbox, a.tag)) ctx.scheduler.runAfter(0, "lib:untag" as any, a);
        return null;
      },
    }),
    /** Sets a thread's tags (ids of its mailbox's tags, at most 20); returns them. Each change goes on the timeline. */
    setTags: mutation({
      args: { threadId: v.string(), tags: v.array(v.string()), author: v.optional(v.string()) },
      handler: (ctx, a) => setThreadTags(ctx as unknown as Ctx, threadOf(ctx as unknown as Ctx, a.threadId), a.tags, a.author),
    }),
    addTag: mutation({
      args: { threadId: v.string(), tag: v.string(), author: v.optional(v.string()) },
      handler: (ctx, a) => {
        const t = threadOf(ctx as unknown as Ctx, a.threadId);
        return setThreadTags(ctx as unknown as Ctx, t, [...(t.tags ?? []), a.tag], a.author);
      },
    }),
    removeTag: mutation({
      args: { threadId: v.string(), tag: v.string(), author: v.optional(v.string()) },
      handler: (ctx, a) => {
        const t = threadOf(ctx as unknown as Ctx, a.threadId);
        return setThreadTags(ctx as unknown as Ctx, t, (t.tags ?? []).filter((x: string) => x !== a.tag), a.author);
      },
    }),

    // ---------------------------------------------------------------- snooze
    /**
     * Snoozes a thread until `until` (ms, in the future, at most 366 days ahead), or wakes it now with `null`. A
     * snoozed thread is out of the default lists and counts. At `until` it comes back as new (see `wakePatch`); an
     * inbound message wakes it at once. Returns `until`.
     */
    snooze: mutation({
      args: { threadId: v.string(), until: v.union(v.number(), v.null()), author: v.optional(v.string()) },
      handler: (ctx, a) => {
        const c = ctx as unknown as Ctx;
        const t = threadOf(c, a.threadId);
        if (a.until === null) {
          if (t.snoozed) writeThread(c, t, wakePatch(c, t, "manual", a.author), a.author);
          return null;
        }
        if (!Number.isFinite(a.until) || a.until <= ctx.now) return fail("ValidationError", "until: a time in the future (ms)");
        if (a.until > ctx.now + MAX_SNOOZE_MS) return fail("ValidationError", "until: at most 366 days ahead");
        if (t.snoozeJob) ctx.scheduler.cancel(t.snoozeJob);
        const snoozeJob = ctx.scheduler.runAt(a.until, "lib:wake" as any, { threadId: t._id });
        recordEvent(c, t, "snoozed", { until: a.until, ...(t.snoozed ? { previous: t.snoozedUntil } : {}) }, a.author);
        writeThread(c, t, { snoozed: true, snoozedUntil: a.until, snoozeJob }, a.author);
        return a.until;
      },
    }),
    wake: internalMutation({
      args: { threadId: v.string() },
      handler: (ctx, a) => {
        const c = ctx as unknown as Ctx;
        const id = ctx.db.normalizeId("threads", a.threadId);
        const t = id ? (ctx.db.get(id) as ThreadDoc | null) : null;
        if (!t?.snoozed || (t.snoozedUntil ?? 0) > ctx.now) return false;
        writeThread(c, t, wakePatch(c, t, "time"));
        return true;
      },
    }),

    // ---------------------------------------------------------------- scheduled sends
    /** A thread's emails still waiting for their `sendAt` (`reply` / `compose` with `sendAt`), soonest first. */
    scheduled: query({
      args: { threadId: v.string() },
      handler: (ctx, a) => {
        const id = ctx.db.normalizeId("threads", a.threadId);
        if (!id) return [];
        return ctx.db
          .query("emails")
          .withIndex("by_thread_status", (q) => q.eq("threadId", id).eq("status", "scheduled"))
          .collect()
          .map((e) => {
            const m = threadMessageOf(ctx as unknown as Ctx, id, e._id);
            return { emailId: e._id, sendAt: e.sendAt, subject: e.subject, to: e.to, ...(e.cc ? { cc: e.cc } : {}), ...(m ? { messageId: m._id, ...(m.author ? { author: m.author } : {}), snippet: m.snippet } : {}) };
          });
      },
    }),
    /**
     * Cancels an email that has not gone yet (`scheduled` or `queued`) and removes its message from the thread. A
     * composed conversation left with no message is deleted. Anything else: `{ ok: false, status }`.
     */
    cancelScheduled: mutation({
      args: { emailId: v.string(), author: v.optional(v.string()) },
      handler: (ctx, a) => {
        const c = ctx as unknown as Ctx;
        const eid = ctx.db.normalizeId("emails", a.emailId);
        const e = eid ? ctx.db.get(eid) : null;
        if (!e) return fail("NotFound", "email not found");
        // Only mail that never left: scheduled, or queued and not tried yet. A queued email back from a transient
        // failure (attempts > 0) may already have reached the recipient: it stays, and so does its thread message.
        if (e.status !== "scheduled" && !(e.status === "queued" && !e.attempts)) return { ok: false, status: e.status };
        if (e.jobId) ctx.scheduler.cancel(e.jobId);
        ctx.db.patch(e._id, { status: "canceled" });
        const tid = e.threadId ? ctx.db.normalizeId("threads", e.threadId) : null;
        const t = tid ? (ctx.db.get(tid) as ThreadDoc | null) : null;
        if (!t) return { ok: true, status: "canceled" };
        const m = threadMessageOf(c, t._id, e._id);
        if (m) ctx.db.delete(m._id);
        const left = ctx.db.query("messages").withIndex("by_thread", (q) => q.eq("threadId", t._id as any)).order("desc").take(50);
        if (!left.length) {
          if (t.snoozeJob) ctx.scheduler.cancel(t.snoozeJob);
          ctx.db.delete(t._id as any);
          dropMessages(c, t._id);
          return { ok: true, status: "canceled", ...(m ? { messageId: m._id } : {}), threadDeleted: true };
        }
        recordEvent(c, t, "scheduled_canceled", { emailId: e._id, ...(m ? { messageId: m._id } : {}) }, a.author);
        if (m) {
          // The thread's summary comes from the messages that are left.
          const latest = left[0]!;
          const sent = left.find((x) => x.direction !== "note");
          // Undo the status move this reply made, and only that one: the timeline's latest status change, if it
          // happened when the reply was stored (same instant) and nothing changed the status since, goes back to its
          // `from`. A status set by hand (before or after) stays.
          const lastStatus = ctx.db
            .query("threadEvents")
            .withIndex("by_thread", (q) => q.eq("threadId", t._id as any))
            .order("desc")
            .take(50)
            .find((ev) => ev.kind === "status");
          // Also only when the contact's message is the latest again: another reply still on the thread keeps it waiting.
          const undoMove =
            sent?.direction === "inbound" && lastStatus && lastStatus.at === m.at && lastStatus.data?.to === t.status ? (lastStatus.data?.from as string | undefined) : undefined;
          writeThread(
            c,
            t,
            {
              messageCount: Math.max(0, t.messageCount - 1),
              ...(m.at >= t.lastMessageAt ? { lastMessageAt: latest.at } : {}),
              ...(sent ? { snippet: sent.snippet } : {}),
              ...(undoMove ? { status: undoMove } : {}),
            },
            a.author,
          );
        }
        return { ok: true, status: "canceled", ...(m ? { messageId: m._id } : {}) };
      },
    }),

    // ---------------------------------------------------------------- presence
    /**
     * Who is on a thread ("Bia is replying"). Call it as a heartbeat (every ~10 s) with `state`, or with `null` to
     * leave. The row expires `ttlMs` (default 30 s, 5..120 s) after the last heartbeat: a scheduled job deletes it,
     * so `presence` subscribers see it go without polling. A heartbeat that changes nothing within half the TTL
     * writes nothing.
     */
    setPresence: mutation({
      args: {
        threadId: v.string(),
        userId: v.string(),
        name: v.string(),
        state: v.union(v.literal("viewing"), v.literal("replying"), v.null()),
        ttlMs: v.optional(v.number()),
      },
      handler: (ctx, a) => {
        const t = threadOf(ctx as unknown as Ctx, a.threadId);
        if (!a.userId || a.userId.length > 200) return fail("ValidationError", "userId: 1..200 characters");
        const name = a.name.trim().slice(0, 100);
        const ttl = Math.min(Math.max(Math.trunc(a.ttlMs ?? PRESENCE_TTL), 5_000), 120_000);
        const row = ctx.db.query("presence").withIndex("by_thread", (q) => q.eq("threadId", t._id as any).eq("userId", a.userId)).first();
        if (a.state === null) {
          if (row) {
            ctx.scheduler.cancel(row.jobId);
            ctx.db.delete(row._id);
          }
          return null;
        }
        const expiresAt = ctx.now + ttl;
        if (!row) {
          const jobId = ctx.scheduler.runAt(expiresAt, "lib:expirePresence" as any, { threadId: t._id, userId: a.userId });
          ctx.db.insert("presence", { threadId: t._id as any, mailbox: t.mailbox, userId: a.userId, name, state: a.state, since: ctx.now, expiresAt, jobId, jobAt: expiresAt });
          return null;
        }
        // Nothing changes and the row is not due soon: no write. A shorter TTL than the row's (its expiry is later
        // than this heartbeat's) is a change: it falls through and reschedules.
        if (row.state === a.state && row.name === name && row.expiresAt - ctx.now > ttl / 2 && row.expiresAt <= expiresAt) return null;
        const patch: Record<string, unknown> = { state: a.state, name, expiresAt, ...(row.state !== a.state ? { since: ctx.now } : {}) };
        // A shorter TTL than before: the pending job would come too late.
        if (expiresAt < row.jobAt) {
          ctx.scheduler.cancel(row.jobId);
          Object.assign(patch, { jobId: ctx.scheduler.runAt(expiresAt, "lib:expirePresence" as any, { threadId: t._id, userId: a.userId }), jobAt: expiresAt });
        }
        ctx.db.patch(row._id, patch as any);
        return null;
      },
    }),
    expirePresence: internalMutation({
      args: { threadId: v.string(), userId: v.string() },
      handler: (ctx, a) => {
        const row = ctx.db.query("presence").withIndex("by_thread", (q) => q.eq("threadId", a.threadId as any).eq("userId", a.userId)).first();
        if (!row) return null;
        if (row.expiresAt <= ctx.now) ctx.db.delete(row._id);
        else ctx.db.patch(row._id, { jobId: ctx.scheduler.runAt(row.expiresAt, "lib:expirePresence" as any, a), jobAt: row.expiresAt });
        return null;
      },
    }),
    /** Who is on the thread now: `{ userId, name, state, since }`, oldest first. */
    presence: query({
      args: { threadId: v.string() },
      handler: (ctx, a) => {
        const id = ctx.db.normalizeId("threads", a.threadId);
        if (!id) return [];
        return ctx.db
          .query("presence")
          .withIndex("by_thread", (q) => q.eq("threadId", id))
          .collect()
          .sort((x, y) => x.since - y.since)
          .map((r) => ({ userId: r.userId, name: r.name, state: r.state as "viewing" | "replying", since: r.since }));
      },
    }),

    // ---------------------------------------------------------------- activity
    /**
     * A thread's timeline, oldest first (the latest `limit`, default 200, at most 1000): `{ kind, at, author?, data }`
     * with kind `status` `{ from, to }`, `assigned` `{ from, fromName?, to, toName? }` (ids or null), `tag_added` /
     * `tag_removed` `{ tag, name, color }`, `delivery` `{ emailId, status, previous, messageId?, recipient?, … }`,
     * `snoozed` `{ until, previous? }`, `unsnoozed` `{ reason: "time" | "inbound" | "manual", until }`, `scheduled`
     * `{ emailId, messageId, sendAt }`, `scheduled_canceled` `{ emailId, messageId? }`.
     */
    activity: query({
      args: { threadId: v.string(), limit: v.optional(v.number()) },
      handler: (ctx, a) => {
        const id = ctx.db.normalizeId("threads", a.threadId);
        // A deleted thread has no timeline, even while its events are still being dropped in batches.
        if (!id || !ctx.db.get(id)) return [];
        const n = Math.min(Math.max(Math.trunc(a.limit ?? 200), 1), 1000);
        return ctx.db
          .query("threadEvents")
          .withIndex("by_thread", (q) => q.eq("threadId", id))
          .order("desc")
          .take(n)
          .reverse();
      },
    }),

    /**
     * Cron (every 10 minutes): fills `hasUnread` in on threads from before 0.7, a bounded batch per run, again at once
     * while there is more. Skips a run while the new index is still backfilling after a deploy.
     */
    maintain: internalMutation({
      args: {},
      handler: (ctx) => {
        let filled = 0;
        let woken = 0;
        let more = false;
        try {
          for (const g of ctx.db.aggregate("threads", "unread").range()) {
            const mailbox = String(g.group[0]);
            const rows = ctx.db
              .query("threads")
              .withIndex("by_mailbox_unread", (q) => q.eq("mailbox", mailbox).eq("hasUnread", undefined as any))
              .take(MAINTAIN_BUDGET - filled + 1);
            if (filled + rows.length > MAINTAIN_BUDGET) more = true;
            for (const t of rows.slice(0, MAINTAIN_BUDGET - filled)) ctx.db.patch(t._id, { hasUnread: t.unreadCount > 0 });
            filled = Math.min(MAINTAIN_BUDGET, filled + rows.length);
            if (more) break;
          }
          // A snooze whose wake-up job is gone (it never should be) still ends.
          for (const g of ctx.db.aggregate("threads", "unread").range()) {
            const overdue = ctx.db
              .query("threads")
              .withIndex("by_mailbox_snoozed", (q) => q.eq("mailbox", String(g.group[0])).gt("snoozedUntil", null as any).lte("snoozedUntil", ctx.now - 60_000))
              .take(100);
            for (const t of overdue) writeThread(ctx as unknown as Ctx, t, wakePatch(ctx as unknown as Ctx, t, "time"));
            woken += overdue.length;
          }
        } catch (e) {
          if ((e as EmberError).code === "IndexNotReady") return { filled, more: false, waiting: true };
          throw e;
        }
        if (more) ctx.scheduler.runAfter(0, "lib:maintain" as any, {});
        return { filled, more, ...(woken ? { woken } : {}) };
      },
    }),
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
    cronJobs({ shard: config?.shard ?? "global:main" })
      .interval("sweep", { minutes: 10 }, "lib:sweep")
      .interval("maintain", { minutes: 10 }, "lib:maintain")
      .daily("purge", { hour: 4 }, "lib:purge"),
  queues: {
    events: { shard: (config) => config?.shard ?? "global:main", consumer: { maxBatchSize: 100, maxBatchTimeoutSeconds: 2, maxRetries: 10 }, handler: onEvents },
  },
  email: {
    match: (to, config) => !config?.domains?.length || config.domains.some((d) => domainOf(to) === d.toLowerCase()),
    shard: (config) => config?.shard ?? "global:main",
    handler: onEmail,
  },
}).use(rateLimit);


