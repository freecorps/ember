// Analytics Engine points of the sentry component (dataset `ember_sentry` by default; contracts.md "Sentry"). One point
// per event, session update, kept transaction and dropped item. Never throws: a failed write loses a point, not an event.
//
//   index1 = project
//   blob1  = kind: "event" | "session" | "transaction" | "dropped"
//   blob2  = project, blob3 = release, blob4 = environment
//   event:       blob5 = level, blob6 = issue fingerprint, blob7 = platform               double1 = 1
//   session:     blob5 = status (ok, exited, crashed, abnormal, errored)                  double1 = started,
//                double2 = crashed, double3 = errored, double4 = abnormal, double5 = exited (ended without error)
//   transaction: blob5 = name, blob6 = op, blob7 = status                                  double1 = 1, double2 = duration ms
//   dropped:     blob5 = reason (rate_limited, sampled, too_large, invalid), blob6 = item type   double1 = items
//
// Crash-free sessions of a release: 1 - SUM(_sample_interval * double2) / SUM(_sample_interval * double1)
// WHERE blob1 = 'session' AND blob3 = '<release>' (README has the queries).

import type { AnalyticsEngineLike } from "./config.ts";
import type { JsonObject } from "./envelope.ts";

const s = (x: unknown, n = 256) => (typeof x === "string" ? x.slice(0, n) : "");

function write(ae: AnalyticsEngineLike | null, project: string, blobs: Array<string>, doubles: number[]): void {
  if (!ae) return;
  try {
    ae.writeDataPoint({ indexes: [project.slice(0, 96)], blobs, doubles });
  } catch (e) {
    console.error(`ember-sentry: analytics write failed: ${(e as Error).message}`);
  }
}

export function eventPoint(ae: AnalyticsEngineLike | null, p: { project: string; release?: string | undefined; environment?: string | undefined; level: string; fingerprint: string; platform?: string | undefined }): void {
  write(ae, p.project, ["event", p.project, s(p.release), s(p.environment), p.level, p.fingerprint, s(p.platform, 32)], [1]);
}

export function droppedPoint(ae: AnalyticsEngineLike | null, project: string, reason: string, type: string, n = 1): void {
  write(ae, project, ["dropped", project, "", "", reason, type], [n]);
}

/** A `session` item (one update) or a `sessions` item (pre-aggregated buckets). Returns the points written. */
export function sessionPoints(ae: AnalyticsEngineLike | null, project: string, type: "session" | "sessions", payload: JsonObject): number {
  const attrs = (payload.attrs ?? {}) as JsonObject;
  const release = s(attrs.release ?? payload.release);
  const environment = s(attrs.environment ?? payload.environment);
  if (type === "session") {
    const status = s(payload.status, 16) || "ok";
    const errors = typeof payload.errors === "number" ? payload.errors : 0;
    const started = payload.init === true ? 1 : 0;
    // An exited session that had errors is an errored one.
    const final = status === "exited" && errors > 0 ? "errored" : status;
    write(ae, project, ["session", project, release, environment, final], [started, final === "crashed" ? 1 : 0, final === "errored" ? 1 : 0, final === "abnormal" ? 1 : 0, final === "exited" ? 1 : 0]);
    return 1;
  }
  let n = 0;
  for (const a of Array.isArray(payload.aggregates) ? (payload.aggregates as JsonObject[]) : []) {
    const num = (k: string) => (typeof a[k] === "number" ? (a[k] as number) : 0);
    const exited = num("exited"), errored = num("errored"), abnormal = num("abnormal"), crashed = num("crashed");
    write(ae, project, ["session", project, release, environment, "aggregate"], [exited + errored + abnormal + crashed, crashed, errored, abnormal, exited]);
    n++;
  }
  return n;
}

export function transactionPoint(ae: AnalyticsEngineLike | null, project: string, tx: JsonObject): void {
  const start = typeof tx.start_timestamp === "number" ? tx.start_timestamp : NaN;
  const end = typeof tx.timestamp === "number" ? tx.timestamp : NaN;
  const trace = ((tx.contexts as JsonObject | undefined)?.trace ?? {}) as JsonObject;
  const ms = Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, Math.round((end - start) * 1000)) : 0;
  write(ae, project, ["transaction", project, s(tx.release), s(tx.environment), s(tx.transaction), s(trace.op, 64), s(trace.status, 32)], [1, ms]);
}
