// The webhooks component (PLAN §12): outbound webhooks with Standard Webhooks signatures, retries with backoff, a
// circuit breaker per endpoint, a dead-letter state and replays. Its tables live in the caller's shard (an org shard
// holds that org's endpoints and deliveries).
//
//   send (mutation, in the caller's transaction) ─ 1 `messages` row (the payload, once) + 1 `deliveries` row per
//       matching endpoint, each handed to the nested workpool (`@<install>/@pool`, bounded parallelism) unless its
//       endpoint's breaker is open (then it waits, `heldAt`).
//   lib:attempt (action, run by the pool) ─ signs and POSTs the payload (10 s timeout), returns what happened; payloads
//       over `offloadBytes` move to R2 (`ctx.storage`) on their first attempt.
//   lib:settle (mutation, the pool's onComplete) ─ delivered / retry on the schedule (a `lib:retry` job) / dead, and
//       the breaker: `threshold` consecutive failures open it; after `cooldownMs` a `lib:probe` job sends one held
//       delivery (half-open); its success closes the breaker and releases the held ones (`lib:release`, in batches).
//
// Every attempt is fenced by `attempt` (and the pool's work id): a late report of an older attempt, or one that a
// replay overtook, changes nothing.

import { componentBuilders, defineComponent, defineErrors, defineSchema, defineTable, EmberError, paginationOptsValidator, unsafeRef, v, type ComponentCtx, type GenericId } from "@freecorps/ember-server";
import { workpool } from "@freecorps/ember-workpool";
import {
  breakerHalfOpen,
  breakerOnFailure,
  breakerOnSuccess,
  classify,
  closedBreaker,
  DAY,
  DEFAULT_BREAKER_COOLDOWN_MS,
  DEFAULT_BREAKER_THRESHOLD,
  DEFAULT_JITTER,
  DEFAULT_RETRY_SCHEDULE_MS,
  matchesEvent,
  parseRetryAfter,
  retryDelay,
  SECOND,
  type Breaker,
} from "./policy.ts";
import { generateWebhookSecret, webhookHeaders } from "./verify.ts";

// ---------------------------------------------------------------------------------------------------- shapes

const vStatus = v.union(v.literal("pending"), v.literal("delivered"), v.literal("failed"), v.literal("dead"));
export type DeliveryStatus = "pending" | "delivered" | "failed" | "dead";
const vBreaker = v.object({
  state: v.union(v.literal("closed"), v.literal("open"), v.literal("halfOpen")),
  failures: v.number(),
  openedAt: v.optional(v.number()),
  probeAt: v.optional(v.number()),
});
const vSecret = v.object({ secret: v.string(), createdAt: v.number(), expiresAt: v.optional(v.number()) });
const vHistory = v.object({
  at: v.number(),
  attempt: v.number(),
  event: v.union(v.literal("delivered"), v.literal("retry"), v.literal("dead"), v.literal("held"), v.literal("replay"), v.literal("probe")),
  status: v.optional(v.number()),
  error: v.optional(v.string()),
  durationMs: v.optional(v.number()),
});

const schema = defineSchema({
  tables: {
    endpoints: defineTable({
      url: v.string(),
      /** Event names (`"invoice.paid"`), prefixes (`"invoice.*"`) or `"*"`. */
      events: v.array(v.string()),
      description: v.optional(v.string()),
      /** Newest first. Every one not expired signs (a rotation keeps the previous one for its grace period). */
      secrets: v.array(vSecret),
      enabled: v.boolean(),
      breaker: vBreaker,
      /** The probe job while the breaker is open, and the delivery being probed while half-open. */
      probeJob: v.optional(v.string()),
      probing: v.optional(v.id("deliveries")),
      /** App data (a tenant id, a label). */
      metadata: v.optional(v.any()),
      createdAt: v.number(),
    }).index("by_enabled", ["enabled"]),
    /** One row per send: the payload, shared by its deliveries (`refs` of them still exist). */
    messages: defineTable({
      event: v.string(),
      /** The JSON body as sent; moved to `file` (R2) by the first attempt when larger than `offloadBytes`. */
      body: v.optional(v.string()),
      file: v.optional(v.file()),
      size: v.number(),
      refs: v.number(),
      createdAt: v.number(),
    }),
    deliveries: defineTable({
      endpointId: v.id("endpoints"),
      messageId: v.id("messages"),
      event: v.string(),
      status: vStatus,
      /** Attempts started (the fence of attempt reports). */
      attempt: v.number(),
      /** `attempt` when the current round began (a replay starts a new round of retries). */
      roundStart: v.number(),
      /** The pool's work id of the attempt in flight. */
      workId: v.optional(v.string()),
      /** Set while waiting for the breaker to close (or the endpoint to be enabled again). */
      heldAt: v.optional(v.number()),
      /** When the scheduled retry is due (`failed`), and its job. */
      nextAt: v.optional(v.number()),
      retryJob: v.optional(v.string()),
      lastError: v.optional(v.string()),
      responseStatus: v.optional(v.number()),
      /** The first `maxResponseBytes` (1 KB) of the last response body. */
      responseBody: v.optional(v.string()),
      durationMs: v.optional(v.number()),
      /** The last 20 attempts and transitions. */
      history: v.array(vHistory),
      createdAt: v.number(),
      updatedAt: v.number(),
      deliveredAt: v.optional(v.number()),
    })
      .index("by_endpoint", ["endpointId", "createdAt"])
      .index("by_endpoint_status", ["endpointId", "status", "createdAt"])
      // Retention (gc) and counts: by the time of the last transition.
      .index("by_status", ["status", "updatedAt"])
      // Listing one status: in creation order, like an endpoint's list.
      .index("by_status_created", ["status", "createdAt"])
      // Sparse: only held deliveries (a few, while a breaker is open) are in it.
      .index("by_held", ["endpointId", "heldAt"], { sparse: true }),
    /** One row while a GC job is scheduled in this shard. */
    gc: defineTable({ at: v.number(), job: v.string() }),
  },
});

export type WebhooksInstallConfig = {
  /** Attempts in flight at once in this shard (the nested workpool's maxParallelism; default 10). */
  concurrency?: number;
  /** Delays before each retry, ms (default 5 s, 30 s, 2 min, 10 min, 1 h, 6 h, 24 h; then dead). */
  retrySchedule?: number[];
  /** Spread of each delay, 0–1 (default 0.2: ±20%). */
  jitter?: number;
  /** The fetch timeout, ms (default 10 s). */
  timeoutMs?: number;
  /** Consecutive failures that open an endpoint's breaker (default 10) and how long it stays open (default 1 min). */
  breaker?: { threshold?: number; cooldownMs?: number };
  /** How long a rotated-out secret keeps signing (default 24 h). */
  rotationGraceMs?: number;
  /** Payloads larger than this go to R2 on their first attempt (default 8 KB). */
  offloadBytes?: number;
  /** Largest payload `send` accepts (default 1 MiB). */
  maxPayloadBytes?: number;
  /** How much of a response body is kept (default 1 KB). */
  maxResponseBytes?: number;
  /** Delivered and dead deliveries older than this are deleted (default 30 days; 0 keeps them). */
  retentionMs?: number;
  /** Accept `http://` endpoint URLs (default false: https only). For local development. */
  allowHttp?: boolean;
};

export const installConfigValidator = v.object({
  concurrency: v.optional(v.number()),
  retrySchedule: v.optional(v.array(v.number())),
  jitter: v.optional(v.number()),
  timeoutMs: v.optional(v.number()),
  breaker: v.optional(v.object({ threshold: v.optional(v.number()), cooldownMs: v.optional(v.number()) })),
  rotationGraceMs: v.optional(v.number()),
  offloadBytes: v.optional(v.number()),
  maxPayloadBytes: v.optional(v.number()),
  maxResponseBytes: v.optional(v.number()),
  retentionMs: v.optional(v.number()),
  allowHttp: v.optional(v.boolean()),
});

export const DEFAULT_CONCURRENCY = 10;
export const DEFAULT_TIMEOUT_MS = 10 * SECOND;
export const DEFAULT_ROTATION_GRACE_MS = DAY;
export const DEFAULT_OFFLOAD_BYTES = 8 * 1024;
export const DEFAULT_MAX_PAYLOAD_BYTES = 1024 * 1024;
export const DEFAULT_MAX_RESPONSE_BYTES = 1024;
export const DEFAULT_RETENTION_MS = 30 * DAY;
/** Held deliveries released (or dead ones replayed, or deliveries purged) per transaction; the rest in a job. */
export const BATCH = 100;
/** Secrets that sign at once (the newest and those in their grace period): one more rotation is refused. */
export const MAX_SIGNING_SECRETS = 5;
const HISTORY = 20;

/** The component's application errors. */
export const webhookErrors = defineErrors({
  EndpointNotFound: { data: v.object({ endpointId: v.string() }), status: 404, message: (d: { endpointId: string }) => `No webhook endpoint ${d.endpointId}` },
  DeliveryNotFound: { data: v.object({ deliveryId: v.string() }), status: 404, message: (d: { deliveryId: string }) => `No webhook delivery ${d.deliveryId}` },
  PayloadTooLarge: { data: v.object({ size: v.number(), max: v.number() }), status: 413, message: (d: { size: number; max: number }) => `Webhook payload of ${d.size} bytes is over ${d.max}` },
});

const { query, mutation, internalQuery, internalMutation, internalAction } = componentBuilders<typeof schema, WebhooksInstallConfig | undefined>();

type C = ComponentCtx<typeof schema, WebhooksInstallConfig | undefined>;
type ReadCtx = C["query"];
type Ctx = C["mutation"];
type EndpointId = GenericId<"endpoints">;
type DeliveryId = GenericId<"deliveries">;
type Endpoint = {
  _id: EndpointId;
  _creationTime: number;
  url: string;
  events: string[];
  description?: string;
  secrets: Array<{ secret: string; createdAt: number; expiresAt?: number }>;
  enabled: boolean;
  breaker: Breaker;
  probeJob?: string | undefined;
  probing?: DeliveryId | undefined;
  metadata?: unknown;
  createdAt: number;
};
type History = { at: number; attempt: number; event: "delivered" | "retry" | "dead" | "held" | "replay" | "probe"; status?: number; error?: string; durationMs?: number };
type Delivery = {
  _id: DeliveryId;
  _creationTime: number;
  endpointId: EndpointId;
  messageId: GenericId<"messages">;
  event: string;
  status: DeliveryStatus;
  attempt: number;
  roundStart: number;
  workId?: string;
  heldAt?: number;
  nextAt?: number;
  retryJob?: string | undefined;
  lastError?: string;
  responseStatus?: number;
  responseBody?: string;
  durationMs?: number;
  history: History[];
  createdAt: number;
  updatedAt: number;
  deliveredAt?: number;
};

type Settings = Required<Omit<WebhooksInstallConfig, "breaker">> & { threshold: number; cooldownMs: number };

/** The install's settings with defaults, read at use time (a redeploy with a new config applies). */
function settings(ctx: { component: { config: WebhooksInstallConfig | undefined } }): Settings {
  const c = ctx.component.config ?? {};
  const pos = (x: number | undefined, d: number, min = 0) => (x !== undefined && Number.isFinite(x) && x >= min ? x : d);
  return {
    concurrency: Math.floor(pos(c.concurrency, DEFAULT_CONCURRENCY, 1)),
    // `[]` is no retry at all (only an absent schedule takes the default).
    retrySchedule: c.retrySchedule !== undefined ? c.retrySchedule.map((x) => pos(x, 0)) : [...DEFAULT_RETRY_SCHEDULE_MS],
    jitter: Math.min(1, pos(c.jitter, DEFAULT_JITTER)),
    timeoutMs: pos(c.timeoutMs, DEFAULT_TIMEOUT_MS, 1),
    threshold: Math.floor(pos(c.breaker?.threshold, DEFAULT_BREAKER_THRESHOLD, 1)),
    cooldownMs: pos(c.breaker?.cooldownMs, DEFAULT_BREAKER_COOLDOWN_MS, 1),
    rotationGraceMs: pos(c.rotationGraceMs, DEFAULT_ROTATION_GRACE_MS),
    offloadBytes: pos(c.offloadBytes, DEFAULT_OFFLOAD_BYTES),
    maxPayloadBytes: pos(c.maxPayloadBytes, DEFAULT_MAX_PAYLOAD_BYTES, 1),
    maxResponseBytes: Math.floor(pos(c.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES)),
    retentionMs: pos(c.retentionMs, DEFAULT_RETENTION_MS),
    allowHttp: c.allowHttp ?? false,
  };
}

/** A handle to this component's own function (`&@<install>/.../lib:x`), callable from the nested pool. */
function own(ctx: { component: { name: string } }, fn: string): string {
  return `&${ctx.component.name.split("/").map((p) => `@${p}/`).join("")}${fn}`;
}

const raise = (e: Error): never => {
  throw e;
};

const invalid = (msg: string): never => {
  throw new EmberError("ValidationError", `webhooks: ${msg}`);
};

const utf8Length = (s: string): number => {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c < 0xdc00) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
};

function checkUrl(url: string, allowHttp: boolean) {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return invalid(`url ${JSON.stringify(url)} is not a URL`);
  }
  if (u.protocol !== "https:" && !(allowHttp && u.protocol === "http:")) invalid(`url must be https:// (got ${u.protocol}${allowHttp ? "" : "; install with { allowHttp: true } for http:// in development"})`);
  if (u.username || u.password) invalid("url must not carry credentials");
}

/** Why the install's current policy refuses an endpoint's stored url now (`allowHttp` turned off since), if it does. */
function refusedUrl(url: string, allowHttp: boolean): string | undefined {
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    return "url is not a URL";
  }
  if (protocol === "https:" || (allowHttp && protocol === "http:")) return undefined;
  return `url must be https:// (got ${protocol}; allowHttp is off): not sent`;
}

function checkEvents(events: string[]) {
  if (!events.length) invalid("events must name at least one event (or \"*\")");
  for (const e of events) if (typeof e !== "string" || !e || e.length > 200) invalid(`event pattern ${JSON.stringify(e)}`);
}

const endpointOf = (ctx: ReadCtx, id: string): Endpoint | null => {
  const n = ctx.db.normalizeId("endpoints", id);
  return n ? (ctx.db.get(n) as Endpoint | null) : null;
};
const deliveryOf = (ctx: ReadCtx, id: string): Delivery | null => {
  const n = ctx.db.normalizeId("deliveries", id);
  return n ? (ctx.db.get(n) as Delivery | null) : null;
};
const mustEndpoint = (ctx: ReadCtx, id: string): Endpoint => endpointOf(ctx, id) ?? raise(webhookErrors.EndpointNotFound({ endpointId: id }));
const mustDelivery = (ctx: ReadCtx, id: string): Delivery => deliveryOf(ctx, id) ?? raise(webhookErrors.DeliveryNotFound({ deliveryId: id }));

/** The secrets that sign now: the newest, and every older one still in its grace period. */
const signing = (e: Endpoint, now: number): string[] => e.secrets.filter((s, i) => i === 0 || (s.expiresAt !== undefined && s.expiresAt > now)).map((s) => s.secret);

const push = (h: History[], e: History): History[] => [...h, e].slice(-HISTORY);

/** What an endpoint looks like outside the component: no secrets (only how many sign now). */
function publicEndpoint(e: Endpoint, now: number) {
  return {
    _id: e._id,
    url: e.url,
    events: e.events,
    ...(e.description !== undefined ? { description: e.description } : {}),
    enabled: e.enabled,
    breaker: e.breaker,
    signingSecrets: signing(e, now).length,
    ...(e.metadata !== undefined ? { metadata: e.metadata } : {}),
    createdAt: e.createdAt,
  };
}

function publicDelivery(d: Delivery) {
  const { workId: _w, retryJob: _j, roundStart: _r, ...rest } = d;
  return rest;
}

// ------------------------------------------------------------------------------------------------ dispatch

/** Hands attempt `d.attempt + 1` to the pool. */
function enqueue(ctx: Ctx, d: Delivery, s: Settings, probe = false): void {
  const attempt = d.attempt + 1;
  const [workId] = ctx.runMutation(unsafeRef<"mutation">("@pool/lib:enqueue"), {
    items: [{ kind: "action", fn: own(ctx, "lib:attempt"), args: { deliveryId: d._id, attempt }, onComplete: own(ctx, "lib:settle"), context: { deliveryId: d._id, attempt } }],
    maxParallelism: s.concurrency,
    // The pool's results are not needed once settled: no retained rows.
    retentionMs: 0,
  }) as string[];
  ctx.db.patch(d._id, {
    status: "pending",
    attempt,
    workId: workId!,
    heldAt: undefined,
    nextAt: undefined,
    retryJob: undefined,
    updatedAt: ctx.now,
    ...(probe ? { history: push(d.history, { at: ctx.now, attempt, event: "probe" }) } : {}),
  });
}

/** Sends `d` now, or holds it while its endpoint is disabled or its breaker is open (half-open: one probe at a time). */
function dispatch(ctx: Ctx, d: Delivery, e: Endpoint, s: Settings): void {
  if (e.enabled && e.breaker.state === "closed") return enqueue(ctx, d, s);
  if (e.enabled && e.breaker.state === "halfOpen" && !e.probing) {
    ctx.db.patch(e._id, { probing: d._id });
    return enqueue(ctx, d, s, true);
  }
  ctx.db.patch(d._id, {
    status: "pending",
    attempt: d.attempt,
    workId: undefined,
    heldAt: ctx.now,
    nextAt: undefined,
    retryJob: undefined,
    updatedAt: ctx.now,
    history: push(d.history, { at: ctx.now, attempt: d.attempt, event: "held" }),
  });
}

/**
 * Whether a queued attempt of `d` may POST now: the endpoint is enabled and its breaker closed, or half-open with `d`
 * as its probe. Checked again when the attempt starts (`lib:prepare`): the breaker may have opened, or the endpoint
 * been disabled, while the attempt waited in the pool.
 */
const maySend = (e: Endpoint, d: Delivery): boolean => e.enabled && (e.breaker.state === "closed" || (e.breaker.state === "halfOpen" && e.probing === d._id));

/** Releases up to `BATCH` held deliveries of a closed, enabled endpoint; the rest in a `lib:release` job. */
function release(ctx: Ctx, e: Endpoint, s: Settings): number {
  if (!e.enabled || e.breaker.state !== "closed") return 0;
  const held = ctx.db
    .query("deliveries")
    .withIndex("by_held", (q) => q.eq("endpointId", e._id).gte("heldAt", 0))
    .take(BATCH + 1) as Delivery[];
  for (const d of held.slice(0, BATCH)) enqueue(ctx, d, s);
  if (held.length > BATCH) ctx.scheduler.runAfter(0, "lib:release", { endpointId: e._id });
  return Math.min(held.length, BATCH);
}

/**
 * Half-open with no probe out: the oldest held delivery goes as the probe (nothing held: the next send or retry is
 * the probe). A no-op otherwise (closed, open, disabled, or a probe already out).
 */
function probeNext(ctx: Ctx, e: Endpoint, s: Settings): void {
  if (!e.enabled || e.breaker.state !== "halfOpen" || e.probing) return;
  const first = ctx.db
    .query("deliveries")
    .withIndex("by_held", (q) => q.eq("endpointId", e._id).gte("heldAt", 0))
    .first() as Delivery | null;
  if (first) dispatch(ctx, first, e, s);
}

/** Opens (or reopens) the breaker: the probe job after the cooldown. */
function scheduleProbe(ctx: Ctx, e: Endpoint, b: Breaker): string {
  if (e.probeJob) ctx.scheduler.cancel(e.probeJob);
  return ctx.scheduler.runAt(b.probeAt ?? ctx.now, "lib:probe", { endpointId: e._id });
}

/** Keeps one GC job in this shard while retention is on (at most one row read when it exists). */
function ensureGc(ctx: Ctx, s: Settings): void {
  if (!s.retentionMs) return;
  const cur = ctx.db.query("gc").first();
  if (cur) {
    if (cur.at > ctx.now) return;
    const job = ctx.scheduler.get(cur.job);
    if (job && (job.state.kind === "pending" || job.state.kind === "inProgress")) return;
  }
  const at = ctx.now + Math.min(s.retentionMs, DAY);
  const job = ctx.scheduler.runAt(at, "lib:gc", {});
  if (cur) ctx.db.patch(cur._id, { at, job });
  else ctx.db.insert("gc", { at, job });
}

/** Deletes a delivery and, with its last reference, its message (and the R2 object, by refcount). */
function dropDelivery(ctx: Ctx, d: Delivery): void {
  ctx.db.delete(d._id);
  const m = ctx.db.get(d.messageId);
  if (!m) return;
  if (m.refs <= 1) ctx.db.delete(m._id);
  else ctx.db.patch(m._id, { refs: m.refs - 1 });
}

/**
 * Replays up to `BATCH` dead deliveries of `e` after `cursor` (oldest first); the rest in a `lib:replayDeadRest` job
 * that continues after the last one replayed here (a replayed row that dies again before it runs is not taken again,
 * and the newer ones are not skipped). Returns how many now.
 */
function replayDeadFrom(ctx: Ctx, e: Endpoint, cursor: string | null): number {
  const s = settings(ctx);
  const page = ctx.db
    .query("deliveries")
    .withIndex("by_endpoint_status", (q) => q.eq("endpointId", e._id).eq("status", "dead"))
    .paginate({ numItems: BATCH, cursor }) as { page: Delivery[]; isDone: boolean; continueCursor: string };
  for (const d of page.page) replayOne(ctx, d, s);
  if (!page.isDone) ctx.scheduler.runAfter(0, "lib:replayDeadRest", { endpointId: e._id, cursor: page.continueCursor });
  return page.page.length;
}

/** Re-sends `d` from attempt 1 of a new round (same message id: receivers dedupe on it). */
function replayOne(ctx: Ctx, d: Delivery, s: Settings): void {
  if (d.retryJob) ctx.scheduler.cancel(d.retryJob);
  const e = ctx.db.get(d.endpointId) as Endpoint | null;
  if (!e) return raise(webhookErrors.EndpointNotFound({ endpointId: d.endpointId }));
  const fresh: Delivery = { ...d, roundStart: d.attempt, history: push(d.history, { at: ctx.now, attempt: d.attempt, event: "replay" }) };
  ctx.db.patch(d._id, { roundStart: d.attempt, history: fresh.history });
  dispatch(ctx, fresh, e, s);
}

// ------------------------------------------------------------------------------------------------ attempt

/** What `lib:attempt` reports to `lib:settle`. */
export type AttemptReport =
  | { skipped: true }
  /** Not sent: the endpoint was disabled or its breaker open when the attempt started. */
  | { held: true }
  /** Not sent: the stored url is no longer allowed (`http://` after `allowHttp` was turned off). */
  | { refused: string }
  | { status?: number; error?: string; retryAfterMs?: number; durationMs: number; body?: string };

const vReport = v.any();

async function readCapped(res: Response, max: number): Promise<string> {
  if (!res.body || max <= 0) {
    await res.body?.cancel().catch(() => {});
    return "";
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  try {
    while (n < max) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      n += value.length;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const all = new Uint8Array(Math.min(n, max));
  let off = 0;
  for (const c of chunks) {
    const take = Math.min(c.length, all.length - off);
    all.set(c.subarray(0, take), off);
    off += take;
    if (off >= all.length) break;
  }
  return new TextDecoder().decode(all);
}

const errorText = (e: unknown): string => {
  const err = e as { name?: string; message?: string } | null;
  if (err?.name === "TimeoutError" || err?.name === "AbortError") return "timeout";
  return String(err?.message ?? e).slice(0, 500);
};

// ------------------------------------------------------------------------------------------------ functions

const vEndpointArgs = {
  url: v.string(),
  events: v.optional(v.array(v.string())),
  description: v.optional(v.string()),
  metadata: v.optional(v.any()),
};

export const functions = {
  lib: {
    /**
     * Queues `event` with `payload` (any JSON value) for every enabled endpoint subscribed to it, in the caller's
     * transaction: 1 message row + 1 delivery row per endpoint. `endpointIds` limits it to those endpoints. Returns
     * the message id (`webhook-id`) and the delivery ids (none: no endpoint matched, nothing written).
     */
    send: mutation({
      args: { event: v.string(), payload: v.any(), endpointIds: v.optional(v.array(v.string())) },
      returns: v.object({ messageId: v.nullable(v.string()), deliveries: v.array(v.string()) }),
      errors: [webhookErrors.PayloadTooLarge],
      handler: (ctx, a) => {
        if (!a.event || a.event.length > 200) invalid("event must be a non-empty name (max 200)");
        const s = settings(ctx);
        const body = JSON.stringify(a.payload ?? null);
        const size = utf8Length(body);
        if (size > s.maxPayloadBytes) raise(webhookErrors.PayloadTooLarge({ size, max: s.maxPayloadBytes }));
        const only = a.endpointIds ? new Set(a.endpointIds) : null;
        const targets = (ctx.db.query("endpoints").withIndex("by_enabled", (q) => q.eq("enabled", true)).collect() as Endpoint[]).filter((e) => (!only || only.has(e._id)) && matchesEvent(e.events, a.event));
        if (!targets.length) return { messageId: null, deliveries: [] };
        const messageId = ctx.db.insert("messages", { event: a.event, body, size, refs: targets.length, createdAt: ctx.now });
        const ids: string[] = [];
        for (const e of targets) {
          const row = { endpointId: e._id, messageId, event: a.event, status: "pending" as const, attempt: 0, roundStart: 0, history: [], createdAt: ctx.now, updatedAt: ctx.now };
          const id = ctx.db.insert("deliveries", row);
          dispatch(ctx, { ...row, _id: id, _creationTime: ctx.now }, e, s);
          ids.push(id);
        }
        return { messageId: `msg_${messageId}`, deliveries: ids };
      },
    }),

    /** Adds an endpoint (enabled, breaker closed) with a new secret. Returns its id and the secret (shown once). */
    createEndpoint: mutation({
      args: vEndpointArgs,
      returns: v.object({ endpointId: v.string(), secret: v.string() }),
      handler: (ctx, a) => {
        const s = settings(ctx);
        checkUrl(a.url, s.allowHttp);
        const events = a.events ?? ["*"];
        checkEvents(events);
        const secret = generateWebhookSecret();
        const endpointId = ctx.db.insert("endpoints", {
          url: a.url,
          events,
          ...(a.description !== undefined ? { description: a.description } : {}),
          ...(a.metadata !== undefined ? { metadata: a.metadata } : {}),
          secrets: [{ secret, createdAt: ctx.now }],
          enabled: true,
          breaker: closedBreaker(),
          createdAt: ctx.now,
        });
        return { endpointId, secret };
      },
    }),
    /** Changes an endpoint's url, events, description or metadata. */
    updateEndpoint: mutation({
      args: { endpointId: v.string(), url: v.optional(v.string()), events: v.optional(v.array(v.string())), description: v.optional(v.string()), metadata: v.optional(v.any()) },
      returns: v.null(),
      errors: [webhookErrors.EndpointNotFound],
      handler: (ctx, a) => {
        const e = mustEndpoint(ctx, a.endpointId);
        const s = settings(ctx);
        if (a.url !== undefined) checkUrl(a.url, s.allowHttp);
        if (a.events !== undefined) checkEvents(a.events);
        ctx.db.patch(e._id, {
          ...(a.url !== undefined ? { url: a.url } : {}),
          ...(a.events !== undefined ? { events: a.events } : {}),
          ...(a.description !== undefined ? { description: a.description } : {}),
          ...(a.metadata !== undefined ? { metadata: a.metadata } : {}),
        });
        // A new url, half-open with no probe out (the last probe was refused by the url policy): the oldest held
        // delivery goes now as the probe, so the held ones get out without a disable and enable.
        if (a.url !== undefined) probeNext(ctx, { ...e, url: a.url }, s);
        return null;
      },
    }),
    /**
     * Enables or disables an endpoint. Disabled: `send` skips it and its retries wait (held); enabling it again closes
     * its breaker and releases them.
     */
    setEnabled: mutation({
      args: { endpointId: v.string(), enabled: v.boolean() },
      returns: v.null(),
      errors: [webhookErrors.EndpointNotFound],
      handler: (ctx, a) => {
        const e = mustEndpoint(ctx, a.endpointId);
        if (e.enabled === a.enabled) return null;
        if (!a.enabled) {
          ctx.db.patch(e._id, { enabled: false });
          return null;
        }
        if (e.probeJob) ctx.scheduler.cancel(e.probeJob);
        const next: Endpoint = { ...e, enabled: true, breaker: closedBreaker(), probeJob: undefined, probing: undefined };
        ctx.db.patch(e._id, { enabled: true, breaker: next.breaker, probeJob: undefined, probing: undefined });
        release(ctx, next, settings(ctx));
        return null;
      },
    }),
    /**
     * A new secret signs from now on; the previous one keeps signing too (a second `v1,` entry in
     * `webhook-signature`) for `graceMs` (default: the install's `rotationGraceMs`, 24 h), so receivers can switch.
     * Older secrets still in their grace period keep it, cut to `graceMs` when that is sooner (`graceMs: 0` revokes
     * every old secret at once). At most `MAX_SIGNING_SECRETS` sign at once: a rotation that would need more is
     * refused. Returns the new secret (shown once).
     */
    rotateSecret: mutation({
      args: { endpointId: v.string(), graceMs: v.optional(v.number()) },
      returns: v.object({ secret: v.string(), previousExpiresAt: v.number() }),
      errors: [webhookErrors.EndpointNotFound],
      handler: (ctx, a) => {
        const e = mustEndpoint(ctx, a.endpointId);
        const grace = a.graceMs !== undefined && Number.isFinite(a.graceMs) && a.graceMs >= 0 ? a.graceMs : settings(ctx).rotationGraceMs;
        const secret = generateWebhookSecret();
        const previousExpiresAt = ctx.now + grace;
        // Every secret keeps the expiry it was promised (or `previousExpiresAt`, when sooner); expired ones go.
        const kept = e.secrets
          .map((x) => ({ ...x, expiresAt: Math.min(x.expiresAt ?? Infinity, previousExpiresAt) }))
          .filter((x) => x.expiresAt > ctx.now);
        if (kept.length + 1 > MAX_SIGNING_SECRETS) invalid(`at most ${MAX_SIGNING_SECRETS} secrets sign at once: wait for an older one's grace period to end, or rotate with graceMs: 0`);
        ctx.db.patch(e._id, { secrets: [{ secret, createdAt: ctx.now }, ...kept] });
        return { secret, previousExpiresAt };
      },
    }),
    /** Deletes an endpoint and its deliveries (in batches of `BATCH`, the rest in jobs). */
    deleteEndpoint: mutation({
      args: { endpointId: v.string() },
      returns: v.boolean(),
      handler: (ctx, a) => {
        const e = endpointOf(ctx, a.endpointId);
        if (!e) return false;
        if (e.probeJob) ctx.scheduler.cancel(e.probeJob);
        ctx.db.delete(e._id);
        ctx.scheduler.runAfter(0, "lib:purge", { endpointId: e._id });
        return true;
      },
    }),
    /** Sends a delivery again (dead, failed or delivered), from attempt 1 of a new round, with the same message id. */
    replay: mutation({
      args: { deliveryId: v.string() },
      returns: v.null(),
      errors: [webhookErrors.DeliveryNotFound, webhookErrors.EndpointNotFound],
      handler: (ctx, a) => {
        const d = mustDelivery(ctx, a.deliveryId);
        if (d.status === "pending") invalid(`delivery ${d._id} is pending (in flight or waiting for its endpoint)`);
        replayOne(ctx, d, settings(ctx));
        return null;
      },
    }),
    /** Replays every dead delivery of an endpoint (`BATCH` now, the rest in jobs). Returns how many now. */
    replayDead: mutation({
      args: { endpointId: v.string() },
      returns: v.number(),
      errors: [webhookErrors.EndpointNotFound],
      handler: (ctx, a) => {
        const e = mustEndpoint(ctx, a.endpointId);
        return replayDeadFrom(ctx, e, null);
      },
    }),

    /** An endpoint, without its secrets (null when unknown). */
    getEndpoint: query({
      args: { endpointId: v.string() },
      returns: v.any(),
      handler: (ctx, a) => {
        const e = endpointOf(ctx, a.endpointId);
        return e ? publicEndpoint(e, ctx.now) : null;
      },
    }),
    /** Every endpoint of this shard, without secrets. */
    listEndpoints: query({
      args: {},
      returns: v.any(),
      handler: (ctx) => (ctx.db.query("endpoints").collect() as Endpoint[]).map((e) => publicEndpoint(e, ctx.now)),
    }),
    /** A delivery with its history (null when unknown). */
    getDelivery: query({
      args: { deliveryId: v.string() },
      returns: v.any(),
      handler: (ctx, a) => {
        const d = deliveryOf(ctx, a.deliveryId);
        return d ? publicDelivery(d) : null;
      },
    }),
    /** Deliveries newest first, a page at a time: all, by status, or of one endpoint (and status). */
    listDeliveries: query({
      args: { status: v.optional(vStatus), endpointId: v.optional(v.string()), paginationOpts: paginationOptsValidator },
      returns: v.any(),
      handler: (ctx, a) => {
        const page = deliveriesPage(ctx, a.status, a.endpointId, a.paginationOpts);
        return { ...page, page: page.page.map(publicDelivery) };
      },
    }),

    // ------------------------------------------------------------------------------------ internal (pool, jobs)

    /**
     * What an attempt needs; null when the attempt is stale (replayed, settled, or the endpoint is gone), `hold` when
     * the endpoint may not take it now (disabled, or its breaker opened while the attempt was queued).
     */
    prepare: internalQuery({
      args: { deliveryId: v.id("deliveries"), attempt: v.number() },
      handler: (ctx, a) => {
        const d = ctx.db.get(a.deliveryId) as Delivery | null;
        if (!d || d.attempt !== a.attempt || d.status !== "pending") return null;
        const e = ctx.db.get(d.endpointId) as Endpoint | null;
        const m = ctx.db.get(d.messageId);
        if (!e || !m) return null;
        if (!maySend(e, d)) return { hold: true as const };
        const s = settings(ctx);
        // The https policy applies to every attempt, not only when the url was set.
        const refused = refusedUrl(e.url, s.allowHttp);
        if (refused) return { refused };
        return {
          url: e.url,
          secrets: signing(e, ctx.now),
          msgId: `msg_${m._id}`,
          messageId: m._id,
          body: m.body ?? null,
          file: m.file ?? null,
          size: m.size,
          offload: m.body !== undefined && m.size > s.offloadBytes,
          timeoutMs: s.timeoutMs,
          maxResponseBytes: s.maxResponseBytes,
        };
      },
    }),
    /** Signs and POSTs one attempt. Never throws for the endpoint's answer: the report says what happened. */
    attempt: internalAction({
      args: { deliveryId: v.id("deliveries"), attempt: v.number() },
      handler: async (ctx, a): Promise<AttemptReport> => {
        type Prep = { url: string; secrets: string[]; msgId: string; messageId: string; body: string | null; file: string | null; size: number; offload: boolean; timeoutMs: number; maxResponseBytes: number };
        type Prepared = Prep | { hold: true } | { refused: string } | null;
        const p = (await ctx.runQuery(unsafeRef<"query">("lib:prepare"), a)) as Prepared;
        if (!p) return { skipped: true };
        // No POST: settle holds it until the endpoint can take it (the probe or `release` sends it then).
        if ("hold" in p) return { held: true };
        if ("refused" in p) return { refused: p.refused };
        let body = p.body;
        if (body === null && p.file) {
          const f = await ctx.storage.get(p.file);
          if (!f) return { error: "payload file missing", durationMs: 0 };
          body = await new Response(f.body).text();
        }
        if (body === null) return { error: "payload missing", durationMs: 0 };
        if (p.offload) {
          // Large payloads leave the shard on their first attempt (content-addressed: concurrent attempts store one object).
          try {
            const file = await ctx.storage.store(new TextEncoder().encode(body), { contentType: "application/json" });
            await ctx.runMutation(unsafeRef<"mutation">("lib:offload"), { messageId: p.messageId, file });
          } catch (e) {
            console.error("webhooks: payload offload failed (kept in the shard)", e);
          }
        }
        // Storage work awaited: the endpoint is read again, so a rotation (`graceMs: 0` revokes), a disable or a new
        // url committed meanwhile applies to this attempt.
        let { url, secrets } = p;
        if (p.file || p.offload) {
          const again = (await ctx.runQuery(unsafeRef<"query">("lib:prepare"), a)) as Prepared;
          if (!again) return { skipped: true };
          if ("hold" in again) return { held: true };
          if ("refused" in again) return { refused: again.refused };
          ({ url, secrets } = again);
        }
        const timestamp = Math.floor(Date.now() / 1000);
        const headers = { "content-type": "application/json", "user-agent": "Ember-Webhooks/1", ...(await webhookHeaders(secrets, p.msgId, timestamp, body)) };
        const started = Date.now();
        try {
          const res = await fetch(url, { method: "POST", headers, body, redirect: "manual", signal: AbortSignal.timeout(p.timeoutMs) });
          const text = await readCapped(res, p.maxResponseBytes).catch(() => "");
          const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"), Date.now());
          return { status: res.status, durationMs: Date.now() - started, body: text, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
        } catch (e) {
          return { error: errorText(e), durationMs: Date.now() - started };
        }
      },
    }),
    /** Moves a message's body to R2 (`file`); a no-op once done. */
    offload: internalMutation({
      args: { messageId: v.id("messages"), file: v.file() },
      handler: (ctx, a) => {
        const m = ctx.db.get(a.messageId);
        if (m && m.body !== undefined && !m.file) ctx.db.patch(m._id, { file: a.file, body: undefined });
      },
    }),
    /** The pool's onComplete: the attempt's outcome, the next step and the breaker, in one transaction. */
    settle: internalMutation({
      args: { workId: v.string(), context: v.object({ deliveryId: v.id("deliveries"), attempt: v.number() }), result: v.any() },
      handler: (ctx, a) => {
        const d = ctx.db.get(a.context.deliveryId) as Delivery | null;
        if (!d || d.attempt !== a.context.attempt || d.status !== "pending" || d.workId !== a.workId) return;
        const result = a.result as { kind: "success"; returnValue: AttemptReport } | { kind: "failed"; error: string } | { kind: "canceled" };
        const report: AttemptReport = result.kind === "success" ? result.returnValue : { error: result.kind === "failed" ? result.error : "canceled", durationMs: 0 };
        const e = ctx.db.get(d.endpointId) as Endpoint | null;
        if ("skipped" in report || !e) return;
        const s = settings(ctx);
        // The attempt did not go: it gets its number back (it used no retry) and waits, or goes now if the endpoint
        // can take it again by now (`release` ran before it was held, so it would not see it).
        if ("held" in report) return dispatch(ctx, { ...d, attempt: d.attempt - 1 }, e, s);
        // Refused by the url policy: dead at once (a retry would be refused too), shown with why; the breaker is not
        // the endpoint's answer, so it does not move. A refused probe gives its reservation back (still half-open):
        // the next send or retry is the probe, and so is the oldest held one when the url is changed
        // (`updateEndpoint`). The held ones are not sent as probes here: the same url would refuse each of them.
        if ("refused" in report) {
          ctx.db.patch(d._id, { workId: undefined, updatedAt: ctx.now, status: "dead", lastError: report.refused, history: push(d.history, { at: ctx.now, attempt: d.attempt, event: "dead", error: report.refused }) });
          if (e.probing === d._id) ctx.db.patch(e._id, { probing: undefined });
          ensureGc(ctx, s);
          return;
        }
        const outcome = report.error !== undefined ? classify(undefined) : classify(report.status, report.retryAfterMs);
        const wasProbe = e.probing === d._id;
        // Half-open with its probe out: only the probe's outcome moves the breaker. An attempt sent before the breaker
        // opened that reports now is recorded, but neither closes it (releasing the held ones under the probe) nor
        // reopens it.
        const probeOut = e.breaker.state === "halfOpen" && e.probing !== undefined && !wasProbe;
        const base = {
          workId: undefined,
          updatedAt: ctx.now,
          durationMs: report.durationMs,
          ...(report.status !== undefined ? { responseStatus: report.status } : { responseStatus: undefined }),
          responseBody: report.body !== undefined && report.body !== "" ? report.body : undefined,
        };
        const entry: Omit<History, "event"> = { at: ctx.now, attempt: d.attempt, durationMs: report.durationMs, ...(report.status !== undefined ? { status: report.status } : {}), ...(report.error !== undefined ? { error: report.error } : {}) };

        if (outcome.kind === "delivered") {
          ctx.db.patch(d._id, { ...base, status: "delivered", deliveredAt: ctx.now, lastError: undefined, history: push(d.history, { ...entry, event: "delivered" }) });
          const reopened = e.breaker.state !== "closed" || e.breaker.failures > 0;
          if (reopened && !probeOut) {
            if (e.probeJob) ctx.scheduler.cancel(e.probeJob);
            const next: Endpoint = { ...e, breaker: breakerOnSuccess(e.breaker), probeJob: undefined, probing: undefined };
            ctx.db.patch(e._id, { breaker: next.breaker, probeJob: undefined, probing: undefined });
            release(ctx, next, s);
          }
          ensureGc(ctx, s);
          return;
        }

        const error = report.error ?? `HTTP ${report.status}`;
        // The breaker counts every failed attempt (a refusal too: the endpoint is not taking deliveries).
        const breaker = probeOut ? { ...e.breaker, failures: e.breaker.failures + 1 } : breakerOnFailure(e.breaker, ctx.now, s.threshold, s.cooldownMs);
        const opened = breaker.state === "open" && e.breaker.state !== "open";
        ctx.db.patch(e._id, { breaker, ...(opened ? { probeJob: scheduleProbe(ctx, e, breaker) } : {}), ...(wasProbe ? { probing: undefined } : {}) });

        const delay = outcome.kind === "retry" ? retryDelay(d.attempt - d.roundStart - 1, s.retrySchedule, ctx.random(), s.jitter, outcome.retryAfterMs) : null;
        if (delay === null) {
          ctx.db.patch(d._id, { ...base, status: "dead", lastError: error, history: push(d.history, { ...entry, event: "dead" }) });
          ensureGc(ctx, s);
          return;
        }
        const nextAt = ctx.now + delay;
        const retryJob = ctx.scheduler.runAt(nextAt, "lib:retry", { deliveryId: d._id, attempt: d.attempt });
        ctx.db.patch(d._id, { ...base, status: "failed", lastError: error, nextAt, retryJob, history: push(d.history, { ...entry, event: "retry" }) });
      },
    }),
    /** A scheduled retry: sends the next attempt (or holds it, breaker open / endpoint disabled). */
    retry: internalMutation({
      args: { deliveryId: v.id("deliveries"), attempt: v.number() },
      handler: (ctx, a) => {
        const d = ctx.db.get(a.deliveryId) as Delivery | null;
        if (!d || d.status !== "failed" || d.attempt !== a.attempt) return;
        const e = ctx.db.get(d.endpointId) as Endpoint | null;
        if (!e) return;
        dispatch(ctx, { ...d, retryJob: undefined }, e, settings(ctx));
      },
    }),
    /** The cooldown is over: half-open, and the oldest held delivery goes as the probe. */
    probe: internalMutation({
      args: { endpointId: v.id("endpoints") },
      handler: (ctx, a) => {
        const e = ctx.db.get(a.endpointId) as Endpoint | null;
        if (!e || e.breaker.state !== "open") return;
        const breaker = breakerHalfOpen(e.breaker);
        ctx.db.patch(e._id, { breaker, probeJob: undefined, probing: undefined });
        probeNext(ctx, { ...e, breaker, probeJob: undefined, probing: undefined }, settings(ctx));
      },
    }),
    /** Releases the next batch of held deliveries. */
    release: internalMutation({
      args: { endpointId: v.id("endpoints") },
      handler: (ctx, a) => {
        const e = ctx.db.get(a.endpointId) as Endpoint | null;
        if (e) release(ctx, e, settings(ctx));
      },
    }),
    /** The next batch of a `replayDead`, after the last row the previous one replayed. */
    replayDeadRest: internalMutation({
      args: { endpointId: v.id("endpoints"), cursor: v.string() },
      handler: (ctx, a) => {
        const e = ctx.db.get(a.endpointId) as Endpoint | null;
        if (e) replayDeadFrom(ctx, e, a.cursor);
      },
    }),
    /** Deletes the deliveries of a deleted endpoint, `BATCH` per job. */
    purge: internalMutation({
      args: { endpointId: v.id("endpoints") },
      handler: (ctx, a) => {
        const rows = ctx.db
          .query("deliveries")
          .withIndex("by_endpoint", (q) => q.eq("endpointId", a.endpointId))
          .take(BATCH + 1) as Delivery[];
        for (const d of rows.slice(0, BATCH)) {
          if (d.retryJob) ctx.scheduler.cancel(d.retryJob);
          dropDelivery(ctx, d);
        }
        if (rows.length > BATCH) ctx.scheduler.runAfter(0, "lib:purge", { endpointId: a.endpointId });
      },
    }),
    /** Deletes delivered and dead deliveries older than `retentionMs` (`BATCH` per status), then reschedules. */
    gc: internalMutation({
      args: {},
      handler: (ctx) => {
        const s = settings(ctx);
        const cur = ctx.db.query("gc").first();
        if (!s.retentionMs) {
          if (cur) ctx.db.delete(cur._id);
          return 0;
        }
        const cutoff = ctx.now - s.retentionMs;
        let full = false;
        let n = 0;
        for (const status of ["delivered", "dead"] as const) {
          const old = ctx.db
            .query("deliveries")
            .withIndex("by_status", (q) => q.eq("status", status).lt("updatedAt", cutoff))
            .take(BATCH + 1) as Delivery[];
          for (const d of old.slice(0, BATCH)) dropDelivery(ctx, d);
          n += Math.min(old.length, BATCH);
          if (old.length > BATCH) full = true;
        }
        const left = full || ctx.db.query("deliveries").withIndex("by_status", (q) => q.eq("status", "delivered")).first() || ctx.db.query("deliveries").withIndex("by_status", (q) => q.eq("status", "dead")).first();
        if (!left) {
          if (cur) ctx.db.delete(cur._id);
          return n;
        }
        const at = full ? ctx.now : ctx.now + Math.min(s.retentionMs, DAY);
        const job = ctx.scheduler.runAt(at, "lib:gc", {});
        if (cur) ctx.db.patch(cur._id, { at, job });
        else ctx.db.insert("gc", { at, job });
        return n;
      },
    }),
  },
};

type PageOpts = { numItems: number; cursor: string | null; endCursor?: string | null };
function deliveriesPage(ctx: ReadCtx, status: DeliveryStatus | undefined, endpointId: string | undefined, opts: PageOpts) {
  if (endpointId !== undefined) {
    const id = ctx.db.normalizeId("endpoints", endpointId);
    if (!id) return { page: [] as Delivery[], isDone: true, continueCursor: "" };
    // Newest first: one status of the endpoint (`by_endpoint_status`) or all of them in time order (`by_endpoint`).
    const q = ctx.db.query("deliveries");
    const indexed = status !== undefined ? q.withIndex("by_endpoint_status", (r) => r.eq("endpointId", id).eq("status", status)) : q.withIndex("by_endpoint", (r) => r.eq("endpointId", id));
    return indexed.order("desc").paginate(opts) as { page: Delivery[]; isDone: boolean; continueCursor: string };
  }
  if (status !== undefined) {
    return ctx.db
      .query("deliveries")
      .withIndex("by_status_created", (q) => q.eq("status", status))
      .order("desc")
      .paginate(opts) as { page: Delivery[]; isDone: boolean; continueCursor: string };
  }
  return ctx.db.query("deliveries").order("desc").paginate(opts) as { page: Delivery[]; isDone: boolean; continueCursor: string };
}

// ------------------------------------------------------------------------------------------------ dashboard

const dashboardFunctions = {
  endpoints: internalQuery({
    args: {},
    handler: (ctx) =>
      (ctx.db.query("endpoints").collect() as Endpoint[]).map((e) => ({
        _id: e._id,
        url: e.url,
        events: e.events.join(", "),
        enabled: e.enabled,
        breaker: e.breaker.state,
        failures: e.breaker.failures,
        probeAt: e.breaker.state === "open" ? (e.breaker.probeAt ?? null) : null,
        signingSecrets: signing(e, ctx.now).length,
        createdAt: e.createdAt,
      })),
  }),
  deliveries: internalQuery({
    args: { status: v.optional(vStatus), endpointId: v.optional(v.string()), paginationOpts: paginationOptsValidator },
    handler: (ctx, a) => {
      const page = deliveriesPage(ctx, a.status, a.endpointId, a.paginationOpts);
      return {
        ...page,
        page: page.page.map((d) => ({
          _id: d._id,
          event: d.event,
          status: d.status,
          endpointId: d.endpointId,
          attempt: d.attempt,
          responseStatus: d.responseStatus ?? null,
          lastError: d.lastError ?? null,
          durationMs: d.durationMs ?? null,
          nextAt: d.nextAt ?? null,
          held: d.heldAt !== undefined,
          updatedAt: d.updatedAt,
        })),
      };
    },
  }),
  delivery: internalQuery({
    args: { deliveryId: v.string() },
    handler: (ctx, a) => {
      const d = deliveryOf(ctx, a.deliveryId);
      if (!d) return null;
      const m = ctx.db.get(d.messageId);
      // Where the payload is: in the shard (`body`) or in R2 (`file`, after the first attempt of a large one).
      return { ...publicDelivery(d), payload: m ? { size: m.size, storage: m.file ? "r2" : "shard", messageId: `msg_${m._id}` } : null };
    },
  }),
  stats: internalQuery({
    args: {},
    handler: (ctx) => {
      // Counted up to 1000 per status (at most 1001 rows read each).
      const count = (status: DeliveryStatus) => ((n) => (n > 1000 ? "1000+" : n))(ctx.db.query("deliveries").withIndex("by_status", (q) => q.eq("status", status)).take(1001).length);
      const endpoints = ctx.db.query("endpoints").collect() as Endpoint[];
      return { endpoints: endpoints.length, open: endpoints.filter((e) => e.breaker.state !== "closed").length, pending: count("pending"), failed: count("failed"), dead: count("dead"), delivered: count("delivered") };
    },
  }),
};

export const webhooks = defineComponent({
  name: "webhooks",
  schema,
  config: v.optional(installConfigValidator),
  functions: { ...functions, dashboard: dashboardFunctions },
  dashboard: {
    label: "Webhooks",
    icon: "bell",
    description: "Outbound webhooks of this shard: endpoints with their circuit breaker, and every delivery with its attempts.",
    tabs: [
      {
        id: "endpoints",
        label: "Endpoints",
        blocks: [
          {
            kind: "stats",
            id: "stats",
            query: dashboardFunctions.stats,
            items: [
              { label: "Endpoints", path: "endpoints", format: "number" },
              { label: "Breaker open", path: "open", format: "number" },
              { label: "Pending", path: "pending", format: "number" },
              { label: "Retrying", path: "failed", format: "number" },
              { label: "Dead", path: "dead", format: "number" },
            ],
          },
          {
            kind: "table",
            id: "endpoints",
            query: dashboardFunctions.endpoints,
            columns: [
              { label: "URL", path: "url", format: "code" },
              { label: "Events", path: "events" },
              { label: "Enabled", path: "enabled", format: "boolean", toggle: { mutation: functions.lib.setEnabled, arg: "enabled", fromRow: { endpointId: "_id" } } },
              { label: "Breaker", path: "breaker", format: "badge" },
              { label: "Failures", path: "failures", format: "number" },
              { label: "Next probe", path: "probeAt", format: "date" },
              { label: "Secrets signing", path: "signingSecrets", format: "number" },
              { label: "Created", path: "createdAt", format: "ago" },
            ],
            rowActions: [
              { id: "rotate", label: "Rotate secret", fn: functions.lib.rotateSecret, fromRow: { endpointId: "_id" }, destructive: true, description: "A new secret signs from now on; the old one keeps signing for the grace period (24 h unless graceMs). The new secret is shown once." },
              { id: "replayDead", label: "Replay dead", fn: functions.lib.replayDead, fromRow: { endpointId: "_id" }, description: "Sends every dead delivery of this endpoint again, with the same message ids." },
              { id: "delete", label: "Delete", fn: functions.lib.deleteEndpoint, fromRow: { endpointId: "_id" }, destructive: true, description: "Deletes the endpoint and its deliveries." },
            ],
          },
          { kind: "actions", id: "manage", label: "Manage", actions: [{ id: "create", label: "Add endpoint…", fn: functions.lib.createEndpoint }] },
        ],
      },
      {
        id: "deliveries",
        label: "Deliveries",
        blocks: [
          {
            kind: "table",
            id: "deliveries",
            query: dashboardFunctions.deliveries,
            filters: ["status", "endpointId"],
            columns: [
              { label: "Event", path: "event", format: "code" },
              { label: "Status", path: "status", format: "badge" },
              { label: "Attempt", path: "attempt", format: "number" },
              { label: "HTTP", path: "responseStatus", format: "number" },
              { label: "Error", path: "lastError" },
              { label: "Duration", path: "durationMs", format: "ms" },
              { label: "Next retry", path: "nextAt", format: "date" },
              { label: "Held", path: "held", format: "boolean" },
              { label: "Updated", path: "updatedAt", format: "ago" },
            ],
            detail: {
              query: dashboardFunctions.delivery,
              fromRow: { deliveryId: "_id" },
              sections: [
                { kind: "kv", items: [{ label: "Endpoint", path: "endpointId", format: "code" }, { label: "Message", path: "payload.messageId", format: "code" }, { label: "Payload", path: "payload.size", format: "bytes" }, { label: "Stored in", path: "payload.storage", format: "badge" }, { label: "Response", path: "responseBody", format: "code" }] },
                { kind: "timeline", path: "history", time: "at", title: "event", detail: "error", status: "status" },
              ],
            },
            rowActions: [{ id: "replay", label: "Replay", fn: functions.lib.replay, fromRow: { deliveryId: "_id" }, description: "Sends this delivery again (dead or failed; same message id)." }],
          },
        ],
      },
    ],
  },
}).use(workpool, { name: "pool" });
