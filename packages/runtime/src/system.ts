import { DurableObject } from "cloudflare:workers";
import { getEmberConfig, resolvedCrons, type EmberEnv, type ResolvedCron } from "./config.ts";
import { cronMatches, parseCron, type CronExpr } from "./cron.ts";
import type { JobInput } from "./shard.ts";
import { shardStub } from "./stubs.ts";

const MINUTE = 60_000;
/** Missed minutes (e.g. a skipped Cron Trigger) are caught up to this far back, coalesced into one run. */
const MAX_CATCH_UP_MINUTES = 60;

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
