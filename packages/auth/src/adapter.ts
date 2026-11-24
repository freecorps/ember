/**
 * Better Auth database adapter for Durable Object SQLite (`ctx.storage.sql`).
 *
 * Built on `createAdapterFactory` so Better Auth handles id generation,
 * defaults, field renames, Date/boolean/JSON/array (de)serialization and the
 * join planning. We only translate the resulting CleanedWhere/JoinConfig into
 * SQL.
 *
 * The executor is abstract so the same adapter can run:
 *   - inside the DO (production): `exec` = ctx.storage.sql.exec, synchronous
 *   - from a test harness: `exec` = RPC/runInDurableObject (async)
 */
import { createAdapterFactory, type DBAdapterDebugLogOption } from "@better-auth/core/db/adapter";
import type { CleanedWhere, JoinConfig } from "@better-auth/core/db/adapter";
import type { BetterAuthOptions } from "better-auth";
import type { DBAdapter } from "@better-auth/core/db/adapter";

export type SqlValue = string | number | null | ArrayBuffer;
export type ExecResult = {
  rows: Record<string, unknown>[];
  rowsWritten: number;
  /** SQLite's `changes()` right after the statement (rows it changed itself: no cascades, triggers or indexes). */
  changes?: number;
};
export interface SqlExecutor {
  /** `o.changes`: also answer `changes` (only asked of an executor with `reportsChanges`). */
  exec(query: string, params: SqlValue[], o?: { changes?: boolean }): ExecResult | Promise<ExecResult>;
  /**
   * The executor answers `changes` when asked, read in the same synchronous step as the statement (no other statement
   * can run in between). Without it `deleteMany` counts with `RETURNING rowid`.
   */
  reportsChanges?: boolean;
  /**
   * Run `fn` atomically. `fn` receives an executor bound to the transaction.
   * If omitted, Better Auth runs "transactions" sequentially without rollback.
   */
  transaction?: (<R>(fn: (tx: SqlExecutor) => Promise<R>) => Promise<R>) | undefined;
}

/** Wrap a DO `SqlStorage` (ctx.storage.sql) as an executor. */
export const sqlStorageExecutor = (
  sql: SqlStorage,
  transaction?: SqlExecutor["transaction"],
): SqlExecutor => ({
  exec(query, params, o) {
    const cursor = sql.exec(query, ...params);
    const rows = cursor.toArray() as Record<string, unknown>[];
    if (!o?.changes) return { rows, rowsWritten: cursor.rowsWritten };
    return { rows, rowsWritten: cursor.rowsWritten, changes: Number(sql.exec("SELECT changes() AS n").one().n) };
  },
  reportsChanges: true,
  transaction,
});

/** Durable Object SQL takes at most 100 bound parameters per statement. */
const MAX_IN = 90;

export type DOSqliteAdapterConfig = {
  debugLogs?: DBAdapterDebugLogOption;
};

const q = (ident: string) => `"${ident.replaceAll('"', '""')}"`;

const toSqlValue = (v: unknown): SqlValue => {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "bigint") return Number(v);
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "object" && !(v instanceof ArrayBuffer)) return JSON.stringify(v);
  return v as SqlValue;
};

export const doSqliteAdapter = (executor: SqlExecutor, config: DOSqliteAdapterConfig = {}) => {
  let lazyOptions: BetterAuthOptions | null = null;
  // The adapter a transaction runs with, per executor and options: `sqlStorageExecutor`'s transactions hand the same
  // executor every time, so a sign-up does not build a new adapter factory per transaction.
  const txAdapters = new WeakMap<SqlExecutor, { options: BetterAuthOptions; adapter: DBAdapter<BetterAuthOptions> }>();
  const txAdapter = (tx: SqlExecutor): DBAdapter<BetterAuthOptions> => {
    const options = lazyOptions!;
    const hit = txAdapters.get(tx);
    if (hit && hit.options === options) return hit.adapter;
    const adapter = build(tx, true)(options);
    txAdapters.set(tx, { options, adapter });
    return adapter;
  };

  const build = (exec: SqlExecutor, inTransaction: boolean): ((o: BetterAuthOptions) => DBAdapter<BetterAuthOptions>) =>
    createAdapterFactory({
      config: {
        adapterId: "do-sqlite",
        adapterName: "Durable Object SQLite",
        usePlural: false,
        debugLogs: config.debugLogs ?? false,
        supportsNumericIds: true,
        supportsUUIDs: false,
        supportsJSON: false,
        supportsDates: false,
        supportsBooleans: false,
        supportsArrays: false,
        transaction:
          !inTransaction && exec.transaction
            ? (cb) => exec.transaction!((tx): Promise<any> => cb(txAdapter(tx)))
            : false,
      },
      adapter: ({ getFieldName }) => {
        const run = async (sql: string, params: SqlValue[], o?: { changes?: boolean }) => (o ? exec.exec(sql, params, o) : exec.exec(sql, params));

        const col = (modelKey: string, field: string) => q(getFieldName({ model: modelKey, field }));

        /** Better Auth semantics (same as kysely adapter): (AND ...) AND (OR ...). */
        const whereSql = (modelKey: string, where: CleanedWhere[] | undefined) => {
          if (!where || where.length === 0) return { sql: "", params: [] as SqlValue[] };
          const ands: string[] = [];
          const ors: string[] = [];
          const params: SqlValue[] = [];
          for (const w of where) {
            const c = col(modelKey, w.field);
            const value = w.value as unknown;
            const insensitive =
              w.mode === "insensitive" &&
              (typeof value === "string" || (Array.isArray(value) && value.every((x) => typeof x === "string")));
            const lhs = insensitive ? `LOWER(${c})` : c;
            const norm = (x: unknown) => toSqlValue(insensitive && typeof x === "string" ? x.toLowerCase() : x);
            let expr: string;
            switch (w.operator) {
              case "in":
              case "not_in": {
                const arr = Array.isArray(value) ? value : [value];
                expr = `${lhs} ${w.operator === "in" ? "IN" : "NOT IN"} (${arr.map(() => "?").join(", ")})`;
                params.push(...arr.map(norm));
                break;
              }
              // instr/substr instead of LIKE: SQLite LIKE is ASCII-case-insensitive
              // and would treat % and _ in user input as wildcards.
              case "contains":
                expr = `instr(${lhs}, ?) > 0`;
                params.push(norm(value));
                break;
              case "starts_with":
                expr = `substr(${lhs}, 1, length(?)) = ?`;
                params.push(norm(value), norm(value));
                break;
              case "ends_with":
                expr = `(length(${lhs}) >= length(?) AND substr(${lhs}, -length(?)) = ?)`;
                params.push(norm(value), norm(value), norm(value));
                break;
              case "ne":
                if (value === null) expr = `${c} IS NOT NULL`;
                else {
                  expr = `${lhs} <> ?`;
                  params.push(norm(value));
                }
                break;
              case "gt":
              case "gte":
              case "lt":
              case "lte": {
                const op = { gt: ">", gte: ">=", lt: "<", lte: "<=" }[w.operator];
                expr = `${lhs} ${op} ?`;
                params.push(norm(value));
                break;
              }
              case "eq":
              default:
                if (value === null) expr = `${c} IS NULL`;
                else {
                  expr = `${lhs} = ?`;
                  params.push(norm(value));
                }
            }
            (w.connector === "OR" ? ors : ands).push(expr);
          }
          const parts: string[] = [];
          if (ands.length) parts.push(ands.join(" AND "));
          if (ors.length) parts.push(`(${ors.join(" OR ")})`);
          return { sql: ` WHERE ${parts.join(" AND ")}`, params };
        };

        const selectList = (modelKey: string, select?: string[]) =>
          select && select.length ? select.map((f) => col(modelKey, f)).join(", ") : "*";

        /**
         * Joins (Better Auth passes them only with `advanced.database.joins`). One-to-one: one `IN (...)` lookup per
         * join for all base rows (the target is unique: one row per key, the first in rowid order as `LIMIT 1` gave).
         * One-to-many: one lookup per base row, so each stays bounded by its `LIMIT`.
         */
        const applyJoins = async (rows: Record<string, unknown>[], join?: JoinConfig) => {
          if (!join || !rows.length) return rows;
          for (const [joinModel, j] of Object.entries(join)) {
            if (j.relation === "one-to-one") {
              // Keys by type and value: SQLite compares TEXT and INTEGER as different values here too.
              const keyOf = (v: unknown) => `${typeof v}:${String(v)}`;
              const keys = new Map<string, SqlValue>();
              for (const row of rows) {
                const v = toSqlValue(row[j.on.from]);
                if (v !== null) keys.set(keyOf(v), v);
              }
              const found = new Map<string, Record<string, unknown>>();
              const values = [...keys.values()];
              for (let i = 0; i < values.length; i += MAX_IN) {
                const part = values.slice(i, i + MAX_IN);
                const { rows: joined } = await run(`SELECT * FROM ${q(joinModel)} WHERE ${q(j.on.to)} IN (${part.map(() => "?").join(", ")}) ORDER BY rowid`, part);
                for (const r of joined) {
                  const k = keyOf(r[j.on.to]);
                  if (!found.has(k)) found.set(k, r);
                }
              }
              for (const row of rows) {
                const v = toSqlValue(row[j.on.from]);
                row[joinModel] = v === null ? null : (found.get(keyOf(v)) ?? null);
              }
              continue;
            }
            const limit = j.limit ?? 100;
            for (const row of rows) {
              const { rows: joined } = await run(`SELECT * FROM ${q(joinModel)} WHERE ${q(j.on.to)} = ? LIMIT ?`, [toSqlValue(row[j.on.from]), limit]);
              row[joinModel] = joined;
            }
          }
          return rows;
        };

        /**
         * WHERE of a single-row op: the condition itself when it is `id = ?` (the primary key: at most one row), else
         * the rowid of the first matching row (Better Auth's update/delete/consume touch one row).
         */
        const oneRow = (model: string, modelKey: string, where: CleanedWhere[], w: { sql: string }) => {
          const only = where.length === 1 ? where[0]! : null;
          if (only && only.field === "id" && (only.operator ?? "eq") === "eq" && only.value !== null && only.mode !== "insensitive" && getFieldName({ model: modelKey, field: "id" }) === "id") {
            return w.sql.slice(" WHERE ".length);
          }
          return `rowid = (SELECT rowid FROM ${q(model)}${w.sql} LIMIT 1)`;
        };

        return {
          async create({ model, data }) {
            const entries = Object.entries(data as Record<string, unknown>).filter(([, v]) => v !== undefined);
            const sql = entries.length
              ? `INSERT INTO ${q(model)} (${entries.map(([k]) => q(k)).join(", ")}) VALUES (${entries.map(() => "?").join(", ")}) RETURNING *`
              : `INSERT INTO ${q(model)} DEFAULT VALUES RETURNING *`;
            const { rows } = await run(sql, entries.map(([, v]) => toSqlValue(v)));
            return rows[0] as any;
          },
          async findOne({ model, modelKey = model, where, select, join }) {
            const w = whereSql(modelKey, where);
            const { rows } = await run(`SELECT ${selectList(modelKey, select)} FROM ${q(model)}${w.sql} LIMIT 1`, w.params);
            if (!rows[0]) return null;
            return (await applyJoins(rows, join))[0] as any;
          },
          async findMany({ model, modelKey = model, where, limit, select, sortBy, offset, join }) {
            const w = whereSql(modelKey, where);
            let sql = `SELECT ${selectList(modelKey, select)} FROM ${q(model)}${w.sql}`;
            const params = [...w.params];
            if (sortBy?.field) sql += ` ORDER BY ${col(modelKey, sortBy.field)} ${sortBy.direction === "desc" ? "DESC" : "ASC"}`;
            if (limit !== undefined || offset !== undefined) {
              sql += " LIMIT ? OFFSET ?";
              params.push(limit ?? -1, offset ?? 0);
            }
            const { rows } = await run(sql, params);
            return (await applyJoins(rows, join)) as any[];
          },
          async count({ model, modelKey = model, where }) {
            const w = whereSql(modelKey, where);
            const { rows } = await run(`SELECT COUNT(*) AS c FROM ${q(model)}${w.sql}`, w.params);
            return Number(rows[0]?.c ?? 0);
          },
          async update({ model, modelKey = model, where, update }) {
            if (!where.length) return null;
            const entries = Object.entries(update as Record<string, unknown>).filter(([, v]) => v !== undefined);
            const w = whereSql(modelKey, where);
            if (!entries.length) {
              const { rows } = await run(`SELECT * FROM ${q(model)}${w.sql} LIMIT 1`, w.params);
              return (rows[0] ?? null) as any;
            }
            const { rows } = await run(
              `UPDATE ${q(model)} SET ${entries.map(([k]) => `${q(k)} = ?`).join(", ")} WHERE ${oneRow(model, modelKey, where, w)} RETURNING *`,
              [...entries.map(([, v]) => toSqlValue(v)), ...w.params],
            );
            return (rows[0] ?? null) as any;
          },
          async updateMany({ model, modelKey = model, where, update }) {
            const entries = Object.entries(update).filter(([, v]) => v !== undefined);
            if (!entries.length) return 0;
            const w = whereSql(modelKey, where);
            const { rowsWritten } = await run(
              `UPDATE ${q(model)} SET ${entries.map(([k]) => `${q(k)} = ?`).join(", ")}${w.sql}`,
              [...entries.map(([, v]) => toSqlValue(v)), ...w.params],
            );
            return rowsWritten;
          },
          async delete({ model, modelKey = model, where }) {
            if (!where.length) return;
            const w = whereSql(modelKey, where);
            await run(`DELETE FROM ${q(model)} WHERE ${oneRow(model, modelKey, where, w)}`, w.params);
          },
          async deleteMany({ model, modelKey = model, where }) {
            const w = whereSql(modelKey, where);
            // Rows this statement deleted, without FK cascades or triggers (`rowsWritten` counts those, and index
            // writes, too): `changes()`, or RETURNING with an executor that cannot report it. One DELETE either way:
            // an executor that claims `reportsChanges` and answers none breaks its contract (a second DELETE would
            // count 0).
            if (exec.reportsChanges) {
              const r = await run(`DELETE FROM ${q(model)}${w.sql}`, w.params, { changes: true });
              if (r.changes === undefined) throw new Error("ember auth: an executor with reportsChanges answered no `changes`");
              return r.changes;
            }
            const { rows } = await run(`DELETE FROM ${q(model)}${w.sql} RETURNING rowid`, w.params);
            return rows.length;
          },
          async consumeOne({ model, modelKey = model, where }) {
            const w = whereSql(modelKey, where);
            const { rows } = await run(`DELETE FROM ${q(model)} WHERE ${oneRow(model, modelKey, where, w)} RETURNING *`, w.params);
            return (rows[0] ?? null) as any;
          },
          async incrementOne({ model, modelKey = model, where, increment, set }) {
            const w = whereSql(modelKey, where);
            const sets: string[] = [];
            const params: SqlValue[] = [];
            for (const [field, delta] of Object.entries(increment)) {
              const c = q(field);
              sets.push(`${c} = COALESCE(${c}, 0) + ?`);
              params.push(delta);
            }
            for (const [field, v] of Object.entries(set ?? {})) {
              if (v === undefined) continue;
              sets.push(`${q(field)} = ?`);
              params.push(toSqlValue(v));
            }
            if (!sets.length) {
              const { rows } = await run(`SELECT * FROM ${q(model)}${w.sql} LIMIT 1`, w.params);
              return (rows[0] ?? null) as any;
            }
            const { rows } = await run(
              `UPDATE ${q(model)} SET ${sets.join(", ")} WHERE ${oneRow(model, modelKey, where, w)} RETURNING *`,
              [...params, ...w.params],
            );
            return (rows[0] ?? null) as any;
          },
        };
      },
    });

  const creator = build(executor, false);
  return (options: BetterAuthOptions) => {
    lazyOptions = options;
    return creator(options);
  };
};
