// defineSchema / defineTable with an extensible index-kind registry.
//
// `.index()` (b-tree over typed columns) is the only kind the core knows. Every other kind -- `.searchIndex()`
// (FTS5, built in, see search.ts), `.vectorIndex()` (plugins/vector.ts), or anything a user writes -- is an
// IndexKindPlugin registered at runtime with `registerIndexKind`, which installs a builder method on
// TableDefinition.prototype. Its static type comes from module augmentation of `IndexKindMethods`:
//
//   declare module "cfx/schema" {
//     interface IndexKindMethods<V, Indexes, Ext> {
//       vectorIndex<N extends string, F extends FieldPathsOf<V>>(name: N, cfg: {...}):
//         TableDefinition<V, Indexes, Ext & { vector: Record<N, {...}> }>;
//     }
//   }
//
// A plugin owns: config parsing (at schema-definition time), the SQL objects it needs (DDL, diffed by the
// migration planner like any other object), a backfill statement for existing rows, how it is queried, and how
// a write overlaps a read set recorded through it (reactivity).

import type { Doc, ReadSetEntry, RowChange } from "./types";
import { v, type GenericValidator, type Infer, type PropertyValidators, type ObjectValidator, type Expand, type GenericId, type Shape } from "./values";

export type GenericIndexes = Record<string, string[]>;
export type GenericExt = Record<string, Record<string, any>>;

export type IndexSpec = { kind: string; name: string; fields: string[]; config?: unknown };

/** A schema object (index, virtual table, trigger) owned by a table; diffed by exact SQL text. */
export type OwnedObject = { type: "index" | "table" | "trigger"; name: string; sql: string };

/** How a table is laid out in SQLite; given to plugins so they can address fields. */
export interface TableLayout {
  table: string;
  /** SQL expression reading a (possibly dotted) field path from a row of `table` (alias-free). */
  expr(fieldPath: string, rowRef?: string): string;
}

export interface IndexKindPlugin<Config = any> {
  /** Stored in IndexSpec.kind and ReadSetEntry.indexKind, e.g. "search". */
  kind: string;
  /** The TableDefinition builder method name, e.g. "searchIndex". */
  method: string;
  /** Validates the config at schema-definition time; returns the stored spec (JSON-serialisable). */
  parse(name: string, config: Config, documentShape: Shape): IndexSpec;
  /** SQL objects backing the index. Names must start with `${table}__`. */
  ddl(layout: TableLayout, spec: IndexSpec): OwnedObject[];
  /** Statements filling a newly created index from existing rows (b-tree indexes do not need it). */
  backfill?(layout: TableLayout, spec: IndexSpec): string[];
  /** Reactivity: whether `change` may alter a result read through this index. Default: any change to the table. */
  /** Query support: the QueryInitializer method name (e.g. "withSearchIndex") and how to run it. */
  queryMethod?: string;
  execute?(env: PluginQueryEnv, spec: IndexSpec, builder: unknown): { docs: Doc[]; readSetData: unknown };
  overlaps?(entry: Extract<ReadSetEntry, { kind: "plugin" }>, change: RowChange, keyPart: (doc: Record<string, unknown>, path: string) => unknown): boolean;
}

export interface PluginQueryEnv {
  sql: import("./sqlite").Sql;
  layout: TableLayout;
  /** Raw SQL row of the table -> document. */
  decode(row: Record<string, unknown>): Doc;
}

export function registeredIndexKinds(): IndexKindPlugin[] {
  return [...kinds.values()];
}

/** Augment this (keeping the exact type parameters and constraints) to type a plugin's builder method. */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface IndexKindMethods<V extends GenericValidator, Indexes extends GenericIndexes, Ext extends GenericExt> {}

/** All dotted field paths of a table's document validator. */
export type FieldPathsOf<V extends GenericValidator> = NonNullable<V["fieldPaths"]> | "_creationTime";

const SYSTEM_INDEXES = new Set(["by_id", "by_creation_time"]);
const NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export interface TableDefinition<V extends GenericValidator, Indexes extends GenericIndexes, Ext extends GenericExt>
  extends IndexKindMethods<V, Indexes, Ext> {}

export class TableDefinition<
  V extends GenericValidator = GenericValidator,
  Indexes extends GenericIndexes = {},
  Ext extends GenericExt = {},
> {
  readonly indexes: IndexSpec[] = [];
  constructor(readonly validator: V) {}

  index<N extends string, const F extends [FieldPathsOf<V>, ...FieldPathsOf<V>[]]>(
    name: N,
    fields: F,
  ): TableDefinition<V, Expand<Indexes & Record<N, [...F, "_creationTime"]>>, Ext> {
    this.addIndex({ kind: "db", name, fields: [...fields] });
    return this as any;
  }

  /** @internal used by plugin methods too */
  addIndex(spec: IndexSpec) {
    if (!NAME.test(spec.name)) throw new Error(`Invalid index name ${spec.name}`);
    if (SYSTEM_INDEXES.has(spec.name)) throw new Error(`Index name ${spec.name} is reserved`);
    if (this.indexes.some((i) => i.name === spec.name)) throw new Error(`Duplicate index ${spec.name}`);
    for (const f of spec.fields) {
      if (f !== "_creationTime" && !fieldExists(this.validator.shape, f)) {
        throw new Error(`Index ${spec.name}: unknown field ${f}`);
      }
    }
    this.indexes.push(spec);
  }

  export() {
    return { documentShape: this.validator.shape, indexes: this.indexes };
  }
}

function fieldExists(shape: Shape, path: string): boolean {
  let cur: Shape | undefined = shape;
  for (const part of path.split(".")) {
    if (!cur || cur.kind !== "object") return false;
    cur = cur.fields[part]?.shape;
  }
  return cur !== undefined;
}

export function defineTable<F extends PropertyValidators>(
  fields: F,
): TableDefinition<ObjectValidator<F>> {
  return new TableDefinition(v.object(fields)) as any;
}

// ------------------------------------------------------------------------------------------- plugin registry

const kinds = new Map<string, IndexKindPlugin>();

export function registerIndexKind<C>(plugin: IndexKindPlugin<C>): void {
  if (plugin.kind === "db" || kinds.has(plugin.kind)) {
    if (kinds.get(plugin.kind) === plugin) return;
    throw new Error(`Index kind ${plugin.kind} already registered`);
  }
  if (plugin.method in TableDefinition.prototype) throw new Error(`Method ${plugin.method} already exists`);
  kinds.set(plugin.kind, plugin as IndexKindPlugin);
  Object.defineProperty(TableDefinition.prototype, plugin.method, {
    value: function (this: TableDefinition, name: string, config: C) {
      this.addIndex(plugin.parse(name, config, this.validator.shape));
      return this;
    },
  });
}

export function indexKind(kind: string): IndexKindPlugin {
  const plugin = kinds.get(kind);
  if (!plugin) throw new Error(`Unknown index kind ${kind} (plugin not registered?)`);
  return plugin;
}

// ------------------------------------------------------------------------------------------------- schema

export type GenericSchema = Record<string, TableDefinition<any, any, any>>;

export class SchemaDefinition<S extends GenericSchema> {
  constructor(
    readonly tables: S,
    readonly schemaValidation: boolean,
  ) {
    for (const name of Object.keys(tables)) {
      if (!NAME.test(name) || name.startsWith("_")) throw new Error(`Invalid table name ${name}`);
    }
  }
  /** The JSON form pushed on deploy and stored next to the data. */
  export(): SchemaJson {
    return {
      schemaValidation: this.schemaValidation,
      tables: Object.fromEntries(Object.entries(this.tables).map(([n, t]) => [n, t.export()])),
    };
  }
}

export type SchemaJson = {
  schemaValidation: boolean;
  tables: Record<string, { documentShape: Shape; indexes: IndexSpec[] }>;
};

export function defineSchema<S extends GenericSchema>(tables: S, options?: { schemaValidation?: boolean }) {
  return new SchemaDefinition(tables, options?.schemaValidation ?? true);
}

// ---------------------------------------------------------------------------------------------- data model

export type SystemIndexes = { by_id: ["_id"]; by_creation_time: ["_creationTime"] };

export type TableInfo = {
  document: any;
  fieldPaths: string;
  indexes: GenericIndexes;
  ext: GenericExt;
};
export type GenericDataModel = Record<string, TableInfo>;

export type DocFor<TableName extends string, V extends GenericValidator> = Expand<
  { _id: GenericId<TableName>; _creationTime: number } & Infer<V>
>;

export type DataModelFromSchema<SD> =
  SD extends SchemaDefinition<infer S>
    ? {
        [T in keyof S & string]: S[T] extends TableDefinition<infer V, infer I, infer E>
          ? {
              document: DocFor<T, V>;
              fieldPaths: FieldPathsOf<V> | "_id";
              indexes: Expand<I & SystemIndexes>;
              ext: E;
            }
          : never;
      }
    : never;
