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
} from "@freecorps/ember-values";
import { aggregateKind } from "./aggregate.ts";
import type { IndexKind } from "./indexKinds.ts";
import { layoutOf } from "./layout.ts";
import { searchIndexKind } from "./search.ts";
import { vectorIndexKind } from "./vector.ts";
import { aiSearchIndexKind } from "./aiSearch.ts";
import { sha256Hex } from "./sha256.ts";
import type { IndexSpec } from "./types.ts";
import type { ComponentManifest } from "./components.ts";

export type GenericIndexes = Record<string, string[]>;

/** Index kinds every schema has: search (FTS5), aggregates, Vectorize and AI Search. */
const BUILTIN_KINDS: IndexKind[] = [searchIndexKind as IndexKind, aggregateKind as IndexKind, vectorIndexKind as IndexKind, aiSearchIndexKind as IndexKind];
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

/** Cloudflare's Durable Object location hints (developers.cloudflare.com/durable-objects/reference/data-location). */
export const LOCATION_HINTS = ["wnam", "enam", "sam", "weur", "eeur", "apac", "apac-ne", "apac-se", "oc", "afr", "me"] as const;
export type LocationHint = (typeof LOCATION_HINTS)[number];

/**
 * Where a shard kind's objects are created: one hint for every key, or `{ fromKey: true }`: the hint is the key's last
 * `separator`-delimited segment (default `":"`) when it is one of `LOCATION_HINTS` (`probe:ws_1:weur` → `weur`),
 * else `fallback`, else the Worker's default. Declarative so it stays part of the schema's manifest and hash; a rule
 * that needs code goes in `createEmberWorker({ locationHint })`.
 */
export type ShardLocationHint = LocationHint | { fromKey: true; separator?: string; fallback?: LocationHint };

export interface ShardDefinition<K extends GenericValidator = GenericValidator> {
  readonly key: K;
  readonly locationHint?: ShardLocationHint;
}

export function defineShard<K extends GenericValidator>(def: { key: K; locationHint?: ShardLocationHint }): ShardDefinition<K> {
  const h = def.locationHint;
  const known = (x: unknown) => (LOCATION_HINTS as readonly string[]).includes(x as string);
  if (typeof h === "string" && !known(h)) throw new Error(`defineShard: unknown locationHint ${JSON.stringify(h)} (one of ${LOCATION_HINTS.join(", ")})`);
  if (h !== undefined && typeof h !== "string") {
    if (typeof h !== "object" || h === null || h.fromKey !== true) throw new Error("defineShard: locationHint is a hint string or { fromKey: true, separator?, fallback? }");
    if (h.separator !== undefined && (typeof h.separator !== "string" || h.separator === "")) throw new Error("defineShard: locationHint.separator must be a non-empty string");
    if (h.fallback !== undefined && !known(h.fallback)) throw new Error(`defineShard: unknown locationHint.fallback ${JSON.stringify(h.fallback)} (one of ${LOCATION_HINTS.join(", ")})`);
  }
  return Object.freeze({ ...def });
}

/** The hint for one shard key under `hint` (`ShardLocationHint`); undefined when it gives none. */
export function resolveLocationHint(hint: unknown, key: string): string | undefined {
  if (typeof hint === "string") return hint || undefined;
  if (typeof hint !== "object" || hint === null || (hint as { fromKey?: unknown }).fromKey !== true) return undefined;
  const { separator, fallback } = hint as { separator?: unknown; fallback?: unknown };
  const sep = typeof separator === "string" && separator ? separator : ":";
  const at = key.lastIndexOf(sep);
  // No separator in the key: the whole key is its only segment.
  const last = at < 0 ? key : key.slice(at + sep.length);
  if ((LOCATION_HINTS as readonly string[]).includes(last)) return last;
  return typeof fallback === "string" && fallback ? fallback : undefined;
}

// ------------------------------------------------------------------------------------------------ manifest

export type TableManifest = {
  idPrefix: string;
  document: ObjectShape;
  shard?: { name: string; field: string };
  indexes: IndexSpec[];
};
export type ShardManifest = { key: Shape; locationHint?: ShardLocationHint };
export type SchemaManifest = {
  /** Schema version: the manifest hash (what the runtime and the catalog compare). */
  version: string;
  /** sha256 of the canonical JSON of everything except `version`/`hash`. */
  hash: string;
  formatVersion: 1;
  schemaValidation: boolean;
  tables: Record<string, TableManifest>;
  shards: Record<string, ShardManifest>;
  /**
   * Installed components (contracts.md "Componentes"), by install path ("rl", "email/rl"). Only present when the
   * app installs components (`composeApp`); their tables are in `tables` under physical names (`rl$buckets`).
   */
  components?: Record<string, ComponentManifest>;
};

export type AnyTableDefinition = TableDefinition<any, any, any>;
export type GenericTables = Record<string, AnyTableDefinition>;
export type GenericShards = Record<string, ShardDefinition>;

export class SchemaDefinition<Tables extends GenericTables = GenericTables, Shards extends GenericShards = GenericShards> {
  readonly manifest: SchemaManifest;
  /** Index kinds available to this schema, by kind. */
  readonly indexKinds: ReadonlyMap<string, IndexKind>;
  /** Install configs of the components of a composed schema (`composeApp`), by install path. */
  readonly componentConfigs?: ReadonlyMap<string, unknown>;
  /** The app's private SQL tables (`SchemaOptions.privateSql`), checked. */
  readonly privateSql?: PrivateSql;

  constructor(
    readonly tables: Tables,
    readonly shards: Shards,
    options: SchemaOptions = {},
  ) {
    const kinds = new Map<string, IndexKind>();
    const byMethod = new Map<string, IndexKind>();
    for (const k of [...BUILTIN_KINDS, ...(options.indexKinds ?? [])]) {
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

    if (options.privateSql) {
      const { tables: names, ddl } = options.privateSql;
      for (const name of names) {
        if (!NAME.test(name) || name.startsWith("_")) throw new Error(`Invalid private SQL table name ${name}: use [A-Za-z][A-Za-z0-9_]*, no leading "_"`);
        if (name in tableManifests) throw new Error(`Private SQL table ${name} is also a schema table`);
      }
      const declared = new Set(names.map((n) => n.toLowerCase()));
      for (const statement of ddl) {
        const shown = statement.trim().slice(0, 60);
        // One statement, nothing hidden in comments: `migrate()` hands it to the driver as it is.
        if (/;\s*\S/.test(statement) || /--|\/\*/.test(statement)) throw new Error(`Private SQL DDL must be one statement without comments: ${shown}`);
        const m = /^\s*create\s+(?:unique\s+)?(table|index)\s+if\s+not\s+exists\s+"?([A-Za-z_][A-Za-z0-9_]*)"?(?:\s+on\s+"?([A-Za-z_][A-Za-z0-9_]*)"?)?/i.exec(statement);
        if (!m) throw new Error(`Private SQL DDL must be idempotent (create table/index if not exists): ${shown}`);
        const [, kind, name, on] = m;
        if (name!.startsWith("_")) throw new Error(`Private SQL DDL may not create ${name}: no leading "_"`);
        const table = kind!.toLowerCase() === "table" ? name! : on;
        if (!table || !declared.has(table.toLowerCase())) {
          throw new Error(`Private SQL DDL must create a declared private table or an index on one: ${shown}`);
        }
      }
      this.privateSql = { tables: [...names], ddl: [...ddl] };
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

/**
 * App-private SQL tables (`ctx.sql` in mutations): tables Ember neither syncs, validates nor makes reactive, for an
 * app's own bookkeeping (ledgers, leases, counters) next to its documents in the same transaction. `tables` names
 * them (never a schema table, never starting with "_"); `ddl` creates them, and must be idempotent (`create table if
 * not exists`, `create index if not exists`): `migrate()` runs every statement on each migration.
 */
export type PrivateSql = { tables: readonly string[]; ddl: readonly string[] };

export type SchemaOptions = { indexKinds?: IndexKind[]; schemaValidation?: boolean; privateSql?: PrivateSql };

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

