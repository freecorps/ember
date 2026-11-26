// Real-user latency (RUM, docs/spikes/remote/latency-protocol.md S6; contracts.md "RUM"). Opt-in in the client
// (`new EmberClient({ rum: { sampleRate } })`, drawn once per page load): the client keeps log-scale histograms of
// what it measured (socket connect → `ready`, heartbeat `rtt`, mutation `ack`, subscription `first_value`) per shard
// kind and Durable Object colo, and posts them in one small batch to `POST /api/_ember/rum` (every 60 s and on
// `pagehide`, `sendBeacon`). The Worker writes them to Analytics Engine (EMBER_METRICS) and to nothing else: no
// Durable Object is woken or written, and without the binding the batch is dropped (204 either way).
//
// No personal data: the batch has no user, client id, IP, args or shard key; the country and the entry colo come from
// `request.cf` here (the IP is never read). `EMBER_RUM = "0"` turns the endpoint off (404).
//
// Analytics Engine point, one per (metric, shard kind, DO colo, bucket) — same dataset as metrics.ts, `blob5 = "rum"`:
//   index1 = "<project>/<env>"
//   blob1 project  blob2 env  blob3 shard kind  blob4 metric  blob5 "rum"  blob6 platform  blob7 SDK version
//   blob8 shard kind  blob9 ""  blob10 country  blob11 entry colo  blob12 DO colo ("" when unknown)
//   double1 = the bucket's representative ms   double2..9 = 0 (double5, the executions' weight, is 0: a reader of
//   execution metrics counts no calls here)   double10 = bucket index   double11 = samples   double12 = weight (1/rate)

import { readLimitedText } from "./body.ts";
import type { AnalyticsEngineDatasetLike } from "./metrics.ts";
import { metricsDataset } from "./metrics.ts";

export const RUM_METRICS = ["connect", "rtt", "ack", "first_value"] as const;
export type RumMetric = (typeof RUM_METRICS)[number];
export const RUM_PLATFORMS = ["web", "react-native", "node", "other"] as const;

/** Largest batch accepted (the client sends ~2 KB at most). */
export const RUM_MAX_BYTES = 4096;
/** Histograms per batch, and data points written per batch (Analytics Engine takes 250 per invocation). */
export const RUM_MAX_HISTOGRAMS = 32;
export const RUM_MAX_POINTS = 200;
/** Buckets: `floor(2·log2(ms + 1))`, so each is ~√2 wide; 0 (< 0.41 ms) to 40 (≥ ~1048 s). */
export const RUM_MAX_BUCKET = 40;

/** The bucket of a duration (the client's and the dashboard's copy are the same formula). */
export function rumBucket(ms: number): number {
  if (!(ms > 0)) return 0;
  return Math.min(RUM_MAX_BUCKET, Math.floor(2 * Math.log2(ms + 1)));
}

/** A bucket's representative value (its geometric middle), in ms. */
export function rumBucketMs(b: number): number {
  return Math.round((2 ** ((b + 0.5) / 2) - 1) * 100) / 100;
}

export interface RumBatch {
  /** Sample rate the session was drawn with: each sample stands for 1/r sessions'. */
  r: number;
  p: (typeof RUM_PLATFORMS)[number];
  s: string;
  h: Array<{ m: RumMetric; k: string; c: string; b: Array<[number, number]> }>;
}

const KIND = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const COLO = /^(?:[A-Z]{3}|)$/;
const SDK = /^[0-9A-Za-z.+-]{0,32}$/;

/** The batch, or why it is refused. Strict: unknown metrics, bad shapes and out-of-range numbers are refused whole. */
export function parseRumBatch(text: string): RumBatch | string {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return "not JSON";
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "expected an object";
  const o = raw as Record<string, unknown>;
  if (o.v !== 1) return "v: 1 expected";
  const r = o.r;
  if (typeof r !== "number" || !(r > 0 && r <= 1)) return "r: the sample rate, in (0, 1]";
  const p = o.p;
  if (typeof p !== "string" || !(RUM_PLATFORMS as readonly string[]).includes(p)) return `p: one of ${RUM_PLATFORMS.join(", ")}`;
  const s = o.s ?? "";
  if (typeof s !== "string" || !SDK.test(s)) return "s: the SDK version";
  if (!Array.isArray(o.h) || o.h.length > RUM_MAX_HISTOGRAMS) return `h: up to ${RUM_MAX_HISTOGRAMS} histograms`;
  const h: RumBatch["h"] = [];
  let points = 0;
  for (const x of o.h as unknown[]) {
    if (!x || typeof x !== "object" || Array.isArray(x)) return "h[]: objects";
    const e = x as Record<string, unknown>;
    if (typeof e.m !== "string" || !(RUM_METRICS as readonly string[]).includes(e.m)) return `h[].m: one of ${RUM_METRICS.join(", ")}`;
    if (typeof e.k !== "string" || !KIND.test(e.k)) return "h[].k: a shard kind";
    const c = e.c ?? "";
    if (typeof c !== "string" || !COLO.test(c)) return "h[].c: a colo (three capital letters) or empty";
    if (!Array.isArray(e.b) || !e.b.length) return "h[].b: [bucket, count] pairs";
    const b: Array<[number, number]> = [];
    for (const pair of e.b as unknown[]) {
      if (!Array.isArray(pair) || pair.length !== 2) return "h[].b: [bucket, count] pairs";
      const [i, n] = pair as [unknown, unknown];
      if (!Number.isInteger(i) || (i as number) < 0 || (i as number) > RUM_MAX_BUCKET) return `h[].b: buckets 0..${RUM_MAX_BUCKET}`;
      if (!Number.isInteger(n) || (n as number) < 1 || (n as number) > 100_000) return "h[].b: counts 1..100000";
      b.push([i as number, n as number]);
    }
    points += b.length;
    if (points > RUM_MAX_POINTS) return `up to ${RUM_MAX_POINTS} buckets per batch`;
    h.push({ m: e.m as RumMetric, k: e.k, c, b });
  }
  return { r, p: p as RumBatch["p"], s, h };
}

const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "POST", "access-control-allow-headers": "content-type", "access-control-max-age": "86400" };

interface RumEnv {
  EMBER_RUM?: unknown;
  EMBER_PROJECT?: unknown;
  EMBER_ENV?: unknown;
  [k: string]: unknown;
}

const refuse = (status: number, code: string, message: string) =>
  new Response(JSON.stringify({ ok: false, error: { code, message } }), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS } });

/**
 * `POST /api/_ember/rum` (and its CORS preflight). Public: no token (the batch carries nothing to protect and
 * nothing that identifies anyone). Writes only to Analytics Engine.
 */
export async function handleRum(request: Request, env: RumEnv): Promise<Response> {
  if (env.EMBER_RUM === "0") return refuse(404, "not_found", "not found");
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (request.method !== "POST") return refuse(405, "method_not_allowed", "use POST");
  const text = await readLimitedText(request, RUM_MAX_BYTES);
  if (text === null) return refuse(413, "too_large", `RUM batches up to ${RUM_MAX_BYTES} bytes`);
  const batch = parseRumBatch(text);
  if (typeof batch === "string") return refuse(400, "bad_rum", batch);
  const cf = (request as { cf?: { country?: unknown; colo?: unknown } }).cf;
  const country = typeof cf?.country === "string" && /^[A-Z0-9]{2}$/.test(cf.country) ? cf.country : "XX";
  const entry = typeof cf?.colo === "string" && /^[A-Z]{3}$/.test(cf.colo) ? cf.colo : "";
  writeRum(metricsDataset(env), env, batch, { country, entry });
  return new Response(null, { status: 204, headers: { "cache-control": "no-store", ...CORS } });
}

/** Writes a batch's points (none without a dataset). Never throws. Returns how many were written. */
export function writeRum(ds: AnalyticsEngineDatasetLike | null, env: RumEnv, batch: RumBatch, where: { country: string; entry: string }): number {
  if (!ds) return 0;
  const project = typeof env.EMBER_PROJECT === "string" && env.EMBER_PROJECT ? env.EMBER_PROJECT : "unknown";
  const envName = typeof env.EMBER_ENV === "string" && env.EMBER_ENV ? env.EMBER_ENV : "unknown";
  const weight = 1 / batch.r;
  let n = 0;
  try {
    for (const h of batch.h)
      for (const [b, count] of h.b) {
        ds.writeDataPoint({
          indexes: [`${project}/${envName}`],
          blobs: [project, envName, h.k, h.m, "rum", batch.p, batch.s, h.k, "", where.country, where.entry, h.c],
          doubles: [rumBucketMs(b), 0, 0, 0, 0, 0, 0, 0, 0, b, count, weight],
        });
        n++;
      }
  } catch (e) {
    console.error("ember: RUM write failed", e);
  }
  return n;
}

export { probeColo } from "./colo.ts";
