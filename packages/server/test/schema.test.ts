import { describe, expect, expectTypeOf, test } from "vitest";
import {
  createEngine,
  defineIndexKind,
  defineSchema,
  defineShard,
  defineTable,
  mutationGeneric,
  queryGeneric,
  v,
  type DataModelFromSchema,
  type FieldPathsOf,
  type GenericExt,
  type GenericId,
  type GenericIndexes,
  type MutationCtx,
  type QueryCtx,
  type TableDefinition,
} from "../src/index.ts";
import type { GenericValidator } from "@freecorps/ember-values";
import { createNodeSqliteDriver } from "../testing/index.ts";
import { schema } from "./fixtures.ts";

// A user index kind, typed through augmentation of the public entry point.
declare module "../src/index.ts" {
  interface IndexKindMethods<V extends GenericValidator, Indexes extends GenericIndexes, Ext extends GenericExt> {
    tagIndex<N extends string, F extends FieldPathsOf<V>>(name: N, cfg: { field: F }): TableDefinition<V, Indexes, Ext & { tag: Record<N, F> }>;
  }
}

/** Indexes rows by a string field into a side table; queryable via `withTagIndex(name, tag)`. */
const tagIndexKind = defineIndexKind<{ field: string }, string>({
  kind: "tag",
  method: "tagIndex",
  queryMethod: "withTagIndex",
  parse: (name, cfg) => ({ kind: "tag", name, fields: [cfg.field], config: { field: cfg.field } }),
  ddl: (layout, spec) => {
    const side = `${layout.table}__${spec.name}`;
    const f = (spec.config as { field: string }).field;
    return [
      { type: "table", name: side, sql: `CREATE TABLE "${side}" ("rid" INTEGER PRIMARY KEY, "tag" TEXT) STRICT` },
      { type: "trigger", name: `${side}__ai`, sql: `CREATE TRIGGER "${side}__ai" AFTER INSERT ON "${layout.table}" BEGIN INSERT INTO "${side}" VALUES (new."_rowid", ${layout.expr(f, "new")}); END` },
    ];
  },
  backfill: (layout, spec) =>
    `INSERT INTO "${layout.table}__${spec.name}" SELECT "_rowid", ${layout.expr((spec.config as { field: string }).field)} FROM "${layout.table}" WHERE "_rowid" > ?1 AND "_rowid" <= ?2`,
  query: (env, tag) => ({
    docs: env.exec(`SELECT t.* FROM "${env.layout.table}" t JOIN "${env.layout.table}__${env.spec.name}" s ON s.rid = t."_rowid" WHERE s.tag = ? ORDER BY t."_rowid"`, tag).map(env.decode),
    data: { tag },
  }),
  matchesChange: (entry, change, h) => [change.before, change.after].some((d) => d && h.field(d, (entry.data as any).field ?? "kind") === (entry.data as any).tag),
});

describe("defineSchema", () => {
  test("manifest: JSON, stable hash/version, system indexes implicit", () => {
    const m = schema.manifest;
    expect(JSON.parse(JSON.stringify(m))).toEqual(m);
    expect(m.version).toBe(m.hash);
    expect(m.version).toMatch(/^[0-9a-f]{64}$/);
    expect(m.tables.messages!.idPrefix).toBe("msg");
    expect(m.tables.messages!.indexes.map((i) => [i.kind, i.name])).toEqual([
      ["db", "by_channel"],
      ["db", "by_channel_likes"],
      ["db", "by_edited"],
      ["search", "search_body"],
    ]);
    const again = defineSchema({
      tables: {
        messages: defineTable(
          { channel: v.string(), author: v.id("users"), body: v.string(), likes: v.number(), meta: v.optional(v.object({ edited: v.boolean(), tags: v.array(v.string()) })) },
          { idPrefix: "msg" },
        )
          .index("by_channel", ["channel"])
          .index("by_channel_likes", ["channel", "likes"])
          .index("by_edited", ["meta.edited"])
          .searchIndex("search_body", { searchField: "body", filterFields: ["channel"] }),
        users: defineTable({ name: v.string(), email: v.string(), admin: v.boolean() }).index("by_email", ["email"]),
      },
    });
    expect(again.manifest.hash).toBe(m.hash); // table order does not matter
    const changed = defineSchema({ tables: { users: defineTable({ name: v.string() }) } });
    expect(changed.manifest.hash).not.toBe(m.hash);
  });

  test("Convex-style form and shards", () => {
    const s = defineSchema({ users: defineTable({ name: v.string() }) });
    expect(Object.keys(s.manifest.tables)).toEqual(["users"]);
    const sharded = defineSchema({
      shards: { mailbox: defineShard({ key: v.id("mailboxes"), locationHint: "enam" }) },
      tables: {
        mailboxes: defineTable({ owner: v.string() }),
        messages: defineTable({ mailboxId: v.id("mailboxes"), subject: v.string() }).shard("mailbox", "mailboxId"),
      },
    });
    expect(sharded.manifest.shards).toEqual({ mailbox: { key: { kind: "id", table: "mailboxes" }, locationHint: "enam" } });
    expect(sharded.manifest.tables.messages!.shard).toEqual({ name: "mailbox", field: "mailboxId" });
    expect(() =>
      defineSchema({ shards: { mailbox: defineShard({ key: v.id("mailboxes") }) }, tables: { m: defineTable({ x: v.string() }).shard("mailbox", "x") } }),
    ).toThrow(/match the shard key/);
  });

  test("validation errors", () => {
    expect(() => defineSchema({ tables: { _bad: defineTable({ x: v.string() }) } })).toThrow(/Invalid table name/);
    expect(() => defineSchema({ tables: { a__b: defineTable({ x: v.string() }) } })).toThrow(/Invalid table name/);
    expect(() => defineSchema({ tables: { t: defineTable({ _x: v.string() }) } })).toThrow(/reserved/);
    expect(() => defineSchema({ tables: { t: defineTable({ x: v.string() }).index("by_id", ["x"]) } })).toThrow(/reserved/);
    expect(() => defineSchema({ tables: { t: defineTable({ x: v.string() }).index("i", ["x"]).index("i", ["x"]) } })).toThrow(/duplicate/);
    expect(() => defineSchema({ tables: { t: defineTable({ x: v.string() }).index("i", ["y" as any]) } })).toThrow(/unknown field/);
    expect(() => defineSchema({ tables: { t: defineTable({ x: v.number() }).searchIndex("s", { searchField: "x" }) } })).toThrow(/string field/);
    expect(() =>
      defineSchema({ tables: { a: defineTable({ x: v.string() }, { idPrefix: "p" }), b: defineTable({ x: v.string() }, { idPrefix: "p" }) } }),
    ).toThrow(/share the id prefix/);
  });

  test("index-kind plugins are per schema: no global registry, no import-order dependence", () => {
    const table = () => defineTable({ kind: v.string() }).tagIndex("by_tag", { field: "kind" });
    expect(() => defineSchema({ tables: { t: table() } })).toThrow(/needs its index kind plugin/);
    const s = defineSchema({ tables: { t: table() }, indexKinds: [tagIndexKind] });
    expect(s.manifest.tables.t!.indexes).toEqual([{ kind: "tag", name: "by_tag", fields: ["kind"], config: { field: "kind" } }]);

    const driver = createNodeSqliteDriver();
    const engine = createEngine({ schema: s, driver });
    engine.migrate();
    const ins = (kind: string) => engine.runMutation(mutationGeneric((ctx) => ctx.db.insert("t", { kind })) as any);
    ins("x");
    ins("y");
    ins("x");
    const q = queryGeneric((ctx) => (ctx.db.query("t") as any).withTagIndex("by_tag", "x").collect().length);
    const r = engine.runQuery(q as any);
    expect(r.value).toBe(2);
    expect(r.readSet[0]).toMatchObject({ kind: "tag", index: "by_tag", data: { tag: "x" } });
    const change = ins("x").changes;
    expect(engine.matches(r.readSet, change)).toBe(true);
    expect(engine.matches(r.readSet, ins("z").changes)).toBe(false);
  });
});

describe("types", () => {
  type DM = DataModelFromSchema<typeof schema>;

  test("documents, ids, indexes", () => {
    expectTypeOf<DM["messages"]["document"]>().toEqualTypeOf<{
      _id: GenericId<"messages">;
      _creationTime: number;
      channel: string;
      author: GenericId<"users">;
      body: string;
      likes: number;
      meta?: { edited: boolean; tags: string[] };
    }>();
    expectTypeOf<DM["messages"]["indexes"]["by_channel_likes"]>().toEqualTypeOf<["channel", "likes", "_creationTime"]>();
    expectTypeOf<DM["messages"]["indexes"]["by_id"]>().toEqualTypeOf<["_id"]>();
    expectTypeOf<DM["messages"]["ext"]>().toMatchTypeOf<{ search: { search_body: { searchField: "body"; filterFields: "channel" } } }>();
  });

  test("typed ctx.db", () => {
    const check = (ctx: QueryCtx<DM>, mctx: MutationCtx<DM>) => {
      const m = ctx.db.query("messages").withIndex("by_channel_likes", (q) => q.eq("channel", "a").gt("likes", 1)).first();
      expectTypeOf(m).toEqualTypeOf<DM["messages"]["document"] | null>();
      // @ts-expect-error eq out of order
      ctx.db.query("messages").withIndex("by_channel_likes", (q) => q.eq("likes", 1));
      // @ts-expect-error wrong value type
      ctx.db.query("messages").withIndex("by_channel", (q) => q.eq("channel", 1));
      // @ts-expect-error unknown index
      ctx.db.query("messages").withIndex("nope");
      // @ts-expect-error unknown table
      ctx.db.query("nope");
      const id = mctx.db.insert("users", { name: "a", email: "b", admin: false });
      expectTypeOf(id).toEqualTypeOf<GenericId<"users">>();
      // @ts-expect-error missing field
      mctx.db.insert("users", { name: "a" });
      // @ts-expect-error system field
      mctx.db.patch(id, { _id: id });
      ctx.db.query("messages").filter((q) => q.eq(q.field("meta.edited"), true));
    };
    expect(typeof check).toBe("function");
  });

  test("builders infer args and return types; async mutations are a type error", () => {
    const f = mutationGeneric({ args: { n: v.number(), s: v.optional(v.string()) }, handler: (_ctx, args) => args.n + 1 });
    expectTypeOf(f.__args!).toEqualTypeOf<{ n: number; s?: string }>();
    expectTypeOf(f.__returns!).toEqualTypeOf<number>();
    // @ts-expect-error mutations must be synchronous
    mutationGeneric({ handler: async () => 1 });
    // @ts-expect-error bare async handler too
    mutationGeneric(async () => 1);
  });
});
