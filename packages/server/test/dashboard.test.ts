// Declarative dashboard screens (contracts.md "Telas declarativas"): the spec is plain data, checked when the component
// or app is defined/composed, and serialized with absolute function names.
import { describe, expect, test } from "vitest";
import {
  componentBuilders,
  composeApp,
  defineApp,
  defineComponent,
  defineSchema,
  defineTable,
  makeFunctionReference,
  mutationGeneric,
  paginationOptsValidator,
  queryGeneric,
  unsafeRef,
  v,
  type DashboardSpecInput,
} from "../src/index.ts";

const schema = defineSchema({ tables: { items: defineTable({ name: v.string(), status: v.union(v.literal("pending"), v.literal("done")), on: v.boolean() }).index("by_status", ["status"]) } });
const b = componentBuilders<typeof schema, undefined>();
const status = v.union(v.literal("pending"), v.literal("done"));
const lib = {
  stats: b.query({ args: {}, handler: () => ({ pending: 1, done: 2 }) }),
  list: b.query({ args: { status: v.optional(status), paginationOpts: paginationOptsValidator }, handler: (ctx, a) => ctx.db.query("items").paginate(a.paginationOpts) }),
  all: b.query({ args: { status: v.optional(status) }, handler: (ctx) => ctx.db.query("items").collect() }),
  get: b.query({ args: { id: v.id("items") }, handler: (ctx, { id }) => ctx.db.get(id) }),
  setOn: b.mutation({ args: { id: v.id("items"), on: v.boolean() }, handler: (ctx, { id, on }) => ctx.db.patch(id, { on }) }),
  remove: b.mutation({ args: { id: v.id("items") }, handler: (ctx, { id }) => ctx.db.delete(id) }),
  purge: b.internalMutation({ args: { status }, handler: () => 0 }),
  ping: b.action({ args: {}, handler: async () => "pong" }),
};
const functions = { lib };

const spec = (over: Partial<DashboardSpecInput> = {}): DashboardSpecInput => ({
  label: "Items",
  icon: "queue",
  tabs: [
    {
      id: "overview",
      label: "Overview",
      blocks: [
        { kind: "stats", query: lib.stats, items: [{ label: "Pending", path: "pending", format: "number" }] },
        {
          kind: "table",
          id: "items",
          query: lib.list,
          args: { status: "pending" },
          columns: [{ label: "Name", path: "name" }, { label: "On", path: "on", format: "boolean", toggle: { mutation: lib.setOn, arg: "on", fromRow: { id: "_id" } } }],
          detail: { query: lib.get, fromRow: { id: "_id" }, sections: [{ kind: "kv", items: [{ label: "Name", path: "name" }] }, { kind: "json" }] },
          rowActions: [{ label: "Remove", fn: lib.remove, fromRow: { id: "_id" }, destructive: true }],
        },
        { kind: "actions", actions: [{ id: "purge", label: "Purge done", fn: lib.purge, args: { status: "done" } }, { label: "Ping", fn: lib.ping }] },
      ],
    },
  ],
  ...over,
});

describe("defineComponent({ dashboard })", () => {
  test("resolves refs to names, fills ids and defaults, lists the functions it runs", () => {
    const c = defineComponent({ name: "items", schema, functions, dashboard: spec() });
    const d = c.dashboard!;
    expect(d).toMatchObject({ label: "Items", icon: "queue", scope: "shard" });
    const [stats, table, actions] = d.tabs[0]!.blocks;
    expect(stats).toMatchObject({ kind: "stats", id: "b0", query: "lib:stats" });
    expect(table).toMatchObject({
      kind: "table",
      id: "items",
      query: "lib:list",
      args: { status: "pending" },
      // `status` is fixed, `paginationOpts` is the pager: no filter left.
      filters: [],
      pageSize: 25,
      rowKey: "_id",
      detail: { query: "lib:get", fromRow: { id: "_id" } },
      rowActions: [{ id: "a0", fn: "lib:remove", destructive: true }],
    });
    expect((table as { columns: unknown[] }).columns[1]).toMatchObject({ toggle: { mutation: "lib:setOn", arg: "on" } });
    expect(actions).toMatchObject({ kind: "actions", actions: [{ id: "purge", fn: "lib:purge" }, { id: "a1", fn: "lib:ping" }] });
    expect(Object.keys(d.functions)).toEqual(["lib:get", "lib:list", "lib:ping", "lib:purge", "lib:remove", "lib:setOn", "lib:stats"]);
    expect(d.functions["lib:remove"]).toMatchObject({ type: "mutation", destructive: true });
    expect(d.functions["lib:ping"]).toMatchObject({ type: "action" });
    expect(d.functions["lib:purge"]!.destructive).toBeUndefined();
    // Plain data: survives JSON as is.
    expect(JSON.parse(JSON.stringify(d))).toEqual(d);
  });

  test("filters default to the query's args (minus the pager and fixed ones)", () => {
    const c = defineComponent({ name: "items", schema, functions, dashboard: spec({ tabs: [{ id: "t", label: "T", blocks: [{ kind: "table", query: lib.all, columns: [{ label: "N", path: "name" }] }] }] }) });
    expect(c.dashboard!.tabs[0]!.blocks[0]).toMatchObject({ filters: ["status"] });
    expect(c.dashboard!.tabs[0]!.blocks[0]).not.toHaveProperty("pageSize");
  });

  const refuses = (over: Partial<DashboardSpecInput>, message: RegExp) => expect(() => defineComponent({ name: "items", schema, functions, dashboard: spec(over) })).toThrow(message);
  const oneBlock = (block: unknown) => ({ tabs: [{ id: "t", label: "T", blocks: [block as never] }] });

  test("refuses refs that are strings, unknown, or of another component", () => {
    refuses(oneBlock({ kind: "stats", query: "lib:stats", items: [{ label: "x", path: "x" }] }), /tabs\[0\]\.blocks\[0\]\.query: a function reference .* not a string/);
    const other = queryGeneric({ args: {}, handler: () => 1 });
    refuses(oneBlock({ kind: "stats", query: other, items: [{ label: "x", path: "x" }] }), /not one of this component's functions/);
    refuses(oneBlock({ kind: "stats", query: unsafeRef("lib:nope"), items: [{ label: "x", path: "x" }] }), /lib:nope is not a function of this component/);
    // A reference by name to its own function is fine.
    expect(() => defineComponent({ name: "items", schema, functions, dashboard: spec(oneBlock({ kind: "stats", query: makeFunctionReference<"query">("lib:stats"), items: [{ label: "x", path: "x" }] })) })).not.toThrow();
  });

  test("refuses the wrong kind of function", () => {
    refuses(oneBlock({ kind: "stats", query: lib.remove, items: [{ label: "x", path: "x" }] }), /lib:remove is a mutation, expected a query/);
    refuses(oneBlock({ kind: "actions", actions: [{ label: "x", fn: lib.stats }] }), /lib:stats is a query, expected a mutation or action/);
    refuses(oneBlock({ kind: "toggle", label: "On", query: lib.stats, path: "x", mutation: lib.ping, arg: "on" }), /lib:ping is a action, expected a mutation/);
  });

  test("refuses args that do not fit the function's validators", () => {
    refuses(oneBlock({ kind: "table", query: lib.list, args: { status: "lost" }, columns: [{ label: "N", path: "name" }] }), /args\.status: .*does not fit lib:list's validator/);
    refuses(oneBlock({ kind: "table", query: lib.list, args: { nope: 1 }, columns: [{ label: "N", path: "name" }] }), /args\.nope: lib:list has no argument "nope"/);
    refuses(oneBlock({ kind: "table", query: lib.all, filters: ["nope"], columns: [{ label: "N", path: "name" }] }), /filters\[0\]: lib:all has no argument "nope"/);
    refuses(oneBlock({ kind: "table", query: lib.all, pageSize: 10, columns: [{ label: "N", path: "name" }] }), /lib:all is not paginated/);
    refuses(oneBlock({ kind: "actions", actions: [{ label: "x", fn: lib.remove, args: { id: 3 } }] }), /args\.id: /);
    refuses(oneBlock({ kind: "toggle", label: "On", query: lib.stats, path: "x", mutation: lib.setOn, arg: "id" }), /setOn's id is not a v\.boolean\(\)/);
    refuses(oneBlock({ kind: "table", query: lib.all, columns: [{ label: "N", path: "name" }], rowActions: [{ label: "x", fn: lib.remove, fromRow: { nope: "_id" } }] }), /fromRow\.nope: lib:remove has no argument/);
    // Plain data only.
    refuses(oneBlock({ kind: "actions", actions: [{ label: "x", fn: lib.purge, args: { status: () => "done" } }] }), /must be plain JSON/);
  });

  test("a paginated table's paginationOpts must take the pager's cursor (null, then a string)", () => {
    const withCursor = (cursor: Parameters<typeof v.object>[0][string]) => {
      const pager = { list: b.query({ args: { paginationOpts: v.object({ numItems: v.number(), cursor }) }, handler: () => null }) };
      return () => defineComponent({ name: "items", schema, functions: { lib: pager }, dashboard: spec(oneBlock({ kind: "table", query: pager.list, columns: [{ label: "N", path: "name" }] })) });
    };
    expect(withCursor(v.number())).toThrow(/paginationOpts argument must be paginationOptsValidator/);
    expect(withCursor(v.string())).toThrow(/paginationOpts argument must be paginationOptsValidator/);
    expect(withCursor(v.null())).toThrow(/paginationOpts argument must be paginationOptsValidator/);
    expect(withCursor(v.nullable(v.string()))).not.toThrow();
  });

  test("the page size must fit the query's numItems; sparse lists are refused", () => {
    const pager = { list: b.query({ args: { paginationOpts: v.object({ numItems: v.number().max(10), cursor: v.nullable(v.string()) }) }, handler: () => null }) };
    const table = (pageSize?: number) => () =>
      defineComponent({ name: "items", schema, functions: { lib: pager }, dashboard: spec(oneBlock({ kind: "table", query: pager.list, columns: [{ label: "N", path: "name" }], ...(pageSize ? { pageSize } : {}) })) });
    expect(table()).toThrow(/pageSize: lib:list's paginationOpts\.numItems does not accept 25 \(the default; set pageSize\)/);
    expect(table(20)).toThrow(/does not accept 20/);
    expect(table(10)).not.toThrow();
    // A lower bound: the table's own page size must meet it (the default 25 does; 5 does not, named as pageSize).
    const atLeast = { list: b.query({ args: { paginationOpts: v.object({ numItems: v.number().min(10), cursor: v.nullable(v.string()) }) }, handler: () => null }) };
    const minTable = (pageSize?: number) => () =>
      defineComponent({ name: "items", schema, functions: { lib: atLeast }, dashboard: spec(oneBlock({ kind: "table", query: atLeast.list, columns: [{ label: "N", path: "name" }], ...(pageSize ? { pageSize } : {}) })) });
    expect(minTable(10)).not.toThrow();
    expect(minTable()).not.toThrow();
    expect(minTable(5)).toThrow(/pageSize: lib:list's paginationOpts\.numItems does not accept 5/);
    refuses({ tabs: new Array(1) }, /tabs\[0\] is missing \(a sparse array\)/);
  });

  test("refuses malformed specs: unknown keys and kinds, bad paths, ids, icons, duplicates", () => {
    refuses({ icon: "rocket" as never }, /icon "rocket": one of box/);
    refuses({ scope: "everywhere" as never }, /scope must be/);
    refuses({ tabs: [] }, /tabs is empty/);
    refuses(oneBlock({ kind: "chart" }), /kind "chart": one of stats, table, detail, toggle, actions/);
    refuses(oneBlock({ kind: "stats", query: lib.stats, items: [{ label: "x", path: "a..b" }] }), /path must be a dot path/);
    refuses(oneBlock({ kind: "stats", query: lib.stats, items: [{ label: "x", path: "x", format: "money" }] }), /format "money"/);
    refuses(oneBlock({ kind: "stats", query: lib.stats, items: [{ label: "x", path: "x" }], colour: "red" }), /colour: unknown key/);
    refuses(oneBlock({ kind: "detail", query: lib.get, sections: [{ kind: "video", path: "x" }] }), /sections\[0\]\.kind "video"/);
    refuses(oneBlock({ kind: "detail", query: lib.get, fromRow: { id: "_id" }, sections: [{ kind: "json" }] }), /only a table's detail has rows/);
    refuses({ tabs: [{ id: "Bad Id", label: "x", blocks: [{ kind: "stats", query: lib.stats, items: [{ label: "x", path: "x" }] }] }] }, /tabs\[0\]\.id must match/);
    const stats = { kind: "stats", query: lib.stats, items: [{ label: "x", path: "x" }] };
    refuses({ tabs: [{ id: "a", label: "A", blocks: [stats as never] }, { id: "a", label: "B", blocks: [stats as never] }] }, /tabs\[1\]\.id "a" is used twice/);
    refuses(oneBlock({ kind: "actions", actions: [{ id: "x", label: "x", fn: lib.ping }, { id: "x", label: "y", fn: lib.ping }] }), /\.id "x" is used twice/);
  });
});

describe("composeApp: dashboards in the manifest", () => {
  const items = defineComponent({ name: "items", schema, functions, dashboard: spec() });
  const appFns = {
    jobs: {
      list: queryGeneric({ args: { status: v.optional(v.string()) }, handler: () => [] }),
      retry: mutationGeneric({ args: { id: v.string() }, handler: () => null }),
    },
  };
  const appSchema = defineSchema({ tables: { notes: defineTable({ text: v.string() }) } });

  test("the app's spec (key \"\") and each install's, with absolute names; nested installs too", () => {
    const outer = defineComponent({ name: "outer", functions: {} }).use(items, { name: "inner" });
    const app = defineApp({
      dashboard: {
        label: "Jobs",
        scope: "global",
        tabs: [{ id: "jobs", label: "Jobs", blocks: [{ kind: "table", query: makeFunctionReference<"query">("jobs:list"), columns: [{ label: "Id", path: "_id" }], rowActions: [{ label: "Retry", fn: makeFunctionReference<"mutation">("jobs:retry"), fromRow: { id: "_id" } }] }] }],
      },
    })
      .use(items, { name: "pool" })
      .use(outer);
    const composed = composeApp({ schema: appSchema, functions: appFns, app });
    expect(composed.dashboards.map((d) => [d.key, d.component, d.scope])).toEqual([
      ["", null, "global"],
      ["pool", "items", "shard"],
      ["outer/inner", "items", "shard"],
    ]);
    const pool = composed.dashboards[1]!;
    expect(pool.tabs[0]!.blocks[1]).toMatchObject({ query: "@pool/lib:list", detail: { query: "@pool/lib:get" }, rowActions: [{ fn: "@pool/lib:remove" }] });
    expect(Object.keys(pool.functions)).toContain("@pool/lib:setOn");
    expect(Object.keys(composed.dashboards[2]!.functions)).toContain("@outer/@inner/lib:stats");
    // Every named function is in the composed map, with the same args.
    for (const d of composed.dashboards) for (const [n, f] of Object.entries(d.functions)) expect((composed.functions[n] as { args: unknown }).args).toEqual(f.args);
    expect(composed.dashboards[0]!.functions).toMatchObject({ "jobs:list": { type: "query" }, "jobs:retry": { type: "mutation" } });
  });

  test("an app without components keeps its dashboard; the schema hash does not change", () => {
    const plain = composeApp({ schema: appSchema, functions: appFns, app: defineApp() });
    const withSpec = composeApp({
      schema: appSchema,
      functions: appFns,
      app: defineApp({ dashboard: { label: "Jobs", tabs: [{ id: "t", label: "T", blocks: [{ kind: "stats", query: makeFunctionReference<"query">("jobs:list"), items: [{ label: "n", path: "length" }] }] }] } }),
    });
    expect(plain.dashboards).toEqual([]);
    expect(withSpec.dashboards.map((d) => d.key)).toEqual([""]);
    expect(withSpec.schema.manifest.hash).toBe(plain.schema.manifest.hash);
    // A component's spec does not change the composed schema either.
    const bare = defineComponent({ name: "items", schema, functions });
    expect(composeApp({ schema: appSchema, functions: appFns, app: defineApp().use(items) }).schema.manifest.hash).toBe(composeApp({ schema: appSchema, functions: appFns, app: defineApp().use(bare) }).schema.manifest.hash);
  });

  test("the app's refs are checked against its functions when composed; the shape already in defineApp", () => {
    const bad = defineApp({ dashboard: { label: "J", tabs: [{ id: "t", label: "T", blocks: [{ kind: "stats", query: makeFunctionReference<"query">("jobs:nope"), items: [{ label: "n", path: "x" }] }] }] } });
    expect(() => composeApp({ schema: appSchema, functions: appFns, app: bad })).toThrow(/defineApp: dashboard tabs\[0\]\.blocks\[0\]\.query: jobs:nope is not a function of this app/);
    const wrongKind = defineApp({ dashboard: { label: "J", tabs: [{ id: "t", label: "T", blocks: [{ kind: "stats", query: makeFunctionReference<"query">("jobs:retry"), items: [{ label: "n", path: "x" }] }] }] } });
    expect(() => composeApp({ schema: appSchema, functions: appFns, app: wrongKind })).toThrow(/jobs:retry is a mutation, expected a query/);
    expect(() => defineApp({ dashboard: { label: "", tabs: [] } })).toThrow(/defineApp: dashboard label must be a non-empty string/);
    // The shape-only check (defineApp) accepts a destructive action and a pageSize; composeApp decides with the args.
    const shaped = defineApp({ dashboard: { label: "J", tabs: [{ id: "t", label: "T", blocks: [{ kind: "actions", actions: [{ label: "Retry", fn: makeFunctionReference<"mutation">("jobs:retry"), destructive: true }] }] }] } });
    expect(composeApp({ schema: appSchema, functions: appFns, app: shaped }).dashboards[0]!.functions["jobs:retry"]).toMatchObject({ type: "mutation", destructive: true });
    // A global screen cannot name a function pinned to another kind of shard (it would refuse to run on global:main).
    const pinned = { orgs: { get: queryGeneric({ shard: "org", args: {}, handler: () => null }) } };
    const spec = (scope: "global" | "shard") => defineApp({ dashboard: { label: "J", scope, tabs: [{ id: "t", label: "T", blocks: [{ kind: "stats", query: makeFunctionReference<"query">("orgs:get"), items: [{ label: "n", path: "" }] }] }] } });
    expect(() => composeApp({ schema: appSchema, functions: pinned, app: spec("global") })).toThrow(/orgs:get runs in "org" shards, but a scope "global" screen runs on global:main/);
    expect(composeApp({ schema: appSchema, functions: pinned, app: spec("shard") }).dashboards).toHaveLength(1);
    expect(() => defineApp({ dashboard: { label: "J", tabs: [{ id: "t", label: "T", blocks: [{ kind: "stats", query: "jobs:list" as never, items: [{ label: "n", path: "x" }] }] }] } })).toThrow(/not a string/);
  });
});
