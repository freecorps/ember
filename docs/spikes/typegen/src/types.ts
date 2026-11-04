// Runtime types shared by the engine, the DDL compiler, index-kind plugins and reactivity.

export type Doc = Record<string, unknown> & { _id: string; _creationTime: number };

/** One row a committed transaction touched (undefined = absent before / after). */
export type RowChange = { table: string; id: string; before: Doc | undefined; after: Doc | undefined };

/** A key bound over an index's (fields..., _creationTime, _id) tuple; `key` may be a prefix. */
export type Bound = { key: unknown[]; inclusive: boolean };

/** What a query execution read, recorded so commits can decide whether it may have changed. */
export type ReadSetEntry =
  | {
      kind: "range";
      table: string;
      index: string;
      /** Full index key fields incl. tiebreakers, e.g. ["channel", "_creationTime", "_id"]. */
      fields: string[];
      lower: Bound | null;
      upper: Bound | null;
      /** `.filter()` predicates applied to the range; a row failing them before and after cannot matter. */
      filter?: FilterExpr[];
    }
  | {
      /** Read through a non-db index kind (search, vector, user plugins); the plugin decides overlap. */
      kind: "plugin";
      table: string;
      index: string;
      indexKind: string;
      data: unknown;
    }
  | {
      /** Conservative fallback: any write to the table invalidates. */
      kind: "table";
      table: string;
    };

/** `.filter()` expression tree (data, so it can live in a read set and be evaluated against changed rows). */
export type FilterExpr =
  | { field: string }
  | { literal: unknown }
  | { op: "eq" | "neq" | "lt" | "lte" | "gt" | "gte" | "and" | "or" | "not"; args: FilterExpr[] };
