import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ServerMessage } from "../src/protocol.ts";
import { connect, hello, is, shardStub } from "./helpers.ts";

// Opt-in: RUN_LONG=1 bunx vitest run test/long.test.ts
describe.skipIf(env.RUN_LONG !== "1")("long", () => {
  it("2,000 pipelined WS mutations are group-committed", { timeout: 120_000 }, async () => {
    const shard = "chat:load";
    const c = await connect(shard);
    await hello(c);
    const N = 2000;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) c.send({ t: "mut", mid: i, fn: "messages:send", args: { channel: "l", body: `${i}` } });
    await c.waitFor(is("mres", (m) => m.mid === N - 1), 60_000);
    const ms = performance.now() - t0;
    const info = await shardStub(shard).inspect();
    console.log(`RESULT long.groupcommit ${JSON.stringify({ N, ms, batches: info.stats.batches, perSec: Math.round((N / ms) * 1000) })}`);
    expect(info.stats.batches).toBeLessThan(N / 5);
    expect(c.frames.filter((f: ServerMessage) => f.t === "mres" && !f.ok)).toEqual([]);
  });
});
