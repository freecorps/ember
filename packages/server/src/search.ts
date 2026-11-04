// `.searchIndex()`: full-text search on FTS5, written as an ordinary index-kind plugin.
//
// - FTS5 external content over the table (`content=<table>, content_rowid=_rowid`), so the text is stored once.
// - AFTER INSERT / DELETE / UPDATE OF <field> triggers keep it in sync, guarded so rows in a staged backfill
//   window are left to the backfill.
// - Tokenizer `unicode61 remove_diacritics 2` (default) or `trigram` (substring search).
// - Query: the query is tokenised like FTS5 does, every term quoted (no FTS5 syntax from users), OR semantics,
//   last term as a prefix (type-ahead); ordered by bm25 (`rank`). `.eq()` on filter fields.
// - Reactivity: a change matches when its row was in the results, or its before/after text contains a query
//   term (prefix) and it passes the filters. Rank can still drift (bm25 depends on the whole corpus); the
//   runtime debounces a re-run of search subscriptions (PLAN §4).

import { columnSpecFor, compareValues, shapeAtPath, toSqlValue, ESCAPE, type JSONValue, type ObjectShape } from "@ember/values";
import { defineIndexKind, indexedGuard, lit, q } from "./indexKinds.ts";
import type { SqlValue } from "./driver.ts";
import type { Doc, IndexSpec, TableLayout } from "./types.ts";
import type { FieldPathsOf, GenericExt, GenericIndexes, TableDefinition, TableInfo } from "./schema.ts";
import type { FieldTypeFromPath, OrderedQuery } from "./query.ts";
import type { GenericValidator } from "@ember/values";

// ------------------------------------------------------------------------------------------------ typing

export type SearchIndexTypeInfo<S extends string, F extends string> = { searchField: S; filterFields: F };

declare module "./schema.ts" {
  interface IndexKindMethods<V extends GenericValidator, Indexes extends GenericIndexes, Ext extends GenericExt> {
    searchIndex<N extends string, S extends FieldPathsOf<V>, F extends FieldPathsOf<V> = never>(
      name: N,
      config: { searchField: S; filterFields?: F[]; tokenizer?: SearchTokenizer },
    ): TableDefinition<V, Indexes, Ext & { search: Record<N, SearchIndexTypeInfo<S, F>> }>;
  }
}

export interface SearchFilter {
  readonly __searchFilter?: true;
}
export interface SearchFilterFinal<D, F extends string> extends SearchFilter {
  eq<P extends F>(field: P, value: FieldTypeFromPath<D, P>): SearchFilterFinal<D, F>;
}
export interface SearchFilterBuilder<D, C extends SearchIndexTypeInfo<string, string>> {
  search(field: C["searchField"], query: string): SearchFilterFinal<D, C["filterFields"]>;
}
type SearchIndexesOf<TI extends TableInfo> = TI["ext"] extends { search: infer S } ? S : {};

declare module "./query.ts" {
  interface IndexKindQueryMethods<TI extends TableInfo> {
    withSearchIndex<N extends keyof SearchIndexesOf<TI> & string>(
      name: N,
      filter: (q: SearchFilterBuilder<TI["document"], SearchIndexesOf<TI>[N] & SearchIndexTypeInfo<string, string>>) => SearchFilter,
    ): OrderedQuery<TI>;
  }
}

export type SearchTokenizer = "unicode61" | "trigram";
export type SearchIndexConfig = { searchField: string; filterFields?: string[]; tokenizer?: SearchTokenizer };
type StoredConfig = { searchField: string; filterFields: string[]; tokenizer: SearchTokenizer };

export const SEARCH_MAX_RESULTS = 1024;
const MAX_TERMS = 16;

/** Mirrors FTS5's unicode61 tokenizer with remove_diacritics 2 (lowercase, strip marks, split on non-alnum). */
export function tokenize(text: unknown): string[] {
  if (typeof text !== "string") return [];
  return normalize(text)
    .split(/[^\p{L}\p{N}\p{Co}]+/u)
    .filter(Boolean);
}
const normalize = (s: string) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();

type SearchData = {
  searchField: string;
  tokenizer: SearchTokenizer;
  terms: string[];
  filters: { field: string; value: unknown }[];
  resultIds: string[];
};

type Builder = { search(field: string, text: string): Builder; eq(field: string, value: unknown): Builder };

const config = (spec: IndexSpec) => spec.config as unknown as StoredConfig;
const ftsName = (layout: TableLayout, spec: IndexSpec) => `${layout.table}__${spec.name}`;

export const searchIndexKind = defineIndexKind<SearchIndexConfig, (q: Builder) => unknown>({
  kind: "search",
  method: "searchIndex",
  queryMethod: "withSearchIndex",

  parse(name, cfg, document: ObjectShape) {
    const f = document.fields[cfg.searchField];
    const col = f && columnSpecFor(f);
    if (!f || !col || col.cls !== "text" || cfg.searchField.includes(".")) {
      throw new Error(`searchIndex ${name}: searchField ${cfg.searchField} must be a top-level string field`);
    }
    const filterFields = cfg.filterFields ?? [];
    if (filterFields.length > 16) throw new Error(`searchIndex ${name}: at most 16 filter fields`);
    for (const ff of filterFields) if (!shapeAtPath(document, ff)) throw new Error(`searchIndex ${name}: unknown filter field ${ff}`);
    const tokenizer = cfg.tokenizer ?? "unicode61";
    if (tokenizer !== "unicode61" && tokenizer !== "trigram") throw new Error(`searchIndex ${name}: unknown tokenizer ${tokenizer}`);
    const stored: StoredConfig = { searchField: cfg.searchField, filterFields, tokenizer };
    return { kind: "search", name, fields: [cfg.searchField, ...filterFields], config: stored as unknown as JSONValue };
  },

  ddl(layout, spec) {
    const { searchField, tokenizer } = config(spec);
    const fts = ftsName(layout, spec);
    const t = q(layout.table);
    const col = q(searchField);
    const tok = tokenizer === "trigram" ? "trigram" : "unicode61 remove_diacritics 2";
    const ins = `INSERT INTO ${q(fts)} (rowid, ${col}) VALUES (new."_rowid", new.${col});`;
    const del = `INSERT INTO ${q(fts)} (${q(fts)}, rowid, ${col}) VALUES ('delete', old."_rowid", old.${col});`;
    return [
      {
        type: "table",
        name: fts,
        sql: `CREATE VIRTUAL TABLE ${q(fts)} USING fts5(${col}, content=${lit(layout.table)}, content_rowid='_rowid', tokenize=${lit(tok)})`,
      },
      {
        type: "trigger",
        name: `${fts}__ai`,
        sql: `CREATE TRIGGER ${q(fts + "__ai")} AFTER INSERT ON ${t} WHEN ${indexedGuard(layout.table, spec.name, "new")} BEGIN ${ins} END`,
      },
      {
        type: "trigger",
        name: `${fts}__ad`,
        sql: `CREATE TRIGGER ${q(fts + "__ad")} AFTER DELETE ON ${t} WHEN ${indexedGuard(layout.table, spec.name, "old")} BEGIN ${del} END`,
      },
      {
        type: "trigger",
        name: `${fts}__au`,
        sql: `CREATE TRIGGER ${q(fts + "__au")} AFTER UPDATE OF ${col} ON ${t} WHEN ${indexedGuard(layout.table, spec.name, "old")} BEGIN ${del} ${ins} END`,
      },
    ];
  },

  backfill(layout, spec) {
    const col = q(config(spec).searchField);
    return `INSERT INTO ${q(ftsName(layout, spec))} (rowid, ${col}) SELECT "_rowid", ${col} FROM ${q(layout.table)} WHERE "_rowid" > ?1 AND "_rowid" <= ?2`;
  },

  query(env, build) {
    const { searchField, filterFields, tokenizer } = config(env.spec);
    let text: string | undefined;
    const filters: { field: string; value: unknown }[] = [];
    const b: Builder = {
      search(field, t) {
        if (field !== searchField) throw new Error(`search() must use ${searchField}`);
        if (typeof t !== "string") throw new Error("search() needs a string");
        text = t;
        return b;
      },
      eq(field, value) {
        if (!filterFields.includes(field)) throw new Error(`${field} is not a filter field of ${env.spec.name}`);
        filters.push({ field, value });
        return b;
      },
    };
    build(b);
    if (text === undefined) throw new Error(`withSearchIndex(${env.spec.name}): call q.search(...)`);
    const terms =
      tokenizer === "trigram"
        ? text.trim().length >= 3
          ? [text.trim()]
          : []
        : [...new Set(tokenize(text))].slice(0, MAX_TERMS);
    const data: SearchData = { searchField, tokenizer, terms, filters, resultIds: [] };
    if (!terms.length) return { docs: [], data };
    const match =
      tokenizer === "trigram"
        ? `"${terms[0]!.replace(/"/g, '""')}"`
        : terms.map((t, i) => `"${t}"${i === terms.length - 1 ? "*" : ""}`).join(" OR ");
    const params: SqlValue[] = [match];
    const where: string[] = [];
    for (const f of filters) {
      const expr = env.layout.expr(f.field, "t");
      const c = env.layout.column(f.field);
      let sv: SqlValue | typeof ESCAPE;
      if (c) sv = toSqlValue(c.spec.cls, f.value);
      else sv = typeof f.value === "boolean" ? (f.value ? 1 : 0) : typeof f.value === "bigint" ? null : (f.value as SqlValue) ?? null;
      if (sv === ESCAPE || (sv === null && f.value !== null && f.value !== undefined)) continue; // checked in JS below
      if (sv === null) where.push(`${expr} IS NULL`);
      else {
        where.push(`${expr} = ?`);
        params.push(sv);
      }
    }
    const fts = q(ftsName(env.layout, env.spec));
    const rows = env.exec(
      `SELECT t.* FROM ${fts} f JOIN ${q(env.layout.table)} t ON t."_rowid" = f.rowid WHERE f.${fts} MATCH ?${where.map((w) => ` AND ${w}`).join("")} ORDER BY f.rank, t."_rowid" LIMIT ${SEARCH_MAX_RESULTS}`,
      ...params,
    );
    const field = (d: Doc, path: string) => fieldPath(d, path);
    const docs = rows.map(env.decode).filter((d) => filters.every((f) => compareValues(field(d, f.field), f.value) === 0));
    data.resultIds = docs.map((d) => d._id);
    return { docs, data };
  },

  // bm25 depends on the whole corpus: any other write to the table may reorder results (debounced re-run).
  debounceTableWrites: true,

  matchesChange(entry, change, helpers) {
    const data = entry.data as SearchData;
    if (data.resultIds.includes(change.id)) return true;
    if (!data.terms.length) return false;
    const hit = (doc: Doc | null) => {
      if (!doc) return false;
      if (!data.filters.every((f) => compareValues(helpers.field(doc, f.field), f.value) === 0)) return false;
      const text = helpers.field(doc, data.searchField);
      if (typeof text !== "string") return false;
      if (data.tokenizer === "trigram") {
        const needle = data.terms[0]!.toLowerCase();
        return text.toLowerCase().includes(needle) || normalize(text).includes(normalize(needle));
      }
      // Conservative: any token starting with any term (a superset of FTS5's "term, or prefix for the last").
      return tokenize(text).some((tok) => data.terms.some((t) => tok.startsWith(t)));
    };
    return hit(change.before) || hit(change.after);
  },
});

function fieldPath(doc: Record<string, unknown>, path: string): unknown {
  let cur: unknown = doc;
  for (const p of path.split(".")) {
    if (typeof cur !== "object" || cur === null || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}
