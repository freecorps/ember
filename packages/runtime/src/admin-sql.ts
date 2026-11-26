// The dashboard's SQL Explorer, on the shard (docs/design/contracts.md "Dashboard", `POST /api/_ember/sql`).
//
// One read-only query against the Durable Object's SQLite, in two locks:
//   1. `checkReadOnlySql` (@freecorps/ember-server): one SELECT / WITH ... SELECT / VALUES / EXPLAIN QUERY PLAN, by
//      tokens, no write keyword, no internal table (the Worker checks it too, before waking the shard);
//   2. it runs inside `transactionSync`, which this code always aborts (an exception after the rows are read): even a
//      statement that slipped past the check could not persist anything. A cursor that reports `rowsWritten > 0` is
//      refused as well (`SqlWrote`), the rows dropped.
// The answer stops at a row cap (default 500, at most 5000) and a byte budget (`SQL_BYTES_MAX`): `truncated` says the
// query had more. `rowsRead` is the cursor's (what Cloudflare bills), counted in the shard's metrics too.

import { checkReadOnlySql, planTree, SQL_ROWS_DEFAULT, SQL_ROWS_MAX, type SqlPlanNode } from "@freecorps/ember-server";

export type SqlParam = string | number | null | Uint8Array;
export type SqlCell = string | number | null | Uint8Array;

export interface SqlQueryInput {
  sql: string;
  params?: SqlParam[];
  /** Run `EXPLAIN QUERY PLAN <sql>` (also when the text starts with it). */
  explain?: boolean;
  /** Row cap, 1..SQL_ROWS_MAX (default SQL_ROWS_DEFAULT). */
  limit?: number;
}

export interface SqlQueryResult {
  columns: string[];
  rows: SqlCell[][];
  /** Rows SQLite read for this statement (the cursor's `rowsRead`, up to where reading stopped). */
  rowsRead: number;
  /** Always 0 in an answer (a statement that wrote is refused). */
  rowsWritten: number;
  /** The query had more rows than were returned (row cap or byte budget). */
  truncated: boolean;
  ms: number;
  explain: boolean;
  /** With `explain`: the plan as a tree. */
  plan?: SqlPlanNode[];
  /** Things the rows do not show (an integer past 2^53 came back rounded: select `CAST(col AS TEXT)` for it). */
  warnings?: string[];
}

/** `rowsRead` on a failure: what the statement read before it failed (billed all the same); 0 when it never ran. */
export type SqlQueryOutcome = { ok: true; value: SqlQueryResult } | { ok: false; code: "SqlRefused" | "SqlError" | "SqlWrote"; message: string; data?: { at: number }; rowsRead?: number };

/** Answer size budget (approximate bytes of the cells): past it the rows stop and `truncated` is set. */
export const SQL_BYTES_MAX = 4 * 1024 * 1024;

/** Thrown out of `transactionSync` after the rows are read, so it never commits. */
class Abort extends Error {}

const sizeOf = (v: SqlCell): number => (typeof v === "string" ? v.length * 2 : v instanceof Uint8Array ? v.byteLength : 8);

export function runReadOnlySql(storage: Pick<DurableObjectStorage, "sql" | "transactionSync">, input: SqlQueryInput): SqlQueryOutcome {
  const check = checkReadOnlySql(input.sql);
  if (!check.ok) return { ok: false, code: "SqlRefused", message: check.message, data: { at: check.at } };
  const explain = check.explain || input.explain === true;
  const text = explain && !check.explain ? `EXPLAIN QUERY PLAN ${input.sql}` : input.sql;
  const limit = Math.max(1, Math.min(SQL_ROWS_MAX, Math.floor(input.limit ?? SQL_ROWS_DEFAULT) || SQL_ROWS_DEFAULT));
  const params = input.params ?? [];
  const abort = new Abort("read-only");
  let result: SqlQueryResult | null = null;
  let cursor: { rowsRead: number } | null = null;
  const t0 = performance.now();
  try {
    storage.transactionSync(() => {
      const cur = storage.sql.exec(text, ...params);
      cursor = cur;
      const columns = [...cur.columnNames];
      const rows: SqlCell[][] = [];
      let truncated = false;
      let bytes = 0;
      let unsafeInt = false;
      if (columns.length) {
        for (const raw of cur.raw()) {
          if (rows.length >= limit) {
            truncated = true;
            break;
          }
          const row = raw.map((v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : (v as SqlCell)));
          // The budget is checked with the row: one that would pass it is left out (a row that fits exactly stays).
          let size = 0;
          for (const v of row) {
            size += sizeOf(v);
            if (typeof v === "number" && Number.isInteger(v) && !Number.isSafeInteger(v)) unsafeInt = true;
          }
          if (bytes + size > SQL_BYTES_MAX) {
            truncated = true;
            break;
          }
          bytes += size;
          rows.push(row);
        }
      }
      result = { columns, rows, rowsRead: cur.rowsRead, rowsWritten: cur.rowsWritten, truncated, ms: 0, explain };
      if (unsafeInt) result.warnings = ["an integer past 2^53 came back rounded (SQLite integers are read as JavaScript numbers): select it as CAST(col AS TEXT) for the exact value"];
      throw abort;
    });
  } catch (e) {
    if (e !== abort) return { ok: false, code: "SqlError", message: (e as Error).message ?? String(e), rowsRead: (cursor as { rowsRead: number } | null)?.rowsRead ?? 0 };
  }
  const r = result as SqlQueryResult | null;
  if (!r) return { ok: false, code: "SqlError", message: "the statement gave no answer" };
  // Defense in depth: rolled back already, and never answered. `rowsWritten` counts what was stepped (the loop may stop
  // at the cap without draining the cursor: draining a huge SELECT to look for writes would cost what the cap saves).
  // The abort is the guard that always holds; this one catches a write that happened before the rows were read (a DML
  // statement with RETURNING does all of its writes on the first step), which the text check refuses anyway.
  if (r.rowsWritten > 0) return { ok: false, code: "SqlWrote", message: `the statement wrote ${r.rowsWritten} row(s): rolled back, refused`, rowsRead: r.rowsRead };
  r.ms = performance.now() - t0;
  if (explain) r.plan = planTree(r.rows);
  return { ok: true, value: r };
}
