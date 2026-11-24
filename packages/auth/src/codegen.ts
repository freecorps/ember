/**
 * Codegen helpers for the CLI (Node-safe): read-only auth table descriptors (`auth:user`, ...),
 * the reserved-name check for user schemas, and the `Auth` DO baseline DDL.
 */
import type { BetterAuthOptions } from "better-auth";
import { getAuthTables } from "better-auth/db";
import type { DBFieldAttribute } from "@better-auth/core/db";
import { resolveAuthConfig, type EmberAuthConfig, type EmberAuthFactory } from "./define.ts";
import { resolveAuthOptions } from "./options.ts";
import { hiddenFieldsOf, hiddenUserFieldsOf } from "./hidden.ts";
import { REPLICA_JOURNAL_TABLE, REPLICATED_MODELS, schemaDDL, tableSpecs } from "./ddl.ts";

export const AUTH_TABLE_PREFIX = "auth:";

/**
 * Model names used by Better Auth core and its first-party plugins (1.7.x). User tables may not
 * use them (nor the `auth:` prefix), whether or not the plugin is enabled today, so enabling a
 * plugin later never collides with app data. Extend user records via `user.additionalFields`.
 */
export const RESERVED_AUTH_TABLES = [
  "user",
  "session",
  "account",
  "verification",
  "rateLimit",
  "jwks",
  "organization",
  "member",
  "invitation",
  "team",
  "teamMember",
  "organizationRole",
  "twoFactor",
  "passkey",
  "apikey",
  "ssoProvider",
  "scimProvider",
  "scimConnectionBinding",
  "scimSubject",
  "scimUser",
  "scimGroup",
  "scimGroupMember",
  "scimProjectionGrant",
  "scimIdentityTombstone",
  "scimManagedConnection",
  "scimManagedCredential",
  "scimManagedConnectionEvent",
  "oauthApplication",
  "oauthClient",
  "oauthAccessToken",
  "oauthRefreshToken",
  "oauthConsent",
  "oauthResource",
  "oauthClientResource",
  "oauthClientAssertion",
  "deviceCode",
  "walletAddress",
  "subscription",
] as const;

export type AuthFieldType = "string" | "number" | "boolean" | "date" | "json" | "string[]" | "number[]" | { enum: string[] };

export type AuthFieldDescriptor = {
  /** Field name as seen by Better Auth / app code. */
  name: string;
  /** Physical column. */
  column: string;
  type: AuthFieldType;
  optional: boolean;
  unique: boolean;
  /**
   * Never leaves the Auth DO (`hidden.ts`): not returned to clients by Better Auth (password hashes, secrets, private
   * keys), a known plugin secret, or a `user` field listed in `ember.hiddenUserFields`.
   */
  hidden: boolean;
  /** `auth:<model>` this field references. */
  references?: string;
};

export type AuthTableDescriptor = {
  /** `auth:<model>`: the name app code uses (`Doc<"auth:user">`). */
  name: `auth:${string}`;
  model: string;
  table: string;
  readOnly: true;
  idType: "string" | "number";
  fields: AuthFieldDescriptor[];
};

const fieldType = (f: DBFieldAttribute): AuthFieldType => {
  if (Array.isArray(f.type)) return { enum: [...(f.type as string[])] };
  return f.type as AuthFieldType;
};

export type ManifestOptions = { project?: string };

/** Final options as the Auth DO will run them (minus database/secret). */
export const codegenOptions = (config: EmberAuthConfig | EmberAuthFactory | BetterAuthOptions, o: ManifestOptions = {}) =>
  // The function form is called with an empty env: the tables must not depend on the environment.
  resolveAuthOptions(resolveAuthConfig(config, {}), { project: o.project ?? "ember" });

export function authTablesManifest(config: EmberAuthConfig | EmberAuthFactory | BetterAuthOptions, o: ManifestOptions = {}): AuthTableDescriptor[] {
  const resolved = resolveAuthConfig(config, {});
  const options = codegenOptions(resolved, o);
  const tables = getAuthTables(options);
  const specs = new Map(tableSpecs(options).map((s) => [s.key, s]));
  // `ember.hiddenUserFields`: checked here (codegen), so a typo fails before a deploy.
  const hiddenUser = hiddenUserFieldsOf(resolved);
  const out: AuthTableDescriptor[] = [];
  for (const [model, table] of Object.entries(tables)) {
    const spec = specs.get(model);
    if (!spec) continue; // disableMigrations
    const hidden = hiddenFieldsOf(model, table.fields, hiddenUser, true);
    const fields: AuthFieldDescriptor[] = [];
    for (const [key, f] of Object.entries(table.fields)) {
      if ((f.fieldName ?? key) === "id") continue;
      const d: AuthFieldDescriptor = {
        name: key,
        column: f.fieldName ?? key,
        type: fieldType(f),
        optional: f.required === false,
        unique: f.unique === true,
        hidden: hidden.has(key),
      };
      if (f.references) d.references = `${AUTH_TABLE_PREFIX}${f.references.model}`;
      fields.push(d);
    }
    const idCol = spec.columns[0]!;
    out.push({
      name: `${AUTH_TABLE_PREFIX}${model}`,
      model,
      table: table.modelName,
      readOnly: true,
      idType: idCol.sqlType === "INTEGER" ? "number" : "string",
      fields,
    });
  }
  return out;
}

/**
 * Throw if any user table name collides with an auth table: the static reserved list, the
 * `auth:` prefix, or a model/physical name produced by this auth config (custom `modelName`s).
 */
export function assertNoReservedTables(userTables: Iterable<string>, config?: EmberAuthConfig | EmberAuthFactory | BetterAuthOptions) {
  const reserved = new Set<string>(RESERVED_AUTH_TABLES);
  if (config) {
    for (const t of authTablesManifest(config)) {
      reserved.add(t.model);
      reserved.add(t.table);
    }
  }
  const bad: string[] = [];
  for (const name of userTables) {
    if (name.startsWith(AUTH_TABLE_PREFIX) || reserved.has(name)) bad.push(name);
  }
  if (bad.length) {
    throw new Error(
      `Table name(s) reserved for auth: ${bad.join(", ")}. Auth tables are owned by the Auth DO and exposed read-only as "auth:<model>"; extend users via user.additionalFields in auth.config.ts.`,
    );
  }
}

/** Baseline DDL for the Auth DO (what `ember codegen` can write to `_generated/auth.sql`). */
export const authSchemaSQL = (config: EmberAuthConfig | EmberAuthFactory | BetterAuthOptions, o: ManifestOptions = {}) =>
  schemaDDL(codegenOptions(config, o));

// ------------------------------------------------------------------------------------------------ replication

/** One replicated field (what `@freecorps/ember-server`'s `ReplicaFieldSpec` is). */
export type ReplicaFieldSpec = { name: string; type: AuthFieldType; optional: boolean };

/** A replicated model: the replica table the shards get plus how the Auth DO reads it (runtime `AuthReplicaTable`). */
export type AuthReplicaTable = {
  /** `auth:<model>`: the table app code queries in the org shard. */
  name: `auth:${string}`;
  source: "auth";
  idType: "string" | "number";
  /** Visible fields only: hidden ones never leave the Auth DO. */
  fields: ReplicaFieldSpec[];
  /** `by_<field>` on references, unique and indexed fields (`by_source_id` on `id` is implicit). */
  indexes: Array<{ name: string; fields: string[] }>;
  model: string;
  /** Physical table in the Auth DO. */
  table: string;
  /** Field key → physical column and Better Auth type. */
  columns: Record<string, { column: string; kind: string }>;
};

/** What `authOutbox({ replicate })` takes (runtime `AuthReplicaSpec`); JSON, embedded in the Worker entry by the CLI. */
export type AuthReplicaSpec = {
  shardKind: string;
  version: string;
  /** Table the replication triggers write (`REPLICA_JOURNAL_TABLE`): the runtime reads it from here, never a copy. */
  journal: string;
  tables: AuthReplicaTable[];
};

const SHARD_KIND = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** Short stable hash (not cryptographic): the spec's fingerprint. */
function fingerprint(text: string): string {
  let h1 = 0xdeadbeef ^ text.length;
  let h2 = 0x41c6ce57 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

/**
 * Organization replication (`ember.replicate.organization` in auth.config.ts, PLAN §22 L3): the replicated tables and
 * how to read them, or null when it is off. Node-safe and pure: the CLI computes it at codegen/build, so the Worker's
 * shards get the tables without loading Better Auth.
 */
export function authReplicaSpec(config: EmberAuthConfig | EmberAuthFactory | BetterAuthOptions, o: ManifestOptions = {}): AuthReplicaSpec | null {
  const resolved = resolveAuthConfig(config, {}) as EmberAuthConfig;
  const want = resolved.ember?.replicate?.organization;
  if (!want) return null;
  const shardKind = typeof want === "object" && want.shard !== undefined ? want.shard : "org";
  if (typeof shardKind !== "string" || !SHARD_KIND.test(shardKind) || shardKind === "global") {
    throw new Error(`auth: ember.replicate.organization.shard must be a shard kind like "org" (got ${JSON.stringify(shardKind)})`);
  }
  const options = codegenOptions(config, o);
  const descriptors = new Map(authTablesManifest(config, o).map((d) => [d.model, d]));
  if (!descriptors.has("organization") || !descriptors.has("member")) {
    throw new Error("auth: ember.replicate.organization needs the organization() plugin in auth.config.ts");
  }
  const specs = new Map(tableSpecs(options).map((s) => [s.key, s]));
  const tables: AuthReplicaTable[] = [];
  for (const model of REPLICATED_MODELS) {
    const d = descriptors.get(model);
    const s = specs.get(model);
    if (!d || !s) continue;
    const visible = d.fields.filter((f) => !f.hidden);
    const indexed = new Set(s.indexes.filter((i) => i.columns.length === 1).map((i) => i.columns[0]!));
    const columns: AuthReplicaTable["columns"] = {};
    for (const c of s.columns) if (c.field !== "id" && visible.some((f) => f.name === c.field)) columns[c.field] = { column: c.name, kind: c.kind ?? "string" };
    tables.push({
      name: d.name,
      source: "auth",
      idType: d.idType,
      fields: visible.map((f) => ({ name: f.name, type: f.type, optional: f.optional })),
      indexes: visible.filter((f) => f.references || f.unique || indexed.has(f.column)).map((f) => ({ name: `by_${f.name}`, fields: [f.name] })),
      model,
      table: d.table,
      columns,
    });
  }
  return { shardKind, version: fingerprint(JSON.stringify([shardKind, tables])), journal: REPLICA_JOURNAL_TABLE, tables };
}

/** The replica tables alone (`emberTest({ replicas })`, `createEmberWorker({ replicas })`). */
export const authReplicaTables = (config: EmberAuthConfig | EmberAuthFactory | BetterAuthOptions, o: ManifestOptions = {}) =>
  (authReplicaSpec(config, o)?.tables ?? []).map(({ name, source, idType, fields, indexes }) => ({ name, source, idType, fields, indexes }));
