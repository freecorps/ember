import { describe, expect, test } from "vitest";
import {
  createEngine,
  defineSchema,
  defineTable,
  EmberError,
  internalMutationGeneric,
  queryGeneric,
  replicaApplyFunction,
  withReplicas,
  v,
  type ReplicaApplyArgs,
  type ReplicaTableSpec,
} from "../src/index.ts";
import { createNodeSqliteDriver } from "../src/testing.ts";

const member: ReplicaTableSpec = {
  name: "auth:member",
  source: "auth",
  idType: "string",
  fields: [
    { name: "userId", type: "string", optional: false },
    { name: "role", type: "string", optional: false },
    { name: "createdAt", type: "date", optional: false },
    { name: "note", type: "string", optional: true },
  ],
  indexes: [{ name: "by_userId", fields: ["userId"] }],
};
const user: ReplicaTableSpec = { name: "auth:user", source: "auth", idType: "string", fields: [{ name: "name", type: "string", optional: false }] };

const base = defineSchema({ tables: { notes: defineTable({ text: v.string() }) } });
const schema = withReplicas(base, [member, user]);

const fns = {
  "_ember:replicaApply": replicaApplyFunction(() => schema.manifest),
  "t:roleOf": queryGeneric({
    args: { userId: v.string() },
    handler: (ctx, a: { userId: string }) => {
      const m = (ctx.db as any).query("auth:member").withIndex("by_userId", (q: any) => q.eq("userId", a.userId)).first();
      return m?.role ?? null;
    },
  }),
  "t:all": queryGeneric({ args: {}, handler: (ctx) => (ctx.db as any).query("auth:member").collect() }),
  "t:write": internalMutationGeneric({
    args: { op: v.string() },
    handler: (ctx, a: { op: string }) => {
      const db = ctx.db as any;
      if (a.op === "insert") return db.insert("auth:member", { id: "m9", userId: "u9", role: "x", createdAt: 1 });
      const m = db.query("auth:member").first();
      if (a.op === "patch") return db.patch(m._id, { role: "owner" });
      if (a.op === "delete") return db.delete(m._id);
      return db.replace(m._id, { id: m.id, userId: "u", role: "r", createdAt: 1 });
    },
  }),
};

const setup = (s = schema, driver = createNodeSqliteDriver()) => {
  const engine = createEngine({ schema: s, functions: fns, driver, now: () => 1000 });
  engine.migrate();
  const apply = (args: ReplicaApplyArgs) => engine.runMutation("_ember:replicaApply", args);
  return { engine, apply, driver };
};

const up = (seq: number, id: string, doc: Record<string, unknown>) => ({ seq, table: "auth:member", id, op: "upsert" as const, doc });
const del = (seq: number, id: string) => ({ seq, table: "auth:member", id, op: "delete" as const });

describe("replica tables", () => {
  test("manifest: replica tables with the source id indexed, schema hash changes, base untouched", () => {
    expect(schema.manifest.tables["auth:member"]!.replica).toEqual({ source: "auth" });
    expect(schema.manifest.tables["auth:member"]!.indexes.map((i) => i.name)).toEqual(["by_source_id", "by_userId"]);
    expect(schema.manifest.version).not.toBe(base.manifest.version);
    expect(withReplicas(base, [])).toBe(base);
    expect(() => withReplicas(base, [{ ...member, name: "member" }])).toThrow(/<source>:<table>/);
  });

  test("deltas apply in order, produce row changes, and are idempotent (high-water mark)", () => {
    const { engine, apply } = setup();
    const r1 = apply({ source: "auth", prev: 0, rows: [up(1, "m1", { userId: "u1", role: "member", createdAt: 5, note: null })] });
    expect(r1.value).toEqual({ seq: 1, applied: 1, skipped: 0 });
    expect(r1.changes).toHaveLength(1);
    expect(r1.changes[0]!.after).toMatchObject({ id: "m1", userId: "u1", role: "member", createdAt: 5 });
    expect(r1.changes[0]!.after).not.toHaveProperty("note");
    expect(engine.runQuery("t:roleOf", { userId: "u1" }).value).toBe("member");
    const id = (engine.runQuery("t:all").value as Array<{ _id: string }>)[0]!._id;

    // Redelivery of the same batch: no effect. A later batch updates in place (same _id) and deletes.
    expect(apply({ source: "auth", prev: 0, rows: [up(1, "m1", { userId: "u1", role: "member", createdAt: 5 })] }).value).toEqual({ seq: 1, applied: 0, skipped: 1 });
    const r2 = apply({ source: "auth", prev: 1, rows: [up(2, "m1", { userId: "u1", role: "admin", createdAt: 5 }), up(3, "m2", { userId: "u2", role: "member", createdAt: 6 })] });
    expect(r2.value).toEqual({ seq: 3, applied: 2, skipped: 0 });
    const all = engine.runQuery("t:all").value as Array<{ _id: string; id: string; role: string }>;
    expect(all.find((m) => m.id === "m1")).toMatchObject({ _id: id, role: "admin" });
    apply({ source: "auth", prev: 3, rows: [del(4, "m2"), del(5, "nope")] });
    expect((engine.runQuery("t:all").value as unknown[]).length).toBe(1);
  });

  test("a gap (the source delivered more than this shard has) asks for a resync", () => {
    const { apply } = setup();
    expect(apply({ source: "auth", prev: 7, rows: [up(8, "m1", { userId: "u1", role: "member", createdAt: 5 })] }).value).toMatchObject({ resync: true, applied: 0 });
  });

  test("writes from app code are refused with ReadOnlyTable", () => {
    const { engine, apply } = setup();
    apply({ source: "auth", prev: 0, rows: [up(1, "m1", { userId: "u1", role: "member", createdAt: 5 })] });
    for (const op of ["insert", "patch", "replace", "delete"]) {
      let err: unknown;
      try {
        engine.runMutation("t:write", { op });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(EmberError);
      expect((err as EmberError).code).toBe("ReadOnlyTable");
    }
  });

  test("a resync replaces the source's rows (pages, then end) and cuts the deltas at its seq", () => {
    const { engine, apply } = setup();
    apply({ source: "auth", prev: 0, rows: [up(1, "m1", { userId: "u1", role: "member", createdAt: 5 }), up(2, "stale", { userId: "u3", role: "member", createdAt: 5 })] });
    const before = (engine.runQuery("t:all").value as Array<{ _id: string; id: string }>).find((m) => m.id === "m1")!._id;
    apply({ source: "auth", snapshot: { id: "s1", first: true, rows: [{ table: "auth:member", id: "m1", doc: { userId: "u1", role: "owner", createdAt: 5 } }] } });
    // Deltas wait while a resync is in progress.
    expect(apply({ source: "auth", prev: 2, rows: [up(3, "m4", { userId: "u4", role: "member", createdAt: 5 })] }).value).toMatchObject({ resync: true });
    apply({ source: "auth", snapshot: { id: "s1", rows: [{ table: "auth:user", id: "u1", doc: { name: "Ana" } }, { table: "auth:member", id: "m5", doc: { userId: "u5", role: "member", createdAt: 9 } }], end: { cut: 10 } } });
    const all = engine.runQuery("t:all").value as Array<{ _id: string; id: string; role: string }>;
    expect(all.map((m) => m.id).sort()).toEqual(["m1", "m5"]);
    expect(all.find((m) => m.id === "m1")).toMatchObject({ _id: before, role: "owner" });
    // Deltas the snapshot already covers are skipped; later ones apply.
    expect(apply({ source: "auth", prev: 2, rows: [up(9, "m1", { userId: "u1", role: "old", createdAt: 5 }), up(11, "m6", { userId: "u6", role: "member", createdAt: 5 })] }).value).toEqual({ seq: 11, applied: 1, skipped: 1 });
    expect(engine.runQuery("t:roleOf", { userId: "u1" }).value).toBe("owner");
  });

  test("an incompatible schema change empties the replica table (no refusal) and forgets the high-water mark", () => {
    const driver = createNodeSqliteDriver();
    const { apply } = setup(schema, driver);
    apply({ source: "auth", prev: 0, rows: [up(1, "m1", { userId: "u1", role: "member", createdAt: 5 })] });
    const changed = withReplicas(base, [{ ...member, fields: [...member.fields, { name: "required", type: "string", optional: false }] }, user]);
    const next = setup(changed, driver);
    expect(next.engine.runQuery("t:all").value).toEqual([]);
    expect(next.apply({ source: "auth", prev: 1, rows: [up(2, "m1", { userId: "u1", role: "member", createdAt: 5, required: "x" })] }).value).toMatchObject({ resync: true });
  });
});
