// The parser, matcher and Cron Trigger derivation live in @freecorps/ember-server (cron-expr.ts: pure, the CLI's deploy
// derives the Worker's Cron Triggers with them); the Worker's wake decision stays here.
import { assertTimeZone, CRON_CATCH_UP_MINUTES, cronMatches, parseCron, type CronExpr } from "@freecorps/ember-server";

export {
  assertTimeZone,
  CRON_CATCH_UP_MINUTES,
  CRON_HEARTBEAT_MINUTES,
  CronParseError,
  cronMatches,
  nextCronMatch,
  parseCron,
  wallClock,
  type CronExpr,
  type WallClock,
} from "@freecorps/ember-server";

/** Parsed schedules by `tz \0 schedule`; null: the schedule or its time zone is unusable. */
const wakeExprs = new Map<string, CronExpr | null>();

/**
 * Whether the minute of `scheduledTime` needs the `System` DO (the Worker's `scheduled()` runs on every minute of its
 * Cron Trigger, which `ember deploy` derives with `cronTriggers` and may be wider than the crons need; waking a DO for a
 * minute no cron matches costs a request and a duration for nothing). True when some cron matches this minute
 * (in its time zone), or on a heartbeat minute (`minute % heartbeatMinutes === 0`) when some cron matched in the
 * `catchUpMinutes` before it: a Cron Trigger that never came (one minute or an outage of several, heartbeats included)
 * is then caught up by `System`, whose catch-up window is the same. A schedule or time zone that does not parse wakes it
 * on heartbeats only (it never throws out of here), so `System` records the error and the other crons are still looked at.
 */
export function cronWakeDue(
  crons: ReadonlyArray<{ schedule: string; tz?: string }>,
  scheduledTime: number,
  heartbeatMinutes: number,
  catchUpMinutes = CRON_CATCH_UP_MINUTES,
): boolean {
  const minute = Math.floor(scheduledTime / 60_000);
  const heartbeat = minute % heartbeatMinutes === 0;
  const exprs: Array<[CronExpr, string]> = [];
  for (const c of crons) {
    const tz = c.tz ?? "UTC";
    const key = `${tz}\u0000${c.schedule}`;
    let e = wakeExprs.get(key);
    if (e === undefined) {
      try {
        assertTimeZone(tz);
        e = parseCron(c.schedule);
      } catch {
        e = null;
      }
      wakeExprs.set(key, e);
    }
    if (e === null) {
      if (heartbeat) return true;
      continue;
    }
    if (cronMatches(e, minute * 60_000, tz)) return true;
    exprs.push([e, tz]);
  }
  if (!heartbeat) return false;
  // The minutes `System` would catch up from this tick (this one was looked at above).
  for (let m = minute - catchUpMinutes + 1; m < minute; m++) {
    for (const [e, tz] of exprs) if (cronMatches(e, m * 60_000, tz)) return true;
  }
  return false;
}
