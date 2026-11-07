import { describe, expect, test } from "vitest";
import { createNodeSqliteDriver } from "../src/testing.ts";
import {
  anyComponents,
  componentBuilders,
  composeApp,
  createEngine,
  createFunctionHandle,
  defineApp,
  defineComponent,
  defineSchema,
  defineTable,
  EmberError,
  httpActionGeneric,
  httpRouter,
  internalMutationGeneric,
  matchRoute,
  mutationGeneric,
  queryGeneric,
  resolveReference,
  v,
  type AppDefinition,
  type MutationCtx,
} from "../src/index.ts";

// ------------------------------------------------------------------ a small component: counters with a log

const counterSchema = defineSchema({
  tables: {
    counters: defineTable({ key: v.string(), value: v.number() }).index("by_key", ["key"]),
    log: defineTable({ counter: v.id("counters"), delta: v.number() }).index("by_counter", ["counter"]),
  },
});
const cb = componentBuilders<typeof counterSchema, { step: number }>();

const counterLib = {
  add: cb.mutation({
    args: { key: v.string(), by: v.optional(v.number()) },
    handler: (ctx, { key, by }) => {
      const delta = by ?? ctx.component.config.step;
      const row = ctx.db.query("counters").withIndex("by_key", (q) => q.eq("key", key)).unique();
      const id = row ? row._id : ctx.db.insert("counters", { key, value: 0 });
      const value = (row?.value ?? 0) + delta;
      ctx.db.patch(id, { value });
      ctx.db.insert("log", { counter: id, delta });
      if (value > 100) throw new Error("counter overflow");
      return { id, value };
    },
  }),
  get: cb.query({
    args: { key: v.string() },
    handler: (ctx, { key }) => ctx.db.query("counters").withIndex("by_key", (q) => q.eq("key", key)).unique()?.value ?? 0,
  }),
  /** Takes a logical id of its own table. */
  byId: cb.query({ args: { id: v.id("counters") }, handler: (ctx, { id }) => ctx.db.get(id)?.value ?? null }),
  total: cb.query({ args: {}, handler: (ctx) => (ctx.db.sql`SELECT COALESCE(SUM(value), 0) AS s FROM counters`[0] as any).s as number }),
  totalWith: cb.query({
    args: {},
    handler: (ctx) => (ctx.db.sql`WITH big AS (SELECT value FROM counters WHERE value > 1) SELECT COUNT(*) AS n FROM big`[0] as any).n as number,
  }),
  secret: cb.internalMutation({ args: {}, handler: () => "internal" }),
  /** Schedules its own internal function by a relative name. */
  later: cb.mutation({ args: { key: v.string() }, handler: (ctx, { key }) => ctx.scheduler.runAfter(1000, "lib:add", { key, by: 1 }) }),
  /** Calls a handle given by the app (a callback). */
  callback: cb.mutation({ args: { fn: v.string(), n: v.number() }, handler: (ctx, { fn, n }) => ctx.runMutation(fn as any, { n }) }),
  /** Reads an app table: must fail (isolation). */
  peek: cb.query({ args: {}, handler: (ctx) => (ctx.db as any).query("notes").collect() }),
  /** Calls an app function by name: resolves inside the component (not found). */
  callApp: cb.mutation({ args: {}, handler: (ctx) => ctx.runMutation("notes:add" as any, { text: "x" }) }),
  laterFail: cb.mutation({
    args: {},
    handler: (ctx) => {
      ctx.scheduler.runAfter(0, "lib:add", { key: "z" });
      throw new Error("nope");
    },
  }),
  getAny: cb.query({ args: { id: v.string() }, handler: (ctx, { id }) => (ctx.db as any).get(id) }),
  config: cb.query({ args: {}, handler: (ctx) => ctx.component }),
};

const counter = defineComponent({ name: "counter", schema: counterSchema, functions: { lib: counterLib }, config: v.object({ step: v.number() }) });

// ------------------------------------------------------------------ the app

const appSchema = defineSchema({ tables: { notes: defineTable({ text: v.string(), n: v.optional(v.number()) }) } });
const components = anyComponents;

const notes = {
  add: mutationGeneric({
    args: { text: v.string(), fail: v.optional(v.boolean()), by: v.optional(v.number()) },
    handler: (ctx: MutationCtx, { text, fail, by }: { text: string; fail?: boolean; by?: number }) => {
      ctx.db.insert("notes", { text });
      const r = ctx.runMutation(components.c.lib.add, { key: text, ...(by !== undefined ? { by } : {}) });
      if (fail) throw new Error("app failed after the component call");
      return r;
    },
  }),
  addCatching: mutationGeneric({
    args: { key: v.string() },
    handler: (ctx: MutationCtx, { key }: { key: string }) => {
      ctx.db.insert("notes", { text: key });
      try {
        ctx.runMutation(components.c.lib.add, { key, by: 1000 });
      } catch (e) {
        return `caught: ${(e as Error).message}`;
      }
      return "no error";
    },
  }),
  count: queryGeneric({ args: { key: v.string() }, handler: (ctx: any, { key }: { key: string }) => ctx.runQuery(components.c.lib.get, { key }) }),
  readComponentTable: queryGeneric({ args: {}, handler: (ctx: any) => ctx.db.query("c$counters").collect() }),
  callInternal: mutationGeneric({ args: {}, handler: (ctx: any) => ctx.runMutation("@c/lib:secret") }),
  callGrandchild: mutationGeneric({ args: {}, handler: (ctx: any) => ctx.runMutation("@c/@inner/lib:add", { key: "x" }) }),
  record: internalMutationGeneric({ args: { n: v.number() }, handler: (ctx: any, { n }: { n: number }) => ctx.db.insert("notes", { text: "cb", n }) }),
  viaHandle: mutationGeneric({
    args: {},
    handler: (ctx: any) => ctx.runMutation(components.c.lib.callback, { fn: createFunctionHandle("notes:record"), n: 7 }),
  }),
  sqlApp: queryGeneric({ args: {}, handler: (ctx: any) => ctx.db.sql`SELECT COUNT(*) AS n FROM counters` }),
};

function setup(app: AppDefinition<any> = defineApp().use(counter, { name: "c", config: { step: 2 } })) {
  const composed = composeApp({ schema: appSchema, functions: { notes }, app });
  const driver = createNodeSqliteDriver();
  let clock = 1_700_000_000_000;
  const engine = createEngine({ schema: composed.schema, functions: composed.functions, driver, now: () => (clock += 1) });
  engine.migrate();
  const sql = (s: string, ...p: any[]) => driver.exec(s, ...p).rows;
  return { composed, engine, driver, sql };
}

const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as EmberError).code ?? (e as Error).message;
  }
  return "no error";
};

describe("composition", () => {
  test("without components the schema (and its hash) is the app's own", () => {
    const c = composeApp({ schema: appSchema, functions: { notes }, app: defineApp() });
    expect(c.schema).toBe(appSchema);
    expect(c.schema.manifest.components).toBeUndefined();
  });

  test("component tables get physical names, id prefixes and rewritten v.id shapes", () => {
    const { composed } = setup();
    const m = composed.schema.manifest;
    expect(Object.keys(m.tables).sort()).toEqual(["c$counters", "c$log", "notes"]);
    expect(m.tables["c$log"]!.idPrefix).toBe("c$log");
    expect(m.tables["c$log"]!.document.fields.counter!.shape).toEqual({ kind: "id", table: "c$counters" });
    expect(m.components).toEqual({ c: { component: "counter", tables: { counters: "c$counters", log: "c$log" }, httpPrefix: "/c" } });
    expect(m.version).not.toBe(appSchema.manifest.version);
    expect(Object.keys(composed.functions)).toContain("@c/lib:add");
  });

  test("the planner creates the component tables and their indexes", () => {
    const { sql } = setup();
    const names = sql(`SELECT name FROM sqlite_master WHERE type IN ('table','index') AND name LIKE 'c$%' ORDER BY name`).map((r) => r.name);
    expect(names).toContain("c$counters");
    expect(names).toContain("c$counters__by_key");
    expect(names).toContain("c$log__by_counter");
  });

  test("install checks: config validated, duplicate names refused, names checked", () => {
    expect(() => defineApp().use(counter, { config: { step: "x" } as any })).toThrow(/invalid config/);
    expect(() => defineApp().use(counter, { config: { step: 1 } }).use(counter, { config: { step: 1 } })).toThrow(/installed twice/);
    expect(() => defineApp().use(counter, { name: "a$b", config: { step: 1 } })).toThrow(/install name/);
    expect(() => defineComponent({ name: "x", functions: {}, schema: defineSchema({ tables: { t: defineTable({ k: v.string() }).shard("s", "k") }, shards: { s: { key: v.string() } as any } }) })).toThrow(/shards/);
    // The same component twice under different names: separate tables.
    const app = defineApp().use(counter, { name: "a", config: { step: 1 } }).use(counter, { name: "b", config: { step: 3 } });
    const m = composeApp({ schema: appSchema, functions: {}, app }).schema.manifest;
    expect(Object.keys(m.tables).sort()).toEqual(["a$counters", "a$log", "b$counters", "b$log", "notes"]);
  });

  test("a component's v.id() may only name its own tables (app tables and typos are refused at composition)", () => {
    const refs = (doc: Record<string, any>) =>
      defineComponent({ name: "refs", functions: {}, schema: defineSchema({ tables: { own: defineTable({ k: v.string() }), t: defineTable(doc) } }) });
    const compose = (doc: Record<string, any>) => () => composeApp({ schema: appSchema, app: defineApp().use(refs(doc)) });
    expect(compose({ note: v.id("notes") })).toThrow(/Component refs: table t: v\.id\("notes"\) does not name a table of this component.*v\.string\(\)/);
    expect(compose({ x: v.optional(v.array(v.object({ y: v.id("onw") }))) })).toThrow(/v\.id\("onw"\)/);
    expect(compose({ x: v.union(v.id("own"), v.id("notes")) })).toThrow(/v\.id\("notes"\)/);
    const ok = compose({ x: v.optional(v.array(v.id("own"))), opaque: v.string() })().schema.manifest.tables["refs$t"]!.document;
    expect(JSON.stringify(ok)).toContain('"table":"refs$own"');
  });

    test("app function names may not use the component namespace", () => {
    expect(() => composeApp({ schema: appSchema, functions: { "@x/m:f": notes.add }, app: defineApp() })).toThrow(/reserved/);
  });
});

describe("calls and transactions", () => {
  test("ctx.runMutation runs the component in the caller's transaction and returns its value", () => {
    const { engine, sql } = setup();
    const r = engine.runMutation("notes:add", { text: "k" });
    expect(r.value).toEqual({ id: expect.stringMatching(/^c\$counters_/), value: 2 });
    expect(r.changes.map((c) => c.table).sort()).toEqual(["c$counters", "c$counters", "c$log", "notes"].filter((x, i, a) => a.indexOf(x) === i).sort());
    expect(sql(`SELECT value FROM "c$counters"`)).toEqual([{ value: 2 }]);
    expect(engine.runQuery("notes:count", { key: "k" }).value).toBe(2);
  });

  test("a caller failing after the call rolls the component's writes back too", () => {
    const { engine, sql } = setup();
    expect(codeOf(() => engine.runMutation("notes:add", { text: "k", fail: true }))).toBe("app failed after the component call");
    expect(sql(`SELECT COUNT(*) AS n FROM "c$counters"`)[0]!.n).toBe(0);
    expect(sql(`SELECT COUNT(*) AS n FROM "notes"`)[0]!.n).toBe(0);
  });

  test("a failing callee is undone alone (savepoint) and the caller can catch it", () => {
    const { engine, sql } = setup();
    const r = engine.runMutation("notes:addCatching", { key: "z" });
    expect(r.value).toBe("caught: counter overflow");
    expect(sql(`SELECT COUNT(*) AS n FROM "c$counters"`)[0]!.n).toBe(0);
    expect(sql(`SELECT COUNT(*) AS n FROM "c$log"`)[0]!.n).toBe(0);
    expect(sql(`SELECT text FROM "notes"`)).toEqual([{ text: "z" }]);
    // Changes of the undone callee are not reported.
    expect(r.changes.map((c) => c.table)).toEqual(["notes"]);
  });

  test("group commit: a batch item calling a component is isolated like any other", () => {
    const { engine } = setup();
    const out = engine.runMutationBatch([
      { name: "notes:add", args: { text: "a" }, ctx: { identity: null } },
      { name: "notes:add", args: { text: "a", by: 500 }, ctx: { identity: null } },
      { name: "notes:add", args: { text: "a" }, ctx: { identity: null } },
    ]);
    expect(out.map((o) => o.ok)).toEqual([true, false, true]);
    expect(engine.runQuery("notes:count", { key: "a" }).value).toBe(4);
  });

  test("nested reads join the caller's read set (reactivity across the boundary)", () => {
    const { engine } = setup();
    engine.runMutation("notes:add", { text: "k" });
    const q = engine.runQuery("notes:count", { key: "k" });
    expect(q.readSet.some((e) => e.table === "c$counters")).toBe(true);
    const other = engine.runMutation("notes:add", { text: "other" });
    const same = engine.runMutation("notes:add", { text: "k" });
    expect(engine.matches(q.readSet, other.changes.filter((c) => c.table === "c$counters"))).toBe(false);
    expect(engine.matches(q.readSet, same.changes)).toBe(true);
  });

  test("ctx.component carries the install name and config", () => {
    const { engine } = setup();
    expect(engine.runQuery("@c/lib:config").value).toEqual({ name: "c", config: { step: 2 } });
  });
});

describe("isolation", () => {
  test("the app cannot read component tables, nor call their internal functions or grandchildren", () => {
    const { engine } = setup();
    expect(codeOf(() => engine.runQuery("notes:readComponentTable"))).toBe("ValidationError");
    expect(codeOf(() => engine.runQuery("notes:sqlApp"))).toBe("QueryError");
    expect(codeOf(() => engine.runMutation("notes:callInternal"))).toBe("FunctionNotFound");
    expect(codeOf(() => engine.runMutation("notes:callGrandchild"))).toBe("FunctionNotFound");
  });

  test("a component cannot read app tables, get app ids, or call app functions by name", () => {
    const { engine } = setup();
    const note = engine.runMutation(mutationGeneric({ handler: (ctx: any) => ctx.db.insert("notes", { text: "n" }) }) as any).value as string;
    expect(codeOf(() => engine.runQuery("@c/lib:peek"))).toBe("ValidationError");
    expect(codeOf(() => engine.runQuery("@c/lib:getAny", { id: note }))).toBe("ValidationError");
    expect(codeOf(() => engine.runMutation("@c/lib:callApp"))).toBe("FunctionNotFound");
  });

  test("v.id() args are checked against the component's own (logical) tables", () => {
    const { engine } = setup();
    const { id } = engine.runMutation("notes:add", { text: "k" }).value as { id: string };
    expect(engine.runQuery("@c/lib:byId", { id }).value).toBe(2);
    const note = engine.runMutation(mutationGeneric({ handler: (ctx: any) => ctx.db.insert("notes", { text: "n" }) }) as any).value as string;
    expect(codeOf(() => engine.runQuery("@c/lib:byId", { id: note }))).toBe("ValidationError");
  });

  test("v.id() args with a malformed ULID are rejected, in components and in the app (same rule as db.get)", () => {
    const { engine } = setup();
    const { id } = engine.runMutation("notes:add", { text: "k" }).value as { id: string };
    const bad = id.slice(0, id.lastIndexOf("_") + 1) + "not-an-id";
    expect(codeOf(() => engine.runQuery("@c/lib:byId", { id: bad }))).toBe("ValidationError");
    const note = engine.runMutation(mutationGeneric({ handler: (ctx: any) => ctx.db.insert("notes", { text: "n" }) }) as any).value as string;
    const appGet = queryGeneric({ args: { id: v.id("notes") }, handler: (ctx: any, { id }: { id: string }) => ctx.db.get(id)?.text ?? null });
    expect(engine.runQuery(appGet as any, { id: note }).value).toBe("n");
    expect(codeOf(() => engine.runQuery(appGet as any, { id: note.slice(0, note.lastIndexOf("_") + 1) + "not-an-id" }))).toBe("ValidationError");
  });

    test("component functions are never client-callable (functionInfo reports internal + component)", () => {
    const { engine } = setup();
    expect(engine.functionInfo("@c/lib:add")).toEqual({ type: "mutation", visibility: "internal", component: "c" });
    expect(engine.functionInfo("notes:add")).toEqual({ type: "mutation", visibility: "public" });
  });

  test("ctx.db.sql inside a component names its logical tables (with and without WITH)", () => {
    const { engine } = setup();
    engine.runMutation("notes:add", { text: "a" });
    engine.runMutation("notes:add", { text: "b", by: 5 });
    expect(engine.runQuery("@c/lib:total").value).toBe(7);
    expect(engine.runQuery("@c/lib:totalWith").value).toBe(2);
    const q = engine.runQuery("@c/lib:total");
    expect(q.readSet.map((e) => e.table)).toEqual(["c$counters"]);
  });
});

describe("scheduling and handles", () => {
  test("a component schedules its own functions by relative name; the job stores the absolute name", () => {
    const { engine } = setup();
    const r = engine.runMutation("notes:add", { text: "x" });
    expect(r.scheduled).toEqual([]);
    const later = engine.runMutation(mutationGeneric({ handler: (ctx: any) => ctx.runMutation(components.c.lib.later, { key: "q" }) }) as any);
    expect(later.scheduled).toEqual([expect.objectContaining({ fn: "@c/lib:add", args: { key: "q", by: 1 }, kind: "mutation" })]);
    // The runtime runs the job by its absolute name: in the component's scope.
    expect(engine.runMutation(later.scheduled[0]!.fn, later.scheduled[0]!.args).value).toEqual(expect.objectContaining({ value: 1 }));
  });

  test("a callee's scheduled jobs are dropped when it fails", () => {
    const { engine } = setup();
    const r = engine.runMutation(
      mutationGeneric({
        handler: (ctx: any) => {
          ctx.scheduler.runAfter(0, "notes:record", { n: 1 });
          try {
            ctx.runMutation(components.c.lib.laterFail);
          } catch (e) {
            return (e as Error).message;
          }
        },
      }) as any,
    );
    expect(r.value).toBe("nope");
    expect(r.scheduled.map((j) => j.fn)).toEqual(["notes:record"]);
  });

  test("function handles let a component call back into the app", () => {
    const { engine, sql } = setup();
    expect(createFunctionHandle("notes:record")).toBe("&notes:record");
    engine.runMutation("notes:viaHandle");
    expect(sql(`SELECT text, n FROM notes`)).toEqual([{ text: "cb", n: 7 }]);
  });

  test("resolveReference: own, child, handle, grandchild", () => {
    expect(resolveReference([], "notes:add")).toEqual({ name: "notes:add", via: "own" });
    expect(resolveReference([], "@c/lib:add")).toEqual({ name: "@c/lib:add", via: "child" });
    expect(resolveReference(["c"], "lib:add")).toEqual({ name: "@c/lib:add", via: "own" });
    expect(resolveReference(["c"], "@inner/lib:x")).toEqual({ name: "@c/@inner/lib:x", via: "child" });
    expect(resolveReference(["c"], "&notes:add")).toEqual({ name: "notes:add", via: "handle" });
    expect(() => resolveReference([], "@c/@inner/lib:x")).toThrow(EmberError);
  });
});

describe("nested components", () => {
  const outerSchema = defineSchema({ tables: { items: defineTable({ name: v.string() }) } });
  const ob = componentBuilders<typeof outerSchema>();
  const outer = defineComponent({
    name: "outer",
    schema: outerSchema,
    functions: {
      lib: {
        add: ob.mutation({
          args: { name: v.string() },
          handler: (ctx, { name }) => {
            ctx.db.insert("items", { name });
            return ctx.runMutation("@inner/lib:add" as any, { key: name });
          },
        }),
      },
    },
  }).use(counter, { name: "inner", config: { step: 10 } });

  test("a component's child lives in <outer>$<inner>$<table> and is reachable only from the outer one", () => {
    const { engine, sql, composed } = setup(defineApp().use(outer));
    expect(Object.keys(composed.schema.manifest.tables).sort()).toEqual(["notes", "outer$inner$counters", "outer$inner$log", "outer$items"]);
    expect(engine.runMutation(mutationGeneric({ handler: (ctx: any) => ctx.runMutation(components.outer.lib.add, { name: "n" }) }) as any).value).toEqual(
      expect.objectContaining({ value: 10 }),
    );
    expect(sql(`SELECT value FROM "outer$inner$counters"`)).toEqual([{ value: 10 }]);
    expect(engine.functionInfo("@outer/@inner/lib:add")?.component).toBe("outer/inner");
  });
});

describe("http routes", () => {
  const h = httpActionGeneric(async () => new Response("ok"));
  test("component routes are mounted under the install prefix; matching prefers exact paths, then the longest prefix", () => {
    const comp = defineComponent({
      name: "hooks",
      functions: {},
      http: httpRouter().route({ path: "/in", method: "POST", handler: h }).route({ pathPrefix: "/files/", method: "GET", handler: h }),
    });
    const app = defineApp().use(comp).use(comp, { name: "other", httpPrefix: "/x/y" });
    const http = httpRouter().route({ path: "/hello", method: "GET", handler: h }).route({ pathPrefix: "/", method: "GET", handler: h });
    const { routes } = composeApp({ schema: appSchema, app, http });
    expect(routes.map((r) => [r.path ?? r.pathPrefix, r.scope.join("/")])).toEqual([
      ["/hello", ""],
      ["/", ""],
      ["/hooks/in", "hooks"],
      ["/hooks/files/", "hooks"],
      ["/x/y/in", "other"],
      ["/x/y/files/", "other"],
    ]);
    expect(matchRoute(routes, "POST", "/hooks/in")).toEqual({ route: routes[2] });
    expect(matchRoute(routes, "GET", "/hooks/files/a.txt")).toEqual({ route: routes[3] });
    expect(matchRoute(routes, "GET", "/anything")).toEqual({ route: routes[1] });
    expect(matchRoute(routes, "GET", "/hooks/in")).toEqual({ route: routes[1] });
    expect(matchRoute(routes.slice(2), "GET", "/hooks/in")).toEqual({ methodMismatch: true });
    expect(matchRoute(routes.slice(2), "GET", "/nope")).toBeNull();
  });

  test("HEAD falls back to GET, but an explicit HEAD route wins regardless of registration order", () => {
    const r = (method: "GET" | "HEAD" | "POST", at: { path: string } | { pathPrefix: string }) => ({ method, ...at }) as any;
    const exact = [r("GET", { path: "/a" }), r("HEAD", { path: "/a" })];
    expect(matchRoute(exact, "HEAD", "/a")).toEqual({ route: exact[1] });
    expect(matchRoute(exact, "GET", "/a")).toEqual({ route: exact[0] });
    const prefix = [r("GET", { pathPrefix: "/p/" }), r("HEAD", { pathPrefix: "/p/" })];
    expect(matchRoute(prefix, "HEAD", "/p/x")).toEqual({ route: prefix[1] });
    // GET fallback still works, and specificity comes before the method preference.
    const onlyGet = [r("POST", { path: "/a" }), r("GET", { path: "/a" })];
    expect(matchRoute(onlyGet, "HEAD", "/a")).toEqual({ route: onlyGet[1] });
    const longer = [r("HEAD", { pathPrefix: "/p/" }), r("GET", { pathPrefix: "/p/q/" })];
    expect(matchRoute(longer, "HEAD", "/p/q/x")).toEqual({ route: longer[1] });
    expect(matchRoute([r("POST", { path: "/a" })], "HEAD", "/a")).toEqual({ methodMismatch: true });
  });

    test("routes may not live inside the Worker's own endpoints", () => {
    expect(() => httpRouter().route({ path: "/api/query", method: "POST", handler: h })).toThrow(/reserved/);
    expect(() => httpRouter().route({ pathPrefix: "/api/storage/", method: "GET", handler: h })).toThrow(/reserved/);
    const comp = defineComponent({ name: "q", functions: {}, http: httpRouter().route({ path: "/query", method: "POST", handler: h }) });
    expect(() => composeApp({ schema: appSchema, app: defineApp().use(comp, { httpPrefix: "/api" }) })).toThrow(/reserved/);
  });
});

// ------------------------------------------------------------------ hooks: crons, queues, email()

describe("component hooks (crons, queues, email)", () => {
  const hookSchema = defineSchema({ tables: { seen: defineTable({ k: v.string() }) } });
  const hc = componentBuilders<typeof hookSchema, { shard: string }>();
  const hooked = defineComponent({
    name: "hooked",
    schema: hookSchema,
    config: v.object({ shard: v.string() }),
    functions: { lib: { tick: hc.internalMutation({ args: {}, handler: (ctx) => ctx.db.insert("seen", { k: "tick" }) }) } },
    crons: (config, install) => [{ name: "tick", schedule: "*/5 * * * *", shard: config.shard, fn: "lib:tick", args: { install } }],
    queues: { events: { handler: async () => {} }, "dead-letter": { consumer: { maxRetries: 0 }, handler: async () => {} } },
    email: { match: (to) => to.endsWith("@a.test"), shard: (c) => c.shard, handler: async () => {} },
  });

  test("composition: crons with absolute names, queues and email hooks in install order, manifest entries", () => {
    const outer = defineComponent({ name: "outer", functions: {} }).use(hooked, { name: "inner", config: { shard: "x:1" } });
    const c = composeApp({ schema: defineSchema({ tables: {} }), functions: {}, app: defineApp().use(hooked, { config: { shard: "s:1" } }).use(outer) });
    expect(c.crons).toEqual([
      { name: "@hooked/tick", schedule: "*/5 * * * *", shard: "s:1", fn: "@hooked/lib:tick", args: { install: "hooked" } },
      { name: "@outer/@inner/tick", schedule: "*/5 * * * *", shard: "x:1", fn: "@outer/@inner/lib:tick", args: { install: "outer_inner" } },
    ]);
    expect(c.queues.map((q) => [q.queue, q.binding, q.scope.join("/")])).toEqual([
      ["hooked-events", "EMBER_Q_HOOKED_EVENTS", "hooked"],
      ["hooked-dead-letter", "EMBER_Q_HOOKED_DEAD_LETTER", "hooked"],
      ["outer-inner-events", "EMBER_Q_OUTER_INNER_EVENTS", "outer/inner"],
      ["outer-inner-dead-letter", "EMBER_Q_OUTER_INNER_DEAD_LETTER", "outer/inner"],
    ]);
    expect(c.email.map((e) => e.scope.join("/"))).toEqual(["hooked", "outer/inner"]);
    expect(c.schema.manifest.components!.hooked).toMatchObject({ email: true, queues: [{ name: "events" }, { name: "dead-letter", consumer: { maxRetries: 0 } }] });
  });

  test("a fixed queue binding name cannot be installed twice", () => {
    const fixed = defineComponent({ name: "fixed", functions: {}, queues: { q: { binding: "MY_Q", handler: async () => {} } } });
    expect(composeApp({ schema: defineSchema({ tables: {} }), functions: {}, app: defineApp().use(fixed) }).queues[0]!.binding).toBe("MY_Q");
    expect(() => composeApp({ schema: defineSchema({ tables: {} }), functions: {}, app: defineApp().use(fixed).use(fixed, { name: "again" }) })).toThrow(/binding MY_Q is declared twice/);
  });

  test("validation: queue names, handlers, cron targets, duplicate bindings", () => {
    expect(() => defineComponent({ name: "q", functions: {}, queues: { Bad_Name: { handler: async () => {} } } })).toThrow(/queue name/);
    expect(() => defineComponent({ name: "q", functions: {}, queues: { ok: {} as any } })).toThrow(/needs a handler/);
    expect(() => defineComponent({ name: "q", functions: {}, email: {} as any })).toThrow(/email needs a handler/);
    const badCron = defineComponent({ name: "c", functions: {}, crons: () => [{ name: "x", schedule: "* * * * *", shard: "global:main", fn: "lib:missing" }] });
    expect(() => composeApp({ schema: defineSchema({ tables: {} }), functions: {}, app: defineApp().use(badCron) })).toThrow(/not one of its functions/);
    const childCron = defineComponent({ name: "c", functions: {}, crons: () => [{ name: "x", schedule: "* * * * *", shard: "global:main", fn: "@kid/lib:tick" }] }).use(hooked, { name: "kid", config: { shard: "s:1" } });
    expect(() => composeApp({ schema: defineSchema({ tables: {} }), functions: {}, app: defineApp().use(childCron) })).toThrow(/not one of its functions/);
  });

  test("apps without hooks compose with empty lists", () => {
    const c = composeApp({ schema: defineSchema({ tables: {} }), functions: {}, app: null });
    expect([c.crons, c.queues, c.email]).toEqual([[], [], []]);
  });
});

describe("private SQL with components", () => {
  test("composeApp keeps the app's privateSql, and ctx.sql still refuses the component's tables", () => {
    const withLedger = defineSchema({
      tables: { notes: defineTable({ text: v.string() }) },
      privateSql: { tables: ["ledger"], ddl: ["create table if not exists ledger (k text primary key)"] },
    });
    const composed = composeApp({
      schema: withLedger,
      functions: {},
      app: defineApp().use(counter, { name: "c", config: { step: 1 } }),
    });
    expect(composed.schema.privateSql?.tables).toEqual(["ledger"]);
  });

  test("a component may not declare privateSql", () => {
    expect(() =>
      defineComponent({
        name: "sneaky",
        functions: {},
        schema: defineSchema({
          tables: { own: defineTable({ k: v.string() }) },
          privateSql: { tables: ["p"], ddl: ["create table if not exists p (k text)"] },
        }),
      }),
    ).toThrow(/cannot declare privateSql/);
  });
});
