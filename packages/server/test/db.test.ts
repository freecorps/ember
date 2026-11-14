import { describe, expect, test } from "vitest";
import { createNodeSqliteDriver } from "../src/testing.ts";
import {
  actionGeneric,
  createEngine,
  defineSchema,
  defineShard,
  defineTable,
  EmberError,
  internalMutationGeneric,
  makeFunctionReference,
  mutationGeneric,
  parseId,
  queryGeneric,
  resolveLocationHint,
  v,
} from "../src/index.ts";
import { fresh, withUser } from "./fixtures.ts";

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as EmberError).code ?? (e as Error).message;
  }
  return "no error";
};

describe("ctx.db writes and reads", () => {
  test("insert / get / patch / replace / delete with change capture", () => {
    const s = fresh();
    const author = withUser(s);
    const ins = s.tx((db) => db.insert("messages", { channel: "a", author, body: "hi", likes: 1 }));
    const id = ins.value as string;
    expect(parseId(id)?.prefix).toBe("msg");
    expect(ins.changes).toEqual([{ table: "messages", id, before: null, after: expect.objectContaining({ _id: id, body: "hi" }) }]);
    const got = s.run((db) => db.get(id as any)).value as any;
    expect(got).toEqual({ _id: id, _creationTime: expect.any(Number), channel: "a", author, body: "hi", likes: 1 });
    expect(Object.keys(got)).toEqual(["_id", "_creationTime", "channel", "author", "body", "likes"]);

    const p = s.patch(id, { likes: 2, meta: { edited: true, tags: ["x"] } });
    expect(p.changes[0].before.likes).toBe(1);
    expect(p.changes[0].after).toMatchObject({ likes: 2, meta: { edited: true, tags: ["x"] } });
    expect(s.patch(id, { meta: undefined }).changes[0].after.meta).toBeUndefined();

    s.tx((db) => db.replace(id as any, { channel: "b", author, body: "new", likes: 0 } as any));
    expect(s.run((db) => db.get(id as any)).value).toMatchObject({ channel: "b", body: "new", likes: 0, _creationTime: got._creationTime });

    const d = s.del(id);
    expect(d.changes).toEqual([{ table: "messages", id, before: expect.objectContaining({ body: "new" }), after: null }]);
    expect(s.run((db) => db.get(id as any)).value).toBeNull();
  });

  test("multiple writes to one row merge into one change; insert+delete is no change", () => {
    const s = fresh();
    const author = withUser(s);
    const r = s.tx((db) => {
      const a = db.insert("messages", { channel: "a", author, body: "x", likes: 0 } as any);
      db.patch(a, { likes: 1 } as any);
      db.patch(a, { likes: 2 } as any);
      const b = db.insert("messages", { channel: "a", author, body: "y", likes: 0 } as any);
      db.delete(b);
      return a;
    });
    expect(r.changes).toHaveLength(1);
    expect(r.changes[0]).toMatchObject({ before: null, after: { likes: 2 } });
  });

  test("validation, system fields, ids", () => {
    const s = fresh();
    const author = withUser(s);
    expect(code(() => s.tx((db) => db.insert("messages", { channel: 1, author, body: "x", likes: 0 } as any)))).toBe("ValidationError");
    expect(code(() => s.tx((db) => db.insert("messages", { channel: "a", author: "users_x", body: "x", likes: 0 } as any)))).toBe("ValidationError");
    const msg = s.insert("messages", { channel: "a", author, body: "x", likes: 0 });
    // An id of the wrong table is rejected.
    expect(code(() => s.tx((db) => db.insert("messages", { channel: "a", author: msg, body: "x", likes: 0 } as any)))).toBe("ValidationError");
    expect(code(() => s.tx((db) => db.insert("messages", { _id: "x", channel: "a", author, body: "x", likes: 0 } as any)))).toBe("ValidationError");
    expect(code(() => s.patch(msg, { _creationTime: 5 }))).toBe("ValidationError");
    // Passing system fields unchanged is fine (replace with a full doc).
    const doc = s.run((db) => db.get(msg as any)).value as any;
    s.tx((db) => db.replace(msg as any, { ...doc, likes: 3 }));
    expect(code(() => s.patch("msg_01ARZ3NDEKTSV4RRFFQ69G5FAV", { likes: 1 }))).toBe("NotFound");
    expect(code(() => s.tx((db) => db.insert("nope", {} as any)))).toBe("ValidationError");
    expect(s.run((db) => db.get("nope_01ARZ3NDEKTSV4RRFFQ69G5FAV" as any)).value).toBeNull();
    expect(s.run((db) => db.normalizeId("messages", msg))).toMatchObject({ value: msg });
    expect(s.run((db) => db.normalizeId("users", msg))).toMatchObject({ value: null });
  });

  test("values that need care round-trip: int64, bytes, NaN, -0, Infinity, null vs absent", () => {
    const sch = defineSchema({
      tables: {
        t: defineTable({
          big: v.int64(),
          raw: v.bytes(),
          n: v.number(),
          m: v.optional(v.number()),
          nn: v.nullable(v.string()),
          on: v.optional(v.nullable(v.string())),
          flag: v.boolean(),
          lit: v.union(v.literal(1n), v.literal(2n)),
          nested: v.object({ big: v.int64(), b: v.bytes(), f: v.number() }),
        }),
      },
    });
    const s = fresh({ schema: sch });
    const cases = [
      { big: -(2n ** 63n), raw: new Uint8Array([0, 1, 255]), n: NaN, nn: null, flag: true, lit: 1n, nested: { big: 2n ** 63n - 1n, b: new Uint8Array([]), f: -0 } },
      { big: 0n, raw: new Uint8Array(), n: -0, m: Infinity, nn: "x", on: null, flag: false, lit: 2n, nested: { big: 1n, b: new Uint8Array([7]), f: -Infinity } },
      { big: 5n, raw: new Uint8Array([1]), n: 1.5, on: "y", flag: false, nn: null, lit: 2n, nested: { big: 1n, b: new Uint8Array([7]), f: 0 } },
    ];
    for (const c of cases) {
      const id = s.insert("t", c);
      const got = s.run((db) => db.get(id as any)).value as any;
      const { _id, _creationTime, ...rest } = got;
      expect(rest).toEqual(c);
      expect(Object.is(rest.n, c.n)).toBe(true);
      expect(Object.is(rest.nested.f, c.nested.f)).toBe(true);
      expect("on" in rest).toBe("on" in c);
    }
    // Typed columns really are typed: STRICT table, int64 as TEXT, bool as INTEGER.
    const row = s.sql(`SELECT typeof("big") AS b, typeof("flag") AS f, typeof("raw") AS r FROM "t" LIMIT 1`)[0];
    expect(row).toEqual({ b: "text", f: "integer", r: "blob" });
  });

  test("wide rows are written in chunks (100 bound parameters max)", () => {
    const fields = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`f${i}`, v.number()]));
    let table = defineTable(fields) as any;
    for (let i = 0; i < 40; i++) table = table.index(`i${i}`, [`f${i}`]);
    const s = fresh({ schema: defineSchema({ tables: { wide: table } }) });
    const doc = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`f${i}`, i]));
    const id = s.insert("wide", doc);
    expect(s.run((db) => db.get(id as any)).value).toMatchObject(doc);
    s.patch(id, { f39: 100 });
    expect((s.run((db) => db.query("wide").withIndex("i39", (q: any) => q.eq("f39", 100)).collect()).value as any[]).map((d) => d._id)).toEqual([id]);
  });
});

describe("limits", () => {
  test("rows read / written / document size -> typed errors, transaction rolled back", () => {
    const s = fresh({ limits: { rowsRead: 10, rowsWritten: 5, documentSize: 1000 } });
    const author = withUser(s);
    expect(code(() => s.tx((db) => { for (let i = 0; i < 6; i++) db.insert("messages", { channel: "a", author, body: "x", likes: i } as any); }))).toBe("TooManyWrites");
    expect(s.run((db) => db.query("messages").collect()).value).toEqual([]);
    for (let i = 0; i < 12; i++) s.insert("messages", { channel: "a", author, body: "x", likes: i });
    expect(code(() => s.run((db) => db.query("messages").take(9)))).toBe("no error");
    expect(code(() => s.run((db) => db.query("messages").collect()))).toBe("TooManyReads");
    expect(code(() => s.insert("messages", { channel: "a", author, body: "x".repeat(2000), likes: 0 }))).toBe("DocumentTooLarge");
  });

  test("default limits", () => {
    const s = fresh();
    const author = withUser(s);
    expect(code(() => s.insert("messages", { channel: "a", author, body: "x".repeat(2 * 1024 * 1024 + 1), likes: 0 }))).toBe("DocumentTooLarge");
  });
});

describe("functions", () => {
  test("async handlers are rejected at runtime and rolled back", () => {
    const s = fresh();
    const author = withUser(s);
    // @ts-expect-error mutation handlers must be synchronous
    const bad = mutationGeneric({
      handler: async (ctx) => {
        ctx.db.insert("messages", { channel: "a", author, body: "x", likes: 0 });
      },
    });
    expect(code(() => s.engine.runMutation(bad as any))).toBe("AsyncHandler");
    expect(s.run((db) => db.query("messages").collect()).value).toEqual([]);
    // @ts-expect-error query handlers must be synchronous too
    const badQ = queryGeneric(async () => 1);
    expect(code(() => s.engine.runQuery(badQ as any))).toBe("AsyncHandler");
  });

  test("args and returns are validated; functions resolve by name", () => {
    const send = mutationGeneric({
      args: { channel: v.string(), n: v.optional(v.number()) },
      returns: v.string(),
      handler: (ctx, args) => {
        const author = ctx.db.insert("users", { name: "x", email: "e", admin: false });
        return ctx.db.insert("messages", { channel: args.channel, author, body: "b", likes: args.n ?? 0 });
      },
    });
    const wrongReturn = mutationGeneric({ returns: v.number(), handler: () => "x" });
    const count = queryGeneric({ args: {}, handler: (ctx) => ctx.db.query("messages").collect().length });
    const s = fresh({ functions: { messages: { send, wrongReturn, count } } });
    expect(typeof s.engine.runMutation("messages:send", { channel: "a" }).value).toBe("string");
    expect(code(() => s.engine.runMutation("messages:send", { channel: 1 }))).toBe("ValidationError");
    expect(code(() => s.engine.runMutation("messages:send", { channel: "a", extra: 1 }))).toBe("ValidationError");
    expect(code(() => s.engine.runMutation("messages:wrongReturn", {}))).toBe("ValidationError");
    expect(code(() => s.engine.runMutation("messages:nope", {}))).toBe("FunctionNotFound");
    expect(code(() => s.engine.runQuery("messages:send", {}))).toBe("InvalidFunction");
    expect(s.engine.runQuery("messages:count").value).toBe(1);
    expect(s.engine.runQuery(makeFunctionReference<"query">("messages:count")).value).toBe(1);
    expect(s.engine.functionInfo("messages:send")).toEqual({ type: "mutation", visibility: "public" });
  });

  test("sensitive: true is kept on mutations/actions and reported by functionInfo; refused on queries", () => {
    const transfer = mutationGeneric({ sensitive: true, handler: () => null });
    const plain = mutationGeneric({ sensitive: false, handler: () => null });
    expect(transfer.sensitive).toBe(true);
    expect("sensitive" in plain).toBe(false);
    expect(actionGeneric({ sensitive: true, handler: async () => 1 }).sensitive).toBe(true);
    expect(() => queryGeneric({ sensitive: true, handler: () => 1 } as never)).toThrow(/mutations and actions/);
    const s = fresh({ functions: { bank: { transfer, plain } } });
    expect(s.engine.functionInfo("bank:transfer")).toEqual({ type: "mutation", visibility: "public", sensitive: true });
    expect(s.engine.functionInfo("bank:plain")).toEqual({ type: "mutation", visibility: "public" });
  });

  test("defineShard: locationHint is a hint or { fromKey }, checked; resolveLocationHint reads the key", () => {
    expect(defineShard({ key: v.string(), locationHint: { fromKey: true } }).locationHint).toEqual({ fromKey: true });
    expect(() => defineShard({ key: v.string(), locationHint: { fromKey: false } as never })).toThrow(/fromKey/);
    expect(() => defineShard({ key: v.string(), locationHint: { fromKey: true, separator: "" } })).toThrow(/separator/);
    expect(resolveLocationHint("weur", "x")).toBe("weur");
    expect(resolveLocationHint({ fromKey: true }, "ws_1:me")).toBe("me");
    expect(resolveLocationHint({ fromKey: true }, "ws_1:xx")).toBeUndefined();
    expect(resolveLocationHint({ fromKey: true, fallback: "oc" }, "ws_1")).toBe("oc");
    expect(resolveLocationHint(undefined, "x")).toBeUndefined();
    expect(resolveLocationHint({ fromKey: true }, "ws_1:apac-ne")).toBe("apac-ne");
    // A multi-character separator that is not in the key: the whole key is the segment.
    expect(resolveLocationHint({ fromKey: true, separator: "::" }, "weur")).toBe("weur");
    expect(resolveLocationHint({ fromKey: true, separator: "::" }, "a:weur")).toBeUndefined();
    expect(resolveLocationHint({ fromKey: true, separator: "::" }, "ws::weur")).toBe("weur");
    expect(() => defineShard({ key: v.string(), locationHint: "wuer" as never })).toThrow(/unknown locationHint "wuer"/);
    expect(() => defineShard({ key: v.string(), locationHint: { fromKey: true, fallback: "mars" as never } })).toThrow(/fallback/);
  });

  test("dispatch and leaseMs are kept on actions; refused on queries and mutations, and checked", () => {
    const page = actionGeneric({ dispatch: "shard", handler: async () => 1 });
    const leased = actionGeneric({ leaseMs: 60_000.7, handler: async () => 1 });
    const queued = actionGeneric({ dispatch: "queue", handler: async () => 1 });
    expect(page.dispatch).toBe("shard");
    expect(leased.leaseMs).toBe(60_000);
    expect("dispatch" in queued).toBe(false);
    expect(() => mutationGeneric({ dispatch: "shard", handler: () => null } as never)).toThrow(/actions only/);
    expect(() => queryGeneric({ leaseMs: 5000, handler: () => 1 } as never)).toThrow(/actions only/);
    expect(() => actionGeneric({ dispatch: "elsewhere" as never, handler: async () => 1 })).toThrow(/"queue" or "shard"/);
    expect(() => actionGeneric({ leaseMs: 10, handler: async () => 1 })).toThrow(/at least 1000/);
  });

  test("ctx.now / ctx.random are deterministic per mutation; auth identity is passed", () => {
    const seen: unknown[] = [];
    const m = mutationGeneric((ctx) => {
      seen.push([ctx.now, ctx.random(), ctx.random(), ctx.auth.getUserIdentity()]);
      return null;
    });
    const mk = () => fresh({ functions: { m: { m } }, random: () => 0.25, now: () => 42 });
    mk().engine.runMutation("m:m", {}, { identity: { subject: "u1" } });
    mk().engine.runMutation("m:m", {}, { identity: null });
    expect(seen[0]).toEqual([42, (seen[1] as any[])[1], (seen[1] as any[])[2], { subject: "u1" }]);
    expect((seen[1] as any[])[3]).toBeNull();
  });

  test("scheduler returns jobs with the mutation result", () => {
    const later = internalMutationGeneric({ args: { x: v.number() }, handler: () => null });
    const act = { [Symbol.for("ember.function")]: true, type: "action", visibility: "internal", args: { kind: "object", fields: {} }, handler: async () => null };
    const m = mutationGeneric((ctx) => {
      const a = ctx.scheduler.runAfter(1000, "jobs:later", { x: 1 });
      const b = ctx.scheduler.runAt(new Date(5000), makeFunctionReference<"action">("jobs:act"));
      return [a, b];
    });
    const s = fresh({ functions: { jobs: { later, act, m } }, now: () => 100 });
    const r = s.engine.runMutation("jobs:m");
    expect(r.scheduled).toEqual([
      { id: (r.value as string[])[0], fn: "jobs:later", args: { x: 1 }, runAt: 1100, kind: "mutation" },
      { id: (r.value as string[])[1], fn: "jobs:act", args: {}, runAt: 5000, kind: "action" },
    ]);
    const bad = mutationGeneric((ctx) => ctx.scheduler.runAfter(0, "jobs:later", { x: "no" } as any));
    const s2 = fresh({ functions: { jobs: { later, bad } } });
    expect(code(() => s2.engine.runMutation("jobs:bad"))).toBe("ValidationError");
  });

  test("scheduler.cancel: same-mutation jobs are dropped, earlier ones are returned in `cancelled`", () => {
    const later = internalMutationGeneric({ args: { x: v.number() }, handler: () => null });
    const m = mutationGeneric({
      args: { cancel: v.optional(v.string()) },
      handler: (ctx, { cancel }) => {
        const a = ctx.scheduler.runAfter(10, "jobs:later", { x: 1 });
        const b = ctx.scheduler.runAfter(10, "jobs:later", { x: 2 });
        ctx.scheduler.cancel(a);
        if (cancel) {
          ctx.scheduler.cancel(cancel);
          ctx.scheduler.cancel(cancel);
        }
        return b;
      },
    });
    const s = fresh({ functions: { jobs: { later, m } } });
    const r = s.engine.runMutation("jobs:m", {});
    expect(r.scheduled.map((j) => j.args)).toEqual([{ x: 2 }]);
    expect(r.cancelled).toEqual([]);
    const r2 = s.engine.runMutation("jobs:m", { cancel: r.value as string });
    expect(r2.cancelled).toEqual([r.value]);
  });
});

describe("group commit", () => {
  test("one transaction, a failing item is rolled back alone", () => {
    const add = mutationGeneric({
      args: { email: v.string(), fail: v.optional(v.boolean()) },
      handler: (ctx, { email, fail }) => {
        const id = ctx.db.insert("users", { name: "n", email, admin: false });
        if (fail) throw new EmberError("ValidationError", "nope");
        return id;
      },
    });
    const s = fresh({ functions: { users: { add } } });
    const out = s.engine.runMutationBatch([
      { name: "users:add", args: { email: "a" }, ctx: { identity: null } },
      { name: "users:add", args: { email: "b", fail: true }, ctx: { identity: null } },
      { name: "users:missing", args: {}, ctx: { identity: null } },
      { name: "users:add", args: { email: "c" }, ctx: { identity: null } },
    ]);
    expect(out.map((r) => r.ok)).toEqual([true, false, false, true]);
    expect(out[1]).toEqual({ ok: false, error: { code: "ValidationError", message: "nope" } });
    expect(out[2]).toMatchObject({ ok: false, error: { code: "FunctionNotFound" } });
    expect(out[0]).toMatchObject({ ok: true, changes: [{ table: "users" }], scheduled: [] });
    const emails = (s.run((db) => db.query("users").collect()).value as any[]).map((u) => u.email);
    expect(emails).toEqual(["a", "c"]);
  });

  test("a batch without failures uses one savepoint; with a failure, every outcome matches item-by-item savepoints", () => {
    const add = mutationGeneric({
      args: { email: v.string(), fail: v.optional(v.boolean()), catchDup: v.optional(v.boolean()) },
      handler: (ctx, { email, fail }) => {
        const id = ctx.db.insert("users", { name: "n", email, admin: false });
        if (fail) throw new EmberError("ValidationError", `nope ${email}`);
        return id;
      },
    });
    const s = fresh({ functions: { users: { add } } });
    let savepoints = 0;
    const tx = s.driver.transaction.bind(s.driver);
    s.driver.transaction = ((fn: () => unknown) => {
      savepoints++;
      return tx(fn);
    }) as typeof s.driver.transaction;
    const items = (xs: Array<Record<string, unknown>>) => xs.map((args) => ({ name: "users:add", args, ctx: { identity: null } }));
    const ok = s.engine.runMutationBatch(items([{ email: "a" }, { email: "b" }, { email: "c" }, { email: "d" }]));
    expect(ok.every((r) => r.ok)).toBe(true);
    expect(savepoints).toBe(2); // the batch + its single savepoint (was 1 + one per item)
    savepoints = 0;
    const mixed = s.engine.runMutationBatch(items([{ email: "e" }, { email: "f", fail: true }, { email: "g" }, { email: "h", fail: true }, { email: "i" }]));
    expect(mixed.map((r) => (r.ok ? "ok" : r.error.message))).toEqual(["ok", "nope f", "ok", "nope h", "ok"]);
    const emails = (s.run((db) => db.query("users").collect()).value as any[]).map((u) => u.email);
    expect(emails).toEqual(["a", "b", "c", "d", "e", "g", "i"]);
    // The successful items' results are those of the committed run (their ids exist).
    for (const r of mixed) if (r.ok) expect(s.run((db) => db.get(r.value as never)).value).not.toBeNull();
  });

  test("the whole batch nests inside an outer runtime transaction", () => {
    const driver = createNodeSqliteDriver();
    const add = mutationGeneric({ args: { email: v.string() }, handler: (ctx, { email }) => ctx.db.insert("users", { name: "n", email, admin: false }) });
    const { schema } = { schema: defineSchema({ tables: { users: defineTable({ name: v.string(), email: v.string(), admin: v.boolean() }) } }) };
    const engine = createEngine({ schema, driver, functions: { users: { add } } });
    engine.migrate();
    expect(() =>
      driver.transaction(() => {
        engine.runMutationBatch([{ name: "users:add", args: { email: "a" }, ctx: { identity: null } }]);
        throw new Error("runtime failed to write its change log");
      }),
    ).toThrow();
    expect(driver.exec(`SELECT count(*) AS n FROM "users"`).rows[0]!.n).toBe(0);
  });
});
