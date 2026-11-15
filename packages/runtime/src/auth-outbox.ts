// Profile sync outbox (PLAN §9): the Auth DO records every user create/update/delete in its own SQLite (same
// Durable Object, written synchronously from Better Auth's `databaseHooks.user.*.after`) and an alarm delivers each
// row as `internal.users.sync` to the target shard, in order, with retries. Delivery is at-least-once over the wire
// and exactly-once in effect: every row carries an idempotency key the Shard dedups on (`_ember_dedup`).
//
// Crash gap (closed): Better Auth runs `databaseHooks.*.after` once the user write has committed, so an Auth DO that
// dies between the write and the hook would lose the change. @freecorps/ember-auth installs SQLite triggers on the
// user table that journal every write in `_ember_user_journal` *in the same transaction* (USER_JOURNAL_TABLE). The
// hook writes its outbox row and deletes the matching journal row atomically; a journal row older than
// `journalGraceMs` therefore belongs to a change whose hook never ran (crash, or a plugin writing around the hooks),
// and the alarm turns it into an outbox row carrying the user's *current* state (delete: just the id).

import { flattenFunctions, type ReplicaTableSpec } from "@freecorps/ember-server";
import { authReplicaReader, replicaTablesOfSpec, type AuthReplicaSpec } from "./auth-replicas.ts";
import { getEmberConfig, isValidShardName, type EmberEnv, type ReplicationSourceRpc } from "./config.ts";
import { drainReplication, ensureReplicationTables, nextReplicationAt, replicationTargets, requestSnapshot, type ReplicationOptions, type ReplicationTargetRow } from "./replication.ts";
import type { Shard } from "./shard.ts";
import { shardStub } from "./stubs.ts";

export type UserChangeEvent = "create" | "update" | "delete";

/** What `internal.users.sync` receives. Dates are ms since epoch; hidden fields never leave the Auth DO. */
export interface UserSyncArgs {
  event: UserChangeEvent;
  user: Record<string, unknown> & { id: string };
  /** Idempotency key of this outbox row (also used by the runtime to dedup redeliveries). */
  key: string;
}

export interface AuthOutboxOptions {
  /** Internal mutation to call. Default `"users:sync"` (`internal.users.sync`); nothing is recorded if absent. */
  fn?: string;
  /** Target shard (`<kind>:<key>`), fixed or per user. Default `"global:main"`. */
  shard?: string | ((user: Record<string, unknown>) => string);
  /** Attempts before a row is parked as dead (kept for inspection). Default 10. */
  maxAttempts?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** Rows delivered per alarm turn. Default 50. */
  batch?: number;
  /** A journal row older than this has lost its hook (crash) and is recovered by the alarm. Default 60 s. */
  journalGraceMs?: number;
  /**
   * Better Auth organizations in each org shard (PLAN §22 L3): what `authReplicaSpec(config)` of
   * `@freecorps/ember-auth` computes (the CLI embeds it). Requires `ember.replicate` in auth.config.ts (the triggers).
   */
  replicate?: AuthReplicaSpec;
  /** Delivery tuning of the replication (replication.ts). */
  replication?: Pick<ReplicationOptions, "maxAttempts" | "backoffBaseMs" | "backoffMaxMs" | "batch" | "pageSize" | "deliver">;
  /** DO namespace binding of the `Auth` class (admin resyncs reach it). Default "AUTH". */
  binding?: string;
}

/** Written by triggers on the Better Auth user table (@freecorps/ember-auth `userJournalDDL`). */
export const USER_JOURNAL_TABLE = "_ember_user_journal";

/** Loads a user's current row (the Auth DO's `userForSync`), or null when it no longer exists. */
export type UserLoader = (id: string) => Promise<Record<string, unknown> | null>;

export interface OutboxRow {
  seq: number;
  key: string;
  fn: string;
  shard: string;
  event: UserChangeEvent;
  attempts: number;
  next_at: number;
  dead: number;
  last_error: string | null;
}

/** Storage + env as `@freecorps/ember-auth`'s `onUserChange` hook passes them. */
type HookCtx = { storage: DurableObjectStorage; env: Record<string, unknown> };

const DDL = `CREATE TABLE IF NOT EXISTS _ember_outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, fn TEXT NOT NULL, shard TEXT NOT NULL,
  event TEXT NOT NULL, args TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL,
  dead INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at INTEGER NOT NULL
)`;

/** Fields Better Auth keeps private even if a plugin forgets `returned: false`. */
const PRIVATE = new Set(["password", "twoFactorSecret", "backupCodes"]);

function plainUser(user: Record<string, unknown>): Record<string, unknown> & { id: string } {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(user)) {
    if (v === undefined || PRIVATE.has(k)) continue;
    out[k] = v instanceof Date ? v.getTime() : v;
  }
  return out as Record<string, unknown> & { id: string };
}

/** What the wrapped `Auth` class answers about replication (`replicaStatus`). */
export interface AuthReplicationStatus {
  enabled: boolean;
  /** Journal rows not converted yet. */
  journal: number;
  /** The journal conversion keeps failing (retried with backoff): how often, the last error, the next try. */
  convert: { failures: number; retryAt: number; error: string } | null;
  targets: ReplicationTargetRow[];
  next: number | null;
}

export interface AuthOutbox {
  /** Pass as `emberAuth(config, { onUserChange })`. */
  onUserChange(event: UserChangeEvent, user: Record<string, unknown>, ctx: HookCtx): Promise<void>;
  /** Adds the delivery alarm (and an `outbox()` RPC for inspection) to the `Auth` Durable Object class. */
  wrap<C extends abstract new (...args: any[]) => object>(Auth: C): C;
  /** One delivery pass (what the alarm runs): recovers orphaned journal rows first when `loadUser` is given. */
  drain(storage: DurableObjectStorage, env: Record<string, unknown>, loadUser?: UserLoader): Promise<{ delivered: number; failed: number; recovered: number }>;
  /**
   * For `createEmberWorker({ replicas })`: the replica tables the shards get and the Auth DO as their source (admin
   * resyncs). Undefined without `replicate`.
   */
  replicas?: { tables: ReplicaTableSpec[]; sources: Record<string, (env: EmberEnv) => ReplicationSourceRpc> };
}

function hasJournal(sql: SqlStorage): boolean {
  return sql.exec(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '${USER_JOURNAL_TABLE}'`).toArray().length > 0;
}

export function authOutbox(opts: AuthOutboxOptions = {}): AuthOutbox {
  const fn = opts.fn ?? "users:sync";
  const maxAttempts = opts.maxAttempts ?? 10;
  const base = opts.backoffBaseMs ?? 1_000;
  const cap = opts.backoffMaxMs ?? 5 * 60_000;
  const batch = opts.batch ?? 50;
  const grace = opts.journalGraceMs ?? 60_000;
  let enabled: boolean | undefined;
  const isEnabled = () => {
    if (enabled === undefined) {
      const f = flattenFunctions(getEmberConfig().functions).get(fn);
      if (f && f.type !== "mutation") throw new Error(`auth outbox: ${fn} must be an internalMutation (got ${f.type})`);
      enabled = !!f;
    }
    return enabled;
  };
  const shardOf = (user: Record<string, unknown>) => {
    const s = typeof opts.shard === "function" ? opts.shard(user) : (opts.shard ?? "global:main");
    if (!isValidShardName(s)) throw new Error(`auth outbox: invalid shard ${JSON.stringify(s)}`);
    return s;
  };

  const record = (sql: SqlStorage, event: UserChangeEvent, u: Record<string, unknown> & { id: string }, key: string, now: number) => {
    const args: UserSyncArgs = { event, user: u, key };
    sql.exec(
      `INSERT INTO _ember_outbox (key, fn, shard, event, args, next_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      key, fn, shardOf(u), event, JSON.stringify(args), now, now,
    );
  };

  /** Journal rows whose hook never ran (older than the grace period) become outbox rows with the current state. */
  async function recover(storage: DurableObjectStorage, loadUser: UserLoader): Promise<number> {
    const sql = storage.sql;
    if (!hasJournal(sql)) return 0;
    const now = Date.now();
    const rows = sql.exec(`SELECT * FROM ${USER_JOURNAL_TABLE} WHERE at <= ? ORDER BY seq LIMIT ?`, now - grace, batch).toArray();
    let recovered = 0;
    for (const r of rows) {
      const event = r.event as UserChangeEvent;
      const id = String(r.user_id);
      // Current state: a create/update of a user deleted since is covered by the delete's own journal row, which
      // carries the old row (the trigger's `data`), so a per-user `shard` function still routes it.
      let user: Record<string, unknown> | null;
      if (event === "delete") {
        let old: Record<string, unknown> | null = null;
        try {
          old = typeof r.data === "string" ? (JSON.parse(r.data) as Record<string, unknown>) : null;
        } catch {
          old = null;
        }
        user = { ...(old ?? {}), id };
      } else user = await loadUser(id);
      storage.transactionSync(() => {
        if (user) record(sql, event, plainUser(user), `${event}:${id}:recovered:${r.seq}`, Date.now());
        sql.exec(`DELETE FROM ${USER_JOURNAL_TABLE} WHERE seq = ?`, r.seq);
      });
      if (user) {
        recovered++;
        console.error(`ember: auth outbox recovered a ${event} of user ${id} whose hook never ran (crash or a write around the hooks)`);
      }
    }
    return recovered;
  }

  const reader = opts.replicate ? authReplicaReader(opts.replicate) : null;
  const META = "_ember_replication_meta";
  const ensureMeta = (sql: SqlStorage) => sql.exec(`CREATE TABLE IF NOT EXISTS ${META} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  const replicationDue = (sql: SqlStorage) => {
    ensureReplicationTables(sql);
    return nextReplicationAt(sql);
  };
  const bootstrapped = (sql: SqlStorage) => {
    ensureMeta(sql);
    return sql.exec(`SELECT value FROM ${META} WHERE key = 'auth'`).toArray()[0]?.value === opts.replicate?.version;
  };
  // A journal → outbox conversion that throws (a row the reader cannot decode, an insert SQLite refuses) is retried
  // with exponential backoff, not at the next alarm right away: a persistent error would spin the DO. The state is in
  // the DO's SQLite (survives evictions) and visible in `replicaStatus().convert`.
  const convertBase = opts.replication?.backoffBaseMs ?? 1_000;
  const convertCap = opts.replication?.backoffMaxMs ?? 5 * 60_000;
  type ConvertFailure = { failures: number; retryAt: number; error: string };
  const convertFailure = (sql: SqlStorage): ConvertFailure | null => {
    ensureMeta(sql);
    const v = sql.exec(`SELECT value FROM ${META} WHERE key = 'auth_convert'`).toArray()[0]?.value;
    if (typeof v !== "string") return null;
    try {
      return JSON.parse(v) as ConvertFailure;
    } catch {
      return null;
    }
  };
  /** When the next conversion may run: now, or the end of the current backoff. */
  const convertAt = (sql: SqlStorage, now = Date.now()) => Math.max(now, convertFailure(sql)?.retryAt ?? 0);
  /** Moves the alarm earlier (never later: the profile outbox may want it sooner). */
  const armAt = async (storage: DurableObjectStorage, at: number) => {
    const cur = await storage.getAlarm();
    if (cur === null || cur > at) await storage.setAlarm(Math.max(at, Date.now()));
  };
  /** Journal rows waiting (or a bootstrap not done): wake up when the conversion may run. */
  const armForJournal = async (storage: DurableObjectStorage) => {
    if (reader!.journalPending(storage.sql) || !bootstrapped(storage.sql)) await armAt(storage, convertAt(storage.sql));
  };
  /** One replication turn (alarm): bootstrap, journal → outbox, deliveries; re-arms for what is left. */
  async function replicate(storage: DurableObjectStorage, env: Record<string, unknown>) {
    const sql = storage.sql;
    ensureReplicationTables(sql);
    const now = Date.now();
    const failed = convertFailure(sql);
    if (!failed || failed.retryAt <= now) {
      try {
        storage.transactionSync(() => reader!.bootstrap(sql));
        // Journal → outbox in bounded transactions (each one atomic: journal rows out, outbox rows in).
        for (let i = 0; i < 20 && storage.transactionSync(() => reader!.convert(sql)) > 0; i++);
        if (failed) sql.exec(`DELETE FROM ${META} WHERE key = 'auth_convert'`);
      } catch (e) {
        const failures = (failed?.failures ?? 0) + 1;
        const error = e instanceof Error ? e.message : String(e);
        const state: ConvertFailure = { failures, retryAt: now + Math.min(convertCap, convertBase * 2 ** (failures - 1)), error };
        sql.exec(`INSERT INTO ${META} (key, value) VALUES ('auth_convert', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, JSON.stringify(state));
        console.error(`ember: auth replication could not read its journal (${failures} failure${failures === 1 ? "" : "s"} in a row, next try in ${state.retryAt - now} ms): ${error}`);
      }
    }
    const r = await drainReplication(storage, env as EmberEnv, { source: "auth", snapshot: (s, target) => reader!.snapshot(s, target), ...opts.replication });
    let next = r.next;
    if (reader!.journalPending(sql) || !bootstrapped(sql)) next = Math.min(next ?? Infinity, convertAt(sql));
    if (next !== null) await armAt(storage, next);
  }

  async function drain(storage: DurableObjectStorage, env: Record<string, unknown>, loadUser?: UserLoader) {
    const sql = storage.sql;
    sql.exec(DDL);
    const recovered = loadUser && isEnabled() ? await recover(storage, loadUser) : 0;
    const manifest = getEmberConfig().schema.manifest;
    let delivered = 0;
    let failed = 0;
    const rows = sql.exec(`SELECT seq, key, fn, shard, args, attempts, next_at FROM _ember_outbox WHERE dead = 0 ORDER BY seq LIMIT ?`, batch).toArray();
    for (const r of rows) {
      const now = Date.now();
      // In order: a row waiting for its retry holds back the ones after it (a user's create before its update).
      if ((r.next_at as number) > now) break;
      let err: string | null = null;
      try {
        const stub = shardStub(env as EmberEnv, manifest, r.shard as string) as unknown as Shard;
        const out = await stub.mutation(r.shard as string, r.fn as string, JSON.parse(r.args as string), null, true, { dedupKey: r.key as string });
        if (!out.ok) err = `${out.error.code}: ${out.error.message}`;
      } catch (e) {
        err = e instanceof Error ? e.message : String(e);
      }
      if (err === null) {
        sql.exec(`DELETE FROM _ember_outbox WHERE seq = ?`, r.seq);
        delivered++;
        continue;
      }
      failed++;
      const attempts = (r.attempts as number) + 1;
      if (attempts >= maxAttempts) {
        console.error(`ember: auth outbox row ${r.key} (${r.fn} → ${r.shard}) failed ${attempts} times, parked: ${err}`);
        sql.exec(`UPDATE _ember_outbox SET attempts = ?, dead = 1, last_error = ? WHERE seq = ?`, attempts, err, r.seq);
        continue;
      }
      const delay = Math.min(cap, base * 2 ** (attempts - 1));
      sql.exec(`UPDATE _ember_outbox SET attempts = ?, next_at = ?, last_error = ? WHERE seq = ?`, attempts, now + delay, err, r.seq);
      break;
    }
    // Wake up for the head row only: rows behind it are held back until it is delivered or parked, so an earlier
    // `next_at` further down the queue must not schedule the alarm (it would re-fire in a tight loop until the head's
    // backoff expires).
    const head = sql.exec(`SELECT next_at FROM _ember_outbox WHERE dead = 0 ORDER BY seq LIMIT 1`).toArray()[0];
    let next = head ? (head.next_at as number) : null;
    // Journal rows still inside their grace period: come back when the oldest one expires.
    if (loadUser && hasJournal(sql)) {
      const j = sql.exec(`SELECT MIN(at) AS at FROM ${USER_JOURNAL_TABLE}`).toArray()[0];
      if (j && j.at !== null) next = Math.min(next ?? Infinity, (j.at as number) + grace);
    }
    if (next !== null) await storage.setAlarm(Math.max(next, Date.now()));
    return { delivered, failed, recovered };
  }

  return {
    async onUserChange(event, user, { storage }) {
      if (!isEnabled()) return;
      const u = plainUser(user);
      const key = `${event}:${u.id}:${crypto.randomUUID()}`;
      const now = Date.now();
      const sql = storage.sql;
      sql.exec(DDL);
      const journal = hasJournal(sql);
      // The outbox row and the consumption of the trigger's journal row commit together.
      storage.transactionSync(() => {
        record(sql, event, u, key, now);
        if (journal) {
          sql.exec(
            `DELETE FROM ${USER_JOURNAL_TABLE} WHERE seq = (SELECT MIN(seq) FROM ${USER_JOURNAL_TABLE} WHERE user_id = ? AND event = ?)`,
            u.id, event,
          );
        }
      });
      await storage.setAlarm(now);
    },
    wrap<C extends abstract new (...args: any[]) => object>(Auth: C): C {
      type Base = { ctx: DurableObjectState; env: Record<string, unknown> };
      abstract class WithOutbox extends (Auth as unknown as abstract new (...args: any[]) => Base) {
        constructor(...args: any[]) {
          super(...args);
          // After a crash the journal may hold changes whose hook never ran: make sure an alarm will look at them.
          const storage = this.ctx.storage;
          void this.ctx.blockConcurrencyWhile(async () => {
            try {
              if (reader) {
                // Replication: unconverted journal rows, queued rows, or a first boot with it enabled (bootstrap).
                const due = replicationDue(storage.sql);
                if (due !== null) await armAt(storage, due);
                await armForJournal(storage);
              }
              if (!hasJournal(storage.sql)) return;
              const j = storage.sql.exec(`SELECT MIN(at) AS at FROM ${USER_JOURNAL_TABLE}`).toArray()[0];
              if (j && j.at !== null && (await storage.getAlarm()) === null) await storage.setAlarm(Math.max(Date.now(), (j.at as number) + grace));
            } catch (e) {
              console.error("ember: auth outbox journal check failed", e);
            }
          });
        }
        async alarm() {
          const self = this as unknown as { userForSync?: UserLoader };
          await drain(this.ctx.storage, this.env, typeof self.userForSync === "function" ? (id) => self.userForSync!(id) : undefined);
          if (reader) await replicate(this.ctx.storage, this.env);
        }
        /** Resync one org shard (or every one: `null`) from the Auth DO's current rows (admin endpoint). */
        async replicaResync(shard: string | null): Promise<{ ok: true; targets: number } | { ok: false; error: string }> {
          if (!reader) return { ok: false, error: "replication is not enabled (ember.replicate in auth.config.ts)" };
          const sql = this.ctx.storage.sql;
          ensureReplicationTables(sql);
          const targets = shard === null ? reader.allTargets(sql) : [shard];
          if (shard !== null && (!isValidShardName(shard) || !shard.startsWith(`${opts.replicate!.shardKind}:`))) {
            return { ok: false, error: `${shard} is not a ${opts.replicate!.shardKind} shard` };
          }
          const now = Date.now();
          this.ctx.storage.transactionSync(() => {
            for (const t of targets) requestSnapshot(sql, t, now);
          });
          await armAt(this.ctx.storage, now);
          return { ok: true, targets: targets.length };
        }
        /** Replication state: journal backlog and targets (pending, parked, errors). */
        async replicaStatus(shard?: string): Promise<AuthReplicationStatus> {
          const sql = this.ctx.storage.sql;
          if (!reader) return { enabled: false, journal: 0, convert: null, targets: [], next: null };
          ensureReplicationTables(sql);
          const journal = reader.journalCount(sql);
          return { enabled: true, journal, convert: convertFailure(sql), targets: replicationTargets(sql, shard ? { target: shard } : {}), next: nextReplicationAt(sql) };
        }
        /** Pending and parked rows (inspection, tests). */
        async outbox(): Promise<OutboxRow[]> {
          this.ctx.storage.sql.exec(DDL);
          return this.ctx.storage.sql
            .exec(`SELECT seq, key, fn, shard, event, attempts, next_at, dead, last_error FROM _ember_outbox ORDER BY seq`)
            .toArray() as unknown as OutboxRow[];
        }
      }
      // Org data a request wrote (journaled by the triggers in its transaction): deliver it now, not at the next alarm.
      if (reader) {
        for (const name of ["fetch", "handle", "api", "importAuthTables", "importUsers", "adminRevoke"]) {
          const orig = (Auth.prototype as Record<string, unknown>)[name];
          if (typeof orig !== "function") continue;
          Object.defineProperty(WithOutbox.prototype, name, {
            configurable: true,
            writable: true,
            value: async function (this: Base, ...a: unknown[]) {
              try {
                return await (orig as (...x: unknown[]) => Promise<unknown>).apply(this, a);
              } finally {
                if (reader!.journalPending(this.ctx.storage.sql)) await armAt(this.ctx.storage, convertAt(this.ctx.storage.sql));
              }
            },
          });
        }
      }
      Object.defineProperty(WithOutbox, "name", { value: (Auth as { name?: string }).name || "Auth" });
      return WithOutbox as unknown as C;
    },
    drain,
    ...(opts.replicate
      ? {
          replicas: {
            tables: replicaTablesOfSpec(opts.replicate),
            sources: {
              auth: (env: EmberEnv) => {
                const ns = env[opts.binding ?? "AUTH"] as DurableObjectNamespace | undefined;
                if (!ns) throw new Error(`auth replication: missing Durable Object binding ${opts.binding ?? "AUTH"}`);
                return ns.get(ns.idFromName("auth")) as unknown as ReplicationSourceRpc;
              },
            },
          },
        }
      : {}),
  };
}
