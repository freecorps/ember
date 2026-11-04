import { createExecutionContext, createScheduledController, env, runDurableObjectAlarm, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { api, shardStub } from "./helpers.ts";
import worker from "./worker.ts";

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
  });
});
