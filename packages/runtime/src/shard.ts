import { DurableObject } from "cloudflare:workers";
import { rowDiff, type RowDiff } from "@freecorps/ember-values";
import {
  createMatchIndex,
  errorInfo,
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
  type FileStoreOptions,
  type GetUrlOptions,
  type IndexSpec,
  type MatchIndex,
  type MetadataValue,
  type OutboxStats,
  type UploadOptions,
  type UploadTicket,
} from "@freecorps/ember-server";
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
import { ActionRunner, actionDispatch, type ShardApi } from "./actions.ts";
import {
  ANON,
  DEFAULT_CREATE_ENGINE,
  getEmberConfig,
  identityKey,
  indexEnv,
  type ActionJobMessage,
  type EmberConfig,
  type EmberEnv,
} from "./config.ts";
import type { AuthCtx, Engine, Identity, Job, MutationBatchItem, ReadSet, RowChange } from "./engine-types.ts";
import {
  decodeClientMessage,
  encodeServerMessage,
  ProtocolError,
  type ClientMessage,
  type Id,
  type PatchChange,
  type ServerMessage,
} from "./protocol.ts";
import { bucketOf, fileSignerFromEnv, type FileResult, type FileRpc } from "./files.ts";
import { DoSqlDriver } from "./sql-driver.ts";
import { shardStub, systemStub } from "./stubs.ts";
import { browse, type BrowseResult } from "./admin.ts";
import { catalogDue, metricsEnabled, recordExecution, reportShard, share, type CallMetrics, type ExecutionKind, type Timing } from "./metrics.ts";
import { parse, stableStringify, stringify } from "./wire.ts";
import type { BookmarkRow, RestoreFinishInfo, RestoreOutcome, RestorePrepared, RestoreRpc } from "./restore.ts";

/** Id of the running Worker version (`version_metadata` binding EMBER_VERSION, set by `ember deploy`). */
function deployVersionId(env: EmberEnv): string | null {
  const v = env.EMBER_VERSION as { id?: unknown } | undefined;
  return v && typeof v.id === "string" && v.id ? v.id : null;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const DEDUP_RETENTION_MS = 7 * DAY;
export const MAX_ALARM_AHEAD_MS = 30 * DAY;
const BOOKMARK_RETENTION_MS = 30 * DAY;
const MAX_JOBS_PER_ALARM = 500;
/** Default lease of an action job handed to the Queue (`scheduler.actionLeaseMs`). */
const ACTION_LEASE_MS = 5 * 60_000;
/** The shortest lease (`action({ leaseMs })` is checked against the same floor). */
const MIN_ACTION_LEASE_MS = 1000;
/** Job states the alarm picks up when due: waiting to run, or handed to the Queue / claimed past their lease. */
const DUE_STATES = "('pending', 'dispatched', 'claimed')";
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
const RUNTIME_SCHEMA = 3;

/**
 * `dedup_key` is unique through a partial index (`_jobs_dedup`, NOT NULL keys only): most jobs have no key, and a
 * plain UNIQUE column would write an index entry for their NULL too (one billed row per job).
 */
const JOBS_COLUMNS = `
  id INTEGER PRIMARY KEY, run_at INTEGER NOT NULL, fn TEXT NOT NULL, args TEXT NOT NULL,
  kind TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL, last_error TEXT, dedup_key TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, job_id TEXT`;
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

const RUNTIME_DDL = `
CREATE TABLE IF NOT EXISTS _ember_rt_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS _ember_subs (
  sock TEXT NOT NULL, qid TEXT NOT NULL, fn TEXT NOT NULL, args TEXT NOT NULL,
  PRIMARY KEY (sock, qid)
) STRICT, WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS _ember_changes (
  slot INTEGER PRIMARY KEY, version INTEGER NOT NULL, at INTEGER NOT NULL, changes TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS _jobs (${JOBS_COLUMNS}) STRICT;
CREATE INDEX IF NOT EXISTS _jobs_due ON _jobs(state, run_at);
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
  sql.exec("CREATE UNIQUE INDEX IF NOT EXISTS _jobs_job_id ON _jobs(job_id)");
  sql.exec("CREATE UNIQUE INDEX IF NOT EXISTS _jobs_dedup ON _jobs(dedup_key) WHERE dedup_key IS NOT NULL");
}

/** Per-isolate cache: DO id -> schema version already verified in this isolate. */
const verifiedInIsolate = new Map<string, string>();

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
}

export type MutationOutcome = (
  | { ok: true; value: unknown; version: number }
  | { ok: false; error: { code: string; message: string } }
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
    /** `_files` rows removed by GC (since boot). */
    filesCollected: number;
    /** External-index outbox messages delivered (sent to the queue, or indexed in-process). */
    outboxSent: number;
    /** In-process deliveries that failed (retried later). */
    outboxFailed: number;
  };
  /** External-index outbox (Vectorize / AI Search). */
  outbox: OutboxStats;
  files: { total: number; ready: number; pending: number; deleting: number; unreferenced: number };
  /** Staged indexes are still being backfilled by the alarm. */
  backfilling: boolean;
  subs: number;
  queries: number;
  jobs: JobRow[];
  bookmarks: number;
  alarm: number | null;
  /** SQLite rows read / written by this object instance since it started (`cursor.rowsRead/rowsWritten`, billed). */
  rows: { read: number; written: number };
}

interface QueryEntry {
  key: string;
  fn: string;
  args: unknown;
  ctx: AuthCtx;
  json: string;
  value: unknown;
  /** null = the last run failed: matched only by the tables it (or any run of `fn`) touched. */
  readSet: ReadSet | null;
  error: { code: string; message: string } | null;
  /** `${sid}\n${qidKey}` */
  subs: Set<string>;
}

interface Sub {
  sid: string;
  qid: Id;
  key: string;
}

interface Pending {
  fn: string;
  args: unknown;
  ctx: AuthCtx;
  /** `okOnly`: remember only successful outcomes (a failed outbox delivery must be retried, not replayed). */
  dedup?: { identity: string; clientId: string; mid: string; okOnly?: boolean };
  /** WS origin: its mid is listed in the `patch` of the version that includes it. */
  origin?: { sid: string; mid: Id };
  /** When it was received (Date.now() at the start of that event: the clock moves between events). */
  at: number;
  /** The caller records the metrics point (see MutationCallOptions.caller). */
  caller?: boolean;
  resolve: (o: MutationOutcome) => void;
}

const qidKey = (qid: Id) => JSON.stringify(qid);

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

function errInfo(e: unknown, fallback: string): { code: string; message: string } {
  const code = typeof (e as { code?: unknown })?.code === "string" ? (e as { code: string }).code : fallback;
  const message = e instanceof Error ? e.message : String(e);
  return { code, message };
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
   * sid -> qids stored as `_ember_subs` rows (did not fit in the attachment, or left by an older runtime). Each qid
   * lives in exactly one store, the attachment or the table: moving it deletes it from the other.
   */
  private readonly tableSubs = new Map<string, Set<string>>();
  /** Sockets already told `authExpired` for their current (expired) identity. */
  private readonly expiredNotified = new Set<string>();
  /** The latest migration attempt was refused: everything fails with this error until a fixed deploy. */
  private refused: { code: string; message: string } | null = null;
  /** This object instance (a restart makes a new one): tells `restoreFinish` whether the object restarted. */
  private readonly instance = crypto.randomUUID();
  /** Nonce of the restore scheduled by this instance (it applies when the object restarts). */
  private restoring: string | null = null;

  private pending: Pending[] = [];
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  private lastArmed: number | null | undefined = undefined;
  /** Last commit with changes (shard catalog `lastWrite`; persisted at report time). */
  private lastWrite: number | null = null;
  private readonly stats = { batches: 0, batchSizes: [] as number[], booted: 0, migrated: 0, rebuiltSubs: 0, backfillSteps: 0, reruns: 0, debouncedReruns: 0, filesCollected: 0, outboxSent: 0, outboxFailed: 0 };
  /** The schema has external indexes (Vectorize / AI Search): commits feed the outbox. */
  private readonly hasExternal: boolean;
  private flushing: Promise<void> | null = null;
  private flushAgain = false;

  constructor(ctx: DurableObjectState, env: EmberEnv) {
    super(ctx, env);
    this.cfg = getEmberConfig();
    this.driver = new DoSqlDriver(ctx.storage);
    this.hasExternal = externalIndexes(this.cfg.schema.manifest, this.cfg.schema.indexKinds).length > 0;
    this.storageOpts = {
      shard: () => this.shardName,
      signer: fileSignerFromEnv(env),
      // EMBER_FILES_GC_GRACE_MS (a Worker var) overrides the 24 h grace, e.g. for short-lived test environments.
      ...(this.cfg.files?.gcGraceMs !== undefined
        ? { gcGraceMs: this.cfg.files.gcGraceMs }
        : Number(env.EMBER_FILES_GC_GRACE_MS) >= 0 && env.EMBER_FILES_GC_GRACE_MS !== undefined
          ? { gcGraceMs: Number(env.EMBER_FILES_GC_GRACE_MS) }
          : {}),
      ...(this.cfg.files?.urlTtlSeconds !== undefined ? { urlTtlSeconds: this.cfg.files.urlTtlSeconds } : {}),
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
    if (!cached) {
      this.ctx.storage.sql.exec(RUNTIME_DDL);
      for (const sql of FILES_DDL) this.ctx.storage.sql.exec(sql);
      const rt = Number(this.getMeta("rt_schema") ?? "0");
      if (rt < RUNTIME_SCHEMA) {
        this.ctx.storage.transactionSync(() => {
          upgradeRuntimeTables(this.ctx.storage.sql, rt, ringSize(this.cfg));
          this.setMeta("rt_schema", String(RUNTIME_SCHEMA));
        });
      }
      // `changeLogVersions` shrank since the ring was written: slots past the end would never be overwritten.
      this.ctx.storage.sql.exec("DELETE FROM _ember_changes WHERE slot >= ?", ringSize(this.cfg));
    }

    this.engine = create({
      schema: this.cfg.schema,
      functions: this.cfg.functions,
      driver: this.driver,
      now: () => Date.now(),
      random: Math.random,
      storage: this.storageOpts,
    });
    this.index = createMatchIndex<string>(this.cfg.schema);
    this.refused = null;

    // PITR (restore.ts): the first boot under a new Worker version records the state the previous code left behind,
    // before the migration and before any request of the new code runs. A brand-new shard records it too (its
    // state "before" is empty): `--to deploy:<v>` must roll back what it wrote under v. If the bookmark cannot be
    // taken, a `deploy-missed:<v>` row (no bookmark) says so, and deploy targets refuse this shard instead of
    // silently resolving past the writes made under v.
    const deployId = deployVersionId(this.env);
    if (deployId && this.getMeta("deploy_version") !== deployId) {
      if (!(await this.recordBookmark(`deploy:${deployId}`))) {
        this.driver.exec("INSERT INTO _ember_bookmarks(at, bookmark, reason) VALUES (?, '', ?)", Date.now(), `deploy-missed:${deployId}`);
      }
      this.setMeta("deploy_version", deployId);
    }

    let migrated = false;
    if (!cached) {
      const from = this.getMeta("schema_version");
      if (from !== schemaVersion) {
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
    let epoch = this.getMeta("epoch");
    if (!epoch) {
      epoch = crypto.randomUUID();
      this.setMeta("epoch", epoch);
    }
    this.epoch = epoch;
    this.shardName = this.getMeta("shard");

    if (migrated) await this.recordBookmark("migrate");
    if (migrated) this.ctx.waitUntil(this.reportCatalog(true));
    this.rebuildRegistry();
    // After a migration (possibly fixing an earlier refusal, during which the alarm stood down) re-arm for jobs too.
    if (!this.refused && (migrated || this.getMeta("backfill") !== null)) this.armAlarm();
  }

  /**
   * In-memory subscription state is lost on hibernation/eviction; rebuild it from the socket attachments (where
   * subscriptions normally live) and `_ember_subs` (the ones that did not fit).
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
    }
    const restore = (s: { ws: WebSocket; att: Attachment }, qk: string, fn: string, args: string) => {
      const qid = JSON.parse(qk) as Id;
      if (this.refused) {
        this.send(s.ws, { t: "err", code: this.refused.code, message: this.refused.message, qid });
        return;
      }
      const entry = this.getOrRunQuery(fn, parse(args), { identity: s.att.identity });
      this.attach(s.att.sid, qid, entry);
      this.stats.rebuiltSubs++;
      if (entry.error) this.send(s.ws, { t: "err", code: entry.error.code, message: entry.error.message, qid });
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
    const prev = this.driver.exec("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?", dedupTable(n - 1)).rows.length > 0;
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
    });
    this.dedupTables = [dedupTable(n + 1), dedupTable(n)];
    return true;
  }

  private dedupLookup(identity: string, clientId: string, mid: string): string | null {
    for (const t of this.dedupTables) {
      const row = this.driver.exec(`SELECT result FROM ${t} WHERE identity = ? AND client_id = ? AND mid = ?`, identity, clientId, mid).rows[0];
      if (row) return row.result as string;
    }
    return null;
  }

  // ------------------------------------------------------------------ meta

  private getMeta(k: string): string | null {
    const r = this.driver.exec("SELECT v FROM _ember_rt_meta WHERE k = ?", k).rows[0];
    return r ? (r.v as string) : null;
  }

  private setMeta(k: string, v: string): void {
    this.driver.exec("INSERT INTO _ember_rt_meta(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, v);
  }

  private deleteMeta(k: string): void {
    this.driver.exec("DELETE FROM _ember_rt_meta WHERE k = ?", k);
  }

  private setShardName(name: string | null | undefined): void {
    if (!name || this.shardName === name) return;
    this.shardName = name;
    this.setMeta("shard", name);
    if (this.getMeta("catalog_due") !== null) this.ctx.waitUntil(this.reportCatalog(true));
  }

  // ------------------------------------------------------------------ telemetry (metrics.ts)

  /** Row counters + clock before an engine call; `null` when no metrics output is configured. */
  private probe(): { t: number; r: number; w: number } | null {
    return metricsEnabled(this.env) ? { t: performance.now(), r: this.driver.rowsRead, w: this.driver.rowsWritten } : null;
  }

  private emit(p: { t: number; r: number; w: number } | null, kind: ExecutionKind, fn: string, error: { code: string } | null, bytesOut: (() => number) | undefined, timing: Timing): void {
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
      ...(bytesOut ? { bytesOut } : {}),
      timing,
    });
  }

  /**
   * Mutation points (`timing: "commit"`): written once the batch is durable, so the duration is receipt → durable
   * commit (the DO clock advances on that storage I/O; the synchronous transaction alone would read 0 ms).
   */
  private emitAfterCommit(kind: ExecutionKind, items: Array<{ fn: string; at: number; error: { code: string } | null; rowsRead: number; rowsWritten: number; bytesOut?: () => number }>): void {
    if (!items.length || !metricsEnabled(this.env)) return;
    const done = this.ctx.storage.sync().then(
      () => Date.now(),
      () => Date.now(),
    );
    this.ctx.waitUntil(
      done.then((end) => {
        for (const it of items) {
          recordExecution(this.env, {
            fn: it.fn,
            kind,
            shard: this.shardName,
            status: it.error ? "error" : "ok",
            ...(it.error ? { errorCode: it.error.code } : {}),
            durationMs: Math.max(0, end - it.at),
            rowsRead: it.rowsRead,
            rowsWritten: it.rowsWritten,
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
    }
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

  private queryKey(fn: string, args: unknown, ctx: AuthCtx): string {
    return `${fn}\u0000${stableStringify(args)}\u0000${identityKey(ctx.identity)}`;
  }

  /**
   * The cached entry for (fn, args, identity), running the query when it is missing or errored. A failing query
   * still yields an entry (with `error`), so subscribers stay registered and it is re-run after later commits.
   */
  private getOrRunQuery(fn: string, args: unknown, ctx: AuthCtx): QueryEntry {
    const key = this.queryKey(fn, args, ctx);
    const hit = this.queries.get(key);
    if (hit && !hit.error) return hit;
    const entry: QueryEntry = hit ?? { key, fn, args, ctx, value: undefined, json: "", readSet: null, error: null, subs: new Set() };
    this.reevaluate(entry);
    this.queries.set(key, entry);
    return entry;
  }

  /** Runs the query and (re)registers it in the read-set index. */
  private reevaluate(entry: QueryEntry): void {
    const touched = new Set<string>();
    let known = this.knownTables.get(entry.fn);
    if (!known) this.knownTables.set(entry.fn, (known = new Set()));
    const p = this.probe();
    try {
      const r = this.engine.runQuery(entry.fn, entry.args, entry.ctx, { touched });
      entry.value = r.value;
      entry.json = stringify(r.value);
      this.emit(p, "subscription", entry.fn, null, () => entry.json.length, "none");
      entry.readSet = r.readSet;
      entry.error = null;
      for (const e of r.readSet) known.add(e.table);
      this.index.set(entry.key, r.readSet);
    } catch (e) {
      // No read set: re-run only on commits touching tables this function is known to read (what this run opened
      // before failing, plus what any earlier run of it read). Failing before any read = only re-sub / index-ready.
      entry.error = errInfo(e, "Error");
      this.emit(p, "subscription", entry.fn, entry.error, undefined, "none");
      entry.json = `\u0000error:${entry.error.code}:${entry.error.message}`;
      entry.readSet = null;
      this.index.set(entry.key, null, [...touched, ...known]);
    }
    for (const t of touched) known.add(t);
  }

  private attach(sid: string, qid: Id, entry: QueryEntry): void {
    let m = this.subs.get(sid);
    if (!m) this.subs.set(sid, (m = new Map()));
    m.set(qidKey(qid), { sid, qid, key: entry.key });
    entry.subs.add(`${sid}\n${qidKey(qid)}`);
  }

  private detach(sid: string, qid: Id): boolean {
    const m = this.subs.get(sid);
    const sub = m?.get(qidKey(qid));
    if (!m || !sub) return false;
    m.delete(qidKey(qid));
    if (!m.size) this.subs.delete(sid);
    const entry = this.queries.get(sub.key);
    if (entry) {
      entry.subs.delete(`${sid}\n${qidKey(qid)}`);
      if (!entry.subs.size) this.forget(entry.key);
    }
    return true;
  }

  private forget(key: string): void {
    this.queries.delete(key);
    this.index.delete(key);
    this.debounced.delete(key);
  }

  private dropSocket(sid: string): void {
    for (const sub of [...(this.subs.get(sid)?.values() ?? [])]) this.detach(sid, sub.qid);
    this.sockets.delete(sid);
    this.attachments.delete(sid);
    this.expiredNotified.delete(sid);
    this.chains.delete(sid);
    this.tableSubs.delete(sid);
    this.driver.exec("DELETE FROM _ember_subs WHERE sock = ?", sid);
  }

  /**
   * Re-run the queries whose read sets `changes` may affect (read-set index, exact matches) and send one `patch`
   * per socket, listing that socket's mutations included in `version`. Loose matches (a write to a searched table
   * that cannot change the result set, only its bm25 order) are debounced. `force` re-runs only errored entries
   * (e.g. a staged index became ready).
   */
  private publish(version: number, changes: RowChange[], mids?: Map<string, Id[]>, force = false): void {
    if (!changes.length && !force) return;
    let stale: QueryEntry[];
    if (force) stale = [...this.queries.values()].filter((e) => e.error !== null);
    else {
      const { exact, loose } = this.index.match(changes);
      stale = [];
      for (const k of exact) {
        const e = this.queries.get(k);
        if (e) stale.push(e);
        else this.index.delete(k);
      }
      if (loose.size) this.debounce(loose);
    }
    this.rerun(stale, version, mids);
  }

  /** Re-runs `entries` and sends the changed values (and `mids`) as one patch per socket. */
  private rerun(entries: QueryEntry[], version: number, mids?: Map<string, Id[]>, debounced = false): void {
    const perSocket = new Map<string, PatchChange[]>();
    for (const entry of entries) {
      if (!entry.subs.size) {
        this.forget(entry.key);
        continue;
      }
      // The re-run makes the result fresh, rank included.
      this.debounced.delete(entry.key);
      const before = entry.json;
      // Row diffs are computed from the value subscribers last received (only when that was a success).
      const prevValue = entry.error === null && before !== "" ? entry.value : undefined;
      let diff: RowDiff | null | undefined;
      this.reevaluate(entry);
      if (debounced) this.stats.debouncedReruns++;
      else this.stats.reruns++;
      if (entry.json === before) continue;
      for (const s of entry.subs) {
        const [sid, qk] = s.split("\n") as [string, string];
        const sub = this.subs.get(sid)?.get(qk);
        if (!sub || this.expiredSocket(sid)) continue;
        if (entry.error) {
          const ws = this.sockets.get(sid);
          if (ws) this.send(ws, { t: "err", code: entry.error.code, message: entry.error.message, qid: sub.qid });
          continue;
        }
        let list = perSocket.get(sid);
        if (!list) perSocket.set(sid, (list = []));
        if (prevValue !== undefined && this.attachments.get(sid)?.rowdiff) {
          if (diff === undefined) diff = rowDiff(prevValue, entry.value, entry.json);
          if (diff) {
            list.push({ qid: sub.qid, diff });
            continue;
          }
        }
        list.push({ qid: sub.qid, value: entry.value });
      }
    }
    for (const [sid, list] of perSocket) {
      const ws = this.sockets.get(sid);
      if (ws) this.send(ws, { t: "patch", version, changes: list, mids: mids?.get(sid) ?? [] });
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
    if (!att || !isExpired(att.identity)) return false;
    if (!this.expiredNotified.has(sid)) {
      this.expiredNotified.add(sid);
      const ws = this.sockets.get(sid);
      if (ws) this.send(ws, { t: "authExpired" });
    }
    return true;
  }

  private send(ws: WebSocket, m: ServerMessage): void {
    try {
      ws.send(encodeServerMessage(m));
    } catch {
      // socket already closed
    }
  }

  // ------------------------------------------------------------------ group commit

  private enqueue(p: Pending): void {
    this.pending.push(p);
    const max = this.cfg.groupCommit?.maxBatch ?? 100;
    if (this.pending.length >= max) {
      this.drain();
      return;
    }
    if (!this.drainTimer) this.drainTimer = setTimeout(() => this.drain(), this.cfg.groupCommit?.windowMs ?? 0);
  }

  private drain(): void {
    if (this.drainTimer) clearTimeout(this.drainTimer);
    this.drainTimer = null;
    const max = this.cfg.groupCommit?.maxBatch ?? 100;
    while (this.pending.length) this.commitBatch(this.pending.splice(0, max));
  }

  /** Writes version bump, change log, scheduled and cancelled jobs. Must run inside a transaction. */
  private recordCommit(changes: RowChange[], jobs: Job[], cancelled: string[] = []): number {
    let v = this.version;
    const now = Date.now();
    if (changes.length) {
      v++;
      // One upsert per commit: the ring slot of version v replaces version v - ring (and carries the version).
      this.driver.exec(
        "INSERT INTO _ember_changes(slot, version, at, changes) VALUES (?, ?, ?, ?) ON CONFLICT(slot) DO UPDATE SET version = excluded.version, at = excluded.at, changes = excluded.changes",
        v % ringSize(this.cfg), v, now, stringify(changes),
      );
      if (this.getMeta("next_maint") === null) this.setMeta("next_maint", String(now + HOUR));
    }
    for (const j of jobs) this.insertJob({ jobId: j.id, fn: j.fn, args: j.args, kind: j.kind, runAt: j.runAt });
    for (const id of cancelled) this.driver.exec("DELETE FROM _jobs WHERE job_id = ? AND state IN ('pending', 'dispatched')", id);
    return v;
  }

  private commitBatch(batch: Pending[]): void {
    const outcomes: (MutationOutcome | undefined)[] = new Array(batch.length);
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
    /** Per executed item: rows (the batch's counters split evenly: one transaction) and result size. */
    let perItem: Array<{ rowsRead: number; rowsWritten: number; bytesOut?: () => number; error: { code: string } | null }> = [];
    if (toRun.length) {
      this.stats.batches++;
      this.stats.batchSizes.push(toRun.length);
      if (this.stats.batchSizes.length > 50) this.stats.batchSizes.shift();
      try {
        const res = this.driver.transaction(() => {
          const items: MutationBatchItem[] = toRun.map((i) => ({ name: batch[i]!.fn, args: batch[i]!.args, ctx: batch[i]!.ctx }));
          const r0 = this.driver.rowsRead;
          const w0 = this.driver.rowsWritten;
          const results = this.engine.runMutationBatch(items);
          if (results.length !== items.length) throw new Error("engine returned a result count different from the batch size");
          // Group commit: the batch's rows are split evenly across its items (one transaction).
          const rr = share(this.driver.rowsRead - r0, results.length);
          const ww = share(this.driver.rowsWritten - w0, results.length);
          perItem = results.map((r) => ({ rowsRead: rr, rowsWritten: ww, error: r.ok ? null : r.error, ...(r.ok ? { bytesOut: () => stringify(r.value ?? null).length } : {}) }));
          const all: RowChange[] = [];
          const jobs: Job[] = [];
          const cancelled: string[] = [];
          for (const r of results) {
            if (r.ok) {
              all.push(...r.changes);
              jobs.push(...r.scheduled);
              cancelled.push(...(r.cancelled ?? []));
            }
          }
          const v = this.recordCommit(all, jobs, cancelled);
          const now = Date.now();
          results.forEach((r, j) => {
            const i = toRun[j]!;
            const out: MutationOutcome = r.ok ? { ok: true, value: r.value, version: v } : { ok: false, error: r.error };
            outcomes[i] = out;
            const d = batch[i]!.dedup;
            if (d && (out.ok || !d.okOnly)) {
              this.driver.exec(
                `INSERT INTO ${this.dedupTables[0]}(identity, client_id, mid, at, result) VALUES (?, ?, ?, ?, ?)`,
                d.identity, d.clientId, d.mid, now, stringify(out),
              );
            }
          });
          return { v, all, jobs: jobs.length + cancelled.length };
        });
        this.version = res.v;
        changes = res.all;
        if (changes.length) this.lastWrite = Date.now();
        hasJobs = res.jobs > 0 || changes.length > 0;
      } catch (e) {
        const err = errInfo(e, "internal");
        for (const i of toRun) outcomes[i] = { ok: false, error: err };
      }
    }
    for (const [i, first] of followers) outcomes[i] = outcomes[first];
    // Metrics: callers that measure the RPC get the rows in the outcome; the rest get a point after the commit.
    const committed: Parameters<Shard["emitAfterCommit"]>[1] = [];
    toRun.forEach((i, j) => {
      const m = perItem[j];
      const it = batch[i]!;
      if (!m) return;
      if (it.caller) {
        const o = outcomes[i];
        if (o) outcomes[i] = { ...o, metrics: { rowsRead: m.rowsRead, rowsWritten: m.rowsWritten, bytesOut: m.bytesOut ? m.bytesOut() : 0 } };
      } else committed.push({ fn: it.fn, at: it.at, ...m });
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
    if (changes.length) this.kickOutbox();
    // Jobs, and `_files` rows (uploads, refcounts reaching zero) whose GC the alarm must schedule.
    if (hasJobs || toRun.length) this.armAlarm();
    for (let i = 0; i < batch.length; i++) {
      batch[i]!.resolve(outcomes[i] ?? { ok: false, error: { code: "internal", message: "no outcome" } });
    }
  }

  // ------------------------------------------------------------------ scheduler

  /** The job's id (`job_id`), or null when `dedupKey` (or `jobId`) is already taken. */
  private insertJob(job: JobInput): string | null {
    const now = Date.now();
    const maxAttempts = job.maxAttempts ?? this.cfg.scheduler?.maxAttempts ?? 5;
    const jobId = job.jobId ?? makeId("job", now, Math.random);
    const r = this.driver.exec(
      `INSERT INTO _jobs(run_at, fn, args, kind, max_attempts, dedup_key, created_at, updated_at, job_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING job_id`,
      job.runAt ?? now, job.fn, stringify(job.args ?? {}), job.kind ?? "mutation", maxAttempts, job.dedupKey ?? null, now, now, jobId,
    ).rows[0];
    return r ? (r.job_id as string) : null;
  }

  /** alarm = min(next pending job, next maintenance), never more than 30 days ahead (chained). */
  private armAlarm(): void {
    const now = Date.now();
    // `running` rows count too: their run_at is when they are given back if the object died mid-run.
    const j = this.driver.exec(`SELECT MIN(run_at) AS m FROM _jobs WHERE state IN ${DUE_STATES} OR state = 'running'`).rows[0];
    const candidates: number[] = [];
    if (j && j.m !== null) candidates.push(j.m as number);
    const maint = this.getMeta("next_maint");
    if (maint !== null) candidates.push(Number(maint));
    if (this.getMeta("backfill") !== null) candidates.push(now);
    const gc = this.files.nextGcAt();
    if (gc !== null) candidates.push(Math.max(gc, now));
    if (this.hasExternal && !this.flushing) {
      const ob = outboxNextAt(this.driver, now, this.outboxResendMs());
      if (ob !== null) candidates.push(Math.max(ob, now));
    }
    if (!candidates.length) {
      if (this.lastArmed !== null) {
        this.lastArmed = null;
        void this.ctx.storage.deleteAlarm();
      }
      return;
    }
    const target = Math.min(Math.min(...candidates), now + MAX_ALARM_AHEAD_MS);
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

  private failJob(job: Record<string, unknown>, error: { code: string; message: string }): void {
    const attempts = (job.attempts as number) + 1;
    const now = Date.now();
    const final = attempts >= (job.max_attempts as number);
    this.driver.exec(
      "UPDATE _jobs SET attempts = ?, state = ?, run_at = ?, last_error = ?, updated_at = ? WHERE id = ?",
      attempts, final ? "failed" : "pending", final ? (job.run_at as number) : now + this.backoff(attempts),
      `${error.code}: ${error.message}`, now, job.id as number,
    );
  }

  private runMutationJob(job: Record<string, unknown>): void {
    let committed: { v: number; changes: RowChange[] } | null = null;
    const at = Date.now();
    let jobPoint: Parameters<Shard["emitAfterCommit"]>[1][number] | null = null;
    try {
      // The job, its effects and its state update share one transaction (alarm writes are never rolled back: R5).
      committed = this.driver.transaction(() => {
        const r0 = this.driver.rowsRead;
        const w0 = this.driver.rowsWritten;
        const [r] = this.engine.runMutationBatch([{ name: job.fn as string, args: parse(job.args as string), ctx: ANON }]);
        if (!r) throw new Error("engine returned no result");
        jobPoint = { fn: job.fn as string, at, error: r.ok ? null : r.error, rowsRead: this.driver.rowsRead - r0, rowsWritten: this.driver.rowsWritten - w0 };
        if (!r.ok) {
          this.failJob(job, r.error);
          return null;
        }
        const v = this.recordCommit(r.changes, r.scheduled, r.cancelled ?? []);
        this.driver.exec("DELETE FROM _jobs WHERE id = ?", job.id as number);
        return { v, changes: r.changes };
      });
    } catch (e) {
      this.driver.transaction(() => this.failJob(job, errInfo(e, "internal")));
    }
    if (jobPoint) this.emitAfterCommit("job", [jobPoint]);
    if (committed) {
      if (committed.changes.length) this.lastWrite = Date.now();
      this.version = committed.v;
      this.publish(committed.v, committed.changes);
      if (committed.changes.length) this.kickOutbox();
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
    if (!leaseOver && queue && actionDispatch(this.cfg, fn).dispatch !== "shard" && job.job_id !== null) {
      const now = Date.now();
      // The row stays as the lease: the alarm finds it again if nobody reports back in time.
      this.driver.exec("UPDATE _jobs SET state = 'dispatched', run_at = ?, updated_at = ? WHERE id = ?", now + this.actionLease(fn), now, job.id as number);
      try {
        const leased: ActionJobMessage = { ...msg, lease: true };
        if (this.cfg.dispatchAction) await this.cfg.dispatchAction(this.env, leased);
        else await this.env.EMBER_ACTIONS!.send(leased);
      } catch (e) {
        this.driver.transaction(() => this.failJob(job, errInfo(e, "dispatch_failed")));
      }
      return;
    }
    if (leaseOver) console.warn(`ember: action job ${msg.jobId} (${fn}) not finished by the queue within its lease; running it in the shard`);
    try {
      // Mark running first so a concurrent alarm retry (or a late claim from the queue) cannot run it twice, with the
      // moment it is given back if this object dies mid-run (the alarm stays armed for it).
      const started = Date.now();
      this.driver.exec("UPDATE _jobs SET state = 'running', run_at = ?, updated_at = ? WHERE id = ?", started + RUNNING_RECOVERY_MS, started, job.id as number);
      // Durably, before awaiting the action: if the object dies mid-run, this alarm brings the job back.
      this.armAlarm();
      const out = await this.actionRunner().run(fn, msg.args, msg.shard, null, { internal: true });
      if (!out.ok) throw Object.assign(new Error(out.error.message), { code: out.error.code });
      this.driver.exec("DELETE FROM _jobs WHERE id = ?", job.id as number);
    } catch (e) {
      this.driver.transaction(() => this.failJob(job, errInfo(e, "action_failed")));
    }
  }

  /**
   * The queue consumer claims a leased action job before running it: true when the job is still waiting for it
   * (`dispatched`), which then becomes `claimed` with a fresh lease. False when it was cancelled, already ran here
   * after its lease ran out, or another delivery claimed it: the consumer acks the message without running it.
   */
  async claimActionJob(shard: string, jobId: string): Promise<{ run: boolean }> {
    this.setShardName(shard);
    const row = this.driver.exec("SELECT fn FROM _jobs WHERE job_id = ? AND state = 'dispatched'", jobId).rows[0];
    if (!row) return { run: false };
    const now = Date.now();
    this.driver.exec("UPDATE _jobs SET state = 'claimed', run_at = ?, updated_at = ? WHERE job_id = ? AND state = 'dispatched'", now + this.actionLease(row.fn as string), now, jobId);
    this.armAlarm();
    return { run: true };
  }

  /**
   * The outcome of a claimed action job: done (the row goes), or failed (retried here with backoff, or `failed` after
   * `maxAttempts`, like any job). A job no longer claimed (its lease ran out and it ran here) is left alone.
   */
  async settleActionJob(shard: string, jobId: string, error: { code: string; message: string } | null): Promise<void> {
    this.setShardName(shard);
    const job = this.driver.exec("SELECT * FROM _jobs WHERE job_id = ? AND state = 'claimed'", jobId).rows[0];
    if (!job) return;
    if (error === null) this.driver.exec("DELETE FROM _jobs WHERE id = ?", job.id as number);
    else this.driver.transaction(() => this.failJob(job, error));
    this.armAlarm();
  }

  /** Actions run from this shard: calls to this shard skip the RPC hop. */
  private actionRunner(): ActionRunner {
    const self: ShardApi = this;
    return new ActionRunner(this.cfg, this.env, (shard) => (shard === this.shardName ? self : (shardStub(this.env, this.cfg.schema.manifest, shard) as unknown as ShardApi)));
  }

  override async alarm(): Promise<void> {
    // Never throw: retries are counted per job, not by the platform's 6 alarm retries.
    let ran = 0;
    try {
      if (this.refused) return;
      // A crash mid-dispatch can leave action jobs 'running'; give them back to the queue.
      this.driver.exec("UPDATE _jobs SET state = 'pending', run_at = ? WHERE state = 'running' AND updated_at <= ?", Date.now(), Date.now() - RUNNING_RECOVERY_MS);
      if (this.getMeta("backfill") !== null) this.backfillTurn();
      while (ran < MAX_JOBS_PER_ALARM) {
        const job = this.driver.exec(
          `SELECT * FROM _jobs WHERE state IN ${DUE_STATES} AND run_at <= ? ORDER BY run_at, id LIMIT 1`,
          Date.now(),
        ).rows[0];
        if (!job) break;
        ran++;
        if (job.kind === "action") await this.runActionJob(job);
        else this.runMutationJob(job);
      }
      const maint = this.getMeta("next_maint");
      if (maint !== null && Number(maint) <= Date.now()) await this.maintenance();
      await this.filesGc();
      if (this.hasExternal) await this.flushOutbox();
    } catch (e) {
      console.error("ember: alarm failed", e);
    }
    this.lastArmed = undefined;
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

  private async maintenance(): Promise<void> {
    const now = Date.now();
    this.rotateDedup(now);
    this.driver.exec("DELETE FROM _jobs WHERE state = 'failed' AND updated_at < ?", now - DEDUP_RETENTION_MS);
    this.driver.exec("DELETE FROM _ember_bookmarks WHERE at < ?", now - BOOKMARK_RETENTION_MS);
    this.driver.exec("DELETE FROM _ember_sub_ident WHERE at < ?", now - BOOKMARK_RETENTION_MS);
    await this.recordBookmark("hourly");
    await this.reportCatalog(false);
    // Keep the hourly tick only while the shard is active.
    const active = this.getMeta("maint_version") !== String(this.version);
    this.setMeta("maint_version", String(this.version));
    if (active) this.setMeta("next_maint", String(now + HOUR));
    else this.deleteMeta("next_maint");
  }

  // ------------------------------------------------------------------ external indexes (ai-indexes.ts)

  private outboxResendMs(): number {
    return indexEnv(this.cfg, this.env)[INDEXING_QUEUE_BINDING] ? OUTBOX_RESEND_QUEUE_MS : OUTBOX_RESEND_LOCAL_MS;
  }

  /** After a commit that may have written the outbox: deliver in the background (the alarm is the fallback). */
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

  private saveAttachment(ws: WebSocket, att: Attachment): void {
    const { subs, ...base } = att;
    let a: Attachment = base;
    if (JSON.stringify(a).length > MAX_ATTACHMENT_BYTES && a.identity) {
      const { claims: _drop, ...rest } = a.identity;
      a = { ...a, identity: rest };
    }
    if (JSON.stringify(a).length > MAX_ATTACHMENT_BYTES && a.token) {
      // Sensitive mutations on this socket will be refused (`reauth_required`) instead.
      const { token: _drop, ...rest } = a;
      a = rest;
    }
    if (subs?.length) {
      const withSubs: Attachment = { ...a, subs };
      if (JSON.stringify(withSubs).length <= MAX_ATTACHMENT_BYTES) a = withSubs;
      else for (const [qk, fn, args] of subs) this.writeTableSub(a.sid, qk, fn, args);
    }
    ws.serializeAttachment(a);
    this.attachments.set(a.sid, a);
  }

  override async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment;
    // Serialize handling per socket: `hello` may await token verification.
    const prev = this.chains.get(att.sid) ?? Promise.resolve();
    const next = prev.then(() => this.handleMessage(ws, data)).catch((e) => {
      this.send(ws, { t: "err", code: "internal", message: errInfo(e, "internal").message });
    });
    this.chains.set(att.sid, next);
    await next;
  }

  private async handleMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    let msg: ClientMessage;
    try {
      msg = decodeClientMessage(data);
    } catch (e) {
      const code = e instanceof ProtocolError ? e.code : "bad_frame";
      this.send(ws, { t: "err", code, message: (e as Error).message });
      return;
    }
    let att = ws.deserializeAttachment() as Attachment;
    this.sockets.set(att.sid, ws);
    this.attachments.set(att.sid, att);
    if (msg.t !== "hello" && !att.hello) {
      this.send(ws, { t: "err", code: "no_hello", message: "send hello first" });
      return;
    }
    // An expired token never runs anything anonymously: the frame is refused until the client sends `auth`.
    if ((msg.t === "sub" || msg.t === "mut") && isExpired(att.identity)) {
      const error = { code: "auth_expired", message: "the token expired; send {t:\"auth\"} with a fresh one" };
      this.send(ws, { t: "authExpired" });
      if (msg.t === "mut") this.send(ws, { t: "mres", mid: msg.mid, ok: false, error });
      else this.send(ws, { t: "err", ...error, qid: msg.qid });
      return;
    }
    // A refused migration: nothing runs on the old schema with the new code.
    if (this.refused && (msg.t === "sub" || msg.t === "mut")) {
      if (msg.t === "mut") this.send(ws, { t: "mres", mid: msg.mid, ok: false, error: this.refused });
      else this.send(ws, { t: "err", ...this.refused, qid: msg.qid });
      return;
    }
    switch (msg.t) {
      case "hello": {
        if (att.hello) {
          this.send(ws, { t: "err", code: "duplicate_hello", message: "hello already received" });
          return;
        }
        let identity = att.identity;
        let token = att.token;
        if (msg.token !== undefined) {
          const verified = await this.verify(msg.token);
          if (!verified) {
            this.send(ws, { t: "err", code: "unauthenticated", message: "invalid token" });
          } else {
            identity = verified;
            token = msg.token;
          }
        }
        const { token: _old, ...prevAtt } = ws.deserializeAttachment() as Attachment;
        const rowdiff = msg.features?.includes("rowdiff") === true;
        const ident = msg.features?.includes("ident") === true;
        att = { ...prevAtt, identity, clientId: msg.clientId, hello: true, ...(identity && token ? { token } : {}), ...(rowdiff ? { rowdiff: true as const } : {}), ...(ident ? { ident: true as const } : {}) };
        this.saveAttachment(ws, att);
        const features = [...(rowdiff ? ["rowdiff" as const] : []), ...(ident ? ["ident" as const] : [])];
        this.send(ws, { t: "ready", shard: this.shardName ?? "", version: this.version, epoch: this.epoch, ...(features.length ? { features } : {}) });
        return;
      }
      case "sub":
        this.subscribe(ws, att, msg);
        return;
      case "unsub":
        if (this.detach(att.sid, msg.qid)) this.unpersistSub(ws, att, qidKey(msg.qid));
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
          at: Date.now(),
          resolve: (o) => this.send(ws, o.ok ? { t: "mres", mid, ok: true, value: o.value, version: o.version } : { t: "mres", mid, ok: false, error: o.error }),
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
        att = { ...prevAtt, identity, ...(msg.token !== null ? { token: msg.token } : {}) };
        this.saveAttachment(ws, att);
        this.expiredNotified.delete(att.sid);
        // Identity changed: every subscription of this socket is re-evaluated under the new identity.
        const ctx: AuthCtx = { identity };
        for (const sub of [...(this.subs.get(att.sid)?.values() ?? [])]) {
          const old = this.queries.get(sub.key);
          this.detach(att.sid, sub.qid);
          const entry = this.getOrRunQuery(old?.fn ?? "", old?.args ?? {}, ctx);
          this.attach(att.sid, sub.qid, entry);
          this.sendSnap(ws, att, sub.qid, entry);
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
      fresh = (await hook.verify(att.token, { sensitive: true })) ?? null;
    } catch {
      fresh = null;
    }
    if (!fresh || fresh.subject !== att.identity.subject) return { code: "unauthenticated", message: "the session is no longer valid" };
    return null;
  }

  /** A verified, unexpired identity, or null. */
  private async verify(token: string): Promise<Identity | null> {
    const hook = this.cfg.auth;
    if (!hook) return null;
    try {
      const identity = (await hook.verify(token)) ?? null;
      return isExpired(identity) ? null : identity;
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
  private sendSnap(ws: WebSocket, att: Attachment, qid: Id, entry: QueryEntry): void {
    if (entry.error) {
      this.send(ws, { t: "err", code: entry.error.code, message: entry.error.message, qid });
      return;
    }
    if (att.ident) {
      this.send(ws, { t: "snap", qid, version: this.version, value: entry.value, ik: identTag(att.identity) });
      return;
    }
    if (att.clientId) {
      this.driver.exec(
        "INSERT INTO _ember_sub_ident(client_id, qid, identity, at) VALUES (?, ?, ?, ?) ON CONFLICT(client_id, qid) DO UPDATE SET identity = excluded.identity, at = excluded.at",
        att.clientId, qidKey(qid), identityKey(att.identity), Date.now(),
      );
    }
    this.send(ws, { t: "snap", qid, version: this.version, value: entry.value });
  }

  /** Records a subscription for hibernation: in the attachment when it fits (free), else a `_ember_subs` row. */
  private persistSub(ws: WebSocket, att: Attachment, qk: string, fn: string, args: string): Attachment {
    const others = (att.subs ?? []).filter((x) => x[0] !== qk);
    const next: Attachment = { ...att, subs: [...others, [qk, fn, args]] };
    if (JSON.stringify(next).length <= MAX_ATTACHMENT_BYTES) {
      ws.serializeAttachment(next);
      this.attachments.set(att.sid, next);
      this.deleteTableSub(att.sid, qk); // it was in the table (overflow, older runtime): one store per qid
      return next;
    }
    let cur = att;
    if (others.length !== (att.subs ?? []).length) {
      cur = { ...att, subs: others };
      ws.serializeAttachment(cur);
      this.attachments.set(att.sid, cur);
    }
    this.writeTableSub(att.sid, qk, fn, args);
    return cur;
  }

  /** Forgets a subscription in both stores (it should be in one; a leftover in the other would revive it). */
  private unpersistSub(ws: WebSocket, att: Attachment, qk: string): void {
    if (att.subs?.some((x) => x[0] === qk)) {
      const next: Attachment = { ...att, subs: att.subs.filter((x) => x[0] !== qk) };
      ws.serializeAttachment(next);
      this.attachments.set(att.sid, next);
    }
    this.deleteTableSub(att.sid, qk);
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
      // Re-subscribing an errored qid re-runs it; a healthy duplicate is a client bug.
      if (!this.queries.get(existing.key)?.error) {
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
    const entry = this.getOrRunQuery(msg.fn, msg.args, { identity: att.identity });
    this.attach(att.sid, msg.qid, entry);
    att = this.persistSub(ws, att, qidKey(msg.qid), msg.fn, stringify(msg.args));
    if (!entry.error && msg.resume && entry.readSet && this.resumeUnchanged(msg.resume, att, msg.qid, entry.readSet)) {
      this.send(ws, { t: "snap", qid: msg.qid, version: this.version, unchanged: true });
    } else {
      this.sendSnap(ws, att, msg.qid, entry);
    }
  }

  /**
   * True when the client's value at `resume.version` is still current: same epoch, the client's last snapshot
   * of this qid was computed under the socket's current identity, every version since is in the change log,
   * and none of those changes touches the query's read-set.
   */
  private resumeUnchanged(resume: { version: number; epoch: string; ik?: string }, att: Attachment, qid: Id, readSet: ReadSet): boolean {
    if (resume.epoch !== this.epoch || resume.version > this.version) return false;
    if (att.ident) {
      // The tag of the snapshot the client holds (echoed): same identity as this socket's, or a full snap.
      if (resume.ik !== identTag(att.identity)) return false;
    } else {
      if (!att.clientId) return false;
      const owner = this.driver.exec("SELECT identity FROM _ember_sub_ident WHERE client_id = ? AND qid = ?", att.clientId, qidKey(qid)).rows[0];
      if (!owner || owner.identity !== identityKey(att.identity)) return false;
    }
    if (resume.version === this.version) return true;
    const rows = this.driver.exec("SELECT changes FROM _ember_changes WHERE version > ? ORDER BY version", resume.version).rows;
    if (rows.length !== this.version - resume.version) return false;
    const changes = rows.flatMap((r) => parse(r.changes as string) as RowChange[]);
    return !this.engine.matches(readSet, changes);
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (att?.sid) this.dropSocket(att.sid);
    try {
      ws.close(code, reason);
    } catch {
      // already closed
    }
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (att?.sid) this.dropSocket(att.sid);
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
  async query(shard: string, fn: string, args: unknown, identity: Identity | null, internal = false, opts: { caller?: boolean } = {}): Promise<MutationOutcome> {
    this.setShardName(shard);
    const denied = this.checkCallable(fn, "query", internal);
    if (denied) return { ok: false, error: denied };
    const p = opts.caller ? { t: 0, r: this.driver.rowsRead, w: this.driver.rowsWritten } : this.probe();
    const metrics = (bytesOut: number): CallMetrics => ({ rowsRead: this.driver.rowsRead - p!.r, rowsWritten: this.driver.rowsWritten - p!.w, bytesOut });
    try {
      const ctx: AuthCtx = { identity };
      const cached = this.queries.get(this.queryKey(fn, args, ctx));
      const value = cached && !cached.error ? cached.value : this.engine.runQuery(fn, args, ctx).value;
      if (opts.caller) return { ok: true, value, version: this.version, metrics: metrics(stringify(value ?? null).length) };
      // Synchronous inside the DO: in production the clock does not move here (0 ms, timing "none").
      this.emit(p, "query", fn, null, () => stringify(value ?? null).length, "none");
      return { ok: true, value, version: this.version };
    } catch (e) {
      const error = errInfo(e, "Error");
      if (opts.caller) return { ok: false, error, metrics: metrics(0) };
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
    const denied = this.checkCallable(fn, "mutation", internal);
    if (denied) return { ok: false, error: denied };
    const dedup = opts.dedupKey ? { dedup: { identity: identityKey(identity), clientId: "\u0000rpc", mid: opts.dedupKey, okOnly: true } } : {};
    return new Promise((resolve) => this.enqueue({ fn, args, ctx: { identity }, resolve, at: Date.now(), ...(opts.caller ? { caller: true } : {}), ...dedup }));
  }

  /** `id`: the job id, or null when its dedup key / id is already taken. */
  async enqueueJob(shard: string, job: JobInput): Promise<{ id: string | null }> {
    this.setShardName(shard);
    if (this.refused) throw Object.assign(new Error(this.refused.message), { code: this.refused.code });
    const id = this.insertJob(job);
    this.armAlarm();
    return { id };
  }

  /**
   * Cancels a job by id that has not started: pending, or handed to the Queue and not claimed yet (the consumer's claim
   * then finds nothing and skips it). True when one was removed (a running or finished job is not affected).
   */
  async cancelJob(shard: string, id: string): Promise<boolean> {
    this.setShardName(shard);
    const r = this.driver.exec("DELETE FROM _jobs WHERE job_id = ? AND state IN ('pending', 'dispatched') RETURNING id", id);
    if (r.rows.length) this.armAlarm();
    return r.rows.length > 0;
  }

  /** Migration / backfill state for `GET /api/_ember/status` (waking the shard runs its migration first). */
  async status(shard: string): Promise<ShardStatus> {
    this.setShardName(shard);
    const expectedVersion = this.cfg.schema.manifest.version;
    const schemaVersion = this.getMeta("schema_version");
    const hasIndexes = this.driver.exec("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = '_ember_indexes'").rows.length > 0;
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
    const last = this.driver.exec("SELECT * FROM _ember_migrations WHERE to_version = ? ORDER BY id DESC LIMIT 1", expectedVersion).rows[0];
    const lastError = this.driver.exec("SELECT * FROM _ember_migrations WHERE ok = 0 ORDER BY id DESC LIMIT 1").rows[0];
    return {
      shard,
      expectedVersion,
      schemaVersion,
      ready: !this.refused && schemaVersion === expectedVersion && staged.length === 0,
      staged,
      migrationError: this.refused && last && last.ok === 0 ? toInfo(last) : null,
      lastMigrationError: toInfo(lastError),
      version: this.version,
      databaseSize: this.ctx.storage.sql.databaseSize,
    };
  }

  /** Read-only data browser (`GET /api/_ember/data`, admin only). `table: null` lists the tables. */
  async browse(shard: string, table: string | null, cursor: string | null, limit?: number): Promise<BrowseResult> {
    this.setShardName(shard);
    return browse(this.driver, this.cfg.schema.manifest, table, cursor, limit);
  }

  /** Introspection for tests and the dashboard. */
  async inspect(): Promise<ShardInspection> {
    let subs = 0;
    for (const m of this.subs.values()) subs += m.size;
    return {
      version: this.version,
      epoch: this.epoch,
      shard: this.shardName,
      stats: { ...this.stats, batchSizes: [...this.stats.batchSizes] },
      subs,
      queries: this.queries.size,
      jobs: this.driver.exec("SELECT id, job_id, run_at, fn, kind, state, attempts, max_attempts, last_error, dedup_key FROM _jobs ORDER BY run_at, id").rows as unknown as JobRow[],
      bookmarks: (this.driver.exec("SELECT COUNT(*) AS n FROM _ember_bookmarks").rows[0]?.n as number) ?? 0,
      alarm: await this.ctx.storage.getAlarm(),
      backfilling: this.getMeta("backfill") !== null,
      files: this.files.stats(),
      outbox: outboxStats(this.driver),
      rows: { read: this.driver.rowsRead, written: this.driver.rowsWritten },
    };
  }

  // ------------------------------------------------------------------ point-in-time recovery (restore.ts)

  /** Recorded bookmarks, oldest first (`ember restore --list`). */
  async bookmarks(shard: string): Promise<BookmarkRow[]> {
    this.setShardName(shard);
    return this.driver.exec("SELECT id, at, bookmark, reason FROM _ember_bookmarks ORDER BY id").rows.map((r) => ({
      id: Number(r.id),
      at: Number(r.at),
      bookmark: String(r.bookmark),
      reason: String(r.reason),
    }));
  }

  /** Records a bookmark now (null: no PITR in this runtime). */
  async bookmarkNow(shard: string, reason: string): Promise<BookmarkRow | null> {
    this.setShardName(shard);
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
  async restorePrepare(shard: string, bookmark: string, label: string): Promise<RestorePrepared> {
    this.setShardName(shard);
    if (this.restoring) throw new Error(`restore_in_progress: a restore of ${shard} is already scheduled; it applies when the object restarts`);
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
    const state = () => ({ version: this.version, epoch: this.epoch, schemaVersion: this.getMeta("schema_version") });
    const notScheduled = () => new Error("restore_not_scheduled: the shard restarted without applying the restore; nothing was restored");
    const outcome = this.restoreOutcome(info.nonce);
    if (outcome?.stage === "failed") throw notScheduled();
    if (outcome?.stage === "done") return state();
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
          this.driver.exec("INSERT OR IGNORE INTO _ember_bookmarks(id, at, bookmark, reason) VALUES (?, ?, ?, ?)", r.id, r.at, r.bookmark, r.reason);
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
      try {
        ws.close(1012, "ember restore");
      } catch {
        // already closed
      }
    }
    this.lastArmed = undefined;
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

  // ------------------------------------------------------------------ files (RPC from the Worker / actions)

  private fileOp<T>(shard: string, fn: () => T): FileResult<T> {
    this.setShardName(shard);
    if (this.refused) return { ok: false, code: this.refused.code, message: this.refused.message };
    try {
      return { ok: true, value: this.driver.transaction(fn) };
    } catch (e) {
      const { code, message } = errorInfo(e);
      return { ok: false, code, message };
    }
  }

  async fileUploadTarget(shard: string, id: string, token: string | null): Promise<FileResult<FileRow>> {
    return this.fileOp(shard, () => this.files.uploadTarget(id, token));
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
    const r = this.fileOp(shard, () => this.files.byKey(key));
    return r.ok ? r.value : [];
  }

  async fileMeta(shard: string, id: string): Promise<FileRow | null> {
    const r = this.fileOp(shard, () => this.files.get(id));
    return r.ok ? r.value : null;
  }

  async fileUrl(shard: string, id: string, opts: GetUrlOptions): Promise<string | null> {
    const r = this.fileOp(shard, () => this.files.getUrl(id, opts, Date.now()));
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

  async fileDelete(shard: string, id: string): Promise<FileResult<null>> {
    const r = this.fileOp(shard, () => {
      this.files.delete(id, Date.now());
      return null;
    });
    this.armAlarm();
    return r;
  }
}
