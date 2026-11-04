// A user-land index kind: `.vectorIndex()` + `ctx.db.query(t).withVectorIndex()`. Brute-force cosine over a
// side table kept in sync by triggers -- a stand-in for Vectorize. Shows the whole plugin surface: typed builder
// method, DDL (migrated like any other object), backfill, query execution, and reactivity overlap.

import { registerIndexKind, type FieldPathsOf, type GenericExt, type GenericIndexes, type TableDefinition, type TableInfo } from "cfx/schema";
import type { FieldTypeFromPath, OrderedQuery } from "cfx/server";
import { compareValues } from "cfx/keys";
import { q } from "cfx/sqlite";
import type { GenericValidator } from "cfx/values";

export type VectorIndexConfig<F extends string> = { vectorField: string; dimensions: number; filterFields: F };

declare module "cfx/schema" {
  interface IndexKindMethods<V extends GenericValidator, Indexes extends GenericIndexes, Ext extends GenericExt> {
    vectorIndex<N extends string, VF extends FieldPathsOf<V>, F extends FieldPathsOf<V> = never>(
      name: N,
      config: { vectorField: VF; dimensions: number; filterFields?: F[] },
    ): TableDefinition<V, Indexes, Ext & { vector: Record<N, VectorIndexConfig<F>> }>;
  }
}

type VectorIndexesOf<TI extends TableInfo> = TI["ext"] extends { vector: infer S } ? S : {};
export type VectorQuery<D, F extends string> = { vector: number[]; limit?: number; filter?: { [P in F]?: FieldTypeFromPath<D, P> } };

declare module "cfx/server" {
  interface IndexKindQueryMethods<TI extends TableInfo> {
    withVectorIndex<N extends keyof VectorIndexesOf<TI> & string>(
      name: N,
      query: VectorQuery<TI["document"], (VectorIndexesOf<TI>[N] & VectorIndexConfig<string>)["filterFields"]>,
    ): OrderedQuery<TI>;
  }
}

type ReadSetData = { filter: [string, unknown][] };

registerIndexKind<{ vectorField: string; dimensions: number; filterFields?: string[] }>({
  kind: "vector",
  method: "vectorIndex",
  queryMethod: "withVectorIndex",
  parse(name, config, documentShape) {
    const f = documentShape.kind === "object" ? documentShape.fields[config.vectorField] : undefined;
    if (f?.shape.kind !== "array" || f.shape.item.kind !== "float64") throw new Error(`vectorIndex ${name}: ${config.vectorField} must be v.array(v.float64())`);
    if (!Number.isInteger(config.dimensions) || config.dimensions < 2 || config.dimensions > 4096) throw new Error(`vectorIndex ${name}: bad dimensions`);
    const filterFields = config.filterFields ?? [];
    return { kind: "vector", name, fields: [config.vectorField, ...filterFields], config: { ...config, filterFields } };
  },
  ddl(layout, spec) {
    const { vectorField } = spec.config as { vectorField: string };
    const side = q(`${layout.table}__${spec.name}`);
    const up = (ref: string) => `INSERT OR REPLACE INTO ${side} (rid, vec) SELECT ${ref}.rowid, ${layout.expr(vectorField, ref)} WHERE ${layout.expr(vectorField, ref)} IS NOT NULL;`;
    return [
      { type: "table", name: `${layout.table}__${spec.name}`, sql: `CREATE TABLE ${side} (rid INTEGER PRIMARY KEY, vec TEXT NOT NULL)` },
      { type: "trigger", name: `${layout.table}__${spec.name}__ai`, sql: `CREATE TRIGGER ${q(`${layout.table}__${spec.name}__ai`)} AFTER INSERT ON ${q(layout.table)} BEGIN ${up("new")} END` },
      { type: "trigger", name: `${layout.table}__${spec.name}__au`, sql: `CREATE TRIGGER ${q(`${layout.table}__${spec.name}__au`)} AFTER UPDATE ON ${q(layout.table)} BEGIN DELETE FROM ${side} WHERE rid = old.rowid; ${up("new")} END` },
      { type: "trigger", name: `${layout.table}__${spec.name}__ad`, sql: `CREATE TRIGGER ${q(`${layout.table}__${spec.name}__ad`)} AFTER DELETE ON ${q(layout.table)} BEGIN DELETE FROM ${side} WHERE rid = old.rowid; END` },
    ];
  },
  backfill(layout, spec) {
    const { vectorField } = spec.config as { vectorField: string };
    return [`INSERT INTO ${q(`${layout.table}__${spec.name}`)} (rid, vec) SELECT rowid, ${layout.expr(vectorField)} FROM ${q(layout.table)} WHERE ${layout.expr(vectorField)} IS NOT NULL`];
  },
  execute(env, spec, arg) {
    const query = arg as { vector: number[]; limit?: number; filter?: Record<string, unknown> };
    const filter = Object.entries(query.filter ?? {}).map(([k, x]) => [k, typeof x === "boolean" ? (x ? 1 : 0) : (x ?? null)] as [string, unknown]);
    const params = filter.map(([, x]) => x);
    const where = filter.map(([k]) => `AND ${env.layout.expr(k, "t")} IS ?`).join(" ");
    const rows = env.sql.all<Record<string, unknown> & { __vec: string }>(
      `SELECT t.*, s.vec AS __vec FROM ${q(`${env.layout.table}__${spec.name}`)} s JOIN ${q(env.layout.table)} t ON t.rowid = s.rid WHERE 1 ${where}`,
      ...params,
    );
    const scored = rows
      .map((r) => ({ doc: env.decode(r), score: cosine(query.vector, JSON.parse(r.__vec)) }))
      .sort((a, b) => b.score - a.score || compareValues(a.doc._id, b.doc._id))
      .slice(0, query.limit ?? 10);
    return { docs: scored.map((s) => s.doc), readSetData: { filter } satisfies ReadSetData };
  },
  overlaps(entry, change, keyPart) {
    // Any matching row can enter the top-k, so: every write to the table that passes the filter.
    const { filter } = entry.data as ReadSetData;
    const hit = (d: Record<string, unknown> | undefined) => d !== undefined && filter.every(([k, x]) => compareValues(keyPart(d, k), x) === 0);
    return hit(change.before) || hit(change.after);
  },
});

function cosine(a: number[], b: number[]) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * (b[i] ?? 0);
    na += a[i]! ** 2;
    nb += (b[i] ?? 0) ** 2;
  }
  return dot / (Math.sqrt(na * nb) || 1);
}
