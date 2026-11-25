// Sparse indexes (`.index(name, fields, { sparse: true })`) on every backend: a local scan of one leaves out the
// documents missing an indexed field, as the server's partial index does.
import { afterEach, describe, expect, it } from "vitest";
import { stableStringify } from "@freecorps/ember-client";
import { createEngine, defineSchema, defineTable, mutationGeneric, query, v, type Doc, type QueryCtx } from "@freecorps/ember-server";
import { createNodeSqliteDriver } from "@freecorps/ember-server/testing";
import { backend, BACKENDS } from "./backends.ts";
import type { OfflineStore } from "../src/index.ts";

const schema = defineSchema({
  tables: { items: defineTable({ name: v.string(), k: v.optional(v.string()) }).index("by_k", ["k"], { sparse: true }) },
});
const items = {
  /** Every document (what the replica holds). */
  all: query({ handler: (ctx: QueryCtx) => ctx.db.query("items").collect() }),
  /** The sparse index, without bounds: only documents with `k`. */
  keyed: query({ handler: (ctx: QueryCtx) => ctx.db.query("items").withIndex("by_k" as never).collect() }),
  byK: query({ args: { k: v.string() }, handler: (ctx: QueryCtx, { k }: { k: string }) => ctx.db.query("items").withIndex("by_k" as never, (q: any) => q.eq("k", k)).collect() }),
};
const SHARD = "org:acme";
const req = (fn: string, args: Record<string, unknown> = {}) => ({ shard: SHARD, fn, args, argsJson: stableStringify(args), identity: null });
const upd = (fn: string, args: Record<string, unknown>, value: unknown) => ({ shard: SHARD, fn, args, argsJson: stableStringify(args), value, version: 1 });

describe.each(BACKENDS)("sparse index: %s", (kind) => {
  const cleanups: Array<() => void> = [];
  const open: OfflineStore[] = [];
  afterEach(async () => {
    for (const s of open.splice(0)) await s.close().catch(() => undefined);
    for (const c of cleanups.splice(0)) c();
  });

  it("local scans match the server's: documents without the field are not in the index", async () => {
    const engine = createEngine({ schema, functions: { items }, driver: createNodeSqliteDriver() });
    engine.migrate();
    for (const doc of [{ name: "a", k: "2" }, { name: "b" }, { name: "c", k: "1" }, { name: "d" }]) {
      engine.runMutation(mutationGeneric({ handler: (ctx: any) => ctx.db.insert("items", doc) }) as never);
    }
    const server = (fn: string, args: Record<string, unknown> = {}) => engine.runQuery(fn, args).value as Doc[];
    const b = backend(kind);
    cleanups.push(b.cleanup);
    const s = b.make({ schema, queries: { items } });
    open.push(s);
    await s.load();
    await s.applyPatch(upd("items:all", {}, server("items:all")));
    const local = async (fn: string, args: Record<string, unknown> = {}) => (await s.runQueryLocally(req(fn, args)))!.value as Doc[];
    expect(server("items:keyed").map((d) => d.name)).toEqual(["c", "a"]);
    expect(await local("items:keyed")).toEqual(server("items:keyed"));
    expect(await local("items:byK", { k: "2" })).toEqual(server("items:byK", { k: "2" }));
  });
});
