import { describe, expect, test } from "bun:test";
import { fresh, withUser } from "./helpers";

async function seeded() {
  const env = fresh();
  const author = await withUser(env);
  const ids: string[] = [];
  for (const [channel, likes, body] of [
    ["a", 1, "hello world"], ["a", 5, "héllo again"], ["a", 3, "bye"], ["b", 9, "hello b"], ["a", 5, "tie"], ["a", 7, ""],
  ] as const) {
    ids.push(await env.insert("messages", { channel, author, body, likes }));
  }
  return { ...env, author, ids };
}

describe("withIndex range queries compile to SQL and record read sets", () => {
  test("eq + gt + order desc + take", async () => {
    const { run } = await seeded();
    const { value, readSet } = await run((db) =>
      db.query("messages").withIndex("by_channel_likes", (q: any) => q.eq("channel", "a").gt("likes", 2)).order("desc").take(2),
    );
    expect(value.map((m: any) => [m.likes, m.body])).toEqual([[7, ""], [5, "tie"]]); // ties: later _creationTime first in desc
    expect(readSet).toHaveLength(1);
    const e = readSet[0];
    expect(e.kind).toBe("range");
    expect(e.fields).toEqual(["channel", "likes", "_creationTime", "_id"]);
    expect(e.upper).toEqual({ key: ["a"], inclusive: true });
    // take(2) stopped at the 2nd row, so the read set covers only [that row's key, upper].
    expect(e.lower.inclusive).toBe(true);
    expect(e.lower.key.slice(0, 2)).toEqual(["a", 5]);
  });

  test("full range when the scan is exhausted", async () => {
    const { run } = await seeded();
    const { value, readSet } = await run((db) => db.query("messages").withIndex("by_channel", (q: any) => q.eq("channel", "b")).take(10));
    expect(value).toHaveLength(1);
    expect(readSet[0].lower).toEqual({ key: ["b"], inclusive: true });
    expect(readSet[0].upper).toEqual({ key: ["b"], inclusive: true });
  });

  test("filter is applied in JS and recorded in the read set", async () => {
    const { run } = await seeded();
    const { value, readSet } = await run((db) =>
      db.query("messages").withIndex("by_channel", (q: any) => q.eq("channel", "a")).filter((q: any) => q.gte(q.field("likes"), 5)).collect(),
    );
    expect(value.map((m: any) => m.likes)).toEqual([5, 5, 7]);
    expect(readSet[0].filter).toEqual([{ op: "gte", args: [{ field: "likes" }, { literal: 5 }] }]);
  });

  test("index on a nested field (expression index over _rest JSON)", async () => {
    const env = await seeded();
    await env.patch(env.ids[0]!, { meta: { edited: true, tags: [] } });
    const { value } = await env.run((db) => db.query("messages").withIndex("by_edited", (q: any) => q.eq("meta.edited", true)).collect());
    expect(value.map((m: any) => m._id)).toEqual([env.ids[0]]);
  });

  test("paginate: stable pages, cursors, endCursor re-run", async () => {
    const { run } = await seeded();
    const page = (cursor: string | null, endCursor?: string) =>
      run((db) => db.query("messages").withIndex("by_channel", (q: any) => q.eq("channel", "a")).paginate({ numItems: 2, cursor, endCursor }));
    const p1 = (await page(null)).value;
    const p2 = (await page(p1.continueCursor)).value;
    const p3 = (await page(p2.continueCursor)).value;
    expect([p1, p2, p3].map((p: any) => [p.page.map((m: any) => m.likes), p.isDone])).toEqual([[[1, 5], false], [[3, 5], false], [[7], true]]);
    // Reactive re-run of page 1 pins its end so it cannot shift into page 2.
    const again = (await page(null, p1.continueCursor)).value;
    expect(again.page.map((m: any) => m.likes)).toEqual([1, 5]);
  });

  test("first / unique / get", async () => {
    const { run, ids } = await seeded();
    expect((await run((db) => db.query("users").withIndex("by_email", (q: any) => q.eq("email", "ada@x.dev")).unique())).value.name).toBe("Ada");
    await expect(run((db) => db.query("messages").withIndex("by_channel", (q: any) => q.eq("channel", "a")).unique())).rejects.toThrow(/more than one/);
    const { value, readSet } = await run((db) => db.get(ids[2]));
    expect(value.body).toBe("bye");
    expect(readSet[0]).toMatchObject({ index: "by_id", lower: { key: [ids[2]], inclusive: true }, upper: { key: [ids[2]], inclusive: true } });
  });

  test("withIndex range builder rejects out-of-order fields at runtime too", async () => {
    const { run } = await seeded();
    await expect(run((db) => db.query("messages").withIndex("by_channel_likes", (q: any) => q.eq("likes", 1)).collect())).rejects.toThrow(/out of order/);
  });

  test("SQLite uses the named index (no table scan)", async () => {
    const { sql } = await seeded();
    const plan = sql.all<{ detail: string }>(
      `EXPLAIN QUERY PLAN SELECT * FROM "messages" INDEXED BY "messages__by_channel_likes" WHERE "channel" IS ? AND ("likes" > ?) ORDER BY "channel", "likes", "_creationTime", "_id"`,
      "a", 2,
    );
    expect(plan.map((p) => p.detail).join(" ")).toMatch(/SEARCH messages USING INDEX messages__by_channel_likes \(channel=\? AND likes>\?\)/);
  });

  test("search index (FTS5): diacritics folded, prefix on last term, filter field, read set", async () => {
    const { run } = await seeded();
    const { value, readSet } = await run((db) =>
      db.query("messages").withSearchIndex("search_body", (q: any) => q.search("body", "HELLO").eq("channel", "a")).collect(),
    );
    expect(value.map((m: any) => m.body).sort()).toEqual(["hello world", "héllo again"]);
    expect(readSet[0]).toMatchObject({ kind: "plugin", indexKind: "search", data: { terms: ["hello"], eqs: [{ field: "channel", value: "a" }] } });
    const prefix = await run((db) => db.query("messages").withSearchIndex("search_body", (q: any) => q.search("body", "wor")).collect());
    expect(prefix.value.map((m: any) => m.body)).toEqual(["hello world"]);
    const injection = await run((db) => db.query("messages").withSearchIndex("search_body", (q: any) => q.search("body", '" OR * NEAR(')).collect());
    expect(injection.value).toEqual([]);
  });

  test("user plugin index (vector) answers queries", async () => {
    const env = await seeded();
    await env.patch(env.ids[0]!, { embedding: [1, 0, 0] });
    await env.patch(env.ids[1]!, { embedding: [0, 1, 0] });
    await env.patch(env.ids[3]!, { embedding: [1, 0, 0] }); // channel b
    const { value } = await env.run((db) => db.query("messages").withVectorIndex("by_embedding", { vector: [0.9, 0.1, 0], limit: 2, filter: { channel: "a" } }).collect());
    expect(value.map((m: any) => m._id)).toEqual([env.ids[0], env.ids[1]]);
  });
});
