// The Queue consumer of the sentry component (one batch, up to 100 events):
//
//   1. events from the messages (inline, or the R2 spill object);
//   2. source maps: one query for every (release, dist, file) and debug id of the batch, maps from R2 through the
//      per-isolate LRU, frames rewritten (symbolicate.ts);
//   3. fingerprint, title, culprit per event, grouped by (project, fingerprint);
//   4. one R2 object for the batch (one gzip member per event, so each can be read back by range);
//   5. one mutation (`lib:apply`): one insert or patch per issue, whatever the number of its events; alerts decided there;
//   6. one Analytics Engine point per event.
//
// Memory: a batch is consumed in slices of at most `maxSliceBytes` of event JSON (steps 2-6 per slice, one R2 object
// and one `lib:apply` each), so 100 spilled 1 MiB events never sit in memory at once. A malformed event is dropped
// (logged) instead of failing the batch it came in; so is a spill object that is gone. A spill that R2 fails to read
// (a transient error) is not: that message is retried (`retry`), the rest of the batch goes on.
//
// Retries: once a slice's `lib:apply` commits, `committed` gets the indexes of the messages it covered (with the ones
// skipped or dropped since the previous slice) and the Queue handler acks them one by one; a later slice that throws
// makes the Queue redeliver only the messages not acked yet, so a committed slice is never counted twice. What is left
// at-least-once is the window between the commit and the ack (an RPC that commits and then fails): those events count
// again. An alert is tied to the state change it reports (new / resolved → seen / window crossed), so it is not sent
// twice.

import { aeOf, r2Of, type SentryInstallConfig } from "./config.ts";
import { eventPoint } from "./analytics.ts";
import { artifactName, culpritOf, fingerprintOf, levelOf, normalizeEvent, stackText, timestampOf, titleOf, type SentryEvent, type StackFrame } from "./event.ts";
import type { QueuedEvent } from "./ingest.ts";
import { batchObject, getGunzip, keys, type EventPointer } from "./storage.ts";
import { cachedMap, lookupsOf, symbolicate } from "./symbolicate.ts";
import { gunzip, utf8 } from "./envelope.ts";

/** One issue's share of a batch: what `lib:apply` writes in one statement. */
export interface IssueGroup {
  project: string;
  fingerprint: string;
  n: number;
  firstSeen: number;
  lastSeen: number;
  title: string;
  culprit: string;
  level: string;
  release: string;
  environment: string;
  platform: string;
  eventId: string;
  stack: string;
  pointer?: EventPointer;
}

export interface ArtifactLookup {
  project: string;
  release: string;
  dist: string;
  names: string[];
  debugIds: string[];
}

export interface ConsumerDeps {
  install: string;
  config: SentryInstallConfig;
  env: Record<string, unknown>;
  now: number;
  /** `lib:findArtifacts` → `{ artifactKey | debugKey: sha256 }`; at most `LOOKUP_LIMITS` per call. */
  findArtifacts(lookups: ArtifactLookup[]): Promise<Record<string, string>>;
  /** `lib:apply`. */
  apply(groups: IssueGroup[]): Promise<{ issues: number; created: number; alerts: number }>;
  /** Event JSON consumed per slice (default `SLICE_BYTES`). */
  maxSliceBytes?: number;
  /** Called after each slice is applied with the indexes (into `messages`) it settled: the Queue handler acks them. */
  committed?(indexes: readonly number[]): void;
  /**
   * Called at the end with the indexes whose spill object R2 failed to read (a transient error): the Queue handler
   * retries them. Without it (the inline consumer) such a failure throws, after the rest of the batch is applied.
   */
  retry?(indexes: readonly number[]): void;
}

export interface ConsumeResult {
  events: number;
  issues: number;
  created: number;
  alerts: number;
  symbolicated: number;
  /** The batch object in R2 (the first slice's; none without a bucket). */
  object: string | null;
  /** Every object written, one per slice. */
  objects: string[];
  /** Events dropped as malformed (or whose spill object is gone). */
  dropped: number;
  /** Messages left for the Queue to redeliver (their spill object could not be read). */
  retried: number;
}

export const artifactKey = (project: string, release: string, dist: string, name: string) => `${project}\n${release}\n${dist}\n${name}`;
/** A debug id is looked up within the event's project only. */
export const debugKey = (project: string, debugId: string) => `debug:${project}\n${debugId}`;

/** What one `lib:findArtifacts` call takes (`chunkLookups` splits a batch's lookups to fit, nothing is left out). */
export const LOOKUP_LIMITS = { lookups: 50, names: 200, debugIds: 200 };
/** Event JSON per slice of a batch. */
export const SLICE_BYTES = 16 * 1024 * 1024;

/** Splits lookups into calls within `LOOKUP_LIMITS`: long name or debug id lists become several lookups of the same key. */
export function chunkLookups(lookups: readonly ArtifactLookup[], limits = LOOKUP_LIMITS): ArtifactLookup[][] {
  const pieces: ArtifactLookup[] = [];
  for (const l of lookups) {
    const n = Math.max(Math.ceil(l.names.length / limits.names), Math.ceil(l.debugIds.length / limits.debugIds), 1);
    for (let i = 0; i < n; i++) pieces.push({ ...l, names: l.names.slice(i * limits.names, (i + 1) * limits.names), debugIds: l.debugIds.slice(i * limits.debugIds, (i + 1) * limits.debugIds) });
  }
  const out: ArtifactLookup[][] = [];
  for (let i = 0; i < pieces.length; i += limits.lookups) out.push(pieces.slice(i, i + limits.lookups));
  return out;
}

interface Loaded {
  m: QueuedEvent;
  e: SentryEvent;
}

export async function consume(deps: ConsumerDeps, messages: readonly QueuedEvent[]): Promise<ConsumeResult> {
  const bucket = r2Of(deps.env, deps.config);
  const budget = deps.maxSliceBytes ?? SLICE_BYTES;
  const total: ConsumeResult = { events: 0, issues: 0, created: 0, alerts: 0, symbolicated: 0, object: null, objects: [], dropped: 0, retried: 0 };
  const add = (r: Omit<ConsumeResult, "dropped" | "object" | "objects" | "retried"> & { object: string | null; dropped: number }) => {
    total.events += r.events;
    total.issues += r.issues;
    total.created += r.created;
    total.alerts += r.alerts;
    total.symbolicated += r.symbolicated;
    total.dropped += r.dropped;
    if (r.object) total.objects.push(r.object);
    total.object ??= r.object;
  };
  // 1. Events, a slice at a time (a spilled event is read when its slice is next, not the whole batch up front).
  let slice: Loaded[] = [];
  let bytes = 0;
  // Messages seen since the last applied slice (events, and the ones skipped or dropped): settled with that slice.
  let settled: number[] = [];
  // Messages whose spill could not be read (a storage failure): never settled, the Queue redelivers them.
  const retry: number[] = [];
  const flush = async () => {
    if (slice.length) add(await consumeSlice(deps, bucket, slice));
    if (settled.length) deps.committed?.(settled);
    slice = [];
    bytes = 0;
    settled = [];
  };
  for (const [i, m] of messages.entries()) {
    if (!m || m.v !== 1 || typeof m.project !== "string") {
      settled.push(i);
      continue;
    }
    let e: unknown = m.event;
    let size = 0;
    if (!e && m.spill && bucket) {
      // Reading the spill object: a storage failure is transient (the message is retried, never acked), a missing
      // object (404, or expired) is permanent and dropped, like one that does not decompress or parse.
      let stored: ArrayBuffer | null;
      try {
        const obj = await bucket.get(m.spill);
        stored = obj ? await obj.arrayBuffer() : null;
      } catch (err) {
        console.error(`ember-sentry: event ${String(m.id)} spill ${m.spill} could not be read, retried: ${(err as Error).message}`);
        retry.push(i);
        continue;
      }
      try {
        if (!stored) throw new Error("the spill object is missing");
        const raw = await gunzip(stored);
        size = raw.length;
        e = JSON.parse(utf8.decode(raw));
      } catch (err) {
        console.error(`ember-sentry: event ${String(m.id)} dropped, its spill ${m.spill} is unreadable: ${(err as Error).message}`);
        total.dropped++;
        settled.push(i);
        continue;
      }
    } else {
      try {
        size = e ? JSON.stringify(e).length : 0;
      } catch (err) {
        console.error(`ember-sentry: event ${String(m.id)} could not be read (inline): ${(err as Error).message}`);
        total.dropped++;
        settled.push(i);
        continue;
      }
    }
    if (!e || typeof e !== "object" || Array.isArray(e)) {
      settled.push(i);
      continue;
    }
    if (slice.length && bytes + size > budget) await flush();
    slice.push({ m, e: normalizeEvent(e as SentryEvent) });
    settled.push(i);
    bytes += size;
  }
  await flush();
  if (retry.length) {
    total.retried = retry.length;
    if (deps.retry) deps.retry(retry);
    // Inline (no Queue to redeliver it): the caller sees the failure instead of an event lost quietly.
    else throw new Error(`ember-sentry: ${retry.length} spilled event(s) could not be read from R2`);
  }
  return total;
}

async function consumeSlice(deps: ConsumerDeps, bucket: ReturnType<typeof r2Of>, loaded: Loaded[]) {
  const ae = aeOf(deps.env, deps.config, deps.install);
  // 2. Source maps: lookup queries for the slice (as few as LOOKUP_LIMITS allow).
  let symbolicated = 0;
  const wanted = new Map<string, ArtifactLookup>();
  const want = (k: string, l: ArtifactLookup, names: string[], debugIds: string[]) => {
    const cur = wanted.get(k) ?? l;
    cur.names = [...new Set([...cur.names, ...names])];
    cur.debugIds = [...new Set([...cur.debugIds, ...debugIds])];
    wanted.set(k, cur);
  };
  for (const { m, e } of loaded) {
    const { names, debugIds } = lookupsOf(e);
    // Events without a release can still be mapped by debug id.
    if (e.release && (names.length || debugIds.length)) want(`${m.project}\n${e.release}\n${e.dist ?? ""}`, { project: m.project, release: e.release, dist: e.dist ?? "", names: [], debugIds: [] }, names, debugIds);
    else if (!e.release && debugIds.length) want(`${m.project}\n\n`, { project: m.project, release: "", dist: "", names: [], debugIds: [] }, [], debugIds);
  }
  if (wanted.size && bucket) {
    const found: Record<string, string> = {};
    for (const chunk of chunkLookups([...wanted.values()])) Object.assign(found, await deps.findArtifacts(chunk));
    for (const { m, e } of loaded) {
      const mapFor = async (f: StackFrame, debugId: string | undefined) => {
        const name = artifactName(f.abs_path ?? f.filename ?? "");
        const sha = (debugId && found[debugKey(m.project, debugId)]) || (e.release ? (found[artifactKey(m.project, e.release, e.dist ?? "", name)] ?? found[artifactKey(m.project, e.release, "", name)]) : undefined);
        if (!sha) return null;
        const map = await cachedMap(sha, async () => {
          const bytes = await getGunzip(bucket, keys.map(deps.install, sha));
          return bytes ? utf8.decode(bytes) : null;
        });
        return map ? { map, key: sha } : null;
      };
      try {
        symbolicated += await symbolicate(e, mapFor);
      } catch (err) {
        console.error(`ember-sentry: symbolication of ${m.id} failed: ${(err as Error).message}`);
      }
    }
  }
  // 3. Grouping: an event whose fields cannot be read is dropped, the rest of the slice goes on.
  let dropped = 0;
  const prepared: Array<{ m: QueuedEvent; e: SentryEvent; fingerprint: string; at: number; line: string; latest: Omit<IssueGroup, "project" | "fingerprint" | "n" | "firstSeen" | "lastSeen" | "pointer"> }> = [];
  for (const { m, e } of loaded) {
    try {
      const latest = { title: titleOf(e), culprit: culpritOf(e), level: levelOf(e), release: e.release ?? "", environment: e.environment ?? "", platform: e.platform ?? "", eventId: m.id, stack: stackText(e) };
      prepared.push({ m, e, fingerprint: await fingerprintOf(e), at: timestampOf(e, m.receivedAt), line: JSON.stringify({ project: m.project, receivedAt: m.receivedAt, event: e }), latest });
    } catch (err) {
      console.error(`ember-sentry: event ${m.id} is malformed, dropped: ${(err as Error).message}`);
      dropped++;
    }
  }
  // 4. One object for the slice.
  let object: string | null = null;
  const pointers: Array<EventPointer | undefined> = [];
  if (bucket && prepared.length) {
    const lines = prepared.map((p) => p.line);
    for (const p of prepared) p.line = "";
    const { bytes, ranges } = await batchObject(lines);
    lines.length = 0;
    object = keys.events(deps.install, deps.now, `${deps.now.toString(36)}-${crypto.randomUUID().slice(0, 8)}`);
    await bucket.put(object, bytes, { httpMetadata: { contentType: "application/x-ndjson", contentEncoding: "gzip" } });
    for (const r of ranges) pointers.push({ key: object, ...r });
  }
  const groups = new Map<string, IssueGroup>();
  prepared.forEach(({ m, fingerprint, at, latest: fields }, i) => {
    const k = `${m.project}\n${fingerprint}`;
    const g = groups.get(k);
    const latest = !g || at >= g.lastSeen;
    const next: IssueGroup = g ?? { project: m.project, fingerprint, n: 0, firstSeen: at, lastSeen: at, title: "", culprit: "", level: "", release: "", environment: "", platform: "", eventId: "", stack: "" };
    next.n++;
    next.firstSeen = Math.min(next.firstSeen, at);
    if (latest) {
      Object.assign(next, { lastSeen: at, ...fields });
      if (pointers[i]) next.pointer = pointers[i];
      else delete next.pointer;
    }
    groups.set(k, next);
  });
  // 5. One write per issue.
  const applied = groups.size ? await deps.apply([...groups.values()]) : { issues: 0, created: 0, alerts: 0 };
  // 6. Time series.
  for (const { m, e, fingerprint } of prepared) eventPoint(ae, { project: m.project, release: e.release, environment: e.environment, level: levelOf(e), fingerprint, platform: e.platform });
  return { events: prepared.length, ...applied, symbolicated, object, dropped };
}
