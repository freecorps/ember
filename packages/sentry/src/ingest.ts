// Ingestion compatible with the Sentry Envelope API: `POST <mount>/api/<project>/envelope/`, the endpoint the official
// SDKs (`@sentry/react`, `@sentry/react-native`, `@sentry/cloudflare`, ...) send to for the DSN
// `https://<key>@<host>/<mount>/<project>`.
//
// The ingest path never touches a Durable Object: auth, the rate limit and sampling read the install config; events go
// to the component's Queue (the consumer groups them into issues, one write per issue per batch); attachments, replays
// and oversized events go to R2; sessions, transactions and drops are Analytics Engine points. 0 rows written per event.

import { aeOf, INLINE_EVENT_MAX, limitsOf, queueOf, r2Of, DEFAULT_RATE, type RateLimitLike, type SentryInstallConfig, type SentryProjectConfig } from "./config.ts";
import { decodeBody, EnvelopeError, itemJson, parseEnvelope, readCapped, utf8, type EnvelopeItem, type JsonObject } from "./envelope.ts";
import { eventId, isObj, type SentryEvent } from "./event.ts";
import { droppedPoint, sessionPoints, transactionPoint } from "./analytics.ts";
import { keys, putGzip } from "./storage.ts";

/** A queue message: one error event (inline, or in R2 when too big for a message). */
export interface QueuedEvent {
  v: 1;
  project: string;
  id: string;
  receivedAt: number;
  event?: SentryEvent;
  /** R2 key of the gzipped event (`spill/...`), when it did not fit in the message. */
  spill?: string;
}

export interface IngestDeps {
  config: SentryInstallConfig;
  /** Install path (`ctx.component.name`). */
  install: string;
  env: Record<string, unknown>;
  now?: number;
  random?: () => number;
  /** Without the queue binding (tests, a Worker deployed without it): the messages go to the consumer inline. */
  inline?: (messages: QueuedEvent[]) => Promise<void>;
  /** Per-isolate token buckets (shared by default). */
  buckets?: TokenBuckets;
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-expose-headers": "x-sentry-error, x-sentry-rate-limits, retry-after",
};
const PREFLIGHT = {
  ...CORS,
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type, content-encoding, x-sentry-auth, authorization, sentry-trace, baggage",
  "access-control-max-age": "86400",
};

function reply(status: number, body: JsonObject, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...CORS, ...extra } });
}
const refuse = (status: number, detail: string, extra: Record<string, string> = {}) => reply(status, { detail }, { "x-sentry-error": detail, ...extra });

/** `/<mount>/api/<project>/envelope/` → the project id (trailing slash optional). */
export function projectFromPath(pathname: string): string | null {
  const m = /\/api\/([^/]+)\/envelope\/?$/.exec(pathname);
  return m ? decodeURIComponent(m[1]!) : null;
}

/** `sentry_key` from `X-Sentry-Auth: Sentry sentry_key=..., sentry_version=7` or the `?sentry_key=` query. */
export function keyFromRequest(request: Request, url = new URL(request.url)): string | null {
  const h = request.headers.get("x-sentry-auth") ?? request.headers.get("authorization");
  const m = h ? /(?:^|[\s,])sentry_key\s*=\s*([^,\s]+)/.exec(h) : null;
  if (m) return m[1]!;
  return url.searchParams.get("sentry_key");
}

/** The public key of a DSN (`https://<key>@host/...`), or null. */
export function keyFromDsn(dsn: unknown): string | null {
  if (typeof dsn !== "string") return null;
  try {
    return new URL(dsn).username || null;
  } catch {
    return null;
  }
}

/** Per-isolate token buckets, one per project: a cheap first line when no Rate Limiting binding is configured. */
export class TokenBuckets {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  /** Takes a token; returns 0, or the seconds until one is back. */
  take(key: string, perMinute: number, burst: number, now: number): number {
    const rate = perMinute / 60_000;
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size > 10_000) this.buckets.clear();
      this.buckets.set(key, (b = { tokens: burst, at: now }));
    }
    b.tokens = Math.min(burst, b.tokens + (now - b.at) * rate);
    b.at = now;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return 0;
    }
    return Math.max(1, Math.ceil((1 - b.tokens) / rate / 1000));
  }
}
export const isolateBuckets = new TokenBuckets();

/** `X-Sentry-Rate-Limits: <seconds>:<categories>:<scope>:<reason>` (empty categories = all). */
export const rateLimitHeaders = (seconds: number) => ({ "retry-after": String(seconds), "x-sentry-rate-limits": `${seconds}::project:ember_rate_limit` });

async function limited(deps: IngestDeps, project: string, now: number): Promise<number> {
  const rl = deps.config.rateLimit;
  if (rl === false) return 0;
  if (rl?.binding) {
    const b = deps.env[rl.binding] as RateLimitLike | undefined;
    if (b && typeof b.limit === "function") return (await b.limit({ key: `sentry:${deps.install}:${project}` })).success ? 0 : 60;
    console.error(`ember-sentry: rateLimit.binding ${rl.binding} is not bound; using the per-isolate bucket`);
  }
  return (deps.buckets ?? isolateBuckets).take(`${deps.install}:${project}`, rl?.perMinute ?? DEFAULT_RATE.perMinute, rl?.burst ?? DEFAULT_RATE.burst, now);
}

const keyMatches = (p: SentryProjectConfig, key: string | null) => key !== null && p.keys.some((k) => timingSafeEqual(k, key));

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** Handles one envelope request. Never throws (a failure is a Sentry-shaped error response). */
export async function handleIngest(request: Request, deps: IngestDeps): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: PREFLIGHT });
  if (request.method !== "POST") return refuse(405, "method not allowed", { allow: "POST, OPTIONS" });
  const now = deps.now ?? Date.now();
  const random = deps.random ?? Math.random;
  const url = new URL(request.url);
  const projectId = projectFromPath(url.pathname);
  const project = projectId === null ? undefined : deps.config.projects.find((p) => p.id === projectId);
  if (!project) return refuse(404, "unknown project");
  const ae = aeOf(deps.env, deps.config, deps.install);
  let key = keyFromRequest(request, url);
  // A key in the header or query is checked before the body is read (a bad DSN costs nothing).
  if (key !== null && !keyMatches(project, key)) return refuse(403, "invalid sentry_key");
  const wait = await limited(deps, project.id, now);
  if (wait > 0) {
    droppedPoint(ae, project.id, "rate_limited", "envelope");
    return refuse(429, "rate limited", rateLimitHeaders(wait));
  }
  const limits = limitsOf(deps.config);
  const declared = Number(request.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > limits.maxEnvelopeBytes) return tooLarge(ae, project.id);
  let envelope;
  try {
    const raw = await readCapped(request.body, limits.maxEnvelopeBytes);
    envelope = parseEnvelope(await decodeBody(raw, request.headers.get("content-encoding"), limits.maxDecompressedBytes));
  } catch (e) {
    if (e instanceof EnvelopeError) {
      if (e.reason === "too_large") return tooLarge(ae, project.id);
      droppedPoint(ae, project.id, "invalid", "envelope");
      return refuse(e.reason === "unsupported" ? 415 : 400, e.message);
    }
    throw e;
  }
  // Without a key in the header or query, the envelope header's `dsn` carries it.
  if (key === null) {
    key = keyFromDsn(envelope.header.dsn);
    if (!keyMatches(project, key)) return refuse(key === null ? 401 : 403, key === null ? "missing sentry_key" : "invalid sentry_key");
  }

  const bucket = r2Of(deps.env, deps.config);
  const headerId = typeof envelope.header.event_id === "string" ? envelope.header.event_id : undefined;
  // Pass 1, no writes: every condition that refuses the whole envelope (an oversized event or transaction, an item
  // that is not JSON, an event too big for a queue message with nowhere to spill it), so a refused envelope stored
  // nothing and its corrected resend counts once. Oversized attachments and replays are dropped per item (pass 2).
  const plan: Array<{ type: unknown; item: EnvelopeItem; json?: JsonObject }> = [];
  try {
    for (const item of envelope.items) {
      const type = item.header.type;
      if ((type === "event" || type === "transaction") && item.payload.length > limits.maxEventBytes) return tooLarge(ae, project.id);
      const parse = type === "event" || type === "transaction" || type === "session" || type === "sessions" || (type === "replay_event" && !!bucket && item.payload.length <= limits.maxReplayBytes);
      const json = parse ? itemJson(item) : undefined;
      if (type === "sessions" && !validAggregates(json!)) return refuse(400, "sessions payload: aggregates must be a list of objects");
      if (type === "event") {
        // The final id now, so the size check below measures the message that is queued.
        const ev = json as SentryEvent;
        ev.event_id = (typeof ev.event_id === "string" && ev.event_id) || headerId || eventId();
      }
      if (type === "event" && !bucket && !fitsInline(json as SentryEvent, project.id, now)) return refuse(413, "event too large for a queue message (no R2 bucket to spill it to)");
      plan.push({ type, item, ...(json ? { json } : {}) });
    }
  } catch (e) {
    if (e instanceof EnvelopeError) return refuse(400, e.message);
    throw e;
  }
  // Pass 2: sampling and writes.
  const messages: QueuedEvent[] = [];
  let replayId: string | undefined;
  let attachments = 0;
  let firstId: string | undefined = headerId;
  for (const { type, item, json } of plan) {
    if (type === "event") {
      const ev = json as SentryEvent;
      const id = ev.event_id as string; // set in pass 1
      firstId ??= id;
      if (random() >= (project.sampleRate ?? 1)) {
        droppedPoint(ae, project.id, "sampled", "event");
        continue;
      }
      messages.push((await queueMessage(deps.install, bucket, project.id, id, ev, now))!);
    } else if (type === "transaction") {
      const tx = json!;
      firstId ??= typeof tx.event_id === "string" ? tx.event_id : undefined;
      if (random() < (project.transactionSampleRate ?? 0)) transactionPoint(ae, project.id, tx);
      else droppedPoint(ae, project.id, "sampled", "transaction");
    } else if (type === "session" || type === "sessions") {
      sessionPoints(ae, project.id, type, json!);
    } else if (type === "attachment") {
      if (!bucket || item.payload.length > limits.maxAttachmentBytes) {
        droppedPoint(ae, project.id, bucket ? "too_large" : "no_bucket", "attachment");
        continue;
      }
      const filename = typeof item.header.filename === "string" ? item.header.filename : "attachment";
      await putGzip(bucket, keys.attachment(deps.install, now, project.id, headerId ?? "unknown", attachments++, filename), item.payload, typeof item.header.content_type === "string" ? item.header.content_type : "application/octet-stream");
    } else if (type === "replay_event" || type === "replay_recording") {
      if (!bucket || item.payload.length > limits.maxReplayBytes) {
        droppedPoint(ae, project.id, bucket ? "too_large" : "no_bucket", type);
        continue;
      }
      const replay = type === "replay_event" ? json! : null;
      replayId = (replay && typeof replay.replay_id === "string" ? replay.replay_id : undefined) ?? replayId ?? headerId ?? eventId();
      const segment = replay && typeof replay.segment_id === "number" ? replay.segment_id : segmentOf(item);
      await putGzip(bucket, keys.replay(deps.install, now, project.id, replayId, segment, type === "replay_event" ? "event" : "recording"), item.payload, type === "replay_event" ? "application/json" : "application/octet-stream");
      firstId ??= replayId;
    }
    // client_report, check_in, profile, statsd, span, feedback...: accepted and not stored.
  }
  if (messages.length) {
    const queue = queueOf(deps.env, deps.install);
    if (queue) {
      for (let i = 0; i < messages.length; i += 100) await queue.sendBatch(messages.slice(i, i + 100).map((body) => ({ body, contentType: "json" })));
    } else if (deps.inline) {
      await deps.inline(messages);
    } else {
      droppedPoint(ae, project.id, "no_queue", "event", messages.length);
    }
  }
  return reply(200, firstId ? { id: firstId } : {});
}

function tooLarge(ae: ReturnType<typeof aeOf>, project: string): Response {
  droppedPoint(ae, project, "too_large", "envelope");
  return refuse(413, "envelope too large");
}

/** A replay recording's payload starts with a JSON header line (`{"segment_id":3}`). */
function segmentOf(item: EnvelopeItem): number {
  const nl = item.payload.indexOf(10);
  if (nl < 0 || nl > 256) return 0;
  try {
    const h = JSON.parse(utf8.decode(item.payload.subarray(0, nl))) as JsonObject;
    return typeof h.segment_id === "number" ? h.segment_id : 0;
  } catch {
    return 0;
  }
}

/** A `sessions` payload's `aggregates`: absent, or a list of objects (what `sessionPoints` reads). */
const validAggregates = (payload: JsonObject) => payload.aggregates === undefined || (Array.isArray(payload.aggregates) && payload.aggregates.every(isObj));

const encoder = new TextEncoder();
/** A queue message's size as sent (UTF-8 JSON). */
export const messageBytes = (msg: QueuedEvent) => encoder.encode(JSON.stringify(msg)).length;

/** The event without its breadcrumbs (usually what makes it big): what goes inline when there is no bucket to spill to. */
const withoutBreadcrumbs = (ev: SentryEvent): SentryEvent => {
  const { breadcrumbs: _b, ...rest } = ev;
  return { ...rest, breadcrumbs: { values: [] } };
};

/** Whether the event fits in a queue message without spilling (as is, or without its breadcrumbs). */
export function fitsInline(ev: SentryEvent, project: string, now: number): boolean {
  const msg: QueuedEvent = { v: 1, project, id: typeof ev.event_id === "string" ? ev.event_id : "0".repeat(32), receivedAt: now, event: ev };
  return messageBytes(msg) <= INLINE_EVENT_MAX || messageBytes({ ...msg, event: withoutBreadcrumbs(ev) }) <= INLINE_EVENT_MAX;
}

/**
 * The queue message for one event: inline when it fits `INLINE_EVENT_MAX` (UTF-8 bytes, headroom under the Queue's
 * 128 KB), else spilled to R2 under a key of its own (never shared by two messages, even for the same event id), else
 * inline without breadcrumbs. Null when it does not fit at all (no bucket, still too big): the caller refuses it.
 */
export async function queueMessage(install: string, bucket: ReturnType<typeof r2Of>, project: string, id: string, ev: SentryEvent, now: number): Promise<QueuedEvent | null> {
  const msg: QueuedEvent = { v: 1, project, id, receivedAt: now, event: ev };
  if (messageBytes(msg) <= INLINE_EVENT_MAX) return msg;
  if (bucket) {
    const spill = keys.spill(install, now, project, `${id}-${crypto.randomUUID().slice(0, 8)}`);
    await putGzip(bucket, spill, JSON.stringify(ev));
    return { v: 1, project, id, receivedAt: now, spill };
  }
  const stripped: QueuedEvent = { ...msg, event: withoutBreadcrumbs(ev) };
  return messageBytes(stripped) <= INLINE_EVENT_MAX ? stripped : null;
}
