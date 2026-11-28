// Install config of the sentry component, its defaults, and the structural types of the bindings it uses (R2, Queue,
// Analytics Engine, Rate Limiting): no @cloudflare/workers-types in the public surface.

import { v, type Infer } from "@freecorps/ember-values";

const alertsFields = {
  /** Alert on a new issue (default true). */
  newIssue: v.optional(v.boolean()),
  /** Alert when a resolved issue is seen again (default true). */
  regression: v.optional(v.boolean()),
  /** Alert when an issue gets `events` events within `windowMinutes` (off by default). */
  spike: v.optional(v.union(v.literal(false), v.object({ events: v.number(), windowMinutes: v.number() }))),
  /** At most one regression / spike alert per issue this often (default 30 min). */
  throttleMinutes: v.optional(v.number()),
  /** At most this many alerts per project per hour (default 20); the rest are counted, not sent. */
  maxPerHour: v.optional(v.number()),
  /** Signed webhooks (`x-ember-sentry-signature: t=<unix>,v1=<hex HMAC-SHA256(secret, t + "." + body)>`). */
  webhooks: v.optional(v.array(v.object({ url: v.string(), secretEnv: v.optional(v.string()) }))),
  /**
   * A mutation of the app (a function handle: `createFunctionHandle(internal.alerts.notify)`) called with
   * `{ alert }` per alert: send it with the email or push component there (`alertEmail`, `alertPush`).
   */
  handler: v.optional(v.string()),
};

export const alertsValidator = v.object(alertsFields);

export const projectValidator = v.object({
  /** The DSN's project id (`https://<key>@<host>/<mount>/<id>`). */
  id: v.string(),
  /** Accepted DSN public keys (`sentry_key`). Several while rotating one. */
  keys: v.array(v.string()),
  name: v.optional(v.string()),
  /** Fraction of error events kept (0..1, default 1). */
  sampleRate: v.optional(v.number()),
  /** Fraction of transactions kept as Analytics Engine points (0..1, default 0: dropped). */
  transactionSampleRate: v.optional(v.number()),
  /** Overrides of the install's `alerts` for this project (`false`: none). */
  alerts: v.optional(v.union(v.literal(false), alertsValidator)),
});

export const installConfigValidator = v.object({
  projects: v.array(projectValidator),
  /** The shard of the issue tables and the consumer (default `global:main`). */
  shard: v.optional(v.string()),
  /** The R2 binding (default `EMBER_FILES`, the files bucket: keys under `sentry/<install>/`, never touched by its GC). */
  bucket: v.optional(v.string()),
  /** Days raw events, attachments and replays are kept in R2 (default 30). */
  retentionDays: v.optional(v.number()),
  limits: v.optional(
    v.object({
      /** Request body as sent (compressed), default 10 MiB. */
      maxEnvelopeBytes: v.optional(v.number()),
      /** After decompression, default 20 MiB. */
      maxDecompressedBytes: v.optional(v.number()),
      /** One event or transaction item, default 1 MiB. */
      maxEventBytes: v.optional(v.number()),
      /** One attachment (bigger ones are dropped), default 1 MiB. */
      maxAttachmentBytes: v.optional(v.number()),
      /** One replay recording segment, default 10 MiB. */
      maxReplayBytes: v.optional(v.number()),
    }),
  ),
  /**
   * Edge rate limit per project: `binding` = a Rate Limiting binding (from `@freecorps/ember-rate-limit`'s
   * `config.bindings`), keyed by project; else a per-isolate token bucket of `perMinute` (default 1000) and `burst`
   * (default 200). `false`: off.
   */
  rateLimit: v.optional(v.union(v.literal(false), v.object({ binding: v.optional(v.string()), perMinute: v.optional(v.number()), burst: v.optional(v.number()) }))),
  /** Analytics Engine (time series, crash-free sessions): `false` asks for no binding. */
  analytics: v.optional(v.union(v.literal(false), v.object({ binding: v.optional(v.string()), dataset: v.optional(v.string()) }))),
  alerts: v.optional(alertsValidator),
  /** Env vars whose value authorizes source map uploads (default `EMBER_SENTRY_UPLOAD_TOKEN`, then `EMBER_ADMIN_TOKEN`). */
  uploadTokenEnv: v.optional(v.array(v.string())),
});

export type SentryInstallConfig = Infer<typeof installConfigValidator>;
export type SentryProjectConfig = Infer<typeof projectValidator>;
export type SentryAlertsConfig = Infer<typeof alertsValidator>;

export const MiB = 1024 * 1024;
export const DEFAULT_LIMITS = { maxEnvelopeBytes: 10 * MiB, maxDecompressedBytes: 20 * MiB, maxEventBytes: MiB, maxAttachmentBytes: MiB, maxReplayBytes: 10 * MiB };
export const DEFAULT_RETENTION_DAYS = 30;
export const DEFAULT_RATE = { perMinute: 1000, burst: 200 };
export const DEFAULT_DATASET = "ember_sentry";
export const DEFAULT_THROTTLE_MINUTES = 30;
export const DEFAULT_MAX_ALERTS_PER_HOUR = 20;
/** A queue message is at most 128 KB: events larger than this go to R2 first and the message carries the key. */
export const INLINE_EVENT_MAX = 96 * 1024;
/**
 * What one `sendBatch` takes (Cloudflare Queues limits): at most 100 messages and 256 KB in all, 1 KB being 1000 bytes;
 * each message carries up to ~100 bytes of internal metadata that count towards that total.
 */
export const QUEUE_BATCH = { messages: 100, bytes: 256_000, overhead: 100 };

export const limitsOf = (c: SentryInstallConfig) => ({ ...DEFAULT_LIMITS, ...stripUndefined(c.limits ?? {}) });
export const shardOf = (c: SentryInstallConfig | undefined) => c?.shard ?? "global:main";
export const bucketBinding = (c: SentryInstallConfig | undefined) => c?.bucket ?? "EMBER_FILES";
/** `EMBER_SENTRY_<INSTALL>_AE` (`sentry` → `EMBER_SENTRY_SENTRY_AE`), unless `analytics.binding`. */
export const analyticsBinding = (c: SentryInstallConfig | undefined, install: string) =>
  c?.analytics === false ? null : (c?.analytics?.binding ?? `EMBER_SENTRY_${install.replace(/[/-]/g, "_").toUpperCase()}_AE`);
/** The component queue's producer binding (`EMBER_Q_<INSTALL>_EVENTS`), as `composeApp` names it. */
export const queueBinding = (install: string) => `EMBER_Q_${install.split("/").join("_")}_EVENTS`.toUpperCase().replace(/-/g, "_");

/** Project alerts: the install's, overridden per project. */
export function alertsFor(c: SentryInstallConfig, project: string): SentryAlertsConfig | null {
  const p = c.projects.find((x) => x.id === project);
  if (p?.alerts === false) return null;
  return { ...(c.alerts ?? {}), ...stripUndefined(p?.alerts ?? {}) };
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, x]) => x !== undefined)) as Partial<T>;
}

/** A webhook URL alerts may be posted to: `https://`, or `http://` on a loopback host (local development). */
export function webhookUrlAllowed(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]");
}

/** Checks values `v.*` cannot express (ranges, ids). Throws with the field. */
export function checkConfig(c: SentryInstallConfig): void {
  const bad = (m: string): never => {
    throw new Error(`sentry: config.${m}`);
  };
  const ids = new Set<string>();
  for (const [i, p] of c.projects.entries()) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(p.id)) bad(`projects[${i}].id must be 1-64 letters, digits, _ or -`);
    if (ids.has(p.id)) bad(`projects[${i}].id ${p.id} is repeated`);
    ids.add(p.id);
    if (!p.keys.length || p.keys.some((k) => !/^[A-Za-z0-9_-]{8,128}$/.test(k))) bad(`projects[${i}].keys must be 8-128 letters, digits, _ or -`);
    for (const k of ["sampleRate", "transactionSampleRate"] as const) if (p[k] !== undefined && !(p[k]! >= 0 && p[k]! <= 1)) bad(`projects[${i}].${k} must be in 0..1`);
  }
  if (c.retentionDays !== undefined && !(Number.isInteger(c.retentionDays) && c.retentionDays >= 1 && c.retentionDays <= 3650)) bad("retentionDays must be an integer in 1..3650");
  for (const [k, n] of Object.entries(c.limits ?? {})) if (n !== undefined && !(Number.isInteger(n) && n > 0 && n <= 100 * MiB)) bad(`limits.${k} must be a positive integer up to 100 MiB`);
  if (c.rateLimit && c.rateLimit.perMinute !== undefined && !(c.rateLimit.perMinute > 0)) bad("rateLimit.perMinute must be > 0");
  const alerts = [c.alerts, ...c.projects.map((p) => (p.alerts === false ? undefined : p.alerts))];
  for (const a of alerts) {
    if (!a) continue;
    if (a.spike && !(Number.isInteger(a.spike.events) && a.spike.events > 0 && a.spike.windowMinutes > 0)) bad("alerts.spike needs events (integer > 0) and windowMinutes (> 0)");
    for (const w of a.webhooks ?? []) if (!webhookUrlAllowed(w.url)) bad(`alerts.webhooks: ${w.url} must be an https:// URL (http:// only for localhost)`);
  }
}

// ------------------------------------------------------------------------------------------- bindings (structural)

export interface R2ObjectLike {
  key: string;
  size: number;
  uploaded: Date;
}
export interface R2BodyLike extends R2ObjectLike {
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}
export interface R2Like {
  put(key: string, value: Uint8Array | ArrayBuffer | string, options?: { httpMetadata?: { contentType?: string; contentEncoding?: string }; customMetadata?: Record<string, string> }): Promise<unknown>;
  get(key: string, options?: { range?: { offset: number; length: number } }): Promise<R2BodyLike | null>;
  head(key: string): Promise<R2ObjectLike | null>;
  list(options?: { prefix?: string; delimiter?: string; cursor?: string; limit?: number }): Promise<{ objects: R2ObjectLike[]; delimitedPrefixes?: string[]; truncated: boolean; cursor?: string }>;
  delete(keys: string | string[]): Promise<void>;
}
export interface QueueLike<T = unknown> {
  send(body: T, options?: { contentType?: string }): Promise<void>;
  sendBatch(messages: Iterable<{ body: T; contentType?: string }>): Promise<void>;
}
export interface AnalyticsEngineLike {
  writeDataPoint(point: { indexes?: string[]; blobs?: Array<string | null>; doubles?: number[] }): void;
}
export interface RateLimitLike {
  limit(o: { key: string }): Promise<{ success: boolean }>;
}

export const r2Of = (env: Record<string, unknown>, c: SentryInstallConfig | undefined): R2Like | null => {
  const b = env[bucketBinding(c)] as R2Like | undefined;
  return b && typeof b.put === "function" ? b : null;
};
export const aeOf = (env: Record<string, unknown>, c: SentryInstallConfig | undefined, install: string): AnalyticsEngineLike | null => {
  const name = analyticsBinding(c, install);
  const b = name ? (env[name] as AnalyticsEngineLike | undefined) : undefined;
  return b && typeof b.writeDataPoint === "function" ? b : null;
};
export const queueOf = (env: Record<string, unknown>, install: string): QueueLike | null => {
  const q = env[queueBinding(install)] as QueueLike | undefined;
  return q && typeof q.sendBatch === "function" ? q : null;
};
