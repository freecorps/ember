/**
 * Ceiling on one change-log entry (`changeLogEntryMaxBytes`, default 128 KiB): a commit whose changes are larger (a
 * huge document) keeps only its version in `_ember_changes`, and a resume across it answers with a full snapshot
 * (correct value) instead of `unchanged`. Smaller commits stay on the incremental path.
 */
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { CHANGE_LOG_ENTRY_MAX_BYTES } from "../src/shard.ts";
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
  runInDurableObject(shardStub(shard), (_i, state) => state.storage.sql.exec<{ n: number }>("SELECT length(changes) AS n FROM _ember_changes WHERE version = ?", version).one().n);
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

    // Same rows written per commit (one ring row each); what the ring stops holding is the document's bytes.
    expect(bigRows).toBe(smallRows);
    await annotate(`ring row for a ${big.length}-byte document: ${4} chars instead of ~${big.length}; a small commit's row: ${smallText} chars; rows written per insert: ${smallRows} (small) vs ${bigRows} (huge)`);
  });
});
