import { DurableObject } from "cloudflare:workers";
import { getEmberConfig, resolvedCrons, type EmberEnv, type ResolvedCron } from "./config.ts";
import { cronMatches, parseCron, type CronExpr } from "./cron.ts";
import { NOT_APPLIED, NOT_SCHEDULED, type BookmarkRow, type RestoreFinishInfo } from "./restore.ts";
import type { JobInput } from "./shard.ts";
import { shardStub } from "./stubs.ts";

const MINUTE = 60_000;
/** Missed minutes (e.g. a skipped Cron Trigger) are caught up to this far back, coalesced into one run. */
const MAX_CATCH_UP_MINUTES = 60;
/** Restore journal: first completion attempt this long after prepare (the Worker normally finishes in ~1 s). */
export const RESTORE_GRACE_MS = 10_000;
const RESTORE_MAX_BACKOFF_MS = 10 * MINUTE;

export interface RestoreJournalEntry {
  shard: string;
  nonce: string;
  label: string;
  bookmark: string;
  rows: BookmarkRow[];
  instance: string;
}

export interface RestoreJournalRow {
  nonce: string;
  shard: string;
  label: string;
  bookmark: string;
  undo: string | null;
  at: number;
  attempts: number;
  next_at: number;
  last_error: string | null;
}

export interface CronState {
  name: string;
  last_minute: number;
  last_dispatch: number | null;
  last_error: string | null;
}

export interface CronTickResult {
  minute: number;
  dispatched: Array<{ name: string; shard: string; minute: number }>;
  errors: Array<{ name: string; message: string }>;
}

/**
 * Singleton DO that evaluates `crons.ts` once a minute (driven by the Worker's
 * `scheduled` handler) in each cron's time zone and dispatches due crons to their
 * shard as jobs. Dispatch carries a dedup key `cron:<name>:<minute>`, so a
 * repeated or concurrent tick never runs a cron twice for the same minute.
 */
export class System extends DurableObject<EmberEnv> {
  private readonly parsed = new Map<string, CronExpr>();
  private lock: Promise<unknown> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: EmberEnv) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS _ember_crons (name TEXT PRIMARY KEY, last_minute INTEGER NOT NULL, last_dispatch INTEGER, last_error TEXT) STRICT",
    );
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS _ember_restores (nonce TEXT PRIMARY KEY, shard TEXT NOT NULL, label TEXT NOT NULL, bookmark TEXT NOT NULL,
         undo TEXT, rows TEXT NOT NULL, instance TEXT NOT NULL, at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
         next_at INTEGER NOT NULL, last_error TEXT) STRICT`,
    );
  }

  // ------------------------------------------------------------------ restore journal (restore.ts)
  // A Shard journals a restore here before scheduling it: nothing inside the shard survives the restore, and a
  // Worker request that dies between prepare and finish would leave it applied (on the next restart) but never
  // completed (rows, undo row, new epoch). The alarm completes such entries; the Worker settles the ones it finished.

  async restoreBegin(e: RestoreJournalEntry): Promise<void> {
    const now = Date.now();
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO _ember_restores(nonce, shard, label, bookmark, undo, rows, instance, at, attempts, next_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 0, ?)",
      e.nonce, e.shard, e.label, e.bookmark, JSON.stringify(e.rows), e.instance, now, now + RESTORE_GRACE_MS,
    );
    await this.armRestores();
  }

  async restoreScheduled(nonce: string, undo: string): Promise<void> {
    this.ctx.storage.sql.exec("UPDATE _ember_restores SET undo = ? WHERE nonce = ?", undo, nonce);
  }

  async restoreSettle(nonce: string): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM _ember_restores WHERE nonce = ?", nonce);
  }

  /** Restores scheduled but not confirmed yet. */
  async restores(): Promise<RestoreJournalRow[]> {
    return this.ctx.storage.sql
      .exec<RestoreJournalRow & Record<string, SqlStorageValue>>("SELECT nonce, shard, label, bookmark, undo, at, attempts, next_at, last_error FROM _ember_restores ORDER BY at")
      .toArray();
  }

  private async armRestores(): Promise<void> {
    const next = this.ctx.storage.sql.exec<{ t: number | null }>("SELECT MIN(next_at) AS t FROM _ember_restores").toArray()[0]?.t;
    if (next === null || next === undefined) return;
    const cur = await this.ctx.storage.getAlarm();
    if (cur === null || cur > next) await this.ctx.storage.setAlarm(next);
  }

  /** Completes due journaled restores: finish; abort again while the shard has not restarted. */
  override async alarm(): Promise<void> {
    const now = Date.now();
    const due = this.ctx.storage.sql
      .exec<{ nonce: string; shard: string; label: string; bookmark: string; undo: string | null; rows: string; instance: string; attempts: number }>(
        "SELECT nonce, shard, label, bookmark, undo, rows, instance, attempts FROM _ember_restores WHERE next_at <= ?",
        now,
      )
      .toArray();
    for (const r of due) {
      const shard = shardStub(this.env, getEmberConfig().schema.manifest, r.shard);
      const info: RestoreFinishInfo = { nonce: r.nonce, instance: r.instance, rows: JSON.parse(r.rows) as BookmarkRow[], undo: r.undo, bookmark: r.bookmark, label: r.label };
      try {
        await shard.restoreFinish(r.shard, info);
        await this.restoreSettle(r.nonce);
        continue;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (NOT_SCHEDULED.test(msg)) {
          await this.restoreSettle(r.nonce);
          continue;
        }
        if (NOT_APPLIED.test(msg)) await shard.restoreAbort().catch(() => undefined);
        const backoff = Math.min(RESTORE_GRACE_MS * 2 ** r.attempts, RESTORE_MAX_BACKOFF_MS);
        this.ctx.storage.sql.exec("UPDATE _ember_restores SET attempts = attempts + 1, next_at = ?, last_error = ? WHERE nonce = ?", Date.now() + backoff, msg.slice(0, 500), r.nonce);
      }
    }
    await this.armRestores();
  }

  private expr(c: ResolvedCron): CronExpr {
    let e = this.parsed.get(c.schedule);
    if (!e) this.parsed.set(c.schedule, (e = parseCron(c.schedule)));
    return e;
  }

  async tick(scheduledTime: number = Date.now()): Promise<CronTickResult> {
    const run = this.lock.then(() => this.doTick(scheduledTime));
    this.lock = run.catch(() => {});
    return run;
  }

  private async doTick(scheduledTime: number): Promise<CronTickResult> {
    const crons = resolvedCrons(getEmberConfig());
    const minute = Math.floor(scheduledTime / MINUTE);
    const result: CronTickResult = { minute, dispatched: [], errors: [] };
    const sql = this.ctx.storage.sql;
    for (const c of crons) {
      const row = sql.exec<{ last_minute: number }>("SELECT last_minute FROM _ember_crons WHERE name = ?", c.name).toArray()[0];
      // A new cron starts now: no backfill.
      const last = row ? row.last_minute : minute - 1;
      if (last >= minute) continue;
      let due: number | null = null;
      try {
        const e = this.expr(c);
        for (let m = Math.max(last + 1, minute - MAX_CATCH_UP_MINUTES + 1); m <= minute; m++) {
          if (cronMatches(e, m * MINUTE, c.tz ?? "UTC")) due = m;
        }
        if (due !== null) {
          const shard = shardStub(this.env, getEmberConfig().schema.manifest, c.shard);
          const job: JobInput = {
            fn: c.fn,
            args: c.args ?? {},
            kind: c.kind,
            runAt: due * MINUTE,
            dedupKey: `cron:${c.name}:${due}`,
          };
          await shard.enqueueJob(c.shard, job);
          result.dispatched.push({ name: c.name, shard: c.shard, minute: due });
        }
        sql.exec(
          `INSERT INTO _ember_crons(name, last_minute, last_dispatch, last_error) VALUES (?, ?, ?, NULL)
           ON CONFLICT(name) DO UPDATE SET last_minute = excluded.last_minute,
             last_dispatch = COALESCE(excluded.last_dispatch, last_dispatch), last_error = NULL`,
          c.name, minute, due,
        );
      } catch (err) {
        // last_minute is not advanced: the next tick retries (dedup key keeps it exactly-once per minute).
        const message = err instanceof Error ? err.message : String(err);
        result.errors.push({ name: c.name, message });
        sql.exec(
          `INSERT INTO _ember_crons(name, last_minute, last_error) VALUES (?, ?, ?)
           ON CONFLICT(name) DO UPDATE SET last_error = excluded.last_error`,
          c.name, last, message,
        );
      }
    }
    return result;
  }

  async state(): Promise<CronState[]> {
    return this.ctx.storage.sql.exec<CronState & Record<string, SqlStorageValue>>("SELECT * FROM _ember_crons ORDER BY name").toArray();
  }
}
