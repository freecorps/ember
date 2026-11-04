/**
 * Codegen helpers for the CLI (Node-safe): read-only auth table descriptors (`auth:user`, ...),
 * the reserved-name check for user schemas, and the `Auth` DO baseline DDL.
 */
import type { BetterAuthOptions } from "better-auth";
import { getAuthTables } from "better-auth/db";
import type { DBFieldAttribute } from "@better-auth/core/db";
import type { EmberAuthConfig } from "./define.ts";
import { resolveAuthOptions } from "./options.ts";
import { schemaDDL, tableSpecs } from "./ddl.ts";

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
  "oauthApplication",
  "oauthClient",
  "oauthAccessToken",
  "oauthRefreshToken",
  "oauthConsent",
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
  /** Not returned to clients by Better Auth (password hashes, secrets, private keys). */
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

/** Fields that never leave the Auth DO even if Better Auth does not flag them `returned: false`. */
const HIDDEN_FIELDS: Record<string, string[]> = {
  account: ["password", "accessToken", "refreshToken", "idToken"],
  verification: ["value"],
  twoFactor: ["secret", "backupCodes"],
  jwks: ["privateKey"],
  apikey: ["key"],
  passkey: ["publicKey"],
  session: ["token"],
};

const fieldType = (f: DBFieldAttribute): AuthFieldType => {
  if (Array.isArray(f.type)) return { enum: [...(f.type as string[])] };
  return f.type as AuthFieldType;
};

export type ManifestOptions = { project?: string };

/** Final options as the Auth DO will run them (minus database/secret). */
export const codegenOptions = (config: EmberAuthConfig | BetterAuthOptions, o: ManifestOptions = {}) =>
  resolveAuthOptions(config, { project: o.project ?? "ember" });

export function authTablesManifest(config: EmberAuthConfig | BetterAuthOptions, o: ManifestOptions = {}): AuthTableDescriptor[] {
  const options = codegenOptions(config, o);
  const tables = getAuthTables(options);
  const specs = new Map(tableSpecs(options).map((s) => [s.key, s]));
  const out: AuthTableDescriptor[] = [];
  for (const [model, table] of Object.entries(tables)) {
    const spec = specs.get(model);
    if (!spec) continue; // disableMigrations
    const hidden = new Set(HIDDEN_FIELDS[model] ?? []);
    const fields: AuthFieldDescriptor[] = [];
    for (const [key, f] of Object.entries(table.fields)) {
      if ((f.fieldName ?? key) === "id") continue;
      const d: AuthFieldDescriptor = {
        name: key,
        column: f.fieldName ?? key,
        type: fieldType(f),
        optional: f.required === false,
        unique: f.unique === true,
        hidden: f.returned === false || hidden.has(key),
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
export function assertNoReservedTables(userTables: Iterable<string>, config?: EmberAuthConfig | BetterAuthOptions) {
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
export const authSchemaSQL = (config: EmberAuthConfig | BetterAuthOptions, o: ManifestOptions = {}) =>
  schemaDDL(codegenOptions(config, o));
