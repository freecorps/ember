/**
 * The flags component in workerd with real shards: a flag written in global:main reaches an org shard by replication,
 * and the org shard evaluates it from its own copy. To show evaluation makes no cross-shard call, the test then
 * changes global:main's row behind the replication log's back: the org shard keeps serving what it was sent.
 */
import { env, runDurableObjectAlarm, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

type Target = { target: string; pending: number; snapshot: number; dead: number };
type Status = { targets: Target[] };
const stub = (shard: string) => env.SHARD.get(env.SHARD.idFromName(shard));
const global = () => stub("global:main") as unknown as { replicaStatus(shard?: string): Promise<Status> };

const call = async (kind: "query" | "mutation", fn: string, args: unknown, shard = "global:main") => {
  const res = await SELF.fetch(`http://ember/api/${kind}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fn, args, shard }) });
  const body = (await res.json()) as { ok: boolean; value?: any; error?: unknown };
  if (!body.ok) throw new Error(`${kind} ${fn}: ${JSON.stringify(body)}`);
  return body.value;
};

/** Runs global:main's alarm until `shard` is a target with nothing left to deliver. */
async function settle(shard: string) {
  for (let i = 0; i < 300; i++) {
    await runDurableObjectAlarm(stub("global:main"));
    const s = await global().replicaStatus();
    const t = s.targets.find((x) => x.target === shard);
    if (t && t.pending === 0 && t.snapshot === 0 && t.dead === 0) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`replication did not settle: ${JSON.stringify(await global().replicaStatus())}`);
}

describe("flags in workerd", () => {
  it("a flag changed in global:main is evaluated in an org shard after replication, from the shard's own copy", async () => {
    const org = `org:${crypto.randomUUID().slice(0, 8)}`;
    // The org shard's first request registers it in global:main's catalog.
    expect(await call("query", "shop:detail", { context: { unitId: "u1" } }, org)).toEqual({ value: false, reason: "missing" });
    await settle(org);

    expect(await call("mutation", "admin:set", { flag: { key: "newCheckout", type: "boolean", defaultValue: false, rules: [{ conditions: [{ attr: "plan", op: "eq", value: "free" }], value: false }] } })).toBe(1);
    await settle(org);
    expect(await call("query", "shop:detail", { context: { unitId: "u1" } }, org)).toEqual({ value: true, reason: "on", version: 1 });
    expect(await call("query", "shop:detail", { context: { unitId: "u1", plan: "free" } }, org)).toEqual({ value: false, reason: "rule", rule: 0, version: 1 });
    await call("mutation", "shop:visit", { unitId: "u1" }, org);

    // The kill switch, flipped in global:main, reaches the org shard's mutations.
    expect(await call("mutation", "admin:toggle", { key: "newCheckout", on: false })).toBe(2);
    await settle(org);
    expect(await call("query", "shop:detail", { context: { unitId: "u1" } }, org)).toEqual({ value: false, reason: "disabled", version: 2 });
    await call("mutation", "shop:visit", { unitId: "u1" }, org);
    expect(await call("query", "shop:flows", {}, org)).toEqual(["new", "old"]);

    // global:main's row changes without going through the log (no replication): the org shard still answers from its
    // copy, so an evaluation never asks global:main.
    await runInDurableObject(stub("global:main"), (_i, state) => {
      state.storage.sql.exec(`UPDATE "flags$flags" SET "enabled" = 1`);
    });
    expect(await call("query", "shop:detail", { context: { unitId: "u1" } }, "global:main")).toMatchObject({ value: true });
    for (let i = 0; i < 5; i++) expect(await call("query", "shop:detail", { context: { unitId: `u${i}` } }, org)).toMatchObject({ value: false, reason: "disabled" });

    // Off global:main the admin write is refused.
    await expect(call("mutation", "admin:toggle", { key: "newCheckout", on: true }, org)).rejects.toThrow(/ReadOnlyTable/);
  });
});
