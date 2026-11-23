import { createExecutionContext, createScheduledController, env, runDurableObjectAlarm, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { setEmberConfig, type CronDef, type EmberConfig } from "../src/config.ts";
import { api, shardStub } from "./helpers.ts";
import worker, { config } from "./worker.ts";

const DAY = 86_400_000;

describe("System crons", () => {
  it("evaluates crons in America/Sao_Paulo, dispatches once per minute, and the shard runs them", async () => {
    const system = env.SYSTEM.get(env.SYSTEM.idFromName("system"));
    // A day in the past so dispatched jobs are due immediately.
    const day = Math.floor(Date.now() / DAY) * DAY - 3 * DAY;
    const t0900Z = day + 9 * 3_600_000;
    const t1200Z = day + 12 * 3_600_000; // 09:00 in São Paulo

    const first = await system.tick(t0900Z);
    expect(first.dispatched.map((d) => d.name)).toEqual(["every-5"]); // 06:00 in SP: morning not due

    const second = await system.tick(t1200Z);
    expect(second.dispatched.map((d) => d.name).sort()).toEqual(["every-5", "morning"]);
    expect(second.dispatched.every((d) => d.minute === t1200Z / 60_000)).toBe(true);

    expect((await system.tick(t1200Z)).dispatched).toEqual([]); // same minute again: no-op
    expect((await system.tick(t1200Z + 60_000)).dispatched).toEqual([]); // 12:01: nothing matches

    const shard = shardStub("org:crons");
    await runDurableObjectAlarm(shard);
    const runs = await api("query", { fn: "runs:list", args: {}, shard: "org:crons" });
    expect(runs.body.value.map((r: { label: string }) => r.label).sort()).toEqual(["every-5", "every-5", "morning"]);

    // The Worker's scheduled handler drives the same tick.
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ scheduledTime: new Date(t1200Z + 5 * 60_000), cron: "* * * * *" }), env as never, ctx);
    await waitOnExecutionContext(ctx);
    const state = await system.state();
    expect(state.find((s) => s.name === "every-5")).toMatchObject({ last_dispatch: t1200Z / 60_000 + 5, last_error: null });

    // Idle minutes (nothing due) write the tick mark only, not a row per cron; the state still shows them evaluated.
    const rows = () => runInDurableObject(system, (_i, st) => st.storage.sql.exec("SELECT name, last_minute, last_dispatch FROM _ember_crons ORDER BY name").toArray());
    const before = await rows();
    const idle = t1200Z + 6 * 60_000;
    expect((await system.tick(idle)).dispatched).toEqual([]);
    expect(await rows()).toEqual(before);
    expect((await system.state()).every((c) => c.last_minute === idle / 60_000)).toBe(true);
    // And the next due minute dispatches as before (once).
    expect((await system.tick(t1200Z + 10 * 60_000)).dispatched.map((d) => d.name)).toEqual(["every-5"]);
    expect((await system.tick(t1200Z + 10 * 60_000)).dispatched).toEqual([]);
  });

  it("the Worker wakes System only on minutes a cron matches (60 idle-ish minutes: 12 wakes, not 60)", async () => {
    let gets = 0;
    const counted = { ...env, SYSTEM: { idFromName: (n: string) => env.SYSTEM.idFromName(n), get: (id: DurableObjectId) => (gets++, env.SYSTEM.get(id)) } };
    // Two hours into a day well in the past (nothing of this test's minutes was ticked before).
    const base = Math.floor(Date.now() / DAY) * DAY - 5 * DAY + 2 * 3_600_000;
    for (let m = 0; m < 60; m++) {
      const ctx = createExecutionContext();
      await worker.scheduled(createScheduledController({ scheduledTime: new Date(base + m * 60_000), cron: "* * * * *" }), counted as never, ctx);
      await waitOnExecutionContext(ctx);
    }
    // every-5 matches 12 minutes of the hour; morning (09:00 in São Paulo) none of them; heartbeats fall on :x0.
    expect(gets).toBe(12);
  });

  it("a cron that fails to dispatch is retried by System's own alarm, without a Worker tick", async () => {
    const system = env.SYSTEM.get(env.SYSTEM.idFromName("system"));
    const flaky = (args: Record<string, unknown>): EmberConfig => ({ ...config, crons: [{ name: "flaky", schedule: "* * * * *", shard: "org:retry", fn: "jobs:record", args } as CronDef] });
    const minute = Math.floor(Date.now() / 60_000);
    try {
      setEmberConfig(flaky({ label: Symbol("not serializable") })); // the RPC to the shard throws
      const r = await system.tick(minute * 60_000);
      expect(r.errors.map((e) => e.name)).toEqual(["flaky"]);
      const alarm = await runInDurableObject(system, (_i, st) => st.storage.getAlarm());
      expect(alarm).not.toBeNull();
      // Fixed (e.g. the shard came back): the alarm alone dispatches the failed minute.
      setEmberConfig(flaky({ label: "flaky" }));
      expect(await runDurableObjectAlarm(system)).toBe(true);
      const state = await system.state();
      expect(state.find((s) => s.name === "flaky")).toMatchObject({ last_error: null });
      expect(state.find((s) => s.name === "flaky")!.last_dispatch).toBeGreaterThanOrEqual(minute);
      // Nothing left to retry: no alarm stays armed.
      expect(await runInDurableObject(system, (_i, st) => st.storage.getAlarm())).toBeNull();
    } finally {
      setEmberConfig(config);
    }
  });
});
