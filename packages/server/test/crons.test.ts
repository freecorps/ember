import { describe, expect, it } from "vitest";
import { cronFunctionName, cronJobs, cronList, makeFunctionReference, type CronDef } from "../src/index.ts";

describe("cronJobs()", () => {
  it("builds CronDefs with shard/tz defaults, per-cron overrides and schedule helpers", () => {
    const trim = makeFunctionReference<"mutation", { keep: number }>("messages:trim");
    const crons = cronJobs({ shard: "global:main", tz: "America/Sao_Paulo" })
      .cron("raw", "*/5 * * * *", "jobs:record", { label: "x" })
      .daily("digest", { hour: 9, minute: 30 }, trim, { keep: 10 }, { shard: "org:acme" })
      .hourly("h", { minute: 15 }, "jobs:record", { label: "h" }, { tz: "UTC" })
      .weekly("w", { dayOfWeek: 1, hour: 8 }, "jobs:record", { label: "w" })
      .monthly("m", { day: 1 }, "jobs:record", { label: "m" })
      .interval("i", { minutes: 15 }, "jobs:record", { label: "i" })
      .interval("i2", { hours: 6 }, "jobs:record", { label: "i2" });
    const list = cronList(crons);
    expect(list.map((c) => [c.name, c.schedule, c.shard, c.tz])).toEqual([
      ["raw", "*/5 * * * *", "global:main", "America/Sao_Paulo"],
      ["digest", "30 9 * * *", "org:acme", "America/Sao_Paulo"],
      ["h", "15 * * * *", "global:main", "UTC"],
      ["w", "0 8 * * 1", "global:main", "America/Sao_Paulo"],
      ["m", "0 0 1 * *", "global:main", "America/Sao_Paulo"],
      ["i", "*/15 * * * *", "global:main", "America/Sao_Paulo"],
      ["i2", "0 */6 * * *", "global:main", "America/Sao_Paulo"],
    ]);
    expect(cronFunctionName(list[1]!)).toBe("messages:trim");
    expect(list[1]!.args).toEqual({ keep: 10 });
  });

  it("rejects duplicates, missing shards and bad intervals", () => {
    expect(() => cronJobs().cron("a", "* * * * *", "x:y")).toThrow(/no shard/);
    const c = cronJobs({ shard: "global:main" }).cron("a", "* * * * *", "x:y");
    expect(() => c.cron("a", "* * * * *", "x:y")).toThrow(/twice/);
    expect(() => c.interval("b", { minutes: 7 }, "x:y")).toThrow(/divide 60/);
    expect(() => c.daily("d", { hour: 24 }, "x:y")).toThrow(/0\.\.23/);
  });

  it("cronList accepts arrays, cronJobs from another copy of the package, and nothing", () => {
    const arr: CronDef[] = [{ name: "a", schedule: "@daily", shard: "global:main", fn: "x:y" }];
    expect(cronList(arr)).toEqual(arr);
    expect(cronList({ jobs: arr })).toEqual(arr);
    expect(cronList(undefined)).toEqual([]);
    expect(() => cronList(42)).toThrow(/crons.ts/);
  });
});
