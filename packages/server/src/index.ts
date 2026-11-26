export * from "./driver.ts";
export * from "./errors.ts";
export * from "./types.ts";
export * from "./schema.ts";
export * from "./indexKinds.ts";
export { searchIndexKind, tokenize, SEARCH_MAX_RESULTS, type SearchIndexConfig, type SearchTokenizer, type SearchIndexTypeInfo, type SearchFilter, type SearchFilterFinal, type SearchFilterBuilder } from "./search.ts";
export * from "./external.ts";
export * from "./vector.ts";
export * from "./aiSearch.ts";
export * from "./functions.ts";
export { errorCodesOf, isLazyFunction, lazyActions, loadFunction, type LazyActionMeta } from "./lazy.ts";
export * from "./crons.ts";
export * from "./triggers.ts";
export * from "./components.ts";
export * from "./channels.ts";
export * from "./dashboard.ts";
export * from "./http.ts";
export { MAX_HTTP_BODY_BYTES, readLimited, readLimitedText } from "./body.ts";
export { createMatchIndex, IntervalSet, type MatchIndex, type MatchResult } from "./matchIndex.ts";
export * from "./query.ts";
export {
  aggregateKind,
  aggregateTable,
  AGGREGATE_KIND,
  type AggregateOptions,
  type AggregateConfig,
  type AggregateSpec,
  type AggregateValue,
  type AggregateRow,
  type AggregateRangeOptions,
} from "./aggregate.ts";
export { sqlId, compileSql, tokenize as tokenizeSql, type SqlReader, type SqlTag, type SqlIdentifier, type CompiledSql } from "./sqlQuery.ts";
export { checkReadOnlySql, planTree, ALLOWED_PRAGMA_FUNCTIONS, SQL_ROWS_DEFAULT, SQL_ROWS_MAX, SQL_TEXT_MAX, SQL_PARAMS_MAX, type ReadOnlySqlCheck, type SqlPlanNode } from "./sql-readonly.ts";
export { evalExpr, filterBuilder } from "./filter.ts";
export { compileSchema, createTableDdl, indexFields, docKey, indexKey, isSparseIndex, dbIndexesOf, CREATION_INDEX, SYSTEM_DDL } from "./ddl.ts";
export { layoutOf, keyColumn, encodeFields, decodeRow, fieldOf, MAX_USER_COLUMNS, type Layout } from "./layout.ts";
export {
  introspect,
  planMigration,
  applyMigration,
  backfillStep,
  stagedIndexes,
  shapeAccepts,
  type MigrationPlan,
  type MigrationReport,
  type MigrationStep,
  type BackfillProgress,
} from "./migrate.ts";
export { makeId, parseId, ulid, seededRandom } from "./ids.ts";
export { convexTableNumber, isConvexId, isForeignId, makeConvexId, foreignTableOf, parseForeignIds, mergeForeignIds, FOREIGN_IDS_META, type ForeignIds } from "./foreignIds.ts";
export { Importer, checkImportDoc, DocSetHash, docDigest, storageDigestDoc, type ImportBatchResult, type ImportInvalid, type ImportFileRow, type ImportFinishResult, type ImportHashPage, type ImportExportPage, type ImportMeta } from "./importer.ts";
export { defineImport, isImportConfig, type ImportConfig, type ImportDoc } from "./importConfig.ts";
export { classicTables, CLASSIC_TABLES_META } from "./migrate.ts";
export { preflightMigration, manifestProblem, unknownIndexKinds, type PreflightResult, type PreflightStep } from "./preflight.ts";
export { sha256, sha256Hex } from "./sha256.ts";
export * from "./engine.ts";
export * from "./scheduled.ts";
export * from "./limits.ts";
export {
  runLocalQuery,
  localSchema,
  localQueryRegistry,
  assertLocalQuery,
  localTableOfId,
  localIds,
  documentsIn,
  prepareLocalDatabase,
  wipeLocalDatabase,
  sqlLocalReader,
  sqlReplicaWriter,
  jsSearch,
  localReadSetMatches,
  OFFLINE_UNSUPPORTED,
  type LocalRowChange,
  type LocalReader,
  type LocalSchema,
  type LocalQueryOptions,
} from "./local.ts";
export { runLocalMutation, overlayReader, assertLocalMutation, type OverlayReader, type LocalMutationOptions } from "./local-mutation.ts";
export { createEngine as default } from "./engine.ts";
export { v, paginationOptsValidator, paginationResultValidator, unsafeRef } from "@freecorps/ember-values";
export type { ObjectValidator, PaginationOptions as PaginationOpts } from "@freecorps/ember-values";
export type { Infer, GenericId, FileId } from "@freecorps/ember-values";
export * from "./files.ts";
export type * from "./actionFiles.ts";
export type * from "./actionBrowser.ts";
export {
  presignUrl,
  signRequest,
  hmacSha256,
  sha256HexOf,
  uriEncode,
  encodeKeyPath,
  amzDate,
  base64 as base64Bytes,
  hexToBytes,
  hex as toHex,
  UNSIGNED_PAYLOAD,
  EMPTY_SHA256,
  type SigV4Credentials,
  type SignInput,
} from "./sigv4.ts";
export * from "./replica.ts";
export * from "./cron-expr.ts";
