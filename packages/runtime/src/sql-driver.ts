import type { SqlDriver, SqlExecResult, SqlValue } from "./engine-types.ts";

function isThenable(v: unknown): v is PromiseLike<unknown> {
  return (typeof v === "object" || typeof v === "function") && v !== null && typeof (v as { then?: unknown }).then === "function";
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
    this.rowsRead += cursor.rowsRead;
    this.rowsWritten += cursor.rowsWritten;
    return { rows, rowsRead: cursor.rowsRead, rowsWritten: cursor.rowsWritten };
  }

  transaction<T>(fn: () => T): T {
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
