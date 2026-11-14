// `ember dev` feedback (EMBER_DEV_PERF=1): a line per commit that re-ran queries (cost, sharing, the change that hit
// each read set) and advice once per function (.filter() scans, unbounded .collect(), ctx.db.sql, ctx.auth reads).
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connect, hello, is, shardStub } from "./helpers.ts";

afterEach(() => vi.restoreAllMocks());

describe("ember dev perf feedback", () => {
  it("summarizes the re-runs of a commit and advises once per function", async () => {
    const shard = "perf:dev";
    const stub = shardStub(shard);
    await runInDurableObject(stub, (instance) => {
      (instance as unknown as { env: Record<string, unknown> }).env.EMBER_DEV_PERF = "1";
    });
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...xs: unknown[]) => void logs.push(xs.join(" ")));
    vi.spyOn(console, "warn").mockImplementation((...xs: unknown[]) => void logs.push(xs.join(" ")));
    const a = await connect(shard);
    await hello(a, "a", "good:amy");
    a.send({ t: "sub", qid: 1, fn: "shared:list", args: { room: "r" } });
    a.send({ t: "sub", qid: 2, fn: "shared:inline", args: { room: "r" } });
    await a.waitFor(is("snap", (m) => m.qid === 1));
    a.send({ t: "mut", mid: "m1", fn: "shared:put", args: { room: "r", body: "x" } });
    await a.waitFor(is("mres"));
    a.send({ t: "mut", mid: "m2", fn: "shared:put", args: { room: "r", body: "y" } });
    await a.waitFor(is("mres", (m) => m.mid === "m2"));
    const summary = logs.filter((l) => l.startsWith("ember perf: v"));
    expect(summary.length).toBeGreaterThanOrEqual(1);
    expect(summary[0]).toMatch(/re-ran 1 query/);
    expect(summary[0]).toMatch(/shared:list\(\{"room":"r"\}\) shared by 1 read \d+\/returned 1 <- insert notes notes_\w+ \(by_room\)/);
    const advice = logs.filter((l) => l.includes("reads ctx.auth"));
    expect(advice).toHaveLength(1); // once, though it ran several times
    expect(advice[0]).toMatch(/^ember perf: shared:inline: .*authorize/);
    a.close();
  });
});
