// What Convex names become in Ember: imports of `convex/server` / `convex/values`, the `_generated` modules, the
// ctx methods that turn synchronous (PLAN D6) and the builders. A test checks that every Ember name here is exported
// by `@freecorps/ember-server` (test/migrate-convex.test.ts), so this table cannot drift from the package.

export const EMBER_SERVER = "@freecorps/ember-server";
export const EMBER_VALUES = "@freecorps/ember-values";

/** `convex/server` and `convex/values` names Ember exports under the same name. */
export const SAME_NAME = new Set([
  "v",
  "defineSchema",
  "defineTable",
  "cronJobs",
  "httpRouter",
  "paginationOptsValidator",
  "paginationResultValidator",
  "makeFunctionReference",
  "getFunctionName",
  "anyApi",
  "createFunctionHandle",
  "Infer",
  "GenericId",
  "PaginationOptions",
  "PaginationResult",
  "FunctionReference",
  "FunctionReturnType",
  "FunctionArgs",
  "FunctionHandle",
  "FunctionType",
  "WithoutSystemFields",
  "Scheduler",
  "Auth",
  "StorageReader",
  "StorageWriter",
  "IndexRangeBuilder",
  "Expression",
  "FilterBuilder",
  "OrderedQuery",
  "Query",
  "QueryInitializer",
  "CronJobs",
  "RegisteredQuery",
  "RegisteredMutation",
  "RegisteredAction",
  "ApiFromModules",
  "FilterApi",
  "GenericDataModel",
  "HttpRouter",
  "SchemaDefinition",
  "TableDefinition",
  "queryGeneric",
  "mutationGeneric",
  "actionGeneric",
  "internalQueryGeneric",
  "internalMutationGeneric",
  "internalActionGeneric",
  "httpActionGeneric",
  "defineApp",
  "defineComponent",
]);

/** `convex/server` / `convex/values` names Ember has under another name (imported as `Ember as Convex`). */
export const RENAMED: Record<string, string> = {
  GenericQueryCtx: "QueryCtx",
  GenericMutationCtx: "MutationCtx",
  GenericActionCtx: "ActionCtx",
  GenericDatabaseReader: "DatabaseReader",
  GenericDatabaseWriter: "DatabaseWriter",
  DataModelFromSchemaDefinition: "DataModelFromSchema",
  UserIdentity: "Identity",
  TableNamesInDataModel: "TableNamesIn",
  componentsGeneric: "anyComponents",
  ROUTABLE_HTTP_METHODS: "HTTP_METHODS",
  RoutableMethod: "HttpMethod",
  PublicHttpAction: "RegisteredHttpAction",
  Value: "JSONValue",
};

/** Validator types Ember keeps in `@freecorps/ember-values` (a dependency of `@freecorps/ember-server`). */
export const VALUES_ONLY = new Set(["Validator", "PropertyValidators", "ObjectType", "GenericValidator", "ObjectValidator", "JSONValue"]);

/** Notes for renamed names whose shape differs. */
export const RENAME_NOTES: Record<string, string> = {
  UserIdentity: "Ember's `Identity` is `{ subject, issuer?, exp?, iat?, claims? }`: profile fields (email, name...) are in `claims`",
  Value: "Convex `Value` includes ArrayBuffer and bigint; Ember's `JSONValue` is plain JSON",
};

/** Builders exported by `_generated/server` (Convex and Ember alike) and their generic forms in `convex/server`. */
export const BUILDERS: Record<string, BuilderKind> = {
  query: "query",
  internalQuery: "query",
  mutation: "mutation",
  internalMutation: "mutation",
  action: "action",
  internalAction: "action",
  httpAction: "action",
  queryGeneric: "query",
  internalQueryGeneric: "query",
  mutationGeneric: "mutation",
  internalMutationGeneric: "mutation",
  actionGeneric: "action",
  internalActionGeneric: "action",
  httpActionGeneric: "action",
};
export type BuilderKind = "query" | "mutation" | "action";

/** convex-helpers builders wrapping another builder (first argument). */
export const CUSTOM_BUILDERS = new Set(["customQuery", "customMutation", "customAction", "zCustomQuery", "zCustomMutation", "zCustomAction"]);

/** Ctx types: parameters typed with these (or a type built from them) are database helpers. */
export const CTX_TYPES: Record<string, { kind: BuilderKind; path: string[] }> = {
  QueryCtx: { kind: "query", path: ["ctx"] },
  GenericQueryCtx: { kind: "query", path: ["ctx"] },
  MutationCtx: { kind: "mutation", path: ["ctx"] },
  GenericMutationCtx: { kind: "mutation", path: ["ctx"] },
  DatabaseReader: { kind: "query", path: ["ctx", "db"] },
  GenericDatabaseReader: { kind: "query", path: ["ctx", "db"] },
  DatabaseWriter: { kind: "mutation", path: ["ctx", "db"] },
  GenericDatabaseWriter: { kind: "mutation", path: ["ctx", "db"] },
  ActionCtx: { kind: "action", path: ["ctx"] },
  GenericActionCtx: { kind: "action", path: ["ctx"] },
};

/** ctx paths whose calls return a Promise in Convex and a value in Ember queries and mutations. */
export function isSyncCtxCall(segs: readonly string[]): boolean {
  const [root, a, b] = segs;
  if (root !== "ctx" || a === undefined) return false;
  if (a === "db") return b !== undefined && ["get", "insert", "patch", "replace", "delete", "normalizeId", "query", "system"].includes(b);
  if (a === "runQuery" || a === "runMutation") return segs.length === 2;
  if (a === "storage") return b !== undefined && ["getUrl", "getMetadata", "delete", "generateUploadUrl"].includes(b) && segs.length === 3;
  if (a === "scheduler") return b !== undefined && ["runAfter", "runAt", "cancel", "get", "list"].includes(b) && segs.length === 3;
  if (a === "auth") return b === "getUserIdentity" && segs.length === 3;
  return false;
}

/** Terminal methods of a query chain (anything else on `ctx.db.query(...)` is still a query). */
export const QUERY_TERMINALS = new Set(["collect", "first", "unique", "take", "paginate"]);

/** Fields of Convex's `UserIdentity` that Ember's `Identity` has at the top level. */
export const IDENTITY_FIELDS = new Set(["subject", "issuer", "exp", "iat", "claims"]);

export const WEEKDAYS: Record<string, number> = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
