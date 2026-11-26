import { DurableObject } from "cloudflare:workers";
import { ColoCache } from "./colo.ts";
import { claimKey, encodeParts, rowDiffJson, valueDiffJson, type EncodedValue } from "@freecorps/ember-values";
import {
  createMatchIndex,
  errorInfo,
  kindReceivesReplicated,
  replicatedTargets,
  replicatedWriteAdvice,
  REPLICATED_SOURCE,
  shardKindOf,
  type ReplicaApplyResult,
  newQueryProfile,
  type QueryProfile,
  externalIndexes,
  FILES_DDL,
  FileStore,
  makeId,
  matchesFilter,
  outboxAck,
  outboxClaim,
  outboxDefer,
  outboxFetch,
  outboxForget,
  outboxNextAt,
  outboxStats,
  type FetchedItem,
  type FileRow,
  type ForeignIds,
  type ImportBatchResult,
  type ImportFileRow,
  type ImportFinishResult,
  type ImportHashPage,
  type ImportExportPage,
  type ImportMeta,
  type FileStoreOptions,
  type GetUrlOptions,
  type IndexSpec,
  type MatchIndex,
  type MetadataValue,
  type OutboxStats,
  type UploadOptions,
  type UploadTicket,
  type Usage,
  type WireError,
  type ListScheduledOptions,
  type ScheduledFunction,
  type ScheduledFunctionStateKind,
  EmberError,
  JOBS_TABLE,
  LIST_SCHEDULED_DEFAULT,
  LIST_SCHEDULED_MAX,
  limitWarnings,
  NestedQueryMemo,
  preflightMigration,
  usageFractions,
} from "@freecorps/ember-server";
import type { ShardPreflight } from "./admin-api.ts";
import { runReadOnlySql, type SqlQueryInput, type SqlQueryOutcome } from "./admin-sql.ts";
import {
  deliverIndexBatch,
  INDEXING_QUEUE_BINDING,
  LOCAL_DDL,
  localSearch,
  type ExternalIndexRpc,
  type IndexMessage,
  type LocalHit,
  type LocalOp,
  type LocalSearch,
} from "./ai-indexes.ts";
import { ActionRunner, ephemeralJobs, actionDispatch, type ShardApi } from "./actions.ts";
import {
  ANON,
  DEFAULT_CREATE_ENGINE,
  compactFormatOf,
  SYSTEM,
  getEmberConfig,
  identityKey,
  indexEnv,
  type ActionJobMessage,
  type EmberConfig,
  type EmberEnv,
} from "./config.ts";
import type { AuthCtx, Engine, Identity, Job, MutationBatchItem, ReadSet, RowChange } from "./engine-types.ts";
import {
  decodeClientFrame,
  encodeServerMessage,
  MAX_BATCH_MESSAGES,
  ProtocolError,
  type ClientMessage,
  type Id,
  type ServerMessage,
} from "./protocol.ts";
import { bucketOf, fileSignerFromEnv, type FileResult, type FileRpc } from "./files.ts";
import { DoSqlDriver, type SqlCounters } from "./sql-driver.ts";
import { shardStub, systemStub } from "./stubs.ts";
import { browse, BROWSABLE_INTERNAL, type BrowseResult } from "./admin.ts";
import {
  broadcastStatus,
  drainBroadcast,
  ensureBroadcastTables,
  listDirectory,
  logReplicated,
  nextBroadcastAt,
  registerShard as registerInDirectory,
  replicatedSet,
  resyncAllTargets,
  resyncTarget,
  syncBroadcastTargets,
} from "./replicated.ts";
import { REPLICA_APPLY_FN } from "./replication.ts";
import { catalogDue, metricsEnabled, recordExecution, reportShard, sampleExecution, share, usageMetrics, type CallMetrics, type ExecutionKind, type Timing } from "./metrics.ts";
import { parse, stableStringify, stringify } from "./wire.ts";
import { deflateFrame, ZFRAME_MIN_CHARS, zframeSupported } from "./zframe.ts";
import { EphemeralChannels, memberId, type EphemeralAttachment } from "./ephemeral.ts";
import { queryAdvice, ReactivityLog, reactivityReport, returnedOf, type ProfileResult, type ReactivityReport } from "./reactivity.ts";
import { AHEAD_MARKER_KEY, aheadFinishDecision, isAheadMarker, type AheadMarker, type BookmarkRow, type RestoreFinishInfo, type RestoreOutcome, type RestorePrepared, type RestoreRpc } from "./restore.ts";

/** Id of the running Worker version (`version_metadata` binding EMBER_VERSION, set by `ember deploy`). */
function deployVersionId(env: EmberEnv): string | null {
  const v = env.EMBER_VERSION as { id?: unknown } | undefined;
  return v && typeof v.id === "string" && v.id ? v.id : null;
}

const HOUR = 3_600_000;
/**
 * A refused shard (`refused`: a refused migration, or `RuntimeSchemaTooNew`) re-arms the alarm that woke it at least
 * this far ahead, without running anything (see `alarm`): once a fixed deploy serves the shard, the next turn runs.
 */
const REFUSED_ALARM_MS = 5 * 60_000;
const DAY = 24 * HOUR;
export const DEDUP_RETENTION_MS = 7 * DAY;
export const MAX_ALARM_AHEAD_MS = 30 * DAY;
const BOOKMARK_RETENTION_MS = 30 * DAY;
const MAX_JOBS_PER_ALARM = 500;
/** Default lease of an action job handed to the Queue (`scheduler.actionLeaseMs`). */
const ACTION_LEASE_MS = 5 * 60_000;
/** The shortest lease (`action({ leaseMs })` is checked against the same floor). */
const MIN_ACTION_LEASE_MS = 1000;
/**
 * Job states the alarm picks up when due: waiting to run (`pending`), or handed to the Queue / claimed past their
 * lease (`dispatched`, `claimed`).
 * The `_jobs_due (state, run_at)` index answers one state at a time in order: `state IN (…) ORDER BY run_at` sorts
 * every due row (per pick: O(N²) over an alarm turn). These ask each state for its first row and keep the earliest.
 */
const NEXT_JOB_AT_SQL = `SELECT MIN(m) AS m FROM (${["pending", "dispatched", "claimed", "running"].map((st) => `SELECT MIN(run_at) AS m FROM _jobs WHERE state = '${st}'`).join(" UNION ALL ")})`;
const nextDueJobsSql = (limit: string) =>
  `SELECT * FROM (${["pending", "dispatched", "claimed"].map((st) => `SELECT * FROM (SELECT * FROM _jobs WHERE state = '${st}' AND run_at <= ?1 ORDER BY run_at, id LIMIT ${limit})`).join(" UNION ALL ")}) ORDER BY run_at, id LIMIT ${limit}`;
const NEXT_DUE_JOB_SQL = nextDueJobsSql("1");
/** The next due jobs in order (binds: now, limit): a run of mutation jobs commits together, action jobs are sent together. */
const NEXT_DUE_JOBS_SQL = nextDueJobsSql("?2");
/** Thrown inside `runMutationJobs`' transaction to undo a batch and commit only its first `size` jobs. */
class BatchCut extends Error {
  constructor(readonly size: number) {
    super("batch cut");
  }
}
/** Due mutation jobs run in one transaction (one change-log row, one publish), at most this many. */
const MUTATION_JOB_GROUP = 50;
/** Due action jobs handed to the Queue per `sendBatch` (the Queues limit). */
const ACTION_JOB_GROUP = 100;
/** A decoded value holds a `bigint` (an int64) somewhere. */
function holdsBigint(v: unknown): boolean {
  if (typeof v === "bigint") return true;
  if (v === null || typeof v !== "object" || ArrayBuffer.isView(v) || v instanceof ArrayBuffer) return false;
  for (const x of Array.isArray(v) ? v : Object.values(v)) if (holdsBigint(x)) return true;
  return false;
}
/**
 * A Queue message's args: as a value (what older consumers read), or, when they hold an int64 (a `bigint`, which the
 * Queue's JSON content type cannot carry), as the stored wire text in `argsJson`. The text is only walked when it
 * mentions the int64 tag at all.
 */
function queueArgs(job: Record<string, unknown>): { args?: unknown; argsJson?: string } {
  const text = job.args as string;
  const args = parse(text);
  return text.includes('"$int64"') && holdsBigint(args) ? { argsJson: text } : { args };
}
/** `sendBatch`'s total size limit (256 KB), with room to spare, and what each message adds besides its args and fn. */
const SEND_BATCH_BYTES = 240_000;
const SEND_MESSAGE_BYTES = 120_000;
const SEND_BATCH_OVERHEAD = 128;
const UTF8 = new TextEncoder();
/** Job states a job ends in: kept `scheduler.retainMs` (7 days by default) for `ctx.scheduler.get`, then deleted. */
const TERMINAL_STATES = "('success', 'failed', 'canceled')";
export const JOB_RETENTION_MS = 7 * DAY;
/** Finished jobs deleted per maintenance turn, in chunks of `JOB_GC_CHUNK`. */
const JOB_GC_CHUNK = 1000;
const JOB_GC_MAX = 20_000;
/**
 * An action job running in this shard is given back (`pending`) if it is still `running` this long after it started:
 * the object died mid-run. Its `run_at` is set to that moment so the alarm is armed for it.
 */
const RUNNING_RECOVERY_MS = 5 * 60_000;
const MAX_ATTACHMENT_BYTES = 16_000;
export const DEFAULT_SEARCH_DEBOUNCE_MS = 2_000;
/** External-index outbox: re-send unacknowledged rows after this long (queue / in-process delivery). */
const OUTBOX_RESEND_QUEUE_MS = 10 * 60_000;
const OUTBOX_RESEND_LOCAL_MS = 15_000;

/** Minimal Queue producer surface for the indexing queue. */
interface IndexQueue {
  sendBatch(messages: Array<{ body: IndexMessage }>): Promise<unknown>;
}
/** Bumped when RUNTIME_DDL needs an upgrade step for shards created by an older runtime. */
const RUNTIME_SCHEMA = 5;

/**
 * `_ember_rt_meta.rt_schema` as stored, read without creating anything. Null: no marker (a new shard, one created
 * before the runtime tables were versioned, or a blank value, which no runtime writes): upgraded from 0 as before.
 */
export function storedRuntimeSchema(sql: SqlStorage): string | null {
  const v = storedMeta(sql, "rt_schema");
  return v === null || v.trim() === "" ? null : v;
}

/** `_ember_rt_meta.<k>` read without creating anything (null: no table or no row). */
function storedMeta(sql: SqlStorage, k: string): string | null {
  return allStoredMeta(sql)?.get(k) ?? null;
}

/**
 * Every `_ember_rt_meta` row in one read, without creating anything (null: no table yet). `counted`: the driver whose
 * counters take the read (it runs on the raw storage, before the driver may touch anything).
 */
function allStoredMeta(sql: SqlStorage, counted?: { counters: { select: number[] } }): Map<string, string> | null {
  let rows: Array<Record<string, SqlStorageValue>>;
  if (counted) counted.counters.select[0]!++;
  try {
    rows = sql.exec("SELECT k, v FROM _ember_rt_meta").toArray();
  } catch (e) {
    if (/no such table/i.test(String((e as Error | null)?.message ?? e))) return null;
    throw e;
  }
  const m = new Map<string, string>();
  for (const r of rows) if (r.v !== null && r.v !== undefined) m.set(String(r.k), String(r.v));
  return m;
}

/**
 * The runtime tables were written by a newer runtime: a version greater than RUNTIME_SCHEMA, or one that is not a
 * number (no runtime writes that, so this one cannot know what the tables hold: refuse rather than guess). Compared as
 * numbers, like the storage marker (engine.ts `storageAhead`).
 */
export function runtimeSchemaAhead(stored: string | null): boolean {
  if (stored === null) return false;
  const n = /^\d+$/.test(stored) ? Number(stored) : NaN;
  return !(n <= RUNTIME_SCHEMA);
}

function runtimeSchemaTooNew(stored: string): EmberError {
  return new EmberError(
    "RuntimeSchemaTooNew",
    `This shard's runtime tables were written by a newer Ember runtime (runtime schema ${stored}; this runtime understands up to ${RUNTIME_SCHEMA}). ` +
      `Nothing was changed and the shard is read-only: deploy the newer runtime again (nothing is lost), or restore it from this ` +
      `runtime to a bookmark taken before the newer runtime first ran here (ember restore --to deploy:<version that brought the ` +
      `newer runtime> --discard-newer), which loses what was written since (the undo bookmark brings it back).`,
    { stored, supported: String(RUNTIME_SCHEMA) },
  );
}

/**
 * `dedup_key` is unique through a partial index (`_jobs_dedup`, NOT NULL keys only): most jobs have no key, and a
 * plain UNIQUE column would write an index entry for their NULL too (one billed row per job).
 */
const JOBS_COLUMNS = `
  id INTEGER PRIMARY KEY, run_at INTEGER NOT NULL, fn TEXT NOT NULL, args TEXT NOT NULL,
  kind TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL, last_error TEXT, dedup_key TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, job_id TEXT, scheduled_at INTEGER`;
const JOBS_COPY = "id, run_at, fn, args, kind, state, attempts, max_attempts, last_error, dedup_key, created_at, updated_at, job_id";

/**
 * Mutation dedup (client retries, auth outbox keys) lives in generation tables `_ember_dedup_<n>` (n ≥ 1; the
 * legacy `_ember_dedup` is generation 0). Writes go to the newest; lookups check the newest two. Maintenance
 * starts a new generation once the newest is DEDUP_RETENTION_MS old and drops the one before it: an outcome is
 * kept between 1× and 2× the retention, and expiring it costs no row writes (DROP TABLE is free; a per-row
 * DELETE and the `at` index it needed were 2 of the ~8 rows a WebSocket insert wrote).
 */
export const dedupTable = (n: number): string => (n === 0 ? "_ember_dedup" : `_ember_dedup_${n}`);
const dedupDdl = (name: string) =>
  `CREATE TABLE IF NOT EXISTS ${name} (identity TEXT NOT NULL, client_id TEXT NOT NULL, mid TEXT NOT NULL, at INTEGER NOT NULL, result TEXT NOT NULL, PRIMARY KEY (identity, client_id, mid)) STRICT, WITHOUT ROWID`;

/** Change-log ring size (`changeLogVersions`, at least 1: the newest entry also carries the shard's version). */
const ringSize = (cfg: EmberConfig): number => Math.max(1, Math.floor(cfg.changeLogVersions ?? 256));

/** Default `changeLogEntryMaxBytes`: the largest `changes` a change-log row holds (UTF-8 bytes of its JSON). */
export const CHANGE_LOG_ENTRY_MAX_BYTES = 128 * 1024;
/**
 * The `changes` of a version whose changes did not fit (`changeLogEntryMaxBytes`): JSON `null`. A resume that needs
 * that version answers with a full snapshot (`changesSince` → null), as for a version the ring no longer holds.
 *
 * Rollback: runtimes before the ceiling parse every row of a resume's range as an array. So the version also gets a
 * second row, out of the ring (`slot = -version`, `oversizedSlot`): their `changesSince` then counts one row more than
 * versions in any range that holds it, the check they already make for a ring that lost a version, and answers with a
 * snapshot before parsing anything. The extra row goes once the ring slot of its version is reused (`dropOversized`);
 * until then it is outside every range a resume can ask for once that version is out of the ring.
 */
const OVERSIZED_CHANGES = "null";
const oversizedSlot = (version: number): number => -version;
const entryCap = (cfg: EmberConfig): number => {
  const c = cfg.changeLogEntryMaxBytes;
  return c !== undefined && Number.isFinite(c) && c >= 0 ? Math.floor(c) : CHANGE_LOG_ENTRY_MAX_BYTES;
};
/** Whether `text` (JSON) is more than `cap` UTF-8 bytes: from its length alone unless it may be either (1–3 bytes a unit). */
const overCap = (text: string, cap: number): boolean => text.length > cap || (text.length * 3 > cap && UTF8.encode(text).byteLength > cap);

const RUNTIME_DDL = `
CREATE TABLE IF NOT EXISTS _ember_rt_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS _ember_subs (
  sock TEXT NOT NULL, qid TEXT NOT NULL, fn TEXT NOT NULL, args TEXT NOT NULL,
  PRIMARY KEY (sock, qid)
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS _ember_changes (
  slot INTEGER PRIMARY KEY, version INTEGER NOT NULL, at INTEGER NOT NULL, changes TEXT NOT NULL, dedup TEXT, acks TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS _jobs (${JOBS_COLUMNS}) STRICT;
CREATE INDEX IF NOT EXISTS _jobs_due ON _jobs(state, run_at);
CREATE TABLE IF NOT EXISTS _ember_revoked (k TEXT PRIMARY KEY, at INTEGER NOT NULL, until INTEGER NOT NULL) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS _ember_sub_ident (
  client_id TEXT NOT NULL, qid TEXT NOT NULL, identity TEXT NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (client_id, qid)
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS _ember_bookmarks (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, bookmark TEXT NOT NULL, reason TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS _ember_migrations (
  id INTEGER PRIMARY KEY, at INTEGER NOT NULL, from_version TEXT, to_version TEXT NOT NULL,
  ok INTEGER NOT NULL, code TEXT, message TEXT
) STRICT;
`;

/** Upgrades for shards whose runtime tables predate a column (CREATE IF NOT EXISTS does not add columns). */
function upgradeRuntimeTables(sql: SqlStorage, from: number, ring: number): void {
  if (from < 2) {
    try {
      sql.exec("ALTER TABLE _jobs ADD COLUMN job_id TEXT");
    } catch {
      // fresh shard: the column is already in RUNTIME_DDL
    }
  }
  if (from < 3) {
    // v3: `_jobs.dedup_key` unique only when set (partial index), change log as a ring of slots (one upsert per
    // commit instead of insert + trim delete + version meta).
    const jobs = sql.exec<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = '_jobs'").toArray()[0]?.sql ?? "";
    if (/dedup_key\s+TEXT\s+UNIQUE/i.test(jobs)) {
      sql.exec(`CREATE TABLE _jobs_v3 (${JOBS_COLUMNS}) STRICT`);
      sql.exec(`INSERT INTO _jobs_v3 (${JOBS_COPY}) SELECT ${JOBS_COPY} FROM _jobs`);
      sql.exec("DROP TABLE _jobs");
      sql.exec("ALTER TABLE _jobs_v3 RENAME TO _jobs");
      sql.exec("CREATE INDEX IF NOT EXISTS _jobs_due ON _jobs(state, run_at)");
    }
    const old = sql.exec("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = '_ember_changelog'").toArray().length > 0;
    if (old) {
      sql.exec(
        "INSERT OR REPLACE INTO _ember_changes(slot, version, at, changes) SELECT version % ?, version, at, changes FROM _ember_changelog WHERE version > (SELECT MAX(version) FROM _ember_changelog) - ? ORDER BY version",
        ring, ring,
      );
      sql.exec("DROP TABLE _ember_changelog");
    }
  }
  if (from < 4) {
    // v4: mutation outcomes ride in the change-log row of their commit (`dedup`), with the client's acks (`acks`).
    for (const col of ["dedup", "acks"]) {
      try {
        sql.exec(`ALTER TABLE _ember_changes ADD COLUMN ${col} TEXT`);
      } catch {
        // fresh shard: the column is already in RUNTIME_DDL
      }
    }
  }
  if (from < 5) {
    // v5: `scheduled_at` (the time the job was scheduled for: `run_at` moves with leases, retries and, once the job
    // ends, to its completion time). NULL on older rows: their `run_at` stands in.
    try {
      sql.exec("ALTER TABLE _jobs ADD COLUMN scheduled_at INTEGER");
    } catch {
      // fresh shard (or rebuilt by v3): the column is already in JOBS_COLUMNS
    }
  }
  sql.exec("CREATE UNIQUE INDEX IF NOT EXISTS _jobs_job_id ON _jobs(job_id)");
  sql.exec("CREATE UNIQUE INDEX IF NOT EXISTS _jobs_dedup ON _jobs(dedup_key) WHERE dedup_key IS NOT NULL");
}

/** `ctx.scheduler` state kinds → `_jobs.state` values. */
const JOB_STATES_OF: Record<ScheduledFunctionStateKind, string[]> = {
  pending: ["pending", "dispatched"],
  inProgress: ["claimed", "running"],
  success: ["success"],
  failed: ["failed"],
  canceled: ["canceled"],
};

/** Per-isolate cache: DO id -> schema version already verified in this isolate. */
const verifiedInIsolate = new Map<string, string>();

/** A batch frame to a client stays well under the 1 MiB WebSocket message limit (UTF-16 units: ≤ 768 KiB of UTF-8). */
const MAX_BATCH_BYTES = 256 * 1024;
/**
 * Mutations per group-committed transaction. With batch frames a hot shard fills 100 per commit in production; 500 gave
 * +29% throughput and a lower ack p50 there (docs/spikes/remote/perf-remote.md §4).
 */
const DEFAULT_MAX_BATCH = 500;
/** Dormant subscriptions run per turn after a wake (see `Shard.dormant`). */

export interface Attachment {
  sid: string;
  identity: Identity | null;
  clientId: string | null;
  hello: boolean;
  /**
   * The bearer token the identity came from: kept so `sensitive` mutations can re-check the session in the Auth DO
   * (PLAN §9). Never sent anywhere else.
   */
  token?: string;
  /** The client negotiated `features: ["rowdiff"]` (protocol v1.1): patches may carry per-row diffs. */
  rowdiff?: true;
  /** The client negotiated `features: ["vdiff"]`: patches of objects holding arrays of documents may carry value diffs. */
  vdiff?: true;
  /**
   * The client negotiated `features: ["ident"]`: snapshots carry an identity tag (`ik`) the client echoes in
   * `resume`, instead of the shard recording each snapshot's identity in `_ember_sub_ident` (one row per snap).
   */
  ident?: true;
  /**
   * This socket's subscriptions `[qidKey, fn, argsJson]`, for hibernation wake-up: the attachment survives
   * hibernation and costs no row writes. Subscriptions that do not fit in MAX_ATTACHMENT_BYTES go to `_ember_subs`.
   */
  subs?: Array<[string, string, string]>;
  /**
   * Mids (qidKey) the client acknowledged (feature "ack") since the shard's last change-log row: they survive a
   * hibernation here, and the next commit writes them into its ring row (then they are cleared).
   */
  acks?: string[];
  /** The client negotiated `features: ["batch"]`: frames to it may be JSON arrays of messages. */
  batch?: true;
  /** The client negotiated `features: ["zframe"]`: frames to it above ZFRAME_MIN_CHARS go compressed (binary). */
  zframe?: true;
  /** The client negotiated `features: ["rum"]` (a sampled RUM session): it gets this object's colo (`ready`, `colo`). */
  rum?: true;
  /**
   * The client negotiated `features: ["ack"]`: it acknowledges settled outcomes, so the effect-free ones need not stay
   * in the dedup generations (`Pending.acks`). Missing (a client without it, or a socket from an older runtime): they
   * do, as before.
   */
  ack?: true;
  /**
   * The client negotiated `features: ["ephemeral"]`: its member id and the channels it is in, with its member state
   * (ephemeral.ts). Rebuilt into the shard's rooms on wake; no row.
   */
  eph?: EphemeralAttachment;
}

/** Options of the `mutation` RPC. */
export interface MutationCallOptions {
  /** Exactly-once effect across retries (auth outbox): a key seen before returns the stored outcome. */
  dedupKey?: string;
  /**
   * The caller records the metrics point itself (wall time around this RPC, `timing: "rpc"`): the shard writes
   * none and returns the row counts in `outcome.metrics`.
   */
  caller?: boolean;
  /** An internal call made by a system run (a scheduled action, a component hook) without identity: no claim check. */
  system?: boolean;
}

/** The AuthCtx of an RPC call: a system run's internal calls without identity skip the `fromAuth` claim check. */
const callerCtx = (identity: Identity | null, system: boolean): AuthCtx => (identity === null && system ? SYSTEM : { identity });

export type MutationOutcome = (
  /**
   * Queries also carry `epoch` and `ik` (the identity tag of feature "ident", for the caller's identity): a client
   * that got its first value over HTTP subscribes with `resume { version, epoch, ik }` and gets `unchanged`.
   */
  | { ok: true; value: unknown; version: number; epoch?: string; ik?: string }
  /**
   * A query called with `resume` (the version, epoch and identity tag of a value the caller holds) that is still
   * current: no value, the caller keeps its own (`POST /api/query` with `resume`; contracts.md "HTTP-first").
   */
  | { ok: true; unchanged: true; version: number; epoch: string; ik: string; value?: undefined }
  | { ok: false; error: WireError }
) & {
  /** With `{ caller: true }`: rows and result size of this execution, for the caller's metrics point. */
  metrics?: CallMetrics;
};

export interface JobInput {
  /** The id `scheduler.runAfter/runAt` returned (engine or action scheduler). Generated when omitted. */
  jobId?: string;
  fn: string;
  args?: unknown;
  kind?: "mutation" | "action";
  runAt?: number;
  dedupKey?: string;
  maxAttempts?: number;
}

export interface JobRow {
  id: number;
  job_id: string | null;
  run_at: number;
  fn: string;
  kind: string;
  state: string;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  dedup_key: string | null;
}

export interface MigrationErrorInfo {
  at: number;
  fromVersion: string | null;
  toVersion: string;
  code: string;
  message: string;
}

/** `GET /api/_ember/status` (one entry per shard). */
export interface ShardStatus {
  shard: string;
  /** Schema version the code expects (this deploy). */
  expectedVersion: string;
  /** Schema version stored in the shard (null = never migrated). */
  schemaVersion: string | null;
  /** The stored version is the expected one and no index is still backfilling. */
  ready: boolean;
  /** Staged indexes still backfilling: rows `(cursor, until]` remain. */
  staged: Array<{ table: string; index: string; kind: string; cursor: number; until: number }>;
  /** Set while the latest migration attempt to `expectedVersion` was refused; requests fail until a fixed deploy. */
  migrationError: MigrationErrorInfo | null;
  /** Last recorded migration error, any version (history). */
  lastMigrationError: MigrationErrorInfo | null;
  version: number;
  databaseSize: number;
}

export interface ShardInspection {
  version: number;
  epoch: string;
  shard: string | null;
  stats: {
    batches: number;
    batchSizes: number[];
    booted: number;
    migrated: number;
    rebuiltSubs: number;
    backfillSteps: number;
    /** Query re-runs triggered by a commit (exact matches). */
    reruns: number;
    /** Debounced re-runs (search rank drift). */
    debouncedReruns: number;
    /** Query runs that read the identity (their result cannot be shared between identities). */
    identityRuns: number;
    /** Shared entries split back into per-identity entries (a re-run started reading the identity). */
    splits: number;
    /** Nested `ctx.runQuery` calls answered from the shard version's memo (a list shared by per-user queries). */
    nestedReused: number;
    /** Runs of `authorize` checks (gates). */
    gateRuns: number;
    /** Subscriptions whose first run came from the HTTP query just before them (`warm`), not from SQLite again. */
    prefetchHits: number;
    /** Commits whose changes were over `changeLogEntryMaxBytes`: their change-log row only marks the version. */
    changeLogOversized: number;
    /** `armAlarm` calls, and the subsystem reads they made (the rest came from the in-memory cache). */
    alarmArms: number;
    alarmJobReads: number;
    alarmFileReads: number;
    alarmOutboxReads: number;
    alarmBcastReads: number;
    /** `_ember_rt_meta` reads (`next_maint`, `backfill`) by `armAlarm`. */
    alarmMetaReads: number;
    /** Subscriptions restored by a wake (dormant) that have since run. */
    warmed: number;
    /** `_files` rows removed by GC (since boot). */
    filesCollected: number;
    /** External-index outbox messages delivered (sent to the queue, or indexed in-process). */
    outboxSent: number;
    /** In-process deliveries that failed (retried later). */
    outboxFailed: number;
    /** Socket `auth` frames that only renewed the token (same identity and claims): nothing re-ran or was re-sent. */
    authRenewals: number;
    /** Socket mutation outcomes with no effect (no write, or an error) kept in memory instead of a dedup row. */
    volatileOutcomes: number;
    /** Feature "zframe": frames sent compressed, and their size before (UTF-16 units) and after (bytes), since boot. */
    zframes: number;
    zframeBytesIn: number;
    zframeBytesOut: number;
  };
  /** External-index outbox (Vectorize / AI Search). */
  outbox: OutboxStats;
  files: { total: number; ready: number; pending: number; deleting: number; unreferenced: number };
  /** Staged indexes are still being backfilled by the alarm. */
  backfilling: boolean;
  subs: number;
  /** Cached query results (shared + per identity). */
  queries: number;
  /** Of `queries`, the ones shared by every identity. */
  shared: number;
  /** Per-identity checks of queries with `authorize`. */
  gates: number;
  /** Subscriptions restored by a wake that have not run yet (see `Shard.dormant`). */
  dormant: number;
  /** Jobs not finished, and failed ones. */
  jobs: JobRow[];
  /** Successful and cancelled jobs kept for `ctx.scheduler.get` (`scheduler.retainMs`). */
  finishedJobs: number;
  bookmarks: number;
  alarm: number | null;
  /** SQLite rows read / written by this object instance since it started (`cursor.rowsRead/rowsWritten`, billed). */
  rows: { read: number; written: number };
  /** Ephemeral channels (feature "ephemeral"): held now, and counters since this object instance started. */
  ephemeral: { channels: number; members: number; joins: number; messages: number; delivered: number; refused: number; timedOut: number };
  /** Statements and rows by kind since this object instance started (`DoSqlDriver.counters`). */
  sql: SqlCounters;
}

interface QueryEntry {
  /** `${fn}\0${argsJson}\0*` (shared) or `${fn}\0${argsJson}\0i:${identityKey}` (own). */
  key: string;
  fn: string;
  args: unknown;
  /** Who its re-runs run as: the identity of an own entry; anonymous for a shared one (its runs never read it). */
  ctx: AuthCtx;
  /** No run of it read the identity: every subscriber reads it, whoever they are. */
  shared: boolean;
  json: string;
  /** JSON of each document when the value is an array of documents (encoded once: the value's JSON and its diffs). */
  docs: string[] | null;
  /** Each field's encoding when the value is an object holding arrays of documents (its value diffs). */
  fields: Map<string, EncodedValue> | null;
  value: unknown;
  /** null = the last run failed: matched only by the tables it (or any run of `fn`) touched. */
  readSet: ReadSet | null;
  /**
   * The last shard version at which the value changed without a commit (a debounced search re-run, an index that
   * became ready): a client holding a value "as of" that version may hold the one before, so it cannot resume.
   */
  unbumpedAt?: number;
  error: WireError | null;
  /** `${sid}\n${qidKey}` -> the subscriber (its current `Sub` is still looked up in `subs` before a delivery). */
  subs: Map<string, Sub>;
}

/** The per-identity check of a query declared with `authorize`: `\u0002${fn}\0${argsJson}\0${identityKey}`. */
interface GateEntry {
  key: string;
  fn: string;
  args: unknown;
  ctx: AuthCtx;
  /** The check refused (or failed): its subscribers hold this error and get no value. */
  error: WireError | null;
  subs: Map<string, Sub>;
}

/** A value as subscribers last received it (the base of their row diffs). */
type EntrySnapshot = { value: unknown; json: string; docs: string[] | null; fields: Map<string, EncodedValue> | null; error: WireError | null };
const snapshotOf = (e: QueryEntry): EntrySnapshot => ({ value: e.value, json: e.json, docs: e.docs, fields: e.fields, error: e.error });

type RunOutcome = EntrySnapshot & {
  readSet: ReadSet | null;
  touched: Set<string>;
  identityRead: boolean;
  /** `ember dev` only (EMBER_DEV_PERF): rows read, documents returned and what the run did. */
  perf?: { read: number; returned: number; profile: QueryProfile };
};

/**
 * A query run for an HTTP caller that said a subscription follows (`warm`: the client's `httpFirst`), kept for the
 * `sub` of the same caller: its handler-phase result, the shard version, epoch and nested-memo generation it was read
 * at. Keyed by function, args and the whole verified identity (`prefetchKey`), never shared between callers.
 */
type Prefetched = { value: unknown; readSet: ReadSet; touched: Set<string>; identityRead: boolean; version: number; epoch: string; gen: number; at: number };
/** Most prefetched runs a shard keeps (the oldest go first), and how long one waits for its `sub`. */
export const PREFETCH_MAX = 64;
export const PREFETCH_TTL_MS = 10_000;
/** Most queries one `POST /api/query/batch` (one `Shard.queryBatch` RPC) carries. */
export const MAX_QUERY_BATCH = 32;
/** One query of `Shard.queryBatch`. */
export type QueryBatchItem = { fn: string; args: unknown; resume?: { version: number; epoch: string; ik: string }; warm?: boolean };

/** Most action jobs one `claimActionJobs` / `settleActionJobs` RPC carries (a Queue batch is at most 100 messages). */
export const MAX_LEASE_BATCH = 100;
/**
 * One outcome of `Shard.settleActionJobs`: the claimed job ran (`error` null: done; else failed and retried by the
 * shard), or was `released` unstarted (the consumer ran out of lease time before reaching it).
 */
export type ActionJobOutcome = { jobId: string; error: { code: string; message: string } | null } | { jobId: string; released: true };

/** Changes of one delivery pass, per socket; `skip`: subscribers handled at the end of the pass. */
type Delivery = { perSocket: Map<string, string[]>; skip: Set<string>; diffs?: Map<QueryEntry, { from: EntrySnapshot; json: string | null }> };

interface Sub {
  sid: string;
  qid: Id;
  /** `qidKey(qid)`: its key in `subs.get(sid)`. */
  qk: string;
  /** `stringify(qid)`, made once: every patch entry for it splices it. */
  qidJson: string;
  /** The entry it reads. */
  key: string;
  /** Its gate (queries with `authorize`). */
  gate?: string;
}

interface Pending {
  fn: string;
  args: unknown;
  ctx: AuthCtx;
  /** `okOnly`: remember only successful outcomes (a failed outbox delivery must be retried, not replayed). */
  dedup?: { identity: string; clientId: string; mid: string; okOnly?: boolean };
  /** WS origin: its mid is listed in the `patch` of the version that includes it. */
  origin?: { sid: string; mid: Id };
  /**
   * The socket negotiated "ack": an effect-free outcome (an error, nothing written) stays only in memory or a flagged
   * ring row, never a dedup row. Without it the client never says it is done with an outcome, and a retry after a
   * lost reply must find it for the whole dedup retention: such outcomes go where effectful ones do.
   */
  acks?: true;
  /** When it was received (Date.now() at the start of that event: the clock moves between events). */
  at: number;
  /** The caller records the metrics point (see MutationCallOptions.caller). */
  caller?: boolean;
  /** `encoded`: `stringify(o)` when the commit already encoded it (dedup row / ring entry), so a reply reuses it. */
  resolve: (o: MutationOutcome, encoded?: string) => void;
}

const qidKey = (qid: Id) => JSON.stringify(qid);
/** `{t:"mres", mid, ...outcome}` from the outcome's JSON (`{"ok":…}`), equal to encoding the object form. */
const mresFrame = (mid: Id, outcome: string): string => `{"t":"mres","mid":${stringify(mid)},${outcome.slice(1)}`;
/** Key of a mutation outcome: identity key, client id, qidKey(mid). */
const outcomeKey = (identity: string, clientId: string, mid: string): string => JSON.stringify([identity, clientId, mid]);
/** At most this many acked mids wait in one socket's attachment (older ones are dropped: their outcomes spill). */
const MAX_ATTACHED_ACKS = 128;

/** A mutation outcome kept for retries: `[identity, clientId, mid, resultJson]`. */
/**
 * `[identity, clientId, mid, result]`, plus `1` for an outcome with no effect (an error, or a mutation that wrote
 * nothing): running it again changes nothing, so it is never spilled to a dedup row (an older runtime reading the ring
 * ignores the flag and spills it, as before).
 */
type OutcomeEntry = [string, string, string, string] | [string, string, string, string, 1];
/** Effect-free outcomes kept in memory (`Shard.volatile`) until acknowledged or carried by a ring row. */
const MAX_VOLATILE = 4096;
/**
 * Their total size, as the ring row writes them: the length of each entry's JSON (escapes included, a control
 * character's `\u0001` too). They all ride in one ring row's `dedup` value, which DO SQLite caps at 2 MB; a JSON unit
 * is at most 3 bytes of UTF-8 (non-ASCII is not escaped), so 256 Ki units stay under 768 KB, next to the commit's own.
 */
const MAX_VOLATILE_UNITS = 256 * 1024;
/** An effect-free outcome larger than this is not kept in memory: it goes to the dedup generations, as before. */
const MAX_VOLATILE_ENTRY_UNITS = 16 * 1024;
/** An entry's size in the ring row: its JSON, flagged (the longer form), plus the separating comma. */
const entryUnits = (e: OutcomeEntry): number => stringify([e[0], e[1], e[2], e[3], 1]).length + 1;
/**
 * The most a ring row's `dedup` may hold for the effect-free outcomes in memory to ride along (same units: 512 Ki stay
 * under 1.5 MB). A commit whose own outcomes leave no room for them writes its row without them: they wait in memory
 * for a later row, so the value never grows past the limit because of them.
 */
const MAX_RING_ROW_UNITS = 512 * 1024;

/**
 * Identity tag of a snapshot (feature "ident"): a 53-bit hash of the identity key. Not a secret: a client can only
 * make the shard skip sending it data under the socket's own identity; an honest client holding a value computed
 * under another identity (sign-out, account switch) echoes that identity's tag and gets a full snapshot.
 */
export function identTag(identity: Identity | null): string {
  const str = identityKey(identity);
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

const isExpired = (identity: Identity | null): boolean => identity?.exp !== undefined && identity.exp * 1000 <= Date.now();

/** Claims that only say when a token was issued or expires, or name the token itself: a renewal changes them. */
const RENEWAL_CLAIMS = new Set(["exp", "iat", "nbf", "jti"]);

/**
 * Whether two identities are the same caller with the same claims, apart from the token's own timing (`exp`, `iat`,
 * `nbf`, `jti`): what a refreshed JWT of the same session looks like. Two anonymous sockets are the same too.
 */
export function sameIdentityClaims(a: Identity | null, b: Identity | null): boolean {
  if (!a || !b) return a === b;
  if (identityKey(a) !== identityKey(b)) return false;
  const relevant = (c: Record<string, unknown> | undefined) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(c ?? {})) if (!RENEWAL_CLAIMS.has(k)) out[k] = v;
    return stableStringify(out);
  };
  return relevant(a.claims) === relevant(b.claims);
}

/** Which identities a revocation reaches: one subject, or every identity whose claim `claim` equals `value`. */
export type RevokeMatch = { subject: string } | { claim: string; value: string | number };
/** How long a revocation is remembered by default (an unexpired token presented again is refused meanwhile). */
const REVOKE_MS = 10 * 60_000;
/** The longest a revocation is remembered. */
const REVOKE_MAX_MS = 24 * HOUR;

/** Why `match` is not a `RevokeMatch` (null when it is). */
export function revokeMatchError(match: unknown): string | null {
  const m = match as Record<string, unknown> | null;
  const ok =
    typeof m === "object" &&
    m !== null &&
    ("subject" in m
      ? typeof m.subject === "string" && m.subject !== ""
      : typeof m.claim === "string" && m.claim !== "" && (typeof m.value === "string" || typeof m.value === "number"));
  return ok ? null : "revokeSockets: match is { subject } or { claim, value }";
}

const revokeKey = (m: RevokeMatch): string => ("subject" in m ? `sub:${m.subject}` : `claim:${m.claim}=${JSON.stringify(m.value)}`);

/** Whether `identity` is one `m` reaches. */
function revokeMatches(m: RevokeMatch, identity: Identity): boolean {
  if ("subject" in m) return identity.subject === m.subject;
  return identity.claims?.[m.claim] === m.value;
}

/** The revocation a key stands for (the inverse of `revokeKey`). */
function revokeOf(k: string): RevokeMatch | null {
  if (k.startsWith("sub:")) return { subject: k.slice(4) };
  const eq = k.indexOf("=");
  if (!k.startsWith("claim:") || eq < 0) return null;
  try {
    return { claim: k.slice(6, eq), value: JSON.parse(k.slice(eq + 1)) as string | number };
  } catch {
    return null;
  }
}

const errInfo = (e: unknown, fallback: string): WireError => errorInfo(e, fallback);
/** A shard registers with global:main's catalog again after this long (replicated.ts). */
const CATALOG_REREGISTER_MS = 24 * HOUR;

/**
 * A server frame's text without its subscription deliveries (`snap`, `patch`): null when nothing is left. For a frame
 * produced before the socket's access expired (`revokeSockets` without `close`, feature "zframe").
 */
function withoutDeliveries(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const isDelivery = (m: unknown) => typeof m === "object" && m !== null && ((m as { t?: unknown }).t === "snap" || (m as { t?: unknown }).t === "patch");
  if (!Array.isArray(parsed)) return isDelivery(parsed) ? null : text;
  const kept = parsed.filter((m) => !isDelivery(m));
  if (!kept.length) return null;
  return kept.length === parsed.length ? text : JSON.stringify(kept);
}

export class Shard extends DurableObject<EmberEnv> implements FileRpc, ExternalIndexRpc, RestoreRpc {
  private readonly cfg: EmberConfig;
  private readonly driver: DoSqlDriver;
  /** `_files` (PLAN §7): same options as the engine's `ctx.storage`. */
  private readonly storageOpts: FileStoreOptions;
  private readonly files: FileStore;
  private engine!: Engine;
  private version = 0;
  private epoch = "";
  private shardName: string | null = null;

  private readonly sockets = new Map<string, WebSocket>();
  private readonly subs = new Map<string, Map<string, Sub>>();
  private readonly queries = new Map<string, QueryEntry>();
  /** Gates of queries with `authorize`, per (fn, args, identity). */
  private readonly gates = new Map<string, GateEntry>();
  private readonly chains = new Map<string, Promise<void>>();
  /** Read-set index over `queries` (interval structure per (table, index); PLAN §4). */
  private index!: MatchIndex<string>;
  /** fn -> every table any run of it touched: a failing query is re-run only on commits to these. */
  private readonly knownTables = new Map<string, Set<string>>();
  /** Query keys waiting for a debounced re-run (search rank drift), and its timer. */
  private readonly debounced = new Set<string>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  /** sid -> attachment (identity / clientId), mirrored from the socket attachment. */
  private readonly attachments = new Map<string, Attachment>();
  /**
   * Sids whose attachment may carry `acks` (a superset: every path that stores acks adds the sid). A ring row that
   * lands acks rewrites only these attachments, each once, instead of walking every socket.
   */
  private readonly ackedSockets = new Set<string>();
  /**
   * sid -> qids stored as `_ember_subs` rows (did not fit in the attachment, or left by an older runtime). Each qid
   * lives in exactly one store, the attachment or the table: moving it deletes it from the other.
   */
  private readonly tableSubs = new Map<string, Set<string>>();
  /** Sockets already told `authExpired` for their current (expired) identity. */
  private readonly expiredNotified = new Set<string>();
  /** Ephemeral channels (feature "ephemeral"): in memory, rebuilt from the attachments on wake. */
  private readonly eph = new EphemeralChannels({
    socket: (sid) => this.sockets.get(sid),
    attachment: (sid) => this.attachments.get(sid),
    saveEph: (ws, eph) => {
      const att = this.attachmentOf(ws);
      const next: Attachment = { ...att, eph };
      // A channel never writes a row: a larger `eph` that would push the subscriptions out to `_ember_subs` (or drop the
      // identity's claims or token) is refused instead. Smaller (a leave) always fits.
      if (JSON.stringify(eph).length > JSON.stringify(att.eph ?? null).length && JSON.stringify(next).length > MAX_ATTACHMENT_BYTES) return false;
      this.saveAttachment(ws, next);
      return true;
    },
    send: (ws, frame) => this.send(ws, frame),
    blocked: (sid) => this.expiredSocket(sid),
    close: (ws, code, reason) => {
      const sid = this.attachmentOf(ws)?.sid;
      this.closeNow(ws, code, reason);
      if (sid) this.dropSocket(sid);
    },
    autoResponseAt: (ws) => this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0,
    shard: () => this.shardName ?? "",
    channels: () => this.cfg.app?.channels,
  });
  /** The latest migration attempt was refused: everything fails with this error until a fixed deploy. */
  private refused: { code: string; message: string } | null = null;
  /**
   * Set when the runtime tables are newer than this runtime (`RuntimeSchemaTooNew`): the boot stopped before touching
   * anything, nothing is recorded in them, and `status()` reports this instead of `_ember_migrations`.
   */
  private runtimeAhead: MigrationErrorInfo | null = null;
  /** This object instance (a restart makes a new one): tells `restoreFinish` whether the object restarted. */
  private readonly instance = crypto.randomUUID();
  /** Nonce of the restore scheduled by this instance (it applies when the object restarts). */
  private restoring: string | null = null;

  private pending: Pending[] = [];
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  private lastArmed: number | null | undefined = undefined;
  /** Last commit with changes (shard catalog `lastWrite`; persisted at report time). */
  private lastWrite: number | null = null;
  private readonly stats = { batches: 0, batchSizes: [] as number[], booted: 0, migrated: 0, rebuiltSubs: 0, backfillSteps: 0, reruns: 0, debouncedReruns: 0, filesCollected: 0, outboxSent: 0, outboxFailed: 0, identityRuns: 0, splits: 0, gateRuns: 0, warmed: 0, nestedReused: 0, authRenewals: 0, volatileOutcomes: 0, prefetchHits: 0, changeLogOversized: 0, zframes: 0, zframeBytesIn: 0, zframeBytesOut: 0 };
  /** The schema has external indexes (Vectorize / AI Search): commits feed the outbox. */
  private readonly hasExternal: boolean;
  /** Tables with an external index (Vectorize, AI Search): only a commit touching one may have written the outbox. */
  private readonly externalTables: ReadonlySet<string>;
  /** `.replicated()` tables (replicated.ts): in `global:main`, commits that change them feed the broadcast log. */
  private readonly replicated: ReadonlySet<string>;
  /** A commit appended to the broadcast log since the alarm was last armed. */
  private bcastNew = false;
  /** The broadcast tables exist (created once per object instance). */
  private bcastReady = false;
  private bcastDraining: Promise<void> | null = null;
  /** The catalog registration (replicated.ts) of this object instance, once started. */
  private registering: Promise<void> | null = null;
  private flushing: Promise<void> | null = null;
  private flushAgain = false;
  /**
   * What `armAlarm` last read, per subsystem (undefined: unknown, read it again), so an arm re-reads only what changed.
   * Dropped by the writes that can move each: `_jobs` rows (`jobChanged`, which every write of them calls), `_files`
   * rows (`FileStore` `onWrite`, the engine's stores included), the outbox and the broadcast log (every commit, their
   * flushes, the catalog). Memory only: a new instance (eviction, restart) starts unknown, and every alarm turn, outbox
   * flush and restore reads everything again (`resetAlarmCache`).
   */
  private nextJobAt: number | null | undefined = undefined;
  private nextFilesAt: number | null | undefined = undefined;
  private nextOutboxAt: number | null | undefined = undefined;
  private nextBcastAt: number | null | undefined = undefined;
  /**
   * `_ember_rt_meta` `next_maint` (a time, null: none) and `backfill` (pending) as `armAlarm` last read them. Dropped by
   * `setMeta`/`deleteMeta` of that key (the only writers; a rolled back write leaves them unknown, never stale) and by
   * `resetAlarmCache`.
   */
  private nextMaintAt: number | null | undefined = undefined;
  private backfillDue: boolean | undefined = undefined;
  /** `armAlarm` calls and the subsystem reads they made (`inspect().stats`). */
  private readonly alarmStats = { alarmArms: 0, alarmJobReads: 0, alarmFileReads: 0, alarmOutboxReads: 0, alarmBcastReads: 0, alarmMetaReads: 0 };

  constructor(ctx: DurableObjectState, env: EmberEnv) {
    super(ctx, env);
    this.cfg = getEmberConfig();
    this.driver = new DoSqlDriver(ctx.storage);
    this.externalTables = new Set(externalIndexes(this.cfg.schema.manifest, this.cfg.schema.indexKinds).map((x) => x.table));
    this.hasExternal = this.externalTables.size > 0;
    this.replicated = replicatedSet(this.cfg.schema.manifest);
    this.storageOpts = {
      shard: () => this.shardName,
      signer: fileSignerFromEnv(env, this.cfg.basePath),
      // EMBER_FILES_GC_GRACE_MS (a Worker var) overrides the 24 h grace, e.g. for short-lived test environments.
      ...(this.cfg.files?.gcGraceMs !== undefined
        ? { gcGraceMs: this.cfg.files.gcGraceMs }
        : Number(env.EMBER_FILES_GC_GRACE_MS) >= 0 && env.EMBER_FILES_GC_GRACE_MS !== undefined
          ? { gcGraceMs: Number(env.EMBER_FILES_GC_GRACE_MS) }
          : {}),
      ...(this.cfg.files?.urlTtlSeconds !== undefined ? { urlTtlSeconds: this.cfg.files.urlTtlSeconds } : {}),
      onWrite: () => {
        this.nextFilesAt = undefined;
      },
    };
    this.files = FileStore.ofDriver(this.driver, this.storageOpts);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    void ctx.blockConcurrencyWhile(() => this.boot());
  }

  // ------------------------------------------------------------------ boot

  private async boot(): Promise<void> {
    this.stats.booted++;
    const create = this.cfg.createEngine ?? DEFAULT_CREATE_ENGINE;
    const schemaVersion = this.cfg.schema.manifest.version;
    const idKey = this.ctx.id.toString();
    const cached = verifiedInIsolate.get(idKey) === schemaVersion;
    // Before RUNTIME_DDL (which would create what a newer runtime dropped) and before any write: an older runtime
    // rolled back under a newer one must not run against tables it does not understand. Every boot (two small reads),
    // not only uncached ones.
    this.runtimeAhead = null;
    this.driver.readOnly = null;
    // `_ember_rt_meta` in one read for the whole boot (`getMeta` answers from it until the boot ends).
    const stored = allStoredMeta(this.ctx.storage.sql, this.driver);
    const rtValue = stored?.get("rt_schema") ?? null;
    const storedRt = rtValue === null || rtValue.trim() === "" ? null : rtValue;
    if (runtimeSchemaAhead(storedRt)) return this.refuseRuntimeAhead(storedRt!, create, schemaVersion);
    this.metaCache = stored ?? new Map();
    try {
      await this.bootCurrent(create, schemaVersion, idKey, cached, stored, storedRt);
    } finally {
      this.metaCache = null;
    }
  }

  private async bootCurrent(create: NonNullable<EmberConfig["createEngine"]>, schemaVersion: string, idKey: string, cached: boolean, stored: Map<string, string> | null, storedRt: string | null): Promise<void> {
    // PITR (restore.ts): the first boot under a new Worker version records the state the previous code left behind,
    // before the migration and before any request of the new code runs. The bookmark is taken here, before the
    // runtime tables are created or upgraded (its row is written below, once the table exists): restoring
    // `deploy:<v>` must bring back runtime tables the previous runtime understands (what restoring a shard refused with
    // RuntimeSchemaTooNew from the older runtime relies on: `restorePrepare` with `discardNewer`). A brand-new shard records it too (its state "before" is
    // empty): `--to deploy:<v>` must roll back what it wrote under v. If the bookmark cannot be taken, a
    // `deploy-missed:<v>` row (no bookmark) says so, and deploy targets refuse this shard instead of silently resolving
    // past the writes made under v.
    const deployId = deployVersionId(this.env);
    let deployMark: string | null | undefined;
    if (deployId && (stored?.get("deploy_version") ?? null) !== deployId) {
      try {
        deployMark = await this.ctx.storage.getCurrentBookmark();
      } catch {
        deployMark = null; // no PITR here (as in recordBookmark)
      }
    }
    // Runtime tables already at RUNTIME_SCHEMA exist (with `_files`; its newer indexes come with the engine's
    // migrate, which checks FILES_DDL against sqlite_master): no DDL on such a wake.
    if (!cached && storedRt !== String(RUNTIME_SCHEMA)) {
      this.ctx.storage.sql.exec(RUNTIME_DDL);
      for (const sql of FILES_DDL) this.ctx.storage.sql.exec(sql);
      const rt = Number(this.getMeta("rt_schema") ?? "0");
      if (rt < RUNTIME_SCHEMA) {
        this.ctx.storage.transactionSync(() => {
          upgradeRuntimeTables(this.ctx.storage.sql, rt, ringSize(this.cfg));
          this.setMeta("rt_schema", String(RUNTIME_SCHEMA));
        });
      }
    }

    this.engine = create({
      schema: this.cfg.schema,
      functions: this.cfg.functions,
      driver: this.driver,
      now: () => Date.now(),
      random: Math.random,
      storage: this.storageOpts,
      ...(this.cfg.triggers !== undefined ? { triggers: this.cfg.triggers } : {}),
      // `ctx.scheduler.get/list` read `_jobs` in the same transaction (PLAN §8).
      scheduledFunctions: { get: (id) => this.scheduledJob(id), list: (o) => this.scheduledJobs(o) },
      // `defineApp({ limits })` (PLAN §3): the project's limits; each function may set its own.
      ...(this.cfg.app?.limits ? { limits: this.cfg.app.limits } : {}),
      // `defineApp({ storage: { compactFormat } })` / `createEmberWorker({ compactFormat })`: the format of new tables.
      ...this.compactFormatOpt(),
    });
    this.index = createMatchIndex<string>(this.cfg.schema);
    this.refused = null;

    if (deployId && deployMark !== undefined) {
      this.driver.exec("INSERT INTO _ember_bookmarks(at, bookmark, reason) VALUES (?, ?, ?)", Date.now(), deployMark ?? "", deployMark ? `deploy:${deployId}` : `deploy-missed:${deployId}`);
      this.setMeta("deploy_version", deployId);
    }
    // Known before the migration: a `.replicated()` table is the source's own data in global:main and a copy elsewhere
    // (migrate.ts); a brand-new shard learns its name with its first request, and has nothing to migrate yet.
    this.shardName = this.getMeta("shard");
    let migrated = false;
    if (!cached) {
      const from = this.getMeta("schema_version");
      // A runtime upgrade may have storage work for an unchanged schema (classic tables -> compact storage).
      if (from !== schemaVersion || this.engine.storageBehind()) {
        try {
          this.driver.transaction(() => {
            const report = this.engine.migrate();
            if (report.staged.length) this.setMeta("backfill", "1");
            this.setMeta("schema_version", schemaVersion);
            this.driver.exec(
              "INSERT INTO _ember_migrations(at, from_version, to_version, ok) VALUES (?, ?, ?, 1)",
              Date.now(), from, schemaVersion,
            );
          });
          migrated = true;
          this.stats.migrated++;
        } catch (e) {
          // MigrationRefused (or a failing DDL): the transaction rolled back; the shard keeps its old schema and
          // refuses work until a deploy fixes the schema. Recorded for `GET /api/_ember/status` / `deploy --wait`.
          // The boot's meta copy saw the rolled-back writes: read it again.
          this.metaCache = allStoredMeta(this.ctx.storage.sql, this.driver) ?? new Map();
          const err = errInfo(e, "MigrationFailed");
          this.refused = err;
          this.driver.exec(
            "INSERT INTO _ember_migrations(at, from_version, to_version, ok, code, message) VALUES (?, ?, ?, 0, ?, ?)",
            Date.now(), from, schemaVersion, err.code, err.message,
          );
          this.driver.exec("DELETE FROM _ember_migrations WHERE id <= (SELECT MAX(id) FROM _ember_migrations) - 100");
          console.error(`ember: migration to ${schemaVersion.slice(0, 12)} refused`, err.message);
        }
      }
      if (!this.refused) verifiedInIsolate.set(idKey, schemaVersion);
    }

    // The newest change-log entry carries the version (meta `version` is only what runtimes before v3 wrote).
    const newest = this.driver.exec("SELECT MAX(version) AS v FROM _ember_changes").rows[0]?.v;
    this.version = Math.max(Number(this.getMeta("version") ?? "0"), Number(newest ?? 0));
    this.loadDedup();
    if (!cached) this.trimRing();
    this.loadOversized();
    this.ring = null;
    this.volatile.clear();
    this.volatileSizes.clear();
    this.volatileUnits = 0;
    this.spilledClients.clear();
    let epoch = this.getMeta("epoch");
    if (!epoch) {
      epoch = crypto.randomUUID();
      this.setMeta("epoch", epoch);
    }
    this.epoch = epoch;

    if (migrated) await this.recordBookmark("migrate");
    if (migrated) this.ctx.waitUntil(this.reportCatalog(true));
    this.rebuildRegistry();
    this.catalogBoot();
    // After a migration (possibly fixing an earlier refusal, during which the alarm stood down) re-arm for jobs too.
    if (!this.refused && (migrated || this.getMeta("backfill") !== null)) this.armAlarm();
  }

  /** `{ compactFormat }` when the config or the app sets one (`compactFormatOf`), else nothing (the engine's default). */
  private compactFormatOpt(): { compactFormat?: 2 | 3 } {
    const f = compactFormatOf(this.cfg);
    return f !== undefined ? { compactFormat: f } : {};
  }

  /** The boot of a shard whose runtime tables are newer (see `runtimeAhead`): read-only from here on. */
  private refuseRuntimeAhead(stored: string, create: NonNullable<EmberConfig["createEngine"]>, schemaVersion: string): void {
    const err = errInfo(runtimeSchemaTooNew(stored), "RuntimeSchemaTooNew");
    // An engine is still built (no I/O): every path that runs functions checks `refused` first.
    this.engine = create({ schema: this.cfg.schema, functions: this.cfg.functions, driver: this.driver, now: () => Date.now(), random: Math.random, storage: this.storageOpts });
    this.index = createMatchIndex<string>(this.cfg.schema);
    this.refused = err;
    // The choke point: from here on the driver runs single SELECTs only, so a write no check below foresaw throws this
    // error instead of reaching tables of the newer runtime. The non-SQL writes (alarm) are stopped in `armAlarm`/`alarm`.
    this.driver.readOnly = err;
    const meta = (k: string) => this.ctx.storage.sql.exec("SELECT v FROM _ember_rt_meta WHERE k = ?", k).toArray()[0]?.v;
    const from = meta("schema_version");
    this.runtimeAhead = { at: Date.now(), fromVersion: typeof from === "string" ? from : null, toVersion: schemaVersion, code: err.code, message: err.message };
    const name = meta("shard");
    this.shardName = typeof name === "string" ? name : null;
    console.error(`ember: shard ${this.shardName ?? "?"} refused: runtime schema ${stored} is newer than ${RUNTIME_SCHEMA}`, err.message);
    // Sockets still attached (hibernation) hear it the way a new socket does (`fetch`): one `err` frame. Their
    // subscriptions are not rebuilt: that reads `_ember_subs`, a table of the newer runtime.
    for (const ws of this.ctx.getWebSockets()) {
      try {
        this.send(ws, { t: "err", code: err.code, message: err.message });
      } catch {
        // a closing socket
      }
    }
  }

  /**
   * `assertNotAhead` for the restore path: `bookmarkNow` (it would write `_ember_bookmarks`), and `restorePrepare`
   * without `discardNewer`. The same code, with a message that says what works.
   */
  private assertNotAheadForRestore(what: "bookmark" | "restore"): void {
    const a = this.runtimeAhead;
    if (a) {
      throw new EmberError(
        a.code,
        what === "bookmark"
          ? `${a.message} No bookmark is taken on a refused shard: its runtime tables belong to the newer runtime.`
          : `${a.message} Restoring it from this runtime discards everything the newer runtime wrote after the bookmark: pass ` +
              `discardNewer (ember restore --discard-newer) to accept that.`,
        (this.refused as { data?: unknown } | null)?.data,
      );
    }
  }

  /** Throws `RuntimeSchemaTooNew` on a shard whose runtime tables are newer (`runtimeAhead`): for RPCs that must not run. */
  private assertNotAhead(): void {
    const a = this.runtimeAhead;
    if (a) throw new EmberError(a.code, a.message, (this.refused as { data?: unknown } | null)?.data);
  }

  /**
   * In-memory subscription state is lost on hibernation/eviction; rebuild it from the socket attachments (where
   * subscriptions normally live) and `_ember_subs` (the ones that did not fit). The subscriptions are registered
   * dormant, without running their queries: the boot (inside `blockConcurrencyWhile`) no longer grows with the number
   * of distinct queries. See `dormant`.
   */
  private rebuildRegistry(): void {
    const live = new Map<string, { ws: WebSocket; att: Attachment }>();
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (att?.sid) live.set(att.sid, { ws, att });
    }
    for (const [sid, { ws, att }] of live) {
      this.sockets.set(sid, ws);
      this.attachments.set(sid, att);
      if (att.acks?.length) this.ackedSockets.add(sid);
      if (att.batch) this.batching.add(ws);
      if (att.zframe) this.zframes.add(ws);
      // Channel memberships (feature "ephemeral"): the rooms come back from the attachments.
      this.eph.restore(sid, att.eph);
      // Acks received before a hibernation, not yet in a ring row.
      for (const mid of att.acks ?? []) this.pendingAcks.add(outcomeKey(identityKey(att.identity), att.clientId ?? "", mid));
    }
    const restore = (s: { ws: WebSocket; att: Attachment }, qk: string, fn: string, args: string) => {
      const qid = JSON.parse(qk) as Id;
      if (this.refused) {
        this.send(s.ws, { t: "err", code: this.refused.code, message: this.refused.message, qid });
        return;
      }
      let m = this.subs.get(s.att.sid);
      if (!m) this.subs.set(s.att.sid, (m = new Map()));
      m.set(qk, { sid: s.att.sid, qid, qk, qidJson: stringify(qid), key: "" });
      this.dormant.set(`${s.att.sid}\n${qk}`, { sid: s.att.sid, qid, fn, args, identity: s.att.identity });
      this.stats.rebuiltSubs++;
    };
    for (const s of live.values()) for (const [qk, fn, args] of s.att.subs ?? []) restore(s, qk, fn, args);
    const rows = this.driver.exec("SELECT sock, qid, fn, args FROM _ember_subs").rows;
    const dead = new Set<string>();
    this.tableSubs.clear();
    for (const r of rows) {
      const sid = r.sock as string;
      const qk = r.qid as string;
      const s = live.get(sid);
      if (!s) {
        dead.add(sid);
        continue;
      }
      if (s.att.subs?.some((x) => x[0] === qk)) {
        // A stale duplicate (data of a runtime that kept both stores): the attachment is the current one.
        this.driver.exec("DELETE FROM _ember_subs WHERE sock = ? AND qid = ?", sid, qk);
        continue;
      }
      restore(s, qk, r.fn as string, r.args as string);
      this.tableSubsOf(sid).add(qk);
    }
    for (const sid of dead) this.driver.exec("DELETE FROM _ember_subs WHERE sock = ?", sid);
  }

  /**
   * Subscriptions restored by a wake that have not run yet (`${sid}\n${qk}` -> what to run; their `Sub.key` is "").
   * Each client holds its value as of the last commit before the hibernation, which is still the current state: nothing
   * commits while the object sleeps. They run lazily, all of them before anything can change results (a commit, a job
   * run, any `_jobs` write, an index becoming ready: `warmAll`), so no update is lost and the first re-run diffs from
   * the value the client holds. A socket's `sub` and an `auth` that changes its identity run its dormant ones first.
   * Nothing else runs them: a wake that only reads (`q`, HTTP query, `ack`, a close, a token renewal, an alarm turn
   * that writes nothing) leaves them dormant, and the object can hibernate again without having run them.
   */
  private readonly dormant = new Map<string, { sid: string; qid: Id; fn: string; args: string; identity: Identity | null }>();

  /** Runs dormant subscriptions (at most `limit`; only `sid`'s when given), each joining its entry as a new one would. */
  private warmDormant(limit = Infinity, sid?: string): void {
    let n = 0;
    for (const [k, d] of this.dormant) {
      if (n >= limit) break;
      if (sid !== undefined && d.sid !== sid) continue;
      this.dormant.delete(k);
      n++;
      this.bind(d.sid, d.qid, d.fn, parse(d.args), d.identity);
      this.stats.warmed++;
    }
  }

  /**
   * Before anything can change a result: every dormant subscription must hold its current value. Every write that can
   * change one calls it first: a commit, a job run and any other `_jobs` write (`ctx.scheduler.get`/`list` read them),
   * an index becoming ready. A no-op once nothing is dormant.
   */
  private warmAll(): void {
    if (this.dormant.size) this.warmDormant();
  }

  // ------------------------------------------------------------------ mutation dedup (generation tables)

  /** Generation tables to look up, newest first (see dedupTable). Creates generation 1 on a new shard. */
  private dedupTables: string[] = [];

  private loadDedup(): void {
    let n = Number(this.getMeta("dedup_gen") ?? "0");
    if (!n) {
      n = 1;
      this.driver.transaction(() => {
        this.driver.exec(dedupDdl(dedupTable(1)));
        this.setMeta("dedup_gen", "1");
        this.setMeta("dedup_gen_at", String(Date.now()));
      });
    }
    // From generation 2 on, `dedup_has_prev` (written by each rotation) spares a sqlite_master probe; generation 1
    // probes for the legacy `_ember_dedup` (runtime < 3), and so do shards rotated before the marker existed.
    const known = n >= 2 ? this.getMeta("dedup_has_prev") : null;
    const prev = known !== null ? known === "1" : this.driver.exec("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?", dedupTable(n - 1)).rows.length > 0;
    this.dedupTables = prev ? [dedupTable(n), dedupTable(n - 1)] : [dedupTable(n)];
  }

  /** Starts a new generation once the newest is DEDUP_RETENTION_MS old, dropping the previous one (free). */
  private rotateDedup(now: number): boolean {
    const n = Number(this.getMeta("dedup_gen") ?? "0");
    const at = Number(this.getMeta("dedup_gen_at") ?? "0");
    if (!n || now - at < DEDUP_RETENTION_MS) return false;
    this.driver.transaction(() => {
      for (const t of this.dedupTables.slice(1)) this.driver.exec(`DROP TABLE IF EXISTS ${t}`);
      this.driver.exec(dedupDdl(dedupTable(n + 1)));
      this.setMeta("dedup_gen", String(n + 1));
      this.setMeta("dedup_gen_at", String(now));
      this.setMeta("dedup_has_prev", "1");
    });
    this.dedupTables = [dedupTable(n + 1), dedupTable(n)];
    return true;
  }

  /**
   * Whether a client (identity + clientId) may have outcomes in the generation tables: probed once per client and
   * object lifetime, set by every spill. A client that acknowledges its outcomes (feature "ack") never has any, so its
   * mutations skip the per-mid lookups. `true` is always safe (it only means "look").
   */
  private readonly spilledClients = new Map<string, boolean>();

  private mayHaveSpilled(identity: string, clientId: string): boolean {
    const k = `${identity}\n${clientId}`;
    let known = this.spilledClients.get(k);
    if (known === undefined) {
      known = this.dedupTables.some((t) => this.driver.exec(`SELECT 1 AS x FROM ${t} WHERE identity = ? AND client_id = ? LIMIT 1`, identity, clientId).rows.length > 0);
      if (this.spilledClients.size >= 10_000) this.spilledClients.clear();
      this.spilledClients.set(k, known);
    }
    return known;
  }

  private dedupLookup(identity: string, clientId: string, mid: string): string | null {
    const k = outcomeKey(identity, clientId, mid);
    const inRing = this.ensureRing().results.get(k) ?? this.volatile.get(k);
    if (inRing !== undefined) return inRing[3];
    if (!this.mayHaveSpilled(identity, clientId)) return null;
    for (const t of this.dedupTables) {
      const row = this.driver.exec(`SELECT result FROM ${t} WHERE identity = ? AND client_id = ? AND mid = ?`, identity, clientId, mid).rows[0];
      if (row) return row.result as string;
    }
    return null;
  }

  // ------------------------------------------------------------------ outcomes in the change-log ring (feature "ack")
  //
  // A socket mutation's outcome is written into the change-log row of its commit (`_ember_changes.dedup`), a row the
  // commit writes anyway: no dedup row. The client acknowledges outcomes it has settled (`{t:"ack"}`); the acks ride
  // in a later ring row (`acks`) and, until then, in memory and the socket's attachment. When a slot is reused, the
  // outcomes of the version it held that were never acknowledged move to the dedup generation tables ("spill"): an
  // outcome is always findable (ring, then generations) until it is acknowledged, and costs a row only if it is not.

  /** Outcomes and acks of the ring rows, loaded on the first commit or lookup after a wake. */
  private ring: { bySlot: Map<number, { keys: string[]; acks: string[] }>; results: Map<string, OutcomeEntry>; acked: Set<string> } | null = null;
  /** Acks received since the last ring row: written into the next one. */
  private readonly pendingAcks = new Set<string>();
  /**
   * Outcomes of socket mutations with no effect (an error, or nothing written) from commits without a ring row: kept
   * here (no dedup row, `spilledClients` untouched) until the client acknowledges them or the next ring row carries
   * them (flagged, never spilled). Only for clients with feature "ack" (`Pending.acks`). Losing one (eviction before a
   * ring row, overflow) is safe: a retry runs again and, as the first run changed nothing, still has its effects at
   * most once. Bounded by count (MAX_VOLATILE) and size (MAX_VOLATILE_UNITS, `volatileUnits`): the oldest go first,
   * so the ring row that carries them all always fits.
   */
  private readonly volatile = new Map<string, OutcomeEntry>();
  /** Each one's `entryUnits` (computed once), and their sum. */
  private readonly volatileSizes = new Map<string, number>();
  private volatileUnits = 0;
  /** The ring update of the commit in progress, applied to `ring` once its transaction commits. */
  private ringPending: { slot: number; keys: string[]; entries: OutcomeEntry[]; acks: string[]; maint?: true; oversized?: number } | null = null;
  /** `next_maint` is known to be set (null: not known). Set once a commit that wrote or saw it is durable in memory. */
  private maintArmed: boolean | null = null;
  /** This commit set `next_maint` (the alarm must pick it up). */
  private maintNew = false;

  private ensureRing(): NonNullable<Shard["ring"]> {
    if (this.ring) return this.ring;
    const ring: NonNullable<Shard["ring"]> = { bySlot: new Map(), results: new Map(), acked: new Set() };
    for (const r of this.driver.exec("SELECT slot, dedup, acks FROM _ember_changes WHERE dedup IS NOT NULL OR acks IS NOT NULL").rows) {
      const entries = r.dedup ? (parse(r.dedup as string) as OutcomeEntry[]) : [];
      const acks = r.acks ? (parse(r.acks as string) as string[]) : [];
      const keys = entries.map((e) => outcomeKey(e[0], e[1], e[2]));
      ring.bySlot.set(Number(r.slot), { keys, acks });
      entries.forEach((e, i) => ring.results.set(keys[i]!, e));
      for (const k of acks) ring.acked.add(k);
    }
    return (this.ring = ring);
  }

  private keepVolatile(e: OutcomeEntry, units = entryUnits(e)): void {
    const k = outcomeKey(e[0], e[1], e[2]);
    this.dropVolatile(k);
    while (this.volatile.size && (this.volatile.size >= MAX_VOLATILE || this.volatileUnits + units > MAX_VOLATILE_UNITS)) this.dropVolatile(this.volatile.keys().next().value!);
    this.volatile.set(k, e);
    this.volatileSizes.set(k, units);
    this.volatileUnits += units;
    this.stats.volatileOutcomes++;
  }

  private dropVolatile(k: string): boolean {
    const e = this.volatile.get(k);
    if (!e) return false;
    this.volatile.delete(k);
    this.volatileUnits -= this.volatileSizes.get(k) ?? entryUnits(e);
    this.volatileSizes.delete(k);
    return true;
  }

  /** An outcome into the newest dedup generation (an unacknowledged one leaving the ring, or one with no ring row). */
  private spill(e: OutcomeEntry, at: number): void {
    this.spilledClients.set(`${e[0]}\n${e[1]}`, true);
    this.driver.exec(`INSERT OR IGNORE INTO ${this.dedupTables[0]}(identity, client_id, mid, at, result) VALUES (?, ?, ?, ?, ?)`, e[0], e[1], e[2], at, e[3]);
  }

  /**
   * The ring columns of version `v`'s row (inside the commit's transaction): its outcomes, the pending acks, and the
   * spill of the unacknowledged outcomes of the version the slot held.
   */
  private ringColumns(v: number, entries: OutcomeEntry[], now: number): { dedup: string | null; acks: string | null } {
    const ring = this.ensureRing();
    const slot = v % ringSize(this.cfg);
    const old = ring.bySlot.get(slot);
    if (old) {
      for (const k of old.keys) {
        if (ring.acked.has(k) || this.pendingAcks.has(k)) continue;
        const e = ring.results.get(k);
        if (e && e[4] !== 1) this.spill(e, now);
      }
    }
    // Effect-free outcomes waiting in memory ride in this row (written anyway): they survive an eviction for free.
    let dedup = entries.length ? stringify(entries) : null;
    if (this.volatile.size && (dedup?.length ?? 2) + this.volatileUnits <= MAX_RING_ROW_UNITS) {
      entries = [...entries, ...[...this.volatile.values()].map((e): OutcomeEntry => [e[0], e[1], e[2], e[3], 1])];
      dedup = stringify(entries);
    }
    const acks = [...this.pendingAcks];
    this.ringPending = { slot, keys: entries.map((e) => outcomeKey(e[0], e[1], e[2])), entries, acks };
    return { dedup, acks: acks.length ? stringify(acks) : null };
  }

  /** After the commit: the in-memory ring follows the row just written. */
  private applyRing(): void {
    const p = this.ringPending;
    this.ringPending = null;
    if (p?.maint) this.maintArmed = true;
    // The commit's changes are not in its row: no resume is answered from memory for that version either.
    if (p?.oversized !== undefined) this.parsedChanges.set(p.oversized, null);
    if (!p || !this.ring) return;
    const ring = this.ring;
    const old = ring.bySlot.get(p.slot);
    if (old) {
      for (const k of old.keys) ring.results.delete(k);
      // Acks in the old row were for older versions, whose slots were reused before this one.
      for (const k of old.acks) ring.acked.delete(k);
    }
    if (p.keys.length || p.acks.length) ring.bySlot.set(p.slot, { keys: p.keys, acks: p.acks });
    else ring.bySlot.delete(p.slot);
    p.entries.forEach((e, i) => ring.results.set(p.keys[i]!, e));
    for (const k of p.keys) this.dropVolatile(k);
    for (const k of p.acks) {
      ring.acked.add(k);
      this.pendingAcks.delete(k);
    }
    if (this.ackedSockets.size) {
      // A sid leaves the set only once its attachment no longer carries landed acks: one with no socket, or whose
      // write throws, is retried on the next ring row, with or without acks of its own (the commit already landed:
      // nothing here may fail it). Every attached ack is in `pendingAcks` until a ring row lands it (`acknowledge`,
      // `rebuildRegistry`), so "not pending" means landed, even once that row's slot was reused. Acks sent after this
      // commit are still pending and stay attached.
      for (const sid of [...this.ackedSockets]) {
        const att = this.attachments.get(sid);
        if (!att?.acks?.length) {
          this.ackedSockets.delete(sid);
          continue;
        }
        const ws = this.sockets.get(sid);
        if (!ws) continue;
        const identity = identityKey(att.identity);
        const left = att.acks.filter((mid) => this.pendingAcks.has(outcomeKey(identity, att.clientId ?? "", mid)));
        if (left.length === att.acks.length) continue;
        const { acks: _done, ...rest } = att;
        try {
          this.saveAttachment(ws, left.length ? { ...rest, acks: left } : rest);
          if (!left.length) this.ackedSockets.delete(sid);
        } catch {
          // Kept in the set: retried on the next ring row.
        }
      }
    }
  }

  /** `{t:"ack"}`: outcomes the client settled; ignored for outcomes that are not (or no longer) in the ring. */
  private acknowledge(ws: WebSocket, att: Attachment, mids: Id[]): void {
    const ring = this.ensureRing();
    const identity = identityKey(att.identity);
    const clientId = att.clientId ?? "";
    const fresh: string[] = [];
    for (const mid of mids) {
      const k = outcomeKey(identity, clientId, qidKey(mid));
      // Effect-free: nothing to remember (a lost ack only costs a re-run that changes nothing).
      if (this.dropVolatile(k)) continue;
      const e = ring.results.get(k);
      if (e?.[4] === 1) {
        ring.results.delete(k);
        continue;
      }
      if (!e || ring.acked.has(k) || this.pendingAcks.has(k)) continue;
      this.pendingAcks.add(k);
      fresh.push(qidKey(mid));
    }
    if (fresh.length) this.saveAttachment(ws, { ...att, acks: [...(att.acks ?? []), ...fresh].slice(-MAX_ATTACHED_ACKS) });
  }

  /**
   * `changeLogVersions` shrank since the ring was written: slots past the end would never be reused, and the remaining
   * rows no longer sit where the new size reuses them in version order. So the ring gives up its outcomes once: every
   * unacknowledged one spills to the dedup generations, then the trimmed rows go and the others lose `dedup`/`acks`.
   */
  private trimRing(): void {
    const size = ringSize(this.cfg);
    if (!this.driver.exec("SELECT 1 AS x FROM _ember_changes WHERE slot >= ? LIMIT 1", size).rows.length) return;
    const rows = this.driver.exec("SELECT dedup, acks FROM _ember_changes WHERE dedup IS NOT NULL OR acks IS NOT NULL").rows;
    const acked = new Set<string>();
    for (const r of rows) for (const k of r.acks ? (parse(r.acks as string) as string[]) : []) acked.add(k);
    this.driver.transaction(() => {
      const now = Date.now();
      for (const r of rows) {
        for (const e of r.dedup ? (parse(r.dedup as string) as OutcomeEntry[]) : []) if (e[4] !== 1 && !acked.has(outcomeKey(e[0], e[1], e[2]))) this.spill(e, now);
      }
      this.driver.exec("DELETE FROM _ember_changes WHERE slot >= ?", size);
      this.driver.exec("UPDATE _ember_changes SET dedup = NULL, acks = NULL WHERE dedup IS NOT NULL OR acks IS NOT NULL");
    });
  }

  /**
   * Versions with an out-of-ring row (`OVERSIZED_CHANGES`), oldest first. Read once per load; one whose ring slot no
   * longer holds it (a ring that grew or shrank since) goes then.
   */
  private oversizedRows: number[] = [];

  private loadOversized(): void {
    const read = () => this.driver.exec("SELECT version FROM _ember_changes WHERE slot < 0 ORDER BY version").rows.map((r) => Number(r.version));
    this.oversizedRows = read();
    if (!this.oversizedRows.length) return;
    this.driver.exec("DELETE FROM _ember_changes WHERE slot < 0 AND version NOT IN (SELECT version FROM _ember_changes WHERE slot >= 0)");
    this.oversizedRows = read();
  }

  /** At the commit of version `v` (in its transaction): out-of-ring rows of versions the ring no longer holds go. */
  private dropOversized(v: number): void {
    const gone = v - ringSize(this.cfg);
    while (this.oversizedRows.length && this.oversizedRows[0]! <= gone) {
      this.driver.exec("DELETE FROM _ember_changes WHERE slot = ?", oversizedSlot(this.oversizedRows.shift()!));
    }
  }

  // ------------------------------------------------------------------ meta

  /** During `boot` only: `_ember_rt_meta` as read at its start, kept in step by `setMeta`/`deleteMeta`. */
  private metaCache: Map<string, string> | null = null;

  private getMeta(k: string): string | null {
    if (this.metaCache) return this.metaCache.get(k) ?? null;
    const r = this.driver.exec("SELECT v FROM _ember_rt_meta WHERE k = ?", k).rows[0];
    return r ? (r.v as string) : null;
  }

  private setMeta(k: string, v: string): void {
    this.metaChanged(k);
    this.driver.exec("INSERT INTO _ember_rt_meta(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, v);
    this.metaCache?.set(k, v);
  }

  private deleteMeta(k: string): void {
    this.metaChanged(k);
    this.driver.exec("DELETE FROM _ember_rt_meta WHERE k = ?", k);
    this.metaCache?.delete(k);
  }

  /** A meta key `armAlarm` caches is written: the next arm reads it again. */
  private metaChanged(k: string): void {
    if (k === "next_maint") this.nextMaintAt = undefined;
    else if (k === "backfill") this.backfillDue = undefined;
  }

  private setShardName(name: string | null | undefined): void {
    if (!name || this.shardName === name) return;
    this.shardName = name;
    // Runtime tables of a newer runtime: not even the name is written (refused, see `runtimeAhead`).
    if (this.runtimeAhead) return;
    this.setMeta("shard", name);
    if (this.getMeta("catalog_due") !== null) this.ctx.waitUntil(this.reportCatalog(true));
    this.catalogBoot();
  }

  // ------------------------------------------------------------------ shard catalog and `.replicated()` (replicated.ts)

  private get isReplicatedSource(): boolean {
    return this.shardName === REPLICATED_SOURCE;
  }

  /**
   * Once the name is known: `global:main` checks its replication targets against the deployed schema; any other
   * shard registers in the catalog (once; the hourly maintenance retries a failed attempt).
   */
  private catalogBoot(): void {
    if (!this.shardName || this.refused) return;
    if (this.isReplicatedSource) {
      if (!this.replicated.size) {
        // Turned off (or never on): forget the last version, so turning it on again resyncs every target.
        try {
          syncBroadcastTargets(this.driver, this.cfg.schema.manifest);
        } catch (e) {
          console.error("ember: replicated tables: target check failed", e);
        }
        return;
      }
      try {
        if (syncBroadcastTargets(this.driver, this.cfg.schema.manifest) > 0 || nextBroadcastAt(this.driver) !== null) {
          this.bcastNew = true;
          this.nextBcastAt = undefined;
          this.armAlarm();
        }
      } catch (e) {
        console.error("ember: replicated tables: target check failed", e);
      }
      return;
    }
    if (this.registrationDue()) this.ctx.waitUntil(this.registerInCatalog(false));
  }

  /**
   * Never registered, or not in the last day: registering again is how the catalog heals after a restore of
   * global:main (shards registered after its bookmark come back, and get their copy, within a day of activity).
   */
  private registrationDue(): boolean {
    const at = this.getMeta("catalog_registered");
    return at === null || Date.now() - Number(at) > CATALOG_REREGISTER_MS;
  }

  /** Registers this shard with `global:main` (`resync`: and asks for a full copy of the replicated tables). */
  private registerInCatalog(resync: boolean): Promise<void> {
    if (this.registering && !resync) return this.registering;
    const name = this.shardName;
    if (!name || name === REPLICATED_SOURCE) return Promise.resolve();
    const run = (async () => {
      try {
        const stub = shardStub(this.env, this.cfg.schema.manifest, REPLICATED_SOURCE) as unknown as Shard;
        await stub.registerShard(name, resync ? { resync: true } : {});
        this.setMeta("catalog_registered", String(Date.now()));
      } catch (e) {
        console.error(`ember: shard catalog: ${name} could not register with ${REPLICATED_SOURCE} (retried hourly)`, e);
      } finally {
        this.registering = null;
      }
    })();
    this.registering = run;
    return run;
  }

  /** RPC (to `global:main`): `shard` exists. `resync`: it lost its copy of the replicated tables (a restore). */
  async registerShard(shard: string, opts: { resync?: boolean } = {}): Promise<{ registered: boolean; snapshot: boolean }> {
    this.setShardName(REPLICATED_SOURCE);
    // The caller (`registerInCatalog`) logs it and registers again within the hour.
    this.assertNotAhead();
    const r = registerInDirectory(this.driver, this.cfg.schema.manifest, shard, opts);
    if (r.snapshot) {
      this.bcastNew = true;
      this.nextBcastAt = undefined;
      this.armAlarm();
    }
    return r;
  }

  /** RPC (to `global:main`): a page of the catalog (`ctx.shards.list`). */
  async shardDirectory(kind: string, opts: { cursor?: string | null; limit?: number } = {}): Promise<{ shards: Array<{ shard: string; kind: string; key: string; registeredAt: number }>; next: string | null }> {
    this.setShardName(REPLICATED_SOURCE);
    this.assertNotAhead();
    if (kind === "global") return { shards: [{ shard: REPLICATED_SOURCE, kind: "global", key: "main", registeredAt: 0 }], next: null };
    return listDirectory(this.driver, kind, opts);
  }

  /** RPC (admin `POST /api/_ember/replicas/resync`, source `global:main`): resync one target, or all (`null`). */
  async replicaResync(shard: string | null): Promise<{ ok: true; targets: number } | { ok: false; error: string }> {
    this.setShardName(REPLICATED_SOURCE);
    this.assertNotAhead();
    if (!this.replicated.size) return { ok: false, error: "the schema has no .replicated() tables" };
    let targets: number;
    if (shard === null) targets = resyncAllTargets(this.driver, this.cfg.schema.manifest);
    else if (resyncTarget(this.driver, this.cfg.schema.manifest, shard)) targets = 1;
    else return { ok: false, error: `${shard} receives no .replicated() table` };
    this.bcastNew = true;
    this.nextBcastAt = undefined;
    this.armAlarm();
    return { ok: true, targets };
  }

  /** RPC (admin `GET /api/_ember/replicas`, source `global:main`): the log and the targets. */
  async replicaStatus(shard?: string): Promise<unknown> {
    this.setShardName(REPLICATED_SOURCE);
    this.assertNotAhead();
    if (!this.replicated.size) return { enabled: false, journal: 0, seq: 0, targets: [], next: null };
    return broadcastStatus(this.driver, shard ? { target: shard } : {});
  }

  /** `ember dev`: writes per replicated table in the last minute (the cost guard, replica.ts `replicatedWriteAdvice`). */
  private readonly replicatedWrites = new Map<string, number[]>();

  private replicatedAdvice(changes: RowChange[], now: number): void {
    const manifest = this.cfg.schema.manifest;
    let byKind: Record<string, number> | null = null;
    for (const c of changes) {
      if (!this.replicated.has(c.table)) continue;
      const times = (this.replicatedWrites.get(c.table) ?? []).filter((t) => t > now - 60_000);
      times.push(now);
      this.replicatedWrites.set(c.table, times);
      byKind ??= Object.fromEntries(this.driver.exec("SELECT kind, COUNT(*) AS n FROM _ember_shard_directory GROUP BY kind").rows.map((r) => [String(r.kind), Number(r.n)]));
      const targets = replicatedTargets(manifest, byKind).find((x) => x.table === c.table)?.targets ?? 0;
      const advice = replicatedWriteAdvice(c.table, times.length, targets);
      if (advice) this.advise(c.table, "replicated-writes", advice);
    }
  }

  /** One delivery turn of the broadcast log (alarm). One at a time. */
  private drainReplicated(): Promise<void> {
    if (this.bcastDraining) return this.bcastDraining;
    const run = (async () => {
      try {
        const manifest = this.cfg.schema.manifest;
        await drainBroadcast(this.driver, manifest, {
          deliver: async (target, args) => {
            const stub = shardStub(this.env, manifest, target) as unknown as Shard;
            const out = await stub.mutation(target, REPLICA_APPLY_FN, args, null, true);
            if (!out.ok) throw new Error(`${out.error.code}: ${out.error.message}`);
            return out.value as ReplicaApplyResult;
          },
        });
      } catch (e) {
        console.error("ember: replicated tables: drain failed", e);
      } finally {
        this.bcastDraining = null;
        this.nextBcastAt = undefined;
      }
    })();
    this.bcastDraining = run;
    return run;
  }

  // ------------------------------------------------------------------ telemetry (metrics.ts)

  /** Row counters + clock before an engine call; `null` when no metrics output is configured. */
  private probe(): { t: number; r: number; w: number } | null {
    return metricsEnabled(this.env) ? { t: performance.now(), r: this.driver.rowsRead, w: this.driver.rowsWritten } : null;
  }

  private emit(p: { t: number; r: number; w: number } | null, kind: ExecutionKind, fn: string, error: { code: string } | null, bytesOut: (() => number) | undefined, timing: Timing, usage?: Usage): void {
    if (!p) return;
    recordExecution(this.env, {
      fn,
      kind,
      shard: this.shardName,
      status: error ? "error" : "ok",
      ...(error ? { errorCode: error.code } : {}),
      durationMs: performance.now() - p.t,
      rowsRead: this.driver.rowsRead - p.r,
      rowsWritten: this.driver.rowsWritten - p.w,
      ...usageMetrics(usage, error),
      ...(bytesOut ? { bytesOut } : {}),
      timing,
    });
  }

  /**
   * Mutation points (`timing: "commit"`): written once the batch is durable, so the duration is receipt → durable
   * commit (the DO clock advances on that storage I/O; the synchronous transaction alone would read 0 ms).
   */
  private emitAfterCommit(kind: ExecutionKind, all: Array<{ fn: string; at: number; error: { code: string } | null; rowsRead: number; rowsWritten: number; bytesOut?: () => number; usage?: Usage | undefined }>): void {
    if (!all.length || !metricsEnabled(this.env)) return;
    // Sampled first: when every point is dropped, nothing waits for the commit (the object is not kept awake for it).
    const trace = this.env.EMBER_TRACE === "1";
    const items = all.map((it) => ({ it, sampled: sampleExecution(this.env, it.error !== null) })).filter((x) => x.sampled || trace);
    if (!items.length) return;
    const done = this.ctx.storage.sync().then(
      () => Date.now(),
      () => Date.now(),
    );
    this.ctx.waitUntil(
      done.then((end) => {
        for (const { it, sampled } of items) {
          recordExecution(this.env, {
            sampled,
            fn: it.fn,
            kind,
            shard: this.shardName,
            status: it.error ? "error" : "ok",
            ...(it.error ? { errorCode: it.error.code } : {}),
            durationMs: Math.max(0, end - it.at),
            rowsRead: it.rowsRead,
            rowsWritten: it.rowsWritten,
            ...usageMetrics(it.usage, it.error),
            ...(it.bytesOut ? { bytesOut: it.bytesOut } : {}),
            timing: "commit",
          });
        }
      }),
    );
  }

  /** Upsert this shard into the registry catalog (after a migration, and hourly from maintenance). */
  private async reportCatalog(force: boolean): Promise<void> {
    if (!this.env.EMBER_REGISTRY) return;
    if (!this.shardName) {
      if (force) this.setMeta("catalog_due", "1");
      return;
    }
    const now = Date.now();
    const at = this.getMeta("catalog_at");
    if (!catalogDue(at === null ? null : Number(at), now, force || this.getMeta("catalog_due") !== null)) return;
    if (this.lastWrite !== null) this.setMeta("last_write", String(this.lastWrite));
    const lw = this.getMeta("last_write");
    const ok = await reportShard(this.env, {
      shard: this.shardName,
      schemaVersion: this.getMeta("schema_version"),
      dbSize: this.ctx.storage.sql.databaseSize,
      lastWrite: lw === null ? null : Number(lw),
    }, now);
    if (ok) {
      this.setMeta("catalog_at", String(now));
      this.deleteMeta("catalog_due");
    } else if (this.getMeta("catalog_due") === null) this.setMeta("catalog_due", "1"); // retried by the next tick
  }

  private async recordBookmark(reason: string): Promise<BookmarkRow | null> {
    try {
      const bookmark = await this.ctx.storage.getCurrentBookmark();
      const at = Date.now();
      const r = this.driver.exec("INSERT INTO _ember_bookmarks(at, bookmark, reason) VALUES (?, ?, ?) RETURNING id", at, bookmark, reason).rows[0];
      return { id: Number(r?.id), at, bookmark, reason };
    } catch {
      // PITR may be unavailable (e.g. some local backends); bookmarks are best effort.
      return null;
    }
  }

  // ------------------------------------------------------------------ query cache
  //
  // An entry is one (fn, args) result, keyed by a scope: `*` (shared) when its runs never read the identity, so the
  // value is every caller's, or `i:<identity>` (own) when its last run read it. A shared entry whose re-run reads the
  // identity (a data-dependent branch) is split back into own entries before anything is sent; an own entry whose
  // re-run no longer reads it becomes the shared one. Queries declared with `authorize` also have a gate per
  // (fn, args, identity): the check's outcome, with its own read set. A subscriber receives the entry's value only
  // while its gate passes; while it fails it holds the gate's error.

  /** Functions declared with `authorize` (functionInfo builds an object per call: cached per function). */
  private readonly authorizeOf = new Map<string, boolean>();

  private hasAuthorize(fn: string): boolean {
    let a = this.authorizeOf.get(fn);
    if (a === undefined) this.authorizeOf.set(fn, (a = this.engine.functionInfo(fn)?.authorize === true));
    return a;
  }

  /** The claim a `fromAuth` query's shard key comes from (null: none), cached like `authorizeOf`. */
  private readonly claimOf = new Map<string, string | null>();

  /**
   * Key of a caller's gate: its identity and, for a `fromAuth` query, the claim's value (a token whose claim changed,
   * same subject, is checked again instead of passing on the old claim's gate).
   */
  private gateKey(fn: string, args: unknown, identity: Identity | null): string {
    let claim = this.claimOf.get(fn);
    if (claim === undefined) this.claimOf.set(fn, (claim = this.engine.functionInfo(fn)?.claim ?? null));
    const tail = claim === null ? "" : `\u0001${claimKey(identity?.claims, claim) ?? ""}`;
    return `\u0002${this.entryBase(fn, args)}${identityKey(identity)}${tail}`;
  }

  private entryBase(fn: string, args: unknown): string {
    return `${fn}\u0000${stableStringify(args)}\u0000`;
  }

  /** The cached value for this caller, or undefined: own entry, else the shared one; either behind a passing check. */
  private cachedValue(fn: string, args: unknown, ctx: AuthCtx): { value: unknown; readSet: ReadSet | null; entry: QueryEntry } | undefined {
    const base = this.entryBase(fn, args);
    const own = this.queries.get(`${base}i:${identityKey(ctx.identity)}`);
    const shared = this.queries.get(`${base}*`);
    const hit = own && !own.error ? own : shared && !shared.error ? shared : undefined;
    if (!hit) return undefined;
    if (this.hasAuthorize(fn)) {
      const gate = this.gates.get(this.gateKey(fn, args, ctx.identity));
      // No live gate for this caller: run the check now (throws when it refuses).
      if (!gate || gate.error) this.engine.runQuery(fn, args, ctx, { phase: "authorize" });
    }
    return { value: hit.value, readSet: hit.readSet, entry: hit };
  }

  /**
   * Registers a subscriber of (fn, args) under `identity`: the entry it reads (run when missing or errored) and, for
   * a query with `authorize`, its gate.
   */
  private bind(sid: string, qid: Id, fn: string, args: unknown, identity: Identity | null): { entry: QueryEntry; gate: GateEntry | undefined } {
    const ctx: AuthCtx = { identity };
    const gate = this.hasAuthorize(fn) ? this.gateFor(fn, args, ctx) : undefined;
    const entry = this.entryFor(fn, args, ctx);
    let m = this.subs.get(sid);
    if (!m) this.subs.set(sid, (m = new Map()));
    const qk = qidKey(qid);
    const sub: Sub = { sid, qid, qk, qidJson: stringify(qid), key: entry.key, ...(gate ? { gate: gate.key } : {}) };
    m.set(qk, sub);
    const s = `${sid}\n${qk}`;
    entry.subs.set(s, sub);
    gate?.subs.set(s, sub);
    return { entry, gate };
  }

  /**
   * The subscriber registered now under `held`'s socket and qid (what `subs` holds, as every delivery reads it), or
   * undefined once it was detached.
   */
  private liveSub(held: Sub): Sub | undefined {
    return this.subs.get(held.sid)?.get(held.qk);
  }

  /** The entry a caller reads: shared, else its own; a missing or errored one is run for it now. */
  private entryFor(fn: string, args: unknown, ctx: AuthCtx): QueryEntry {
    const base = this.entryBase(fn, args);
    const shared = this.queries.get(`${base}*`);
    if (shared && !shared.error) return shared;
    const ownKey = `${base}i:${identityKey(ctx.identity)}`;
    const own = this.queries.get(ownKey);
    if (own && !own.error) return own;
    const r = this.takePrefetched(fn, args, ctx) ?? this.run(fn, args, ctx);
    const out = this.delivery();
    let entry: QueryEntry;
    if (!r.identityRead) {
      // The same for every caller: the shared entry (an errored one is updated; its subscribers get the value).
      entry = shared ?? this.newEntry(`${base}*`, fn, args, ANON, true);
      const before = snapshotOf(entry);
      this.store(entry, r);
      if (entry.subs.size && entry.json !== before.json) this.deliverChanged(out, entry, before);
      if (own) this.moveSubs(own, entry, snapshotOf(own), out);
    } else {
      entry = own ?? this.newEntry(ownKey, fn, args, ctx, false);
      const before = snapshotOf(entry);
      this.store(entry, r);
      if (entry.subs.size && entry.json !== before.json) this.deliverChanged(out, entry, before);
    }
    this.deliverFlush(out, this.version);
    return entry;
  }

  /** HTTP query runs waiting for the `sub` that follows them (`Prefetched`), oldest first. */
  private readonly prefetched = new Map<string, Prefetched>();

  /**
   * The whole verified identity (subject, issuer, claims, `exp`/`iat`), not just `identityKey`: a run is handed only to
   * a `sub` under the very same token's identity, never to another session or claim set of the same subject.
   */
  private prefetchKey(fn: string, args: unknown, identity: Identity | null): string {
    return `${this.entryBase(fn, args)}${stableStringify(identity ?? null)}`;
  }

  /**
   * A query for an HTTP caller whose subscription follows (`warm`): `authorize` (when declared) then the handler phase,
   * as the subscription runs them, and the handler's result kept for that `sub` (`takePrefetched`). Throws like
   * `engine.runQuery` (the caller's error).
   */
  private prefetchRun(fn: string, args: unknown, ctx: AuthCtx): { value: unknown; readSet: ReadSet; usage?: Usage } {
    const gated = this.hasAuthorize(fn);
    if (gated) this.engine.runQuery(fn, args, ctx, { phase: "authorize" });
    const touched = new Set<string>();
    const track = { read: false };
    const r = this.engine.runQuery(fn, args, ctx, { touched, identity: track, ...(gated ? { phase: "handler" as const } : {}), nested: this.nestedMemo() });
    // Only what a later commit can be checked against: a read set the change log alone confirms (`resumable`).
    if (this.resumable(r.readSet, this.version, undefined)) {
      const now = Date.now();
      for (const [k, p] of this.prefetched) {
        if (this.prefetched.size < PREFETCH_MAX && now - p.at <= PREFETCH_TTL_MS) break;
        this.prefetched.delete(k);
      }
      const key = this.prefetchKey(fn, args, ctx.identity);
      this.prefetched.delete(key);
      this.prefetched.set(key, { value: r.value, readSet: r.readSet, touched, identityRead: track.read, version: this.version, epoch: this.epoch, gen: this.memoGen, at: now });
    }
    return r;
  }

  /**
   * The run an HTTP query of this caller left (`prefetchRun`), once, if it is still current: same epoch and memo
   * generation, under `PREFETCH_TTL_MS` old, and nothing it read changed since its version (the change log covers
   * them all). Undefined otherwise (the `sub` runs the query).
   */
  private takePrefetched(fn: string, args: unknown, ctx: AuthCtx): RunOutcome | undefined {
    if (!this.prefetched.size || ctx.system) return undefined;
    const key = this.prefetchKey(fn, args, ctx.identity);
    const p = this.prefetched.get(key);
    if (!p) return undefined;
    this.prefetched.delete(key);
    if (p.epoch !== this.epoch || p.gen !== this.memoGen || Date.now() - p.at > PREFETCH_TTL_MS || p.version > this.version) return undefined;
    if (p.version !== this.version) {
      const changes = this.changesSince(p.version);
      if (changes === null || (changes.length && this.engine.matches(p.readSet, changes))) return undefined;
    }
    this.stats.prefetchHits++;
    const { json, docs, fields } = encodeParts(p.value);
    return { value: p.value, json, docs, fields, readSet: p.readSet, error: null, touched: p.touched, identityRead: p.identityRead };
  }

  private newEntry(key: string, fn: string, args: unknown, ctx: AuthCtx, shared: boolean): QueryEntry {
    const entry: QueryEntry = { key, fn, args, ctx, shared, value: undefined, json: "", docs: null, fields: null, readSet: null, error: null, subs: new Map() };
    this.queries.set(key, entry);
    return entry;
  }

  /** Nested query results shared by every run at one shard version (`NestedQueryMemo`); `memoGen`: dropped early. */
  private memoState: { version: number; gen: number; memo: NestedQueryMemo } | null = null;
  private memoGen = 0;

  private nestedMemo(): NestedQueryMemo {
    const m = this.memoState;
    if (m && m.version === this.version && m.gen === this.memoGen) return m.memo;
    const memo = new NestedQueryMemo();
    this.memoState = { version: this.version, gen: this.memoGen, memo };
    return memo;
  }

  /** One run of (fn, args) as `ctx` (the handler phase for a query with `authorize`), without touching any entry. */
  private run(fn: string, args: unknown, ctx: AuthCtx): RunOutcome {
    const touched = new Set<string>();
    const track = { read: false };
    const p = this.probe();
    const phase = this.hasAuthorize(fn) ? { phase: "handler" as const } : {};
    const profile = this.devPerf ? newQueryProfile() : undefined;
    const read0 = this.driver.rowsRead;
    const nested = this.nestedMemo();
    const hits0 = nested.hits;
    let out: RunOutcome;
    let usage: Usage | undefined;
    try {
      const r = this.engine.runQuery(fn, args, ctx, { touched, identity: track, ...phase, ...(profile ? { profile } : {}), nested });
      const { json, docs, fields } = encodeParts(r.value);
      this.emit(p, "subscription", fn, null, () => json.length, "none", r.usage);
      if ("usage" in r) usage = r.usage;
      this.limitAdvice(fn, usage);
      out = { value: r.value, json, docs, fields, readSet: r.readSet, error: null, touched, identityRead: track.read };
    } catch (e) {
      const error = errInfo(e, "Error");
      this.emit(p, "subscription", fn, error, undefined, "none");
      out = { value: undefined, json: `\u0000error:${stringify(error)}`, docs: null, fields: null, readSet: null, error, touched, identityRead: track.read };
    }
    if (track.read) this.stats.identityRuns++;
    this.stats.nestedReused += nested.hits - hits0;
    if (profile) {
      out.perf = { read: this.driver.rowsRead - read0, returned: returnedOf(out.value), profile };
      this.perfAdvice(fn, out.perf, track.read, usage);
    }
    return out;
  }

  // ------------------------------------------------------------------ `ember dev` feedback (EMBER_DEV_PERF)

  /** Set by `ember dev`: per-commit re-run summaries and performance advice on the console. */
  private get devPerf(): boolean {
    return this.env.EMBER_DEV_PERF === "1";
  }
  /** Re-run counters for the dashboard's reactivity screen (reactivity.ts). */
  private readonly rx = new ReactivityLog();
  /** Advice already given, per `${fn}\0${kind}` (once per object instance). */
  private readonly advised = new Set<string>();

  private advise(fn: string, kind: string, message: string): void {
    const k = `${fn}\u0000${kind}`;
    if (this.advised.has(k)) return;
    this.advised.add(k);
    console.warn(`ember perf: ${fn}: ${message}`);
  }

  private perfAdvice(fn: string, perf: NonNullable<RunOutcome["perf"]>, identityRead: boolean, usage?: Usage): void {
    // The same rules the dashboard's reactivity screen shows (reactivity.ts).
    for (const a of queryAdvice(perf, identityRead, usage)) this.advise(fn, a.counter ? `limits:${a.counter}` : a.kind, a.message);
  }

  /** `ember dev`: a mutation (or job) that used 70% of a limit (the same text as the dashboard's). */
  private limitAdvice(fn: string, usage: Usage | undefined): void {
    if (!usage || !this.devPerf) return;
    for (const a of limitWarnings(usageFractions(usage))) this.advise(fn, `limits:${a.counter}`, a.message);
  }

  /** One console line per commit that re-ran queries: which entries, their cost, and the change that hit each. */
  private perfSummary(version: number, lines: Array<{ entry: QueryEntry; perf: RunOutcome["perf"] | undefined; hit: string | undefined; changed: boolean }>, ms: number, reused = 0): void {
    if (!lines.length) return;
    const shown = lines.slice(0, 6).map(({ entry, perf, hit, changed }) => {
      const args = stableStringify(entry.args);
      const scope = entry.shared ? `shared by ${entry.subs.size}` : `per user (${entry.subs.size})`;
      const cost = perf ? ` read ${perf.read}/returned ${perf.returned}` : "";
      return `  ${entry.fn}(${args.length > 60 ? `${args.slice(0, 57)}...` : args}) ${scope}${cost}${changed ? "" : " unchanged"}${hit ? ` <- ${hit}` : ""}`;
    });
    if (lines.length > 6) shown.push(`  ... and ${lines.length - 6} more`);
    const nested = reused ? ` (a shared ctx.runQuery reused ${reused}×)` : "";
    console.log(`ember perf: v${version} re-ran ${lines.length} quer${lines.length === 1 ? "y" : "ies"} in ${ms.toFixed(1)} ms${nested}\n${shown.join("\n")}`);
  }

  /** The first change of a commit that falls in `entry`'s read set (`table id (index)`), for the summary. */
  private hitOf(entry: QueryEntry, changes: RowChange[] | undefined): string | undefined {
    if (!changes || !entry.readSet) return undefined;
    for (const c of changes) {
      if (!this.engine.matches(entry.readSet, [c])) continue;
      const op = !c.before ? "insert" : !c.after ? "delete" : "update";
      const idx = entry.readSet.find((e) => e.table === c.table)?.index;
      return `${op} ${c.table} ${c.id}${idx ? ` (${idx})` : ""}`;
    }
    return undefined;
  }

  /** Puts a run into `entry` and (re)registers it in the read-set index. */
  private store(entry: QueryEntry, r: RunOutcome): void {
    if (this.unbumpedPass && r.json !== entry.json) entry.unbumpedAt = this.version;
    let known = this.knownTables.get(entry.fn);
    if (!known) this.knownTables.set(entry.fn, (known = new Set()));
    entry.value = r.value;
    entry.json = r.json;
    entry.docs = r.docs;
    entry.fields = r.fields;
    entry.readSet = r.readSet;
    // A new read set (a debounced re-run moves none of the versions): its resume answers are recomputed.
    this.resumeMemo.byEntry.delete(entry);
    entry.error = r.error;
    if (r.readSet) {
      for (const e of r.readSet) known.add(e.table);
      this.index.set(entry.key, r.readSet);
    } else {
      // No read set: re-run only on commits touching tables this function is known to read (what this run opened
      // before failing, plus what any earlier run of it read). Failing before any read = only re-sub / index-ready.
      this.index.set(entry.key, null, [...r.touched, ...known]);
    }
    for (const t of r.touched) known.add(t);
  }

  /** The gate of (fn, args) for `ctx`: run when missing or failing (a new subscriber re-checks). */
  private gateFor(fn: string, args: unknown, ctx: AuthCtx): GateEntry {
    const key = this.gateKey(fn, args, ctx.identity);
    let gate = this.gates.get(key);
    if (gate && !gate.error) return gate;
    if (!gate) this.gates.set(key, (gate = { key, fn, args, ctx, error: null, subs: new Map() }));
    this.runGate(gate);
    return gate;
  }

  /**
   * Runs a gate's check and registers its read set. A refusal the app's code threw (an application error, or
   * `Unauthenticated` from `ctx.auth.require()`) keeps the reads made before it: they decided it, and user code never
   * throws in the middle of a scan. Any other failure falls back to the tables it read, as for a failing query.
   */
  private runGate(gate: GateEntry): void {
    const touched = new Set<string>();
    const readSet: ReadSet = [];
    const knownKey = `\u0002${gate.fn}`;
    let known = this.knownTables.get(knownKey);
    if (!known) this.knownTables.set(knownKey, (known = new Set()));
    this.stats.gateRuns++;
    try {
      this.engine.runQuery(gate.fn, gate.args, gate.ctx, { touched, phase: "authorize", readSet, nested: this.nestedMemo() });
      gate.error = null;
      for (const e of readSet) known.add(e.table);
      this.index.set(gate.key, readSet);
    } catch (e) {
      gate.error = errInfo(e, "Error");
      if (gate.error.kind === "app" || gate.error.code === "Unauthenticated") this.index.set(gate.key, readSet);
      else this.index.set(gate.key, null, [...touched, ...known]);
    }
    for (const t of touched) known.add(t);
  }

  /** Moves every subscriber of `from` (holding `before`) to `to`, delivering `to`'s value; `from` is forgotten. */
  private moveSubs(from: QueryEntry, to: QueryEntry, before: EntrySnapshot, out: Delivery): void {
    for (const [s, held] of from.subs) {
      const sub = this.liveSub(held);
      if (!sub) continue;
      sub.key = to.key;
      to.subs.set(s, sub);
      this.deliverOne(out, sub, to, before);
    }
    from.subs.clear();
    this.forget(from.key);
  }

  /**
   * A shared entry whose re-run read the identity: its value is no longer everyone's. Each subscriber moves to the
   * own entry of its identity, run now (an existing one too, so the moved subscribers and its own share one fresh
   * value), and gets that value as a change from the shared one it held.
   */
  /** Returns how many of the per-user runs changed the value their subscribers had (the reactivity report). */
  private split(entry: QueryEntry, before: EntrySnapshot, out: Delivery, done: Set<QueryEntry>): number {
    this.stats.splits++;
    let changed = 0;
    const groups = new Map<string, { identity: Identity | null; subs: Array<[string, Sub]> }>();
    for (const [s, held] of entry.subs) {
      const identity = this.attachments.get(held.sid)?.identity ?? null;
      const k = identityKey(identity);
      let g = groups.get(k);
      if (!g) groups.set(k, (g = { identity, subs: [] }));
      g.subs.push([s, held]);
    }
    entry.subs.clear();
    this.forget(entry.key);
    const base = this.entryBase(entry.fn, entry.args);
    for (const [k, g] of groups) {
      const ownKey = `${base}i:${k}`;
      let own = this.queries.get(ownKey);
      const ownBefore = own ? snapshotOf(own) : null;
      own ??= this.newEntry(ownKey, entry.fn, entry.args, { identity: g.identity }, false);
      // Always its own entry now (even if this run does not read the identity: the next re-run promotes it).
      this.store(own, this.run(entry.fn, entry.args, own.ctx));
      const differs = own.json !== (ownBefore ?? before).json;
      this.rx.ran(own, differs);
      if (differs) changed++;
      done.add(own);
      if (ownBefore && own.subs.size) this.deliverChanged(out, own, ownBefore);
      for (const [s, held] of g.subs) {
        const sub = this.liveSub(held);
        if (!sub) continue;
        sub.key = own.key;
        own.subs.set(s, sub);
        // One reopened by its gate in this pass gets the full value at the end of it, once.
        if (!out.skip.has(s)) this.deliverOne(out, sub, own, before);
      }
    }
    return changed;
  }

  /** An own entry whose run did not read the identity becomes the shared entry (when there is none). */
  private promote(entry: QueryEntry): void {
    const sharedKey = `${this.entryBase(entry.fn, entry.args)}*`;
    if (this.queries.has(sharedKey)) return;
    this.queries.delete(entry.key);
    this.index.delete(entry.key);
    this.debounced.delete(entry.key);
    entry.key = sharedKey;
    entry.shared = true;
    entry.ctx = ANON;
    this.queries.set(sharedKey, entry);
    if (entry.readSet) this.index.set(sharedKey, entry.readSet);
    else this.index.set(sharedKey, null, this.knownTables.get(entry.fn) ?? []);
    for (const held of entry.subs.values()) {
      const sub = this.liveSub(held);
      if (sub) sub.key = sharedKey;
    }
  }

  private detach(sid: string, qid: Id): boolean {
    const m = this.subs.get(sid);
    const qk = qidKey(qid);
    const sub = m?.get(qk);
    if (!m || !sub) return false;
    m.delete(qk);
    if (!m.size) this.subs.delete(sid);
    const s = `${sid}\n${qk}`;
    if (this.dormant.delete(s)) return true;
    const entry = this.queries.get(sub.key);
    if (entry) {
      entry.subs.delete(s);
      if (!entry.subs.size) this.forget(entry.key);
    }
    const gate = sub.gate ? this.gates.get(sub.gate) : undefined;
    if (gate) {
      gate.subs.delete(s);
      if (!gate.subs.size) {
        this.gates.delete(gate.key);
        this.index.delete(gate.key);
      }
    }
    return true;
  }

  private forget(key: string): void {
    this.queries.delete(key);
    this.index.delete(key);
    this.debounced.delete(key);
  }

  private dropSocket(sid: string): void {
    // `tableSubs` mirrors the socket's `_ember_subs` rows (rebuilt from them at boot): none, no DELETE.
    const hadRows = this.tableSubs.has(sid);
    for (const sub of [...(this.subs.get(sid)?.values() ?? [])]) this.detach(sid, sub.qid);
    this.sockets.delete(sid);
    this.attachments.delete(sid);
    this.ackedSockets.delete(sid);
    this.expiredNotified.delete(sid);
    this.chains.delete(sid);
    this.tableSubs.delete(sid);
    // Out of its channels: the other members are told.
    this.eph.drop(sid);
    // A shard refused by RuntimeSchemaTooNew rebuilt no subscription: nothing of this socket is in `_ember_subs`.
    if (!this.runtimeAhead && hadRows) this.driver.exec("DELETE FROM _ember_subs WHERE sock = ?", sid);
  }

  /**
   * Re-run the queries whose read sets `changes` may affect (read-set index, exact matches) and send one `patch`
   * per socket, listing that socket's mutations included in `version`. Loose matches (a write to a searched table
   * that cannot change the result set, only its bm25 order) are debounced. `force` re-runs only errored entries
   * and failing gates (e.g. a staged index became ready).
   */
  private publish(version: number, changes: RowChange[], mids?: Map<string, Id[]>, force = false): void {
    if (!changes.length && !force) return;
    // The commit's changes, as `changesSince` would parse them from the change log: a resume needs no read for them.
    if (changes.length && version === this.version) this.rememberChanges(version, changes);
    // Something changed without a commit (an index became ready): nested results are not reused across it.
    if (force) this.memoGen++;
    let stale: QueryEntry[];
    let gates: GateEntry[];
    if (force) {
      stale = [...this.queries.values()].filter((e) => e.error !== null);
      gates = [...this.gates.values()].filter((g) => g.error !== null);
    } else {
      const { exact, loose } = this.index.match(changes);
      stale = [];
      gates = [];
      for (const k of exact) {
        if (k.charCodeAt(0) === 2) {
          const g = this.gates.get(k);
          if (g) gates.push(g);
          else this.index.delete(k);
          continue;
        }
        const e = this.queries.get(k);
        if (e) stale.push(e);
        else this.index.delete(k);
      }
      if (loose.size) this.debounce(loose);
    }
    this.rerun(stale, version, mids, false, gates, this.devPerf ? changes : undefined, force);
  }

  /** Set while a re-run changes values without a new shard version (debounced, forced): see `QueryEntry.unbumpedAt`. */
  private unbumpedPass = false;

  /**
   * Whether a value held "as of" `version` can be confirmed by the change log alone: not when the query reads an
   * index kind whose results move without commits (search rank, external vector/AI indexes), nor when the entry's
   * value changed without a commit at or after that version.
   */
  private resumable(readSet: ReadSet, version: number, entry: QueryEntry | undefined): boolean {
    if (entry?.unbumpedAt !== undefined && version <= entry.unbumpedAt) return false;
    // Job state (`ctx.scheduler.get/list`) is not in the change log.
    for (const e of readSet) if (e.kind !== "db" || e.table === JOBS_TABLE) return false;
    return true;
  }

  /** Re-runs `gates` then `entries`, and sends the changed values (and `mids`) as one patch per socket. */
  private rerun(entries: QueryEntry[], version: number, mids?: Map<string, Id[]>, debounced = false, gates: GateEntry[] = [], changes?: RowChange[], forced = false): void {
    const wasUnbumped = this.unbumpedPass;
    this.unbumpedPass = debounced || forced;
    try {
      this.rerunPass(entries, version, mids, debounced, gates, changes);
    } finally {
      this.unbumpedPass = wasUnbumped;
    }
  }

  private rerunPass(entries: QueryEntry[], version: number, mids: Map<string, Id[]> | undefined, debounced: boolean, gates: GateEntry[], changes: RowChange[] | undefined): void {
    const out = this.delivery();
    const perf = this.devPerf ? { t0: performance.now(), lines: [] as Parameters<Shard["perfSummary"]>[1], reused0: this.stats.nestedReused } : null;
    const rx = { t0: performance.now(), changed: 0 };
    // Gates first: a subscriber whose check now refuses gets the error (and no value); one admitted again gets the
    // full value once its entry is fresh.
    const reopened: Array<[string, Sub]> = [];
    for (const gate of gates) {
      if (!gate.subs.size) {
        this.gates.delete(gate.key);
        this.index.delete(gate.key);
        continue;
      }
      const was = gate.error;
      this.runGate(gate);
      if (gate.error) {
        if (was && was.code === gate.error.code && was.message === gate.error.message) continue;
        for (const held of gate.subs.values()) this.deliverError(out, held, gate.error);
      } else if (was) for (const entry of gate.subs) reopened.push(entry);
    }
    for (const [s] of reopened) out.skip.add(s);
    const done = new Set<QueryEntry>();
    for (const entry of entries) {
      if (done.has(entry) || this.queries.get(entry.key) !== entry) continue;
      if (!entry.subs.size) {
        this.forget(entry.key);
        continue;
      }
      done.add(entry);
      // The re-run makes the result fresh, rank included.
      this.debounced.delete(entry.key);
      const before = snapshotOf(entry);
      const hit = perf ? this.hitOf(entry, changes) : undefined;
      const r = this.run(entry.fn, entry.args, entry.ctx);
      if (debounced) this.stats.debouncedReruns++;
      else this.stats.reruns++;
      if (entry.shared && r.identityRead) {
        rx.changed += this.split(entry, before, out, done);
        continue;
      }
      this.store(entry, r);
      if (!entry.shared && !r.identityRead) this.promote(entry);
      this.rx.ran(entry, entry.json !== before.json);
      if (entry.json !== before.json) rx.changed++;
      if (entry.json !== before.json) this.deliverChanged(out, entry, before);
      perf?.lines.push({ entry, perf: r.perf, hit, changed: entry.json !== before.json });
    }
    for (const [s, held] of reopened) {
      const sub = this.liveSub(held);
      const entry = sub && this.queries.get(sub.key);
      if (entry) this.deliverOne(out, sub, entry, null, true);
    }
    this.deliverFlush(out, version, mids);
    this.rx.commit({ version, at: Date.now(), reran: done.size, changed: rx.changed, ms: performance.now() - rx.t0 });
    if (perf) this.perfSummary(version, perf.lines, performance.now() - perf.t0, this.stats.nestedReused - perf.reused0);
  }

  // Delivery of one pass (a commit, a new subscriber's run): changes per socket, sent as one patch each at the end.

  private delivery(): Delivery {
    return { perSocket: new Map(), skip: new Set() };
  }

  /** Every subscriber of `entry` gets its new value (a row diff from `before` when it can). */
  private deliverChanged(out: Delivery, entry: QueryEntry, before: EntrySnapshot): void {
    for (const [s, held] of entry.subs) {
      if (out.skip.has(s)) continue;
      const sub = this.liveSub(held);
      if (sub) this.deliverOne(out, sub, entry, before);
    }
  }

  /**
   * One subscriber (live: `liveSub`) gets `entry`'s value: unless its socket expired or its gate refuses (it holds the
   * gate's error until the gate passes again). `before`: the value it holds (a row diff from it when the socket
   * speaks "rowdiff"); null or `full`: the whole value.
   */
  private deliverOne(out: Delivery, sub: Sub, entry: QueryEntry, before: EntrySnapshot | null, full = false): void {
    const sid = sub.sid;
    if (this.expiredSocket(sid)) return;
    if (sub.gate && this.gates.get(sub.gate)?.error) return;
    if (entry.error) {
      const ws = this.sockets.get(sid);
      if (ws) this.send(ws, { t: "err", ...entry.error, qid: sub.qid });
      return;
    }
    let list = out.perSocket.get(sid);
    if (!list) out.perSocket.set(sid, (list = []));
    // Row diffs are computed from the value the subscriber last received (only when that was a success); a value
    // diff likewise, for an object holding arrays of documents (feature "vdiff"). Each once per entry and base.
    if (!full && before && before.error === null) {
      const att = this.attachments.get(sid);
      const rows = before.docs && entry.docs && att?.rowdiff;
      if (rows || (before.fields && entry.fields && att?.vdiff)) {
        let cached = out.diffs?.get(entry);
        if (!cached || cached.from !== before) {
          const json = rows
            ? rowDiffJson(before.value as Array<Record<string, unknown>>, before.docs!, entry.value as Array<Record<string, unknown>>, entry.docs!, entry.json)
            : valueDiffJson(before.value, before, entry.value, entry);
          cached = { from: before, json };
          (out.diffs ??= new Map()).set(entry, cached);
        }
        if (cached.json !== null) {
          list.push(`{"qid":${sub.qidJson},"${rows ? "diff" : "vdiff"}":${cached.json}}`);
          return;
        }
      }
    }
    // Keep the old object encoder's omission of undefined properties; all other values splice cached wire JSON.
    list.push(entry.value === undefined ? `{"qid":${sub.qidJson}}` : `{"qid":${sub.qidJson},"value":${entry.json}}`);
  }

  /** A subscriber whose gate now refuses: the error, for its qid. */
  private deliverError(_out: Delivery, held: Sub, error: WireError): void {
    const sub = this.liveSub(held);
    const sid = held.sid;
    if (!sub || this.expiredSocket(sid)) return;
    const ws = this.sockets.get(sid);
    if (ws) this.send(ws, { t: "err", ...error, qid: sub.qid });
  }

  private deliverFlush(out: Delivery, version: number, mids?: Map<string, Id[]>): void {
    for (const [sid, list] of out.perSocket) {
      const ws = this.sockets.get(sid);
      if (!ws) continue;
      // Most sockets got no mutation outcome in this commit: the literal, not an empty array stringified per socket.
      const m = mids?.get(sid);
      this.send(ws, `{"t":"patch","version":${version},"changes":[${list.join(",")}],"mids":${m ? stringify(m) : "[]"}}`);
    }
  }

  /**
   * Search rank drift (PLAN §4): a debounced re-run within `reactivity.searchDebounceMs` (default 2 s) of the first
   * loose write, not pushed back by later ones, so a result's order is never more than that stale.
   */
  private debounce(keys: Iterable<string>): void {
    const ms = this.cfg.reactivity?.searchDebounceMs ?? DEFAULT_SEARCH_DEBOUNCE_MS;
    for (const k of keys) this.debounced.add(k);
    if (ms <= 0) return this.flushDebounced();
    if (!this.debounceTimer) this.debounceTimer = setTimeout(() => this.flushDebounced(), ms);
  }

  private flushDebounced(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    const entries = [...this.debounced].map((k) => this.queries.get(k)).filter((e): e is QueryEntry => !!e && !e.error);
    this.debounced.clear();
    if (entries.length) this.rerun(entries, this.version, undefined, true);
  }

  /**
   * True when the socket's identity has expired (checked at patch time): its patches stop, and it is told
   * `authExpired` once until it sends `auth`.
   */
  private expiredSocket(sid: string): boolean {
    const att = this.attachments.get(sid);
    if (!att || !(isExpired(att.identity) || this.isRevoked(att.identity))) return false;
    if (!this.expiredNotified.has(sid)) {
      this.expiredNotified.add(sid);
      const ws = this.sockets.get(sid);
      if (ws) this.send(ws, { t: "authExpired" });
    }
    return true;
  }

  private send(ws: WebSocket, m: ServerMessage | string): void {
    const frame = typeof m === "string" ? m : encodeServerMessage(m);
    if (!this.batching.has(ws)) return this.sendFrame(ws, frame);
    // Feature "batch": what this turn sends to the socket goes out as one frame, at the end of the turn.
    let q = this.outbox.get(ws);
    if (q && q.bytes + frame.length > MAX_BATCH_BYTES) {
      this.flushSocket(ws);
      q = undefined;
    }
    if (!q) {
      this.outbox.set(ws, (q = { frames: [], bytes: 2 }));
      if (!this.outboxScheduled) {
        this.outboxScheduled = true;
        queueMicrotask(() => this.flushSockets());
      }
    }
    q.frames.push(frame);
    q.bytes += frame.length + 1;
    if (q.frames.length >= MAX_BATCH_MESSAGES) this.flushSocket(ws);
  }

  private sendFrame(ws: WebSocket, frame: string): void {
    // Feature "zframe": a large frame goes compressed; one behind a compression still running waits for it (in order).
    if (this.zframes.has(ws) && (frame.length > ZFRAME_MIN_CHARS || this.zsending.has(ws))) return this.sendCompressed(ws, frame);
    try {
      ws.send(frame);
    } catch {
      // socket already closed
    }
  }

  /** Sockets that negotiated feature "zframe" (from `hello`, or their attachment after a wake). */
  private readonly zframes = new WeakSet<WebSocket>();
  /**
   * Where this object runs (RUM, colo.ts): settled by the environment, or probed when a sampled client asks (a failed
   * probe is retried after a backoff, by a later RUM socket). In memory only.
   */
  private coloCache: ColoCache | null = null;

  /** This object's colo for a RUM socket: known → returned; else probed, then sent as `{t:"colo"}` to RUM sockets. */
  private coloFor(): string | null {
    this.coloCache ??= new ColoCache(this.env as { EMBER_COLO?: unknown; EMBER_ENV?: unknown });
    return this.coloCache.get((c) => {
      for (const ws of this.ctx.getWebSockets()) {
        const att = ws.deserializeAttachment() as Attachment | null;
        if (att?.rum) this.send(ws, { t: "colo", colo: c });
      }
    });
  }
  /** Per "zframe" socket, the last frame still being compressed (or waiting behind one): what comes after waits. */
  private readonly zsending = new Map<WebSocket, Promise<void>>();

  /**
   * Feature "zframe": `frame` as a binary message of its raw-DEFLATE bytes when it is large (as text when that is not
   * smaller), sent after every frame queued before it. The compression runs at once; the event is kept alive until the
   * frame went out (`waitUntil`), so a hibernation never drops it.
   */
  private sendCompressed(ws: WebSocket, frame: string): void {
    const bytes = frame.length > ZFRAME_MIN_CHARS ? deflateFrame(frame).catch(() => null) : null;
    const before = this.zsending.get(ws);
    const cut = this.zcut.get(ws) ?? 0;
    const sent = (before ?? Promise.resolve()).then(async () => {
      const z = bytes && (await bytes);
      // Closed meanwhile (revoked, restored): what was being compressed for it is dropped, never sent after the close.
      if (this.zclosed.has(ws)) return;
      // Its access expired meanwhile (`revokeSockets` without `close`): the subscription values in it (`snap`, `patch`)
      // were produced for the identity that just lost access and are dropped; the rest (a committed mutation's `mres`,
      // a `qres`, an `err`) still goes, as text, in its place in the order. What was queued after (`authExpired`) follows.
      if ((this.zcut.get(ws) ?? 0) !== cut) {
        const rest = withoutDeliveries(frame);
        try {
          if (rest !== null) ws.send(rest);
        } catch {
          // socket already closed
        }
        return;
      }
      try {
        if (z && z.byteLength < frame.length) {
          ws.send(z);
          this.stats.zframes++;
          this.stats.zframeBytesIn += frame.length;
          this.stats.zframeBytesOut += z.byteLength;
        } else ws.send(frame);
      } catch {
        // socket already closed
      }
    });
    this.zsending.set(ws, sent);
    void sent.finally(() => {
      if (this.zsending.get(ws) === sent) this.zsending.delete(ws);
    });
    this.ctx.waitUntil(sent);
  }

  /**
   * Closes `ws` now (access revoked, restore, import): nothing produced before the close may reach it after. What
   * waits for the end of the turn goes first, as text (never through an asynchronous compression), unless a frame
   * is still being compressed (feature "zframe"): then that one, and everything behind it, are dropped, so the order
   * is never broken either. The client resynchronizes on its next socket (subscriptions anew, mutations resent).
   */
  private closeNow(ws: WebSocket, code: number, reason: string): void {
    const q = this.outbox.get(ws);
    this.outbox.delete(ws);
    const compressing = this.zsending.has(ws);
    this.zsending.delete(ws);
    this.zclosed.add(ws);
    try {
      if (q && !compressing) ws.send(q.frames.length === 1 ? q.frames[0]! : `[${q.frames.join(",")}]`);
    } catch {
      // socket already closed
    }
    try {
      ws.close(code, reason);
    } catch {
      // already closing
    }
  }

  /** Sockets closed by the shard or by the client: a compression still running for one is never sent (`closeNow`). */
  private readonly zclosed = new WeakSet<WebSocket>();
  /**
   * Per socket, bumped when its access expires without a close (`revokeSockets`): a frame whose compression started
   * under an earlier count was produced for the identity that just lost access, and is dropped (`sendCompressed`).
   */
  private readonly zcut = new WeakMap<WebSocket, number>();

  /** Frames waiting for the end of the turn, per batching socket. */
  private readonly outbox = new Map<WebSocket, { frames: string[]; bytes: number }>();
  private outboxScheduled = false;
  /** Sockets that negotiated feature "batch" (from `hello`, or their attachment after a wake). */
  private readonly batching = new WeakSet<WebSocket>();

  private flushSockets(): void {
    this.outboxScheduled = false;
    for (const ws of [...this.outbox.keys()]) this.flushSocket(ws);
  }

  /** Sends what waits for `ws` now (before closing it, or when a batch is full). */
  private flushSocket(ws: WebSocket): void {
    const q = this.outbox.get(ws);
    if (!q) return;
    this.outbox.delete(ws);
    this.sendFrame(ws, q.frames.length === 1 ? q.frames[0]! : `[${q.frames.join(",")}]`);
  }

  // ------------------------------------------------------------------ group commit

  private enqueue(p: Pending): void {
    this.pending.push(p);
    const max = this.cfg.groupCommit?.maxBatch ?? DEFAULT_MAX_BATCH;
    if (this.pending.length >= max) {
      this.drain();
      return;
    }
    if (!this.drainTimer) this.drainTimer = setTimeout(() => this.drain(), this.cfg.groupCommit?.windowMs ?? 0);
  }

  private drain(): void {
    if (this.drainTimer) clearTimeout(this.drainTimer);
    this.drainTimer = null;
    const max = this.cfg.groupCommit?.maxBatch ?? DEFAULT_MAX_BATCH;
    while (this.pending.length) this.commitBatch(this.pending.splice(0, max));
  }

  /** Writes version bump, change log, scheduled and cancelled jobs. Must run inside a transaction. */
  private recordCommit(changes: RowChange[], jobs: Job[], cancelled: string[] = [], outcomes: OutcomeEntry[] = []): number {
    let v = this.version;
    const now = Date.now();
    if (changes.length) {
      v++;
      // A commit may append to the outbox (external indexes) or the broadcast log (`.replicated()`).
      this.nextOutboxAt = undefined;
      this.nextBcastAt = undefined;
      // `.replicated()` tables: the source's log row commits with the write (replicated.ts).
      if (this.replicated.size && this.isReplicatedSource && logReplicated(this.driver, this.replicated, changes, now) > 0) {
        this.bcastNew = true;
        this.nextBcastAt = undefined;
        if (this.devPerf) this.replicatedAdvice(changes, now);
      }
      // One upsert per commit: the ring slot of version v replaces version v - ring (and carries the version, the
      // socket mutations' outcomes and the pending acks).
      const ring = this.ringColumns(v, outcomes, now);
      // Changes over `changeLogEntryMaxBytes` (a huge document) are not written: the row only marks the version, and
      // a client resuming across it gets a full snapshot (the subscription's value, read once, instead of the commit).
      let text = stringify(changes);
      if (overCap(text, entryCap(this.cfg))) {
        text = OVERSIZED_CHANGES;
        this.ringPending!.oversized = v;
        this.stats.changeLogOversized++;
        // The row that makes a runtime before the ceiling see the gap (`OVERSIZED_CHANGES`).
        this.driver.exec("INSERT OR REPLACE INTO _ember_changes(slot, version, at, changes) VALUES (?, ?, ?, ?)", oversizedSlot(v), v, now, OVERSIZED_CHANGES);
        this.oversizedRows.push(v);
      }
      this.dropOversized(v);
      this.driver.exec(
        "INSERT INTO _ember_changes(slot, version, at, changes, dedup, acks) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(slot) DO UPDATE SET version = excluded.version, at = excluded.at, changes = excluded.changes, dedup = excluded.dedup, acks = excluded.acks",
        v % ringSize(this.cfg), v, now, text, ring.dedup, ring.acks,
      );
      // Once known set (most commits), no meta read per commit; the in-memory flag follows the commit (applyRing).
      if (this.maintArmed !== true) {
        if (this.getMeta("next_maint") === null) {
          this.setMeta("next_maint", String(now + HOUR));
          this.maintNew = true;
        }
        this.ringPending!.maint = true;
      }
    }
    for (const j of jobs) this.insertJob({ jobId: j.id, fn: j.fn, args: j.args, kind: j.kind, runAt: j.runAt });
    for (const id of cancelled) this.cancelRow(id);
    return v;
  }

  private commitBatch(batch: Pending[]): void {
    this.warmAll();
    const outcomes: (MutationOutcome | undefined)[] = new Array(batch.length);
    /** `stringify(outcomes[i])`, when the commit encoded it for the dedup/ring: the `mres` frame reuses it. */
    const encoded: (string | undefined)[] = new Array(batch.length);
    const toRun: number[] = [];
    const firstByKey = new Map<string, number>();
    const followers: Array<[number, number]> = [];

    for (let i = 0; i < batch.length; i++) {
      const d = batch[i]!.dedup;
      if (d) {
        const k = `${d.identity}\n${d.clientId}\n${d.mid}`;
        const first = firstByKey.get(k);
        if (first !== undefined) {
          followers.push([i, first]);
          continue;
        }
        const hit = this.dedupLookup(d.identity, d.clientId, d.mid);
        if (hit !== null) {
          outcomes[i] = parse(hit) as MutationOutcome;
          continue;
        }
        firstByKey.set(k, i);
      }
      toRun.push(i);
    }

    let changes: RowChange[] = [];
    let hasJobs = false;
    /** The batch wrote something the alarm depends on: jobs, `_files` rows, the outbox or `next_maint`. */
    let alarmInputs = false;
    /** Per executed item: rows (the batch's counters split evenly: one transaction) and result size. */
    let perItem: Array<{ rowsRead: number; rowsWritten: number; bytesOut?: () => number; error: { code: string } | null; usage?: Usage | undefined }> = [];
    if (toRun.length) {
      this.stats.batches++;
      this.stats.batchSizes.push(toRun.length);
      if (this.stats.batchSizes.length > 50) this.stats.batchSizes.shift();
      try {
        const items: MutationBatchItem[] = toRun.map((i) => ({ name: batch[i]!.fn, args: batch[i]!.args, ctx: batch[i]!.ctx }));
        const r0 = this.driver.rowsRead;
        const w0 = this.driver.rowsWritten;
        // One transaction for the items and the commit's rows, no savepoint unless an item fails (engine.ts).
        const res = this.engine.commitMutationBatch(items, (results) => {
          if (results.length !== items.length) throw new Error("engine returned a result count different from the batch size");
          // Nothing written by the batch's runs (private `ctx.sql` tables included): a successful item without changes,
          // jobs or files had no effect at all.
          const wroteRows = this.driver.rowsWritten !== w0;
          // Group commit: the batch's rows are split evenly across its items (one transaction).
          const rr = share(this.driver.rowsRead - r0, results.length);
          const ww = share(this.driver.rowsWritten - w0, results.length);
          perItem = results.map((r) => ({ rowsRead: rr, rowsWritten: ww, error: r.ok ? null : r.error, ...(r.ok ? { bytesOut: () => stringify(r.value ?? null).length, usage: r.usage } : {}) }));
          const all: RowChange[] = [];
          const jobs: Job[] = [];
          const cancelled: string[] = [];
          let files = false;
          for (const r of results) {
            if (r.ok) {
              all.push(...r.changes);
              jobs.push(...r.scheduled);
              cancelled.push(...(r.cancelled ?? []));
              if (r.files !== false) files = true;
            }
          }
          // The commit's version is known before its row is written: outcomes of socket mutations go in that row.
          const v = all.length ? this.version + 1 : this.version;
          const now = Date.now();
          const inRing: OutcomeEntry[] = [];
          const inTable: OutcomeEntry[] = [];
          const volatile: OutcomeEntry[] = [];
          results.forEach((r, j) => {
            const i = toRun[j]!;
            const out: MutationOutcome = r.ok ? { ok: true, value: r.value, version: v } : { ok: false, error: r.error };
            outcomes[i] = out;
            const d = batch[i]!.dedup;
            if (!d || (!out.ok && d.okOnly)) return;
            const e: OutcomeEntry = [d.identity, d.clientId, d.mid, (encoded[i] = stringify(out))];
            if (!batch[i]!.origin) inTable.push(e);
            else if (batch[i]!.acks && (!r.ok || (!wroteRows && !r.changes.length && !r.scheduled.length && !r.cancelled?.length && r.files === false))) {
              // No effect (an error is undone by its savepoint), for a client that acknowledges: in the ring row if
              // there is one (flagged: never spilled), else in memory (a large one in the dedup table, as before).
              if (all.length) inRing.push([e[0], e[1], e[2], e[3], 1]);
              else if (entryUnits(e) > MAX_VOLATILE_ENTRY_UNITS) inTable.push(e);
              else volatile.push(e);
            } else (all.length ? inRing : inTable).push(e);
          });
          if (this.recordCommit(all, jobs, cancelled, inRing) !== v) throw new Error("commit version mismatch");
          for (const e of inTable) this.spill(e, now);
          return { v, all, jobs: jobs.length + cancelled.length, files, volatile };
        });
        this.version = res.v;
        this.applyRing();
        for (const e of res.volatile) this.keepVolatile(e);
        changes = res.all;
        if (changes.length) this.lastWrite = Date.now();
        hasJobs = res.jobs > 0 || changes.length > 0;
        alarmInputs = res.jobs > 0 || res.files || this.touchesExternal(changes) || this.maintNew || this.bcastNew;
        this.maintNew = false;
      } catch (e) {
        this.ringPending = null;
        this.maintNew = false;
        const err = errInfo(e, "internal");
        for (const i of toRun) {
          outcomes[i] = { ok: false, error: err };
          encoded[i] = undefined;
        }
      }
    }
    for (const [i, first] of followers) {
      outcomes[i] = outcomes[first];
      encoded[i] = encoded[first];
    }
    // Metrics: callers that measure the RPC get the rows in the outcome; the rest get a point after the commit.
    const committed: Parameters<Shard["emitAfterCommit"]>[1] = [];
    toRun.forEach((i, j) => {
      const m = perItem[j];
      const it = batch[i]!;
      if (!m) return;
      if (it.caller) {
        const o = outcomes[i];
        encoded[i] = undefined;
        if (o) outcomes[i] = { ...o, metrics: { rowsRead: m.rowsRead, rowsWritten: m.rowsWritten, bytesOut: m.bytesOut && metricsEnabled(this.env) ? m.bytesOut() : 0, ...usageMetrics(m.usage, m.error) } };
      } else committed.push({ fn: it.fn, at: it.at, ...m });
      this.limitAdvice(it.fn, m.usage);
    });
    this.emitAfterCommit("mutation", committed);

    const mids = new Map<string, Id[]>();
    for (const i of toRun) {
      const o = batch[i]!.origin;
      if (!o || !outcomes[i]?.ok) continue;
      let l = mids.get(o.sid);
      if (!l) mids.set(o.sid, (l = []));
      l.push(o.mid);
    }
    this.publish(this.version, changes, mids);
    if (this.touchesExternal(changes)) this.kickOutbox();
    // Jobs, `_files` rows (uploads, refcounts reaching zero) whose GC the alarm must schedule, the outbox, the hourly
    // maintenance. A commit that touched none of them cannot move the alarm (5 SQL reads saved per commit); the first
    // one after a wake always arms (`lastArmed` unknown).
    if (alarmInputs || (this.lastArmed === undefined && (hasJobs || toRun.length))) this.armAlarm();
    for (let i = 0; i < batch.length; i++) {
      const o = outcomes[i];
      batch[i]!.resolve(o ?? { ok: false, error: { code: "internal", message: "no outcome" } }, o ? encoded[i] : undefined);
    }
  }

  // ------------------------------------------------------------------ scheduler

  /** The job's id (`job_id`), or null when `dedupKey` (or `jobId`) is already taken. */
  private insertJob(job: JobInput): string | null {
    this.warmAll();
    const now = Date.now();
    const maxAttempts = job.maxAttempts ?? this.cfg.scheduler?.maxAttempts ?? 5;
    const jobId = job.jobId ?? makeId("job", now, Math.random);
    const runAt = job.runAt ?? now;
    const r = this.driver.exec(
      `INSERT INTO _jobs(run_at, fn, args, kind, max_attempts, dedup_key, created_at, updated_at, job_id, scheduled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING job_id`,
      runAt, job.fn, stringify(job.args ?? {}), job.kind ?? "mutation", maxAttempts, job.dedupKey ?? null, now, now, jobId, runAt,
    ).rows[0];
    if (r) this.jobChanged(r.job_id as string);
    return r ? (r.job_id as string) : null;
  }

  // ------------------------------------------------------------------ scheduled job metadata (`ctx.scheduler.get`)

  /** How long finished jobs stay (`scheduler.retainMs`, default 7 days; 0 = success and canceled rows go at once). */
  private retainMs(): number {
    const r = this.cfg.scheduler?.retainMs;
    return r !== undefined && Number.isFinite(r) && r >= 0 ? r : JOB_RETENTION_MS;
  }

  /** Whether a finished run of `fn` keeps its `_jobs` row: `scheduler.retainMs` above 0 and not `retainMs: 0` on `fn`. */
  private retains(fn: string | undefined): boolean {
    if (this.retainMs() <= 0) return false;
    const ephemeral = ephemeralJobs(this.cfg);
    return !ephemeral.size || fn === undefined || !ephemeral.has(fn);
  }

  /** A pending job (or one handed to the Queue and not claimed) is cancelled: kept as `canceled`, or deleted. */
  private cancelRow(jobId: string): boolean {
    this.warmAll();
    const now = Date.now();
    // With functions declared `retainMs: 0`, the row's function decides (one read; none otherwise).
    const fn = this.retainMs() > 0 && ephemeralJobs(this.cfg).size
      ? (this.driver.exec("SELECT fn FROM _jobs WHERE job_id = ? AND state IN ('pending', 'dispatched')", jobId).rows[0]?.fn as string | undefined)
      : undefined;
    const r = this.retains(fn)
      ? this.driver.exec("UPDATE _jobs SET state = 'canceled', dedup_key = NULL, run_at = ?, updated_at = ? WHERE job_id = ? AND state IN ('pending', 'dispatched') RETURNING id", now, now, jobId)
      : this.driver.exec("DELETE FROM _jobs WHERE job_id = ? AND state IN ('pending', 'dispatched') RETURNING id", jobId);
    if (r.rows.length) this.jobChanged(jobId);
    return r.rows.length > 0;
  }

  /** A job ran: kept as `success` (its `run_at` becomes the completion time, which the GC ranges over), or deleted. */
  private succeedJob(job: Record<string, unknown>): void {
    this.warmAll();
    const now = Date.now();
    if (this.retains(job.fn as string)) this.driver.exec("UPDATE _jobs SET state = 'success', dedup_key = NULL, run_at = ?, updated_at = ?, attempts = attempts + 1, last_error = NULL WHERE id = ?", now, now, job.id as number);
    else this.driver.exec("DELETE FROM _jobs WHERE id = ?", job.id as number);
    this.jobChanged(job.job_id as string | null);
  }

  /**
   * Finished jobs past their retention, a bounded number per maintenance turn (the `_jobs_due` index ranges them).
   * Called inside the maintenance transaction, after `warmGcJobs`.
   */
  private gcJobs(now: number): void {
    const before = now - this.retainMs();
    for (let n = 0; n < JOB_GC_MAX; n += JOB_GC_CHUNK) {
      const r = this.driver.exec(
        `DELETE FROM _jobs WHERE id IN (SELECT id FROM _jobs WHERE state IN ${TERMINAL_STATES} AND run_at < ? LIMIT ?) RETURNING job_id`,
        before, JOB_GC_CHUNK,
      );
      for (const row of r.rows) this.jobChanged(row.job_id as string | null);
      if (r.rows.length < JOB_GC_CHUNK) break;
    }
  }

  /**
   * Dormant subscriptions run before `gcJobs` deletes anything (a scheduler read may see it), and only then. Outside the
   * maintenance transaction: a query that throws while warming does not roll the tick's state back.
   */
  private warmGcJobs(now: number): void {
    if (this.dormant.size && this.driver.exec(`SELECT 1 AS x FROM _jobs WHERE state IN ${TERMINAL_STATES} AND run_at < ? LIMIT 1`, now - this.retainMs()).rows.length) this.warmAll();
  }

  private jobOf(r: Record<string, unknown>): ScheduledFunction {
    const state = String(r.state);
    const terminal = state === "success" || state === "failed" || state === "canceled";
    return {
      id: (r.job_id as string | null) ?? `#${r.id as number}`,
      _creationTime: r.created_at as number,
      name: r.fn as string,
      args: parse(r.args as string),
      scheduledTime: (r.scheduled_at as number | null) ?? (r.run_at as number),
      ...(terminal ? { completedTime: r.updated_at as number } : {}),
      state:
        state === "success" ? { kind: "success" }
        : state === "failed" ? { kind: "failed", error: (r.last_error as string | null) ?? "" }
        : state === "canceled" ? { kind: "canceled" }
        : state === "claimed" || state === "running" ? { kind: "inProgress" }
        : { kind: "pending" },
      attempts: r.attempts as number,
    };
  }

  private scheduledJob(id: string): ScheduledFunction | null {
    const r = this.driver.exec("SELECT * FROM _jobs WHERE job_id = ?", id).rows[0];
    return r ? this.jobOf(r) : null;
  }

  private scheduledJobs(o: { state?: ScheduledFunctionStateKind; limit: number }): ScheduledFunction[] {
    const states = o.state === undefined ? null : JOB_STATES_OF[o.state];
    const rows = states
      ? this.driver.exec(`SELECT * FROM _jobs WHERE state IN (${states.map(() => "?").join(", ")}) ORDER BY id LIMIT ?`, ...states, o.limit).rows
      : this.driver.exec("SELECT * FROM _jobs ORDER BY id LIMIT ?", o.limit).rows;
    return rows.map((r) => this.jobOf(r));
  }

  /** `ctx.scheduler.get/list` from an action (each call its own read). */
  async getScheduled(shard: string, id: string): Promise<ScheduledFunction | null> {
    this.setShardName(shard);
    this.assertNotAhead();
    if (typeof id !== "string" || !id) return null;
    return this.scheduledJob(id);
  }

  async listScheduled(shard: string, o: ListScheduledOptions = {}): Promise<ScheduledFunction[]> {
    this.setShardName(shard);
    this.assertNotAhead();
    const limit = o.limit ?? LIST_SCHEDULED_DEFAULT;
    if (o.state !== undefined && !Object.hasOwn(JOB_STATES_OF, o.state)) throw new EmberError("ValidationError", `scheduler.list(): unknown state ${JSON.stringify(o.state)}`);
    if (!Number.isInteger(limit) || limit < 1 || limit > LIST_SCHEDULED_MAX) throw new EmberError("ValidationError", `scheduler.list(): limit must be an integer in 1..${LIST_SCHEDULED_MAX}`);
    return this.scheduledJobs({ ...(o.state ? { state: o.state } : {}), limit });
  }

  /** Job ids whose state changed since the last flush (queries that read them re-run, without a new version). */
  private readonly changedJobs = new Set<string>();

  /**
   * A job's row changed (scheduled, started, finished, cancelled, collected): the queries that read it with
   * `ctx.scheduler.get` (by id) or `list` (the whole table) re-run once the current turn is done. No version bump: job
   * state is not in the change log, so those results are never resumed from it either (`resumable`).
   */
  private jobChanged(jobId: string | null | undefined): void {
    // Any write of a `_jobs` row comes through here: the next arm reads the next job time again.
    this.nextJobAt = undefined;
    if (!jobId) return;
    if (!this.changedJobs.size) queueMicrotask(() => this.flushJobChanges());
    this.changedJobs.add(jobId);
  }

  private flushJobChanges(): void {
    const ids = [...this.changedJobs];
    this.changedJobs.clear();
    if (!ids.length || (!this.queries.size && !this.gates.size)) return;
    const changes = ids.map((id) => ({ table: JOBS_TABLE, id, before: { _id: id }, after: { _id: id } }) as unknown as RowChange);
    const { exact } = this.index.match(changes);
    if (!exact.size) return;
    this.memoGen++;
    const stale: QueryEntry[] = [];
    const gates: GateEntry[] = [];
    for (const k of exact) {
      if (k.charCodeAt(0) === 2) {
        const g = this.gates.get(k);
        if (g) gates.push(g);
      } else {
        const e = this.queries.get(k);
        if (e) stale.push(e);
      }
    }
    this.rerun(stale, this.version, undefined, true, gates);
  }

  /** Every subsystem is read again on the next arm (an alarm turn, an outbox flush, a restore, a boot). */
  private resetAlarmCache(): void {
    this.nextJobAt = undefined;
    this.nextFilesAt = undefined;
    this.nextOutboxAt = undefined;
    this.nextBcastAt = undefined;
    this.nextMaintAt = undefined;
    this.backfillDue = undefined;
  }

  /**
   * alarm = min(next pending job, next maintenance), never more than 30 days ahead (chained). `notBefore`: never sooner
   * than that (a refused shard, `alarm`). Each subsystem's next time comes from the in-memory cache unless a write
   * dropped it (see `nextJobAt`): an arm after a commit that scheduled a job reads `_jobs` only. `jobsOnly`: the caller
   * wrote nothing but `_jobs` (scheduler RPCs), so the outbox and the broadcast log are taken from the cache too when
   * known (other arms read them again, as they may be written without a commit: acks, the catalog).
   */
  private armAlarm(notBefore?: number, jobsOnly = false): void {
    // Refused by RuntimeSchemaTooNew: nothing is read from the newer runtime's tables, no alarm is set or deleted.
    if (this.runtimeAhead) return;
    const now = Date.now();
    this.maintNew = false;
    this.alarmStats.alarmArms++;
    const candidates: number[] = [];
    // `running` rows count too: their run_at is when they are given back if the object died mid-run.
    if (this.nextJobAt === undefined) {
      const m = this.driver.exec(NEXT_JOB_AT_SQL).rows[0]?.m;
      this.nextJobAt = m === null || m === undefined ? null : Number(m);
      this.alarmStats.alarmJobReads++;
    }
    if (this.nextJobAt !== null) candidates.push(this.nextJobAt);
    if (this.nextMaintAt === undefined || this.backfillDue === undefined) {
      const maint = this.getMeta("next_maint");
      this.nextMaintAt = maint === null ? null : Number(maint);
      this.backfillDue = this.getMeta("backfill") !== null;
      this.alarmStats.alarmMetaReads++;
    }
    if (this.nextMaintAt !== null) candidates.push(this.nextMaintAt);
    if (this.backfillDue) candidates.push(now);
    if (this.nextFilesAt === undefined) {
      this.nextFilesAt = this.files.nextGcAt();
      this.alarmStats.alarmFileReads++;
    }
    if (this.nextFilesAt !== null) candidates.push(Math.max(this.nextFilesAt, now));
    if (this.hasExternal && !this.flushing) {
      if (!jobsOnly || this.nextOutboxAt === undefined) {
        // At 0, "rows pending" reads as 0 (now, below): the cached value does not depend on when it was read.
        this.nextOutboxAt = outboxNextAt(this.driver, 0, this.outboxResendMs());
        this.alarmStats.alarmOutboxReads++;
      }
      if (this.nextOutboxAt !== null) candidates.push(Math.max(this.nextOutboxAt, now));
    }
    if (this.replicated.size && this.isReplicatedSource && !this.bcastDraining) {
      this.bcastNew = false;
      if (!this.bcastReady) {
        ensureBroadcastTables(this.driver);
        this.bcastReady = true;
      }
      if (!jobsOnly || this.nextBcastAt === undefined) {
        this.nextBcastAt = nextBroadcastAt(this.driver);
        this.alarmStats.alarmBcastReads++;
      }
      if (this.nextBcastAt !== null) candidates.push(Math.max(this.nextBcastAt, now));
    }
    if (!candidates.length) {
      if (this.lastArmed !== null) {
        this.lastArmed = null;
        void this.ctx.storage.deleteAlarm();
      }
      return;
    }
    // A refused shard runs nothing in its alarm, so every arm keeps the floor its alarm uses: without it, a call in
    // between (a settled action, a file operation) would bring the alarm back to an overdue job for a turn that does nothing.
    const floor = notBefore ?? (this.refused ? now + REFUSED_ALARM_MS : 0);
    const target = Math.max(Math.min(Math.min(...candidates), now + MAX_ALARM_AHEAD_MS), floor);
    if (this.lastArmed === target) return;
    this.lastArmed = target;
    // Issued in program order: the last call reflects the latest table state.
    void this.ctx.storage.setAlarm(target);
  }

  private backoff(attempts: number): number {
    const base = this.cfg.scheduler?.backoffBaseMs ?? 1000;
    const max = this.cfg.scheduler?.backoffMaxMs ?? HOUR;
    return Math.min(base * 2 ** Math.max(0, attempts - 1), max);
  }

  /**
   * `dispatchedAt`: a failed send to the Queue (awaited outside the transaction). The row changes only while it is still
   * that dispatch (`dispatched`, `updated_at` unchanged): cancelled, claimed or finished meanwhile, it is left alone.
   */
  private failJob(job: Record<string, unknown>, error: { code: string; message: string }, dispatchedAt?: number): void {
    this.warmAll();
    const attempts = (job.attempts as number) + 1;
    const now = Date.now();
    const final = attempts >= (job.max_attempts as number);
    const args = [attempts, final ? "failed" : "pending", final ? now : now + this.backoff(attempts), `${error.code}: ${error.message}`, now, job.id as number] as const;
    const r =
      dispatchedAt === undefined
        ? this.driver.exec("UPDATE _jobs SET attempts = ?, state = ?, run_at = ?, last_error = ?, updated_at = ? WHERE id = ?", ...args)
        : this.driver.exec("UPDATE _jobs SET attempts = ?, state = ?, run_at = ?, last_error = ?, updated_at = ? WHERE id = ? AND state = 'dispatched' AND updated_at = ? RETURNING id", ...args, dispatchedAt);
    if (dispatchedAt === undefined || r.rows.length) this.jobChanged(job.job_id as string | null);
  }

  /** The due jobs from the head of the queue, in order, while `same` holds (the head always does). */
  private dueRun(now: number, limit: number, same: (job: Record<string, unknown>) => boolean): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    for (const j of this.driver.exec(NEXT_DUE_JOBS_SQL, now, limit).rows) {
      if (!same(j)) break;
      out.push(j);
    }
    return out;
  }

  /**
   * Several due mutation jobs in one transaction (`runMutationBatch`: a failing one is undone alone), one change-log
   * row and one publish, as a group commit of socket mutations. Each job succeeds or fails on its own.
   */
  private runMutationJobs(jobs: Array<Record<string, unknown>>): void {
    this.warmAll();
    let committed: { v: number; changes: RowChange[] } | null = null;
    const at = Date.now();
    let points: Parameters<Shard["emitAfterCommit"]>[1] = [];
    try {
      committed = this.driver.transaction(() => {
        const r0 = this.driver.rowsRead;
        const w0 = this.driver.rowsWritten;
        const all: RowChange[] = [];
        const ids = new Map(jobs.map((j, i) => [j.job_id as string | null, i] as const));
        const lastRunAt = jobs[jobs.length - 1]!.run_at as number;
        // Each job's outcome, scheduled and cancelled jobs are written before the next job runs (`afterEach`), so it
        // sees them as on the single-job path (`ctx.scheduler.get`); a savepoint per job keeps a failing one alone.
        const results = this.engine.runMutationBatch(
          jobs.map((job) => ({ name: job.fn as string, args: parse(job.args as string), ctx: SYSTEM })),
          {
            afterEach: (r, i) => {
              const job = jobs[i]!;
              if (!r.ok) return this.failJob(job, r.error);
              // A later job of this batch cancelled (it must not run), or a job scheduled to run no later than one
              // (it goes first in `(run_at, id)` order): undo the batch, commit up to this job, pick the rest again.
              if ((r.cancelled ?? []).some((id) => (ids.get(id) ?? -1) > i)) throw new BatchCut(i + 1);
              if (i < jobs.length - 1 && r.scheduled.some((j) => j.runAt <= lastRunAt)) throw new BatchCut(i + 1);
              this.limitAdvice(job.fn as string, r.usage);
              all.push(...r.changes);
              for (const j of r.scheduled) this.insertJob({ jobId: j.id, fn: j.fn, args: j.args, kind: j.kind, runAt: j.runAt });
              for (const id of r.cancelled ?? []) this.cancelRow(id);
              this.succeedJob(job);
            },
          },
        );
        if (results.length !== jobs.length) throw new Error("engine returned a result count different from the batch size");
        const rr = share(this.driver.rowsRead - r0, results.length);
        const ww = share(this.driver.rowsWritten - w0, results.length);
        results.forEach((r, i) => points.push({ fn: jobs[i]!.fn as string, at, error: r.ok ? null : r.error, rowsRead: rr, rowsWritten: ww, usage: r.ok ? r.usage : undefined }));
        const v = this.recordCommit(all, []);
        return { v, changes: all };
      });
    } catch (e) {
      this.ringPending = null;
      points = [];
      if (e instanceof BatchCut) return e.size > 1 ? this.runMutationJobs(jobs.slice(0, e.size)) : this.runMutationJob(jobs[0]!);
      this.driver.transaction(() => {
        for (const job of jobs) this.failJob(job, errInfo(e, "internal"));
      });
    }
    if (points.length) this.emitAfterCommit("job", points);
    if (committed) this.applyRing();
    else this.ringPending = null;
    if (committed) {
      if (committed.changes.length) this.lastWrite = Date.now();
      this.version = committed.v;
      this.publish(committed.v, committed.changes);
      if (this.touchesExternal(committed.changes)) this.kickOutbox();
    }
  }

  private runMutationJob(job: Record<string, unknown>): void {
    this.warmAll();
    let committed: { v: number; changes: RowChange[] } | null = null;
    const at = Date.now();
    let jobPoint: Parameters<Shard["emitAfterCommit"]>[1][number] | null = null;
    try {
      // The job, its effects and its state update share one transaction (alarm writes are never rolled back: R5).
      committed = this.driver.transaction(() => {
        const r0 = this.driver.rowsRead;
        const w0 = this.driver.rowsWritten;
        const [r] = this.engine.runMutationBatch([{ name: job.fn as string, args: parse(job.args as string), ctx: SYSTEM }]);
        if (!r) throw new Error("engine returned no result");
        jobPoint = { fn: job.fn as string, at, error: r.ok ? null : r.error, rowsRead: this.driver.rowsRead - r0, rowsWritten: this.driver.rowsWritten - w0, usage: r.ok ? r.usage : undefined };
        if (r.ok) this.limitAdvice(job.fn as string, r.usage);
        if (!r.ok) {
          this.failJob(job, r.error);
          return null;
        }
        const v = this.recordCommit(r.changes, r.scheduled, r.cancelled ?? []);
        this.succeedJob(job);
        return { v, changes: r.changes };
      });
    } catch (e) {
      this.ringPending = null;
      this.driver.transaction(() => this.failJob(job, errInfo(e, "internal")));
    }
    if (jobPoint) this.emitAfterCommit("job", [jobPoint]);
    if (committed) this.applyRing();
    else this.ringPending = null;
    if (committed) {
      if (committed.changes.length) this.lastWrite = Date.now();
      this.version = committed.v;
      this.publish(committed.v, committed.changes);
      if (this.touchesExternal(committed.changes)) this.kickOutbox();
    }
  }

  /**
   * The lease of an action job handed to the Queue: its `action({ leaseMs })`, else `scheduler.actionLeaseMs`, never
   * under 1 s (a lease already due would run the job here in the very turn that dispatched it).
   */
  private actionLease(fn: string): number {
    const lease = actionDispatch(this.cfg, fn).leaseMs ?? this.cfg.scheduler?.actionLeaseMs ?? ACTION_LEASE_MS;
    return Math.max(MIN_ACTION_LEASE_MS, Number.isFinite(lease) ? lease : ACTION_LEASE_MS);
  }

  /**
   * Action jobs go to the `EMBER_ACTIONS` queue (or `config.dispatchAction`) and run in the Worker's queue consumer,
   * under a lease: the row stays (`dispatched`, then `claimed` by the consumer) until the consumer reports the outcome
   * (`settleActionJob`). A lease that runs out (a Queue that accepted the message and stalls, a consumer that died)
   * brings the job back here, and it runs in this alarm turn. Without a queue, or for `action({ dispatch: "shard" })`,
   * they always run here (the action reaches this shard directly, others by RPC).
   */
  /** The action job goes to the Queue now (not back from an expired lease, not `dispatch: "shard"`, has an id). */
  private queuesAction(job: Record<string, unknown>): boolean {
    if (job.state === "dispatched" || job.state === "claimed" || job.job_id === null) return false;
    if (!(this.cfg.dispatchAction || this.env.EMBER_ACTIONS)) return false;
    return actionDispatch(this.cfg, job.fn as string).dispatch !== "shard";
  }

  /**
   * Due action jobs handed to `EMBER_ACTIONS` together: one transaction leases them all, one `sendBatch` (when the
   * queue has it and no `dispatchAction` overrides the send) carries them; else one send each, as `runActionJob`.
   */
  private async dispatchActionJobs(jobs: Array<Record<string, unknown>>): Promise<void> {
    const queue = this.env.EMBER_ACTIONS;
    if (this.cfg.dispatchAction || !queue || typeof queue.sendBatch !== "function") {
      for (const job of jobs) await this.runActionJob(job);
      return;
    }
    this.warmAll();
    const now = Date.now();
    const shard = this.shardName ?? "";
    const messages = this.driver.transaction(() =>
      jobs.map((job) => {
        const fn = job.fn as string;
        this.driver.exec("UPDATE _jobs SET state = 'dispatched', run_at = ?, updated_at = ? WHERE id = ?", now + this.actionLease(fn), now, job.id as number);
        this.jobChanged(job.job_id as string | null);
        return { body: { shard, jobId: job.job_id as string, fn, ...queueArgs(job), attempt: (job.attempts as number) + 1, lease: true } satisfies ActionJobMessage };
      }),
    );
    // Queues takes at most 100 messages and 256 KB per `sendBatch`: split by size too (one too large alone fails alone).
    const groups: number[][] = [];
    let bytes = 0;
    messages.forEach((m, i) => {
      // The stored args text (never throws, unlike JSON.stringify of a body holding an int64 bigint), escaped as a
      // string when it travels as `argsJson`, and the rest.
      const args = m.body.argsJson === undefined ? (jobs[i]!.args as string) : JSON.stringify(m.body.argsJson);
      const size = UTF8.encode(args).byteLength + UTF8.encode(m.body.fn).byteLength + SEND_BATCH_OVERHEAD;
      const last = groups[groups.length - 1];
      // Over the per-message limit (128 KB): alone, so its rejection fails only it (and the next starts a group).
      if (size > SEND_MESSAGE_BYTES) {
        groups.push([i]);
        bytes = SEND_BATCH_BYTES;
      } else if (!last || bytes + size > SEND_BATCH_BYTES) {
        groups.push([i]);
        bytes = size;
      } else {
        last.push(i);
        bytes += size;
      }
    });
    for (const g of groups) {
      try {
        await queue.sendBatch(g.map((i) => messages[i]!));
      } catch (e) {
        this.driver.transaction(() => {
          for (const i of g) this.failJob(jobs[i]!, errInfo(e, "dispatch_failed"), now);
        });
      }
    }
  }

  private async runActionJob(job: Record<string, unknown>): Promise<void> {
    const fn = job.fn as string;
    const msg: ActionJobMessage = {
      shard: this.shardName ?? "",
      jobId: (job.job_id as string | null) ?? `#${job.id as number}`,
      fn,
      args: parse(job.args as string),
      attempt: (job.attempts as number) + 1,
    };
    const leaseOver = job.state === "dispatched" || job.state === "claimed";
    const queue = this.cfg.dispatchAction || this.env.EMBER_ACTIONS;
    // Its row changes below (dispatched or running): dormant subscriptions run first.
    this.warmAll();
    if (!leaseOver && queue && actionDispatch(this.cfg, fn).dispatch !== "shard" && job.job_id !== null) {
      const now = Date.now();
      // The row stays as the lease: the alarm finds it again if nobody reports back in time.
      this.driver.exec("UPDATE _jobs SET state = 'dispatched', run_at = ?, updated_at = ? WHERE id = ?", now + this.actionLease(fn), now, job.id as number);
      this.jobChanged(job.job_id as string | null);
      try {
        const leased: ActionJobMessage = { ...msg, lease: true };
        if (this.cfg.dispatchAction) await this.cfg.dispatchAction(this.env, leased);
        else {
          const { args: _parsed, ...rest } = leased;
          await this.env.EMBER_ACTIONS!.send({ ...rest, ...queueArgs(job) });
        }
      } catch (e) {
        this.driver.transaction(() => this.failJob(job, errInfo(e, "dispatch_failed"), now));
      }
      return;
    }
    if (leaseOver) console.warn(`ember: action job ${msg.jobId} (${fn}) not finished by the queue within its lease; running it in the shard`);
    try {
      // Mark running first so a concurrent alarm retry (or a late claim from the queue) cannot run it twice, with the
      // moment it is given back if this object dies mid-run (the alarm stays armed for it).
      const started = Date.now();
      this.driver.exec("UPDATE _jobs SET state = 'running', run_at = ?, updated_at = ? WHERE id = ?", started + RUNNING_RECOVERY_MS, started, job.id as number);
      this.jobChanged(job.job_id as string | null);
      // Durably, before awaiting the action: if the object dies mid-run, this alarm brings the job back.
      this.armAlarm();
      const out = await this.actionRunner().run(fn, msg.args, msg.shard, null, { internal: true, system: true });
      if (!out.ok) throw Object.assign(new Error(out.error.message), { code: out.error.code });
      this.succeedJob(job);
    } catch (e) {
      this.driver.transaction(() => this.failJob(job, errInfo(e, "action_failed")));
    }
  }

  /**
   * The queue consumer claims a leased action job before running it: true when the job is still waiting for it
   * (`dispatched`), which then becomes `claimed` with a fresh lease. False when it was cancelled, already ran here
   * after its lease ran out, or another delivery claimed it: the consumer acks the message without running it.
   * One job: `claimActionJobs` with one id (kept for Workers of the runtime before it, mid-deploy).
   */
  async claimActionJob(shard: string, jobId: string): Promise<{ run: boolean }> {
    const [r] = await this.claimActionJobs(shard, [jobId]);
    return { run: r?.run === true };
  }

  /**
   * `claimActionJob` for every job of a Queue batch that belongs to this shard: one RPC (one DO request) for all of
   * them, each claimed or refused on its own, in order. `leaseMs`: the lease each claim got, `leaseUntil` when it ends
   * (this DO's clock, ms): the consumer leaves a job it could not start in time to the shard (see `settleActionJobs`)
   * and reports the outcomes before the lease ends.
   */
  async claimActionJobs(shard: string, jobIds: string[]): Promise<Array<{ run: boolean; leaseMs?: number; leaseUntil?: number }>> {
    this.setShardName(shard);
    if (!Array.isArray(jobIds) || jobIds.length > MAX_LEASE_BATCH || !jobIds.every((j) => typeof j === "string")) {
      throw new EmberError("InvalidArgument", `claimActionJobs: at most ${MAX_LEASE_BATCH} job ids`);
    }
    if (this.refused) {
      // Nothing runs on a refused shard (a refused migration: the old schema under the new code; RuntimeSchemaTooNew).
      // Never `run: true` here, and the message is acked: the row is left as it is (`dispatched`, its lease in
      // `run_at`), and once a fixed deploy serves the shard the lease runs out and the alarm (kept armed while refused,
      // see `alarm`) runs the job in the shard (at least once).
      console.warn(`ember: action jobs ${jobIds.join(", ")} not claimed: shard ${shard} is refused (${this.refused.code}); their lease brings them back`);
      return jobIds.map(() => ({ run: false }));
    }
    const known = this.nextJobAt;
    let sooner = false;
    let earliestOld = Infinity;
    const out = jobIds.map((jobId): { run: boolean; leaseMs?: number; leaseUntil?: number } => {
      const row = this.driver.exec("SELECT fn, run_at FROM _jobs WHERE job_id = ? AND state = 'dispatched'", jobId).rows[0];
      if (!row) return { run: false };
      this.warmAll();
      const now = Date.now();
      const leaseMs = this.actionLease(row.fn as string);
      const lease = now + leaseMs;
      this.driver.exec("UPDATE _jobs SET state = 'claimed', run_at = ?, updated_at = ? WHERE job_id = ? AND state = 'dispatched'", lease, now, jobId);
      this.jobChanged(jobId);
      // A lease shorter than the dispatched one (a deploy shortened `leaseMs` in between): the alarm must come sooner.
      if (lease < (row.run_at as number)) sooner = true;
      earliestOld = Math.min(earliestOld, row.run_at as number);
      return { run: true, leaseMs, leaseUntil: lease };
    });
    if (sooner) this.armAlarm(undefined, true);
    // No arm: a claim moves its row's time later (its fresh lease). The alarm armed for the dispatched leases (or
    // anything sooner) stays; an early alarm finds nothing due and arms again from the tables. Another job sooner
    // than every claimed row's old lease keeps the cached next time exact (`known` is the MIN over every row, the
    // refused ones included, and a refused row's time did not move: it is never sooner than `known`).
    else if (known !== undefined && known !== null && known < earliestOld) this.nextJobAt = known;
    return out;
  }

  /**
   * The outcome of a claimed action job: done (the row goes), or failed (retried here with backoff, or `failed` after
   * `maxAttempts`, like any job). A job no longer claimed (its lease ran out and it ran here) is left alone.
   * One job: `settleActionJobs` with one outcome (kept for Workers of the runtime before it, mid-deploy).
   */
  async settleActionJob(shard: string, jobId: string, error: { code: string; message: string } | null): Promise<void> {
    await this.settleActionJobs(shard, [{ jobId, error }]);
  }

  /**
   * `settleActionJob` for the outcomes of a Queue batch on this shard, in one RPC, each settled on its own and in
   * order (one alarm arm at most for all). `released`: the consumer claimed the job but did not start it before half
   * its lease was gone (a long batch); its lease ends now, and the alarm runs it in the shard (as when the lease runs
   * out, without waiting for it), with no attempt counted.
   */
  async settleActionJobs(shard: string, outcomes: ActionJobOutcome[]): Promise<void> {
    this.setShardName(shard);
    // The consumer logs it and acks: the jobs are still `claimed`, and run again when their lease runs out (at least once).
    this.assertNotAhead();
    if (!Array.isArray(outcomes) || outcomes.length > MAX_LEASE_BATCH) throw new EmberError("InvalidArgument", `settleActionJobs: at most ${MAX_LEASE_BATCH} outcomes`);
    const known = this.nextJobAt;
    const cached = known !== undefined && known !== null && this.lastArmed !== undefined;
    let settled = false;
    let arm = false;
    for (const o of outcomes) {
      if (!o || typeof o.jobId !== "string") continue;
      const job = this.driver.exec("SELECT * FROM _jobs WHERE job_id = ? AND state = 'claimed'", o.jobId).rows[0];
      if (!job) continue;
      settled = true;
      if ("released" in o && o.released === true) {
        this.warmAll();
        const now = Date.now();
        // Its lease ends now: this alarm runs it in the shard, as a lease that ran out (no attempt counted).
        this.driver.exec("UPDATE _jobs SET run_at = ?, updated_at = ? WHERE id = ? AND state = 'claimed'", now, now, job.id as number);
        this.jobChanged(o.jobId);
        arm = true;
        continue;
      }
      const error = "error" in o ? o.error : null;
      if (error === null) {
        this.succeedJob(job);
        // The row leaves the queue: when another job comes sooner than its lease, the next time is unchanged (no arm).
        if (!cached || !(known! < (job.run_at as number))) arm = true;
      } else {
        this.driver.transaction(() => this.failJob(job, error));
        arm = true;
      }
    }
    if (!settled) return;
    if (!arm) {
      this.nextJobAt = known;
      return;
    }
    this.armAlarm(undefined, true);
  }

  /** Actions run from this shard: calls to this shard skip the RPC hop. */
  private actionRunner(): ActionRunner {
    const self: ShardApi = this;
    return new ActionRunner(this.cfg, this.env, (shard) => (shard === this.shardName ? self : (shardStub(this.env, this.cfg.schema.manifest, shard) as unknown as ShardApi)));
  }

  override async alarm(): Promise<void> {
    // Never throw: retries are counted per job, not by the platform's 6 alarm retries.
    // The alarm that woke us is spent: nothing is armed until this turn arms it, so no armAlarm() in it may skip
    // setAlarm because its target equals the one that just fired.
    this.lastArmed = undefined;
    this.resetAlarmCache();
    let ran = 0;
    try {
      if (this.refused) {
        // Runtime tables of a newer runtime: the alarm that fired was theirs (jobs, leases, maintenance). It is armed
        // again, a little later, without reading anything: after a roll-forward that runtime's alarm turn runs and
        // arms itself from its tables; after a restore, `restoreFinish` arms it.
        if (this.runtimeAhead) void this.ctx.storage.setAlarm(Date.now() + REFUSED_ALARM_MS);
        // A refused migration: the runtime tables are this runtime's, so the alarm follows them (due jobs, leases,
        // maintenance), never sooner than REFUSED_ALARM_MS. Without it, a fixed deploy that does not migrate (back to the
        // schema the shard holds) would arm nothing at boot, and due jobs would wait for the next commit.
        else this.armAlarm(Date.now() + REFUSED_ALARM_MS);
        return;
      }
      // A crash mid-dispatch can leave action jobs 'running'; give them back to the queue.
      // (`run_at` of a running job is its start + RUNNING_RECOVERY_MS: an index range, not a scan of `updated_at`.)
      // Dormant subscriptions run first only when one is given back (an alarm turn that writes nothing leaves them).
      if (this.dormant.size && this.driver.exec("SELECT 1 AS x FROM _jobs WHERE state = 'running' AND run_at <= ? LIMIT 1", Date.now()).rows.length) this.warmAll();
      for (const r of this.driver.exec("UPDATE _jobs SET state = 'pending', run_at = ? WHERE state = 'running' AND run_at <= ? RETURNING job_id", Date.now(), Date.now()).rows) {
        this.jobChanged(r.job_id as string | null);
      }
      if (this.getMeta("backfill") !== null) this.backfillTurn();
      while (ran < MAX_JOBS_PER_ALARM) {
        const now = Date.now();
        const job = this.driver.exec(NEXT_DUE_JOB_SQL, now).rows[0];
        if (!job) break;
        const room = MAX_JOBS_PER_ALARM - ran;
        if (job.kind === "action") {
          const batchable = !this.cfg.dispatchAction && typeof this.env.EMBER_ACTIONS?.sendBatch === "function";
          const batch = room > 1 && batchable && this.queuesAction(job) ? this.dueRun(now, Math.min(ACTION_JOB_GROUP, room), (j) => j.kind === "action" && this.queuesAction(j)) : [job];
          ran += batch.length;
          if (batch.length > 1) await this.dispatchActionJobs(batch);
          else await this.runActionJob(job);
        } else {
          const batch = room > 1 ? this.dueRun(now, Math.min(MUTATION_JOB_GROUP, room), (j) => j.kind !== "action") : [job];
          ran += batch.length;
          if (batch.length > 1) this.runMutationJobs(batch);
          else this.runMutationJob(job);
        }
      }
      const maint = this.getMeta("next_maint");
      if (maint !== null && Number(maint) <= Date.now()) await this.maintenance();
      await this.filesGc();
      if (this.hasExternal) await this.flushOutbox();
      if (this.replicated.size && this.isReplicatedSource) await this.drainReplicated();
    } catch (e) {
      console.error("ember: alarm failed", e);
    }
    this.lastArmed = undefined;
    this.resetAlarmCache();
    this.armAlarm();
  }

  /**
   * File GC (PLAN §7): rows unreferenced for the grace period are claimed (`deleting`), their objects deleted from
   * R2 unless another live row shares the key, then the rows go. A failed delete is retried a minute later.
   */
  private async filesGc(): Promise<number> {
    const due = this.files.nextGcAt();
    if (due === null || due > Date.now()) return 0;
    const batch = this.driver.transaction(() => this.files.gcBegin(Date.now(), 100));
    if (!batch.length) return 0;
    const keys = [...new Set(batch.filter((b) => b.deleteObject).map((b) => b.key))];
    const bucket = bucketOf(this.env);
    try {
      if (keys.length && bucket) await bucket.delete(keys);
    } catch (e) {
      console.error("ember: file GC could not delete objects (retrying later)", e);
      return 0;
    }
    this.driver.transaction(() => this.files.gcFinish(batch.map((b) => b.id)));
    this.stats.filesCollected += batch.length;
    return batch.length;
  }

  /** One chunk of staged-index backfill per alarm turn; the alarm re-arms immediately until done. */
  private backfillTurn(): void {
    try {
      // Before the step: the one that makes an index ready changes results (a query that failed with IndexNotReady may
      // work now). A dormant subscription must hold the value its client holds (the error) when that happens, or the
      // forced publish below, which re-runs errored entries, would never send it the new one.
      this.warmAll();
      const p = this.engine.backfillStep(this.cfg.backfillChunk ?? 500);
      this.stats.backfillSteps++;
      if (p.done) this.deleteMeta("backfill");
      if (p.processed) this.kickOutbox();
      // A query that failed with IndexNotReady may work now.
      if (p.indexReady) this.publish(this.version, [], undefined, true);
    } catch (e) {
      console.error("ember: backfill step failed", e);
    }
  }

  /**
   * The hourly tick, kept only while the shard is active: `active` = something committed since the last tick. A tick
   * after an idle hour (the last one a write causes) only cleans up and stands the tick down: the data is what the
   * previous tick's bookmark already points at, so it records no bookmark, and the catalog row it would report is the
   * one that tick reported (a report that failed is retried: `catalog_due`, by this tick, and while it fails again, by
   * a tick an hour later). The cleanups and the tick's own state are one transaction, written before the awaits: a
   * commit during them counts for the next tick (and, when this one stood the tick down, arms it again).
   */
  private async maintenance(): Promise<void> {
    const now = Date.now();
    // No await between this read and the write below (nothing can commit in between); still, the tick records the
    // version `active` was computed from, not whatever `this.version` holds when it writes.
    const version = String(this.version);
    const active = this.getMeta("maint_version") !== version;
    // Its own transaction (it also swaps the in-memory generation list).
    this.rotateDedup(now);
    this.warmGcJobs(now);
    this.driver.transaction(() => {
      this.gcJobs(now);
      const cutoff = now - BOOKMARK_RETENTION_MS;
      this.expireBookmarks(cutoff);
      if (this.subIdentInUse()) this.driver.exec("DELETE FROM _ember_sub_ident WHERE at < ?", cutoff);
      this.setMeta("maint_version", version);
      if (active) this.setMeta("next_maint", String(now + HOUR));
      else this.deleteMeta("next_maint");
    });
    this.maintArmed = active;
    if (active) {
      await this.recordBookmark("hourly");
      await this.reportCatalog(false);
    } else if (this.env.EMBER_REGISTRY && this.getMeta("catalog_due") !== null) {
      await this.reportCatalog(false);
      // Failed again: retried by a tick an hour later (one that finds nothing committed records no bookmark either).
      if (this.getMeta("catalog_due") !== null && this.getMeta("next_maint") === null) {
        this.setMeta("next_maint", String(Date.now() + HOUR));
        this.maintArmed = true;
      }
    }
    if (this.shardName && !this.isReplicatedSource && this.registrationDue()) await this.registerInCatalog(false);
  }

  /**
   * Bookmarks past retention. Ids follow time, so the oldest by id says whether any is past it (no scan of the table),
   * except after `restoreFinish` kept a row under a new id (`bookmarks_unordered`): then by time, until the rows left
   * are in time order by id again (no row older than one with a smaller id; a window over the small table, only while
   * the flag is set).
   */
  private expireBookmarks(cutoff: number): void {
    const unordered = this.getMeta("bookmarks_unordered") !== null;
    const oldest = unordered ? undefined : this.driver.exec("SELECT at FROM _ember_bookmarks ORDER BY id LIMIT 1").rows[0];
    if (unordered || (oldest && Number(oldest.at) < cutoff)) this.driver.exec("DELETE FROM _ember_bookmarks WHERE at < ?", cutoff);
    if (unordered && !this.driver.exec("SELECT 1 AS x FROM (SELECT at, MAX(at) OVER (ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS before FROM _ember_bookmarks) WHERE at < before LIMIT 1").rows.length) this.deleteMeta("bookmarks_unordered");
  }

  /**
   * `_ember_sub_ident` has rows (only clients without the "ident" feature write it): probed once per object instance
   * (and again after a restore or an import), then set by its only writer (`snap`). False lets maintenance skip its
   * unindexed DELETE.
   */
  private subIdent: boolean | undefined = undefined;

  private subIdentInUse(): boolean {
    if (this.subIdent === undefined) this.subIdent = this.driver.exec("SELECT 1 AS x FROM _ember_sub_ident LIMIT 1").rows.length > 0;
    return this.subIdent;
  }

  // ------------------------------------------------------------------ external indexes (ai-indexes.ts)

  private outboxResendMs(): number {
    return indexEnv(this.cfg, this.env)[INDEXING_QUEUE_BINDING] ? OUTBOX_RESEND_QUEUE_MS : OUTBOX_RESEND_LOCAL_MS;
  }

  /** After a commit that may have written the outbox: deliver in the background (the alarm is the fallback). */
  private touchesExternal(changes: readonly RowChange[]): boolean {
    if (!this.hasExternal) return false;
    for (const c of changes) if (this.externalTables.has(c.table)) return true;
    return false;
  }

  private kickOutbox(): void {
    if (!this.hasExternal || this.refused) return;
    this.ctx.waitUntil(this.flushOutbox());
  }

  /**
   * Claims deliverable outbox rows and sends them to the EMBER_INDEXING queue (one message per ≤50 documents of
   * one index), or — without a queue (dev, tests) — indexes them right here. One flush at a time per shard.
   */
  private flushOutbox(): Promise<void> {
    if (this.flushing) {
      this.flushAgain = true;
      return this.flushing;
    }
    const run = async () => {
      const shard = this.shardName;
      if (!shard) return; // learned on the first RPC / socket; the alarm retries
      const env = indexEnv(this.cfg, this.env);
      const queue = env[INDEXING_QUEUE_BINDING] as IndexQueue | undefined;
      do {
        this.flushAgain = false;
        const { batches, parked } = this.driver.transaction(() =>
          outboxClaim(this.driver, this.cfg.schema.manifest, this.cfg.schema.indexKinds, Date.now(), { resendMs: this.outboxResendMs() }),
        );
        for (const p of parked) console.error(`ember: external index ${p.table}.${p.index}: giving up on ${p.id} after repeated failures (re-sent when it changes)`);
        if (!batches.length) break;
        const messages: IndexMessage[] = batches.map((b) => ({ t: "ember.index", shard, table: b.table, index: b.index, ids: b.ids, claim: b.claim }));
        if (queue && typeof queue.sendBatch === "function") {
          try {
            await queue.sendBatch(messages.map((body) => ({ body })));
            this.stats.outboxSent += messages.length;
          } catch (e) {
            // Still in flight, re-sent in 30 s by the alarm (not hammering a failing queue).
            this.stats.outboxFailed += messages.length;
            console.error(`ember: indexing queue send failed (retrying in 30s): ${(e as Error).message}`);
            const at = Date.now() + 30_000;
            this.driver.transaction(() => batches.forEach((b) => outboxDefer(this.driver, b, at, this.outboxResendMs())));
            break;
          }
        } else {
          for (const m of messages) {
            try {
              await deliverIndexBatch({ env, rpc: () => this }, m);
              this.stats.outboxSent++;
            } catch (e) {
              this.stats.outboxFailed++;
              console.error(`ember: indexing ${m.table}.${m.index} failed (retrying in ${OUTBOX_RESEND_LOCAL_MS / 1000}s): ${(e as Error).message}`);
            }
          }
        }
      } while (this.flushAgain);
    };
    this.flushing = run()
      .catch((e) => console.error("ember: outbox flush failed", e))
      .finally(() => {
        this.flushing = null;
        this.lastArmed = undefined;
        this.resetAlarmCache();
        this.armAlarm();
      });
    return this.flushing;
  }

  /** Current state of outbox documents (the indexer calls this when it runs). */
  async extFetch(shard: string, table: string, index: string, ids: string[], claim: number | null = null): Promise<{ spec: IndexSpec | null; items: FetchedItem[] }> {
    this.setShardName(shard);
    if (this.refused) throw Object.assign(new Error(this.refused.message), { code: this.refused.code });
    try {
      return outboxFetch(this.driver, this.cfg.schema.manifest, this.cfg.schema.indexKinds, table, index, ids, claim);
    } catch (e) {
      if ((e as { code?: string }).code !== "IndexNotFound") throw e;
      // The index was removed or renamed (or the message is malformed): nothing will ever deliver these rows, so
      // forget them and let the consumer acknowledge the message instead of retrying it forever.
      outboxForget(this.driver, table, index);
      return { spec: null, items: [] };
    }
  }

  /** Delivered under `claim`: drop rows still at that claim and seq; others are pending / re-enqueued (fencing). */
  async extAck(shard: string, table: string, index: string, acks: Array<{ id: string; seq: number | null }>, claim: number | null = null): Promise<number> {
    this.setShardName(shard);
    const pending = this.driver.transaction(() => outboxAck(this.driver, table, index, acks, claim));
    if (pending > 0) this.kickOutbox();
    return pending;
  }

  /** Local fallback store (EMBER_AI_INDEXES=local without the service binding). */
  async extLocalApply(shard: string, table: string, index: string, ops: LocalOp[]): Promise<void> {
    this.setShardName(shard);
    this.driver.exec(LOCAL_DDL);
    this.driver.transaction(() => {
      for (const op of ops) {
        if (op.delete) this.driver.exec("DELETE FROM _ember_ext_local WHERE tbl = ? AND idx = ? AND id = ?", table, index, op.id);
        else {
          const vec = op.values ? new Uint8Array(Float32Array.from(op.values).buffer) : null;
          this.driver.exec(
            "INSERT INTO _ember_ext_local(tbl, idx, id, vec, text, meta) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(tbl, idx, id) DO UPDATE SET vec = excluded.vec, text = excluded.text, meta = excluded.meta",
            table, index, op.id, vec, op.text ?? null, JSON.stringify(op.metadata ?? {}),
          );
        }
      }
    });
  }

  async extLocalSearch(shard: string, table: string, index: string, q: LocalSearch): Promise<LocalHit[]> {
    this.setShardName(shard);
    this.driver.exec(LOCAL_DDL);
    const rows = this.driver.exec("SELECT id, vec, text, meta FROM _ember_ext_local WHERE tbl = ? AND idx = ?", table, index).rows.map((r) => ({
      id: String(r.id),
      vec: (r.vec as Uint8Array | null) ?? null,
      text: (r.text as string | null) ?? null,
      meta: JSON.parse(String(r.meta)) as Record<string, MetadataValue>,
    }));
    return localSearch(rows, q, matchesFilter);
  }

  // ------------------------------------------------------------------ websockets

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    this.setShardName(request.headers.get("x-ember-shard"));
    const idHeader = request.headers.get("x-ember-identity");
    const identity = idHeader ? (JSON.parse(idHeader) as Identity) : null;
    // The Worker verified the token, but this shard was told its session ended (`revokeSockets`).
    if (this.isRevoked(identity)) return new Response("access revoked: sign in again", { status: 401 });
    const token = identity ? (request.headers.get("x-ember-token") ?? undefined) : undefined;
    const pair = new WebSocketPair();
    const server = pair[1];
    const sid = crypto.randomUUID();
    this.ctx.acceptWebSocket(server, [`sid:${sid}`]);
    this.saveAttachment(server, { sid, identity, clientId: null, hello: false, ...(token ? { token } : {}) });
    this.sockets.set(sid, server);
    if (this.refused) this.send(server, { t: "err", code: this.refused.code, message: this.refused.message });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /** The attachment last written to each socket (every `serializeAttachment` goes through `serialize`). */
  private readonly wsAttachment = new WeakMap<WebSocket, Attachment>();

  private serialize(ws: WebSocket, att: Attachment): void {
    ws.serializeAttachment(att);
    this.wsAttachment.set(ws, att);
  }

  /** The socket's attachment: from memory, or deserialized once after a wake (no structured clone per message). */
  private attachmentOf(ws: WebSocket): Attachment {
    let att = this.wsAttachment.get(ws);
    if (!att) {
      att = ws.deserializeAttachment() as Attachment;
      if (att) this.wsAttachment.set(ws, att);
    }
    return att;
  }

  /** `JSON.stringify(subs).length` per subs array (they are replaced, never mutated: see `persistSub`). */
  private readonly subsSize = new WeakMap<object, number>();

  private saveAttachment(ws: WebSocket, att: Attachment): void {
    const { subs, ...base } = att;
    let a: Attachment = base;
    // The size of the attachment without `subs`: encoded once, again only when a field is dropped.
    let size = JSON.stringify(a).length;
    if (size > MAX_ATTACHMENT_BYTES && a.identity) {
      const { claims: _drop, ...rest } = a.identity;
      a = { ...a, identity: rest };
      size = JSON.stringify(a).length;
    }
    if (size > MAX_ATTACHMENT_BYTES && a.token) {
      // Sensitive mutations on this socket will be refused (`reauth_required`) instead.
      const { token: _drop, ...rest } = a;
      a = rest;
      size = JSON.stringify(a).length;
    }
    if (a.acks?.length) this.ackedSockets.add(a.sid);
    const pending = this.unflushed.get(ws);
    this.unflushed.delete(ws);
    if (subs?.length) {
      const withSubs: Attachment = { ...a, subs };
      let subsSize = this.subsSize.get(subs);
      if (subsSize === undefined) this.subsSize.set(subs, (subsSize = JSON.stringify(subs).length));
      // `{…a,"subs":[…]}`: `a` always has `sid`, and `subs` is its last key.
      if (size + ',"subs":'.length + subsSize <= MAX_ATTACHMENT_BYTES) {
        a = withSubs;
        // Subscriptions recorded in this frame that sat in the table: now in the attachment only.
        for (const qk of pending ?? []) this.deleteTableSub(a.sid, qk);
      } else for (const [qk, fn, args] of subs) this.writeTableSub(a.sid, qk, fn, args);
    }
    this.serialize(ws, a);
    this.attachments.set(a.sid, a);
  }

  override async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    const att = this.attachmentOf(ws);
    this.eph.touch(att.sid);
    // Serialize handling per socket: `hello` may await token verification.
    const prev = this.chains.get(att.sid) ?? Promise.resolve();
    const next = prev.then(() => this.handleMessage(ws, data)).catch((e) => {
      this.send(ws, { t: "err", code: "internal", message: errInfo(e, "internal").message });
    });
    this.chains.set(att.sid, next);
    await next;
  }

  private async handleMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    let msgs: Array<ClientMessage | ProtocolError>;
    try {
      msgs = decodeClientFrame(data);
    } catch (e) {
      const code = e instanceof ProtocolError ? e.code : "bad_frame";
      this.send(ws, { t: "err", code, message: (e as Error).message });
      return;
    }
    // A batch (feature "batch") runs in order, as if its messages had come one frame each.
    try {
      for (const msg of msgs) {
        if (msg instanceof ProtocolError) this.send(ws, { t: "err", code: msg.code, message: msg.message });
        else await this.handleOne(ws, msg);
      }
    } finally {
      this.flushSubs(ws);
    }
  }

  private async handleOne(ws: WebSocket, msg: ClientMessage): Promise<void> {
    // Before a message that may await (token checks): other events can run meanwhile and read the attachment.
    if (msg.t === "hello" || msg.t === "auth" || msg.t === "mut") this.flushSubs(ws);
    let att = this.attachmentOf(ws);
    this.sockets.set(att.sid, ws);
    this.attachments.set(att.sid, att);
    if (att.acks?.length) this.ackedSockets.add(att.sid);
    if (msg.t !== "hello" && !att.hello) {
      this.send(ws, { t: "err", code: "no_hello", message: "send hello first" });
      return;
    }
    // An expired (or revoked) token never runs anything anonymously: the frame is refused until the client sends `auth`.
    if ((msg.t === "sub" || msg.t === "mut" || msg.t === "q") && (isExpired(att.identity) || this.isRevoked(att.identity))) {
      const error = { code: "auth_expired", message: "the token expired; send {t:\"auth\"} with a fresh one" };
      this.send(ws, { t: "authExpired" });
      if (msg.t === "mut") this.send(ws, { t: "mres", mid: msg.mid, ok: false, error });
      else if (msg.t === "q") this.send(ws, { t: "qres", qid: msg.qid, ok: false, error });
      else this.send(ws, { t: "err", ...error, qid: msg.qid });
      return;
    }
    // A refused migration: nothing runs on the old schema with the new code.
    if (this.refused && (msg.t === "sub" || msg.t === "mut" || msg.t === "q")) {
      if (msg.t === "mut") this.send(ws, { t: "mres", mid: msg.mid, ok: false, error: this.refused });
      else if (msg.t === "q") this.send(ws, { t: "qres", qid: msg.qid, ok: false, error: this.refused });
      else this.send(ws, { t: "err", ...this.refused, qid: msg.qid });
      return;
    }
    // Runtime tables of a newer runtime: no subscription or mutation outcome lives here to drop or acknowledge.
    if (this.runtimeAhead && (msg.t === "unsub" || msg.t === "ack")) return;
    switch (msg.t) {
      case "hello": {
        if (att.hello) {
          this.send(ws, { t: "err", code: "duplicate_hello", message: "hello already received" });
          return;
        }
        let verified: Identity | null = null;
        if (msg.token !== undefined) {
          verified = await this.verify(msg.token);
          if (!verified) this.send(ws, { t: "err", code: "unauthenticated", message: "invalid token" });
        }
        // Read after the await: a revocation may have marked this socket meanwhile, and must not be written over.
        const current = ws.deserializeAttachment() as Attachment;
        const identity = verified ?? current.identity;
        const token = verified ? msg.token : current.token;
        // What this hello negotiates replaces what an earlier one did (a hello racing another past the check above).
        const { token: _old, ack: _ack, rum: _rum, ...prevAtt } = current;
        const rowdiff = msg.features?.includes("rowdiff") === true;
        const vdiff = msg.features?.includes("vdiff") === true;
        const ident = msg.features?.includes("ident") === true;
        const acks = msg.features?.includes("ack") === true;
        const batch = msg.features?.includes("batch") === true;
        const zframe = msg.features?.includes("zframe") === true && zframeSupported();
        const rum = msg.features?.includes("rum") === true;
        const ephemeral = msg.features?.includes("ephemeral") === true;
        att = { ...prevAtt, ...(rum ? { rum: true as const } : {}), identity, clientId: msg.clientId, hello: true, ...(identity && token ? { token } : {}), ...(rowdiff ? { rowdiff: true as const } : {}), ...(vdiff ? { vdiff: true as const } : {}), ...(ident ? { ident: true as const } : {}), ...(batch ? { batch: true as const } : {}), ...(acks ? { ack: true as const } : {}), ...(zframe ? { zframe: true as const } : {}), ...(ephemeral ? { eph: prevAtt.eph ?? { m: memberId(), ch: [] } } : {}) };
        this.saveAttachment(ws, att);
        const features = [...(rowdiff ? ["rowdiff" as const] : []), ...(vdiff ? ["vdiff" as const] : []), ...(ident ? ["ident" as const] : []), ...(msg.features?.includes("query") ? ["query" as const] : []), ...(acks ? ["ack" as const] : []), ...(batch ? ["batch" as const] : []), ...(msg.features?.includes("qbatch") ? ["qbatch" as const] : []), ...(zframe ? ["zframe" as const] : []), ...(ephemeral ? ["ephemeral" as const] : []), ...(rum ? ["rum" as const] : [])];
        const colo = rum ? this.coloFor() : null;
        this.send(ws, { t: "ready", shard: this.shardName ?? "", version: this.version, epoch: this.epoch, ...(features.length ? { features } : {}), ...(colo ? { colo } : {}) });
        // `ready` goes out alone (the client reads it before it knows the server batches), and as text (before it knows
        // the server compresses); everything after may batch, and go compressed.
        if (batch) this.batching.add(ws);
        if (zframe) this.zframes.add(ws);
        return;
      }
      case "q": {
        const denied = this.checkCallable(msg.fn, "query");
        if (denied) {
          this.send(ws, { t: "qres", qid: msg.qid, ok: false, error: denied });
          return;
        }
        const p = this.probe();
        try {
          const ctx: AuthCtx = { identity: att.identity };
          const cached = this.cachedValue(msg.fn, msg.args, ctx);
          const r = cached ?? this.engine.runQuery(msg.fn, msg.args, ctx);
          const value = r.value;
          const usage = "usage" in r ? r.usage : undefined;
          this.emit(p, "query", msg.fn, null, () => stringify(value ?? null).length, "none", usage);
          this.limitAdvice(msg.fn, usage);
          this.send(ws, { t: "qres", qid: msg.qid, ok: true, value, version: this.version });
        } catch (e) {
          const error = errInfo(e, "Error");
          this.emit(p, "query", msg.fn, error, undefined, "none");
          this.send(ws, { t: "qres", qid: msg.qid, ok: false, error });
        }
        return;
      }
      case "sub":
        this.warmDormant(Infinity, att.sid);
        this.subscribe(ws, att, msg);
        return;
      case "unsub":
        if (this.detach(att.sid, msg.qid)) this.unpersistSub(ws, att, qidKey(msg.qid));
        return;
      case "ack":
        this.acknowledge(ws, att, msg.mids);
        return;
      // Feature "ephemeral": channels in memory, no row and no version (ephemeral.ts).
      case "join":
        this.eph.join(ws, att.sid, msg.ch, msg.state, "state" in msg, msg.ref);
        return;
      case "leave":
        this.eph.leave(ws, att.sid, msg.ch);
        return;
      case "pub":
        this.eph.publish(ws, att.sid, msg.ch, msg.data, msg.ref);
        return;
      case "mut": {
        const ctx: AuthCtx = { identity: att.identity };
        const mid = msg.mid;
        const denied = this.checkCallable(msg.fn, "mutation") ?? (await this.checkSensitive(msg.fn, att));
        if (denied) {
          this.send(ws, { t: "mres", mid, ok: false, error: denied });
          return;
        }
        this.enqueue({
          fn: msg.fn,
          args: msg.args,
          ctx,
          dedup: { identity: identityKey(att.identity), clientId: att.clientId ?? "", mid: qidKey(mid) },
          origin: { sid: att.sid, mid },
          ...(att.ack ? { acks: true as const } : {}),
          at: Date.now(),
          // The outcome was encoded once for the dedup ring: the frame is that JSON behind `t`/`mid` (same keys, same
          // order as the object form below), not a second encoding of the value.
          resolve: (o, json) =>
            this.send(ws, json !== undefined ? mresFrame(mid, json) : o.ok ? { t: "mres", mid, ok: true, value: o.value, version: o.version } : { t: "mres", mid, ok: false, error: o.error }),
        });
        return;
      }
      case "auth": {
        // `token: null` = sign out: the socket continues anonymously.
        let identity: Identity | null = null;
        if (msg.token !== null) {
          identity = await this.verify(msg.token);
          if (!identity) {
            this.send(ws, { t: "err", code: "unauthenticated", message: "invalid token" });
            return;
          }
        }
        const { token: _old, ...prevAtt } = ws.deserializeAttachment() as Attachment;
        // Attached acks are mids, keyed by the socket's identity when read back (`rebuildRegistry`, `applyRing`): under
        // another identity they would name that identity's outcomes. Their full keys stay in `pendingAcks` and land in
        // the next ring row; a hibernation before it loses them, which only spills those outcomes.
        if (prevAtt.acks && identityKey(prevAtt.identity) !== identityKey(identity)) delete prevAtt.acks;
        // A renewal (same identity and claims, a later `exp`) while every patch reached the socket: its values are
        // current and every entry and gate it reads stays the same, so only the token changes (no re-run, no snaps).
        const renewal = sameIdentityClaims(prevAtt.identity, identity) && !this.expiredNotified.has(att.sid) && !isExpired(prevAtt.identity) && !this.isRevoked(prevAtt.identity);
        att = { ...prevAtt, identity, ...(msg.token !== null ? { token: msg.token } : {}) };
        this.saveAttachment(ws, att);
        this.expiredNotified.delete(att.sid);
        if (renewal) {
          // Dormant subscriptions stay dormant: their values are as current as the live ones'.
          this.stats.authRenewals++;
          return;
        }
        // Its channels are authorized again under the new identity (feature "ephemeral").
        this.eph.reauth(ws, att.sid);
        // Not a renewal: a frame still being compressed for this socket (feature "zframe") holds values of the identity
        // before; its `snap`/`patch` are dropped unsent (as on a revocation), and the fresh snaps below replace them.
        if (this.zsending.has(ws)) this.zcut.set(ws, (this.zcut.get(ws) ?? 0) + 1);
        // Identity changed: every subscription of this socket is re-evaluated under the new identity (the dormant ones
        // run first, so each has its entry to re-bind from).
        this.warmDormant(Infinity, att.sid);
        for (const sub of [...(this.subs.get(att.sid)?.values() ?? [])]) {
          const old = this.queries.get(sub.key);
          this.detach(att.sid, sub.qid);
          const { entry, gate } = this.bind(att.sid, sub.qid, old?.fn ?? "", old?.args ?? {}, identity);
          this.sendSnap(ws, att, sub.qid, entry, gate);
        }
        return;
      }
    }
  }

  /**
   * `sensitive` mutations over a socket: the identity must still have a live session in the Auth DO (sign-out and
   * revocation are immediate, not after the JWT's 5 minutes). Anonymous sockets run them anonymously.
   */
  private async checkSensitive(fn: string, att: Attachment): Promise<{ code: string; message: string } | null> {
    if (!att.identity || !this.engine.functionInfo(fn)?.sensitive) return null;
    const hook = this.cfg.auth;
    if (!att.token || !hook) return { code: "reauth_required", message: `${fn} is sensitive: send {t:"auth"} with a fresh token` };
    let fresh: Identity | null = null;
    try {
      fresh = (await hook.verify(att.token, { sensitive: true, waitUntil: this.waitUntil })) ?? null;
    } catch {
      fresh = null;
    }
    if (!fresh || fresh.subject !== att.identity.subject) return { code: "unauthenticated", message: "the session is no longer valid" };
    return null;
  }

  /** The auth hook's background work (the JWKS refresh after its TTL) outlives the event that started it. */
  private readonly waitUntil = (p: Promise<unknown>): void => this.ctx.waitUntil(p);

  /** A verified, unexpired identity, or null. */
  private async verify(token: string): Promise<Identity | null> {
    const hook = this.cfg.auth;
    if (!hook) return null;
    try {
      const identity = (await hook.verify(token, { waitUntil: this.waitUntil })) ?? null;
      return isExpired(identity) || this.isRevoked(identity) ? null : identity;
    } catch {
      return null;
    }
  }

  /** Clients may only call public functions of the right type (internal ones are for the scheduler and crons). */
  private checkCallable(fn: string, type: "query" | "mutation", internal = false): { code: string; message: string } | null {
    if (this.refused) return this.refused;
    const info = this.engine.functionInfo(fn);
    if (!info || (info.visibility !== "public" && !internal)) return { code: "FunctionNotFound", message: `Function ${fn} not found` };
    if (info.type !== type) return { code: "InvalidFunction", message: `${fn} is a ${info.type}, not a ${type}` };
    return null;
  }

  /** Full snapshot (or error) of one subscription; remembers the identity it was computed under for `resume`. */
  private sendSnap(ws: WebSocket, att: Attachment, qid: Id, entry: QueryEntry, gate?: GateEntry): void {
    const error = gate?.error ?? entry.error;
    if (error) {
      this.send(ws, { t: "err", ...error, qid });
      return;
    }
    const valueField = entry.value === undefined ? "" : `,"value":${entry.json}`;
    if (att.ident) {
      this.send(ws, `{"t":"snap","qid":${stringify(qid)},"version":${this.version}${valueField},"ik":${stringify(identTag(att.identity))}}`);
      return;
    }
    if (att.clientId) {
      this.subIdent = true;
      this.driver.exec(
        "INSERT INTO _ember_sub_ident(client_id, qid, identity, at) VALUES (?, ?, ?, ?) ON CONFLICT(client_id, qid) DO UPDATE SET identity = excluded.identity, at = excluded.at",
        att.clientId, qidKey(qid), identityKey(att.identity), Date.now(),
      );
    }
    this.send(ws, `{"t":"snap","qid":${stringify(qid)},"version":${this.version}${valueField}}`);
  }

  /**
   * Records a subscription for hibernation: in the attachment when it fits (free), else a `_ember_subs` row. The
   * attachment is written once at the end of the frame (`flushSubs`), not once per `sub` of a batch frame (each write
   * was a JSON.stringify of the whole attachment and a structured clone).
   */
  private persistSub(ws: WebSocket, att: Attachment, qk: string, fn: string, args: string): Attachment {
    const next: Attachment = { ...att, subs: [...(att.subs ?? []).filter((x) => x[0] !== qk), [qk, fn, args]] };
    this.wsAttachment.set(ws, next);
    this.attachments.set(att.sid, next);
    let pending = this.unflushed.get(ws);
    if (!pending) this.unflushed.set(ws, (pending = new Set()));
    pending.add(qk);
    return next;
  }

  /** Forgets a subscription in both stores (it should be in one; a leftover in the other would revive it). */
  private unpersistSub(ws: WebSocket, att: Attachment, qk: string): void {
    if (att.subs?.some((x) => x[0] === qk)) {
      const next: Attachment = { ...att, subs: att.subs.filter((x) => x[0] !== qk) };
      this.wsAttachment.set(ws, next);
      this.attachments.set(att.sid, next);
      if (!this.unflushed.has(ws)) this.unflushed.set(ws, new Set());
    }
    this.unflushed.get(ws)?.delete(qk);
    this.deleteTableSub(att.sid, qk);
  }

  /** Sockets whose attachment changed in this frame, with the qids `persistSub` recorded (not in any store yet). */
  private readonly unflushed = new Map<WebSocket, Set<string>>();

  /**
   * Writes the attachment of a socket whose subscriptions changed in this frame. The ones recorded in the frame stay
   * in it while it fits (oldest first), the rest go to `_ember_subs`; each qid ends in exactly one store.
   */
  private flushSubs(ws: WebSocket): void {
    const pending = this.unflushed.get(ws);
    if (!pending) return;
    this.unflushed.delete(ws);
    const att = this.wsAttachment.get(ws);
    if (!att) return;
    if (JSON.stringify(att).length <= MAX_ATTACHMENT_BYTES) {
      this.serialize(ws, att);
      for (const qk of pending) this.deleteTableSub(att.sid, qk); // it was in the table (overflow, older runtime)
      return;
    }
    const subs = att.subs ?? [];
    const kept = subs.filter((x) => !pending.has(x[0]));
    let size = JSON.stringify({ ...att, subs: kept }).length;
    const accepted: Array<[string, string, string]> = [];
    for (const x of subs) {
      if (!pending.has(x[0])) continue;
      const add = JSON.stringify(x).length + 1;
      if (size + add <= MAX_ATTACHMENT_BYTES) {
        size += add;
        accepted.push(x);
        this.deleteTableSub(att.sid, x[0]);
      } else this.writeTableSub(att.sid, x[0], x[1], x[2]);
    }
    const next: Attachment = { ...att, subs: [...kept, ...accepted] };
    this.serialize(ws, next);
    this.attachments.set(att.sid, next);
  }

  private tableSubsOf(sid: string): Set<string> {
    let set = this.tableSubs.get(sid);
    if (!set) this.tableSubs.set(sid, (set = new Set()));
    return set;
  }

  private writeTableSub(sid: string, qk: string, fn: string, args: string): void {
    this.driver.exec("INSERT OR REPLACE INTO _ember_subs(sock, qid, fn, args) VALUES (?, ?, ?, ?)", sid, qk, fn, args);
    this.tableSubsOf(sid).add(qk);
  }

  /** Deletes the qid's `_ember_subs` row if it has one (known in memory: no query, no row written otherwise). */
  private deleteTableSub(sid: string, qk: string): void {
    const set = this.tableSubs.get(sid);
    if (!set?.delete(qk)) return;
    if (!set.size) this.tableSubs.delete(sid);
    this.driver.exec("DELETE FROM _ember_subs WHERE sock = ? AND qid = ?", sid, qk);
  }

  private subscribe(ws: WebSocket, att: Attachment, msg: Extract<ClientMessage, { t: "sub" }>): void {
    const existing = this.subs.get(att.sid)?.get(qidKey(msg.qid));
    if (existing) {
      // Re-subscribing an errored (or refused) qid re-runs it; a healthy duplicate is a client bug.
      if (!this.queries.get(existing.key)?.error && !(existing.gate && this.gates.get(existing.gate)?.error)) {
        this.send(ws, { t: "err", code: "duplicate_qid", message: "qid already subscribed", qid: msg.qid });
        return;
      }
      this.detach(att.sid, msg.qid);
    }
    const denied = this.checkCallable(msg.fn, "query");
    if (denied) {
      this.send(ws, { t: "err", ...denied, qid: msg.qid });
      return;
    }
    // A failing query stays subscribed (errored) and is re-run after matching commits or on re-sub.
    const { entry, gate } = this.bind(att.sid, msg.qid, msg.fn, msg.args, att.identity);
    att = this.persistSub(ws, att, qidKey(msg.qid), msg.fn, stringify(msg.args));
    if (!gate?.error && !entry.error && msg.resume && entry.readSet && this.resumeUnchanged(msg.resume, att, msg.qid, entry)) {
      this.send(ws, { t: "snap", qid: msg.qid, version: this.version, unchanged: true });
    } else {
      this.sendSnap(ws, att, msg.qid, entry, gate);
    }
  }

  /**
   * True when the client's value at `resume.version` is still current: same epoch, the client's last snapshot
   * of this qid was computed under the socket's current identity, every version since is in the change log,
   * and none of those changes touches the query's read-set.
   */
  private resumeUnchanged(resume: { version: number; epoch: string; ik?: string }, att: Attachment, qid: Id, entry: QueryEntry): boolean {
    const readSet = entry.readSet;
    if (!readSet) return false;
    if (resume.epoch !== this.epoch || resume.version > this.version) return false;
    if (!this.resumable(readSet, resume.version, entry)) return false;
    if (att.ident) {
      // The tag of the snapshot the client holds (echoed): same identity as this socket's, or a full snap.
      if (resume.ik !== identTag(att.identity)) return false;
    } else {
      if (!att.clientId) return false;
      const owner = this.driver.exec("SELECT identity FROM _ember_sub_ident WHERE client_id = ? AND qid = ?", att.clientId, qidKey(qid)).rows[0];
      if (!owner || owner.identity !== identityKey(att.identity)) return false;
    }
    if (resume.version === this.version) return true;
    // A reconnect storm (after a deploy) resumes the same few queries from the same few versions: the answer for
    // (entry, version) holds until the shard's version moves (a commit re-runs the entry and may change its read set).
    let memo = this.resumeMemo;
    if (memo.version !== this.version) this.resumeMemo = memo = { version: this.version, byEntry: new Map() };
    let byVersion = memo.byEntry.get(entry);
    if (!byVersion) memo.byEntry.set(entry, (byVersion = new Map()));
    const known = byVersion.get(resume.version);
    if (known !== undefined) return known;
    const changes = this.changesSince(resume.version);
    const unchanged = changes !== null && !this.engine.matches(readSet, changes);
    byVersion.set(resume.version, unchanged);
    return unchanged;
  }

  /** `resumeUnchanged` answers per (entry, resume version), valid for the shard version they were computed at. */
  private resumeMemo: { version: number; byEntry: Map<QueryEntry, Map<number, boolean>> } = { version: -1, byEntry: new Map() };
  /**
   * Parsed change-log rows by version (a version's changes never change; a ring slot is reused only for a newer one):
   * resumes read and parse each row once, not once per subscription.
   */
  private readonly parsedChanges = new Map<number, RowChange[] | null>();
  private parsedSize = 0;

  /** Every change after `version`, or null when the change log no longer covers them all (too old: full snapshot). */
  private rememberChanges(version: number, changes: RowChange[]): void {
    // A version over `changeLogEntryMaxBytes` (`applyRing` marked it null): only a snapshot answers a resume across it,
    // from memory as from its row. The mark survives the reset, and its changes are never kept.
    const oversized = this.parsedChanges.get(version) === null;
    if (this.parsedSize > 20_000) {
      this.parsedChanges.clear();
      this.parsedSize = 0;
      if (oversized) this.parsedChanges.set(version, null);
    }
    if (!oversized && !this.parsedChanges.has(version)) {
      this.parsedChanges.set(version, changes);
      this.parsedSize += changes.length;
    }
    const old = version - ringSize(this.cfg);
    if (this.parsedChanges.has(old)) {
      this.parsedSize -= this.parsedChanges.get(old)?.length ?? 0;
      this.parsedChanges.delete(old);
    }
  }

  private changesSince(version: number): RowChange[] | null {
    // Further back than the change log holds: no read can answer it.
    if (this.version - version > ringSize(this.cfg)) return null;
    const out: RowChange[] = [];
    let missing = false;
    for (let v = version + 1; v <= this.version; v++) {
      const c = this.parsedChanges.get(v);
      // A version whose changes were over `changeLogEntryMaxBytes`: only a full snapshot answers.
      if (c === null) return null;
      if (!c) {
        missing = true;
        break;
      }
      for (const x of c) out.push(x);
    }
    if (!missing) return out;
    const rows = this.driver.exec("SELECT version, changes FROM _ember_changes WHERE version > ? ORDER BY version", version).rows;
    // A version gone from the ring (one row short) or an oversized one in range (its out-of-ring row: one more).
    if (rows.length !== this.version - version) return null;
    // Bounded: a resume burst keeps a few thousand changes; dropped whole (and re-read) past that.
    if (this.parsedSize > 20_000) {
      this.parsedChanges.clear();
      this.parsedSize = 0;
    }
    const all: RowChange[] = [];
    for (const r of rows) {
      const v = Number(r.version);
      let c = this.parsedChanges.get(v);
      if (c === undefined) {
        c = parse(r.changes as string) as RowChange[] | null;
        this.parsedChanges.set(v, c);
        this.parsedSize += c?.length ?? 0;
      }
      if (c === null) return null;
      for (const x of c) all.push(x);
    }
    for (const v of this.parsedChanges.keys()) if (v <= this.version - ringSize(this.cfg)) this.parsedChanges.delete(v);
    return all;
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (att?.sid) this.dropSocket(att.sid);
    this.outbox.delete(ws);
    this.unflushed.delete(ws);
    this.zsending.delete(ws);
    this.zclosed.add(ws);
    try {
      ws.close(code, reason);
    } catch {
      // already closed
    }
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (att?.sid) this.dropSocket(att.sid);
    // Frames queued for a broken socket are never sent: as on close, nothing of it is kept.
    this.outbox.delete(ws);
    this.unflushed.delete(ws);
    this.zsending.delete(ws);
    this.zclosed.add(ws);
  }

  // ------------------------------------------------------------------ RPC (Worker / System)

  /** Pre-warm: construct, migrate and load the registry while the Worker verifies auth. */
  async warm(shard: string): Promise<{ version: number; epoch: string }> {
    this.setShardName(shard);
    return { version: this.version, epoch: this.epoch };
  }

  /** `internal`: callers inside the deployment (actions) may run internal functions; clients may not. */
  /**
   * `internal`: callers inside the deployment (actions) may run internal functions; clients may not.
   * `opts.caller`: the caller measures this RPC and records the point (`outcome.metrics` carries the rows).
   */
  async query(
    shard: string,
    fn: string,
    args: unknown,
    identity: Identity | null,
    internal = false,
    opts: { caller?: boolean; system?: boolean; resume?: { version: number; epoch: string; ik: string }; warm?: boolean } = {},
  ): Promise<MutationOutcome> {
    this.setShardName(shard);
    return this.queryNow(fn, args, identity, internal, opts);
  }

  /**
   * `POST /api/query/batch`: up to `MAX_QUERY_BATCH` client queries in one RPC, all under the request's one verified
   * identity. Each is exactly one `query(…, internal = false, { caller: true })` (the same public-function, revocation,
   * `authorize` and argument checks) with its own outcome: one failing never fails the others. Synchronous inside, so
   * every outcome is at the same shard version.
   */
  async queryBatch(shard: string, items: QueryBatchItem[], identity: Identity | null): Promise<MutationOutcome[]> {
    this.setShardName(shard);
    if (!Array.isArray(items) || items.length > MAX_QUERY_BATCH) throw Object.assign(new Error(`at most ${MAX_QUERY_BATCH} queries per batch`), { code: "InvalidArgument" });
    return items.map((q) => this.queryNow(q.fn, q.args, identity, false, { caller: true, ...(q.resume ? { resume: q.resume } : {}), ...(q.warm === true ? { warm: true } : {}) }));
  }

  private queryNow(
    fn: string,
    args: unknown,
    identity: Identity | null,
    internal: boolean,
    opts: { caller?: boolean; system?: boolean; resume?: { version: number; epoch: string; ik: string }; warm?: boolean },
  ): MutationOutcome {
    const denied = this.checkCallable(fn, "query", internal) ?? this.checkRevoked(identity);
    if (denied) return { ok: false, error: denied };
    const p = opts.caller ? { t: 0, r: this.driver.rowsRead, w: this.driver.rowsWritten } : this.probe();
    let usage: Usage | undefined;
    const metrics = (bytesOut: number, error?: { code: string }): CallMetrics => ({ rowsRead: this.driver.rowsRead - p!.r, rowsWritten: this.driver.rowsWritten - p!.w, bytesOut, ...usageMetrics(usage, error) });
    try {
      const ctx: AuthCtx = callerCtx(identity, internal && opts.system === true);
      const cached = this.cachedValue(fn, args, ctx);
      // A client query whose subscription follows (`httpFirst`): its run is kept for that `sub` (`takePrefetched`).
      const r = cached ?? (opts.warm === true && !internal ? this.prefetchRun(fn, args, ctx) : this.engine.runQuery(fn, args, ctx));
      if ("usage" in r) usage = r.usage;
      this.limitAdvice(fn, usage);
      const value = r.value;
      const at = { version: this.version, epoch: this.epoch, ik: identTag(identity) };
      // The caller's value (same epoch and identity) is still current: nothing it read changed since its version.
      const rs = opts.resume;
      if (rs && r.readSet && rs.epoch === this.epoch && rs.ik === at.ik && rs.version <= this.version && this.resumable(r.readSet, rs.version, cached?.entry)) {
        const changes = rs.version === this.version ? [] : this.changesSince(rs.version);
        if (changes !== null && !(changes.length && this.engine.matches(r.readSet, changes))) {
          if (opts.caller) return { ok: true, unchanged: true, ...at, metrics: metrics(0) };
          this.emit(p, "query", fn, null, () => 0, "none", usage);
          return { ok: true, unchanged: true, ...at };
        }
      }
      // The result's size only when metrics are on (serializing it again costs as much as the reply itself).
      if (opts.caller) return { ok: true, value, ...at, metrics: metrics(metricsEnabled(this.env) ? stringify(value ?? null).length : 0) };
      // Synchronous inside the DO: in production the clock does not move here (0 ms, timing "none").
      this.emit(p, "query", fn, null, () => stringify(value ?? null).length, "none", usage);
      return { ok: true, value, ...at };
    } catch (e) {
      const error = errInfo(e, "Error");
      if (opts.caller) return { ok: false, error, metrics: metrics(0, error) };
      this.emit(p, "query", fn, error, undefined, "none");
      return { ok: false, error };
    }
  }

  /** Callers (Worker, actions, auth outbox) have already verified `identity`, including `sensitive` functions. */
  async mutation(
    shard: string,
    fn: string,
    args: unknown,
    identity: Identity | null,
    internal = false,
    opts: MutationCallOptions = {},
  ): Promise<MutationOutcome> {
    this.setShardName(shard);
    const denied = this.checkCallable(fn, "mutation", internal) ?? this.checkRevoked(identity);
    if (denied) return { ok: false, error: denied };
    const dedup = opts.dedupKey ? { dedup: { identity: identityKey(identity), clientId: "\u0000rpc", mid: opts.dedupKey, okOnly: true } } : {};
    return new Promise((resolve) => this.enqueue({ fn, args, ctx: callerCtx(identity, internal && opts.system === true), resolve, at: Date.now(), ...(opts.caller ? { caller: true } : {}), ...dedup }));
  }

  /**
   * Ends access for an identity on this shard now, instead of when its token expires (an app's session-end hook: a
   * sign-out, a revoked session, a password reset, a member removed). Every socket whose identity `match` reaches is
   * told `authExpired` and runs nothing until it sends a fresh token (`close: true` closes it instead, code 4401). For
   * `forMs` (default 10 minutes, at most 24 hours) a token for that identity issued before now is refused here, on
   * sockets and on HTTP calls, so a client cannot come back with the same unexpired JWT; a token whose `iat` is later
   * (a new sign-in) is not affected. `{ claim: "sid", value }` reaches one session; `{ subject }` every session of a
   * user. A claim the socket's attachment had to drop (over 16 KB) is not matched. Returns the sockets reached.
   */
  async revokeSockets(shard: string, match: RevokeMatch, opts: { forMs?: number; close?: boolean } = {}): Promise<{ sockets: number }> {
    this.setShardName(shard);
    const invalid = revokeMatchError(match);
    if (invalid) throw Object.assign(new Error(invalid), { code: "InvalidArgument" });
    // Not remembered: the caller must know the revocation did not happen (sockets here run nothing anyway).
    this.assertNotAhead();
    const now = Date.now();
    const forMs = Math.min(REVOKE_MAX_MS, Math.max(0, opts.forMs ?? REVOKE_MS));
    this.driver.exec("DELETE FROM _ember_revoked WHERE until <= ?", now);
    if (forMs > 0) {
      this.driver.exec(
        "INSERT INTO _ember_revoked(k, at, until) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET at = excluded.at, until = excluded.until",
        revokeKey(match), now, now + forMs,
      );
    } else {
      // Remember nothing: an earlier revocation of the same identity is forgotten too.
      this.driver.exec("DELETE FROM _ember_revoked WHERE k = ?", revokeKey(match));
    }
    this.revocations = null;
    let reached = 0;
    for (const ws of this.ctx.getWebSockets()) {
      const att = this.attachmentOf(ws) as Attachment | null;
      if (!att?.sid || !att.identity || !revokeMatches(match, att.identity)) continue;
      reached++;
      if (opts.close) {
        this.closeNow(ws, 4401, "ember: access revoked");
        this.dropSocket(att.sid);
        continue;
      }
      // Expired from now on: its patches stop and its frames are refused until a fresh token arrives (`auth`). A frame
      // still being compressed for it (feature "zframe") was produced before: dropped, never sent after this.
      if (this.zsending.has(ws)) this.zcut.set(ws, (this.zcut.get(ws) ?? 0) + 1);
      const { token: _drop, ...rest } = att;
      const expired: Attachment = { ...rest, identity: { ...att.identity, exp: 0 } };
      this.saveAttachment(ws, expired);
      this.expiredNotified.add(att.sid);
      this.send(ws, { t: "authExpired" });
    }
    return { sockets: reached };
  }

  /** Revocations still remembered (`revokeSockets`), cached until the next one. */
  private revocations: Array<{ match: RevokeMatch; at: number; until: number }> | null = null;

  /** Whether `identity` holds a token issued before a revocation that reaches it and is still remembered. */
  private isRevoked(identity: Identity | null): boolean {
    // Refused by RuntimeSchemaTooNew: `_ember_revoked` is not read, and nothing runs for any identity anyway (callers
    // refuse right after; `checkIdentity` refuses on its own).
    if (!identity || this.runtimeAhead) return false;
    if (!this.revocations) {
      this.revocations = this.driver
        .exec("SELECT k, at, until FROM _ember_revoked")
        .rows.map((r) => ({ match: revokeOf(r.k as string), at: r.at as number, until: r.until as number }))
        .filter((r): r is { match: RevokeMatch; at: number; until: number } => r.match !== null);
    }
    if (!this.revocations.length) return false;
    const now = Date.now();
    const issued = typeof identity.iat === "number" ? identity.iat : typeof identity.claims?.iat === "number" ? (identity.claims.iat as number) : null;
    const iat = issued === null ? null : issued * 1000;
    return this.revocations.some(
      (r) =>
        r.until > now &&
        revokeMatches(r.match, identity) &&
        // No `iat`: a session's own revocation (its `sid`) still refuses it, but a whole user's cannot, since a new
        // sign-in could not be told apart (opaque session tokens are checked against the session store anyway).
        (iat === null ? !("subject" in r.match) : iat <= r.at),
    );
  }

  /** For the Worker before it runs an action as `identity`: the refusal when this shard holds it as revoked. */
  async checkIdentity(shard: string, identity: Identity): Promise<{ code: string; message: string } | null> {
    this.setShardName(shard);
    // A refused shard runs nothing, and an action on it would run the new code against it: refused before it starts.
    // (RuntimeSchemaTooNew: `_ember_revoked` belongs to a newer runtime, so the revocation cannot be checked either.)
    if (this.refused) return { code: this.refused.code, message: this.refused.message };
    return this.checkRevoked(identity);
  }

  /** The refusal for a revoked identity on an RPC call (HTTP and actions pass identities the Worker verified). */
  private checkRevoked(identity: Identity | null): { code: string; message: string } | null {
    return this.isRevoked(identity) ? { code: "unauthenticated", message: "access revoked: sign in again" } : null;
  }

  /** `id`: the job id, or null when its dedup key / id is already taken. */
  async enqueueJob(shard: string, job: JobInput): Promise<{ id: string | null }> {
    this.setShardName(shard);
    if (this.refused) throw Object.assign(new Error(this.refused.message), { code: this.refused.code });
    const id = this.insertJob(job);
    this.armAlarm(undefined, true);
    return { id };
  }

  /**
   * Cancels a job by id that has not started: pending, or handed to the Queue and not claimed yet (the consumer's claim
   * then finds nothing and skips it). True when one was removed (a running or finished job is not affected).
   */
  async cancelJob(shard: string, id: string): Promise<boolean> {
    this.setShardName(shard);
    const ok = this.cancelRow(id);
    if (ok) this.armAlarm(undefined, true);
    return ok;
  }

  /** Migration / backfill state for `GET /api/_ember/status` (waking the shard runs its migration first). */
  async status(shard: string): Promise<ShardStatus> {
    this.setShardName(shard);
    const expectedVersion = this.cfg.schema.manifest.version;
    const schemaVersion = this.getMeta("schema_version");
    // Runtime tables of a newer runtime (`runtimeAhead`): neither `_ember_indexes` nor `_ember_migrations` is read.
    const hasIndexes = !this.runtimeAhead && this.driver.exec("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = '_ember_indexes'").rows.length > 0;
    const staged = hasIndexes
      ? this.driver.exec(`SELECT "tbl", "name", "kind", "cursor", "until" FROM "_ember_indexes" ORDER BY "tbl", "name"`).rows.map((r) => ({
          table: String(r.tbl),
          index: String(r.name),
          kind: String(r.kind),
          cursor: Number(r.cursor),
          until: Number(r.until),
        }))
      : [];
    const toInfo = (r: Record<string, unknown> | undefined): MigrationErrorInfo | null =>
      r
        ? {
            at: r.at as number,
            fromVersion: (r.from_version as string | null) ?? null,
            toVersion: r.to_version as string,
            code: (r.code as string) ?? "MigrationFailed",
            message: (r.message as string) ?? "",
          }
        : null;
    // Runtime tables of a newer runtime: nothing was recorded in `_ember_migrations` (nor is it read: its shape is theirs).
    const ahead = this.runtimeAhead;
    const last = ahead ? undefined : this.driver.exec("SELECT * FROM _ember_migrations WHERE to_version = ? ORDER BY id DESC LIMIT 1", expectedVersion).rows[0];
    const lastError = ahead ? undefined : this.driver.exec("SELECT * FROM _ember_migrations WHERE ok = 0 ORDER BY id DESC LIMIT 1").rows[0];
    return {
      shard,
      expectedVersion,
      schemaVersion,
      ready: !this.refused && schemaVersion === expectedVersion && staged.length === 0,
      staged,
      migrationError: ahead ?? (this.refused && last && last.ok === 0 ? toInfo(last) : null),
      lastMigrationError: ahead ?? toInfo(lastError),
      version: this.version,
      databaseSize: this.ctx.storage.sql.databaseSize,
    };
  }

  /** Read-only data browser (`GET /api/_ember/data`, admin only). `table: null` lists the tables. */
  async browse(shard: string, table: string | null, cursor: string | null, limit?: number, opts: { jobs?: "open" | "done" } = {}): Promise<BrowseResult> {
    this.setShardName(shard);
    // Runtime tables of a newer runtime, and app tables whose storage format this runtime never checked (the boot
    // stopped before `migrate()`): nothing is shown rather than something misread.
    if (this.runtimeAhead) return { ok: false, error: { code: this.runtimeAhead.code, message: this.runtimeAhead.message } };
    // A refused migration: the app tables hold the old schema (or a newer storage format, StorageFormatTooNew), and the
    // deployed manifest would decode them wrong. The table list (counts) and the internal tables are still served; any
    // other name is refused, in the deployed manifest or not (a table the new schema dropped is still on this shard).
    if (this.refused && table !== null && !(BROWSABLE_INTERNAL as readonly string[]).includes(table)) return { ok: false, error: { code: this.refused.code, message: this.refused.message } };
    return browse(this.driver, this.cfg.schema.manifest, table, cursor, limit, opts);
  }

  /** Introspection for tests and the dashboard. */
  async inspect(): Promise<ShardInspection> {
    // Before the reads below: the counters say what ran before this call.
    const sql = structuredClone(this.driver.counters);
    let subs = 0;
    for (const m of this.subs.values()) subs += m.size;
    // Refused by RuntimeSchemaTooNew: the counters of this instance only; the newer runtime's tables are not read.
    const ahead = this.runtimeAhead !== null;
    return {
      version: this.version,
      epoch: this.epoch,
      shard: this.shardName,
      stats: { ...this.stats, ...this.alarmStats, batchSizes: [...this.stats.batchSizes] },
      subs,
      queries: this.queries.size,
      shared: [...this.queries.values()].filter((e) => e.shared).length,
      gates: this.gates.size,
      dormant: this.dormant.size,
      // Jobs still to run, and failed ones (finished ones stay for `ctx.scheduler.get`: counted in `finishedJobs`).
      jobs: ahead ? [] : (this.driver.exec("SELECT id, job_id, run_at, fn, kind, state, attempts, max_attempts, last_error, dedup_key FROM _jobs WHERE state NOT IN ('success', 'canceled') ORDER BY run_at, id").rows as unknown as JobRow[]),
      finishedJobs: ahead ? 0 : Number(this.driver.exec("SELECT COUNT(*) AS n FROM _jobs WHERE state IN ('success', 'canceled')").rows[0]?.n ?? 0),
      bookmarks: ahead ? 0 : ((this.driver.exec("SELECT COUNT(*) AS n FROM _ember_bookmarks").rows[0]?.n as number) ?? 0),
      alarm: await this.ctx.storage.getAlarm(),
      backfilling: !ahead && this.getMeta("backfill") !== null,
      files: ahead ? { total: 0, ready: 0, pending: 0, deleting: 0, unreferenced: 0 } : this.files.stats(),
      outbox: ahead ? { pending: 0, inFlight: 0, parked: 0 } : outboxStats(this.driver),
      rows: { read: this.driver.rowsRead, written: this.driver.rowsWritten },
      sql,
      ephemeral: { ...this.eph.counts(), ...this.eph.stats },
    };
  }

  /** Live subscriptions, cached results and recent re-runs (the dashboard's reactivity screen; reactivity.ts). */
  async reactivity(shard: string): Promise<ReactivityReport> {
    this.setShardName(shard);
    return reactivityReport({
      shard: this.shardName,
      version: this.version,
      sockets: this.ctx.getWebSockets().length,
      queries: this.queries.values(),
      gates: this.gates.size,
      stats: { reruns: this.stats.reruns, debouncedReruns: this.stats.debouncedReruns, identityRuns: this.stats.identityRuns, splits: this.stats.splits, gateRuns: this.stats.gateRuns, batches: this.stats.batches },
      log: this.rx,
      stringify,
    });
  }

  /** One profiled run of a cached entry (rows read, returned, the `ember dev` advice); touches no entry. Null: gone. */
  async profileQuery(shard: string, key: string): Promise<ProfileResult | null> {
    this.setShardName(shard);
    const entry = this.queries.get(key);
    if (!entry) return null;
    const profile = newQueryProfile();
    const track = { read: false };
    const read0 = this.driver.rowsRead;
    const phase = this.hasAuthorize(entry.fn) ? { phase: "handler" as const } : {};
    try {
      const r = this.engine.runQuery(entry.fn, entry.args, entry.ctx, { touched: new Set(), identity: track, ...phase, profile });
      const perf = { read: this.driver.rowsRead - read0, returned: returnedOf(r.value), profile };
      return { fn: entry.fn, ...perf, identityRead: track.read, advice: queryAdvice(perf, track.read, r.usage), error: null };
    } catch (e) {
      const err = errInfo(e, "Error");
      return { fn: entry.fn, read: this.driver.rowsRead - read0, returned: 0, profile, identityRead: track.read, advice: [], error: `${err.code}: ${err.message}` };
    }
  }

  // ------------------------------------------------------------------ point-in-time recovery (restore.ts)

  /** Recorded bookmarks, oldest first (`ember restore --list`). */
  async bookmarks(shard: string): Promise<BookmarkRow[]> {
    this.setShardName(shard);
    // Served on a shard refused by RuntimeSchemaTooNew too (a read, harmless), as long as the newer runtime kept these
    // four columns. Restoring from them is refused on such a shard (`restorePrepare`).
    let rows: Record<string, unknown>[];
    try {
      // Oldest first by time: after a restore, a row kept under a new id (`restoreFinish`) is older than its id says.
      rows = this.driver.exec("SELECT id, at, bookmark, reason FROM _ember_bookmarks ORDER BY at, id").rows;
    } catch (e) {
      const a = this.runtimeAhead;
      if (!a) throw e;
      throw new EmberError(a.code, `${a.message} The bookmarks cannot be read by this runtime either (${errInfo(e, "Error").message}).`);
    }
    return rows.map((r) => ({
      id: Number(r.id),
      at: Number(r.at),
      bookmark: String(r.bookmark),
      reason: String(r.reason),
    }));
  }

  /** Records a bookmark now (null: no PITR in this runtime). */
  async bookmarkNow(shard: string, reason: string): Promise<BookmarkRow | null> {
    this.setShardName(shard);
    // Before `recordBookmark`, whose failures mean "no PITR here": this one is RuntimeSchemaTooNew (409).
    this.assertNotAheadForRestore("bookmark");
    return this.recordBookmark(reason);
  }

  /**
   * Schedules the restore of `bookmark` for the next session (restore.ts has the state machine). Before scheduling
   * it writes a `restore_pending` marker (a fresh nonce: newer than any bookmark it can be asked to restore, so its
   * absence after a restart proves the restore applied) and journals the restore in the System DO (which completes
   * it if the caller dies). Returns the platform's undo bookmark, a copy of the bookmark rows (the restored database
   * has only the older ones), the nonce and this instance's id. The caller then aborts the object (`restoreAbort`)
   * and calls `restoreFinish` on the restarted one.
   */
  async restorePrepare(shard: string, bookmark: string, label: string, opts: { discardNewer?: boolean } = {}): Promise<RestorePrepared> {
    this.setShardName(shard);
    if (this.restoring) throw new Error(`restore_in_progress: a restore of ${shard} is already scheduled; it applies when the object restarts`);
    if (this.runtimeAhead) {
      // Refused by RuntimeSchemaTooNew: without `discardNewer`, refused up front (nothing written, no journal entry).
      if (opts.discardNewer !== true) this.assertNotAheadForRestore("restore");
      return this.restorePrepareAhead(shard, bookmark, label);
    }
    await this.recordBookmark(`pre-restore:${label}`);
    const rows = await this.bookmarks(shard);
    const nonce = crypto.randomUUID();
    this.setMeta("restore_pending", nonce);
    const journal = systemStub(this.env);
    let undo: string;
    try {
      await journal?.restoreBegin({ shard, nonce, label, bookmark, rows, instance: this.instance });
      undo = await this.ctx.storage.onNextSessionRestoreBookmark(bookmark);
    } catch (e) {
      // Nothing is scheduled: no marker and no journal entry. The `failed` outcome (not just a deleted marker, whose
      // absence means "applied") keeps a late finish of this nonce — the journal settle below is best effort — from
      // reporting a restore.
      this.driver.transaction(() => {
        this.deleteMeta("restore_pending");
        this.setRestoreOutcome(nonce, { stage: "failed", at: Date.now() });
      });
      await journal?.restoreSettle(nonce).catch(() => undefined);
      throw e;
    }
    this.restoring = nonce;
    // Best effort: without it a restore the System DO has to complete records no `undo:` row (the caller has it).
    await journal?.restoreScheduled(nonce, undo).catch(() => undefined);
    // The restored database may predate a migration: the next boot must verify the schema again.
    verifiedInIsolate.delete(this.ctx.id.toString());
    return { undo, rows, nonce, instance: this.instance };
  }

  /**
   * `restorePrepare` on a shard refused by RuntimeSchemaTooNew, with `discardNewer` (restore.ts has the reasoning).
   * Nothing is read from the newer runtime's tables but the bookmark rows (to re-import them, when their columns are
   * still the four this runtime knows), and nothing is written into them: no `pre-restore` row (the undo bookmark is
   * that state), and the marker goes to key-value storage (`AHEAD_MARKER_KEY`), outside the driver's read-only lock.
   */
  private async restorePrepareAhead(shard: string, bookmark: string, label: string): Promise<RestorePrepared> {
    let rows: BookmarkRow[] = [];
    try {
      rows = await this.bookmarks(shard);
    } catch (e) {
      // Columns of the newer runtime: the restored database keeps the rows it has; none are re-imported. Any other
      // read failure stops here, before anything is scheduled.
      if (!/no such (column|table)/i.test((e as Error).message)) throw e;
    }
    const nonce = crypto.randomUUID();
    const marker = (stage: AheadMarker["stage"]): AheadMarker => ({ nonce, stage });
    await this.ctx.storage.put(AHEAD_MARKER_KEY, marker("pending"));
    const journal = systemStub(this.env);
    let undo: string;
    try {
      await journal?.restoreBegin({ shard, nonce, label, bookmark, rows, instance: this.instance });
      undo = await this.ctx.storage.onNextSessionRestoreBookmark(bookmark);
    } catch (e) {
      // Nothing is scheduled. `failed` (not a deleted marker, whose absence would read as "applied") keeps a late
      // finish of this nonce from reporting a restore.
      await this.ctx.storage.put(AHEAD_MARKER_KEY, marker("failed"));
      await journal?.restoreSettle(nonce).catch(() => undefined);
      throw e;
    }
    this.restoring = nonce;
    await journal?.restoreScheduled(nonce, undo).catch(() => undefined);
    verifiedInIsolate.delete(this.ctx.id.toString());
    console.warn(`ember: restore of ${shard} to ${bookmark} scheduled from a refused shard (RuntimeSchemaTooNew, discardNewer): what the newer runtime wrote after it is discarded; undo ${undo}`);
    return { undo, rows, nonce, instance: this.instance };
  }

  /** The `AHEAD_MARKER_KEY` value (null: none, or not one this runtime wrote). */
  private async aheadMarker(): Promise<AheadMarker | null> {
    const v = await this.ctx.storage.get(AHEAD_MARKER_KEY);
    return isAheadMarker(v) ? v : null;
  }

  /** Restarts the object so the scheduled restore applies (the call fails by design). */
  async restoreAbort(): Promise<void> {
    verifiedInIsolate.delete(this.ctx.id.toString());
    this.ctx.abort("ember restore");
  }

  /** Outcome of restore `nonce` on this shard (meta `restore:<nonce>`; null: none recorded). */
  private restoreOutcome(nonce: string): RestoreOutcome | null {
    const v = this.getMeta(`restore:${nonce}`);
    return v === null ? null : (parse(v) as RestoreOutcome);
  }

  private setRestoreOutcome(nonce: string, o: RestoreOutcome): void {
    this.setMeta(`restore:${nonce}`, stringify(o));
  }

  /**
   * Completes restore `info.nonce` on the restarted object (boot already ran: migration to the current schema if
   * the bookmark predates it). Each nonce has an outcome in meta `restore:<nonce>`, written only after the restart:
   *   - `failed`: the restore never applied (restarted without it, or scheduling failed) → `restore_not_scheduled`,
   *     however many times finish is called;
   *   - `applied`: the transactional part ran (re-imported rows, `undo:` row, new epoch); the rest may not have;
   *   - `done`: everything ran → the same answer again.
   * Without an outcome, the `restore_pending` marker of this nonce still here means the object did not restart yet
   * (`restore_not_applied`: abort again) or restarted without the restore (→ `failed`). Marker and outcome both
   * absent: the database predates the marker, so the restore applied. Completion then runs in two transactions with
   * idempotent work in between, so a retry (CLI or System alarm) after a crash anywhere redoes what is missing:
   *   1. re-import the bookmark rows the restore rolled back, `undo:` row, new epoch (clients holding a newer
   *      version resubscribe with full snapshots instead of `resume`), outcome `applied`;
   *   2. close (1012) every socket (any of them may have resumed against the old epoch; closing again is harmless),
   *      re-arm the alarm and kick the outbox (jobs, GC and outbox rows came back with the data);
   *   3. `restore:` bookmark row and outcome `done`, together.
   */
  async restoreFinish(shard: string, info: RestoreFinishInfo): Promise<{ version: number; epoch: string; schemaVersion: string | null }> {
    this.setShardName(shard);
    const kv = await this.aheadMarker();
    const notScheduled = () => new Error("restore_not_scheduled: the shard restarted without applying the restore; nothing was restored");
    if (this.runtimeAhead) {
      // Still ahead after the restart. Only the key-value marker of a restore prepared on the refused shard can be
      // read here (`aheadFinishDecision`); nothing is written into the newer runtime's tables in any case.
      const d = aheadFinishDecision(kv, info, this.instance);
      if (d === "not_scheduled") throw notScheduled();
      if (d === "not_applied") throw new Error("restore_not_applied: the shard has not restarted since the restore was scheduled");
      if (d === "failed") {
        await this.ctx.storage.put(AHEAD_MARKER_KEY, { nonce: info.nonce, stage: "failed" } satisfies AheadMarker);
        throw notScheduled();
      }
      // `still_ahead`: the restore applied a bookmark taken under a newer runtime (or was scheduled while the shard was
      // compatible and a newer runtime ran here since). Only a runtime that understands these tables can finish it:
      // nothing is written, and the System journal keeps the entry (with the undo bookmark) and retries with its
      // backoff until one does.
      throw new EmberError(
        this.runtimeAhead.code,
        `restore_still_ahead: ${shard} restarted on runtime tables newer than this runtime understands (the restore of ${info.bookmark} ` +
          `applied a bookmark taken under a newer runtime, or a newer runtime ran on the shard since). Nothing was written; the restore stays ` +
          `pending in the System journal and completes when the newer runtime is deployed again` +
          `${info.undo ? ` (undo bookmark ${info.undo}: the state before this restore)` : ""}.`,
        (this.refused as { data?: unknown } | null)?.data,
      );
    }
    const state = () => ({ version: this.version, epoch: this.epoch, schemaVersion: this.getMeta("schema_version") });
    // The restored database brings its own `_ember_sub_ident` rows: probed again.
    this.subIdent = undefined;
    // A restore prepared on the refused shard whose scheduling failed: nothing applied (this shard is compatible again
    // for another reason, e.g. a later restore). Any other key-value marker here is spent: the shard is no longer ahead,
    // which only a restore can do, so the restore applied (whether or not the platform rolled the marker back with it).
    const outcome = this.restoreOutcome(info.nonce);
    // A restore already recorded as done stays done, whatever marker is around.
    if (outcome?.stage === "done") return state();
    if (kv?.nonce === info.nonce && kv.stage === "failed") throw notScheduled();
    if (kv) await this.ctx.storage.delete(AHEAD_MARKER_KEY);
    if (outcome?.stage === "failed") throw notScheduled();
    if (!outcome) {
      if (this.getMeta("restore_pending") === info.nonce) {
        if (info.instance === this.instance) throw new Error("restore_not_applied: the shard has not restarted since the restore was scheduled");
        this.driver.transaction(() => {
          this.deleteMeta("restore_pending");
          this.setRestoreOutcome(info.nonce, { stage: "failed", at: Date.now() });
        });
        throw notScheduled();
      }
      const at = Date.now();
      const epoch = crypto.randomUUID();
      this.driver.transaction(() => {
        // A marker of another restore can come back with the data (restoring an undo bookmark): it is stale, unless
        // this instance scheduled it.
        const pending = this.getMeta("restore_pending");
        if (pending !== null && pending !== this.restoring) this.deleteMeta("restore_pending");
        for (const r of info.rows) {
          // The restored database has the rows up to its bookmark, and the boot after the restore may have recorded
          // one of its own (`deploy:<v>`) under the id a later row had. A row is already there only when its bookmark
          // and reason are; one whose id went to another row is kept under a new id, not dropped.
          if (this.driver.exec("SELECT 1 AS x FROM _ember_bookmarks WHERE bookmark = ? AND reason = ? LIMIT 1", r.bookmark, r.reason).rows.length) continue;
          if (this.driver.exec("SELECT 1 AS x FROM _ember_bookmarks WHERE id = ?", r.id).rows.length) {
            this.driver.exec("INSERT INTO _ember_bookmarks(at, bookmark, reason) VALUES (?, ?, ?)", r.at, r.bookmark, r.reason);
            // Its id no longer follows its time: the maintenance expires bookmarks by time for a while.
            this.setMeta("bookmarks_unordered", "1");
          } else this.driver.exec("INSERT INTO _ember_bookmarks(id, at, bookmark, reason) VALUES (?, ?, ?, ?)", r.id, r.at, r.bookmark, r.reason);
        }
        if (info.undo) this.driver.exec("INSERT INTO _ember_bookmarks(at, bookmark, reason) VALUES (?, ?, ?)", at, info.undo, `undo:${info.label}`);
        this.setMeta("epoch", epoch);
        this.setRestoreOutcome(info.nonce, { stage: "applied", at, bookmark: info.bookmark, undo: info.undo, label: info.label });
      });
      this.epoch = epoch;
    }
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (att?.sid) this.dropSocket(att.sid);
      this.closeNow(ws, 1012, "ember restore");
    }
    // `.replicated()` tables: a restored global:main resends everything (its log went back in time); a restored target
    // asks for a fresh copy (its marks went back).
    if (this.replicated.size) {
      if (this.isReplicatedSource) resyncAllTargets(this.driver, this.cfg.schema.manifest);
      else if (this.shardName && kindReceivesReplicated(this.cfg.schema.manifest, shardKindOf(this.shardName))) this.ctx.waitUntil(this.registerInCatalog(true));
    }
    this.lastArmed = undefined;
    this.resetAlarmCache();
    this.armAlarm();
    this.kickOutbox();
    let bookmark: string | null = null;
    try {
      bookmark = await this.ctx.storage.getCurrentBookmark();
    } catch {
      // Bookmarks are best effort (as in recordBookmark).
    }
    this.driver.transaction(() => {
      // A concurrent finish of the same nonce (Worker and System alarm) may have completed during the await.
      const cur = this.restoreOutcome(info.nonce);
      if (!cur || cur.stage !== "applied") return;
      if (bookmark) this.driver.exec("INSERT INTO _ember_bookmarks(at, bookmark, reason) VALUES (?, ?, ?)", Date.now(), bookmark, `restore:${info.label}`);
      this.setRestoreOutcome(info.nonce, { ...cur, stage: "done" });
    });
    return state();
  }

  // ------------------------------------------------------------------ import (admin: `ember import`, contracts "Importar do Convex")

  /** Runs an import step; a failure comes back as `{ ok: false }` (`ImportConflict`, `ValidationError`, ...). */
  private importOp<T>(shard: string, write: boolean, fn: () => T): FileResult<T> {
    this.setShardName(shard);
    if (this.refused) return { ok: false, code: this.refused.code, message: this.refused.message };
    try {
      const value = fn();
      if (write) this.resetForImport();
      return { ok: true, value };
    } catch (e) {
      const { code, message } = errorInfo(e);
      return { ok: false, code, message };
    }
  }

  /**
   * Imported rows bypass the commit pipeline (no change log, no patches): every subscriber starts over. A new epoch
   * (no client resumes from a version taken before), every socket closed with 1012 (clients reconnect and receive
   * snapshots, as after a restore), and nested results dropped.
   */
  private resetForImport(): void {
    this.subIdent = undefined;
    this.parsedChanges.clear();
    this.parsedSize = 0;
    const epoch = crypto.randomUUID();
    this.setMeta("epoch", epoch);
    this.epoch = epoch;
    this.memoGen++;
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (att?.sid) this.dropSocket(att.sid);
      this.closeNow(ws, 1012, "ember import");
    }
  }

  async importBegin(shard: string, o: { foreignIds?: ForeignIds; tables: string[] }): Promise<FileResult<{ converted: string[] }>> {
    return this.importOp(shard, true, () => this.engine.importer.begin(o));
  }

  async importBatch(shard: string, o: { table: string; docs?: unknown[]; deletes?: string[]; strict?: boolean }): Promise<FileResult<ImportBatchResult & { deleted: number }>> {
    return this.importOp(shard, true, () => {
      const r = o.docs?.length ? this.engine.importer.documents(o.table, o.docs, o.strict ? { strict: true } : {}) : { written: 0, invalid: [] };
      const d = o.deletes?.length ? this.engine.importer.delete(o.table, o.deletes) : { deleted: 0 };
      return { ...r, deleted: d.deleted };
    });
  }

  async importFiles(shard: string, rows: ImportFileRow[]): Promise<FileResult<{ written: number }>> {
    return this.importOp(shard, true, () => this.engine.importer.files(rows));
  }

  /** Derived state after the batches; staged indexes are filled by the alarm's backfill. */
  async importFinish(shard: string): Promise<FileResult<ImportFinishResult>> {
    const r = this.importOp(shard, true, () => this.engine.importer.finish());
    if (r.ok && r.value.staged.length) this.setMeta("backfill", "1");
    this.lastArmed = undefined;
    this.resetAlarmCache();
    this.armAlarm();
    this.kickOutbox();
    return r;
  }

  async importHash(shard: string, table: string, after: number, limit: number): Promise<FileResult<ImportHashPage>> {
    return this.importOp(shard, false, () => this.engine.importer.hash(table, after, limit));
  }

  async importMeta(shard: string): Promise<FileResult<ImportMeta>> {
    return this.importOp(shard, false, () => this.engine.importer.describe());
  }

  async importExport(shard: string, table: string, after: number, limit: number): Promise<FileResult<ImportExportPage>> {
    return this.importOp(shard, false, () => this.engine.importer.page(table, after, limit));
  }

  /**
   * `POST /api/_ember/preflight` (`ember deploy --preflight`): what `migrate()` would do with `schema` here, with this
   * runtime's planner and index kinds, in a transaction that is always rolled back. Not `setShardName`: nothing is
   * written (the name only decides how `.replicated()` tables plan).
   */
  async preflight(shard: string, schema: unknown): Promise<ShardPreflight> {
    const a = this.runtimeAhead;
    // Refused by RuntimeSchemaTooNew: no plan is made (the planner reads the engine's tables in a format nobody checked).
    if (a) return { shard, schemaVersion: a.fromVersion, refused: this.refused, result: { status: "unchecked", code: "RuntimeSchemaTooNew", message: a.message } };
    // The same format choice as the engine's `migrate()`, so the plan shows the tables it would create.
    const result = preflightMigration(this.driver, schema, this.cfg.schema.indexKinds, { compact: true, shard: this.shardName ?? shard, ...this.compactFormatOpt() });
    return { shard, schemaVersion: this.getMeta("schema_version"), refused: this.refused, result };
  }

  /**
   * `POST /api/_ember/sql` (the dashboard's SQL Explorer, admin-sql.ts): one read-only query on this shard's SQLite, in
   * a transaction that is always aborted. Also on a refused shard (it reads the tables as they are, nothing decodes
   * them). Its rows read count in the shard's metrics like any other statement's.
   */
  async sqlQuery(shard: string, input: SqlQueryInput): Promise<SqlQueryOutcome> {
    this.setShardName(shard);
    const r = runReadOnlySql(this.ctx.storage, input);
    if (r.ok) {
      this.driver.rowsRead += r.value.rowsRead;
      this.driver.counters.select[0]++;
      this.driver.counters.select[1] += r.value.rowsRead;
    }
    return r;
  }

  // ------------------------------------------------------------------ files (RPC from the Worker / actions)

  /**
   * `orphans`: the orphan sweep's bookkeeping (`_files` only, no app function), which also runs on a shard whose
   * migration was refused (`_files` is a runtime table, valid there), so the object of a store it refused can go.
   * Never with RuntimeSchemaTooNew (`_files` is the newer runtime's).
   */
  private fileOp<T>(shard: string, fn: () => T, orphans = false, readOnly = false): FileResult<T> {
    this.setShardName(shard);
    const refused = orphans ? this.runtimeAhead : this.refused;
    if (refused) return { ok: false, code: refused.code, message: refused.message };
    try {
      // A single read needs no transaction.
      return { ok: true, value: readOnly ? fn() : this.driver.transaction(fn) };
    } catch (e) {
      const { code, message } = errorInfo(e);
      return { ok: false, code, message };
    }
  }

  async fileUploadTarget(shard: string, id: string, token: string | null): Promise<FileResult<FileRow>> {
    return this.fileOp(shard, () => this.files.uploadTarget(id, token), false, true);
  }

  async fileReady(shard: string, id: string, info: { size: number; etag: string | null; sha256?: string; key?: string }): Promise<FileResult<FileRow>> {
    const r = this.fileOp(shard, () => this.files.markReady(id, info, Date.now()));
    if (r.ok) this.armAlarm();
    return r;
  }

  async fileFail(shard: string, id: string): Promise<void> {
    this.fileOp(shard, () => this.files.markFailed(id, Date.now()));
    this.armAlarm();
  }

  async filesByKey(shard: string, key: string): Promise<FileRow[]> {
    const r = this.fileOp(shard, () => this.files.byKey(key), false, true);
    return r.ok ? r.value : [];
  }

  async fileMeta(shard: string, id: string): Promise<FileRow | null> {
    const r = this.fileOp(shard, () => this.files.get(id), false, true);
    // A refused shard (or a failing read) is not "no such file": the caller gets the error, as from `fileUrl`.
    if (!r.ok) throw Object.assign(new Error(r.message), { code: r.code });
    return r.value;
  }

  async fileUrl(shard: string, id: string, opts: GetUrlOptions): Promise<string | null> {
    const r = this.fileOp(shard, () => this.files.getUrl(id, opts, Date.now()), false, true);
    if (!r.ok) throw Object.assign(new Error(r.message), { code: r.code });
    return r.value;
  }

  async fileRegister(shard: string, info: { sha256: string; size: number; contentType: string | null; etag: string | null }): Promise<FileResult<string>> {
    const r = this.fileOp(shard, () => this.files.register(info, Date.now()).id);
    this.armAlarm();
    return r;
  }

  async fileGenerateUpload(shard: string, opts: UploadOptions): Promise<FileResult<UploadTicket>> {
    const r = this.fileOp(shard, () => this.files.generateUploadUrl(opts, Date.now()));
    this.armAlarm();
    return r;
  }

  /**
   * The orphan sweep (`POST /api/_ember/files/orphans`, `ember files orphans`) and the cleanup of a failed
   * `ctx.storage.store`: which of `keys` (this shard's object keys) no `_files` row references. `claim`: a tombstone
   * per orphan, in the same transaction (`FileStore.orphans`); the caller deletes the objects and calls
   * `fileOrphansDone`. At most 1000 keys.
   */
  async fileOrphans(shard: string, keys: string[], claim: boolean): Promise<FileResult<Array<{ key: string; id: string | null }>>> {
    if (!Array.isArray(keys) || keys.length > 1000) return { ok: false, code: "ValidationError", message: "fileOrphans: keys must be an array of at most 1000 keys" };
    const r = this.fileOp(shard, () => this.files.orphans(keys, claim, Date.now()), true);
    // A tombstone the caller never drops is collected by the GC turn (a stale `deleting` row): keep the alarm for it.
    if (r.ok && r.value.some((o) => o.id !== null)) this.armAlarm();
    return r;
  }

  /** The objects of these tombstones (`fileOrphans` with `claim`) are deleted: the rows go. */
  async fileOrphansDone(shard: string, ids: string[]): Promise<FileResult<null>> {
    if (!Array.isArray(ids) || ids.length > 1000) return { ok: false, code: "ValidationError", message: "fileOrphansDone: ids must be an array of at most 1000 ids" };
    return this.fileOp(shard, () => {
      this.files.releaseOrphans(ids.filter((id) => typeof id === "string"), Date.now());
      return null;
    }, true);
  }

  async fileDelete(shard: string, id: string): Promise<FileResult<null>> {
    const r = this.fileOp(shard, () => {
      this.files.delete(id, Date.now());
      return null;
    });
    this.armAlarm();
    return r;
  }
}
