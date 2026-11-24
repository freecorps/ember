// PR 2B on Durable Object SQLite (the real driver and its billed row counters): the batched outbox statements
// (`IN (…)` chunks, `(doc_id, seq) IN (VALUES …)`, numbered parameters, `INDEXED BY`), the backfill's
// `UPDATE … FROM (VALUES …)` and per-group aggregate writes, and a missing-table read caught inside a transaction
// (the replica applier's first apply) — what node:sqlite checks in ember-server, here on workerd.
import { runInDurableObject } from "cloudflare:test";
import {
  createEngine,
  defineSchema,
  defineTable,
  mutationGeneric,
  OUTBOX_PENDING_CAP,
  outboxAck,
  outboxClaim,
  outboxFetch,
  outboxRelease,
  replicaApplyFunction,
  SYSTEM_DDL,
  v,
  withReplicas,
  type SqlDriver,
} from "@freecorps/ember-server";
import { describe, expect, it } from "vitest";
import { DoSqlDriver } from "../src/sql-driver.ts";
import { shardStub } from "./helpers.ts";

const P = (...x: number[]) => [...x, ...new Array<number>(32 - x.length).fill(0)];
const ext = defineSchema({
  tables: { docs: defineTable({ title: v.string(), embedding: v.array(v.number()) }).vectorIndex("by_vec", { vectorField: "embedding", dimensions: 32 }) },
});

/** Statements and rows (DO's counters) while `fn` runs. */
function cost<R>(d: DoSqlDriver, fn: () => R) {
  const [s0, r0, w0] = [statements(d), d.rowsRead, d.rowsWritten];
  const value = fn();
  return { value, statements: statements(d) - s0, rowsRead: d.rowsRead - r0, rowsWritten: d.rowsWritten - w0 };
}
const statements = (d: DoSqlDriver) => Object.values(d.counters).reduce((n: number, c) => n + (Array.isArray(c) ? c[0] : 0), 0);
const seed = (d: SqlDriver, n: number, sent = 0) => {
  for (let i = 0; i < n; i++) d.exec(`INSERT INTO "_ember_ext_outbox" ("tbl", "idx", "doc_id", "seq", "sent") VALUES ('docs', 'by_vec', ?, ?, ?)`, `d${String(i).padStart(4, "0")}`, i + 1, sent);
};

// The per-row loops the batching replaced (what external.ts ran before), for the side-by-side counts.
const ENQUEUE =
  `INSERT INTO "_ember_ext_outbox" ("tbl", "idx", "doc_id", "seq") VALUES (?, ?, ?, ((random() & 9007199254740990) + 1)) ` +
  `ON CONFLICT ("tbl", "idx", "doc_id") DO UPDATE SET "seq" = excluded."seq", "attempts" = 0, "sent" = CASE WHEN "sent" < 0 THEN 0 ELSE "sent" END`;
function oldClaim(d: SqlDriver, now: number): number {
  d.exec(`SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = '_ember_ext_outbox'`);
  const claim = Number(d.exec(`SELECT ((random() & 9007199254740990) + 1) AS c`).rows[0]!.c);
  const rows = d.exec(`SELECT "tbl", "idx", "doc_id", "attempts" FROM "_ember_ext_outbox" WHERE "sent" = 0 OR ("sent" > 0 AND "sent_at" <= ?) ORDER BY "sent_at", "tbl", "idx" LIMIT ?`, now - 600_000, 500).rows;
  for (const r of rows) d.exec(`UPDATE "_ember_ext_outbox" SET "sent" = ?, "sent_at" = ?, "attempts" = "attempts" + 1 WHERE "tbl" = ? AND "idx" = ? AND "doc_id" = ?`, claim, now, r.tbl as string, r.idx as string, r.doc_id as string);
  return claim;
}
function oldAck(d: SqlDriver, acks: Array<{ id: string; seq: number | null }>, claim: number): number {
  const k = ["docs", "by_vec"] as const;
  for (const a of acks) {
    if (a.seq !== null && d.exec(`DELETE FROM "_ember_ext_outbox" WHERE "tbl" = ? AND "idx" = ? AND "doc_id" = ? AND "sent" = ? AND "seq" = ? RETURNING 1 AS x`, ...k, a.id, claim, a.seq).rows.length) continue;
    const row = d.exec(`SELECT "seq", "sent" FROM "_ember_ext_outbox" WHERE "tbl" = ? AND "idx" = ? AND "doc_id" = ?`, ...k, a.id).rows[0];
    const mine = !!row && Number(row.sent) === claim;
    if (mine && a.seq !== null && Number(row!.seq) === a.seq) d.exec(`DELETE FROM "_ember_ext_outbox" WHERE "tbl" = ? AND "idx" = ? AND "doc_id" = ?`, ...k, a.id);
    else if (mine) d.exec(`UPDATE "_ember_ext_outbox" SET "sent" = 0, "sent_at" = 0 WHERE "tbl" = ? AND "idx" = ? AND "doc_id" = ?`, ...k, a.id);
    else if (row) d.exec(`UPDATE "_ember_ext_outbox" SET "seq" = ((random() & 9007199254740990) + 1) WHERE "tbl" = ? AND "idx" = ? AND "doc_id" = ? AND "sent" >= 0`, ...k, a.id);
    else d.exec(ENQUEUE, ...k, a.id);
  }
  return Number(d.exec(`SELECT count(*) AS n FROM "_ember_ext_outbox" WHERE "tbl" = ? AND "idx" = ? AND "sent" = 0`, ...k).rows[0]!.n);
}

describe("batched SQL on DO SQLite", () => {
  it("outbox: claim, ack and release of 500 rows in a handful of statements, the same rows written as the per-row loops", async ({ annotate }) => {
    const run = (name: string, batched: boolean) =>
      runInDurableObject(shardStub(name), (_i, state) => {
        const d = new DoSqlDriver(state.storage);
        for (const s of SYSTEM_DDL) d.exec(s);
        seed(d, 500);
        const claim = cost(d, () => d.transaction(() => (batched ? outboxClaim(d, ext.manifest, ext.indexKinds, 1_000, { batchSize: 500 }).batches[0]!.claim : oldClaim(d, 1_000))));
        const seqs = new Map(d.exec(`SELECT "doc_id", "seq" FROM "_ember_ext_outbox"`).rows.map((r) => [String(r.doc_id), Number(r.seq)]));
        // 100 documents written since the fetch (pending again), 2 rows already gone (re-enqueued), the rest done.
        d.exec(`UPDATE "_ember_ext_outbox" SET "seq" = "seq" + 1000 WHERE "doc_id" >= 'd0400'`);
        const acks = [...[...seqs].map(([id, seq]) => ({ id, seq })), { id: "gone1", seq: 1 }, { id: "gone2", seq: null }];
        const ack = cost(d, () => d.transaction(() => (batched ? outboxAck(d, "docs", "by_vec", acks, claim.value) : oldAck(d, acks, claim.value))));
        const left = d.exec(`SELECT "doc_id", "sent" FROM "_ember_ext_outbox" ORDER BY "doc_id"`).rows.map((r) => [r.doc_id, Number(r.sent)]);
        let release: ReturnType<typeof cost> | null = null;
        if (batched) {
          const again = d.transaction(() => outboxClaim(d, ext.manifest, ext.indexKinds, 2_000, { batchSize: 500 })).batches[0]!;
          release = cost(d, () => outboxRelease(d, again));
        }
        const strip = (c: ReturnType<typeof cost>) => ({ statements: c.statements, rowsRead: c.rowsRead, rowsWritten: c.rowsWritten });
        return { claim: strip(claim), ack: { ...strip(ack), value: ack.value }, left, release: release && strip(release) };
      });
    const [now, before] = [await run("pr2b:outbox", true), await run("pr2b:outbox-old", false)];
    annotate(`DO SQLite, 500 rows — claim: ${JSON.stringify(now.claim)} (per row: ${JSON.stringify(before.claim)}); ack: ${JSON.stringify(now.ack)} (per row: ${JSON.stringify(before.ack)}); release of 102: ${JSON.stringify(now.release)}`);
    expect(now.left).toEqual(before.left);
    expect(now.left).toHaveLength(102);
    expect(now.claim.statements).toBe(3 + Math.ceil(500 / 86)); // sqlite_master (first call on this driver), rows, token, UPDATEs
    expect(before.claim.statements).toBe(503);
    expect(now.claim.rowsWritten).toBe(before.claim.rowsWritten);
    expect(now.ack.value).toBe(OUTBOX_PENDING_CAP); // 102 pending, counted up to the cap
    expect(before.ack.value).toBe(102);
    expect(now.ack.rowsWritten).toBe(before.ack.rowsWritten);
    expect(now.ack.statements).toBe(Math.ceil(501 / 43) + 2 + 2 + 1 + 1); // DELETEs, leftovers read, re-pended, enqueued, count
    expect(before.ack.statements).toBeGreaterThan(600);
    expect(now.release!.statements).toBe(Math.ceil(102 / 88));
  });

  it("outbox fetch on real documents: the outbox read first, documents only under the current claim", async () => {
    const out = await runInDurableObject(shardStub("pr2b:fetch"), (_i, state) => {
      const d = new DoSqlDriver(state.storage);
      let clock = 1_700_000_000_000;
      const engine = createEngine({ schema: ext, driver: d, now: () => (clock += 1) });
      engine.migrate();
      engine.runMutation(mutationGeneric((ctx: any) => { for (let i = 0; i < 60; i++) ctx.db.insert("docs", { title: `t${i}`, embedding: P(i + 1) }); }) as any);
      const a = d.transaction(() => outboxClaim(d, ext.manifest, ext.indexKinds, clock, { resendMs: 1, batchSize: 60 })).batches[0]!;
      const b = d.transaction(() => outboxClaim(d, ext.manifest, ext.indexKinds, clock + 10, { resendMs: 1, batchSize: 60 })).batches[0]!;
      const stale = cost(d, () => outboxFetch(d, ext.manifest, ext.indexKinds, "docs", "by_vec", a.ids, a.claim));
      const fresh = cost(d, () => outboxFetch(d, ext.manifest, ext.indexKinds, "docs", "by_vec", b.ids, b.claim));
      return {
        stale: { statements: stale.statements, rowsRead: stale.rowsRead, current: stale.value.items.filter((i) => i.current).length },
        fresh: { statements: fresh.statements, current: fresh.value.items.filter((i) => i.current && i.doc).length, first: fresh.value.items[0]!.doc?.values?.[0] },
      };
    });
    // DO bills an `IN (…)` lookup as two rows read per id; the per-row loop read the outbox row and the document.
    expect(out.stale).toEqual({ statements: 1, rowsRead: 120, current: 0 });
    expect(out.fresh.current).toBe(60);
    expect(out.fresh.first).toBe(1);
    expect(out.fresh.statements).toBe(1 + 1 + 60);
  });

  it("backfill: one read per batch, one aggregate write per group", async ({ annotate }) => {
    const fields = { shop: v.string(), amount: v.number() };
    const v1 = defineSchema({ tables: { orders: defineTable(fields) } });
    const v2 = defineSchema({ tables: { orders: defineTable(fields).index("by_shop", ["shop"]).aggregate("per_shop", { by: ["shop"], sum: ["amount"] }) } });
    const out = await runInDurableObject(shardStub("pr2b:backfill"), (_i, state) => {
      const d = new DoSqlDriver(state.storage);
      let clock = 1_700_000_000_000;
      const e1 = createEngine({ schema: v1, driver: d, now: () => (clock += 1) });
      e1.migrate();
      e1.runMutation(mutationGeneric((ctx: any) => { for (let i = 0; i < 1000; i++) ctx.db.insert("orders", { shop: ["a", "b", "c", "d"][i % 4], amount: i }); }) as any);
      const e2 = createEngine({ schema: v2, driver: d, now: () => (clock += 1) });
      e2.migrate();
      const steps: Array<{ index?: string; processed: number; rowsRead: number; rowsWritten: number; statements: number }> = [];
      for (;;) {
        const c = cost(d, () => e2.backfillStep(500));
        steps.push({ index: c.value.index, processed: c.value.processed, rowsRead: c.rowsRead, rowsWritten: c.rowsWritten, statements: c.statements });
        if (c.value.done) break;
      }
      const sums = d.exec(`SELECT count(*) AS n, sum("count") AS c FROM "orders__per_shop"`).rows[0]!;
      const keyed = Number(d.exec(`SELECT count(*) AS n FROM "orders" WHERE "_k_by_shop" IS NOT NULL`).rows[0]!.n);
      return { steps, groups: Number(sums.n), counted: Number(sums.c), keyed };
    });
    const bySh = out.steps.filter((s) => s.index === "by_shop" && s.processed === 500);
    const agg = out.steps.filter((s) => s.index === "per_shop" && s.processed === 500);
    expect(bySh.length).toBeGreaterThan(0);
    expect(agg.length).toBeGreaterThan(0);
    annotate(`DO SQLite, backfill steps of 500: ${JSON.stringify(out.steps)}`);
    for (const s of bySh) {
      // The batch read (500) and one key UPDATE per row (500); the boundary scan before it read 500 more.
      expect(s.rowsRead).toBeLessThanOrEqual(1000 + 20);
      expect(s.statements).toBeLessThanOrEqual(500 + 8);
    }
    for (const s of agg) {
      // Was a read and a write of the group per document (500 + 500) on top of the two scans.
      expect(s.rowsRead).toBeLessThanOrEqual(500 + 4 + 20);
      expect(s.rowsWritten).toBeLessThanOrEqual(4 + 4);
      expect(s.statements).toBeLessThanOrEqual(2 * 4 + 8);
    }
    expect(out).toMatchObject({ groups: 4, counted: 1000, keyed: 1000 });
  });

  it("a missing table read inside a transaction (the replica applier's first apply) does not abort it", async () => {
    const member = { name: "auth:member", source: "auth", idType: "string" as const, fields: [{ name: "role", type: "string" as const, optional: false }] };
    const schema = withReplicas(defineSchema({ tables: { notes: defineTable({ t: v.string() }) } }), [member]);
    const out = await runInDurableObject(shardStub("pr2b:replica"), (_i, state) => {
      const d = new DoSqlDriver(state.storage);
      const engine = createEngine({ schema, driver: d, functions: { "_ember:replicaApply": replicaApplyFunction(() => schema.manifest) }, now: () => 5 });
      engine.migrate();
      const had = d.exec(`SELECT name FROM sqlite_master WHERE name LIKE '_ember_replicas%'`).rows.map((r) => r.name);
      const first = engine.runMutation("_ember:replicaApply", { source: "auth", snapshot: { id: "s", first: true, rows: [{ table: "auth:member", id: "m1", doc: { role: "x" } }], end: { cut: 3 } } }).value;
      const second = engine.runMutation("_ember:replicaApply", { source: "auth", prev: 3, rows: [{ seq: 4, table: "auth:member", id: "m2", op: "upsert", doc: { role: "y" } }] }).value;
      const tables = d.exec(`SELECT name FROM sqlite_master WHERE name LIKE '_ember_replicas%' ORDER BY name`).rows.map((r) => r.name);
      const rows = d.exec(`SELECT "id" FROM "auth:member" ORDER BY "id"`).rows.map((r) => r.id);
      return { had, first, second, tables, rows };
    });
    expect(out.had).toEqual([]);
    expect(out.first).toEqual({ seq: 3, applied: 1, skipped: 0 });
    expect(out.second).toEqual({ seq: 4, applied: 1, skipped: 0 });
    expect(out.tables).toEqual(["_ember_replicas"]); // a single-page resync never creates _ember_replicas_seen
    expect(out.rows).toEqual(["m1", "m2"]);
  });
});

describe("replica resync on DO SQLite", () => {
  it("a single-page resync (200 rows) writes the rows only, no _ember_replicas_seen", async ({ annotate }) => {
    const member = { name: "auth:member", source: "auth", idType: "string" as const, fields: [{ name: "role", type: "string" as const, optional: false }] };
    const schema = withReplicas(defineSchema({ tables: { notes: defineTable({ t: v.string() }) } }), [member]);
    const out = await runInDurableObject(shardStub("pr2b:resync"), (_i, state) => {
      const d = new DoSqlDriver(state.storage);
      const engine = createEngine({ schema, driver: d, functions: { "_ember:replicaApply": replicaApplyFunction(() => schema.manifest) }, now: () => 5 });
      engine.migrate();
      const rows = (n: number, role: string) => Array.from({ length: n }, (_, i) => ({ table: "auth:member", id: `m${i}`, doc: { role } }));
      engine.runMutation("_ember:replicaApply", { source: "auth", snapshot: { id: "s0", first: true, rows: rows(200, "a"), end: { cut: 1 } } });
      // A resync that changes every row and drops 20: what the resync itself costs.
      const c = cost(d, () => engine.runMutation("_ember:replicaApply", { source: "auth", snapshot: { id: "s1", first: true, rows: rows(180, "b"), end: { cut: 2 } } }));
      const left = Number(d.exec(`SELECT count(*) AS n FROM "auth:member" WHERE "role" = 'b'`).rows[0]!.n);
      return { statements: c.statements, rowsRead: c.rowsRead, rowsWritten: c.rowsWritten, left, value: c.value.value };
    });
    annotate(`DO SQLite, single-page resync of 180 rows over 200: ${JSON.stringify(out)}`);
    expect(out.left).toBe(180);
    expect(out.value).toEqual({ seq: 2, applied: 200, skipped: 0 });
    // 180 replaced and 20 deleted documents with their index entries; before, the seen ids written and deleted
    // brought this resync to 741 rows written, 982 read and 587 statements.
    expect(out.rowsWritten).toBeLessThanOrEqual(200 + 20 * 2);
    expect(out.statements).toBeLessThan(450);
  });
});
