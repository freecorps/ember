import type { SqlDriver, SqlExecResult, SqlValue } from "./engine-types.ts";

function isThenable(v: unknown): v is PromiseLike<unknown> {
  return (typeof v === "object" || typeof v === "function") && v !== null && typeof (v as { then?: unknown }).then === "function";
}

/** `[statements, rowsRead, rowsWritten]` per statement kind. */
export type SqlCounter = [number, number, number];
export interface SqlCounters {
  select: SqlCounter;
  insert: SqlCounter;
  update: SqlCounter;
  delete: SqlCounter;
  /** DDL, `WITH ...`, pragmas and anything else. */
  other: SqlCounter;
  transactions: number;
}

export const newSqlCounters = (): SqlCounters => ({ select: [0, 0, 0], insert: [0, 0, 0], update: [0, 0, 0], delete: [0, 0, 0], other: [0, 0, 0], transactions: 0 });

/** The kind of a statement by its first keyword (one char code check per statement: no allocation). */
function statementKind(sql: string): "select" | "insert" | "update" | "delete" | "other" {
  let i = 0;
  while (i < sql.length && sql.charCodeAt(i) <= 32) i++;
  switch (sql.charCodeAt(i) | 32) {
    case 115: // s
      return (sql.charCodeAt(i + 1) | 32) === 101 ? "select" : "other";
    case 105: // i
      return "insert";
    case 117: // u
      return "update";
    case 100: // d
      return (sql.charCodeAt(i + 1) | 32) === 101 ? "delete" : "other";
    default:
      return "other";
  }
}

/**
 * SqlDriver over `ctx.storage.sql` + `transactionSync`.
 * - BLOBs come back from DO SQLite as ArrayBuffer; they are normalized to Uint8Array.
 * - Nested `transaction` calls are savepoints (DO nests transactionSync natively).
 * - A callback that returns a Promise is rejected and its writes rolled back:
 *   transactionSync would otherwise commit before the async work runs.
 */
export class DoSqlDriver implements SqlDriver {
  depth = 0;
  /** Cumulative row counters (metrics: the shard diffs them around engine calls). */
  rowsRead = 0;
  rowsWritten = 0;
  /**
   * Statements run since this object started, by kind (the first keyword): `[statements, rowsRead, rowsWritten]`.
   * `transactions` counts `transaction()` calls (top level and savepoints). Separates SQL from JS in `inspect()`.
   */
  readonly counters: SqlCounters = newSqlCounters();

  constructor(private readonly storage: DurableObjectStorage) {}

  exec(sql: string, ...params: SqlValue[]): SqlExecResult {
    for (const p of params) {
      const t = typeof p;
      if (t === "bigint" || t === "boolean" || t === "undefined") {
        throw new TypeError(`SqlDriver: unsupported bind value of type ${t}; convert it in the engine`);
      }
    }
    const cursor = this.storage.sql.exec(sql, ...(params as (string | number | null | ArrayBuffer | ArrayBufferView)[]));
    // Arrays (`raw()`) and one object per row built here: cheaper than the cursor's own row objects, copied again.
    const rows: Record<string, SqlValue>[] = [];
    const names = cursor.columnNames;
    for (const raw of cursor.raw()) {
      const row: Record<string, SqlValue> = {};
      for (let i = 0; i < names.length; i++) {
        const v = raw[i];
        row[names[i]!] = v instanceof ArrayBuffer ? new Uint8Array(v) : (v as SqlValue);
      }
      rows.push(row);
    }
    const r = cursor.rowsRead;
    const w = cursor.rowsWritten;
    this.rowsRead += r;
    this.rowsWritten += w;
    const c = this.counters[statementKind(sql)];
    c[0]++;
    c[1] += r;
    c[2] += w;
    return { rows, rowsRead: r, rowsWritten: w };
  }

  transaction<T>(fn: () => T): T {
    this.counters.transactions++;
    return this.storage.transactionSync(() => {
      this.depth++;
      try {
        const r = fn();
        if (isThenable(r)) {
          // Swallow the eventual rejection; the error below is the one that matters.
          Promise.resolve(r).catch(() => {});
          throw new TypeError("SqlDriver.transaction: callback returned a Promise; mutations must be synchronous");
        }
        return r;
      } finally {
        this.depth--;
      }
    });
  }
}
