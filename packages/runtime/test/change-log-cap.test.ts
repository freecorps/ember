/**
 * Ceiling on one change-log entry (`changeLogEntryMaxBytes`, default 128 KiB): a commit whose changes are larger (a
 * huge document) keeps only its version in `_ember_changes`, and a resume across it answers with a full snapshot
 * (correct value) instead of `unchanged`. Smaller commits stay on the incremental path.
 */
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { CHANGE_LOG_ENTRY_MAX_BYTES } from "../src/shard.ts";
import { parse } from "../src/wire.ts";
import { api, shardStub } from "./helpers.ts";

type QueryOk = { ok: true; value?: Array<{ body: string }>; unchanged?: true; version: number; epoch: string; ik: string };

const list = async (shard: string, channel: string, from?: QueryOk): Promise<QueryOk> => {
  const r = await api("query", { fn: "messages:list", args: { channel }, shard, ...(from ? { resume: { version: from.version, epoch: from.epoch, ik: from.ik } } : {}) });
  expect(r.body.ok).toBe(true);
  return r.body as QueryOk;
};
const send = async (shard: string, channel: string, body: string) => {
  const r = await api("mutation", { fn: "messages:send", args: { channel, body }, shard });
  expect(r.body.ok).toBe(true);
};
/** `length(changes)` of the change-log row of `version`, and the rows written meanwhile. */
const ringText = (shard: string, version: number) =>
  runInDurableObject(shardStub(shard), (_i, state) => state.storage.sql.exec<{ n: number }>("SELECT length(changes) AS n FROM _ember_changes WHERE version = ? AND slot >= 0", version).one().n);
const written = async (shard: string) => (await shardStub(shard).inspect()).rows.written;

describe("change-log entry ceiling", () => {
  it("a commit over the ceiling is not written whole: a resume across it gets a full, correct snapshot; small ones stay incremental", async ({ annotate }) => {
    const shard = "chat:changecap";
    const big = "x".repeat(CHANGE_LOG_ENTRY_MAX_BYTES + 10_000);
    await send(shard, "mine", "first");
    const held = await list(shard, "mine");
    // A small write elsewhere: the resume is answered from the change log (no value sent).
    let w0 = await written(shard);
    await send(shard, "elsewhere", "small");
    const smallRows = (await written(shard)) - w0;
    const afterSmall = await list(shard, "mine", held);
    expect(afterSmall).toMatchObject({ unchanged: true });
    const smallText = await ringText(shard, afterSmall.version);

    // A huge document elsewhere: its change-log row only marks the version.
    w0 = await written(shard);
    await send(shard, "elsewhere", big);
    const bigRows = (await written(shard)) - w0;
    const r = await list(shard, "mine", afterSmall);
    expect(r.unchanged).toBeUndefined();
    expect(r.value!.map((m) => m.body)).toEqual(["first"]);
    expect(await ringText(shard, r.version)).toBe(4); // "null"
    expect((await shardStub(shard).inspect()).stats.changeLogOversized).toBe(1);

    // Past it, small commits resume incrementally again.
    await send(shard, "elsewhere", "small again");
    expect(await list(shard, "mine", r)).toMatchObject({ unchanged: true });

    // The huge document in the subscribed range: the client that comes back gets it whole.
    const before = await list(shard, "mine");
    await send(shard, "mine", big);
    const full = await list(shard, "mine", before);
    expect(full.unchanged).toBeUndefined();
    expect(full.value!.map((m) => m.body.length)).toEqual([5, big.length]);

    // Same after the object is evicted (the version is read from the ring row, not from memory).
    const across = await list(shard, "mine");
    await send(shard, "elsewhere", big);
    await evictDurableObject(shardStub(shard));
    const cold = await list(shard, "mine", across);
    expect(cold.unchanged).toBeUndefined();
    expect(cold.value!.map((m) => m.body.length)).toEqual([5, big.length]);
    await send(shard, "elsewhere", "tiny");
    expect(await list(shard, "mine", cold)).toMatchObject({ unchanged: true });

    // One row more per huge commit (its out-of-ring row, for runtimes before the ceiling); what the ring stops holding
    // is the document's bytes.
    expect(bigRows).toBe(smallRows + 1);
    // The in-memory cache of parsed rows full (reset by the commit that follows): the oversized mark survives the reset,
    // so a resume across it still gets a snapshot (the same answer as from the row), not the changes from memory.
    const atReset = await list(shard, "mine");
    await runInDurableObject(shardStub(shard), (i) => void ((i as unknown as { parsedSize: number }).parsedSize = 50_000));
    await send(shard, "elsewhere", big);
    const reset = await list(shard, "mine", atReset);
    expect(reset.unchanged).toBeUndefined();
    expect(reset.value!.map((m) => m.body.length)).toEqual([5, big.length]);

    await annotate(`ring row for a ${big.length}-byte document: ${4} chars instead of ~${big.length}; a small commit's row: ${smallText} chars; rows written per insert: ${smallRows} (small) vs ${bigRows} (huge)`);
  });

  it("rollback: a runtime before the ceiling answers a resume across an oversized version with a snapshot (no throw)", async () => {
    const shard = "chat:changecap-rollback";
    const ring = 5; // test worker: changeLogVersions = 5
    await send(shard, "mine", "first");
    const held = await list(shard, "mine");
    await send(shard, "elsewhere", "x".repeat(CHANGE_LOG_ENTRY_MAX_BYTES + 1));
    await send(shard, "elsewhere", "small");
    // The SQL path of `changesSince` as runtimes before the ceiling run it (main before PR 3c): every row parsed as an
    // array once the count of rows matches the count of versions.
    const oldChangesSince = (from: number) =>
      runInDurableObject(shardStub(shard), (_i, state) => {
        const sql = state.storage.sql;
        const version = Number(sql.exec<{ v: number }>("SELECT MAX(version) AS v FROM _ember_changes").one().v);
        if (version - from > ring) return null;
        const rows = sql.exec<{ version: number; changes: string }>("SELECT version, changes FROM _ember_changes WHERE version > ? ORDER BY version", from).toArray();
        if (rows.length !== version - from) return null;
        const all: unknown[] = [];
        for (const r of rows) for (const x of parse(r.changes) as unknown[]) all.push(x);
        return all.length;
      });
    // Across the huge commit: a gap (snapshot), not a TypeError on its `null`.
    expect(await oldChangesSince(held.version)).toBeNull();
    // After it: the incremental path, as before.
    expect(await oldChangesSince(held.version + 1)).toBe(1);
    // The version the old runtime loads is still the newest commit's.
    const v = (await shardStub(shard).inspect()).version;
    expect(v).toBe(held.version + 2);
  });

  it("the out-of-ring row goes once the ring no longer holds its version", async () => {
    const shard = "chat:changecap-gc";
    await send(shard, "elsewhere", "x".repeat(CHANGE_LOG_ENTRY_MAX_BYTES + 1));
    const extra = () => runInDurableObject(shardStub(shard), (_i, state) => state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM _ember_changes WHERE slot < 0").one().n);
    expect(await extra()).toBe(1);
    // Ring of 5 (test worker: changeLogVersions = 5): the 5th commit after the huge one reuses its slot.
    for (let i = 0; i < 4; i++) await send(shard, "elsewhere", `s${i}`);
    expect(await extra()).toBe(1);
    await send(shard, "elsewhere", "last");
    expect(await extra()).toBe(0);
  });

  it("an out-of-ring row whose version the ring lost (rollback, ring resized) goes when the object loads", async () => {
    const shard = "chat:changecap-orphan";
    await send(shard, "elsewhere", "small");
    await send(shard, "elsewhere", "small 2");
    // Version 1 oversized, then gone from its slot (a ring resized while an older runtime ran).
    await runInDurableObject(shardStub(shard), (_i, state) => {
      state.storage.sql.exec("DELETE FROM _ember_changes WHERE version = 1");
      state.storage.sql.exec("INSERT INTO _ember_changes(slot, version, at, changes) VALUES (-1, 1, 0, 'null')");
    });
    await evictDurableObject(shardStub(shard));
    await send(shard, "elsewhere", "again");
    const n = await runInDurableObject(shardStub(shard), (_i, state) => state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM _ember_changes WHERE slot < 0").one().n);
    expect(n).toBe(0);
  });
});
