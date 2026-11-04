import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { report, stubFor } from "./helpers";

const N = 100_000;
const PAD = "x".repeat(1000); // ~1KB payload per row

/**
 * Timing note: workerd may freeze/coarsen clocks during synchronous execution
 * (Spectre mitigation). We record BOTH the in-DO clock and the clock in the test
 * runner around each runInDurableObject() hop (which advances on I/O).
 */
async function timed<T>(stub: DurableObjectStub, fn: (s: DurableObjectState) => T | Promise<T>) {
  const t0 = Date.now();
  const r = await runInDurableObject(stub, async (_i, state) => {
    const p0 = performance.now();
    const d0 = Date.now();
    const value = await fn(state);
    return { value, innerPerfMs: performance.now() - p0, innerDateMs: Date.now() - d0 };
  });
  return { ...r, outerMs: Date.now() - t0 };
}

describe("Q3 databaseSize + 100k x 1KB rows", () => {
  it("insert 100k rows, measure size, indexed range vs full scan, rowsRead/rowsWritten", async () => {
    const stub = stubFor("q3-perf");
    const out: Record<string, unknown> = {};

    out.empty = await timed(stub, (s) => {
      s.storage.sql.exec("CREATE TABLE docs (id INTEGER PRIMARY KEY, k INTEGER NOT NULL, unindexed INTEGER NOT NULL, body TEXT NOT NULL)");
      s.storage.sql.exec("CREATE INDEX docs_k ON docs(k)");
      return { databaseSize: s.storage.sql.databaseSize, typeof: typeof s.storage.sql.databaseSize };
    });

    out.noop_hop = await timed(stub, () => 0);

    out.insert_single_row_execs = await timed(stub, (s) => {
      const sql = s.storage.sql;
      let rowsWritten = 0;
      for (let i = 0; i < N; i++) {
        const c = sql.exec("INSERT INTO docs(k, unindexed, body) VALUES (?, ?, ?)", i, i, `${i}:${PAD}`);
        rowsWritten += c.rowsWritten;
      }
      return { rowsWritten, databaseSize: sql.databaseSize };
    });

    out.size_after_insert_next_hop = await timed(stub, (s) => ({ databaseSize: s.storage.sql.databaseSize, mb: +(s.storage.sql.databaseSize / 1048576).toFixed(1) }));

    // Bulk path: one statement per 1k rows (~1MB JSON param) via json_each (avoids 100-param limit)
    out.insert_bulk_json_each = await timed(stub, (s) => {
      const sql = s.storage.sql;
      sql.exec("CREATE TABLE docs2 (id INTEGER PRIMARY KEY, k INTEGER NOT NULL, body TEXT NOT NULL)");
      sql.exec("CREATE INDEX docs2_k ON docs2(k)");
      let rowsWritten = 0;
      for (let start = 0; start < N; start += 1_000) {
        const batch = Array.from({ length: 1_000 }, (_, j) => [start + j, `${start + j}:${PAD}`]);
        const c = sql.exec(
          "INSERT INTO docs2(k, body) SELECT value->>0, value->>1 FROM json_each(?)",
          JSON.stringify(batch),
        );
        c.toArray();
        rowsWritten += c.rowsWritten;
      }
      return { rowsWritten, databaseSize: sql.databaseSize };
    });

    const range = (s: DurableObjectState, col: "k" | "unindexed") => {
      const c = s.storage.sql.exec(`SELECT id, k FROM docs WHERE ${col} BETWEEN ? AND ?`, 50_000, 50_999);
      const rows = c.toArray();
      const plan = s.storage.sql.exec(`EXPLAIN QUERY PLAN SELECT id, k FROM docs WHERE ${col} BETWEEN 1 AND 2`).toArray().map((r: any) => r.detail);
      return { rows: rows.length, rowsRead: c.rowsRead, rowsWritten: c.rowsWritten, plan };
    };
    // repeat each 20x to get measurable times
    const repeat = (s: DurableObjectState, col: "k" | "unindexed") => {
      let last;
      for (let i = 0; i < 20; i++) last = range(s, col);
      return last;
    };
    out.indexed_range_1000_rows_x20 = await timed(stub, (s) => repeat(s, "k"));
    out.full_scan_range_1000_rows_x20 = await timed(stub, (s) => repeat(s, "unindexed"));
    out.count_star = await timed(stub, (s) => {
      const c = s.storage.sql.exec("SELECT COUNT(*) AS n FROM docs");
      const n = c.one().n;
      return { n, rowsRead: c.rowsRead };
    });
    out.point_lookup = await timed(stub, (s) => {
      const c = s.storage.sql.exec("SELECT * FROM docs WHERE k = ?", 77_777);
      c.toArray();
      return { rowsRead: c.rowsRead };
    });
    out.order_by_limit_indexed = await timed(stub, (s) => {
      const c = s.storage.sql.exec("SELECT id FROM docs ORDER BY k DESC LIMIT 10");
      c.toArray();
      return { rowsRead: c.rowsRead };
    });
    out.rowsRead_before_iteration = await timed(stub, (s) => {
      const c = s.storage.sql.exec("SELECT id FROM docs WHERE k < 100");
      const before = c.rowsRead;
      c.next();
      const afterOne = c.rowsRead;
      c.toArray();
      return { before, afterOne, afterAll: c.rowsRead };
    });
    out.update_rows_written = await timed(stub, (s) => {
      const c = s.storage.sql.exec("UPDATE docs SET body = 'short' WHERE k < 100");
      c.toArray();
      return { rowsRead: c.rowsRead, rowsWritten: c.rowsWritten, note: "index on k + table row" };
    });
    out.delete_all_size = await timed(stub, (s) => {
      const before = s.storage.sql.databaseSize;
      s.storage.sql.exec("DELETE FROM docs2");
      return { before, afterDeleteSameTick: s.storage.sql.databaseSize };
    });
    out.size_after_delete_next_hop = await timed(stub, (s) => ({ databaseSize: s.storage.sql.databaseSize }));
    out.drop_table_size = await timed(stub, (s) => { s.storage.sql.exec("DROP TABLE docs2"); return { databaseSize: s.storage.sql.databaseSize }; });

    report("q3.perf", out);
    expect((out.insert_single_row_execs as any).value.rowsWritten).toBeGreaterThanOrEqual(N);
  });
});
