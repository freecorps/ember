// R2 layout of the sentry component (contracts.md "Sentry"). Everything lives under `sentry/<install>/`, outside the
// files GC's keys (`f/`, `t/`), date-partitioned where it expires:
//
//   sentry/<install>/events/<yyyy-mm-dd>/<batch>.ndjson.gz        one per consumer batch: one gzip member per event
//   sentry/<install>/spill/<yyyy-mm-dd>/<project>/<event>.json.gz  events too big for a queue message (ingest)
//   sentry/<install>/attachments/<yyyy-mm-dd>/<project>/<event>/<n>-<filename>.gz
//   sentry/<install>/replays/<yyyy-mm-dd>/<project>/<replay>/<segment>-<event|recording>.gz
//   sentry/<install>/maps/<sha256>.map.gz                         source maps, by content (never expire)
//
// Retention: a component cannot set R2 lifecycle rules (they are bucket-wide and the bucket may be the app's), so the
// daily `lib:retention` cron deletes date prefixes older than `retentionDays`, in bounded batches.

import { gunzip, gzip, utf8 } from "./envelope.ts";
import type { R2Like } from "./config.ts";

export const EXPIRING = ["events", "spill", "attachments", "replays"] as const;
export type ExpiringKind = (typeof EXPIRING)[number];

export const rootOf = (install: string) => `sentry/${install}/`;
export const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100) || "_";

export const keys = {
  events: (install: string, now: number, batch: string) => `${rootOf(install)}events/${day(now)}/${safe(batch)}.ndjson.gz`,
  spill: (install: string, now: number, project: string, event: string) => `${rootOf(install)}spill/${day(now)}/${safe(project)}/${safe(event)}.json.gz`,
  attachment: (install: string, now: number, project: string, event: string, n: number, filename: string) =>
    `${rootOf(install)}attachments/${day(now)}/${safe(project)}/${safe(event)}/${n}-${safe(filename)}.gz`,
  replay: (install: string, now: number, project: string, replay: string, segment: number, part: "event" | "recording") =>
    `${rootOf(install)}replays/${day(now)}/${safe(project)}/${safe(replay)}/${segment}-${part}.gz`,
  map: (install: string, sha256: string) => `${rootOf(install)}maps/${sha256}.map.gz`,
};

/** Where one event sits in a batch object: a byte range that is one whole gzip member. */
export interface EventPointer {
  key: string;
  offset: number;
  length: number;
}

/**
 * Builds one batch object from many events: each JSON line is its own gzip member, so one event is read back with a
 * ranged GET of its member alone, and the whole object still decompresses as one NDJSON file (`zcat`).
 */
export async function batchObject(lines: readonly string[]): Promise<{ bytes: Uint8Array; ranges: Array<{ offset: number; length: number }> }> {
  // One member at a time: compression buffers for one event, not for the whole batch at once.
  const members: Uint8Array[] = [];
  for (const l of lines) members.push(await gzip(l + "\n"));
  const ranges: Array<{ offset: number; length: number }> = [];
  let n = 0;
  for (const m of members) {
    ranges.push({ offset: n, length: m.length });
    n += m.length;
  }
  const bytes = new Uint8Array(n);
  members.forEach((m, i) => bytes.set(m, ranges[i]!.offset));
  return { bytes, ranges };
}

export const GZ = { httpMetadata: { contentType: "application/json", contentEncoding: "gzip" } };

/** Reads one event back (a pointer from an issue row). */
export async function readEvent(bucket: R2Like, p: EventPointer): Promise<unknown> {
  const obj = await bucket.get(p.key, { range: { offset: p.offset, length: p.length } });
  if (!obj) return null;
  return JSON.parse(utf8.decode(await gunzip(await obj.arrayBuffer())));
}

export async function putGzip(bucket: R2Like, key: string, data: Uint8Array | string, contentType = "application/json"): Promise<number> {
  const bytes = await gzip(data);
  await bucket.put(key, bytes, { httpMetadata: { contentType, contentEncoding: "gzip" } });
  return bytes.length;
}

export async function getGunzip(bucket: R2Like, key: string): Promise<Uint8Array | null> {
  const obj = await bucket.get(key);
  return obj ? gunzip(await obj.arrayBuffer()) : null;
}

export interface RetentionResult {
  deleted: number;
  /** Date prefixes fully removed. */
  prefixes: string[];
  /** More expired objects are left (the cron schedules another run). */
  more: boolean;
}

/**
 * Deletes the date prefixes of `EXPIRING` older than `retentionDays`, at most `budget` objects per run (R2 deletes
 * take up to 1000 keys per call): a backlog is drained over several runs, never by one unbounded invocation.
 */
export async function sweepExpired(bucket: R2Like, install: string, now: number, retentionDays: number, budget = 5000): Promise<RetentionResult> {
  const cutoff = day(now - retentionDays * 86_400_000);
  const out: RetentionResult = { deleted: 0, prefixes: [], more: false };
  for (const kind of EXPIRING) {
    const base = `${rootOf(install)}${kind}/`;
    let cursor: string | undefined;
    const dates: string[] = [];
    do {
      const page = await bucket.list({ prefix: base, delimiter: "/", limit: 1000, ...(cursor ? { cursor } : {}) });
      for (const p of page.delimitedPrefixes ?? []) dates.push(p);
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    for (const prefix of dates.sort()) {
      const d = prefix.slice(base.length, base.length + 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d >= cutoff) continue;
      for (;;) {
        if (out.deleted >= budget) {
          out.more = true;
          return out;
        }
        const page = await bucket.list({ prefix, limit: Math.min(1000, budget - out.deleted) });
        if (!page.objects.length) break;
        await bucket.delete(page.objects.map((o) => o.key));
        out.deleted += page.objects.length;
        if (!page.truncated && page.objects.length < 1000) {
          // The page was the rest of the prefix (a list after the delete would come back empty).
          break;
        }
      }
      out.prefixes.push(prefix);
    }
  }
  return out;
}
