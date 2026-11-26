/**
 * `@freecorps/ember-audit`: a transactional audit log as an Ember component (PLAN §12).
 *
 *   // ember/ember.config.ts
 *   export default defineApp().use(audit, { config: { retainDays: 90 } });
 *
 *   // ember/triggers.ts: one audit row per write of these tables, in the same transaction
 *   export default defineTriggers({
 *     ...auditTriggers(components.audit, { tables: { users: { redact: ["passwordHash"], ignore: ["lastSeenAt"] }, invoices: true } }),
 *   });
 *
 *   // anywhere in a mutation (synchronous, same transaction) or an action
 *   const log = new Audit(components.audit);
 *   log.log(ctx, { action: "invoice.sent", target: invoiceId, data: { to } });
 *
 * Rows live in the shard of the mutation that wrote them. A daily cron moves rows older than `retainDays` to R2 as
 * gzip NDJSON, in idempotent batches.
 */
import type { FunctionReference, PaginationResult } from "@freecorps/ember-server";
import type { AuditEntry, AuditOp } from "./component.ts";
import { gunzipNdjson, type R2BucketLike } from "./archive.ts";
import { auditDiff, type DiffOptions } from "./diff.ts";

export {
  audit,
  functions as auditFunctions,
  dashboardFunctions as auditDashboardFunctions,
  installConfigValidator,
  DEFAULT_BATCH_SIZE,
  DEFAULT_BUCKET,
  DEFAULT_RETAIN_DAYS,
  MAX_BATCH_SIZE,
  SYSTEM_ACTOR,
  type ArchiveRunResult,
  type AuditEntry,
  type AuditInstallConfig,
  type AuditOp,
} from "./component.ts";
export { auditDiff, capDiff, DEFAULT_MAX_DIFF_BYTES, MAX_DIFF_BYTES, REDACTED, TRUNCATED, type Diff, type DiffOptions, type DiffResult, type FieldChange } from "./diff.ts";
export { archiveKey, gunzipNdjson, gzipNdjson, ndjsonStream, type R2BucketLike } from "./archive.ts";

type RecordArgs = { table: string; docId: string; op: "insert" | "update" | "delete"; diff: unknown; truncated?: boolean; omitted?: number };
type LogArgs = { action: string; target?: string; data?: unknown; actor?: string };
export type ListOptions = { table?: string; docId?: string; actor?: string; op?: AuditOp; from?: number; to?: number; paginationOpts: { numItems: number; cursor: string | null } };
export type ArchiveObject = { key: string; size: number; uploaded: number; count: number; firstAt: number; lastAt: number };

/** What `components.<name>` of the audit component looks like (structural: any install name works). */
export interface AuditComponentApi {
  lib: {
    record: FunctionReference<"mutation", "public", RecordArgs, string>;
    log: FunctionReference<"mutation", "public", LogArgs, string>;
    list: FunctionReference<"query", "public", ListOptions, PaginationResult<AuditEntry>>;
    get: FunctionReference<"query", "public", { id: string }, AuditEntry | null>;
    archives: FunctionReference<"action", "public", { cursor?: string; limit?: number }, { objects: ArchiveObject[]; cursor: string | null }>;
  };
}

type MutationRef = FunctionReference<"mutation", "public">;
type QueryRef = FunctionReference<"query", "public">;
type ActionRef = FunctionReference<"action", "public">;
// Method syntax: any ctx's typed `runQuery`/`runMutation` fits (parameters are compared bivariantly).
/** A mutation's ctx (also a trigger's): calls run in its transaction and return values. */
export interface SyncWriteCtx {
  /** What tells it from an action's ctx (no `db`, and its `runMutation` returns a Promise, which `unknown` also takes). */
  db: object;
  runMutation(fn: MutationRef, args: Record<string, unknown>): unknown;
}
/** A query's (or mutation's) ctx. */
export interface SyncReadCtx {
  db: object;
  runQuery(fn: QueryRef, args: Record<string, unknown>): unknown;
}
/** An action's ctx: each call is its own transaction. */
export interface AsyncCtx {
  runQuery(fn: QueryRef, args: Record<string, unknown>): Promise<unknown>;
  runMutation(fn: MutationRef, args: Record<string, unknown>): Promise<unknown>;
  runAction(fn: ActionRef, args: Record<string, unknown>): Promise<unknown>;
}

/** How one table is audited (`true`: every field, every operation). */
export type TableAudit = true | (Omit<DiffOptions, "maxBytes"> & { ops?: ReadonlyArray<"insert" | "update" | "delete"> });

export interface AuditTriggersOptions<T extends string> {
  tables: Record<T, TableAudit>;
  /** Byte cap of each row's diff (default 4096, at most 64 KiB). */
  maxDiffBytes?: number;
}

/** The change a trigger gets (structural: `Change<Doc<"t">>` of `defineTriggers` fits). */
export type AuditChange =
  | { id: unknown; operation: "insert"; oldDoc: null; newDoc: object }
  | { id: unknown; operation: "update"; oldDoc: object; newDoc: object }
  | { id: unknown; operation: "delete"; oldDoc: object; newDoc: null };
export type AuditTrigger = (ctx: SyncWriteCtx, change: AuditChange) => void;

/**
 * Triggers for `defineTriggers` that write one audit row per write of each listed table, in the mutation's
 * transaction (a mutation that fails leaves none). Updates that change no audited field write nothing. To keep other
 * triggers on the same table, list both: `users: [auditTrigger, myTrigger]` (`auditTriggers(...).users`).
 */
export function auditTriggers<const T extends string>(component: AuditComponentApi, o: AuditTriggersOptions<T>): { [K in T]: AuditTrigger } {
  const out = {} as { [K in T]: AuditTrigger };
  for (const table of Object.keys(o.tables) as T[]) {
    const spec = o.tables[table];
    const opts: DiffOptions & { ops?: ReadonlyArray<string> } = spec === true ? {} : spec;
    const diffOpts: DiffOptions = { ...(opts.fields ? { fields: opts.fields } : {}), ...(opts.ignore ? { ignore: opts.ignore } : {}), ...(opts.redact ? { redact: opts.redact } : {}), ...(o.maxDiffBytes !== undefined ? { maxBytes: o.maxDiffBytes } : {}) };
    out[table] = (ctx, change) => {
      if (opts.ops && !opts.ops.includes(change.operation)) return;
      const d = auditDiff(change.oldDoc as Record<string, unknown> | null, change.newDoc as Record<string, unknown> | null, diffOpts);
      if (!d) return;
      const args: RecordArgs = { table, docId: String(change.id), op: change.operation, diff: d.diff, ...(d.truncated ? { truncated: true } : {}), ...(d.omitted ? { omitted: d.omitted } : {}) };
      ctx.runMutation(component.lib.record, args);
    };
  }
  return out;
}

export type LogEntry = { action: string; target?: string; data?: unknown; actor?: string };

/** Typed helper over an installed audit component. */
export class Audit {
  constructor(readonly component: AuditComponentApi) {}

  /** `auditTriggers(this.component, o)`. */
  triggers<const T extends string>(o: AuditTriggersOptions<T>): { [K in T]: AuditTrigger } {
    return auditTriggers(this.component, o);
  }

  /** An app-level event. In a mutation: synchronous, in its transaction. In an action: its own transaction. */
  log(ctx: SyncWriteCtx, e: LogEntry): string;
  log(ctx: AsyncCtx, e: LogEntry): Promise<string>;
  log(ctx: SyncWriteCtx | AsyncCtx, e: LogEntry): string | Promise<string> {
    const args: LogArgs = { action: e.action, ...(e.target !== undefined ? { target: e.target } : {}), ...(e.data !== undefined ? { data: e.data } : {}), ...(e.actor !== undefined ? { actor: e.actor } : {}) };
    return ctx.runMutation(this.component.lib.log, args) as string | Promise<string>;
  }

  /** Rows of this shard, newest first (reactive inside queries). */
  list(ctx: SyncReadCtx, o: ListOptions): PaginationResult<AuditEntry>;
  list(ctx: AsyncCtx, o: ListOptions): Promise<PaginationResult<AuditEntry>>;
  list(ctx: SyncReadCtx | AsyncCtx, o: ListOptions): PaginationResult<AuditEntry> | Promise<PaginationResult<AuditEntry>> {
    return ctx.runQuery(this.component.lib.list, o) as PaginationResult<AuditEntry>;
  }

  /** The archive objects in R2 (an action). */
  archives(ctx: AsyncCtx, o: { cursor?: string; limit?: number } = {}): Promise<{ objects: ArchiveObject[]; cursor: string | null }> {
    return ctx.runAction(this.component.lib.archives, o) as Promise<{ objects: ArchiveObject[]; cursor: string | null }>;
  }
}

/** Reads one archive object from the bucket (an app action that checks who may read it): its rows. */
export async function readArchive(bucket: Pick<R2BucketLike, "get">, key: string): Promise<AuditEntry[] | null> {
  const obj = await bucket.get(key);
  if (!obj) return null;
  return (await gunzipNdjson(await obj.arrayBuffer())) as AuditEntry[];
}
