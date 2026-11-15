import { describe, expect, expectTypeOf, test } from "vitest";
import { createNodeSqliteDriver } from "../src/testing.ts";
import {
  composeApp,
  createEngine,
  defineApp,
  defineComponent,
  defineSchema,
  defineTable,
  defineTriggers,
  EmberError,
  internalMutationGeneric,
  mutationGeneric,
  queryGeneric,
  v,
  type Change,
  type DataModelFromSchema,
  type DefineTriggers,
  type Limits,
  type RowChange,
} from "../src/index.ts";

const schema = defineSchema({
  tables: {
    rooms: defineTable({ name: v.string(), lastMessageAt: v.optional(v.number()), messages: v.optional(v.number()) }),
    messages: defineTable({ roomId: v.id("rooms"), body: v.string() }).index("by_room", ["roomId"]),
    audit: defineTable({ what: v.string() }).aggregate("total", { by: [], count: true }),
    plain: defineTable({ x: v.number() }),
  },
});
type DM = DataModelFromSchema<typeof schema>;

// Untyped on purpose (string refs, generic tables); typed triggers are checked in the last test.
type Ctx = any;
const m = (handler: (ctx: Ctx, a: any) => unknown, args: Record<string, any> = { a: v.optional(v.any()) }) => mutationGeneric({ args, handler: handler as any });

const fns = {
  t: {
    room: m((ctx, { a }) => ctx.db.insert("rooms", { name: a ?? "general" })),
    send: m((ctx, { a }) => ctx.db.insert("messages", { roomId: a.roomId, body: a.body })),
    edit: m((ctx, { a }) => ctx.db.patch(a.id, { body: a.body })),
    swap: m((ctx, { a }) => ctx.db.replace(a.id, { roomId: a.roomId, body: a.body })),
    drop: m((ctx, { a }) => ctx.db.delete(a.id)),
    bump: m((ctx, { a }) => ctx.db.increment(a, "messages", 1)),
    plain: m((ctx) => ctx.db.insert("plain", { x: 1 })),
    /** Sends, then catches a failing send: the failed insert and what its triggers did are undone alone. */
    catching: m((ctx, { a }) => {
      ctx.db.insert("messages", { roomId: a, body: "kept" });
      try {
        ctx.db.insert("messages", { roomId: a, body: "boom" });
      } catch (e) {
        return (e as Error).message;
      }
      return "no error";
    }),
    nested: m((ctx, { a }) => {
      ctx.runMutation("t:send", { a: { roomId: a, body: "inner" } });
      try {
        ctx.runMutation("t:send", { a: { roomId: a, body: "boom" } });
      } catch {
        // the callee and its triggers are undone
      }
      return null;
    }),
    get: queryGeneric({ args: { id: v.string() }, handler: (ctx: any, { id }: { id: string }) => ctx.db.get(id) }),
    all: queryGeneric({ args: { table: v.string() }, handler: (ctx: any, { table }: { table: string }) => ctx.db.query(table).collect() }),
    total: queryGeneric({ args: {}, handler: (ctx: any) => ctx.db.aggregate("audit", "total").get([]).count }),
    count: internalMutationGeneric({ args: { roomId: v.id("rooms") }, handler: (ctx: any, { roomId }: { roomId: string }) => ctx.db.increment(roomId, "messages", 1) }),
  },
};

function setup(triggers: unknown, limits?: Partial<Limits>) {
  let clock = 1_700_000_000_000;
  const e = createEngine({ schema, functions: fns, driver: createNodeSqliteDriver(), now: () => (clock += 1), triggers: triggers as Record<string, unknown>, ...(limits ? { limits } : {}) });
  e.migrate();
  const all = (table: string) => e.runQuery("t:all", { table }).value as Array<Record<string, any>>;
  return { e, all, room: () => e.runMutation("t:room").value as string };
}

describe("triggers", () => {
  test("each operation fires with the row before and after the write", () => {
    const seen: Change[] = [];
    const s = setup({ messages: (_ctx: unknown, c: Change) => seen.push(c) });
    const roomId = s.room();
    const id = s.e.runMutation("t:send", { a: { roomId, body: "hi" } }).value as string;
    s.e.runMutation("t:edit", { a: { id, body: "hello" } });
    s.e.runMutation("t:swap", { a: { id, roomId, body: "replaced" } });
    s.e.runMutation("t:drop", { a: { id } });
    expect(seen.map((c) => [c.operation, c.id, c.oldDoc?.body ?? null, c.newDoc?.body ?? null])).toEqual([
      ["insert", id, null, "hi"],
      ["update", id, "hi", "hello"],
      ["update", id, "hello", "replaced"],
      ["delete", id, "replaced", null],
    ]);
    expect(seen[0]!.newDoc).toMatchObject({ _id: id, roomId, body: "hi" });
    expect(typeof seen[0]!.newDoc!._creationTime).toBe("number");
  });

  test("a write that changes nothing fires nothing; increment fires an update", () => {
    const seen: string[] = [];
    const s = setup({
      rooms: (_ctx: unknown, c: Change<any>) => seen.push(`rooms ${c.operation} ${c.newDoc?.messages ?? "-"}`),
      messages: (_ctx: unknown, c: Change) => seen.push(`messages ${c.operation}`),
    });
    const roomId = s.room();
    s.e.runMutation("t:bump", { a: roomId });
    const id = s.e.runMutation("t:send", { a: { roomId, body: "same" } }).value as string;
    // A patch with the same values writes no row: no change, no trigger (convex-helpers fires on every call).
    const r = s.e.runMutation("t:edit", { a: { id, body: "same" } });
    expect(r.changes).toEqual([]);
    expect(seen).toEqual(["rooms insert -", "rooms update 1", "messages insert"]);
  });

  test("trigger writes run in the transaction: normal RowChanges, aggregates, more triggers (cascade)", () => {
    const s = setup(
      defineTriggers({
        messages: (ctx, c) => {
          if (c.operation === "insert") ctx.db.patch(c.newDoc.roomId, { lastMessageAt: c.newDoc._creationTime });
          if (c.operation !== "update") ctx.db.increment((c.newDoc ?? c.oldDoc).roomId, "messages", c.operation === "insert" ? 1 : -1);
        },
        rooms: (ctx, c) => {
          if (c.operation === "update") ctx.db.insert("audit", { what: `room ${c.newDoc.messages ?? 0}` });
        },
      }),
    );
    const roomId = s.room();
    const r = s.e.runMutation("t:send", { a: { roomId, body: "hi" } });
    const msg = r.value as string;
    const room = s.e.runQuery("t:get", { id: roomId }).value as Record<string, any>;
    const created = (s.e.runQuery("t:get", { id: msg }).value as Record<string, any>)._creationTime;
    expect(room).toMatchObject({ lastMessageAt: created, messages: 1 });
    expect(s.all("audit").map((d) => d.what)).toEqual(["room 0", "room 1"]);
    // The mutation's changes carry what the triggers wrote (reactivity), aggregates included.
    const tables = (r.changes as RowChange[]).map((c) => c.table).sort();
    expect(tables).toEqual(["audit", "audit", "audit__total", "messages", "rooms"].sort());
    expect(s.e.runQuery("t:total").value).toBe(2);
  });

  test("the queue drains in FIFO order, before the outermost write returns", () => {
    const log: string[] = [];
    let visible: number | undefined;
    const s = setup(
      defineTriggers({
        messages: [
          (ctx, c) => {
            log.push(`A ${c.newDoc?.body}`);
            ctx.db.insert("audit", { what: "from A" });
            log.push("A done");
          },
          (_ctx, c) => log.push(`B ${c.newDoc?.body}`),
        ],
        audit: (_ctx, c) => log.push(`audit ${c.newDoc?.what}`),
      }),
    );
    const roomId = s.room();
    s.e.runMutation(
      internalMutationGeneric({
        args: { roomId: v.string() },
        handler: (ctx: any, { roomId }: { roomId: string }) => {
          ctx.db.insert("messages", { roomId, body: "1" });
          visible = ctx.db.query("audit").collect().length;
          ctx.db.insert("messages", { roomId, body: "2" });
        },
      }),
      { roomId },
    );
    // A's insert into audit only enqueues (no re-entrant run); B runs before the audit trigger.
    expect(log).toEqual(["A 1", "A done", "B 1", "audit from A", "A 2", "A done", "B 2", "audit from A"]);
    expect(visible).toBe(1);
  });

  test("a trigger whose writes keep firing triggers stops at the cap (TriggerLoop), nothing committed", () => {
    const s = setup({ audit: (ctx: Ctx) => ctx.db.insert("audit", { what: "again" }) }, { triggerRuns: 50 });
    const run = () => s.e.runMutation(internalMutationGeneric({ args: {}, handler: (ctx: any) => ctx.db.insert("audit", { what: "first" }) }));
    expect(run).toThrow(expect.objectContaining({ code: "TriggerLoop" }));
    expect(s.all("audit")).toEqual([]);
  });

  test("trigger writes count toward rowsWritten", () => {
    const s = setup({ plain: (ctx: Ctx) => { for (let i = 0; i < 20; i++) ctx.db.insert("audit", { what: String(i) }); } }, { rowsWritten: 30 });
    expect(() => s.e.runMutation("t:plain")).toThrow(expect.objectContaining({ code: "TooManyWrites" }));
  });

  test("a throwing trigger aborts the mutation; caught, it undoes only that write", () => {
    const s = setup({
      messages: (ctx: Ctx, c: Change<any>) => {
        ctx.db.insert("audit", { what: c.newDoc?.body ?? "-" });
        if (c.newDoc?.body === "boom") throw new EmberError("ValidationError", "no boom");
      },
    });
    const roomId = s.room();
    expect(() => s.e.runMutation("t:send", { a: { roomId, body: "boom" } })).toThrow("no boom");
    expect(s.all("messages")).toEqual([]);
    expect(s.all("audit")).toEqual([]);
    const r = s.e.runMutation("t:catching", { a: roomId });
    expect(r.value).toBe("no boom");
    expect(s.all("messages").map((d) => d.body)).toEqual(["kept"]);
    expect(s.all("audit").map((d) => d.what)).toEqual(["kept"]);
    expect(r.changes.map((c) => c.table).sort()).toEqual(["audit", "audit__total", "messages"]);
  });

  test("nested ctx.runMutation fires triggers; a failing callee's triggers are undone with it", () => {
    const s = setup({
      messages: (ctx: Ctx, c: Change<any>) => {
        ctx.db.insert("audit", { what: c.newDoc?.body });
        if (c.newDoc?.body === "boom") throw new Error("boom");
      },
    });
    const roomId = s.room();
    s.e.runMutation("t:nested", { a: roomId });
    expect(s.all("messages").map((d) => d.body)).toEqual(["inner"]);
    expect(s.all("audit").map((d) => d.what)).toEqual(["inner"]);
  });

  test("triggers can call runMutation / runQuery / the scheduler and see the mutation's clock and identity", () => {
    let seen: unknown;
    const s = setup({
      messages: (ctx: Ctx, c: Change<any>) => {
        ctx.runMutation("t:count", { roomId: c.newDoc.roomId });
        ctx.scheduler.runAfter(1000, "t:plain");
        seen = { now: ctx.now, who: ctx.auth.getUserIdentity()?.subject, room: (ctx.runQuery("t:get", { id: c.newDoc.roomId }) as any).messages };
      },
    });
    const roomId = s.room();
    const r = s.e.runMutation("t:send", { a: { roomId, body: "x" } }, { identity: { subject: "ana", tokenIdentifier: "ana" } as never });
    expect(seen).toMatchObject({ who: "ana", room: 1 });
    expect(r.scheduled.map((j) => j.fn)).toEqual(["t:plain"]);
  });

  test("group commit: only the item whose trigger threw is rolled back", () => {
    const s = setup({
      messages: (ctx: Ctx, c: Change<any>) => {
        ctx.db.insert("audit", { what: c.newDoc.body });
        if (c.newDoc.body === "boom") throw new Error("boom");
      },
    });
    const roomId = s.room();
    const out = s.e.runMutationBatch(["a", "boom", "c"].map((body) => ({ name: "t:send", args: { a: { roomId, body } }, ctx: { identity: null } })));
    expect(out.map((x) => x.ok)).toEqual([true, false, true]);
    expect(s.all("messages").map((d) => d.body)).toEqual(["a", "c"]);
    expect(s.all("audit").map((d) => d.what)).toEqual(["a", "c"]);
  });

  test("triggers are synchronous", () => {
    const s = setup({ plain: async () => {} });
    expect(() => s.e.runMutation("t:plain")).toThrow(expect.objectContaining({ code: "AsyncHandler" }));
    expect(s.all("plain")).toEqual([]);
  });

  test("tables that are not the app's are refused at engine creation", () => {
    expect(() => setup({ nope: () => {} })).toThrow(expect.objectContaining({ code: "InvalidTrigger" }));
    expect(() => setup({ _jobs: () => {} })).toThrow(/internal tables/);
    expect(() => setup({ plain: 1 })).toThrow(expect.objectContaining({ code: "InvalidTrigger" }));
    const c = defineComponent({ name: "c", schema: defineSchema({ tables: { items: defineTable({ k: v.string() }) } }), functions: {} });
    const composed = composeApp({ schema, functions: fns, app: defineApp().use(c, { name: "c" }) });
    expect(() => createEngine({ schema: composed.schema, functions: composed.functions, driver: createNodeSqliteDriver(), triggers: { c$items: () => {} } })).toThrow(/component tables/);
    // App tables of an app with components are fine.
    expect(() => createEngine({ schema: composed.schema, functions: composed.functions, driver: createNodeSqliteDriver(), triggers: { plain: () => {} } })).not.toThrow();
  });

  test("types: tables checked, documents typed", () => {
    const define = defineTriggers as unknown as DefineTriggers<DM>;
    define({
      messages: (ctx, change) => {
        if (change.operation === "insert") {
          expectTypeOf(change.newDoc.body).toEqualTypeOf<string>();
          expectTypeOf(change.oldDoc).toEqualTypeOf<null>();
          ctx.db.patch(change.newDoc.roomId, { lastMessageAt: change.newDoc._creationTime });
        }
        if (change.operation === "delete") expectTypeOf(change.newDoc).toEqualTypeOf<null>();
      },
      rooms: [(_ctx, change) => expectTypeOf(change.id).toEqualTypeOf<DM["rooms"]["document"]["_id"]>()],
    });
    // @ts-expect-error unknown table
    define({ nope: () => {} });
  });
});
