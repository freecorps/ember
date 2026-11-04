# Spike: typegen, schema → SQLite, query read sets, and reactivity

Run it: `bun install && bun test` (46 tests; the codegen and `tsc` checks run inside `test/typegen.test.ts`).
Codegen by hand: `bun cli/codegen.ts sample`. Type check: `npx tsc --noEmit -p .` (passes) and
`npx tsc --noEmit -p tsconfig.error.json` (must fail).
Stack: bun 1.4.2, bun:sqlite (SQLite 3.54, standing in for Durable Object SQLite), TypeScript 7.0.2 (tsgo), `convex@1.49.0`, which was installed only so its source could be read.
Nothing was deployed. No Convex code was copied: the spike is about 2k lines of `src/`, written from scratch.

## Results

| # | What | Result |
|---|------|--------|
| a | `v` validators carry a JSON `Shape`; `defineTable().index().searchIndex()`; index-kind plugin registry with typed builder methods (`searchIndex` is built in, `vectorIndex` is a user plugin, and `geoIndex` is registered at runtime in a test) | PASS (7 tests) |
| b | Schema → DDL (STRICT table, typed scalar columns, `_rest` JSON, system columns, b-tree, expression index on a nested path, FTS5 + triggers, plugin side table); diff → migration plan through `sqlite_master`/`PRAGMA` introspection plus the stored schema JSON | PASS (13 tests) |
| c | `withIndex(eq…gt/lt).filter().order().take()/first()/unique()/paginate()` compiled to SQL (`INDEXED BY`, null-aware tuple bounds). Every run records a read set (table, index, key range narrowed to what was actually scanned, filter). `EXPLAIN QUERY PLAN` shows an index SEARCH | PASS (10 tests) |
| d | Reactivity: invalidation by range overlap on the before and after image of each changed row (so rows moving in or out are caught); re-run, diff, patch. 8 targeted tests plus a randomised test (4 seeds × 300 mutations of 1–3 ops × 16 subscriptions) checking **no false negatives and exactly the right patches** | PASS (12 tests, about 6,000 assertions; precision 83–87%) |
| e | Codegen CLI → `_generated/{api,dataModel,server,modules}.{js,d.ts}` + `schema.json` + `functions.json`. `sample/client.ts` passes `tsc` with exact type-equality assertions. All 21 `// ERR` lines in `client_error.ts`/`server_error.ts` fail, and no other line does | PASS (3 tests) |
| – | End to end: generated `api` → in-process client → subscribe / mutate / patch; runtime argument and id validation; internal functions refused | PASS (1 test) |

Checking that the tests can fail. I broke the engine on purpose twice:
- When overlap checks only the `after` image, 7 tests fail, including all 4 random seeds.
- When the `take(n)` read-set bound is made exclusive, 5 tests fail.

The original code was restored both times.

## Part 1: how Convex does it (read from `node_modules/convex/src`)

**What `codegen` emits** (`cli/codegen_templates/*.ts`). By default the generated types are "dynamic" and restate nothing:
- `api.d.ts`
  - Has `import type * as mod from "../path/mod.js"` for every module.
  - Declares `fullApi: ApiFromModules<{ "dir/mod": typeof mod }>`.
  - Exports `api = FilterApi<typeof fullApi, FunctionReference<any,"public">>` and `internal` (the same with `"internal"`).
- `api.js` is just `export const api = anyApi`.
- `dataModel.d.ts` has `DataModel = DataModelFromSchemaDefinition<typeof schema>` (via `import schema from "../schema.js"`), plus `Doc<T>`, `Id<T>` and `TableNames`.
- `server.d.ts` has `query: QueryBuilder<DataModel,"public">` and the same pattern for `internalQuery`, `mutation`, `action` and `httpAction`, plus `QueryCtx`, `MutationCtx` and `DatabaseReader`. `server.js` re-exports `queryGeneric` and the other generic builders.
- There is an optional **static** mode (`convex.json` `codegen.staticApi` / `staticDataModel`). It emits literal types from the server's analysis of validators, which keeps TypeScript fast on big apps. Without a schema, `Doc = any`.

**Function references.**
- `anyApi` is a recursive `Proxy`. `ref[Symbol.for("functionName")]` gives `"dir/mod:export"` (just `"dir/mod"` for a `default` export).
- `FunctionReference` is a phantom type: `{_type, _visibility, _args, _returnType, _componentPath}`.
- `ApiFromModules` splits module paths on `/` into nested objects, keeps exports where `isConvexFunction` is true, and intersects them with `UnionToIntersection`. `FilterApi` prunes by visibility.
- A registered function carries `isQuery`/`isMutation`/`isPublic`, `exportArgs()` (JSON validator) and `invokeQuery(argsJson)`.

**Schema push.**
- `SchemaDefinition.export()` produces JSON: `{tables:[{tableName, indexes, stagedDbIndexes, searchIndexes, vectorIndexes, documentType, stagedDocumentType}], schemaValidation}`.
- The deploy flow is `POST /api/deploy2/start_push` (the server evaluates schema and modules and returns `schemaChange.indexDiffs` with added/removed/enabled/disabled) → poll `/wait_for_schema` → `finish_push`.
- `/wait_for_schema` returns `inProgress{schemaValidationComplete, indexesComplete/Total}`, `failed{error, tableName}`, `raceDetected` or `complete`.
- `schemaValidation` (default true) checks every existing document against the new validators in the background, and checks every write.
- `staged: true` indexes and `.staged(validator)` let a push succeed before the backfill or validation finishes.

**Query typing.**
- `withIndex<Name>(name, q => IndexRange)` uses `IndexRangeBuilder<Doc, Fields, N>`, recursing with `PlusOne<N>`. `eq` walks the index fields in order, then at most one `gt/gte` and one `lt/lte` on the next field.
- Every index implicitly ends in `_creationTime` (`IndexTiebreakerField`). The system indexes are `by_id` and `by_creation_time`.
- `Query.order()` → `OrderedQuery` (`filter`, `take`, `collect`, `first`, `unique`, `paginate`). `paginate` returns `{page, isDone, continueCursor, splitCursor?, pageStatus?}` and accepts `endCursor` and `maximumRowsRead`; reactive pagination pins `endCursor`.
- Filters are expression trees sent through the `1.0/queryStream` syscall.

**System fields and ids.**
- `_id: GenericId<T>` is `string & {__tableName: T}`, and `_creationTime` is float milliseconds.
- An id is base32 of (internal id bytes + table-number varint + checksum). It is 31 characters for table numbers 1–127 and 32 for 128–16383 (`values/size.ts`).
- `db.get` finds the table from the id.

**Components** (`server/components/index.ts`).
- The app has `convex.config.ts` with `defineApp({env})` and `app.use(component, {name, env, httpPrefix})`.
- A component package has its own `convex.config.ts` with `defineComponent(name, {env})`, plus a schema and functions. Its tables and function namespace are isolated.
- The app calls a component with `ctx.runQuery(components.<name>.<mod>.<fn>, args)`. `componentsGeneric()` is a Proxy that resolves to `"_reference/childComponent/<path>"`.
- Component API types are generated statically from the server's analysis.
- Env vars are typed by validators. `createFunctionHandle` passes callbacks across the component boundary.

## Part 2: our design (code in `src/`)

### a. Validators and index kinds (`values.ts`, `schema.ts`, `search.ts`, `plugins/vector.ts`)
- A `Validator<T, Optional, FieldPaths>` is a frozen `{shape, isOptional}`. `T` and the dotted `FieldPaths` are phantom types.
- `Shape` is plain JSON and the single source for:
  - runtime validation (`validate`)
  - the DDL compiler
  - migrations
  - the codegen manifest
- `int64` is a `bigint`, stored as JSON `{"$int64": "…"}`.
- `.index()` is the only kind built into the core. Any other kind is an `IndexKindPlugin`:
  ```ts
  { kind, method, parse(name, cfg, docShape) → IndexSpec,
    ddl(layout, spec) → OwnedObject[], backfill?(layout, spec) → sql[],
    queryMethod?, execute?(env, spec, builderArg) → {docs, readSetData},
    overlaps?(readSetEntry, change, keyPart) → boolean }
  ```
- `registerIndexKind` installs `method` on `TableDefinition.prototype`, and `queryMethod` on every query instance.
- **Typing comes from module augmentation** of two empty interfaces, `IndexKindMethods<V, Indexes, Ext>` (merged into `TableDefinition`) and `IndexKindQueryMethods<TI>` (merged into `QueryInitializer`). A plugin's config lands in `DataModel[t].ext[kind][indexName]`, so for example `withVectorIndex("by_embedding", {filter: {channel}})` gets checked filter fields.
- `searchIndex` is written as such a plugin to prove the API is sufficient.

### b. Schema → SQL (`ddl.ts`)
- **Table layout:**
  - `STRICT`, with `_rowid INTEGER PRIMARY KEY` (explicit, so VACUUM cannot renumber it), `_id TEXT UNIQUE` and `_creationTime REAL`.
  - Each top-level scalar field gets a nullable typed column (`TEXT`/`REAL`/`INTEGER`; bool is stored as 0/1).
  - Everything else goes in `_rest TEXT` JSON. That includes nested objects, arrays, mixed unions, and **optional+nullable scalars**: NULL could not tell `undefined` from `null`, so those must stay in JSON.
- **Indexes:**
  - A b-tree index is `(fields…, _creationTime, _id)`, which matches Convex tie order.
  - A nested path becomes an expression index on `json_extract(_rest, '$."a"."b"')`.
  - Search is FTS5 (`unicode61 remove_diacritics 2`) kept in sync by AFTER INSERT/UPDATE/DELETE triggers keyed on `_rowid`.
- **Ownership:** every derived object is named `<table>__<x>` and **diffed against `sqlite_master` by its exact SQL text**. Plugins therefore get create, drop and change migrations without extra code.
- **Planner** (`planMigration`):
  - Combines introspection (`PRAGMA table_info`, `sqlite_master`, row counts) with the previously pushed schema JSON (`_cfx_schema`), which is needed to know where a field used to live.
  - Every step has a risk level: `safe` (metadata only) / `backfill` / `validate` (scans rows) / `breaking` (refused).

  | Change | Plan |
  |---|---|
  | add table | `createTable` + `createObject` (safe) |
  | add / drop / redefine index | `dropObject` (safe) then `createObject` (backfill if rows exist; FTS and plugins run their `backfill`) |
  | add optional nested field | `noop` + `validateData`. No SQL at all |
  | add optional scalar field | `ADD COLUMN` (metadata only) + `validateData` |
  | add required field | OK if the table is empty; **refused** with data (`owner: Missing required field`) |
  | column type change | `rebuildTable` if empty; **refused** with data ("needs a data migration") |
  | type change inside `_rest` | caught by validating existing documents → refused |
  | widening (`string` → `string \| number`) | `moveField` column→`_rest` (rows rewritten), index rebuilt, data kept |
  | remove field that still has data | refused |
  | remove table | `keepOrphanTable` (data kept, untyped) |
- Re-pushing the same schema produces an empty plan.

### c. Queries and read sets (`engine.ts`, `server.ts`, `keys.ts`)
- `withIndex` turns into bounds over the index key tuple: an equality prefix, then an optional lower bound and an optional upper bound.
- The SQL is `SELECT … INDEXED BY "<t>__<index>" WHERE <shared eq prefix as IS ?> AND <null-aware tuple bounds> ORDER BY <key> ASC|DESC`.
  - Comparisons are spelled out by hand because SQLite's `x < ?` is NULL when `x` is NULL, while in index order NULL sorts first.
- Rows are streamed through a lazy cursor. `.filter()` runs **in JS only**, so there is one semantics for both execution and invalidation. The scan stops after `n` matches.
- **Read set** = `{table, index, fields, lower, upper, filter}`, where the range is narrowed to what was actually scanned:
  - When `take(n)` stops early, the bound ends at the last returned key (inclusive). A write past the tail of a top-n therefore does not invalidate it.
  - `db.get(id)` records a point range on `by_id`.
  - Plugin reads record `{kind: "plugin", indexKind, data}`.
- `paginate` uses opaque cursors (base64 of the key tuple). `endCursor` re-runs a page with its end pinned, as Convex does.
- `keys.ts` reproduces SQLite order in JS:
  - NULL < numbers (int and real compared numerically) < TEXT.
  - TEXT is compared by code point, which equals UTF-8 byte order. JS `<` compares UTF-16 units and differs above U+FFFF; a test covers this.
- **Ids:** base32 of 14 random bytes + table-number varint + fletcher16, 28 characters. They carry the table, and the checksum rejects tampering.

### d. Reactivity (`reactivity.ts`, `overlaps` in `engine.ts`)
- A mutation runs inside a SAVEPOINT. Mutations are serialised, which is the Durable Object model, so no OCC is needed.
- The mutation captures one `RowChange {table, id, before, after}` per row, merging repeated writes to the same row (first `before`, last `after`).
- A subscription is invalidated if any change's **before or after** image falls in a range (and passes the recorded filter). Using both images is what catches rows moving in or out of a range on update.
  - Search overlap: the filter fields match and the JS tokenizer (a mirror of unicode61) finds a query term or the last-term prefix, **or** the id was in the previous results.
  - Vector overlap: the filter matches.
- Invalidated subscriptions are re-run. The read set is replaced with the new run's one (a top-n window may have moved). A result that has not changed emits nothing. Document arrays get a row-level diff `{added, removed, changed, order}`; other results send the whole value.
- **Proof**, by the randomised test: after each commit, every one of the 16 subscriptions is re-run from scratch and compared.
  - Every subscription whose result changed had been invalidated.
  - `onCommit` emitted patches for exactly that set.
  - Precision was 83–87%. The rest are false positives such as in-range writes that do not change a projection or count; they cost only a re-run.

### e. Codegen (`cli/codegen.ts`)
- The approach is Convex's dynamic one. `.d.ts` files hold `typeof import()` of the user modules and the shape-level generics from `cfx/server` (`ApiFromModules`, `FilterApi`, `QueryBuilder<DataModel, Vis>`, `DataModelFromSchema`). Codegen only needs re-running when files are added or removed.
- Runtime stubs: `api.js` = `anyApi`; `server.js` re-exports the generic builders.
- `modules.js` statically imports every module, because a Worker bundle cannot list files at runtime.
- The CLI also imports `schema.ts` (which validates it) and every module, and writes `schema.json` (input to the migration planner) and `functions.json` (name, type, visibility and argument shape, used by the Worker router and argument validation).
- **Proof:**
  - `sample/client.ts` asserts *exact* types with an `Equals<>` helper: arguments, return types (including a paginated projection), `Doc<"messages">` with optional and nested fields, the visibility split, and that non-function exports are absent.
  - `client_error.ts` covers: a wrong argument type, a missing argument, an unknown function, a query used as a mutation, an internal function called from the client, `Id<"messages">` passed as `Id<"users">`, a wrong field type, an unknown field, and missing required arguments.
  - `server_error.ts` covers: an unknown index, eq on the wrong field order, a wrong range value type, a range after a full eq, an unknown table, the wrong search field, the wrong search or vector filter field, an unknown filter field, a missing insert field, a wrong insert type, and writing a system field.
  - Every one of those lines errors, and no other line does.

### Components (design only, not built)
- Mirror Convex. A component package exports `defineComponent("betterAuth", {env})` along with its own `schema.ts` and `functions/`. The app's `cfx.config.ts` calls `app.use(betterAuth, {env: {...}})`.
- Tables live in the same shard under a reserved prefix (`betterAuth$users`), so the planner, read sets and reactivity apply unchanged. App code cannot name these tables because `DataModel` does not include them.
- Codegen emits `components.betterAuth.*` as references (a Proxy to `"_reference/betterAuth/mod:fn"`) with static types generated from the component's `functions.json`. Static generation is required here because the app should not type-check the component's source.
- Planned components:
  - **Better Auth:** adapter functions over its tables.
  - **Scheduler:** a `scheduled` table plus the DO alarm, used by `ctx.scheduler.runAfter(internal.x.y, args)`.
  - **Email:** an outbox table plus an action, retried by the scheduler.

## Open issues / risks
1. **Search ranking can go stale.** bm25 depends on corpus statistics, so an unrelated insert can reorder results without invalidating them. Membership is exact, but order is approximate (Convex is approximate too).
   - The JS tokenizer must match FTS5's. The previous-results check covers rows *leaving* the results; a tokenizer mismatch on a row *entering* would be a false negative.
   - Fix: check overlap with a real FTS5 `MATCH` against the changed row's text in a temporary in-memory FTS table.
2. **Value order is not Convex's.** SQLite orders NULL < number < text. Convex orders undefined < null < int64 < float64 < bool < string < bytes < array < object.
   - In index keys, `undefined` and `null` collapse together, bools collide with 0/1, and objects or arrays compare as JSON text (an int64 nested in `_rest` would be compared as a `{"$int64"}` object).
   - Options: restrict indexable fields to single-typed scalars (which the column layout nearly guarantees already), or add an order-preserving encoded key column (BLOB) per index.
   - NaN, ±Infinity and -0 are not handled.
3. **Large pushes are synchronous.** Validation scans, CREATE INDEX and FTS backfill all run inside the push transaction. A DO has CPU limits, so we need chunked background backfill and validation driven by alarms, with Convex-style `staged` indexes and `inProgress` status.
4. **Mutations and transactions.** The handler is async and the SAVEPOINT spans awaits. That is fine here because every database call is synchronous, but in a DO, mutations must not do real I/O (Convex forbids `fetch` in mutations) or must use the synchronous `transactionSync`. Mutations are serialised with a promise queue.
5. **Matching does not scale yet.** It is O(subscriptions × read-set entries × changes). Thousands of subscriptions need a per-table interval index over read-set ranges. Re-runs are full re-executions; incremental maintenance of simple range queries is a later optimisation.
6. **Pagination is partial.** There is no peek, so `isDone` is false when a page is exactly full and the next page is empty. `splitCursor`/`pageStatus` and `maximumRowsRead` are not implemented.
7. **Codegen trade-offs.**
   - Dynamic types make the client type-check pull in server code, so we should offer static emission from `args`/`returns` validators (`returns` is captured but not used yet).
   - Wire conversions (`undefined` → `null`, bigint over JSON) are not reflected in `FunctionReturnType`.
   - Codegen executes user modules to build the manifest; Convex does this server-side after bundling.
   - Only checked with tsc 7.0.2 (tsgo).
8. **The plugin registry is process-global.** It is installed on prototypes, so `schema.ts` must import its plugins and import order matters. A config file listing plugins (and components) would be cleaner.
9. **Sharding is not addressed.** Read sets and reactivity are per shard. Ids encode the table but not the shard, so cross-shard queries and routing need a shard key in the id or a directory.
10. **Naming.** The meta tables (`_cfx_tables`, `_cfx_schema`) are close to Cloudflare's reserved `_cf_` prefix; consider renaming. Table names may not contain `__` (it marks owned objects) or start with `_`.

## Files
- `src/values.ts`: `v`, `Shape`, `validate`, int64 JSON
- `src/schema.ts`: `defineSchema`, `defineTable`, index-kind registry, `DataModelFromSchema`
- `src/search.ts`: FTS5 search index plugin, typed through augmentation
- `plugins/vector.ts`: a user-land index-kind plugin (vector)
- `src/ddl.ts`: layout, DDL, introspection, `planMigration`, `applyPlan`
- `src/engine.ts`: `Engine` (push, codec, reader and writer, query execution, read sets, `overlaps`)
- `src/keys.ts`: SQLite-compatible key order and ids
- `src/reactivity.ts`: `SubscriptionManager`, diffs
- `src/server.ts`: builders, ctx and db types, `FunctionReference`, `ApiFromModules`, `FilterApi`, `anyApi`
- `src/client.ts`: typed client interface plus the in-process transport
- `cli/codegen.ts`: the codegen CLI
- `sample/`: schema, `functions/{messages,users,nested/admin}.ts`, `_generated/`, `client.ts`, `client_error.ts`, `server_error.ts`
- `test/`: `schema`, `ddl`, `query`, `reactivity`, `typegen` and `e2e` tests
