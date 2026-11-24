// SQLite cost of internal maintenance (PR 4A-4): rows written by aggregate maintenance, and index use (no table scan,
// no temp B-tree) of the `_files` GC and the external-index outbox. Each check counts rows written / statements or reads
// EXPLAIN QUERY PLAN, and the rewritten queries are compared with the ones they replace on random data.

import { describe, expect, test } from "vitest";
import { createNodeSqliteDriver, type NodeSqliteDriver } from "../src/testing.ts";
import {
  createEngine,
  defineSchema,
  defineTable,
  fileKey,
  FileStore,
  outboxClaim,
  outboxNextAt,
  SYSTEM_DDL,
  tmpKey,
  v,
} from "../src/index.ts";
import { FILES_DDL } from "../src/files.ts";
import { fresh, prng } from "./fixtures.ts";

type Stmt = { sql: string; params: unknown[]; rowsWritten: number };

/** The statements `fn` runs on `driver`, with the rows each wrote. */
function trace<R>(driver: NodeSqliteDriver, fn: () => R): { value: R; stmts: Stmt[] } {
  const stmts: Stmt[] = [];
  const exec = driver.exec;
  driver.exec = (sql, ...params) => {
    const r = exec.call(driver, sql, ...params);
    stmts.push({ sql, params, rowsWritten: r.rowsWritten });
    return r;
  };
  try {
    return { value: fn(), stmts };
  } finally {
    driver.exec = exec;
  }
}

/** EXPLAIN QUERY PLAN details of a statement. */
const plan = (driver: NodeSqliteDriver, sql: string, params: unknown[] = []) =>
  driver.exec(`EXPLAIN QUERY PLAN ${sql}`, ...(params as never[])).rows.map((r) => String(r.detail));

const expectIndexed = (details: string[], table: string) => {
  // (an ordered walk of an index, as `_files_deleting` with LIMIT 1, is fine: only a table scan is refused)
  expect(details.filter((d) => d.startsWith(`SCAN ${table}`) && !d.includes(" INDEX "))).toEqual([]);
  expect(details.filter((d) => d.includes("TEMP B-TREE"))).toEqual([]);
};

// ------------------------------------------------------------------------------------------------ aggregates

describe("aggregates: rows written", () => {
  const schema = defineSchema({
    tables: {
      items: defineTable({ g: v.string(), x: v.number() })
        .aggregate("ext", { by: ["g"], min: ["x"], max: ["x"] })
        .aggregate("n", { by: ["g"] }),
    },
  });
  const setup = () => {
    const env = fresh({ schema });
    const put = (g: string, x: number) => env.insert("items", { g, x });
    const ext = (g: string) => env.run((db: any) => db.aggregate("items", "ext").get([g])).value as any;
    const n = (g: string) => env.run((db: any) => db.aggregate("items", "n").get([g])).value as any;
    /** Aggregate statements of a write: rows written to the group table / the multiset, and the extreme seeks. */
    const cost = (fn: () => void) => {
      const { stmts } = trace(env.driver, fn);
      const on = (t: string) => stmts.filter((s) => new RegExp(`(INTO|UPDATE|FROM) "${t}"`).test(s.sql));
      const written = (t: string) => on(t).reduce((a, s) => a + s.rowsWritten, 0);
      return {
        group: written("items__ext"),
        mm: written("items__ext__mm"),
        seeks: on("items__ext__mm").filter((s) => /ORDER BY "key" (ASC|DESC) LIMIT 1/.test(s.sql)).length,
        mmStatements: on("items__ext__mm").map((s) => s.sql),
      };
    };
    return { ...env, put, ext, n, cost };
  };

  test("the last copy of a value leaves the multiset with one written row (a DELETE, not n = 0 then DELETE)", () => {
    const s = setup();
    s.put("a", 1);
    const mid = s.put("a", 5);
    s.put("a", 9);
    const c = s.cost(() => s.patch(mid, { x: 6 }));
    // 6 in, 5 out: one row each; min/max unchanged, so the group row is not written either (was 4 rows: +6, 5 -> 0,
    // DELETE 5, the group row).
    expect(c).toMatchObject({ mm: 2, group: 0, seeks: 0 });
    expect(c.mmStatements.some((q) => /"n" - 1 WHERE "key" = \? AND "n" > 1/.test(q))).toBe(true);
    expect(s.ext("a")).toEqual({ count: 3, sum: {}, min: { x: 1 }, max: { x: 9 } });
    // A value with other copies: one UPDATE (n - 1), no DELETE, no seek.
    s.put("a", 9);
    const dup = s.cost(() => s.patch(mid, { x: 9 }));
    expect(dup).toMatchObject({ mm: 2, group: 0, seeks: 0 });
    expect(Number(s.sql(`SELECT "n" FROM "items__ext__mm" ORDER BY "key" DESC LIMIT 1`)[0]!.n)).toBe(3);
  });

  test("a monotonic update (a growing max, a shrinking min) needs no seek; the group is written once", () => {
    const s = setup();
    const lo = s.put("a", 1);
    const hi = s.put("a", 9);
    expect(s.cost(() => s.patch(hi, { x: 10 }))).toMatchObject({ seeks: 0, group: 1, mm: 2 });
    expect(s.cost(() => s.patch(lo, { x: 0 }))).toMatchObject({ seeks: 0, group: 1, mm: 2 });
    expect(s.ext("a")).toEqual({ count: 2, sum: {}, min: { x: 0 }, max: { x: 10 } });
    // The min moving up past another value still seeks the new min (one seek).
    expect(s.cost(() => s.patch(lo, { x: 12 }))).toMatchObject({ seeks: 1, group: 1 });
    expect(s.ext("a")).toEqual({ count: 2, sum: {}, min: { x: 10 }, max: { x: 12 } });
  });

  test("the group's last document out: the row and its multiset entries go, with no seek", () => {
    const s = setup();
    const only = s.put("b", 3);
    s.put("a", 1);
    const c = s.cost(() => s.del(only));
    expect(c).toMatchObject({ seeks: 0, group: 1, mm: 1 });
    expect(s.ext("b")).toEqual({ count: 0, sum: {}, min: { x: null }, max: { x: null } });
    expect(s.n("b")).toEqual({ count: 0, sum: {}, min: {}, max: {} });
    expect(s.sql(`SELECT count(*) AS n FROM "items__ext__mm"`)[0]!.n).toBe(1);
  });

  test("the new value goes in before the old one leaves: an old extreme with other copies, and the seek after it", () => {
    const s = setup();
    const a = s.put("a", 9);
    const b = s.put("a", 9);
    s.put("a", 1);
    // One copy of the max leaves: the other keeps it (no seek).
    expect(s.cost(() => s.patch(a, { x: 5 }))).toMatchObject({ seeks: 0, group: 0 });
    expect(s.ext("a")).toEqual({ count: 3, sum: {}, min: { x: 1 }, max: { x: 9 } });
    // The last copy leaves: the seek runs after 5 went in again, and finds it (two copies now).
    expect(s.cost(() => s.patch(b, { x: 5 }))).toMatchObject({ seeks: 1, group: 1 });
    expect(s.ext("a")).toEqual({ count: 3, sum: {}, min: { x: 1 }, max: { x: 5 } });
    // A value moved onto the extreme it leaves (+1 then -1 on the same entry): nothing changes.
    expect(s.cost(() => s.patch(b, { x: 5 }))).toMatchObject({ seeks: 0, group: 0, mm: 0 });
  });

  test("random updates and deletes: min/max match a recount from the documents, and the multiset drains", () => {
    const s = setup();
    const rnd = prng(7);
    const docs = new Map<string, { g: string; x: number }>();
    for (let i = 0; i < 400; i++) {
      const ids = [...docs.keys()];
      const g = rnd() < 0.5 ? "a" : "b";
      const x = Math.floor(rnd() * 6);
      const op = ids.length ? rnd() : 0;
      if (op < 0.4) docs.set(s.put(g, x), { g, x });
      else {
        const id = ids[Math.floor(rnd() * ids.length)]!;
        if (op < 0.75) {
          s.patch(id, { x });
          docs.get(id)!.x = x;
        } else {
          s.del(id);
          docs.delete(id);
        }
      }
      for (const k of ["a", "b"]) {
        const xs = [...docs.values()].filter((d) => d.g === k).map((d) => d.x);
        const want = xs.length ? { min: { x: Math.min(...xs) }, max: { x: Math.max(...xs) } } : { min: { x: null }, max: { x: null } };
        expect(s.ext(k)).toEqual({ count: xs.length, sum: {}, ...want });
      }
    }
    for (const id of docs.keys()) s.del(id);
    expect(s.sql(`SELECT count(*) AS n FROM "items__ext__mm"`)[0]!.n).toBe(0);
    expect(s.sql(`SELECT count(*) AS n FROM "items__ext"`)[0]!.n).toBe(0);
  });

  test("optional min/max fields: a group whose documents differ in them leaves no multiset entry behind", () => {
    const opt = defineSchema({
      tables: { items: defineTable({ g: v.string(), x: v.optional(v.number()), y: v.optional(v.number()) }).aggregate("ext", { by: ["g"], min: ["x", "y"], max: ["x", "y"] }) },
    });
    const env = fresh({ schema: opt });
    const ids = [env.insert("items", { g: "a", x: 1 }), env.insert("items", { g: "a", y: 2 }), env.insert("items", { g: "a" }), env.insert("items", { g: "a", x: 3, y: 4 })];
    expect(Number(env.sql(`SELECT count(*) AS n FROM "items__ext__mm"`)[0]!.n)).toBe(4);
    // The last document out has no x or y: the entries of the others left with them.
    for (const id of [ids[0]!, ids[3]!, ids[1]!, ids[2]!]) env.del(id);
    expect(env.sql(`SELECT count(*) AS n FROM "items__ext__mm"`)[0]!.n).toBe(0);
    expect(env.sql(`SELECT count(*) AS n FROM "items__ext"`)[0]!.n).toBe(0);
  });

  test("count-only groups: the values reported to subscribers come from the count alone", () => {
    const s = setup();
    const ids = [s.put("a", 1), s.put("a", 2)];
    const changes = (r: { changes: any[] }) => r.changes.filter((c) => c.table === "items__n").map((c) => [c.before?.count ?? null, c.after?.count ?? null]);
    expect(changes(s.tx((db) => db.insert("items", { g: "a", x: 3 })))).toEqual([[2, 3]]);
    expect(changes(s.del(ids[0]!) as never)).toEqual([[3, 2]]);
    expect(s.n("a")).toEqual({ count: 2, sum: {}, min: {}, max: {} });
  });
});

// ------------------------------------------------------------------------------------------------ files

/** `_files` with the given rows (state, refcount, zero_since, updated_at). */
function filesDb(rows: Array<{ id: string; state: string; refcount: number; zero_since: number | null; updated_at?: number; key?: string; sha256?: string | null }>) {
  const driver = createNodeSqliteDriver();
  for (const s of FILES_DDL) driver.exec(s);
  for (const r of rows) {
    driver.exec(
      `INSERT INTO "_files" ("id", "sha256", "refcount", "state", "key", "token", "created_at", "updated_at", "zero_since") VALUES (?, ?, ?, ?, ?, 't', 0, ?, ?)`,
      r.id, r.sha256 ?? null, r.refcount, r.state, r.key ?? `k/${r.id}`, r.updated_at ?? 0, r.zero_since,
    );
  }
  return driver;
}

const GRACE = 1_000;
const store = (driver: NodeSqliteDriver) => FileStore.ofDriver(driver, { shard: () => "org:a", gcGraceMs: GRACE, urlTtlSeconds: 60 });

/** What `nextGcAt` and `gcBegin` computed before (one CASE over every unreferenced row), for comparison. */
function oldNextGcAt(driver: NodeSqliteDriver, hold: number): number | null {
  const r = driver.exec(
    `SELECT (SELECT "updated_at" FROM "_files" WHERE "state" = 'deleting' ORDER BY "updated_at" LIMIT 1) AS d, ` +
      `(SELECT "zero_since" FROM "_files" WHERE "refcount" = 0 AND "zero_since" > 0 AND "state" = 'pending' ORDER BY "zero_since" LIMIT 1) AS p, ` +
      `(SELECT "zero_since" FROM "_files" WHERE "refcount" = 0 AND "zero_since" IS NOT NULL AND "state" != 'deleting' AND NOT ("state" = 'pending' AND "zero_since" > 0) ORDER BY "zero_since" LIMIT 1) AS g`,
  ).rows[0]!;
  const at = [r.d === null ? null : Number(r.d) + 60_000, r.p === null ? null : Number(r.p) + hold, r.g === null ? null : Number(r.g) + GRACE].filter((x): x is number => x !== null);
  return at.length ? Math.min(...at) : null;
}
function oldDue(driver: NodeSqliteDriver, now: number, hold: number): string[] {
  return driver
    .exec(
      `SELECT "id" FROM "_files" WHERE "refcount" = 0 AND "zero_since" IS NOT NULL AND "zero_since" + (CASE WHEN "state" = 'pending' AND "zero_since" > 0 THEN ? ELSE ? END) <= ? AND "state" != 'deleting' ORDER BY "id"`,
      hold, GRACE, now,
    )
    .rows.map((r) => String(r.id));
}

describe("files GC: index use", () => {
  test("nextGcAt and gcBegin seek `_files_gc_due` per state (no scan, no sort), even with one state empty", () => {
    // Many unreferenced ready rows and no pending upload: finding the oldest pending one used to walk all of them.
    const driver = filesDb(Array.from({ length: 200 }, (_, i) => ({ id: `r${i}`, state: "ready", refcount: 0, zero_since: 10_000 + i })));
    const fs = store(driver);
    const next = trace(driver, () => fs.nextGcAt());
    expect(next.value).toBe(10_000 + GRACE);
    const details = plan(driver, next.stmts[0]!.sql);
    expectIndexed(details, "_files");
    expect(details.filter((d) => d.includes("_files_gc_due"))).toHaveLength(4);
    const begin = trace(driver, () => driver.transaction(() => fs.gcBegin(10_000 + GRACE + 5, 3)));
    expect(begin.value.map((x) => x.id)).toEqual(["r0", "r1", "r2"]);
    const claim = begin.stmts.find((s) => s.sql.includes(`SET "state" = 'deleting'`))!;
    const claimPlan = plan(driver, claim.sql, claim.params);
    expectIndexed(claimPlan, "_files");
    expect(claimPlan.some((d) => /USING (COVERING )?INDEX _files_gc_due \(state=\? AND zero_since>\? AND zero_since<\?\)/.test(d))).toBe(true);
  });

  test("same results as the CASE over every row, on random rows", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const rnd = prng(seed);
      const states = ["pending", "ready", "failed", "deleting"];
      const rows = Array.from({ length: 40 }, (_, i) => ({
        id: `f${String(i).padStart(3, "0")}`,
        state: states[Math.floor(rnd() * 4)]!,
        refcount: rnd() < 0.7 ? 0 : 2,
        zero_since: rnd() < 0.1 ? null : rnd() < 0.2 ? 0 : Math.floor(rnd() * 200_000),
        updated_at: Math.floor(rnd() * 200_000),
      }));
      const driver = filesDb(rows);
      const fs = store(driver);
      expect(fs.nextGcAt()).toBe(oldNextGcAt(driver, fs.pendingHoldMs));
      const now = Math.floor(rnd() * 300_000);
      const want = oldDue(driver, now, fs.pendingHoldMs);
      // (the stale `deleting` retry of gcBegin is unchanged: only the claimed ids are compared)
      const claimed = driver.transaction(() => fs.gcBegin(now, 1_000)).map((x) => x.id);
      expect(claimed.filter((id) => !rows.find((r) => r.id === id && r.state === "deleting")).sort()).toEqual(want);
    }
  });

  test("generateUploadUrl reads only a ready copy of the content", () => {
    const sha = "c".repeat(64);
    const driver = filesDb([{ id: "p1", state: "pending", refcount: 0, zero_since: 5, sha256: sha }]);
    const fs = FileStore.ofDriver(driver, { shard: () => "org:a", signer: { putUrl: () => ({ url: "u", headers: {} }), getUrl: () => "g" } as never });
    const pending = trace(driver, () => fs.generateUploadUrl({ sha256: sha }, 10));
    expect(pending.value.exists).toBeUndefined();
    expect(pending.stmts[0]!.sql).toContain(`"sha256" = ? AND "state" = 'ready'`);
    expect(pending.stmts[0]!.params).toEqual([sha]);
    driver.exec(`INSERT INTO "_files" ("id", "sha256", "refcount", "state", "key", "token", "created_at", "updated_at") VALUES ('r1', ?, 0, 'ready', 'k', 'tok', 1, 1)`, sha);
    expect(fs.generateUploadUrl({ sha256: sha }, 11)).toMatchObject({ storageId: "r1", exists: true, token: "tok" });
  });

  test("orphans: one statement per chunk of keys (and of t/ ids), not one or two per key", () => {
    const shas = Array.from({ length: 150 }, (_, i) => i.toString(16).padStart(64, "0"));
    const known = shas.slice(0, 50);
    const tmpRow = "_storage_01J9Z3AAAAAAAAAAAAAAAAAAAB";
    const driver = filesDb([
      ...known.map((sha, i) => ({ id: `k${i}`, state: "ready", refcount: 1, zero_since: null, key: fileKey("org:a", sha) })),
      { id: tmpRow, state: "ready", refcount: 1, zero_since: null, key: fileKey("org:a", "f".repeat(64)) },
    ]);
    const fs = store(driver);
    const keys = [...shas.map((sha) => fileKey("org:a", sha)), tmpKey("org:a", tmpRow), tmpKey("org:a", "_storage_01J9Z3AAAAAAAAAAAAAAAAAAAC"), fileKey("org:b", shas[0]!)];
    const r = trace(driver, () => fs.orphans(keys, false, 1));
    expect(r.value.map((x) => x.key)).toEqual([...shas.slice(50).map((sha) => fileKey("org:a", sha)), tmpKey("org:a", "_storage_01J9Z3AAAAAAAAAAAAAAAAAAAC")]);
    // 152 keys of this shard in two chunks, the 2 t/ ids in one.
    expect(r.stmts).toHaveLength(3);
    for (const s of r.stmts) expectIndexed(plan(driver, s.sql, s.params), "_files");
    // With claim: the same reads plus one tombstone per orphan.
    const claimed = trace(driver, () => driver.transaction(() => fs.orphans(keys, true, 2)));
    expect(claimed.value).toHaveLength(101);
    expect(claimed.stmts.filter((s) => s.sql.startsWith("INSERT"))).toHaveLength(101);
    expect(fs.orphans(keys, false, 3)).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------ outbox

const OUTBOX = "_ember_ext_outbox";
const outboxSchema = defineSchema({
  tables: { docs: defineTable({ title: v.string(), embedding: v.optional(v.array(v.number())) }).vectorIndex("by_vec", { vectorField: "embedding", dimensions: 32 }) },
});

describe("outbox: index use", () => {
  test("outboxNextAt and outboxClaim seek `_due` (no scan, no temp B-tree) with many rows in flight", () => {
    const driver = createNodeSqliteDriver();
    for (const s of SYSTEM_DDL) driver.exec(s);
    // 300 rows in flight under 30 claims (not due yet), 5 pending, 10 parked.
    for (let i = 0; i < 315; i++) {
      const [sent, sentAt] = i < 300 ? [2 * (i % 30) + 1, 50_000 + i] : i < 305 ? [0, 0] : [-1, 7];
      driver.exec(`INSERT INTO "${OUTBOX}" VALUES ('docs', 'by_vec', ?, 1, ?, ?, 0)`, `d${String(i).padStart(3, "0")}`, sent, sentAt);
    }
    outboxNextAt(driver, 0);
    const next = trace(driver, () => outboxNextAt(driver, 1_000, 100_000));
    expect(next.value).toBe(1_000);
    const nextPlan = plan(driver, next.stmts[0]!.sql);
    expectIndexed(nextPlan, OUTBOX);
    expect(nextPlan.filter((d) => d.includes(`COVERING INDEX ${OUTBOX}_due (<expr>=?)`))).toHaveLength(2);
    // Nothing pending: the earliest re-send from the first in-flight entry.
    driver.exec(`DELETE FROM "${OUTBOX}" WHERE "sent" = 0`);
    expect(outboxNextAt(driver, 1_000, 100_000)).toBe(150_000);

    driver.exec(`INSERT INTO "${OUTBOX}" VALUES ('docs', 'by_vec', 'p1', 1, 0, 0, 0)`);
    const claim = trace(driver, () => driver.transaction(() => outboxClaim(driver, outboxSchema.manifest, outboxSchema.indexKinds, 50_100 + 100_000, { resendMs: 100_000, limit: 20 })));
    // The pending row first, then the rows in flight since before now - resendMs, oldest first.
    expect(claim.value.batches.flatMap((b) => b.ids)).toEqual(["p1", ...Array.from({ length: 19 }, (_, i) => `d${String(i).padStart(3, "0")}`)]);
    const read = claim.stmts.find((s) => s.sql.startsWith("SELECT"))!;
    const claimPlan = plan(driver, read.sql, read.params);
    expectIndexed(claimPlan, OUTBOX);
    expect(claimPlan.filter((d) => d.includes(`INDEX ${OUTBOX}_due`))).toHaveLength(2);
    // The claim token is made in JS (no `SELECT random()`): odd, in [1, 2^53 - 1].
    expect(claim.stmts.some((s) => /random\(\)/.test(s.sql))).toBe(false);
    const token = claim.value.batches[0]!.claim;
    expect(Number.isSafeInteger(token) && token > 0 && token % 2 === 1).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------------ upgrade

describe("internal indexes: an existing shard is upgraded on its next wake", () => {
  test("old `_files_gc` is replaced and `_ember_ext_outbox_due` added, once; `_sent` stays; later wakes run no DDL", () => {
    const driver = createNodeSqliteDriver();
    const first = createEngine({ schema: outboxSchema, driver });
    first.migrate();
    // What an older runtime left: the previous indexes instead of the new ones (same schema version).
    driver.exec(`DROP INDEX "_files_gc_due"`);
    driver.exec(`CREATE INDEX "_files_gc" ON "_files" ("zero_since") WHERE "refcount" = 0`);
    driver.exec(`DROP INDEX "${OUTBOX}_due"`);
    driver.exec(`INSERT INTO "${OUTBOX}" VALUES ('docs', 'by_vec', 'x', 1, 0, 0, 0)`);
    const indexes = () =>
      driver
        .exec(`SELECT name FROM sqlite_master WHERE type = 'index' AND (tbl_name = '_files' OR tbl_name = ?) AND sql IS NOT NULL ORDER BY name`, OUTBOX)
        .rows.map((r) => String(r.name));
    const wake = () => trace(driver, () => createEngine({ schema: outboxSchema, driver }).migrate()).stmts.map((s) => s.sql);
    const upgrade = wake();
    // `_sent` is kept for one release (a rolled-back runtime names it in `INDEXED BY`; see OUTBOX_DDL).
    expect(indexes()).toEqual(["_ember_ext_outbox_due", "_ember_ext_outbox_sent", "_files_deleting", "_files_gc_due", "_files_key", "_files_sha"]);
    const ddl = (stmts: string[]) => stmts.filter((s) => /^\s*(CREATE|DROP)/i.test(s));
    expect(ddl(upgrade).some((s) => s.includes(`"_files_gc_due"`))).toBe(true);
    expect(ddl(upgrade).some((s) => s.includes(`"${OUTBOX}_due"`))).toBe(true);
    expect(ddl(upgrade).some((s) => /^\s*DROP INDEX IF EXISTS "_files_gc"/.test(s))).toBe(true);
    expect(ddl(upgrade).some((s) => s.includes(`"${OUTBOX}_sent"`))).toBe(false);
    expect(outboxNextAt(driver, 5)).toBe(5);
    // What the previous runtime's ack still runs: its pending count names `_sent`.
    expect(() => driver.exec(`SELECT count(*) FROM "${OUTBOX}" INDEXED BY "${OUTBOX}_sent" WHERE "sent" = 0 AND "tbl" = 'docs'`)).not.toThrow();
    expect(ddl(wake())).toEqual([]);
  });
});
