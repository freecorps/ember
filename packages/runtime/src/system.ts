import { DurableObject } from "cloudflare:workers";
import { getEmberConfig, resolvedCrons, type EmberEnv, type ResolvedCron } from "./config.ts";
import { cronMatches, parseCron, type CronExpr } from "./cron.ts";
import { NOT_APPLIED, NOT_SCHEDULED, type BookmarkRow, type RestoreFinishInfo } from "./restore.ts";
import type { JobInput } from "./shard.ts";
import { shardStub } from "./stubs.ts";

const MINUTE = 60_000;
/** Missed minutes (e.g. a skipped Cron Trigger) are caught up to this far back, coalesced into one run. */
const MAX_CATCH_UP_MINUTES = 60;
/** A cron that failed to dispatch is retried by the System's own alarm this often, while its minute can still be caught up. */
const CRON_RETRY_MS = MINUTE;
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
 * Singleton DO that evaluates `crons.ts` (driven by the Worker's `scheduled` handler,
 * which wakes it only on a minute some cron matches, plus a catch-up heartbeat) in each
 * cron's time zone and dispatches due crons to their shard as jobs. A failed dispatch is
 * retried by this DO's own alarm. Dispatch carries a dedup key `cron:<name>:<minute>`, so a
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
    // The minute every cron without an error has been evaluated through (one row): an idle minute writes only this,
    // not a row per cron. A cron's own row moves when it is first seen, dispatches, or fails.
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS _ember_cron_tick (k INTEGER PRIMARY KEY CHECK (k = 0), minute INTEGER NOT NULL) STRICT");
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
    await this.arm();
  }

  async restoreScheduled(nonce: string, undo: string): Promise<void> {
    this.ctx.storage.sql.exec("UPDATE _ember_restores SET undo = ? WHERE nonce = ?", undo, nonce);
  }

  async restoreSettle(nonce: string): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM _ember_restores WHERE nonce = ?", nonce);
    // Nothing left to complete (and no cron to retry): no alarm should fire for it.
    await this.arm();
  }

  /** Restores scheduled but not confirmed yet. */
  async restores(): Promise<RestoreJournalRow[]> {
    return this.ctx.storage.sql
      .exec<RestoreJournalRow & Record<string, SqlStorageValue>>("SELECT nonce, shard, label, bookmark, undo, at, attempts, next_at, last_error FROM _ember_restores ORDER BY at")
      .toArray();
  }

  /**
   * The alarm serves the restore journal (its earliest `next_at`) and the retry of crons that failed to dispatch (one
   * minute out, like the per-minute tick that used to retry them). Nothing pending: no alarm.
   */
  private async arm(): Promise<void> {
    const restore = this.ctx.storage.sql.exec<{ t: number | null }>("SELECT MIN(next_at) AS t FROM _ember_restores").toArray()[0]?.t ?? null;
    const retry = this.cronRetryPending() ? Date.now() + CRON_RETRY_MS : null;
    const next = restore === null ? retry : retry === null ? restore : Math.min(restore, retry);
    const cur = await this.ctx.storage.getAlarm();
    if (next === null) {
      if (cur !== null) await this.ctx.storage.deleteAlarm();
      return;
    }
    if (cur === null || cur > next) await this.ctx.storage.setAlarm(next);
  }

  /**
   * A cron of the current config failed to dispatch and its missed minute is still inside the catch-up window. Older
   * than that, nothing is left to catch up: the cron's next matching minute wakes `System` through the Worker anyway.
   */
  private cronRetryPending(now = Date.now()): boolean {
    const failed = this.ctx.storage.sql
      .exec<{ name: string }>("SELECT name FROM _ember_crons WHERE last_error IS NOT NULL AND last_minute >= ?", Math.floor(now / MINUTE) - MAX_CATCH_UP_MINUTES)
      .toArray();
    if (!failed.length) return false;
    const names = new Set(resolvedCrons(getEmberConfig()).map((c) => c.name));
    return failed.some((r) => names.has(r.name));
  }

  /** Completes due journaled restores (finish; abort again while the shard has not restarted) and retries failed crons. */
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
        // Never applied: retrying cannot help. (`restore_still_ahead` is not settled: the restore applied onto runtime
        // tables of a newer runtime, and only that runtime can finish it; the entry keeps the rows and the undo bookmark,
        // shown by `GET /api/_ember/status`, and is retried with the backoff below.)
        if (NOT_SCHEDULED.test(msg)) {
          await this.restoreSettle(r.nonce);
          continue;
        }
        if (NOT_APPLIED.test(msg)) await shard.restoreAbort().catch(() => undefined);
        const backoff = Math.min(RESTORE_GRACE_MS * 2 ** r.attempts, RESTORE_MAX_BACKOFF_MS);
        this.ctx.storage.sql.exec("UPDATE _ember_restores SET attempts = attempts + 1, next_at = ?, last_error = ? WHERE nonce = ?", Date.now() + backoff, msg.slice(0, 500), r.nonce);
      }
    }
    // A cron that failed to dispatch: the tick that used to come every minute retried it; now this alarm does.
    if (this.cronRetryPending(now)) await this.tick(now).catch(() => undefined);
    await this.arm();
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
    const mark = this.tickMark();
    // A late tick for a minute the mark has passed: every cron without an error was evaluated through it already, and
    // one with an error must keep its retry minute (clearing the error here would move it past the failed minute).
    if (minute < mark) return result;
    const rows = new Map(
      sql.exec<{ name: string; last_minute: number; last_error: string | null }>("SELECT name, last_minute, last_error FROM _ember_crons").toArray().map((r) => [r.name, r] as const),
    );
    type Outcome = { name: string; first: boolean; due: number | null; last: number; error?: string };
    const work: Array<Promise<Outcome>> = [];
    for (const c of crons) {
      const row = rows.get(c.name);
      // A new cron starts now: no backfill. A cron that failed keeps its own minute (retried from there).
      const last = !row ? minute - 1 : row.last_error === null ? Math.max(row.last_minute, mark) : row.last_minute;
      if (last >= minute) continue;
      work.push(
        (async (): Promise<Outcome> => {
          let due: number | null = null;
          try {
            const e = this.expr(c);
            for (let m = Math.max(last + 1, minute - MAX_CATCH_UP_MINUTES + 1); m <= minute; m++) {
              if (cronMatches(e, m * MINUTE, c.tz ?? "UTC")) due = m;
            }
            if (due !== null) {
              const shard = shardStub(this.env, getEmberConfig().schema.manifest, c.shard);
              const job: JobInput = { fn: c.fn, args: c.args ?? {}, kind: c.kind, runAt: due * MINUTE, dedupKey: `cron:${c.name}:${due}` };
              await shard.enqueueJob(c.shard, job);
            }
            return { name: c.name, first: !row || row.last_error !== null, due, last };
          } catch (err) {
            return { name: c.name, first: false, due: null, last, error: err instanceof Error ? err.message : String(err) };
          }
        })(),
      );
    }
    // The crons due this minute are dispatched together (each to its own shard).
    const outcomes = (await Promise.allSettled(work)).map((o) => (o.status === "fulfilled" ? o.value : null)).filter((o): o is Outcome => o !== null);
    const byName = new Map(crons.map((c) => [c.name, c]));
    this.ctx.storage.transactionSync(() => {
      for (const o of outcomes) {
        if (o.error !== undefined) {
          // last_minute is not advanced: the next tick retries (dedup key keeps it exactly-once per minute).
          result.errors.push({ name: o.name, message: o.error });
          sql.exec(
            `INSERT INTO _ember_crons(name, last_minute, last_error) VALUES (?, ?, ?)
             ON CONFLICT(name) DO UPDATE SET last_minute = excluded.last_minute, last_error = excluded.last_error`,
            o.name, o.last, o.error,
          );
          continue;
        }
        if (o.due !== null) result.dispatched.push({ name: o.name, shard: byName.get(o.name)!.shard, minute: o.due });
        // Only a first sighting, a dispatch or the end of an error writes the cron's row; the tick mark covers the rest.
        if (o.due === null && !o.first) continue;
        sql.exec(
          `INSERT INTO _ember_crons(name, last_minute, last_dispatch, last_error) VALUES (?, ?, ?, NULL)
           ON CONFLICT(name) DO UPDATE SET last_minute = excluded.last_minute,
             last_dispatch = COALESCE(excluded.last_dispatch, last_dispatch), last_error = NULL`,
          o.name, minute, o.due,
        );
      }
      if (mark < minute && crons.length) sql.exec("INSERT INTO _ember_cron_tick(k, minute) VALUES (0, ?) ON CONFLICT(k) DO UPDATE SET minute = MAX(minute, excluded.minute)", minute);
    });
    // A failure is retried by the alarm (the Worker no longer wakes this DO every minute). A row an older runtime left
    // with an error is retried by this tick and, failing again, arms it the same way.
    if (result.errors.length) await this.arm();
    return result;
  }

  /** The minute the last tick evaluated every cron through (-Infinity before the first). */
  private tickMark(): number {
    const m = this.ctx.storage.sql.exec<{ minute: number }>("SELECT minute FROM _ember_cron_tick WHERE k = 0").toArray()[0]?.minute;
    return m === undefined ? -Infinity : m;
  }

  async state(): Promise<CronState[]> {
    // A cron without an error has been evaluated through the tick mark (its row only moves when it dispatches).
    const mark = this.tickMark();
    return this.ctx.storage.sql
      .exec<CronState & Record<string, SqlStorageValue>>("SELECT name, last_minute, last_dispatch, last_error FROM _ember_crons ORDER BY name")
      .toArray()
      .map((r) => (r.last_error === null && mark > r.last_minute ? { ...r, last_minute: mark } : r));
  }
}
