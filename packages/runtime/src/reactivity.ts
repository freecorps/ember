// Reactivity report for the Ember Dashboard (docs/design/contracts.md "Dashboard") and the performance advice that
// `ember dev` prints (EMBER_DEV_PERF): one source for both, so the dashboard says exactly what the terminal says.
//
// The Shard keeps a small `ReactivityLog` (counters per cached query entry and the last commits' re-runs: a few
// numbers per commit, no profiling); `reactivityReport` turns its live state into JSON. Rows read against rows
// returned need a profiled run, which costs a run: `profileRun` does one on demand for one entry.

import type { QueryProfile } from "@freecorps/ember-server";

export interface QueryAdvice {
  kind: "filter" | "collect" | "sql" | "identity" | "reads";
  message: string;
}

/** What a run of a query should change, from its profile (the same rules and wording as `ember dev`). */
export function queryAdvice(perf: { read: number; returned: number; profile: QueryProfile }, identityRead: boolean): QueryAdvice[] {
  const { profile: pr, read, returned } = perf;
  const out: QueryAdvice[] = [];
  if (pr.filteredOut >= 200 && pr.filteredOut > 4 * Math.max(1, returned)) {
    out.push({ kind: "filter", message: `.filter() dropped ${pr.filteredOut} of the ${pr.scanned} rows it scanned to return ${returned}: narrow the scan with withIndex (an index on the filtered field)` });
  }
  if (pr.collectRows >= 500) out.push({ kind: "collect", message: `.collect() returned ${pr.collectRows} rows with no limit (all re-sent and re-diffed on every change): use take(n) or paginate()` });
  if (pr.sql > 0) out.push({ kind: "sql", message: "uses ctx.db.sql: it re-runs on any write to the tables the statement names (reactivity per table, not per range)" });
  if (identityRead) {
    out.push({
      kind: "identity",
      message:
        "reads ctx.auth (in its handler or a middleware), so its result is computed once per signed-in user (N users = N re-runs per commit). Move the access check to `authorize` and keep the handler and its middlewares free of ctx.auth to share one result (docs/design/dx.md §3.13); or keep what every user sees in its own query (no ctx.auth) and call it with ctx.runQuery: it runs once per commit for all users, and only the per-user part runs per user",
    });
  }
  if (read >= 1000 && read > 20 * Math.max(1, returned)) out.push({ kind: "reads", message: `read ${read} rows to return ${returned}` });
  return out;
}

/** Documents a query value holds: an array's length, a page's length, else 1 (0 for nothing). */
export function returnedOf(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === "object" && Array.isArray((value as { page?: unknown }).page)) return (value as { page: unknown[] }).page.length;
  return value === undefined || value === null ? 0 : 1;
}

export interface CommitRecord {
  version: number;
  at: number;
  /** Cached query entries re-run by this commit. */
  reran: number;
  /** Of those, the ones whose value changed (sent to subscribers). */
  changed: number;
  ms: number;
}

interface EntryCounters {
  runs: number;
  changed: number;
  lastAt: number;
}

const MAX_COMMITS = 50;

/** Counters the Shard updates as it re-runs (cheap: no profiling). */
export class ReactivityLog {
  readonly commits: CommitRecord[] = [];
  private readonly entries = new WeakMap<object, EntryCounters>();

  ran(entry: object, changed: boolean, at = Date.now()): void {
    const c = this.entries.get(entry) ?? { runs: 0, changed: 0, lastAt: 0 };
    c.runs++;
    if (changed) c.changed++;
    c.lastAt = at;
    this.entries.set(entry, c);
  }

  commit(r: CommitRecord): void {
    if (!r.reran) return;
    this.commits.push(r);
    if (this.commits.length > MAX_COMMITS) this.commits.splice(0, this.commits.length - MAX_COMMITS);
  }

  of(entry: object): EntryCounters {
    return this.entries.get(entry) ?? { runs: 0, changed: 0, lastAt: 0 };
  }
}

/** The fields of a cached query entry the report reads (shard.ts `QueryEntry`). */
export interface EntryLike {
  key: string;
  fn: string;
  args: unknown;
  shared: boolean;
  json: string;
  value: unknown;
  readSet: Array<{ table: string; index: string }> | null;
  error: { code: string; message: string } | null;
  subs: Set<string>;
}

export interface ReactivityEntry {
  /** Opaque id of the entry (for `profile`). */
  key: string;
  fn: string;
  /** The arguments' JSON, cut at 200 characters. */
  args: string;
  /** One result for every subscriber (true), or one per signed-in user. */
  shared: boolean;
  subscribers: number;
  /** Documents in the last value (see `returnedOf`). */
  returned: number;
  /** Size of the value's JSON. */
  bytes: number;
  error: string | null;
  /** Tables and indexes its read set covers. */
  reads: string[];
  ranges: number;
  /** Re-runs since this object started, and how many changed the value. */
  runs: number;
  changed: number;
  lastRunAt: number | null;
}

export interface ReactivityReport {
  shard: string | null;
  version: number;
  subscriptions: number;
  sockets: number;
  entries: ReactivityEntry[];
  gates: number;
  stats: { reruns: number; debouncedReruns: number; identityRuns: number; splits: number; gateRuns: number; batches: number };
  /** The last commits that re-ran something, newest first. */
  commits: CommitRecord[];
}

export function reactivityReport(o: {
  shard: string | null;
  version: number;
  sockets: number;
  queries: Iterable<EntryLike>;
  gates: number;
  stats: ReactivityReport["stats"];
  log: ReactivityLog;
  stringify: (v: unknown) => string;
}): ReactivityReport {
  const entries: ReactivityEntry[] = [];
  let subscriptions = 0;
  for (const e of o.queries) {
    subscriptions += e.subs.size;
    const c = o.log.of(e);
    const args = o.stringify(e.args ?? null);
    entries.push({
      key: e.key,
      fn: e.fn,
      args: args.length > 200 ? `${args.slice(0, 197)}...` : args,
      shared: e.shared,
      subscribers: e.subs.size,
      returned: e.error ? 0 : returnedOf(e.value),
      bytes: e.error ? 0 : e.json.length,
      error: e.error ? `${e.error.code}: ${e.error.message}` : null,
      reads: [...new Set((e.readSet ?? []).map((r) => `${r.table}.${r.index}`))].slice(0, 20),
      ranges: e.readSet?.length ?? 0,
      runs: c.runs,
      changed: c.changed,
      lastRunAt: c.lastAt || null,
    });
  }
  entries.sort((a, b) => b.runs - a.runs || b.subscribers - a.subscribers);
  return {
    shard: o.shard,
    version: o.version,
    subscriptions,
    sockets: o.sockets,
    entries: entries.slice(0, 500),
    gates: o.gates,
    stats: o.stats,
    commits: [...o.log.commits].reverse(),
  };
}

export interface ProfileResult {
  fn: string;
  read: number;
  returned: number;
  profile: QueryProfile;
  identityRead: boolean;
  advice: QueryAdvice[];
  error: string | null;
}
