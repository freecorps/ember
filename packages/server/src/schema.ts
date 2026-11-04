// defineSchema / defineTable / defineShard and the schema manifest.
//
// Plugin index methods (`.searchIndex()`, `.vectorIndex()`, ...) are not installed on a prototype: any method
// named `*Index` on a TableDefinition records a pending `{ method, name, config }`, and `defineSchema` resolves
// it against *that schema's* index kinds (`defineSchema({ ..., indexKinds })`, search built in). So import
// order does not matter and two schemas can use different plugins. Static types come from augmenting
// `IndexKindMethods`.

import {
  shapeAtPath,
  toJSONValue,
  v,
  type Expand,
  type GenericId,
  type GenericValidator,
  type Infer,
  type JSONValue,
  type ObjectShape,
  type ObjectValidator,
  type PropertyValidators,
  type Shape,
} from "@ember/values";
import { aggregateKind } from "./aggregate.ts";
import type { IndexKind } from "./indexKinds.ts";
import { layoutOf } from "./layout.ts";
import { searchIndexKind } from "./search.ts";
import { sha256Hex } from "./sha256.ts";
import type { IndexSpec } from "./types.ts";

export type GenericIndexes = Record<string, string[]>;
export type GenericExt = Record<string, Record<string, any>>;

/** All dotted field paths of a table's document validator, plus `_creationTime`. */
export type FieldPathsOf<V extends GenericValidator> = NonNullable<V["fieldPaths"]> | "_creationTime";

/** Augment (keeping the exact type parameters) to type a plugin's builder method. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface IndexKindMethods<V extends GenericValidator, Indexes extends GenericIndexes, Ext extends GenericExt> {}

const NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const SYSTEM_INDEXES = new Set(["by_id", "by_creation_time"]);
const PLUGIN_METHOD = /^[a-z][A-Za-z0-9]*Index$/;

type PendingIndex = { method: string; name: string; config: unknown };

export interface TableDefinition<
  V extends GenericValidator = GenericValidator,
  Indexes extends GenericIndexes = {},
  Ext extends GenericExt = {},
> extends IndexKindMethods<V, Indexes, Ext> {}

export class TableDefinition<
  V extends GenericValidator = GenericValidator,
  Indexes extends GenericIndexes = {},
  Ext extends GenericExt = {},
> {
  /** @internal */ readonly dbIndexes: IndexSpec[] = [];
  /** @internal */ readonly pending: PendingIndex[] = [];
  /** @internal */ shardRef: { name: string; field: string } | undefined;

  constructor(
    readonly validator: V,
    readonly options: { idPrefix?: string } = {},
  ) {
    // Unknown `*Index` methods are plugin index kinds, resolved by defineSchema.
    return new Proxy(this, {
      get(target, prop, receiver) {
        if (typeof prop === "string" && !(prop in target) && PLUGIN_METHOD.test(prop)) {
          return (name: string, config: unknown) => {
            target.pending.push({ method: prop, name, config });
            return receiver;
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  }

  /** A b-tree index over `fields` (then `_creationTime`, `_id`), stored as an order-preserving BLOB key. */
  index<N extends string, const F extends [FieldPathsOf<V>, ...FieldPathsOf<V>[]]>(
    name: N,
    fields: F,
  ): TableDefinition<V, Expand<Indexes & Record<N, [...F, "_creationTime"]>>, Ext> {
    if (!Array.isArray(fields) || fields.length === 0) throw new Error(`Index ${name}: needs at least one field`);
    if (fields.length > 16) throw new Error(`Index ${name}: at most 16 fields`);
    this.dbIndexes.push({ kind: "db", name, fields: [...fields] });
    return this as any;
  }

  /**
   * A materialized aggregate (PLAN §19), maintained in the write transaction: `count` per group of `by`, plus
   * optional `sum`/`min`/`max` of fields. Read with `ctx.db.aggregate(table, name).get([...group])` (one key
   * lookup) or `.range(q => ...)`; reactive per group. `by: []` keeps one total for the table.
   */
  aggregate<
    N extends string,
    const B extends FieldPathsOf<V>[],
    const S extends FieldPathsOf<V>[] = [],
    const Mn extends FieldPathsOf<V>[] = [],
    const Mx extends FieldPathsOf<V>[] = [],
  >(
    name: N,
    config: { by: B; count?: true; sum?: S; min?: Mn; max?: Mx },
  ): TableDefinition<V, Indexes, Ext & { aggregates: Record<N, AggregateTypeInfo<B, S[number], Mn[number], Mx[number]>> }> {
    this.pending.push({ method: aggregateKind.method, name, config });
    return this as any;
  }

  /** Places the table in shards of type `shard`, keyed by `field`. */
  shard(shard: string, field: FieldPathsOf<V> & string): this {
    this.shardRef = { name: shard, field };
    return this;
  }
}

/** Type-level description of an aggregate (`TableInfo["ext"]["aggregates"][name]`). */
export type AggregateTypeInfo<B extends string[], S extends string, Mn extends string, Mx extends string> = { by: B; sum: S; min: Mn; max: Mx };

export function defineTable<F extends PropertyValidators>(
  fields: F | ObjectValidator<F>,
  options?: { idPrefix?: string },
): TableDefinition<ObjectValidator<F>> {
  const validator = (isValidatorLike(fields) ? fields : v.object(fields as F)) as ObjectValidator<F>;
  if (validator.shape.kind !== "object") throw new Error("defineTable needs an object of validators or v.object()");
  return new TableDefinition(validator, options ?? {});
}

const isValidatorLike = (x: unknown): x is GenericValidator =>
  typeof x === "object" && x !== null && "shape" in x && "isOptional" in x && typeof (x as any).validate === "function";

export interface ShardDefinition<K extends GenericValidator = GenericValidator> {
  readonly key: K;
  readonly locationHint?: string;
}

export function defineShard<K extends GenericValidator>(def: { key: K; locationHint?: string }): ShardDefinition<K> {
  return Object.freeze({ ...def });
}

// ------------------------------------------------------------------------------------------------ manifest

export type TableManifest = {
  idPrefix: string;
  document: ObjectShape;
  shard?: { name: string; field: string };
  indexes: IndexSpec[];
};
export type ShardManifest = { key: Shape; locationHint?: string };
export type SchemaManifest = {
  /** Schema version: the manifest hash (what the runtime and the catalog compare). */
  version: string;
  /** sha256 of the canonical JSON of everything except `version`/`hash`. */
  hash: string;
  formatVersion: 1;
  schemaValidation: boolean;
  tables: Record<string, TableManifest>;
  shards: Record<string, ShardManifest>;
};

export type AnyTableDefinition = TableDefinition<any, any, any>;
export type GenericTables = Record<string, AnyTableDefinition>;
export type GenericShards = Record<string, ShardDefinition>;

export class SchemaDefinition<Tables extends GenericTables = GenericTables, Shards extends GenericShards = GenericShards> {
  readonly manifest: SchemaManifest;
  /** Index kinds available to this schema, by kind. */
  readonly indexKinds: ReadonlyMap<string, IndexKind>;

  constructor(
    readonly tables: Tables,
    readonly shards: Shards,
    options: { indexKinds?: IndexKind[]; schemaValidation?: boolean } = {},
  ) {
    const kinds = new Map<string, IndexKind>();
    const byMethod = new Map<string, IndexKind>();
    for (const k of [searchIndexKind as IndexKind, aggregateKind as IndexKind, ...(options.indexKinds ?? [])]) {
      if (kinds.has(k.kind) && kinds.get(k.kind) !== k) throw new Error(`Index kind ${k.kind} registered twice`);
      if (byMethod.has(k.method) && byMethod.get(k.method) !== k) throw new Error(`Index method ${k.method} registered twice`);
      kinds.set(k.kind, k);
      byMethod.set(k.method, k);
    }
    this.indexKinds = kinds;

    const shardManifests: Record<string, ShardManifest> = {};
    for (const [name, s] of Object.entries(shards)) {
      if (!NAME.test(name) || name === "global") throw new Error(`Invalid shard name ${name}`);
      shardManifests[name] = s.locationHint === undefined ? { key: s.key.shape } : { key: s.key.shape, locationHint: s.locationHint };
    }

    const tableManifests: Record<string, TableManifest> = {};
    const prefixes = new Map<string, string>();
    for (const [name, def] of Object.entries(tables)) {
      if (!(def instanceof TableDefinition)) throw new Error(`Table ${name} is not a defineTable() result`);
      if (!NAME.test(name) || name.startsWith("_") || name.includes("__")) {
        throw new Error(`Invalid table name ${name}: use [A-Za-z][A-Za-z0-9_]*, no leading "_" and no "__"`);
      }
      const document = def.validator.shape as ObjectShape;
      for (const f of Object.keys(document.fields)) {
        if (f.startsWith("_")) throw new Error(`Table ${name}: field ${f} is reserved (fields may not start with "_")`);
      }
      const idPrefix = def.options.idPrefix ?? name;
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(idPrefix)) throw new Error(`Table ${name}: invalid idPrefix ${idPrefix}`);
      if (prefixes.has(idPrefix)) throw new Error(`Tables ${prefixes.get(idPrefix)} and ${name} share the id prefix ${idPrefix}`);
      prefixes.set(idPrefix, name);

      const layout = layoutOf(name, document);
      const indexes: IndexSpec[] = [];
      const add = (spec: IndexSpec) => {
        if (!NAME.test(spec.name) || spec.name.includes("__")) throw new Error(`Table ${name}: invalid index name ${spec.name}`);
        if (SYSTEM_INDEXES.has(spec.name)) throw new Error(`Table ${name}: index name ${spec.name} is reserved`);
        if (indexes.some((i) => i.name === spec.name)) throw new Error(`Table ${name}: duplicate index ${spec.name}`);
        for (const f of spec.fields) {
          if (f !== "_creationTime" && !shapeAtPath(document, f)) throw new Error(`Table ${name}: index ${spec.name} uses unknown field ${f}`);
        }
        indexes.push(spec);
      };
      for (const spec of def.dbIndexes) add(spec);
      for (const p of def.pending) {
        const kind = byMethod.get(p.method);
        if (!kind) {
          throw new Error(`Table ${name}: .${p.method}() needs its index kind plugin: defineSchema({ ..., indexKinds: [...] })`);
        }
        const spec = kind.parse(p.name, p.config, document, layout);
        if (spec.kind !== kind.kind || spec.name !== p.name) throw new Error(`Index kind ${kind.kind}: parse() returned a mismatched spec`);
        add(spec);
      }

      let shard: TableManifest["shard"];
      if (def.shardRef) {
        const s = shardManifests[def.shardRef.name];
        if (!s) throw new Error(`Table ${name}: unknown shard ${def.shardRef.name}`);
        const f = shapeAtPath(document, def.shardRef.field);
        if (!f) throw new Error(`Table ${name}: shard field ${def.shardRef.field} does not exist`);
        if (f.optional || JSON.stringify(f.shape) !== JSON.stringify(s.key)) {
          throw new Error(`Table ${name}: shard field ${def.shardRef.field} must be required and match the shard key validator`);
        }
        shard = { ...def.shardRef };
      }
      tableManifests[name] = shard ? { idPrefix, document, shard, indexes } : { idPrefix, document, indexes };
    }

    const body = { formatVersion: 1 as const, schemaValidation: options.schemaValidation ?? true, tables: tableManifests, shards: shardManifests };
    const hash = manifestHash(body);
    this.manifest = Object.freeze({ version: hash, hash, ...body });
  }
}

/** Stable hash of a manifest (keys sorted, `version`/`hash` excluded). */
export function manifestHash(m: Omit<SchemaManifest, "hash" | "version"> & { hash?: string; version?: string }): string {
  const { hash: _h, version: _v, ...body } = m;
  return sha256Hex(canonicalJson(toJSONValue(body)));
}

export function canonicalJson(x: JSONValue): string {
  if (Array.isArray(x)) return `[${x.map(canonicalJson).join(",")}]`;
  if (x && typeof x === "object") {
    return `{${Object.keys(x)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(x[k]!)}`)
      .join(",")}}`;
  }
  return JSON.stringify(x);
}

export type SchemaOptions = { indexKinds?: IndexKind[]; schemaValidation?: boolean };

/**
 * `defineSchema({ tables: {...}, shards?: {...}, indexKinds?, schemaValidation? })` (PLAN §2), or the Convex form
 * `defineSchema({ users: defineTable(...), ... }, options?)`.
 */
export function defineSchema<T extends GenericTables, S extends GenericShards = {}>(
  def: { tables: T; shards?: S } & SchemaOptions,
): SchemaDefinition<T, S>;
export function defineSchema<T extends GenericTables>(tables: T, options?: SchemaOptions): SchemaDefinition<T, {}>;
export function defineSchema(def: any, options?: SchemaOptions): SchemaDefinition {
  const values = Object.values(def);
  const convexStyle = values.length > 0 && values.every((x) => x instanceof TableDefinition);
  if (convexStyle || values.length === 0) return new SchemaDefinition(def, {}, options);
  const { tables, shards, ...opts } = def;
  if (!tables || typeof tables !== "object") throw new Error("defineSchema: expected { tables: {...} }");
  return new SchemaDefinition(tables, shards ?? {}, opts);
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
/** The data model of untyped (generic) builders. */
export type AnyDataModel = {
  [table: string]: { document: any; fieldPaths: string; indexes: Record<string, string[]>; ext: any };
};

export type DocFor<TableName extends string, V extends GenericValidator> = Expand<
  { _id: GenericId<TableName>; _creationTime: number } & Infer<V>
>;

export type DataModelFromSchema<SD> =
  SD extends SchemaDefinition<infer T, any>
    ? {
        [Name in keyof T & string]: T[Name] extends TableDefinition<infer V, infer I, infer E>
          ? {
              document: DocFor<Name, V>;
              fieldPaths: FieldPathsOf<V> | "_id";
              indexes: Expand<I & SystemIndexes>;
              ext: E;
            }
          : never;
      }
    : never;

