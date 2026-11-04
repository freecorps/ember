// Profile sync outbox (PLAN §9): the Auth DO records every user create/update/delete in its own SQLite (same
// Durable Object, written synchronously from Better Auth's `databaseHooks.user.*.after`) and an alarm delivers each
// row as `internal.users.sync` to the target shard, in order, with retries. Delivery is at-least-once over the wire
// and exactly-once in effect: every row carries an idempotency key the Shard dedups on (`_ember_dedup`).

import { flattenFunctions } from "@freecorps/ember-server";
import { getEmberConfig, isValidShardName, type EmberEnv } from "./config.ts";
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
}

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

export interface AuthOutbox {
  /** Pass as `emberAuth(config, { onUserChange })`. */
  onUserChange(event: UserChangeEvent, user: Record<string, unknown>, ctx: HookCtx): Promise<void>;
  /** Adds the delivery alarm (and an `outbox()` RPC for inspection) to the `Auth` Durable Object class. */
  wrap<C extends abstract new (...args: any[]) => object>(Auth: C): C;
  /** One delivery pass (what the alarm runs). */
  drain(storage: DurableObjectStorage, env: Record<string, unknown>): Promise<{ delivered: number; failed: number }>;
}

export function authOutbox(opts: AuthOutboxOptions = {}): AuthOutbox {
  const fn = opts.fn ?? "users:sync";
  const maxAttempts = opts.maxAttempts ?? 10;
  const base = opts.backoffBaseMs ?? 1_000;
  const cap = opts.backoffMaxMs ?? 5 * 60_000;
  const batch = opts.batch ?? 50;
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

  async function drain(storage: DurableObjectStorage, env: Record<string, unknown>) {
    const sql = storage.sql;
    sql.exec(DDL);
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
    const next = sql.exec(`SELECT MIN(next_at) AS t FROM _ember_outbox WHERE dead = 0`).one().t as number | null;
    if (next !== null) await storage.setAlarm(Math.max(next, Date.now()));
    return { delivered, failed };
  }

  return {
    async onUserChange(event, user, { storage }) {
      if (!isEnabled()) return;
      const u = plainUser(user);
      const key = `${event}:${u.id}:${crypto.randomUUID()}`;
      const args: UserSyncArgs = { event, user: u, key };
      const now = Date.now();
      storage.sql.exec(DDL);
      storage.sql.exec(
        `INSERT INTO _ember_outbox (key, fn, shard, event, args, next_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        key, fn, shardOf(u), event, JSON.stringify(args), now, now,
      );
      await storage.setAlarm(now);
    },
    wrap<C extends abstract new (...args: any[]) => object>(Auth: C): C {
      abstract class WithOutbox extends (Auth as unknown as abstract new (...args: any[]) => { ctx: DurableObjectState; env: Record<string, unknown> }) {
        async alarm() {
          await drain(this.ctx.storage, this.env);
        }
        /** Pending and parked rows (inspection, tests). */
        async outbox(): Promise<OutboxRow[]> {
          this.ctx.storage.sql.exec(DDL);
          return this.ctx.storage.sql
            .exec(`SELECT seq, key, fn, shard, event, attempts, next_at, dead, last_error FROM _ember_outbox ORDER BY seq`)
            .toArray() as unknown as OutboxRow[];
        }
      }
      Object.defineProperty(WithOutbox, "name", { value: (Auth as { name?: string }).name || "Auth" });
      return WithOutbox as unknown as C;
    },
    drain,
  };
}
