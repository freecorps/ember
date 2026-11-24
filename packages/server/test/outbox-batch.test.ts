// External-index outbox delivery in batches (PR 2B): claim / release / defer / fetch / ack run a bounded number of
// statements (`doc_id IN (…)` chunks of OUTBOX_MAX_PARAMS parameters, not one statement per row), give the same
// result as the per-row loops they replace (checked against a copy of those loops on random outboxes, across chunk
// boundaries and with duplicate ids), and roll back as a whole when a statement fails mid-batch.

import { describe, expect, test } from "vitest";
import { createNodeSqliteDriver, type NodeSqliteDriver } from "../src/testing.ts";
import {
  createEngine,
  defineSchema,
  defineTable,
  mutationGeneric,
  OUTBOX_MAX_PARAMS,
  OUTBOX_PENDING_CAP,
  outboxAck,
  outboxClaim,
  outboxDefer,
  outboxFetch,
  outboxNextAt,
  outboxRelease,
  outboxStats,
  SYSTEM_DDL,
  v,
  type MutationCtx,
  type OutboxBatch,
  type SqlDriver,
} from "../src/index.ts";
import { prng } from "./fixtures.ts";

const schema = defineSchema({
  tables: {
    docs: defineTable({ title: v.string(), embedding: v.optional(v.array(v.number())) })
      .vectorIndex("by_vec", { vectorField: "embedding", dimensions: 32 })
      .aiSearchIndex("hybrid", { fields: ["title"] }),
  },
});
const m = schema.manifest;
const kinds = schema.indexKinds;
const OUTBOX = "_ember_ext_outbox";
const P = (...x: number[]) => [...x, ...new Array<number>(32 - x.length).fill(0)];

type Row = { tbl: string; idx: string; doc_id: string; seq: number; sent: number; sent_at: number; attempts: number };

function bare(): NodeSqliteDriver {
  const driver = createNodeSqliteDriver();
  for (const s of SYSTEM_DDL) driver.exec(s);
  return driver;
}
const seed = (driver: SqlDriver, rows: Row[]) => {
  for (const r of rows) driver.exec(`INSERT INTO "${OUTBOX}" VALUES (?, ?, ?, ?, ?, ?, ?)`, r.tbl, r.idx, r.doc_id, r.seq, r.sent, r.sent_at, r.attempts);
};
const dump = (driver: SqlDriver): Row[] => driver.exec(`SELECT * FROM "${OUTBOX}" ORDER BY "tbl", "idx", "doc_id"`).rows as unknown as Row[];
/** The statements `fn` runs. */
function counted<R>(driver: NodeSqliteDriver, fn: () => R): { value: R; statements: number; sql: string[] } {
  const sql: string[] = [];
  const exec = driver.exec;
  driver.exec = (s, ...p) => {
    sql.push(s);
    return exec.call(driver, s, ...p);
  };
  const before = driver.statements;
  try {
    const value = fn();
    return { value, statements: driver.statements - before, sql };
  } finally {
    driver.exec = exec;
  }
}
const pending = (n: number, idx = "by_vec", from = 0): Row[] =>
  Array.from({ length: n }, (_, i) => ({ tbl: "docs", idx, doc_id: `d${String(from + i).padStart(5, "0")}`, seq: 1000 + from + i, sent: 0, sent_at: 0, attempts: 0 }));

/** The acks of a delivery that read `ids` now (their current seqs). */
const asRead = (driver: SqlDriver, ids: string[]) => {
  const seq = new Map(dump(driver).map((r) => [r.doc_id, Number(r.seq)]));
  return ids.map((id) => ({ id, seq: seq.get(id) ?? null }));
};

// ------------------------------------------------------------------------------------------------ the per-row loops
// What external.ts ran before the batching (reference for the equivalence tests below).

const ENQUEUE =
  `INSERT INTO "${OUTBOX}" ("tbl", "idx", "doc_id", "seq") VALUES (?, ?, ?, ((random() & 9007199254740990) + 1)) ` +
  `ON CONFLICT ("tbl", "idx", "doc_id") DO UPDATE SET "seq" = excluded."seq", "attempts" = 0, "sent" = CASE WHEN "sent" < 0 THEN 0 ELSE "sent" END`;

function oldClaim(driver: SqlDriver, now: number, o: { resendMs: number; maxAttempts: number; batchSize: number; limit: number }) {
  const known = new Set(["docs\u0000by_vec", "docs\u0000hybrid"]);
  const claim = 77;
  const rows = driver.exec(
    `SELECT "tbl", "idx", "doc_id", "attempts" FROM "${OUTBOX}" WHERE "sent" = 0 OR ("sent" > 0 AND "sent_at" <= ?) ORDER BY "sent_at", "tbl", "idx" LIMIT ?`,
    now - o.resendMs,
    o.limit,
  ).rows;
  const groups = new Map<string, { table: string; index: string; ids: string[] }>();
  const parked: Array<{ table: string; index: string; id: string }> = [];
  for (const r of rows) {
    const [table, index, id] = [String(r.tbl), String(r.idx), String(r.doc_id)];
    if (!known.has(`${table}\u0000${index}`)) {
      driver.exec(`DELETE FROM "${OUTBOX}" WHERE "tbl" = ? AND "idx" = ? AND "doc_id" = ?`, table, index, id);
      continue;
    }
    if (Number(r.attempts) >= o.maxAttempts) {
      driver.exec(`UPDATE "${OUTBOX}" SET "sent" = -1 WHERE "tbl" = ? AND "idx" = ? AND "doc_id" = ?`, table, index, id);
      parked.push({ table, index, id });
      continue;
    }
    driver.exec(`UPDATE "${OUTBOX}" SET "sent" = ?, "sent_at" = ?, "attempts" = "attempts" + 1 WHERE "tbl" = ? AND "idx" = ? AND "doc_id" = ?`, claim, now, table, index, id);
    const key = `${table}\u0000${index}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { table, index, ids: [] }));
    g.ids.push(id);
  }
  const batches: OutboxBatch[] = [];
  for (const g of groups.values()) for (let i = 0; i < g.ids.length; i += o.batchSize) batches.push({ table: g.table, index: g.index, ids: g.ids.slice(i, i + o.batchSize), claim });
  return { batches, parked };
}

function oldAck(driver: SqlDriver, table: string, index: string, acks: Array<{ id: string; seq: number | null }>, claim: number | null): number {
  for (const a of acks) {
    if (claim != null && a.seq !== null) {
      const gone = driver.exec(`DELETE FROM "${OUTBOX}" WHERE "tbl" = ? AND "idx" = ? AND "doc_id" = ? AND "sent" = ? AND "seq" = ? RETURNING 1 AS x`, table, index, a.id, claim, a.seq).rows.length;
      if (gone) continue;
    }
    const row = driver.exec(`SELECT "seq", "sent" FROM "${OUTBOX}" WHERE "tbl" = ? AND "idx" = ? AND "doc_id" = ?`, table, index, a.id).rows[0];
    const mine = !!row && claim != null && Number(row.sent) === claim;
    if (mine && a.seq !== null && Number(row!.seq) === a.seq) driver.exec(`DELETE FROM "${OUTBOX}" WHERE "tbl" = ? AND "idx" = ? AND "doc_id" = ?`, table, index, a.id);
    else if (mine) driver.exec(`UPDATE "${OUTBOX}" SET "sent" = 0, "sent_at" = 0 WHERE "tbl" = ? AND "idx" = ? AND "doc_id" = ?`, table, index, a.id);
    else if (row) driver.exec(`UPDATE "${OUTBOX}" SET "seq" = ((random() & 9007199254740990) + 1) WHERE "tbl" = ? AND "idx" = ? AND "doc_id" = ? AND "sent" >= 0`, table, index, a.id);
    else driver.exec(ENQUEUE, table, index, a.id);
  }
  return Number(driver.exec(`SELECT count(*) AS n FROM "${OUTBOX}" WHERE "tbl" = ? AND "idx" = ? AND "sent" = 0`, table, index).rows[0]!.n);
}

/** Two outboxes compared: same rows, and a seq changed in one exactly where it changed in the other (it is random). */
function expectSameOutcome(seeded: Row[], a: Row[], b: Row[]) {
  const orig = new Map(seeded.map((r) => [`${r.tbl}/${r.idx}/${r.doc_id}`, r.seq]));
  const norm = (rows: Row[]) =>
    rows.map((r) => {
      const was = orig.get(`${r.tbl}/${r.idx}/${r.doc_id}`);
      return { ...r, seq: was === undefined ? "new" : was === Number(r.seq) ? "same" : "changed" };
    });
  expect(norm(b)).toEqual(norm(a));
}

// ------------------------------------------------------------------------------------------------ statement counts

describe("outbox delivery: statements per call", () => {
  test("claiming 500 rows of one index: 1 statement + one UPDATE per chunk (was 502), 500 ids in 10 batches", () => {
    const driver = bare();
    seed(driver, pending(500));
    outboxNextAt(driver, 0); // the table check is remembered per driver from here on
    const r = counted(driver, () => driver.transaction(() => outboxClaim(driver, m, kinds, 5_000)));
    const chunk = OUTBOX_MAX_PARAMS - 4;
    expect(r.statements).toBe(1 + Math.ceil(500 / chunk)); // rows, UPDATE … IN (≤86 ids); the claim token is made in JS
    expect(r.sql.some((s) => s.includes("sqlite_master"))).toBe(false);
    expect(r.value.batches).toHaveLength(10);
    expect(r.value.batches.flatMap((b) => b.ids)).toEqual(pending(500).map((x) => x.doc_id));
    const claim = r.value.batches[0]!.claim;
    expect(dump(driver).every((x) => Number(x.sent) === claim && Number(x.sent_at) === 5_000 && Number(x.attempts) === 1)).toBe(true);
    // Every statement stays under DO SQLite's 100 bound parameters.
    for (const s of r.sql) expect((s.match(/\?/g) ?? []).length).toBeLessThanOrEqual(OUTBOX_MAX_PARAMS);
  });

  test("an empty outbox claims with one statement (no claim token, no sqlite_master probe)", () => {
    const driver = bare();
    outboxClaim(driver, m, kinds, 1);
    expect(counted(driver, () => outboxClaim(driver, m, kinds, 2)).statements).toBe(1);
    expect(counted(driver, () => outboxNextAt(driver, 2)).statements).toBe(1);
    expect(counted(driver, () => outboxStats(driver)).statements).toBe(1);
  });

  test("no outbox table yet (a first migration refused): nothing to claim, checked again until it exists", () => {
    const driver = createNodeSqliteDriver();
    expect(outboxClaim(driver, m, kinds, 1)).toEqual({ batches: [], parked: [] });
    expect(outboxNextAt(driver, 1)).toBeNull();
    expect(outboxStats(driver)).toEqual({ pending: 0, inFlight: 0, parked: 0 });
    for (const s of SYSTEM_DDL) driver.exec(s);
    seed(driver, pending(3));
    expect(outboxNextAt(driver, 9)).toBe(9);
    expect(outboxClaim(driver, m, kinds, 10).batches[0]!.ids).toHaveLength(3);
  });

  test("release / defer of 500 ids: one UPDATE per chunk", () => {
    const driver = bare();
    seed(driver, pending(500));
    const { batches } = driver.transaction(() => outboxClaim(driver, m, kinds, 5_000, { batchSize: 500 }));
    expect(batches).toHaveLength(1);
    const b = batches[0]!;
    expect(counted(driver, () => outboxDefer(driver, b, 9_000, 100)).statements).toBe(Math.ceil(500 / (OUTBOX_MAX_PARAMS - 3)));
    expect(dump(driver).every((x) => Number(x.sent_at) === 8_900 && Number(x.sent) === b.claim)).toBe(true);
    expect(counted(driver, () => outboxRelease(driver, b)).statements).toBe(Math.ceil(500 / (OUTBOX_MAX_PARAMS - 2)));
    expect(dump(driver).every((x) => Number(x.sent) === 0 && Number(x.sent_at) === 0)).toBe(true);
  });

  test("ack of 500 delivered rows: one DELETE per 43 (doc_id, seq) pairs plus the pending count (was 501)", () => {
    const driver = bare();
    seed(driver, pending(500));
    const { batches } = driver.transaction(() => outboxClaim(driver, m, kinds, 5_000, { batchSize: 500 }));
    const b = batches[0]!;
    const items = asRead(driver, b.ids);
    const r = counted(driver, () => driver.transaction(() => outboxAck(driver, "docs", "by_vec", items, b.claim)));
    expect(r.value).toBe(0);
    expect(r.statements).toBe(Math.ceil(500 / Math.floor((OUTBOX_MAX_PARAMS - 3) / 2)) + 1);
    expect(dump(driver)).toEqual([]);
  });

  test("the pending count: the steady-state range seeks this index's rows only; the legacy ranges are seeks on `sent_at`", () => {
    const driver = bare();
    seed(driver, pending(OUTBOX_PENDING_CAP + 50));
    seed(driver, pending(3, "hybrid"));
    expect(outboxAck(driver, "docs", "by_vec", [], 1)).toBe(OUTBOX_PENDING_CAP);
    expect(outboxAck(driver, "docs", "hybrid", [], 1)).toBe(3);
    // The count statement itself: the `sent_at = 0` range (every row the current code makes pending) binds tbl and idx
    // (the `sent` index's entries end with the primary key), so a backlog in another index is never visited there. The
    // two other ranges only bind `sent_at`: they hold parked rows revived by an older version, from any index, and
    // read those (LIMIT caps matches, not rows read) until they are claimed again; empty in steady state.
    const sql = counted(driver, () => outboxAck(driver, "docs", "hybrid", [], 1)).sql.at(-1)!;
    const plan = driver.exec(`EXPLAIN QUERY PLAN ${sql}`, "docs", "hybrid", OUTBOX_PENDING_CAP).rows.map((r) => String(r.detail));
    expect(plan.filter((d) => d.includes(OUTBOX))).toEqual([
      expect.stringMatching(/SEARCH _ember_ext_outbox USING COVERING INDEX _ember_ext_outbox_due \(<expr>=\? AND sent_at=\? AND tbl=\? AND idx=\?\)/),
      expect.stringMatching(/SEARCH _ember_ext_outbox USING COVERING INDEX _ember_ext_outbox_due \(<expr>=\? AND sent_at>\?\)/),
      expect.stringMatching(/SEARCH _ember_ext_outbox USING COVERING INDEX _ember_ext_outbox_due \(<expr>=\? AND sent_at<\?\)/),
    ]);
  });

  test("a parked row revived by a write (or a backfill) is pending at sent_at = 0, where the count seeks", () => {
    const driver = createNodeSqliteDriver();
    const base = defineSchema({ tables: { docs: defineTable({ title: v.string(), embedding: v.optional(v.array(v.number())) }) } });
    const e1 = createEngine({ schema: base, driver });
    e1.migrate();
    const ids = e1.runMutation(
      mutationGeneric({ handler: (ctx: MutationCtx) => Array.from({ length: 1_000 }, (_, i) => ctx.db.insert("docs", { title: `t${i}`, embedding: P(i + 1) })) }) as never,
      {},
    ).value as unknown as string[];
    // A large parked backlog of one index (left from an earlier delivery).
    const park = () => driver.exec(`UPDATE "${OUTBOX}" SET "sent" = -1, "sent_at" = 1700000000000, "attempts" = 10`);
    for (const id of ids) driver.exec(`INSERT INTO "${OUTBOX}" ("tbl", "idx", "doc_id", "seq") VALUES ('docs', 'by_vec', ?, 1)`, id);
    park();
    const revived = () => driver.exec(`SELECT "sent", "sent_at", "attempts", count(*) AS n FROM "${OUTBOX}" WHERE "idx" = 'by_vec' GROUP BY 1, 2, 3`).rows;
    // Revived by the staged backfill of the index (the same ON CONFLICT as a write).
    const e2 = createEngine({ schema, driver });
    e2.migrate();
    let p;
    do p = e2.backfillStep(300);
    while (!p.done);
    expect(revived()).toEqual([{ sent: 0, sent_at: 0, attempts: 0, n: 1_000 }]);
    // Revived by writes to the documents.
    park();
    e2.runMutation(mutationGeneric({ handler: (ctx: MutationCtx) => { for (const id of ids) ctx.db.patch(id as never, { embedding: P(-1) }); } }) as never, {});
    expect(revived()).toEqual([{ sent: 0, sent_at: 0, attempts: 0, n: 1_000 }]);
    // Nothing of that backlog in the sent_at ≠ 0 ranges the count of another index also reads.
    expect(Number(driver.exec(`SELECT count(*) AS n FROM "${OUTBOX}" WHERE "sent" = 0 AND "sent_at" <> 0`).rows[0]!.n)).toBe(0);
    driver.exec(`DELETE FROM "${OUTBOX}" WHERE "idx" = 'hybrid'`);
    expect(outboxAck(driver, "docs", "hybrid", [], 1)).toBe(0);
    // A row revived before this rule (it kept its old sent_at) is still counted, until its next claim moves it.
    driver.exec(`INSERT INTO "${OUTBOX}" ("tbl", "idx", "doc_id", "seq", "sent", "sent_at") VALUES ('docs', 'hybrid', 'h0', 1, 0, 1700000000000)`);
    expect(outboxAck(driver, "docs", "hybrid", [], 1)).toBe(1);
    expect(outboxAck(driver, "docs", "by_vec", [], 1)).toBe(OUTBOX_PENDING_CAP);
  });

  test("fetch reads the outbox first, in one statement, and only the documents still under the claim", () => {
    const driver = createNodeSqliteDriver();
    let clock = 1_700_000_000_000;
    const engine = createEngine({ schema, driver, now: () => (clock += 1) });
    engine.migrate();
    const ids = engine.runMutation(
      mutationGeneric({ handler: (ctx: MutationCtx) => Array.from({ length: 50 }, (_, i) => (ctx.db as any).insert("docs", { title: `t${i}`, embedding: P(i + 1) })) }) as any,
      {},
    ).value as string[];
    const first = driver.transaction(() => outboxClaim(driver, m, kinds, clock, { resendMs: 10 })).batches.find((b) => b.index === "by_vec")!;
    // A re-send supersedes the first claim: the first delivery's fetch reads no document at all.
    const second = driver.transaction(() => outboxClaim(driver, m, kinds, clock + 1_000, { resendMs: 10 })).batches.find((b) => b.index === "by_vec")!;
    const stale = counted(driver, () => outboxFetch(driver, m, kinds, "docs", "by_vec", first.ids, first.claim));
    expect(stale.value.items.every((i) => !i.current && i.doc === null)).toBe(true);
    expect(stale.statements).toBe(1);
    const fresh = counted(driver, () => outboxFetch(driver, m, kinds, "docs", "by_vec", second.ids, second.claim));
    expect(fresh.value.items.map((i) => i.doc?.values?.[0])).toEqual(ids.map((_, i) => i + 1));
    expect(fresh.statements).toBe(1 + 1 + 1); // outbox rows, table storage, one primary-key IN (…) read for the 50 documents
  });
});

// ------------------------------------------------------------------------------------------------ equivalence

describe("outbox delivery: same outcome as the per-row loops", () => {
  const sizes = [1, 42, 43, 44, 85, 86, 87, 88, 89, 172, 260];

  test.each(sizes)("claim of %i rows (pending, stale, parked, unknown index)", (n) => {
    const rnd = prng(n * 7919);
    const rows: Row[] = Array.from({ length: n }, (_, i) => {
      const x = rnd();
      return {
        tbl: "docs",
        idx: x < 0.1 ? "gone" : x < 0.5 ? "by_vec" : "hybrid",
        doc_id: `d${String(i).padStart(4, "0")}`,
        seq: i + 1,
        sent: rnd() < 0.7 ? 0 : 5,
        sent_at: Math.floor(rnd() * 3) * 100,
        attempts: rnd() < 0.15 ? 10 : Math.floor(rnd() * 3),
      };
    });
    const a = bare();
    const b = bare();
    seed(a, rows);
    seed(b, rows);
    const o = { resendMs: 150, maxAttempts: 10, batchSize: 50, limit: 500 };
    const want = a.transaction(() => oldClaim(a, 1_000, o));
    const got = b.transaction(() => outboxClaim(b, m, kinds, 1_000, o));
    expect(got.parked).toEqual(want.parked);
    expect(got.batches.map(({ claim: _c, ...x }) => x)).toEqual(want.batches.map(({ claim: _c, ...x }) => x));
    const claim = got.batches[0]?.claim;
    expect(dump(b).map((r) => ({ ...r, sent: Number(r.sent) === claim ? 77 : r.sent }))).toEqual(dump(a));
  });

  test.each(sizes)("ack of %i items: clean, written since, superseded, parked, gone, null seq, duplicates", (n) => {
    const rnd = prng(n * 104729);
    const claim = 4242;
    const rows: Row[] = [];
    const acks: Array<{ id: string; seq: number | null }> = [];
    for (let i = 0; i < n; i++) {
      const id = `d${String(i).padStart(4, "0")}`;
      const x = rnd();
      const seq = 10_000 + i;
      // Row states: delivered under this claim (seq as read, or written since), superseded, parked, gone.
      if (x < 0.4) rows.push({ tbl: "docs", idx: "by_vec", doc_id: id, seq, sent: claim, sent_at: 5, attempts: 1 });
      else if (x < 0.55) rows.push({ tbl: "docs", idx: "by_vec", doc_id: id, seq: seq + 1, sent: claim, sent_at: 5, attempts: 1 });
      else if (x < 0.7) rows.push({ tbl: "docs", idx: "by_vec", doc_id: id, seq, sent: 9999, sent_at: 6, attempts: 2 });
      else if (x < 0.8) rows.push({ tbl: "docs", idx: "by_vec", doc_id: id, seq, sent: -1, sent_at: 6, attempts: 10 });
      else if (x < 0.85) rows.push({ tbl: "docs", idx: "by_vec", doc_id: id, seq, sent: 0, sent_at: 0, attempts: 0 });
      acks.push({ id, seq: rnd() < 0.1 ? null : seq });
      if (rnd() < 0.05) acks.push({ id, seq }); // the same id twice in one ack
    }
    rows.push(...pending(3, "hybrid")); // another index: untouched
    const a = bare();
    const b = bare();
    seed(a, rows);
    seed(b, rows);
    const want = a.transaction(() => oldAck(a, "docs", "by_vec", acks, claim));
    const got = b.transaction(() => outboxAck(b, "docs", "by_vec", acks, claim));
    expect(got).toBe(Math.min(want, OUTBOX_PENDING_CAP));
    expectSameOutcome(rows, dump(a), dump(b));
    // Without a claim (a message from an older version): every row is superseded or gone.
    const c = bare();
    const d = bare();
    seed(c, rows);
    seed(d, rows);
    expect(d.transaction(() => outboxAck(d, "docs", "by_vec", acks, null))).toBe(Math.min(c.transaction(() => oldAck(c, "docs", "by_vec", acks, null)), OUTBOX_PENDING_CAP));
    expectSameOutcome(rows, dump(c), dump(d));
  });

  test("an id acknowledged twice sees its first ack (re-enqueued, as the per-row loop did)", () => {
    const driver = bare();
    seed(driver, [{ tbl: "docs", idx: "by_vec", doc_id: "x", seq: 5, sent: 7, sent_at: 1, attempts: 1 }]);
    expect(outboxAck(driver, "docs", "by_vec", [{ id: "x", seq: 5 }, { id: "x", seq: 5 }], 7)).toBe(1);
    expect(dump(driver).map((r) => [r.doc_id, r.sent])).toEqual([["x", 0]]);
  });
});

// ------------------------------------------------------------------------------------------------ crash mid-batch

describe("outbox delivery: a failure mid-batch rolls the whole call back", () => {
  /** Throws on the `n`th statement matching `re` (the DO aborting the transaction mid-way). */
  function failOn(driver: NodeSqliteDriver, re: RegExp, n: number) {
    const exec = driver.exec;
    let seen = 0;
    driver.exec = (s, ...p) => {
      if (re.test(s) && ++seen === n) {
        driver.exec = exec;
        throw new Error("boom");
      }
      return exec.call(driver, s, ...p);
    };
  }

  test("claim: no row claimed, the next claim takes them all", () => {
    const driver = bare();
    seed(driver, pending(300));
    const before = dump(driver);
    failOn(driver, /^UPDATE/, 3);
    expect(() => driver.transaction(() => outboxClaim(driver, m, kinds, 1_000))).toThrow("boom");
    expect(dump(driver)).toEqual(before);
    const again = driver.transaction(() => outboxClaim(driver, m, kinds, 1_000));
    expect(again.batches.flatMap((b) => b.ids)).toHaveLength(300);
  });

  test("ack: nothing deleted or re-enqueued; retried, the same outcome as one clean ack", () => {
    const driver = bare();
    seed(driver, pending(200));
    const { batches } = driver.transaction(() => outboxClaim(driver, m, kinds, 1_000, { batchSize: 200 }));
    const b = batches[0]!;
    const items = asRead(driver, b.ids);
    // Half of the documents written since the fetch, and two acks for rows already gone.
    driver.exec(`UPDATE "${OUTBOX}" SET "seq" = "seq" + 1 WHERE "doc_id" >= 'd00100'`);
    const acks = [...items, { id: "zz1", seq: 1 }, { id: "zz2", seq: null }];
    const before = dump(driver);
    failOn(driver, /^DELETE/, 4);
    expect(() => driver.transaction(() => outboxAck(driver, "docs", "by_vec", acks, b.claim))).toThrow("boom");
    expect(dump(driver)).toEqual(before);
    expect(driver.transaction(() => outboxAck(driver, "docs", "by_vec", acks, b.claim))).toBe(OUTBOX_PENDING_CAP);
    const left = dump(driver);
    expect(left.filter((r) => r.doc_id < "d00100")).toEqual([]);
    expect(left.filter((r) => r.doc_id.startsWith("d")).every((r) => Number(r.sent) === 0)).toBe(true);
    expect(left.filter((r) => r.doc_id.startsWith("zz")).map((r) => [r.doc_id, r.sent])).toEqual([["zz1", 0], ["zz2", 0]]);
  });
});

describe("outbox table remembered per driver", () => {
  test("a table dropped after it was seen (a local database wiped): forgotten, answered as no outbox, found again", () => {
    const driver = bare();
    seed(driver, pending(2));
    expect(outboxNextAt(driver, 5)).toBe(5);
    driver.exec(`DROP TABLE "${OUTBOX}"`);
    expect(outboxClaim(driver, m, kinds, 6)).toEqual({ batches: [], parked: [] });
    expect(outboxNextAt(driver, 6)).toBeNull();
    expect(outboxStats(driver)).toEqual({ pending: 0, inFlight: 0, parked: 0 });
    for (const s of SYSTEM_DDL) driver.exec(s);
    seed(driver, pending(1));
    expect(outboxNextAt(driver, 7)).toBe(7);
    // Another failure is not swallowed.
    const exec = driver.exec;
    driver.exec = () => {
      throw new Error("disk I/O error");
    };
    expect(() => outboxStats(driver)).toThrow("disk I/O error");
    driver.exec = exec;
  });
});
