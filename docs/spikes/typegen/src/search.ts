// `.searchIndex()` -- full-text search on FTS5, written as an ordinary index-kind plugin (the same API a user
// plugin uses: see plugins/vector.ts). Importing this module registers it.

import { compareValues } from "./keys";
import { registerIndexKind, type FieldPathsOf, type GenericExt, type GenericIndexes, type TableDefinition, type TableInfo as _TI } from "./schema";
import type { FieldTypeFromPath, OrderedQuery } from "./server";
import { lit, q } from "./sqlite";
import type { GenericValidator, Shape } from "./values";

// ---------------------------------------------------------------------------------------------- typing

export type SearchIndexConfig<S extends string, F extends string> = { searchField: S; filterFields: F };

declare module "./schema" {
  interface IndexKindMethods<V extends GenericValidator, Indexes extends GenericIndexes, Ext extends GenericExt> {
    searchIndex<N extends string, S extends FieldPathsOf<V>, F extends FieldPathsOf<V> = never>(
      name: N,
      config: { searchField: S; filterFields?: F[] },
    ): TableDefinition<V, Indexes, Ext & { search: Record<N, SearchIndexConfig<S, F>> }>;
  }
}

export interface SearchFilter {
  readonly __searchFilter?: true;
}
export interface SearchFilterFinal<D, F extends string> extends SearchFilter {
  eq<P extends F>(field: P, value: FieldTypeFromPath<D, P>): SearchFilterFinal<D, F>;
}
export interface SearchFilterBuilder<D, C extends SearchIndexConfig<string, string>> {
  search(field: C["searchField"], query: string): SearchFilterFinal<D, C["filterFields"]>;
}

type SearchIndexesOf<TI extends _TI> = TI["ext"] extends { search: infer S } ? S : {};

declare module "./server" {
  interface IndexKindQueryMethods<TI extends import("./schema").TableInfo> {
    withSearchIndex<N extends keyof SearchIndexesOf<TI> & string>(
      name: N,
      filter: (q: SearchFilterBuilder<TI["document"], SearchIndexesOf<TI>[N] & SearchIndexConfig<string, string>>) => SearchFilter,
    ): OrderedQuery<TI>;
  }
}

// ---------------------------------------------------------------------------------------------- runtime

/** Mirrors FTS5's unicode61 tokenizer with remove_diacritics 2, so invalidation sees the tokens FTS5 sees. */
export function tokenize(text: unknown): string[] {
  if (typeof text !== "string") return [];
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}\p{Co}]+/u)
    .filter(Boolean);
}

type SearchReadSet = { searchField: string; terms: string[]; eqs: { field: string; value: unknown }[]; resultIds: string[] };

function fieldShape(shape: Shape, path: string): Shape | undefined {
  let cur: Shape | undefined = shape;
  for (const p of path.split(".")) cur = cur?.kind === "object" ? cur.fields[p]?.shape : undefined;
  return cur;
}

const MAX_RESULTS = 1024;

registerIndexKind<{ searchField: string; filterFields?: string[] }>({
  kind: "search",
  method: "searchIndex",
  queryMethod: "withSearchIndex",
  parse(name, config, documentShape) {
    const s = fieldShape(documentShape, config.searchField);
    if (s?.kind !== "string") throw new Error(`searchIndex ${name}: searchField ${config.searchField} must be v.string()`);
    const filterFields = config.filterFields ?? [];
    if (filterFields.length > 16) throw new Error(`searchIndex ${name}: at most 16 filter fields`);
    return { kind: "search", name, fields: [config.searchField, ...filterFields], config: { searchField: config.searchField, filterFields } };
  },
  ddl(layout, spec) {
    const { searchField } = spec.config as { searchField: string };
    const fts = `${layout.table}__${spec.name}`;
    const t = q(layout.table);
    const ins = (ref: string) => `INSERT INTO ${q(fts)} (rowid, "text") VALUES (${ref}.rowid, ${layout.expr(searchField, ref)});`;
    const del = (ref: string) => `DELETE FROM ${q(fts)} WHERE rowid = ${ref}.rowid;`;
    return [
      { type: "table", name: fts, sql: `CREATE VIRTUAL TABLE ${q(fts)} USING fts5("text", tokenize = ${lit("unicode61 remove_diacritics 2")})` },
      { type: "trigger", name: `${fts}__ai`, sql: `CREATE TRIGGER ${q(fts + "__ai")} AFTER INSERT ON ${t} BEGIN ${ins("new")} END` },
      { type: "trigger", name: `${fts}__ad`, sql: `CREATE TRIGGER ${q(fts + "__ad")} AFTER DELETE ON ${t} BEGIN ${del("old")} END` },
      { type: "trigger", name: `${fts}__au`, sql: `CREATE TRIGGER ${q(fts + "__au")} AFTER UPDATE ON ${t} BEGIN ${del("old")} ${ins("new")} END` },
    ];
  },
  backfill(layout, spec) {
    const { searchField } = spec.config as { searchField: string };
    return [`INSERT INTO ${q(`${layout.table}__${spec.name}`)} (rowid, "text") SELECT rowid, ${layout.expr(searchField)} FROM ${q(layout.table)}`];
  },
  execute(env, spec, build) {
    const { searchField, filterFields } = spec.config as { searchField: string; filterFields: string[] };
    let query = "";
    const eqs: { field: string; value: unknown }[] = [];
    const b: any = {
      search(field: string, text: string) {
        if (field !== searchField) throw new Error(`search() must use ${searchField}`);
        query = text;
        return b;
      },
      eq(field: string, value: unknown) {
        if (!filterFields.includes(field)) throw new Error(`${field} is not a filter field of ${spec.name}`);
        eqs.push({ field, value: typeof value === "boolean" ? (value ? 1 : 0) : (value ?? null) });
        return b;
      },
    };
    (build as (q: unknown) => unknown)(b);
    const terms = [...new Set(tokenize(query))].slice(0, 16);
    if (!terms.length) return { docs: [], readSetData: { searchField, terms, eqs, resultIds: [] } satisfies SearchReadSet };
    // Every term quoted (no FTS5 query syntax from users); OR semantics, last term as a prefix (type-ahead).
    const match = terms.map((t, i) => `"${t}"${i === terms.length - 1 ? "*" : ""}`).join(" OR ");
    const params: unknown[] = [match];
    const where = eqs.map((e) => {
      params.push(e.value);
      return `${env.layout.expr(e.field, "t")} IS ?`;
    });
    const fts = q(`${env.layout.table}__${spec.name}`);
    const rows = env.sql.all(
      `SELECT t.* FROM ${fts} f JOIN ${q(env.layout.table)} t ON t.rowid = f.rowid WHERE f."text" MATCH ? ${where.map((w) => `AND ${w}`).join(" ")} ORDER BY f.rank, t."_id" LIMIT ${MAX_RESULTS}`,
      ...params,
    );
    const docs = rows.map(env.decode);
    return { docs, readSetData: { searchField, terms, eqs, resultIds: docs.map((d) => d._id) } satisfies SearchReadSet };
  },
  overlaps(entry, change, keyPart) {
    const data = entry.data as SearchReadSet;
    if (data.resultIds.includes(change.id)) return true;
    const last = data.terms[data.terms.length - 1];
    const hit = (doc: Record<string, unknown> | undefined) =>
      doc !== undefined &&
      data.eqs.every((e) => compareValues(keyPart(doc, e.field), e.value) === 0) &&
      tokenize(keyPart(doc, data.searchField)).some((tok) => data.terms.includes(tok) || (last !== undefined && tok.startsWith(last)));
    // NB: bm25 ranks depend on corpus statistics, so an unrelated write can reorder results; we accept that
    // staleness (Convex's search is similarly approximate). Membership is exact.
    return hit(change.before) || hit(change.after);
  },
});
