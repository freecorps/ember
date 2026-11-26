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
// At-least-once: a batch the Queue redelivers is counted again (issue counts are approximate under retries); an alert
// is tied to the state change it reports (new / resolved → seen / window crossed), so it is not sent twice.

import { aeOf, r2Of, type SentryInstallConfig } from "./config.ts";
import { eventPoint } from "./analytics.ts";
import { artifactName, culpritOf, fingerprintOf, levelOf, stackText, timestampOf, titleOf, type SentryEvent, type StackFrame } from "./event.ts";
import type { QueuedEvent } from "./ingest.ts";
import { batchObject, getGunzip, keys, type EventPointer } from "./storage.ts";
import { cachedMap, lookupsOf, symbolicate } from "./symbolicate.ts";
import { utf8 } from "./envelope.ts";

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
  /** `lib:findArtifacts` → `{ "<project>\n<release>\n<dist>\n<name>" | "debug:<id>": sha256 }`. */
  findArtifacts(lookups: ArtifactLookup[]): Promise<Record<string, string>>;
  /** `lib:apply`. */
  apply(groups: IssueGroup[]): Promise<{ issues: number; created: number; alerts: number }>;
}

export interface ConsumeResult {
  events: number;
  issues: number;
  created: number;
  alerts: number;
  symbolicated: number;
  /** The batch object in R2 (none without a bucket). */
  object: string | null;
}

export const artifactKey = (project: string, release: string, dist: string, name: string) => `${project}\n${release}\n${dist}\n${name}`;

export async function consume(deps: ConsumerDeps, messages: readonly QueuedEvent[]): Promise<ConsumeResult> {
  const bucket = r2Of(deps.env, deps.config);
  const ae = aeOf(deps.env, deps.config, deps.install);
  // 1. Events.
  const loaded: Array<{ m: QueuedEvent; e: SentryEvent }> = [];
  for (const m of messages) {
    if (!m || m.v !== 1 || typeof m.project !== "string") continue;
    let e = m.event;
    if (!e && m.spill && bucket) {
      const bytes = await getGunzip(bucket, m.spill);
      e = bytes ? (JSON.parse(utf8.decode(bytes)) as SentryEvent) : undefined;
    }
    if (e && typeof e === "object") loaded.push({ m, e });
  }
  // 2. Source maps: one lookup query for the batch.
  let symbolicated = 0;
  const wanted = new Map<string, ArtifactLookup>();
  for (const { m, e } of loaded) {
    if (!e.release) continue;
    const { names, debugIds } = lookupsOf(e);
    if (!names.length && !debugIds.length) continue;
    const k = `${m.project}\n${e.release}\n${e.dist ?? ""}`;
    const l = wanted.get(k) ?? { project: m.project, release: e.release, dist: e.dist ?? "", names: [], debugIds: [] };
    l.names = [...new Set([...l.names, ...names])];
    l.debugIds = [...new Set([...l.debugIds, ...debugIds])];
    wanted.set(k, l);
  }
  // Events without a release can still be mapped by debug id.
  for (const { m, e } of loaded) {
    if (e.release) continue;
    const { debugIds } = lookupsOf(e);
    if (!debugIds.length) continue;
    const l = wanted.get(`${m.project}\n\n`) ?? { project: m.project, release: "", dist: "", names: [], debugIds: [] };
    l.debugIds = [...new Set([...l.debugIds, ...debugIds])];
    wanted.set(`${m.project}\n\n`, l);
  }
  if (wanted.size && bucket) {
    const found = await deps.findArtifacts([...wanted.values()]);
    for (const { m, e } of loaded) {
      const mapFor = async (f: StackFrame, debugId: string | undefined) => {
        const name = artifactName(f.abs_path ?? f.filename ?? "");
        const sha = (debugId && found[`debug:${debugId}`]) || (e.release ? (found[artifactKey(m.project, e.release, e.dist ?? "", name)] ?? found[artifactKey(m.project, e.release, "", name)]) : undefined);
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
  // 3. Grouping.
  const prepared = await Promise.all(loaded.map(async ({ m, e }) => ({ m, e, fingerprint: await fingerprintOf(e), at: timestampOf(e, m.receivedAt) })));
  // 4. One object for the batch.
  let object: string | null = null;
  const pointers: Array<EventPointer | undefined> = [];
  if (bucket && prepared.length) {
    const { bytes, ranges } = await batchObject(prepared.map(({ m, e }) => JSON.stringify({ project: m.project, receivedAt: m.receivedAt, event: e })));
    object = keys.events(deps.install, deps.now, `${deps.now.toString(36)}-${crypto.randomUUID().slice(0, 8)}`);
    await bucket.put(object, bytes, { httpMetadata: { contentType: "application/x-ndjson", contentEncoding: "gzip" } });
    for (const r of ranges) pointers.push({ key: object, ...r });
  }
  const groups = new Map<string, IssueGroup>();
  prepared.forEach(({ m, e, fingerprint, at }, i) => {
    const k = `${m.project}\n${fingerprint}`;
    const g = groups.get(k);
    const latest = !g || at >= g.lastSeen;
    const next: IssueGroup = g ?? { project: m.project, fingerprint, n: 0, firstSeen: at, lastSeen: at, title: "", culprit: "", level: "", release: "", environment: "", platform: "", eventId: "", stack: "" };
    next.n++;
    next.firstSeen = Math.min(next.firstSeen, at);
    if (latest) {
      Object.assign(next, { lastSeen: at, title: titleOf(e), culprit: culpritOf(e), level: levelOf(e), release: e.release ?? "", environment: e.environment ?? "", platform: e.platform ?? "", eventId: m.id, stack: stackText(e) });
      if (pointers[i]) next.pointer = pointers[i];
      else delete next.pointer;
    }
    groups.set(k, next);
  });
  // 5. One write per issue.
  const applied = groups.size ? await deps.apply([...groups.values()]) : { issues: 0, created: 0, alerts: 0 };
  // 6. Time series.
  for (const { m, e, fingerprint } of prepared) eventPoint(ae, { project: m.project, release: e.release, environment: e.environment, level: levelOf(e), fingerprint, platform: e.platform });
  return { events: prepared.length, ...applied, symbolicated, object };
}
