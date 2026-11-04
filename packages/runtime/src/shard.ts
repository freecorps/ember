import { DurableObject } from "cloudflare:workers";
import {
  ANON,
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
import { parse, stableStringify, stringify } from "./wire.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const DEDUP_RETENTION_MS = 7 * DAY;
export const MAX_ALARM_AHEAD_MS = 30 * DAY;
const BOOKMARK_RETENTION_MS = 30 * DAY;
const MAX_JOBS_PER_ALARM = 500;
const MAX_ATTACHMENT_BYTES = 16_000;

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
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS _jobs_due ON _jobs(state, run_at);
CREATE TABLE IF NOT EXISTS _ember_bookmarks (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, bookmark TEXT NOT NULL, reason TEXT NOT NULL) STRICT;
`;

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
  fn: string;
  args?: unknown;
  kind?: "mutation" | "action";
  runAt?: number;
  dedupKey?: string;
  maxAttempts?: number;
}

export interface JobRow {
  id: number;
  run_at: number;
  fn: string;
  kind: string;
  state: string;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  dedup_key: string | null;
}

export interface ShardInspection {
  version: number;
  epoch: string;
  shard: string | null;
  stats: { batches: number; batchSizes: number[]; booted: number; migrated: number; rebuiltSubs: number };
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
  readSet: ReadSet;
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
  resolve: (o: MutationOutcome) => void;
}

const qidKey = (qid: Id) => JSON.stringify(qid);

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

  private pending: Pending[] = [];
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  private lastArmed: number | null | undefined = undefined;
  private readonly stats = { batches: 0, batchSizes: [] as number[], booted: 0, migrated: 0, rebuiltSubs: 0 };

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
    const create = this.cfg.createEngine;
    if (!create) throw new Error("Ember: no engine factory configured (createEmberWorker({ createEngine }))");
    const schemaVersion = this.cfg.schema.manifest.version;
    const idKey = this.ctx.id.toString();
    const cached = verifiedInIsolate.get(idKey) === schemaVersion;
    if (!cached) this.ctx.storage.sql.exec(RUNTIME_DDL);

    this.engine = create({
      schema: this.cfg.schema,
      functions: this.cfg.functions,
      driver: this.driver,
      now: () => Date.now(),
      random: Math.random,
    });

    let migrated = false;
    if (!cached) {
      if (this.getMeta("schema_version") !== schemaVersion) {
        this.driver.transaction(() => {
          this.engine.migrate();
          this.setMeta("schema_version", schemaVersion);
        });
        migrated = true;
        this.stats.migrated++;
      }
      verifiedInIsolate.set(idKey, schemaVersion);
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
  }

  /** In-memory subscription state is lost on hibernation/eviction; rebuild it from `_ember_subs`. */
  private rebuildRegistry(): void {
    const live = new Map<string, { ws: WebSocket; att: Attachment }>();
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (att?.sid) live.set(att.sid, { ws, att });
    }
    for (const [sid, { ws }] of live) this.sockets.set(sid, ws);
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
      try {
        const entry = this.getOrRunQuery(r.fn as string, parse(r.args as string), { identity: s.att.identity });
        this.attach(sid, qid, entry);
        this.stats.rebuiltSubs++;
      } catch (e) {
        this.driver.exec("DELETE FROM _ember_subs WHERE sock = ? AND qid = ?", sid, r.qid as string);
        this.send(s.ws, { t: "err", code: "query_failed", message: errInfo(e, "query_failed").message, qid });
      }
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

  /** Throws if the query fails (the entry is not cached in that case). */
  private getOrRunQuery(fn: string, args: unknown, ctx: AuthCtx): QueryEntry {
    const key = this.queryKey(fn, args, ctx);
    const hit = this.queries.get(key);
    if (hit && !hit.error) return hit;
    const r = this.engine.runQuery(fn, args, ctx);
    const entry: QueryEntry = {
      key, fn, args, ctx,
      value: r.value,
      json: stringify(r.value),
      readSet: r.readSet,
      error: null,
      subs: hit?.subs ?? new Set(),
    };
    this.queries.set(key, entry);
    return entry;
  }

  private reevaluate(entry: QueryEntry): void {
    try {
      const r = this.engine.runQuery(entry.fn, entry.args, entry.ctx);
      entry.value = r.value;
      entry.json = stringify(r.value);
      entry.readSet = r.readSet;
      entry.error = null;
    } catch (e) {
      // keep the previous readSet so the query is retried when that data changes again
      entry.error = errInfo(e, "query_failed");
      entry.json = `\u0000error:${entry.error.message}`;
    }
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
      if (!entry.subs.size) this.queries.delete(entry.key);
    }
    return true;
  }

  private dropSocket(sid: string): void {
    for (const sub of [...(this.subs.get(sid)?.values() ?? [])]) this.detach(sid, sub.qid);
    this.sockets.delete(sid);
    this.chains.delete(sid);
    this.driver.exec("DELETE FROM _ember_subs WHERE sock = ?", sid);
  }

  /** Re-run every query whose read-set intersects `changes`; one `patch` per socket. */
  private publish(version: number, changes: RowChange[]): void {
    if (!changes.length) return;
    const perSocket = new Map<string, Array<{ qid: Id; value: unknown }>>();
    for (const entry of [...this.queries.values()]) {
      if (!this.engine.matches(entry.readSet, changes)) continue;
      if (!entry.subs.size) {
        this.queries.delete(entry.key);
        continue;
      }
      const before = entry.json;
      this.reevaluate(entry);
      if (entry.json === before) continue;
      for (const s of entry.subs) {
        const [sid, qk] = s.split("\n") as [string, string];
        const sub = this.subs.get(sid)?.get(qk);
        if (!sub) continue;
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
      if (ws) this.send(ws, { t: "patch", version, changes: list });
    }
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

  /** Writes version bump, change log, scheduled jobs. Must run inside a transaction. */
  private recordCommit(changes: RowChange[], jobs: Job[]): number {
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
    for (const j of jobs) this.insertJob({ fn: j.fn, args: j.args, kind: j.kind, runAt: j.runAt });
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
          for (const r of results) {
            if (r.ok) {
              all.push(...r.changes);
              jobs.push(...r.scheduled);
            }
          }
          const v = this.recordCommit(all, jobs);
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
          return { v, all, jobs: jobs.length };
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

    this.publish(this.version, changes);
    if (hasJobs) this.armAlarm();
    for (let i = 0; i < batch.length; i++) {
      batch[i]!.resolve(outcomes[i] ?? { ok: false, error: { code: "internal", message: "no outcome" } });
    }
  }

  // ------------------------------------------------------------------ scheduler

  private insertJob(job: JobInput): number | null {
    const now = Date.now();
    const maxAttempts = job.maxAttempts ?? this.cfg.scheduler?.maxAttempts ?? 5;
    const r = this.driver.exec(
      `INSERT INTO _jobs(run_at, fn, args, kind, max_attempts, dedup_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(dedup_key) DO NOTHING RETURNING id`,
      job.runAt ?? now, job.fn, stringify(job.args ?? {}), job.kind ?? "mutation", maxAttempts, job.dedupKey ?? null, now, now,
    ).rows[0];
    return r ? (r.id as number) : null;
  }

  /** alarm = min(next pending job, next maintenance), never more than 30 days ahead (chained). */
  private armAlarm(): void {
    const now = Date.now();
    const j = this.driver.exec("SELECT MIN(run_at) AS m FROM _jobs WHERE state = 'pending'").rows[0];
    const candidates: number[] = [];
    if (j && j.m !== null) candidates.push(j.m as number);
    const maint = this.getMeta("next_maint");
    if (maint !== null) candidates.push(Number(maint));
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
        const v = this.recordCommit(r.changes, r.scheduled);
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

  private async runActionJob(job: Record<string, unknown>): Promise<void> {
    const msg: ActionJobMessage = {
      shard: this.shardName ?? "",
      jobId: job.id as number,
      fn: job.fn as string,
      args: parse(job.args as string),
      attempt: (job.attempts as number) + 1,
    };
    try {
      // Mark running first so a concurrent alarm retry cannot double-send while we await the queue.
      this.driver.exec("UPDATE _jobs SET state = 'running', updated_at = ? WHERE id = ?", Date.now(), job.id as number);
      if (this.cfg.dispatchAction) await this.cfg.dispatchAction(this.env, msg);
      else if (this.env.EMBER_ACTIONS) await this.env.EMBER_ACTIONS.send(msg);
      else throw Object.assign(new Error("no EMBER_ACTIONS queue binding"), { code: "no_action_queue" });
      this.driver.exec("DELETE FROM _jobs WHERE id = ?", job.id as number);
    } catch (e) {
      this.driver.transaction(() => this.failJob(job, errInfo(e, "dispatch_failed")));
    }
  }

  override async alarm(): Promise<void> {
    // Never throw: retries are counted per job, not by the platform's 6 alarm retries.
    let ran = 0;
    try {
      // A crash mid-dispatch can leave action jobs 'running'; give them back to the queue.
      this.driver.exec("UPDATE _jobs SET state = 'pending' WHERE state = 'running' AND updated_at < ?", Date.now() - 5 * 60_000);
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

  private async maintenance(): Promise<void> {
    const now = Date.now();
    this.driver.exec("DELETE FROM _ember_dedup WHERE at < ?", now - DEDUP_RETENTION_MS);
    this.driver.exec("DELETE FROM _jobs WHERE state = 'failed' AND updated_at < ?", now - DEDUP_RETENTION_MS);
    this.driver.exec("DELETE FROM _ember_bookmarks WHERE at < ?", now - BOOKMARK_RETENTION_MS);
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
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  private saveAttachment(ws: WebSocket, att: Attachment): void {
    let a = att;
    if (JSON.stringify(a).length > MAX_ATTACHMENT_BYTES && a.identity) {
      const { claims: _drop, ...rest } = a.identity;
      a = { ...a, identity: rest };
    }
    ws.serializeAttachment(a);
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
    if (msg.t !== "hello" && !att.hello) {
      this.send(ws, { t: "err", code: "no_hello", message: "send hello first" });
      return;
    }
    if (att.identity?.exp !== undefined && att.identity.exp * 1000 <= Date.now() && msg.t !== "auth") {
      att = { ...att, identity: null };
      this.saveAttachment(ws, att);
      this.send(ws, { t: "authExpired" });
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
        this.enqueue({
          fn: msg.fn,
          args: msg.args,
          ctx,
          dedup: { identity: identityKey(att.identity), clientId: att.clientId ?? "", mid: qidKey(mid) },
          resolve: (o) => this.send(ws, o.ok ? { t: "mres", mid, ok: true, value: o.value, version: o.version } : { t: "mres", mid, ok: false, error: o.error }),
        });
        return;
      }
      case "auth": {
        const identity = await this.verify(msg.token);
        if (!identity) {
          this.send(ws, { t: "err", code: "unauthenticated", message: "invalid token" });
          return;
        }
        att = { ...(ws.deserializeAttachment() as Attachment), identity };
        this.saveAttachment(ws, att);
        // Identity changed: every subscription of this socket is re-evaluated under the new identity.
        const ctx: AuthCtx = { identity };
        for (const sub of [...(this.subs.get(att.sid)?.values() ?? [])]) {
          const old = this.queries.get(sub.key);
          this.detach(att.sid, sub.qid);
          try {
            const entry = this.getOrRunQuery(old?.fn ?? "", old?.args ?? {}, ctx);
            this.attach(att.sid, sub.qid, entry);
            this.send(ws, { t: "snap", qid: sub.qid, version: this.version, value: entry.value });
          } catch (e) {
            const err = errInfo(e, "query_failed");
            this.driver.exec("DELETE FROM _ember_subs WHERE sock = ? AND qid = ?", att.sid, qidKey(sub.qid));
            this.send(ws, { t: "err", code: err.code, message: err.message, qid: sub.qid });
          }
        }
        return;
      }
    }
  }

  private async verify(token: string): Promise<Identity | null> {
    const hook = this.cfg.auth;
    if (!hook) return null;
    try {
      return (await hook.verify(token)) ?? null;
    } catch {
      return null;
    }
  }

  private subscribe(ws: WebSocket, att: Attachment, msg: Extract<ClientMessage, { t: "sub" }>): void {
    if (this.subs.get(att.sid)?.has(qidKey(msg.qid))) {
      this.send(ws, { t: "err", code: "duplicate_qid", message: "qid already subscribed", qid: msg.qid });
      return;
    }
    let entry: QueryEntry;
    try {
      entry = this.getOrRunQuery(msg.fn, msg.args, { identity: att.identity });
    } catch (e) {
      const err = errInfo(e, "query_failed");
      this.send(ws, { t: "err", code: err.code, message: err.message, qid: msg.qid });
      return;
    }
    this.attach(att.sid, msg.qid, entry);
    this.driver.exec(
      "INSERT OR REPLACE INTO _ember_subs(sock, qid, fn, args) VALUES (?, ?, ?, ?)",
      att.sid, qidKey(msg.qid), msg.fn, stringify(msg.args),
    );
    if (msg.resume && this.resumeUnchanged(msg.resume, entry.readSet)) {
      this.send(ws, { t: "snap", qid: msg.qid, version: this.version, unchanged: true });
    } else {
      this.send(ws, { t: "snap", qid: msg.qid, version: this.version, value: entry.value });
    }
  }

  /**
   * True when the client's value at `resume.version` is still current: same epoch, every version
   * since is in the change log, and none of those changes touches the query's read-set.
   */
  private resumeUnchanged(resume: { version: number; epoch: string }, readSet: ReadSet): boolean {
    if (resume.epoch !== this.epoch || resume.version > this.version) return false;
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

  async query(shard: string, fn: string, args: unknown, identity: Identity | null): Promise<MutationOutcome> {
    this.setShardName(shard);
    try {
      const ctx: AuthCtx = { identity };
      const cached = this.queries.get(this.queryKey(fn, args, ctx));
      const value = cached && !cached.error ? cached.value : this.engine.runQuery(fn, args, ctx).value;
      return { ok: true, value, version: this.version };
    } catch (e) {
      return { ok: false, error: errInfo(e, "query_failed") };
    }
  }

  async mutation(shard: string, fn: string, args: unknown, identity: Identity | null): Promise<MutationOutcome> {
    this.setShardName(shard);
    return new Promise((resolve) => this.enqueue({ fn, args, ctx: { identity }, resolve }));
  }

  async enqueueJob(shard: string, job: JobInput): Promise<{ id: number | null }> {
    this.setShardName(shard);
    const id = this.insertJob(job);
    this.armAlarm();
    return { id };
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
      jobs: this.driver.exec("SELECT id, run_at, fn, kind, state, attempts, max_attempts, last_error, dedup_key FROM _jobs ORDER BY run_at, id").rows as unknown as JobRow[],
      bookmarks: (this.driver.exec("SELECT COUNT(*) AS n FROM _ember_bookmarks").rows[0]?.n as number) ?? 0,
      alarm: await this.ctx.storage.getAlarm(),
    };
  }
}
