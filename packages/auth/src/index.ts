/**
 * `@freecorps/ember-auth`: first-party Better Auth for Ember (PLAN §9, §21).
 *
 * This entry is Node-safe (the CLI imports it to evaluate `ember/auth.config.ts` and run codegen).
 * The Durable Object, fetch handler and `verify` live in `@freecorps/ember-auth/worker` (workerd only).
 */
export { defineAuth, isEmberAuthConfig, INJECTED_OPTIONS } from "./define.ts";
export type { AuthSession, DefineAuthInput, EmberAuthConfig, EmberAuthExtras } from "./define.ts";
export {
  assertProjectName,
  DEFAULT_BASE_PATH,
  DEFAULT_COOKIE_CACHE_MAX_AGE,
  DEFAULT_JWT_TTL,
  jwtIssuer,
  resolveAuthOptions,
} from "./options.ts";
export type { PasswordHooks, ResolveOptions, UserChangeEvent, UserChangeHook } from "./options.ts";
export {
  AUTH_TABLE_PREFIX,
  assertNoReservedTables,
  authSchemaSQL,
  authTablesManifest,
  codegenOptions,
  RESERVED_AUTH_TABLES,
} from "./codegen.ts";
export type { AuthFieldDescriptor, AuthFieldType, AuthTableDescriptor, ManifestOptions } from "./codegen.ts";
export { AuthMigrationError, migrate, planMigration, schemaDDL, schemaFingerprint, tableSpecs, userJournalDDL, USER_JOURNAL_TABLE } from "./ddl.ts";
export type { ColumnSpec, MigrateOptions, SqlLike, TableSpec } from "./ddl.ts";
export { PASSWORD_RULES } from "./password.ts";
export type { CredentialLookup, PasswordPlan, PasswordRule } from "./password.ts";
export type { Identity } from "./types.ts";
