/**
 * The engine contract the runtime codes against (docs/design/contracts.md), re-exported from `@ember/server`.
 * Type-only: the runtime's value import of `createEngine` lives in config.ts.
 */
import type { CreateEngineOptions, Engine, SchemaDefinition } from "@ember/server";

export type {
  AuthCtx,
  BackfillProgress,
  CreateEngineOptions,
  Doc,
  Engine,
  FunctionInfo,
  Identity,
  Job,
  MigrationReport,
  MutationBatchItem,
  MutationBatchResult,
  MutationResult,
  QueryResult,
  ReadSet,
  ReadSetEntry,
  RowChange,
  SchemaManifest,
  SqlDriver,
  SqlResult,
  SqlResult as SqlExecResult,
  SqlRow,
  SqlValue,
} from "@ember/server";

export type CreateEngine = (opts: CreateEngineOptions) => Engine;

/** What the runtime needs from `defineSchema(...)`. */
export type SchemaLike = SchemaDefinition<any, any>;
