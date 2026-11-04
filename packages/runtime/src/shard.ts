import { DurableObject } from "cloudflare:workers";
import { createMatchIndex, makeId, type MatchIndex } from "@ember/server";
import { ActionRunner, type ShardApi } from "./actions.ts";
import {
  ANON,
  DEFAULT_CREATE_ENGINE,
  getEmberConfig,
  identityKey,
  type ActionJobMessage,
  type EmberConfig,
  type EmberEnv,
} from "./config.ts";
import type { AuthCtx, Engine, Identity, Job, MutationBatchItem, ReadSet, RowChange } from "./engine-types.ts";
import {
  decodeClientMessage,
  encodeServerMessage,
  ProtocolError,
  type ClientMessage,
  type Id,
  type ServerMessage,
} from "./protocol.ts";
import { DoSqlDriver } from "./sql-driver.ts";
import { shardStub } from "./stubs.ts";
import { parse, stableStringify, stringify } from "./wire.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const DEDUP_RETENTION_MS = 7 * DAY;
export const MAX_ALARM_AHEAD_MS = 30 * DAY;
const BOOKMARK_RETENTION_MS = 30 * DAY;
const MAX_JOBS_PER_ALARM = 500;
const MAX_ATTACHMENT_BYTES = 16_000;
export const DEFAULT_SEARCH_DEBOUNCE_MS = 2_000;
/** Bumped when RUNTIME_DDL needs an upgrade step for shards created by an older runtime. */
const RUNTIME_SCHEMA = 2;

const RUNTIME_DDL = `
CREATE TABLE IF NOT EXISTS _ember_rt_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS _ember_subs (
  sock TEXT NOT NULL, qid TEXT NOT NULL, fn TEXT NOT NULL, args TEXT NOT NULL,
  PRIMARY KEY (sock, qid)
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS _ember_dedup (
  identity TEXT NOT NULL, client_id TEXT NOT NULL, mid TEXT NOT NULL, at INTEGER NOT NULL, result TEXT NOT NULL,
  PRIMARY KEY (identity, client_id, mid)
) STRICT, WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS _ember_dedup_at ON _ember_dedup(at);
CREATE TABLE IF NOT EXISTS _ember_changelog (version INTEGER PRIMARY KEY, at INTEGER NOT NULL, changes TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS _jobs (
  id INTEGER PRIMARY KEY, run_at INTEGER NOT NULL, fn TEXT NOT NULL, args TEXT NOT NULL,
  kind TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL, last_error TEXT, dedup_key TEXT UNIQUE,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, job_id TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS _jobs_due ON _jobs(state, run_at);
CREATE TABLE IF NOT EXISTS _ember_sub_ident (
  client_id TEXT NOT NULL, qid TEXT NOT NULL, identity TEXT NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (client_id, qid)
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS _ember_bookmarks (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, bookmark TEXT NOT NULL, reason TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS _ember_migrations (
  id INTEGER PRIMARY KEY, at INTEGER NOT NULL, from_version TEXT, to_version TEXT NOT NULL,
  ok INTEGER NOT NULL, code TEXT, message TEXT
) STRICT;
`;

/** Upgrades for shards whose runtime tables predate a column (CREATE IF NOT EXISTS does not add columns). */
function upgradeRuntimeTables(sql: SqlStorage, from: number): void {
  if (from < 2) {
    try {
      sql.exec("ALTER TABLE _jobs ADD COLUMN job_id TEXT");
    } catch {
      // fresh shard: the column is already in RUNTIME_DDL
    }
  }
  sql.exec("CREATE UNIQUE INDEX IF NOT EXISTS _jobs_job_id ON _jobs(job_id)");
}

/** Per-isolate cache: DO id -> schema version already verified in this isolate. */
const verifiedInIsolate = new Map<string, string>();

export interface Attachment {
  sid: string;
  identity: Identity | null;
  clientId: string | null;
  hello: boolean;
}

export type MutationOutcome =
  | { ok: true; value: unknown; version: number }
  | { ok: false; error: { code: string; message: string } };

export interface JobInput {
  /** The id `scheduler.runAfter/runAt` returned (engine or action scheduler). Generated when omitted. */
  jobId?: string;
  fn: string;
  args?: unknown;
  kind?: "mutation" | "action";
  runAt?: number;
  dedupKey?: string;
  maxAttempts?: number;
}

export interface JobRow {
  id: number;
  job_id: string | null;
  run_at: number;
  fn: string;
  kind: string;
  state: string;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  dedup_key: string | null;
}

export interface MigrationErrorInfo {
  at: number;
  fromVersion: string | null;
  toVersion: string;
  code: string;
  message: string;
}

/** `GET /api/_ember/status` (one entry per shard). */
export interface ShardStatus {
  shard: string;
  /** Schema version the code expects (this deploy). */
  expectedVersion: string;
  /** Schema version stored in the shard (null = never migrated). */
  schemaVersion: string | null;
  /** The stored version is the expected one and no index is still backfilling. */
  ready: boolean;
  /** Staged indexes still backfilling: rows `(cursor, until]` remain. */
  staged: Array<{ table: string; index: string; kind: string; cursor: number; until: number }>;
  /** Set while the latest migration attempt to `expectedVersion` was refused; requests fail until a fixed deploy. */
  migrationError: MigrationErrorInfo | null;
  /** Last recorded migration error, any version (history). */
  lastMigrationError: MigrationErrorInfo | null;
  version: number;
  databaseSize: number;
}

export interface ShardInspection {
  version: number;
  epoch: string;
  shard: string | null;
  stats: {
    batches: number;
    batchSizes: number[];
    booted: number;
    migrated: number;
    rebuiltSubs: number;
    backfillSteps: number;
    /** Query re-runs triggered by a commit (exact matches). */
    reruns: number;
    /** Debounced re-runs (search rank drift). */
    debouncedReruns: number;
  };
  /** Staged indexes are still being backfilled by the alarm. */
  backfilling: boolean;
  subs: number;
  queries: number;
  jobs: JobRow[];
  bookmarks: number;
  alarm: number | null;
}

interface QueryEntry {
  key: string;
  fn: string;
  args: unknown;
  ctx: AuthCtx;
  json: string;
  value: unknown;
  /** null = the last run failed: matched only by the tables it (or any run of `fn`) touched. */
  readSet: ReadSet | null;
  error: { code: string; message: string } | null;
  /** `${sid}\n${qidKey}` */
  subs: Set<string>;
}

interface Sub {
  sid: string;
  qid: Id;
  key: string;
}

interface Pending {
  fn: string;
  args: unknown;
  ctx: AuthCtx;
  dedup?: { identity: string; clientId: string; mid: string };
  /** WS origin: its mid is listed in the `patch` of the version that includes it. */
  origin?: { sid: string; mid: Id };
  resolve: (o: MutationOutcome) => void;
}

const qidKey = (qid: Id) => JSON.stringify(qid);

const isExpired = (identity: Identity | null): boolean => identity?.exp !== undefined && identity.exp * 1000 <= Date.now();

function errInfo(e: unknown, fallback: string): { code: string; message: string } {
  const code = typeof (e as { code?: unknown })?.code === "string" ? (e as { code: string }).code : fallback;
  const message = e instanceof Error ? e.message : String(e);
  return { code, message };
}

export class Shard extends DurableObject<EmberEnv> {
  private readonly cfg: EmberConfig;
  private readonly driver: DoSqlDriver;
  private engine!: Engine;
  private version = 0;
  private epoch = "";
  private shardName: string | null = null;

  private readonly sockets = new Map<string, WebSocket>();
  private readonly subs = new Map<string, Map<string, Sub>>();
  private readonly queries = new Map<string, QueryEntry>();
  private readonly chains = new Map<string, Promise<void>>();
  /** Read-set index over `queries` (interval structure per (table, index); PLAN §4). */
  private index!: MatchIndex<string>;
  /** fn -> every table any run of it touched: a failing query is re-run only on commits to these. */
  private readonly knownTables = new Map<string, Set<string>>();
  /** Query keys waiting for a debounced re-run (search rank drift), and its timer. */
  private readonly debounced = new Set<string>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  /** sid -> attachment (identity / clientId), mirrored from the socket attachment. */
  private readonly attachments = new Map<string, Attachment>();
  /** Sockets already told `authExpired` for their current (expired) identity. */
  private readonly expiredNotified = new Set<string>();
  /** The latest migration attempt was refused: everything fails with this error until a fixed deploy. */
  private refused: { code: string; message: string } | null = null;

  private pending: Pending[] = [];
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  private lastArmed: number | null | undefined = undefined;
  private readonly stats = { batches: 0, batchSizes: [] as number[], booted: 0, migrated: 0, rebuiltSubs: 0, backfillSteps: 0, reruns: 0, debouncedReruns: 0 };

  constructor(ctx: DurableObjectState, env: EmberEnv) {
    super(ctx, env);
    this.cfg = getEmberConfig();
    this.driver = new DoSqlDriver(ctx.storage);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    void ctx.blockConcurrencyWhile(() => this.boot());
  }

  // ------------------------------------------------------------------ boot

  private async boot(): Promise<void> {
    this.stats.booted++;
    const create = this.cfg.createEngine ?? DEFAULT_CREATE_ENGINE;
    const schemaVersion = this.cfg.schema.manifest.version;
    const idKey = this.ctx.id.toString();
    const cached = verifiedInIsolate.get(idKey) === schemaVersion;
    if (!cached) {
      this.ctx.storage.sql.exec(RUNTIME_DDL);
      const rt = Number(this.getMeta("rt_schema") ?? "0");
      if (rt < RUNTIME_SCHEMA) {
        upgradeRuntimeTables(this.ctx.storage.sql, rt);
        this.setMeta("rt_schema", String(RUNTIME_SCHEMA));
      }
    }

    this.engine = create({
      schema: this.cfg.schema,
      functions: this.cfg.functions,
      driver: this.driver,
      now: () => Date.now(),
      random: Math.random,
    });
    this.index = createMatchIndex<string>(this.cfg.schema);
    this.refused = null;

    let migrated = false;
    if (!cached) {
      const from = this.getMeta("schema_version");
      if (from !== schemaVersion) {
        try {
          this.driver.transaction(() => {
            const report = this.engine.migrate();
            if (report.staged.length) this.setMeta("backfill", "1");
            this.setMeta("schema_version", schemaVersion);
            this.driver.exec(
              "INSERT INTO _ember_migrations(at, from_version, to_version, ok) VALUES (?, ?, ?, 1)",
              Date.now(), from, schemaVersion,
            );
          });
          migrated = true;
          this.stats.migrated++;
        } catch (e) {
          // MigrationRefused (or a failing DDL): the transaction rolled back; the shard keeps its old schema and
          // refuses work until a deploy fixes the schema. Recorded for `GET /api/_ember/status` / `deploy --wait`.
          const err = errInfo(e, "MigrationFailed");
          this.refused = err;
          this.driver.exec(
            "INSERT INTO _ember_migrations(at, from_version, to_version, ok, code, message) VALUES (?, ?, ?, 0, ?, ?)",
            Date.now(), from, schemaVersion, err.code, err.message,
          );
          this.driver.exec("DELETE FROM _ember_migrations WHERE id <= (SELECT MAX(id) FROM _ember_migrations) - 100");
          console.error(`ember: migration to ${schemaVersion.slice(0, 12)} refused`, err.message);
        }
      }
      if (!this.refused) verifiedInIsolate.set(idKey, schemaVersion);
    }

    this.version = Number(this.getMeta("version") ?? "0");
    let epoch = this.getMeta("epoch");
    if (!epoch) {
      epoch = crypto.randomUUID();
      this.setMeta("epoch", epoch);
    }
    this.epoch = epoch;
    this.shardName = this.getMeta("shard");

    if (migrated) await this.recordBookmark("migrate");
    this.rebuildRegistry();
    // After a migration (possibly fixing an earlier refusal, during which the alarm stood down) re-arm for jobs too.
    if (!this.refused && (migrated || this.getMeta("backfill") !== null)) this.armAlarm();
  }

  /** In-memory subscription state is lost on hibernation/eviction; rebuild it from `_ember_subs`. */
  private rebuildRegistry(): void {
    const live = new Map<string, { ws: WebSocket; att: Attachment }>();
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (att?.sid) live.set(att.sid, { ws, att });
    }
    for (const [sid, { ws, att }] of live) {
      this.sockets.set(sid, ws);
      this.attachments.set(sid, att);
    }
    const rows = this.driver.exec("SELECT sock, qid, fn, args FROM _ember_subs").rows;
    const dead = new Set<string>();
    for (const r of rows) {
      const sid = r.sock as string;
      const s = live.get(sid);
      if (!s) {
        dead.add(sid);
        continue;
      }
      const qid = JSON.parse(r.qid as string) as Id;
      if (this.refused) {
        this.send(s.ws, { t: "err", code: this.refused.code, message: this.refused.message, qid });
        continue;
      }
      const entry = this.getOrRunQuery(r.fn as string, parse(r.args as string), { identity: s.att.identity });
      this.attach(sid, qid, entry);
      this.stats.rebuiltSubs++;
      if (entry.error) this.send(s.ws, { t: "err", code: entry.error.code, message: entry.error.message, qid });
    }
    for (const sid of dead) this.driver.exec("DELETE FROM _ember_subs WHERE sock = ?", sid);
  }

  // ------------------------------------------------------------------ meta

  private getMeta(k: string): string | null {
    const r = this.driver.exec("SELECT v FROM _ember_rt_meta WHERE k = ?", k).rows[0];
    return r ? (r.v as string) : null;
  }

  private setMeta(k: string, v: string): void {
    this.driver.exec("INSERT INTO _ember_rt_meta(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, v);
  }

  private deleteMeta(k: string): void {
    this.driver.exec("DELETE FROM _ember_rt_meta WHERE k = ?", k);
  }

  private setShardName(name: string | null | undefined): void {
    if (!name || this.shardName === name) return;
    this.shardName = name;
    this.setMeta("shard", name);
  }

  private async recordBookmark(reason: string): Promise<void> {
    try {
      const bookmark = await this.ctx.storage.getCurrentBookmark();
      this.driver.exec("INSERT INTO _ember_bookmarks(at, bookmark, reason) VALUES (?, ?, ?)", Date.now(), bookmark, reason);
    } catch {
      // PITR may be unavailable (e.g. some local backends); bookmarks are best effort.
    }
  }

  // ------------------------------------------------------------------ query cache

  private queryKey(fn: string, args: unknown, ctx: AuthCtx): string {
    return `${fn}\u0000${stableStringify(args)}\u0000${identityKey(ctx.identity)}`;
  }

  /**
   * The cached entry for (fn, args, identity), running the query when it is missing or errored. A failing query
   * still yields an entry (with `error`), so subscribers stay registered and it is re-run after later commits.
   */
  private getOrRunQuery(fn: string, args: unknown, ctx: AuthCtx): QueryEntry {
    const key = this.queryKey(fn, args, ctx);
    const hit = this.queries.get(key);
    if (hit && !hit.error) return hit;
    const entry: QueryEntry = hit ?? { key, fn, args, ctx, value: undefined, json: "", readSet: null, error: null, subs: new Set() };
    this.reevaluate(entry);
    this.queries.set(key, entry);
    return entry;
  }

  /** Runs the query and (re)registers it in the read-set index. */
  private reevaluate(entry: QueryEntry): void {
    const touched = new Set<string>();
    let known = this.knownTables.get(entry.fn);
    if (!known) this.knownTables.set(entry.fn, (known = new Set()));
    try {
      const r = this.engine.runQuery(entry.fn, entry.args, entry.ctx, { touched });
      entry.value = r.value;
      entry.json = stringify(r.value);
      entry.readSet = r.readSet;
      entry.error = null;
      for (const e of r.readSet) known.add(e.table);
      this.index.set(entry.key, r.readSet);
    } catch (e) {
      // No read set: re-run only on commits touching tables this function is known to read (what this run opened
      // before failing, plus what any earlier run of it read). Failing before any read = only re-sub / index-ready.
      entry.error = errInfo(e, "Error");
      entry.json = `\u0000error:${entry.error.code}:${entry.error.message}`;
      entry.readSet = null;
      this.index.set(entry.key, null, [...touched, ...known]);
    }
    for (const t of touched) known.add(t);
  }

  private attach(sid: string, qid: Id, entry: QueryEntry): void {
    let m = this.subs.get(sid);
    if (!m) this.subs.set(sid, (m = new Map()));
    m.set(qidKey(qid), { sid, qid, key: entry.key });
    entry.subs.add(`${sid}\n${qidKey(qid)}`);
  }

  private detach(sid: string, qid: Id): boolean {
    const m = this.subs.get(sid);
    const sub = m?.get(qidKey(qid));
    if (!m || !sub) return false;
    m.delete(qidKey(qid));
    if (!m.size) this.subs.delete(sid);
    const entry = this.queries.get(sub.key);
    if (entry) {
      entry.subs.delete(`${sid}\n${qidKey(qid)}`);
      if (!entry.subs.size) this.forget(entry.key);
    }
    return true;
  }

  private forget(key: string): void {
    this.queries.delete(key);
    this.index.delete(key);
    this.debounced.delete(key);
  }

  private dropSocket(sid: string): void {
    for (const sub of [...(this.subs.get(sid)?.values() ?? [])]) this.detach(sid, sub.qid);
    this.sockets.delete(sid);
    this.attachments.delete(sid);
    this.expiredNotified.delete(sid);
    this.chains.delete(sid);
    this.driver.exec("DELETE FROM _ember_subs WHERE sock = ?", sid);
  }

  /**
   * Re-run the queries whose read sets `changes` may affect (read-set index, exact matches) and send one `patch`
   * per socket, listing that socket's mutations included in `version`. Loose matches (a write to a searched table
   * that cannot change the result set, only its bm25 order) are debounced. `force` re-runs only errored entries
   * (e.g. a staged index became ready).
   */
  private publish(version: number, changes: RowChange[], mids?: Map<string, Id[]>, force = false): void {
    if (!changes.length && !force) return;
    let stale: QueryEntry[];
    if (force) stale = [...this.queries.values()].filter((e) => e.error !== null);
    else {
      const { exact, loose } = this.index.match(changes);
      stale = [];
      for (const k of exact) {
        const e = this.queries.get(k);
        if (e) stale.push(e);
        else this.index.delete(k);
      }
      if (loose.size) this.debounce(loose);
    }
    this.rerun(stale, version, mids);
  }

  /** Re-runs `entries` and sends the changed values (and `mids`) as one patch per socket. */
  private rerun(entries: QueryEntry[], version: number, mids?: Map<string, Id[]>, debounced = false): void {
    const perSocket = new Map<string, Array<{ qid: Id; value: unknown }>>();
    for (const entry of entries) {
      if (!entry.subs.size) {
        this.forget(entry.key);
        continue;
      }
      // The re-run makes the result fresh, rank included.
      this.debounced.delete(entry.key);
      const before = entry.json;
      this.reevaluate(entry);
      if (debounced) this.stats.debouncedReruns++;
      else this.stats.reruns++;
      if (entry.json === before) continue;
      for (const s of entry.subs) {
        const [sid, qk] = s.split("\n") as [string, string];
        const sub = this.subs.get(sid)?.get(qk);
        if (!sub || this.expiredSocket(sid)) continue;
        if (entry.error) {
          const ws = this.sockets.get(sid);
          if (ws) this.send(ws, { t: "err", code: entry.error.code, message: entry.error.message, qid: sub.qid });
          continue;
        }
        let list = perSocket.get(sid);
        if (!list) perSocket.set(sid, (list = []));
        list.push({ qid: sub.qid, value: entry.value });
      }
    }
    for (const [sid, list] of perSocket) {
      const ws = this.sockets.get(sid);
      if (ws) this.send(ws, { t: "patch", version, changes: list, mids: mids?.get(sid) ?? [] });
    }
  }

  /**
   * Search rank drift (PLAN §4): a debounced re-run within `reactivity.searchDebounceMs` (default 2 s) of the first
   * loose write, not pushed back by later ones, so a result's order is never more than that stale.
   */
  private debounce(keys: Iterable<string>): void {
    const ms = this.cfg.reactivity?.searchDebounceMs ?? DEFAULT_SEARCH_DEBOUNCE_MS;
    for (const k of keys) this.debounced.add(k);
    if (ms <= 0) return this.flushDebounced();
    if (!this.debounceTimer) this.debounceTimer = setTimeout(() => this.flushDebounced(), ms);
  }

  private flushDebounced(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    const entries = [...this.debounced].map((k) => this.queries.get(k)).filter((e): e is QueryEntry => !!e && !e.error);
    this.debounced.clear();
    if (entries.length) this.rerun(entries, this.version, undefined, true);
  }

  /**
   * True when the socket's identity has expired (checked at patch time): its patches stop, and it is told
   * `authExpired` once until it sends `auth`.
   */
  private expiredSocket(sid: string): boolean {
    const att = this.attachments.get(sid);
    if (!att || !isExpired(att.identity)) return false;
    if (!this.expiredNotified.has(sid)) {
      this.expiredNotified.add(sid);
      const ws = this.sockets.get(sid);
      if (ws) this.send(ws, { t: "authExpired" });
    }
    return true;
  }

  private send(ws: WebSocket, m: ServerMessage): void {
    try {
      ws.send(encodeServerMessage(m));
    } catch {
      // socket already closed
    }
  }

  // ------------------------------------------------------------------ group commit

  private enqueue(p: Pending): void {
    this.pending.push(p);
    const max = this.cfg.groupCommit?.maxBatch ?? 100;
    if (this.pending.length >= max) {
      this.drain();
      return;
    }
    if (!this.drainTimer) this.drainTimer = setTimeout(() => this.drain(), this.cfg.groupCommit?.windowMs ?? 0);
  }

  private drain(): void {
    if (this.drainTimer) clearTimeout(this.drainTimer);
    this.drainTimer = null;
    const max = this.cfg.groupCommit?.maxBatch ?? 100;
    while (this.pending.length) this.commitBatch(this.pending.splice(0, max));
  }

  /** Writes version bump, change log, scheduled and cancelled jobs. Must run inside a transaction. */
  private recordCommit(changes: RowChange[], jobs: Job[], cancelled: string[] = []): number {
    let v = this.version;
    const now = Date.now();
    if (changes.length) {
      v++;
      this.setMeta("version", String(v));
      this.driver.exec("INSERT INTO _ember_changelog(version, at, changes) VALUES (?, ?, ?)", v, now, stringify(changes));
      const keep = this.cfg.changeLogVersions ?? 256;
      this.driver.exec("DELETE FROM _ember_changelog WHERE version <= ?", v - keep);
      if (this.getMeta("next_maint") === null) this.setMeta("next_maint", String(now + HOUR));
    }
    for (const j of jobs) this.insertJob({ jobId: j.id, fn: j.fn, args: j.args, kind: j.kind, runAt: j.runAt });
    for (const id of cancelled) this.driver.exec("DELETE FROM _jobs WHERE job_id = ? AND state = 'pending'", id);
    return v;
  }

  private commitBatch(batch: Pending[]): void {
    const outcomes: (MutationOutcome | undefined)[] = new Array(batch.length);
    const toRun: number[] = [];
    const firstByKey = new Map<string, number>();
    const followers: Array<[number, number]> = [];

    for (let i = 0; i < batch.length; i++) {
      const d = batch[i]!.dedup;
      if (d) {
        const k = `${d.identity}\n${d.clientId}\n${d.mid}`;
        const first = firstByKey.get(k);
        if (first !== undefined) {
          followers.push([i, first]);
          continue;
        }
        const row = this.driver.exec(
          "SELECT result FROM _ember_dedup WHERE identity = ? AND client_id = ? AND mid = ?",
          d.identity, d.clientId, d.mid,
        ).rows[0];
        if (row) {
          outcomes[i] = parse(row.result as string) as MutationOutcome;
          continue;
        }
        firstByKey.set(k, i);
      }
      toRun.push(i);
    }

    let changes: RowChange[] = [];
    let hasJobs = false;
    if (toRun.length) {
      this.stats.batches++;
      this.stats.batchSizes.push(toRun.length);
      if (this.stats.batchSizes.length > 50) this.stats.batchSizes.shift();
      try {
        const res = this.driver.transaction(() => {
          const items: MutationBatchItem[] = toRun.map((i) => ({ name: batch[i]!.fn, args: batch[i]!.args, ctx: batch[i]!.ctx }));
          const results = this.engine.runMutationBatch(items);
          if (results.length !== items.length) throw new Error("engine returned a result count different from the batch size");
          const all: RowChange[] = [];
          const jobs: Job[] = [];
          const cancelled: string[] = [];
          for (const r of results) {
            if (r.ok) {
              all.push(...r.changes);
              jobs.push(...r.scheduled);
              cancelled.push(...(r.cancelled ?? []));
            }
          }
          const v = this.recordCommit(all, jobs, cancelled);
          const now = Date.now();
          results.forEach((r, j) => {
            const i = toRun[j]!;
            const out: MutationOutcome = r.ok ? { ok: true, value: r.value, version: v } : { ok: false, error: r.error };
            outcomes[i] = out;
            const d = batch[i]!.dedup;
            if (d) {
              this.driver.exec(
                "INSERT INTO _ember_dedup(identity, client_id, mid, at, result) VALUES (?, ?, ?, ?, ?)",
                d.identity, d.clientId, d.mid, now, stringify(out),
              );
            }
          });
          return { v, all, jobs: jobs.length + cancelled.length };
        });
        this.version = res.v;
        changes = res.all;
        hasJobs = res.jobs > 0 || changes.length > 0;
      } catch (e) {
        const err = errInfo(e, "internal");
        for (const i of toRun) outcomes[i] = { ok: false, error: err };
      }
    }
    for (const [i, first] of followers) outcomes[i] = outcomes[first];

    const mids = new Map<string, Id[]>();
    for (const i of toRun) {
      const o = batch[i]!.origin;
      if (!o || !outcomes[i]?.ok) continue;
      let l = mids.get(o.sid);
      if (!l) mids.set(o.sid, (l = []));
      l.push(o.mid);
    }
    this.publish(this.version, changes, mids);
    if (hasJobs) this.armAlarm();
    for (let i = 0; i < batch.length; i++) {
      batch[i]!.resolve(outcomes[i] ?? { ok: false, error: { code: "internal", message: "no outcome" } });
    }
  }

  // ------------------------------------------------------------------ scheduler

  /** The job's id (`job_id`), or null when `dedupKey` (or `jobId`) is already taken. */
  private insertJob(job: JobInput): string | null {
    const now = Date.now();
    const maxAttempts = job.maxAttempts ?? this.cfg.scheduler?.maxAttempts ?? 5;
    const jobId = job.jobId ?? makeId("job", now, Math.random);
    const r = this.driver.exec(
      `INSERT INTO _jobs(run_at, fn, args, kind, max_attempts, dedup_key, created_at, updated_at, job_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING job_id`,
      job.runAt ?? now, job.fn, stringify(job.args ?? {}), job.kind ?? "mutation", maxAttempts, job.dedupKey ?? null, now, now, jobId,
    ).rows[0];
    return r ? (r.job_id as string) : null;
  }

  /** alarm = min(next pending job, next maintenance), never more than 30 days ahead (chained). */
  private armAlarm(): void {
    const now = Date.now();
    const j = this.driver.exec("SELECT MIN(run_at) AS m FROM _jobs WHERE state = 'pending'").rows[0];
    const candidates: number[] = [];
    if (j && j.m !== null) candidates.push(j.m as number);
    const maint = this.getMeta("next_maint");
    if (maint !== null) candidates.push(Number(maint));
    if (this.getMeta("backfill") !== null) candidates.push(now);
    if (!candidates.length) {
      if (this.lastArmed !== null) {
        this.lastArmed = null;
        void this.ctx.storage.deleteAlarm();
      }
      return;
    }
    const target = Math.min(Math.min(...candidates), now + MAX_ALARM_AHEAD_MS);
    if (this.lastArmed === target) return;
    this.lastArmed = target;
    // Issued in program order: the last call reflects the latest table state.
    void this.ctx.storage.setAlarm(target);
  }

  private backoff(attempts: number): number {
    const base = this.cfg.scheduler?.backoffBaseMs ?? 1000;
    const max = this.cfg.scheduler?.backoffMaxMs ?? HOUR;
    return Math.min(base * 2 ** Math.max(0, attempts - 1), max);
  }

  private failJob(job: Record<string, unknown>, error: { code: string; message: string }): void {
    const attempts = (job.attempts as number) + 1;
    const now = Date.now();
    const final = attempts >= (job.max_attempts as number);
    this.driver.exec(
      "UPDATE _jobs SET attempts = ?, state = ?, run_at = ?, last_error = ?, updated_at = ? WHERE id = ?",
      attempts, final ? "failed" : "pending", final ? (job.run_at as number) : now + this.backoff(attempts),
      `${error.code}: ${error.message}`, now, job.id as number,
    );
  }

  private runMutationJob(job: Record<string, unknown>): void {
    let committed: { v: number; changes: RowChange[] } | null = null;
    try {
      // The job, its effects and its state update share one transaction (alarm writes are never rolled back: R5).
      committed = this.driver.transaction(() => {
        const [r] = this.engine.runMutationBatch([{ name: job.fn as string, args: parse(job.args as string), ctx: ANON }]);
        if (!r) throw new Error("engine returned no result");
        if (!r.ok) {
          this.failJob(job, r.error);
          return null;
        }
        const v = this.recordCommit(r.changes, r.scheduled, r.cancelled ?? []);
        this.driver.exec("DELETE FROM _jobs WHERE id = ?", job.id as number);
        return { v, changes: r.changes };
      });
    } catch (e) {
      this.driver.transaction(() => this.failJob(job, errInfo(e, "internal")));
    }
    if (committed) {
      this.version = committed.v;
      this.publish(committed.v, committed.changes);
    }
  }

  /**
   * Action jobs go to the `EMBER_ACTIONS` queue (or `config.dispatchAction`) and run in the Worker's queue consumer.
   * Without a queue they run here, in the alarm turn (the action reaches this shard directly, others by RPC).
   */
  private async runActionJob(job: Record<string, unknown>): Promise<void> {
    const msg: ActionJobMessage = {
      shard: this.shardName ?? "",
      jobId: (job.job_id as string | null) ?? `#${job.id as number}`,
      fn: job.fn as string,
      args: parse(job.args as string),
      attempt: (job.attempts as number) + 1,
    };
    try {
      // Mark running first so a concurrent alarm retry cannot double-send while we await the queue.
      this.driver.exec("UPDATE _jobs SET state = 'running', updated_at = ? WHERE id = ?", Date.now(), job.id as number);
      if (this.cfg.dispatchAction) await this.cfg.dispatchAction(this.env, msg);
      else if (this.env.EMBER_ACTIONS) await this.env.EMBER_ACTIONS.send(msg);
      else {
        const out = await this.actionRunner().run(msg.fn, msg.args, msg.shard, null, { internal: true });
        if (!out.ok) throw Object.assign(new Error(out.error.message), { code: out.error.code });
      }
      this.driver.exec("DELETE FROM _jobs WHERE id = ?", job.id as number);
    } catch (e) {
      this.driver.transaction(() => this.failJob(job, errInfo(e, "dispatch_failed")));
    }
  }

  /** Actions run from this shard: calls to this shard skip the RPC hop. */
  private actionRunner(): ActionRunner {
    const self: ShardApi = this;
    return new ActionRunner(this.cfg, this.env, (shard) => (shard === this.shardName ? self : (shardStub(this.env, this.cfg.schema.manifest, shard) as unknown as ShardApi)));
  }

  override async alarm(): Promise<void> {
    // Never throw: retries are counted per job, not by the platform's 6 alarm retries.
    let ran = 0;
    try {
      if (this.refused) return;
      // A crash mid-dispatch can leave action jobs 'running'; give them back to the queue.
      this.driver.exec("UPDATE _jobs SET state = 'pending' WHERE state = 'running' AND updated_at < ?", Date.now() - 5 * 60_000);
      if (this.getMeta("backfill") !== null) this.backfillTurn();
      while (ran < MAX_JOBS_PER_ALARM) {
        const job = this.driver.exec(
          "SELECT * FROM _jobs WHERE state = 'pending' AND run_at <= ? ORDER BY run_at, id LIMIT 1",
          Date.now(),
        ).rows[0];
        if (!job) break;
        ran++;
        if (job.kind === "action") await this.runActionJob(job);
        else this.runMutationJob(job);
      }
      const maint = this.getMeta("next_maint");
      if (maint !== null && Number(maint) <= Date.now()) await this.maintenance();
    } catch (e) {
      console.error("ember: alarm failed", e);
    }
    this.lastArmed = undefined;
    this.armAlarm();
  }

  /** One chunk of staged-index backfill per alarm turn; the alarm re-arms immediately until done. */
  private backfillTurn(): void {
    try {
      const p = this.engine.backfillStep(this.cfg.backfillChunk ?? 500);
      this.stats.backfillSteps++;
      if (p.done) this.deleteMeta("backfill");
      // A query that failed with IndexNotReady may work now.
      if (p.indexReady) this.publish(this.version, [], undefined, true);
    } catch (e) {
      console.error("ember: backfill step failed", e);
    }
  }

  private async maintenance(): Promise<void> {
    const now = Date.now();
    this.driver.exec("DELETE FROM _ember_dedup WHERE at < ?", now - DEDUP_RETENTION_MS);
    this.driver.exec("DELETE FROM _jobs WHERE state = 'failed' AND updated_at < ?", now - DEDUP_RETENTION_MS);
    this.driver.exec("DELETE FROM _ember_bookmarks WHERE at < ?", now - BOOKMARK_RETENTION_MS);
    this.driver.exec("DELETE FROM _ember_sub_ident WHERE at < ?", now - BOOKMARK_RETENTION_MS);
    await this.recordBookmark("hourly");
    // Keep the hourly tick only while the shard is active.
    const active = this.getMeta("maint_version") !== String(this.version);
    this.setMeta("maint_version", String(this.version));
    if (active) this.setMeta("next_maint", String(now + HOUR));
    else this.deleteMeta("next_maint");
  }

  // ------------------------------------------------------------------ websockets

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    this.setShardName(request.headers.get("x-ember-shard"));
    const idHeader = request.headers.get("x-ember-identity");
    const identity = idHeader ? (JSON.parse(idHeader) as Identity) : null;
    const pair = new WebSocketPair();
    const server = pair[1];
    const sid = crypto.randomUUID();
    this.ctx.acceptWebSocket(server, [`sid:${sid}`]);
    this.saveAttachment(server, { sid, identity, clientId: null, hello: false });
    this.sockets.set(sid, server);
    if (this.refused) this.send(server, { t: "err", code: this.refused.code, message: this.refused.message });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  private saveAttachment(ws: WebSocket, att: Attachment): void {
    let a = att;
    if (JSON.stringify(a).length > MAX_ATTACHMENT_BYTES && a.identity) {
      const { claims: _drop, ...rest } = a.identity;
      a = { ...a, identity: rest };
    }
    ws.serializeAttachment(a);
    this.attachments.set(a.sid, a);
  }

  override async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment;
    // Serialize handling per socket: `hello` may await token verification.
    const prev = this.chains.get(att.sid) ?? Promise.resolve();
    const next = prev.then(() => this.handleMessage(ws, data)).catch((e) => {
      this.send(ws, { t: "err", code: "internal", message: errInfo(e, "internal").message });
    });
    this.chains.set(att.sid, next);
    await next;
  }

  private async handleMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    let msg: ClientMessage;
    try {
      msg = decodeClientMessage(data);
    } catch (e) {
      const code = e instanceof ProtocolError ? e.code : "bad_frame";
      this.send(ws, { t: "err", code, message: (e as Error).message });
      return;
    }
    let att = ws.deserializeAttachment() as Attachment;
    this.sockets.set(att.sid, ws);
    this.attachments.set(att.sid, att);
    if (msg.t !== "hello" && !att.hello) {
      this.send(ws, { t: "err", code: "no_hello", message: "send hello first" });
      return;
    }
    // An expired token never runs anything anonymously: the frame is refused until the client sends `auth`.
    if ((msg.t === "sub" || msg.t === "mut") && isExpired(att.identity)) {
      const error = { code: "auth_expired", message: "the token expired; send {t:\"auth\"} with a fresh one" };
      this.send(ws, { t: "authExpired" });
      if (msg.t === "mut") this.send(ws, { t: "mres", mid: msg.mid, ok: false, error });
      else this.send(ws, { t: "err", ...error, qid: msg.qid });
      return;
    }
    // A refused migration: nothing runs on the old schema with the new code.
    if (this.refused && (msg.t === "sub" || msg.t === "mut")) {
      if (msg.t === "mut") this.send(ws, { t: "mres", mid: msg.mid, ok: false, error: this.refused });
      else this.send(ws, { t: "err", ...this.refused, qid: msg.qid });
      return;
    }
    switch (msg.t) {
      case "hello": {
        if (att.hello) {
          this.send(ws, { t: "err", code: "duplicate_hello", message: "hello already received" });
          return;
        }
        let identity = att.identity;
        if (msg.token !== undefined) {
          const verified = await this.verify(msg.token);
          if (!verified) {
            this.send(ws, { t: "err", code: "unauthenticated", message: "invalid token" });
          } else identity = verified;
        }
        att = { ...(ws.deserializeAttachment() as Attachment), identity, clientId: msg.clientId, hello: true };
        this.saveAttachment(ws, att);
        this.send(ws, { t: "ready", shard: this.shardName ?? "", version: this.version, epoch: this.epoch });
        return;
      }
      case "sub":
        this.subscribe(ws, att, msg);
        return;
      case "unsub":
        if (this.detach(att.sid, msg.qid)) {
          this.driver.exec("DELETE FROM _ember_subs WHERE sock = ? AND qid = ?", att.sid, qidKey(msg.qid));
        }
        return;
      case "mut": {
        const ctx: AuthCtx = { identity: att.identity };
        const mid = msg.mid;
        const denied = this.checkCallable(msg.fn, "mutation");
        if (denied) {
          this.send(ws, { t: "mres", mid, ok: false, error: denied });
          return;
        }
        this.enqueue({
          fn: msg.fn,
          args: msg.args,
          ctx,
          dedup: { identity: identityKey(att.identity), clientId: att.clientId ?? "", mid: qidKey(mid) },
          origin: { sid: att.sid, mid },
          resolve: (o) => this.send(ws, o.ok ? { t: "mres", mid, ok: true, value: o.value, version: o.version } : { t: "mres", mid, ok: false, error: o.error }),
        });
        return;
      }
      case "auth": {
        // `token: null` = sign out: the socket continues anonymously.
        let identity: Identity | null = null;
        if (msg.token !== null) {
          identity = await this.verify(msg.token);
          if (!identity) {
            this.send(ws, { t: "err", code: "unauthenticated", message: "invalid token" });
            return;
          }
        }
        att = { ...(ws.deserializeAttachment() as Attachment), identity };
        this.saveAttachment(ws, att);
        this.expiredNotified.delete(att.sid);
        // Identity changed: every subscription of this socket is re-evaluated under the new identity.
        const ctx: AuthCtx = { identity };
        for (const sub of [...(this.subs.get(att.sid)?.values() ?? [])]) {
          const old = this.queries.get(sub.key);
          this.detach(att.sid, sub.qid);
          const entry = this.getOrRunQuery(old?.fn ?? "", old?.args ?? {}, ctx);
          this.attach(att.sid, sub.qid, entry);
          this.sendSnap(ws, att, sub.qid, entry);
        }
        return;
      }
    }
  }

  /** A verified, unexpired identity, or null. */
  private async verify(token: string): Promise<Identity | null> {
    const hook = this.cfg.auth;
    if (!hook) return null;
    try {
      const identity = (await hook.verify(token)) ?? null;
      return isExpired(identity) ? null : identity;
    } catch {
      return null;
    }
  }

  /** Clients may only call public functions of the right type (internal ones are for the scheduler and crons). */
  private checkCallable(fn: string, type: "query" | "mutation", internal = false): { code: string; message: string } | null {
    if (this.refused) return this.refused;
    const info = this.engine.functionInfo(fn);
    if (!info || (info.visibility !== "public" && !internal)) return { code: "FunctionNotFound", message: `Function ${fn} not found` };
    if (info.type !== type) return { code: "InvalidFunction", message: `${fn} is a ${info.type}, not a ${type}` };
    return null;
  }

  /** Full snapshot (or error) of one subscription; remembers the identity it was computed under for `resume`. */
  private sendSnap(ws: WebSocket, att: Attachment, qid: Id, entry: QueryEntry): void {
    if (entry.error) {
      this.send(ws, { t: "err", code: entry.error.code, message: entry.error.message, qid });
      return;
    }
    if (att.clientId) {
      this.driver.exec(
        "INSERT INTO _ember_sub_ident(client_id, qid, identity, at) VALUES (?, ?, ?, ?) ON CONFLICT(client_id, qid) DO UPDATE SET identity = excluded.identity, at = excluded.at",
        att.clientId, qidKey(qid), identityKey(att.identity), Date.now(),
      );
    }
    this.send(ws, { t: "snap", qid, version: this.version, value: entry.value });
  }

  private subscribe(ws: WebSocket, att: Attachment, msg: Extract<ClientMessage, { t: "sub" }>): void {
    const existing = this.subs.get(att.sid)?.get(qidKey(msg.qid));
    if (existing) {
      // Re-subscribing an errored qid re-runs it; a healthy duplicate is a client bug.
      if (!this.queries.get(existing.key)?.error) {
        this.send(ws, { t: "err", code: "duplicate_qid", message: "qid already subscribed", qid: msg.qid });
        return;
      }
      this.detach(att.sid, msg.qid);
    }
    const denied = this.checkCallable(msg.fn, "query");
    if (denied) {
      this.send(ws, { t: "err", ...denied, qid: msg.qid });
      return;
    }
    // A failing query stays subscribed (errored) and is re-run after matching commits or on re-sub.
    const entry = this.getOrRunQuery(msg.fn, msg.args, { identity: att.identity });
    this.attach(att.sid, msg.qid, entry);
    this.driver.exec(
      "INSERT OR REPLACE INTO _ember_subs(sock, qid, fn, args) VALUES (?, ?, ?, ?)",
      att.sid, qidKey(msg.qid), msg.fn, stringify(msg.args),
    );
    if (!entry.error && msg.resume && entry.readSet && this.resumeUnchanged(msg.resume, att, msg.qid, entry.readSet)) {
      this.send(ws, { t: "snap", qid: msg.qid, version: this.version, unchanged: true });
    } else {
      this.sendSnap(ws, att, msg.qid, entry);
    }
  }

  /**
   * True when the client's value at `resume.version` is still current: same epoch, the client's last snapshot
   * of this qid was computed under the socket's current identity, every version since is in the change log,
   * and none of those changes touches the query's read-set.
   */
  private resumeUnchanged(resume: { version: number; epoch: string }, att: Attachment, qid: Id, readSet: ReadSet): boolean {
    if (resume.epoch !== this.epoch || resume.version > this.version) return false;
    if (!att.clientId) return false;
    const owner = this.driver.exec("SELECT identity FROM _ember_sub_ident WHERE client_id = ? AND qid = ?", att.clientId, qidKey(qid)).rows[0];
    if (!owner || owner.identity !== identityKey(att.identity)) return false;
    if (resume.version === this.version) return true;
    const rows = this.driver.exec("SELECT changes FROM _ember_changelog WHERE version > ? ORDER BY version", resume.version).rows;
    if (rows.length !== this.version - resume.version) return false;
    const changes = rows.flatMap((r) => parse(r.changes as string) as RowChange[]);
    return !this.engine.matches(readSet, changes);
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (att?.sid) this.dropSocket(att.sid);
    try {
      ws.close(code, reason);
    } catch {
      // already closed
    }
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (att?.sid) this.dropSocket(att.sid);
  }

  // ------------------------------------------------------------------ RPC (Worker / System)

  /** Pre-warm: construct, migrate and load the registry while the Worker verifies auth. */
  async warm(shard: string): Promise<{ version: number; epoch: string }> {
    this.setShardName(shard);
    return { version: this.version, epoch: this.epoch };
  }

  /** `internal`: callers inside the deployment (actions) may run internal functions; clients may not. */
  async query(shard: string, fn: string, args: unknown, identity: Identity | null, internal = false): Promise<MutationOutcome> {
    this.setShardName(shard);
    const denied = this.checkCallable(fn, "query", internal);
    if (denied) return { ok: false, error: denied };
    try {
      const ctx: AuthCtx = { identity };
      const cached = this.queries.get(this.queryKey(fn, args, ctx));
      const value = cached && !cached.error ? cached.value : this.engine.runQuery(fn, args, ctx).value;
      return { ok: true, value, version: this.version };
    } catch (e) {
      return { ok: false, error: errInfo(e, "Error") };
    }
  }

  async mutation(shard: string, fn: string, args: unknown, identity: Identity | null, internal = false): Promise<MutationOutcome> {
    this.setShardName(shard);
    const denied = this.checkCallable(fn, "mutation", internal);
    if (denied) return { ok: false, error: denied };
    return new Promise((resolve) => this.enqueue({ fn, args, ctx: { identity }, resolve }));
  }

  /** `id`: the job id, or null when its dedup key / id is already taken. */
  async enqueueJob(shard: string, job: JobInput): Promise<{ id: string | null }> {
    this.setShardName(shard);
    if (this.refused) throw Object.assign(new Error(this.refused.message), { code: this.refused.code });
    const id = this.insertJob(job);
    this.armAlarm();
    return { id };
  }

  /** Cancels a pending job by id. True when one was removed (a running or finished job is not affected). */
  async cancelJob(shard: string, id: string): Promise<boolean> {
    this.setShardName(shard);
    const r = this.driver.exec("DELETE FROM _jobs WHERE job_id = ? AND state = 'pending' RETURNING id", id);
    if (r.rows.length) this.armAlarm();
    return r.rows.length > 0;
  }

  /** Migration / backfill state for `GET /api/_ember/status` (waking the shard runs its migration first). */
  async status(shard: string): Promise<ShardStatus> {
    this.setShardName(shard);
    const expectedVersion = this.cfg.schema.manifest.version;
    const schemaVersion = this.getMeta("schema_version");
    const hasIndexes = this.driver.exec("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = '_ember_indexes'").rows.length > 0;
    const staged = hasIndexes
      ? this.driver.exec(`SELECT "tbl", "name", "kind", "cursor", "until" FROM "_ember_indexes" ORDER BY "tbl", "name"`).rows.map((r) => ({
          table: String(r.tbl),
          index: String(r.name),
          kind: String(r.kind),
          cursor: Number(r.cursor),
          until: Number(r.until),
        }))
      : [];
    const toInfo = (r: Record<string, unknown> | undefined): MigrationErrorInfo | null =>
      r
        ? {
            at: r.at as number,
            fromVersion: (r.from_version as string | null) ?? null,
            toVersion: r.to_version as string,
            code: (r.code as string) ?? "MigrationFailed",
            message: (r.message as string) ?? "",
          }
        : null;
    const last = this.driver.exec("SELECT * FROM _ember_migrations WHERE to_version = ? ORDER BY id DESC LIMIT 1", expectedVersion).rows[0];
    const lastError = this.driver.exec("SELECT * FROM _ember_migrations WHERE ok = 0 ORDER BY id DESC LIMIT 1").rows[0];
    return {
      shard,
      expectedVersion,
      schemaVersion,
      ready: !this.refused && schemaVersion === expectedVersion && staged.length === 0,
      staged,
      migrationError: this.refused && last && last.ok === 0 ? toInfo(last) : null,
      lastMigrationError: toInfo(lastError),
      version: this.version,
      databaseSize: this.ctx.storage.sql.databaseSize,
    };
  }

  /** Introspection for tests and the dashboard. */
  async inspect(): Promise<ShardInspection> {
    let subs = 0;
    for (const m of this.subs.values()) subs += m.size;
    return {
      version: this.version,
      epoch: this.epoch,
      shard: this.shardName,
      stats: { ...this.stats, batchSizes: [...this.stats.batchSizes] },
      subs,
      queries: this.queries.size,
      jobs: this.driver.exec("SELECT id, job_id, run_at, fn, kind, state, attempts, max_attempts, last_error, dedup_key FROM _jobs ORDER BY run_at, id").rows as unknown as JobRow[],
      bookmarks: (this.driver.exec("SELECT COUNT(*) AS n FROM _ember_bookmarks").rows[0]?.n as number) ?? 0,
      alarm: await this.ctx.storage.getAlarm(),
      backfilling: this.getMeta("backfill") !== null,
    };
  }
}
