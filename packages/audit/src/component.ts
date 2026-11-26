// The audit component (contracts.md "Audit"). Rows are written by app triggers (`auditTriggers`) inside the mutation
// that changed the document, so an audit row exists exactly when the write committed: one row per audited write.
// Old rows leave the shard through a daily cron: batches of `batchSize` are claimed in a mutation, written to R2 as
// gzip NDJSON by an action, and deleted by a mutation once the object is there. A batch is named before it is
// written, so a crash between the R2 write and the delete re-runs the same batch: the object is found and only the
// delete is done. Nothing is lost (rows are deleted only after their object exists) or duplicated (a batch's rows go
// to one key, written at most once).

import {
  componentBuilders,
  cronJobs,
  defineComponent,
  defineSchema,
  defineTable,
  EmberError,
  paginationOptsValidator,
  unsafeRef,
  v,
  type ComponentCtx,
  type GenericId,
  type PaginationResult,
} from "@freecorps/ember-server";
import { archiveKey, gunzipNdjson, gzipNdjson, type R2BucketLike } from "./archive.ts";

export const DEFAULT_RETAIN_DAYS = 30;
export const DEFAULT_BATCH_SIZE = 1000;
/** Most rows one batch moves (its delete stays well under the shard's write limit, indexes included). */
export const MAX_BATCH_SIZE = 1500;
export const DEFAULT_BUCKET = "EMBER_FILES";
export const SYSTEM_ACTOR = "system";
const DAY = 86_400_000;

const vOp = v.union(v.literal("insert"), v.literal("update"), v.literal("delete"), v.literal("log"));
export type AuditOp = "insert" | "update" | "delete" | "log";

const schema = defineSchema({
  tables: {
    /**
     * One row per audited write (`op` insert/update/delete: `table` and `docId` of the document, `diff` of its audited
     * fields) or app event (`op` "log": `action`, `docId` = the target, `data`). `actor`: the identity subject of the
     * mutation, or "system" (jobs, crons, the dashboard).
     */
    entries: defineTable({
      table: v.string(),
      docId: v.string(),
      op: vOp,
      actor: v.string(),
      at: v.number(),
      diff: v.optional(v.any()),
      action: v.optional(v.string()),
      data: v.optional(v.any()),
      truncated: v.optional(v.boolean()),
      omitted: v.optional(v.number()),
    })
      .index("by_at", ["at"])
      .index("by_table_doc", ["table", "docId", "at"])
      .index("by_actor", ["actor", "at"]),
    /**
     * Archive batches: `pending` from the claim until its rows are deleted (`ids` are the rows, `key` the R2 object),
     * then `archived` (the archives list of the dashboard; `ids` dropped).
     */
    batches: defineTable({
      key: v.string(),
      state: v.union(v.literal("pending"), v.literal("archived")),
      ids: v.optional(v.array(v.string())),
      count: v.number(),
      firstAt: v.number(),
      lastAt: v.number(),
      cutoff: v.number(),
      at: v.number(),
      bytes: v.optional(v.number()),
      archivedAt: v.optional(v.number()),
    })
      .index("by_state", ["state", "at"])
      .index("by_at", ["at"]),
  },
});

export const installConfigValidator = v.object({
  /** Rows older than this many days leave the shard (default 30). */
  retainDays: v.optional(v.number()),
  /** Rows per archive job (default 1000, at most 1500). */
  batchSize: v.optional(v.number()),
  /** Write old rows to R2 before deleting them (default true; false: they are only deleted). */
  archive: v.optional(v.boolean()),
  /** The R2 bucket binding (default the files bucket `EMBER_FILES`). */
  bucket: v.optional(v.string()),
  /** Key prefix (default `audit/<install>`). */
  prefix: v.optional(v.string()),
  /** The cron's shard (default `global:main`). */
  shard: v.optional(v.string()),
  /** Shard kinds whose shards the cron also archives (audit rows live in the shard of each mutation). */
  shardKinds: v.optional(v.array(v.string())),
  /** UTC hour of the daily cron (default 3). */
  hour: v.optional(v.number()),
});

export type AuditInstallConfig = {
  retainDays?: number;
  batchSize?: number;
  archive?: boolean;
  bucket?: string;
  prefix?: string;
  shard?: string;
  shardKinds?: string[];
  hour?: number;
};

type Config = AuditInstallConfig | undefined;
const { query, mutation, action, internalQuery, internalMutation, internalAction } = componentBuilders<typeof schema, Config>();
type ActCtx = ComponentCtx<typeof schema, Config>["action"];
type QCtx = ComponentCtx<typeof schema, Config>["query"];
type MCtx = ComponentCtx<typeof schema, Config>["mutation"];

const actorOf = (ctx: QCtx | MCtx) => ctx.auth.getUserIdentity()?.subject ?? SYSTEM_ACTOR;
const prefixOf = (ctx: { component: { name: string; config: Config } }) => (ctx.component.config?.prefix ?? `audit/${ctx.component.name}`).replace(/\/+$/, "");
const retainDaysOf = (c: Config) => Math.max(0, c?.retainDays ?? DEFAULT_RETAIN_DAYS);
const batchSizeOf = (c: Config) => Math.max(1, Math.min(MAX_BATCH_SIZE, Math.floor(c?.batchSize ?? DEFAULT_BATCH_SIZE)));

function bucketOf(ctx: ActCtx): R2BucketLike {
  const name = ctx.component.config?.bucket ?? DEFAULT_BUCKET;
  const b = ctx.env[name] as R2BucketLike | undefined;
  if (!b || typeof b.put !== "function" || typeof b.head !== "function") {
    throw new EmberError("StorageError", `audit: no R2 bucket ${name} (enable files in ember.json, or set config.bucket; archive: false only deletes)`);
  }
  return b;
}

export type AuditEntry = {
  _id: string;
  _creationTime: number;
  table: string;
  docId: string;
  op: AuditOp;
  actor: string;
  at: number;
  diff?: Record<string, { from?: unknown; to?: unknown }>;
  action?: string;
  data?: unknown;
  truncated?: boolean;
  omitted?: number;
};

const listArgs = {
  /** Rows of this table (with `docId`: of this document). */
  table: v.optional(v.string()),
  docId: v.optional(v.string()),
  actor: v.optional(v.string()),
  op: v.optional(vOp),
  /** `at` ≥ from (ms). */
  from: v.optional(v.number()),
  /** `at` < to (ms). */
  to: v.optional(v.number()),
  paginationOpts: paginationOptsValidator,
};
type ListArgs = { table?: string; docId?: string; actor?: string; op?: AuditOp; from?: number; to?: number; paginationOpts: { numItems: number; cursor: string | null } };

type Range = { gte(f: "at", v: number): Range; lt(f: "at", v: number): Range };
/** `at` bounds on an index whose last field is `at` (after its equalities). */
function atRange<Q extends object>(q: Q, a: ListArgs): Q {
  let r = q as unknown as Range;
  if (a.from !== undefined) r = r.gte("at", a.from);
  if (a.to !== undefined) r = r.lt("at", a.to);
  return r as unknown as Q;
}

/**
 * Newest first, through one index range: (table, docId) → `by_table_doc`; actor → `by_actor`; table alone →
 * `by_table_doc` (grouped by document, newest first within each); otherwise `by_at`. The other filters run on the rows
 * of that range.
 */
function list(ctx: QCtx, a: ListArgs) {
  const t = ctx.db.query("entries");
  let q;
  let used: "doc" | "actor" | "table" | "at";
  if (a.table !== undefined && a.docId !== undefined) {
    used = "doc";
    q = t.withIndex("by_table_doc", (r) => atRange(r.eq("table", a.table!).eq("docId", a.docId!), a));
  } else if (a.actor !== undefined) {
    used = "actor";
    q = t.withIndex("by_actor", (r) => atRange(r.eq("actor", a.actor!), a));
  } else if (a.table !== undefined) {
    used = "table";
    q = t.withIndex("by_table_doc", (r) => r.eq("table", a.table!));
  } else {
    used = "at";
    q = t.withIndex("by_at", (r) => atRange(r, a));
  }
  let o = q.order("desc");
  // Every filter the index range did not take (each `true` when absent): a filter given is always applied.
  const op = a.op;
  const table = used === "actor" ? a.table : undefined;
  const docId = used !== "doc" ? a.docId : undefined;
  const actor = used !== "actor" ? a.actor : undefined;
  const from = used === "table" ? a.from : undefined;
  const to = used === "table" ? a.to : undefined;
  if (op !== undefined || table !== undefined || docId !== undefined || actor !== undefined || from !== undefined || to !== undefined) {
    o = o.filter((f) =>
      f.and(
        op !== undefined ? f.eq(f.field("op"), op) : true,
        table !== undefined ? f.eq(f.field("table"), table) : true,
        docId !== undefined ? f.eq(f.field("docId"), docId) : true,
        actor !== undefined ? f.eq(f.field("actor"), actor) : true,
        from !== undefined ? f.gte(f.field("at"), from) : true,
        to !== undefined ? f.lt(f.field("at"), to) : true,
      ),
    );
  }
  return o.paginate(a.paginationOpts);
}

const archiveRef = "lib:archive";
const claimRef = unsafeRef<"mutation">("lib:claim");
const rowsRef = unsafeRef<"query">("lib:batchRows");
const commitRef = unsafeRef<"mutation">("lib:commit");

type Batch = { _id: string; key: string; count: number; firstAt: number; lastAt: number };
export type ArchiveRunResult = { batch: string | null; key: string | null; archived: number; deleted: number; more: boolean; skippedPut: boolean };

/** One batch: claim (or resume) → write the object unless it is already there → delete its rows. */
async function archiveOnce(ctx: ActCtx): Promise<ArchiveRunResult> {
  const cfg = ctx.component.config;
  const cutoff = ctx.now - retainDaysOf(cfg) * DAY;
  const batch = (await ctx.runMutation(claimRef, { cutoff, limit: batchSizeOf(cfg) })) as Batch | null;
  if (!batch) return { batch: null, key: null, archived: 0, deleted: 0, more: false, skippedPut: false };
  let bytes = 0;
  let skippedPut = false;
  let archived = 0;
  if (cfg?.archive !== false) {
    const bucket = bucketOf(ctx);
    const there = await bucket.head(batch.key);
    if (there) {
      // A run before this one wrote the object and stopped before the delete: only the delete is left.
      skippedPut = true;
      bytes = there.size;
      archived = Number(there.customMetadata?.count ?? batch.count);
    } else {
      const rows = (await ctx.runQuery(rowsRef, { id: batch._id })) as AuditEntry[] | null;
      if (rows === null) {
        // Another run (the cron's job and the dashboard's "archive now", or a job recovered while the first one was
        // still alive) archived this batch between our `head` and now: its object is written and its rows are gone.
        // Writing now would replace that object with an empty one.
        return { batch: batch._id, key: batch.key, archived: 0, deleted: 0, more: false, skippedPut: true };
      }
      const body = await gzipNdjson(rows);
      await bucket.put(batch.key, body, {
        httpMetadata: { contentType: "application/x-ndjson", contentEncoding: "gzip" },
        customMetadata: { count: String(rows.length), firstAt: String(batch.firstAt), lastAt: String(batch.lastAt), batch: batch._id },
      });
      // `put` resolved: the object is written (R2 writes are atomic and strongly consistent).
      bytes = body.byteLength;
      archived = rows.length;
    }
  }
  const r = (await ctx.runMutation(commitRef, { id: batch._id, bytes })) as { deleted: number; more: boolean };
  return { batch: batch._id, key: cfg?.archive === false ? null : batch.key, archived, deleted: r.deleted, more: r.more, skippedPut };
}

export const functions = {
  lib: {
    /** One audited write (what `auditTriggers` calls, in the caller's transaction). The actor is the caller's identity. */
    record: mutation({
      args: { table: v.string(), docId: v.string(), op: v.union(v.literal("insert"), v.literal("update"), v.literal("delete")), diff: v.any(), truncated: v.optional(v.boolean()), omitted: v.optional(v.number()) },
      handler: (ctx, a): string =>
        ctx.db.insert("entries", {
          table: a.table,
          docId: a.docId,
          op: a.op,
          actor: actorOf(ctx),
          at: ctx.now,
          diff: a.diff,
          ...(a.truncated ? { truncated: true } : {}),
          ...(a.omitted ? { omitted: a.omitted } : {}),
        }),
    }),
    /** An app-level event (`audit.log(ctx, { action, target, data })`). `actor` defaults to the caller's identity. */
    log: mutation({
      args: { action: v.string(), target: v.optional(v.string()), data: v.optional(v.any()), actor: v.optional(v.string()) },
      handler: (ctx, a): string =>
        ctx.db.insert("entries", {
          table: "",
          docId: a.target ?? "",
          op: "log",
          actor: a.actor ?? actorOf(ctx),
          at: ctx.now,
          action: a.action,
          ...(a.data !== undefined ? { data: a.data } : {}),
        }),
    }),
    /** Rows in this shard, newest first, paginated; filters by table/document, actor, op and time. */
    list: query({ args: listArgs, handler: (ctx, a): PaginationResult<AuditEntry> => list(ctx, a as ListArgs) as unknown as PaginationResult<AuditEntry> }),
    /** One row (the dashboard's detail). */
    get: query({
      args: { id: v.string() },
      handler: (ctx, a): AuditEntry | null => {
        const id = ctx.db.normalizeId("entries", a.id);
        return id ? (ctx.db.get(id) as AuditEntry | null) : null;
      },
    }),
    /** The archive objects in R2 (this install's prefix), a page at a time. */
    archives: action({
      args: { cursor: v.optional(v.string()), limit: v.optional(v.number()) },
      handler: async (ctx, a) => {
        const page = await bucketOf(ctx).list({ prefix: `${prefixOf(ctx)}/`, limit: Math.max(1, Math.min(1000, Math.floor(a.limit ?? 100))), include: ["customMetadata"], ...(a.cursor ? { cursor: a.cursor } : {}) });
        return {
          objects: page.objects.map((o) => ({ key: o.key, size: o.size, uploaded: o.uploaded.getTime(), count: Number(o.customMetadata?.count ?? 0), firstAt: Number(o.customMetadata?.firstAt ?? 0), lastAt: Number(o.customMetadata?.lastAt ?? 0) })),
          cursor: page.truncated ? (page.cursor ?? null) : null,
        };
      },
    }),
    /**
     * The cron (and its continuations): archives one batch of rows older than `retainDays` in this shard; the delete
     * schedules the next batch while old rows remain. With `fanOut` (the cron's own run) it also starts the archive on
     * every shard of `config.shardKinds`.
     */
    archive: internalAction({
      args: { fanOut: v.optional(v.boolean()) },
      handler: async (ctx, a): Promise<ArchiveRunResult & { shards: number }> => {
        let shards = 0;
        if (a.fanOut) {
          for (const kind of ctx.component.config?.shardKinds ?? []) {
            let cursor: string | null = null;
            do {
              const page: { shards: Array<{ shard: string }>; next: string | null } = await ctx.shards.list(kind, { cursor, limit: 1000 });
              for (const s of page.shards) {
                if (s.shard === ctx.shard) continue;
                await ctx.onShard(s.shard).scheduler.runAfter(0, archiveRef, {});
                shards++;
              }
              cursor = page.next;
            } while (cursor);
          }
        }
        return { ...(await archiveOnce(ctx)), shards };
      },
    }),
    /** Names the next batch (or returns the pending one: a run that stopped resumes it). */
    claim: internalMutation({
      args: { cutoff: v.number(), limit: v.number() },
      handler: (ctx, a) => {
        const pending = ctx.db.query("batches").withIndex("by_state", (q) => q.eq("state", "pending")).first();
        if (pending) return { _id: pending._id, key: pending.key, count: pending.count, firstAt: pending.firstAt, lastAt: pending.lastAt };
        const rows = ctx.db.query("entries").withIndex("by_at", (q) => q.lt("at", a.cutoff)).take(a.limit);
        if (!rows.length) return null;
        const first = rows[0]!;
        const last = rows[rows.length - 1]!;
        const name = `${first.at}-${Math.floor(ctx.random() * 0xffffffff).toString(16).padStart(8, "0")}`;
        const key = archiveKey(prefixOf(ctx), first.at, name);
        const id = ctx.db.insert("batches", { key, state: "pending", ids: rows.map((r) => r._id), count: rows.length, firstAt: first.at, lastAt: last.at, cutoff: a.cutoff, at: ctx.now });
        return { _id: id, key, count: rows.length, firstAt: first.at, lastAt: last.at };
      },
    }),
    /** The rows of a pending batch, oldest first; null once it is archived (or gone): there is nothing to write. */
    batchRows: internalQuery({
      args: { id: v.id("batches") },
      handler: (ctx, a) => {
        const b = ctx.db.get(a.id);
        if (!b || b.state !== "pending") return null;
        return (b.ids ?? []).map((id) => ctx.db.get(id as GenericId<"entries">)).filter((r) => r !== null);
      },
    }),
    /** Deletes a batch's rows once its object exists; idempotent (a batch already archived does nothing). */
    commit: internalMutation({
      args: { id: v.id("batches"), bytes: v.number() },
      handler: (ctx, a) => {
        const b = ctx.db.get(a.id);
        if (!b || b.state !== "pending") return { deleted: 0, more: false };
        let deleted = 0;
        for (const id of b.ids ?? []) {
          const eid = id as GenericId<"entries">;
          if (!ctx.db.get(eid)) continue;
          ctx.db.delete(eid);
          deleted++;
        }
        ctx.db.patch(a.id, { state: "archived", ids: undefined, archivedAt: ctx.now, bytes: a.bytes });
        const more = ctx.db.query("entries").withIndex("by_at", (q) => q.lt("at", b.cutoff)).first() !== null;
        if (more) ctx.scheduler.runAfter(0, archiveRef, {});
        return { deleted, more };
      },
    }),
    /** One archive's rows (`offset`/`limit`, at most 500): for the dashboard and admin tooling only. */
    readArchive: internalAction({
      args: { key: v.string(), offset: v.optional(v.number()), limit: v.optional(v.number()) },
      handler: async (ctx, a) => {
        if (!a.key.startsWith(`${prefixOf(ctx)}/`) || a.key.includes("..")) throw new EmberError("ValidationError", `audit: ${a.key} is not an archive of this install`);
        const obj = await bucketOf(ctx).get(a.key);
        if (!obj) throw new EmberError("NotFound", `audit: no archive ${a.key}`);
        const rows = await gunzipNdjson(await obj.arrayBuffer());
        const offset = Math.max(0, Math.floor(a.offset ?? 0));
        const limit = Math.max(1, Math.min(500, Math.floor(a.limit ?? 100)));
        return { key: a.key, total: rows.length, offset, entries: rows.slice(offset, offset + limit), next: offset + limit < rows.length ? offset + limit : null };
      },
    }),
  },
};

/** What only the dashboard reads and runs (`@<install>/dashboard:*`, internal). */
export const dashboardFunctions = {
  /** Archive batches, newest first (what moved to R2 from this shard, and a pending one). */
  batches: internalQuery({
    args: { paginationOpts: paginationOptsValidator },
    handler: (ctx, a) => {
      const page = ctx.db.query("batches").withIndex("by_at").order("desc").paginate(a.paginationOpts);
      return { ...page, page: page.page.map(({ ids: _ids, ...b }) => b) };
    },
  }),
  /** Counts for the header: rows here (up to 10 000) and the oldest one. */
  stats: internalQuery({
    args: {},
    handler: (ctx) => {
      const n = ctx.db.query("entries").withIndex("by_at").take(10_001).length;
      const oldest = ctx.db.query("entries").withIndex("by_at").first();
      const pending = ctx.db.query("batches").withIndex("by_state", (q) => q.eq("state", "pending")).first();
      return { rows: n > 10_000 ? "10000+" : n, oldest: oldest?.at ?? null, retainDays: retainDaysOf(ctx.component.config), pending: pending ? pending.key : null };
    },
  }),
  archiveNow: internalAction({ args: {}, handler: (ctx) => archiveOnce(ctx) }),
};

export const audit = defineComponent({
  name: "audit",
  schema,
  functions: { ...functions, dashboard: dashboardFunctions },
  config: v.optional(installConfigValidator),
  crons: (config) => cronJobs({ shard: config?.shard ?? "global:main" }).daily("archive", { hour: Math.max(0, Math.min(23, Math.floor(config?.hour ?? 3))) }, archiveRef, { fanOut: true }),
  dashboard: {
    label: "Audit log",
    icon: "shield",
    description: "Who changed what in this shard: one row per audited write, written in the same transaction. Rows older than the retention move to R2 as gzip NDJSON.",
    tabs: [
      {
        id: "entries",
        label: "Entries",
        blocks: [
          {
            kind: "stats",
            id: "stats",
            query: dashboardFunctions.stats,
            items: [
              { label: "Rows here", path: "rows", format: "number" },
              { label: "Oldest", path: "oldest", format: "ago" },
              { label: "Retention (days)", path: "retainDays", format: "number" },
              { label: "Pending batch", path: "pending", format: "code" },
            ],
          },
          {
            kind: "table",
            id: "entries",
            query: functions.lib.list,
            filters: ["table", "actor", "op", "docId"],
            columns: [
              { label: "When", path: "at", format: "date" },
              { label: "Table", path: "table", format: "code" },
              { label: "Document", path: "docId", format: "code" },
              { label: "Op", path: "op", format: "badge" },
              { label: "Actor", path: "actor", format: "code" },
              { label: "Action", path: "action" },
            ],
            detail: {
              query: functions.lib.get,
              fromRow: { id: "_id" },
              sections: [
                { kind: "kv", items: [{ label: "Table", path: "table", format: "code" }, { label: "Document", path: "docId", format: "code" }, { label: "Op", path: "op", format: "badge" }, { label: "Actor", path: "actor", format: "code" }, { label: "At", path: "at", format: "date" }, { label: "Truncated", path: "truncated", format: "boolean" }] },
                { kind: "json", path: "diff" },
                { kind: "json", path: "data" },
              ],
            },
          },
        ],
      },
      {
        id: "archives",
        label: "Archives",
        blocks: [
          {
            kind: "table",
            id: "batches",
            query: dashboardFunctions.batches,
            columns: [
              { label: "Key", path: "key", format: "code" },
              { label: "State", path: "state", format: "badge" },
              { label: "Rows", path: "count", format: "number" },
              { label: "From", path: "firstAt", format: "date" },
              { label: "To", path: "lastAt", format: "date" },
              { label: "Size", path: "bytes", format: "bytes" },
              { label: "Archived", path: "archivedAt", format: "ago" },
            ],
            rowActions: [{ id: "read", label: "Read", fn: functions.lib.readArchive, fromRow: { key: "key" }, description: "The first rows of the archive." }],
          },
          {
            kind: "actions",
            id: "run",
            actions: [{ id: "archiveNow", label: "Archive one batch now", fn: dashboardFunctions.archiveNow, description: "Moves the oldest rows past the retention to R2 (one batch; more follow through the scheduler)." }],
          },
        ],
      },
    ],
  },
});
