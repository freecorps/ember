// `.replicated()` tables and `ctx.shards` (PLAN §22 L5) on workerd with real shards: `fxRates` is written in global:main
// and copied to every org shard (ember/rates.ts). Each org shard registers in global:main's catalog when it first
// serves a request, gets a full copy, then deltas in order; a live query in an org shard gets the patches.
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { selfFetch, testClient } from "@freecorps/ember-example-testing";
import { describe, expect, it } from "vitest";
import { api } from "../ember/_generated/api";

type Target = { target: string; pending: number; snapshot: number; dead: number; last_seq: number };
type Status = { enabled: boolean; seq: number; targets: Target[]; next: number | null };
const global = () => env.SHARD.get(env.SHARD.idFromName("global:main")) as unknown as { replicaStatus(shard?: string): Promise<Status>; replicaResync(shard: string | null): Promise<{ ok: boolean; targets?: number }> };
const orgShard = (org: string) => env.SHARD.get(env.SHARD.idFromName(`org:${org}`));
const BASE = "http://localhost:8787";

/** Runs global:main's alarm until every org in `orgs` is a target and nothing is left to deliver. */
async function settle(orgs: string[]): Promise<Status> {
  for (let i = 0; i < 300; i++) {
    await runDurableObjectAlarm(global() as never);
    const s = await global().replicaStatus();
    const known = new Set(s.targets.map((t) => t.target));
    if (orgs.every((o) => known.has(`org:${o}`)) && s.targets.every((t) => t.pending === 0 && t.snapshot === 0 && t.dead === 0)) return s;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`replicated tables did not settle: ${JSON.stringify(await global().replicaStatus())}`);
}

let n = 0;
const uid = () => `r${Date.now().toString(36)}${n++}`;
const rateIn = (client: ReturnType<typeof testClient>, org: string, base = "USD", quote = "BRL") => client.query(api.rates.rate, { base, quote }, { shard: `org:${org}` });

describe(".replicated() tables", () => {
  it("a write in global:main reaches a live query in an org shard; the copy keeps the id; writes off-source are refused", async () => {
    const client = testClient();
    const org = uid();
    // First request to the org shard: it registers in the catalog and asks for a copy (empty here, so `pending`/`ready`).
    const first = await rateIn(client, org, "AAA", "BBB");
    expect(first.rate).toBeNull();
    await settle([org]);
    expect((await rateIn(client, org, "AAA", "BBB")).status.state).toBe("ready");

    const seen: Array<{ status: string; value: any }> = [];
    const stop = client.subscribe(api.rates.rate, { base: "USD", quote: "BRL" }, { shard: `org:${org}` }, (s) => seen.push(s));
    await expect.poll(() => seen.at(-1)?.status).toBe("success");

    const id = await client.mutation(api.rates.setRate, { base: "USD", quote: "BRL", rate: 5.1 });
    await settle([org]);
    await expect.poll(() => seen.at(-1)?.value?.rate?.rate).toBe(5.1);
    // Same `_id` as in global:main: a tenant row can hold it and `ctx.db.get` resolves it in the org shard.
    expect(seen.at(-1)!.value.rate._id).toBe(id);
    expect(seen.at(-1)!.value.status).toMatchObject({ state: "ready", seq: expect.any(Number), updatedAt: expect.any(Number) });
    const quote = await client.mutation(api.rates.convert, { org, rateId: id, amount: 10 });
    const stored = await runInDurableObject(orgShard(org), (_i, state) => state.storage.sql.exec(`SELECT "rateId", "converted" FROM "quotes" WHERE "_id" = ?`, quote).toArray());
    expect(stored).toEqual([{ rateId: id, converted: 51 }]);

    // Order: several updates in a row land as the last one.
    for (const r of [5.2, 5.3, 5.4]) await client.mutation(api.rates.setRate, { base: "USD", quote: "BRL", rate: r });
    await settle([org]);
    await expect.poll(() => seen.at(-1)?.value?.rate?.rate).toBe(5.4);
    const values = seen.map((s) => s.value?.rate?.rate).filter((x) => typeof x === "number");
    expect(values).toEqual([...values].sort((a, b) => a - b));

    await expect(client.mutation(api.rates.setRateHere, {}, { shard: `org:${org}` })).rejects.toMatchObject({ code: "ReadOnlyTable", message: expect.stringContaining("global:main") });
    stop();
    client.close();
  });

  it("a new shard bootstraps from a snapshot; a target that lost its copy is resynced (gap, admin endpoint)", async () => {
    const client = testClient();
    const id = await client.mutation(api.rates.setRate, { base: "EUR", quote: "BRL", rate: 6 });
    const org = uid();
    await rateIn(client, org, "EUR", "BRL");
    await settle([org]);
    expect((await rateIn(client, org, "EUR", "BRL")).rate).toMatchObject({ _id: id, rate: 6 });

    // The target loses its copy and its mark (what a restore to an older bookmark looks like from the source).
    await runInDurableObject(orgShard(org), (_i, state) => {
      state.storage.sql.exec(`DELETE FROM "fxRates"`);
      state.storage.sql.exec(`DELETE FROM "_ember_replicas"`);
    });
    // The next delta finds the gap: the source resyncs the whole table there.
    await client.mutation(api.rates.setRate, { base: "GBP", quote: "BRL", rate: 7 });
    await settle([org]);
    expect((await rateIn(client, org, "EUR", "BRL")).rate).toMatchObject({ _id: id, rate: 6 });
    expect((await rateIn(client, org, "GBP", "BRL")).rate).toMatchObject({ rate: 7 });

    // Admin: resync one shard by hand (source global:main), and the replicated tables are listed.
    await runInDurableObject(orgShard(org), (_i, state) => void state.storage.sql.exec(`DELETE FROM "fxRates"`));
    const admin = (path: string, body?: unknown) =>
      selfFetch(`${BASE}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: "Bearer admin-secret", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }).then((r) => r.json() as Promise<any>);
    expect(await admin("/api/_ember/replicas/resync", { shard: `org:${org}`, source: "global:main" })).toEqual({ ok: true, value: { "global:main": { ok: true, targets: 1 } } });
    await settle([org]);
    expect((await rateIn(client, org, "EUR", "BRL")).rate).toMatchObject({ rate: 6 });
    const listed = await admin(`/api/_ember/replicas?source=global:main&shard=org:${org}`);
    expect(listed.tables).toContainEqual({ name: "fxRates", source: "global:main" });
    expect(listed.sources["global:main"].targets).toEqual([expect.objectContaining({ target: `org:${org}`, pending: 0, snapshot: 0 })]);
    // Admin API level 18 (the dashboard's Replication screen): the source's outbox and maxAttempts, the target's lag.
    expect(listed.sources["global:main"]).toMatchObject({ maxAttempts: 10, outbox: { seq: expect.any(Number), depth: expect.any(Number), parked: 0 } });
    expect(listed.sources["global:main"].targets[0]).toMatchObject({ oldest_at: null, last_seq: expect.any(Number) });
    client.close();
  });
});

describe("ctx.shards", () => {
  it("lists the org shards of the catalog and fans a query out to each, with per-shard errors", async () => {
    const client = testClient();
    const orgs = [uid(), uid(), uid()];
    for (const o of orgs) await rateIn(client, o);
    const id = await client.mutation(api.rates.setRate, { base: "USD", quote: "EUR", rate: 0.9 });
    await settle(orgs);
    await client.mutation(api.rates.convert, { org: orgs[1]!, rateId: id, amount: 1 });

    const r = await client.action(api.rates.report, { failFor: orgs[1]!, concurrency: 2 });
    for (const o of orgs) expect(r.orgs).toContain(`org:${o}`);
    expect(r.results.map((x) => x.shard)).toEqual(r.orgs);
    const by = new Map(r.results.map((x) => [x.shard, x]));
    expect(by.get(`org:${orgs[0]}`)).toEqual({ shard: `org:${orgs[0]}`, ok: true, value: { quotes: 0, status: "ready" } });
    expect(by.get(`org:${orgs[1]}`)).toMatchObject({ ok: false, error: { message: expect.stringContaining("this org is broken") } });
    client.close();
  });
});
