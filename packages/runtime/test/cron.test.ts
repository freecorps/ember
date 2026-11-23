import { describe, expect, it } from "vitest";
import { CronParseError, cronMatches, cronWakeDue, nextCronMatch, parseCron, wallClock } from "../src/cron.ts";

const at = (iso: string) => Date.parse(iso);

describe("cron parser", () => {
  it("parses fields, lists, ranges, steps, names and macros", () => {
    const e = parseCron("*/15 9-17 * JAN,mar MON-FRI");
    expect([...e.minute]).toEqual([0, 15, 30, 45]);
    expect([...e.hour]).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect([...e.month]).toEqual([1, 3]);
    expect([...e.dow]).toEqual([1, 2, 3, 4, 5]);
    expect([...parseCron("5/20 * * * 7").minute]).toEqual([5, 25, 45]);
    expect([...parseCron("0 0 * * 7").dow]).toEqual([0]);
    expect(parseCron("@hourly").minute).toEqual(new Set([0]));
    for (const bad of ["* * * *", "60 * * * *", "* * 0 * *", "*/0 * * * *", "1-a * * * *", "5-1 * * * *", "* * * * * *", "1,,2 * * * *"]) {
      expect(() => parseCron(bad), bad).toThrow(CronParseError);
    }
  });

  it("matches in UTC with Vixie day-of-month/day-of-week OR semantics", () => {
    const e = parseCron("0 12 13 * FRI");
    expect(cronMatches(e, at("2026-11-13T12:00:00Z"))).toBe(true); // Friday the 13th
    expect(cronMatches(e, at("2026-11-06T12:00:00Z"))).toBe(true); // a Friday
    expect(cronMatches(e, at("2026-12-13T12:00:00Z"))).toBe(true); // the 13th (Sunday)
    expect(cronMatches(e, at("2026-11-07T12:00:00Z"))).toBe(false);
    expect(cronMatches(e, at("2026-11-06T12:01:00Z"))).toBe(false);
  });

  it("evaluates in America/Sao_Paulo (UTC-3, no DST)", () => {
    const e = parseCron("0 9 * * MON-FRI");
    const tz = "America/Sao_Paulo";
    expect(wallClock(at("2026-11-05T12:00:00Z"), tz)).toMatchObject({ hour: 9, minute: 0, day: 5, month: 11, weekday: 4 });
    expect(cronMatches(e, at("2026-11-05T12:00:00Z"), tz)).toBe(true);
    expect(cronMatches(e, at("2026-11-05T09:00:00Z"), tz)).toBe(false);
    // 23:30 Saturday in São Paulo is already Sunday in UTC
    expect(cronMatches(parseCron("30 23 * * SAT"), at("2026-11-08T02:30:00Z"), tz)).toBe(true);
    expect(nextCronMatch(e, at("2026-11-06T12:00:00Z"), tz)).toBe(at("2026-11-09T12:00:00Z")); // Fri -> Mon
    expect(() => wallClock(0, "Nope/Zone")).toThrow(RangeError);
  });
});

describe("cronWakeDue (the Worker wakes System only when needed)", () => {
  const min = (iso: string) => Date.parse(iso);
  it("wakes on a matching minute (in the cron's time zone) and not on others", () => {
    const daily = [{ schedule: "0 9 * * *", tz: "America/Sao_Paulo" }];
    expect(cronWakeDue(daily, min("2026-03-02T12:00:00Z"), 10)).toBe(true); // 09:00 in SP
    expect(cronWakeDue(daily, min("2026-03-02T09:00:00Z"), 10)).toBe(false); // 06:00 in SP
    expect(cronWakeDue(daily, min("2026-03-02T12:01:30Z"), 10)).toBe(false);
    // 60 minutes of an every-15 cron: its 4 minutes plus the heartbeats right after each (:10 :20 :40 :50).
    const q = [{ schedule: "*/15 * * * *" }];
    let wakes = 0;
    for (let m = 0; m < 60; m++) if (cronWakeDue(q, min("2026-03-02T10:00:00Z") + m * 60_000, 10)) wakes++;
    expect(wakes).toBe(8);
  });
  it("a heartbeat minute wakes only after a match since the previous heartbeat", () => {
    const daily = [{ schedule: "3 9 * * *" }];
    expect(cronWakeDue(daily, min("2026-03-02T09:10:00Z"), 10)).toBe(true); // 09:03 matched since 09:00
    expect(cronWakeDue(daily, min("2026-03-02T09:20:00Z"), 10)).toBe(false);
    expect(cronWakeDue(daily, min("2026-03-02T09:00:00Z"), 10)).toBe(false);
    // An invalid schedule: heartbeats only, so System records the error without a wake every minute.
    expect(cronWakeDue([{ schedule: "nope" }], min("2026-03-02T09:20:00Z"), 10)).toBe(true);
    expect(cronWakeDue([{ schedule: "nope" }], min("2026-03-02T09:21:00Z"), 10)).toBe(false);
  });
});
