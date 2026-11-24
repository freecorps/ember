// The Worker's Cron Trigger derived from crons.ts (`cronTriggers`): the sparsest UTC expression that still ticks on every
// minute some cron matches (in its time zone, across DST) plus every heartbeat of the 60-minute catch-up window after it,
// never more than one trigger.
import { describe, expect, it } from "vitest";
import { CRON_CATCH_UP_MINUTES, CRON_HEARTBEAT_MINUTES, cronJobs, cronList, cronMatches, cronTriggers, parseCron } from "../src/index.ts";

const NOW = Date.UTC(2026, 0, 1);
const t = (crons: Array<{ schedule: string; tz?: string }>, opts: Parameters<typeof cronTriggers>[1] = {}) => cronTriggers(crons, { now: NOW, ...opts }).triggers;

describe("cronTriggers", () => {
  it("no crons: no trigger", () => {
    expect(cronTriggers([])).toEqual({ triggers: [], warnings: [] });
  });

  it("a daily cron ticks at its minute and at the heartbeats of the catch-up window after it, not every minute", () => {
    // @freecorps/ember-email's crons: daily at 04:00 UTC (04:00..04:50, ~180 invocations a month instead of 43,200).
    expect(t([{ schedule: "0 4 * * *" }])).toEqual(["*/10 4 * * *"]);
    expect(t([{ schedule: "@daily" }])).toEqual(["*/10 0 * * *"]);
    // Days are not narrowed: a weekly or monthly cron ticks daily (cronWakeDue skips the other days).
    expect(t([{ schedule: "0 9 * * MON" }])).toEqual(["*/10 9 * * *"]);
    // 03:30's window crosses the hour: heartbeats 03:40..04:20.
    expect(t([{ schedule: "30 3 1 * *" }])).toEqual(["*/10 3,4 * * *"]);
  });

  it("interval and hourly crons (cronJobs builders)", () => {
    const c = cronJobs({ shard: "global:main" });
    c.interval("five", { minutes: 5 }, "m:f");
    expect(t(cronList(c))).toEqual(["*/5 * * * *"]);
    const q = cronJobs({ shard: "global:main" });
    q.interval("quarter", { minutes: 15 }, "m:f");
    expect(t(cronList(q))).toEqual(["0,10,15,20,30,40,45,50 * * * *"]);
    const h = cronJobs({ shard: "global:main" });
    h.hourly("hourly", { minute: 0 }, "m:f").interval("six", { hours: 6 }, "m:g");
    expect(t(cronList(h))).toEqual(["*/10 * * * *"]);
    expect(t([{ schedule: "* * * * *" }])).toEqual(["* * * * *"]);
    expect(t([{ schedule: "*/2 * * * *" }])).toEqual(["*/2 * * * *"]);
  });

  it("time zones: every UTC offset of the next year, DST included", () => {
    // No DST: one offset (UTC-3).
    expect(t([{ schedule: "0 9 * * *", tz: "America/Sao_Paulo" }])).toEqual(["*/10 12 * * *"]);
    // EST and EDT.
    expect(t([{ schedule: "0 9 * * *", tz: "America/New_York" }])).toEqual(["*/10 13,14 * * *"]);
    // A half-hour offset moves the minute (03:30 UTC; its window runs to 04:20).
    expect(t([{ schedule: "0 9 * * *", tz: "Asia/Kolkata" }])).toEqual(["*/10 3,4 * * *"]);
  });

  it("the catch-up window after 23:55 crosses into the next day", () => {
    expect(t([{ schedule: "55 23 * * *" }], { maxTriggers: 2 })).toEqual(["*/10 0 * * *", "55 23 * * *"]);
    // Merged into one: the minutes of both hours on both hours.
    expect(t([{ schedule: "55 23 * * *" }])).toEqual(["0,10,20,30,40,50,55 0,23 * * *"]);
  });

  it("different minute sets merge into one trigger (Cron Triggers are counted per account); more when allowed", () => {
    const crons = [{ schedule: "0 4 * * *" }, { schedule: "5 12 * * *" }];
    expect(t(crons)).toEqual(["0,5,10,20,30,40,50 4,12,13 * * *"]);
    expect(t(crons, { maxTriggers: 3 })).toEqual(["*/10 4 * * *", "5,10,20,30,40,50 12 * * *", "0 13 * * *"]);
  });

  it("a daily cron whose 04:00 and 04:10 invocations are both lost is still caught up inside the window", () => {
    // What cronWakeDue + System do: a heartbeat tick M recovers a match u when M - u < CRON_CATCH_UP_MINUTES.
    const [trigger] = t([{ schedule: "0 4 * * *" }]).map((s) => parseCron(s));
    const day = NOW / 60_000;
    const u = day + 4 * 60;
    const missed = new Set([u, u + 10]);
    const recovers: number[] = [];
    for (let m = day; m < day + 1440; m++) {
      if (missed.has(m) || !cronMatches(trigger!, m * 60_000, "UTC")) continue;
      if (m > u && m - u < CRON_CATCH_UP_MINUTES && m % CRON_HEARTBEAT_MINUTES === 0) recovers.push(m - u);
    }
    expect(recovers).toEqual([20, 30, 40, 50]);
  });

  it("a schedule or time zone that does not parse keeps the per-minute trigger, with a warning for each", () => {
    const bad = cronTriggers([{ schedule: "61 * * * *" }, { schedule: "0 4 * * *" }, { schedule: "x" }, { schedule: "0 4 * * *", tz: "Mars/Olympus" }], { now: NOW });
    expect(bad.triggers).toEqual(["* * * * *"]);
    expect(bad.warnings).toHaveLength(3);
    expect(bad.warnings[0]).toMatch(/61 \* \* \* \*.*invalid/);
    expect(bad.warnings[1]).toMatch(/"x".*invalid/);
    expect(bad.warnings[2]).toMatch(/Mars\/Olympus.*invalid/);
    expect(cronTriggers([{ schedule: "0 4 * * *", tz: "Mars/Olympus" }], { now: NOW }).triggers).toEqual(["* * * * *"]);
  });

  it("every minute a cron matches in 2026 (and every heartbeat of its catch-up window) is a trigger minute", () => {
    const crons = [
      { schedule: "0 9 * * MON-FRI", tz: "America/New_York" },
      { schedule: "30 2 * * *", tz: "Europe/Berlin" },
      { schedule: "15 4 1 * *", tz: "Australia/Lord_Howe" },
      { schedule: "*/20 6-7 * * *" },
    ];
    const triggers = t(crons).map((s) => parseCron(s));
    expect(triggers).toHaveLength(1);
    const exprs = crons.map((c) => [parseCron(c.schedule), c.tz ?? "UTC"] as const);
    const ticks = (ms: number) => triggers.some((e) => cronMatches(e, ms, "UTC"));
    let matches = 0;
    for (let m = NOW / 60_000, end = m + 366 * 1440; m < end; m++) {
      if (!exprs.some(([e, tz]) => cronMatches(e, m * 60_000, tz))) continue;
      matches++;
      expect(ticks(m * 60_000), new Date(m * 60_000).toISOString()).toBe(true);
      for (let hb = m + 1; hb < m + CRON_CATCH_UP_MINUTES; hb++) {
        if (hb % CRON_HEARTBEAT_MINUTES === 0) expect(ticks(hb * 60_000), `heartbeat ${new Date(hb * 60_000).toISOString()}`).toBe(true);
      }
    }
    expect(matches).toBeGreaterThan(300);
  });
});
