// The sentry component (PLAN §12; contracts.md "Sentry"): error tracking over the Sentry Envelope API.
//
//   POST /<mount>/api/<project>/envelope/  (httpAction, no shard call) ─ auth, rate limit, sampling, size caps
//       events → the component's Queue `events` · attachments, replays → R2 · sessions, transactions → Analytics Engine
//   queue `events` (batches of up to 100) ─ consumer.ts: symbolicate, fingerprint, group;
//       one R2 object per batch; `lib:apply`: one insert or patch per issue; alerts → one `lib:deliver` job
//   POST /<mount>/admin/sourcemaps, PUT /<mount>/admin/sourcemaps/blobs/<sha256> ─ source maps per release (the CLI)
//   cron `retention` (daily) ─ deletes R2 date prefixes older than `retentionDays`, in bounded batches

import { componentBuilders, cronJobs, defineComponent, defineSchema, defineTable, EmberError, httpRouter, paginationOptsValidator, unsafeRef, v, type ComponentCtx, type DataModelFromSchema } from "@freecorps/ember-server";
import { alertValidator, postWebhook, type SentryAlert } from "./alerts.ts";
import { alertsFor, analyticsBinding, checkConfig, DEFAULT_DATASET, DEFAULT_MAX_ALERTS_PER_HOUR, DEFAULT_RETENTION_DAYS, DEFAULT_THROTTLE_MINUTES, installConfigValidator, MiB, queueOf, r2Of, shardOf, type SentryInstallConfig } from "./config.ts";
import { artifactKey, consume, debugKey, LOOKUP_LIMITS, type ArtifactLookup, type IssueGroup } from "./consumer.ts";
import { decodeBody, EnvelopeError, readCapped, utf8 } from "./envelope.ts";
import { eventId, type SentryEvent } from "./event.ts";
import { handleIngest, queueMessage, type QueuedEvent } from "./ingest.ts";
import { EVENT_PAGE, EVENT_PAGE_ROUTE } from "./page.ts";
import { keys, putGzip, readEvent, sweepExpired } from "./storage.ts";
import { normalizeDebugId } from "./sourcemap.ts";

const status = v.union(v.literal("unresolved"), v.literal("resolved"), v.literal("ignored"));
const pointer = v.object({ key: v.string(), offset: v.number(), length: v.number() });

const schema = defineSchema({
  tables: {
    /** One row per (project, fingerprint): written once per consumer batch that has events of it. */
    issues: defineTable({
      project: v.string(),
      fingerprint: v.string(),
      title: v.string(),
      culprit: v.string(),
      level: v.string(),
      status,
      count: v.number(),
      firstSeen: v.number(),
      lastSeen: v.number(),
      /** Release of the latest event ("" when none). */
      release: v.string(),
      firstRelease: v.string(),
      environment: v.string(),
      platform: v.string(),
      lastEventId: v.string(),
      /** Where the latest event is in R2 (its gzip member in the batch object). */
      lastEvent: v.optional(pointer),
      /** The latest event's stack as text, symbolicated (capped at 16 KiB). */
      stack: v.string(),
      /** Events per hour, the last 24 hours; `hourlyAt` is the hour (ms / 3.6e6) of the last slot. */
      hourly: v.array(v.number()),
      hourlyAt: v.number(),
      /** Spike window: start and events in it. */
      spikeStart: v.optional(v.number()),
      spikeCount: v.optional(v.number()),
      resolvedAt: v.optional(v.number()),
      regressedAt: v.optional(v.number()),
      /** Last regression / spike alert (the per-issue throttle). */
      alertedAt: v.optional(v.number()),
    })
      .index("by_fingerprint", ["project", "fingerprint"])
      .index("by_seen", ["lastSeen"])
      .index("by_status_seen", ["status", "lastSeen"])
      .index("by_release_seen", ["release", "lastSeen"]),
    /** Alerts sent per project in the current hour (the per-project throttle); written only when an alert fires. */
    alertState: defineTable({ project: v.string(), hourStart: v.number(), sent: v.number(), suppressed: v.number() }).index("by_project", ["project"]),
    /** Source maps per release: the artifact name frames are matched by (`~/assets/app.js`) and the map's content hash. */
    artifacts: defineTable({ project: v.string(), release: v.string(), dist: v.string(), name: v.string(), sha256: v.string(), size: v.number(), debugId: v.optional(v.string()), uploadedAt: v.number() })
      .index("by_name", ["project", "release", "dist", "name"])
      .index("by_debug_id", ["project", "debugId"], { sparse: true }),
    releases: defineTable({ project: v.string(), release: v.string(), dist: v.string(), files: v.number(), bytes: v.number(), firstUploadAt: v.number(), lastUploadAt: v.number() })
      .index("by_key", ["project", "release", "dist"])
      .index("by_uploaded", ["lastUploadAt"]),
  },
});

type Config = SentryInstallConfig;
const { query, mutation, internalQuery, internalMutation, action, internalAction, httpAction } = componentBuilders<typeof schema, Config>();
type DM = DataModelFromSchema<typeof schema>;
type Issue = DM["issues"]["document"];
type MCtx = ComponentCtx<typeof schema, Config>["mutation"];
type ACtx = ComponentCtx<typeof schema, Config>["action"];

const HOUR = 3_600_000;
const HOURS = 24;
const MAX_MAP_BYTES = 64 * MiB;
const ref = {
  apply: unsafeRef<"mutation">("lib:apply"),
  findArtifacts: unsafeRef<"query">("lib:findArtifacts"),
  register: unsafeRef<"mutation">("lib:registerArtifacts"),
  consume: unsafeRef<"action">("lib:consume"),
  deliver: unsafeRef<"action">("lib:deliver"),
  retention: unsafeRef<"action">("lib:retention"),
};

/** `hourly` shifted so its last slot is `hour`, then `n` added there. */
export function bumpHourly(hourly: readonly number[], at: number, hour: number, n: number): number[] {
  const out = Array.from({ length: HOURS }, (_, i) => hourly[i - (HOURS - hourly.length)] ?? 0);
  const shift = Math.max(0, hour - at);
  const moved = shift >= HOURS ? new Array<number>(HOURS).fill(0) : [...out.slice(shift), ...new Array<number>(shift).fill(0)];
  moved[HOURS - 1]! += n;
  return moved;
}

const groupValidator = v.object({
  project: v.string(),
  fingerprint: v.string(),
  n: v.number(),
  firstSeen: v.number(),
  lastSeen: v.number(),
  title: v.string(),
  culprit: v.string(),
  level: v.string(),
  release: v.string(),
  environment: v.string(),
  platform: v.string(),
  eventId: v.string(),
  stack: v.string(),
  pointer: v.optional(pointer),
});
const lookupValidator = v.object({ project: v.string(), release: v.string(), dist: v.string(), names: v.array(v.string()), debugIds: v.array(v.string()) });

/** Per-project alert budget for this hour; true when one more may be sent (written only when an alert fires). */
function takeAlertBudget(ctx: MCtx, project: string, max: number, now: number): boolean {
  const hourStart = Math.floor(now / HOUR) * HOUR;
  const row = ctx.db.query("alertState").withIndex("by_project", (q) => q.eq("project", project)).first();
  if (!row) {
    // The first alert of the project goes by the same cap (`maxPerHour: 0` sends none).
    const allowed = max > 0;
    ctx.db.insert("alertState", { project, hourStart, sent: allowed ? 1 : 0, suppressed: allowed ? 0 : 1 });
    return allowed;
  }
  const fresh = row.hourStart !== hourStart;
  const sent = fresh ? 0 : row.sent;
  if (sent >= max) {
    ctx.db.patch(row._id, { suppressed: (fresh ? 0 : row.suppressed) + 1 });
    return false;
  }
  ctx.db.patch(row._id, fresh ? { hourStart, sent: 1, suppressed: 0 } : { sent: sent + 1 });
  return true;
}

/** `lib:apply`: one statement per issue of the batch (an insert, or a patch), and the alerts that state change asks for. */
function applyGroups(ctx: MCtx, groups: readonly IssueGroup[]): { issues: number; created: number; alerts: number } {
  const config = ctx.component.config;
  const now = ctx.now;
  const hour = Math.floor(now / HOUR);
  const alerts: SentryAlert[] = [];
  let created = 0;
  for (const g of groups) {
    const cfg = alertsFor(config, g.project);
    const throttle = (cfg?.throttleMinutes ?? DEFAULT_THROTTLE_MINUTES) * 60_000;
    const existing = ctx.db.query("issues").withIndex("by_fingerprint", (q) => q.eq("project", g.project).eq("fingerprint", g.fingerprint)).first();
    const latest = (x: Issue | null) => !x || g.lastSeen >= x.lastSeen;
    const fields = {
      title: g.title,
      culprit: g.culprit,
      level: g.level,
      release: g.release,
      environment: g.environment,
      platform: g.platform,
      lastEventId: g.eventId,
      stack: g.stack,
      ...(g.pointer ? { lastEvent: g.pointer } : {}),
    };
    let kind: SentryAlert["kind"] | null = null;
    let doc: Omit<Issue, "_id" | "_creationTime">;
    if (!existing) {
      created++;
      doc = { project: g.project, fingerprint: g.fingerprint, ...fields, status: "unresolved", count: g.n, firstSeen: g.firstSeen, lastSeen: g.lastSeen, firstRelease: g.release, hourly: bumpHourly([], hour, hour, g.n), hourlyAt: hour };
      if (cfg && cfg.newIssue !== false) kind = "new";
    } else {
      const { _id, _creationTime, ...rest } = existing;
      doc = { ...rest, ...(latest(existing) ? fields : {}), count: existing.count + g.n, firstSeen: Math.min(existing.firstSeen, g.firstSeen), lastSeen: Math.max(existing.lastSeen, g.lastSeen), hourly: bumpHourly(existing.hourly, existing.hourlyAt, hour, g.n), hourlyAt: Math.max(hour, existing.hourlyAt) };
      // The latest event's pointer comes with its id: a newer event stored nowhere (no bucket) leaves none.
      if (latest(existing) && !g.pointer) delete doc.lastEvent;
      if (existing.status === "resolved") {
        // A regression: seen again after it was resolved.
        doc.status = "unresolved";
        doc.regressedAt = now;
        delete doc.resolvedAt;
        if (cfg && cfg.regression !== false && !(existing.alertedAt !== undefined && now - existing.alertedAt < throttle)) kind = "regression";
      }
    }
    // Spike: N events inside the window; one alert per window (and per throttle).
    const spike = cfg?.spike;
    if (spike && doc.status !== "ignored") {
      const windowMs = spike.windowMinutes * 60_000;
      const start = doc.spikeStart !== undefined && now - doc.spikeStart < windowMs ? doc.spikeStart : now;
      const before = start === doc.spikeStart ? (doc.spikeCount ?? 0) : 0;
      doc.spikeStart = start;
      doc.spikeCount = before + g.n;
      const crossed = before < spike.events && doc.spikeCount >= spike.events;
      if (!kind && crossed && !(doc.alertedAt !== undefined && now - doc.alertedAt < throttle)) kind = "spike";
    }
    if (doc.status === "ignored") kind = null;
    if (kind && cfg && takeAlertBudget(ctx, g.project, cfg.maxPerHour ?? DEFAULT_MAX_ALERTS_PER_HOUR, now)) {
      if (kind !== "new") doc.alertedAt = now;
    } else kind = null;
    let id: string;
    if (existing) {
      // One write: the whole row (fields that left it, like resolvedAt, cleared).
      ctx.db.replace(existing._id, doc);
      id = existing._id;
    } else id = ctx.db.insert("issues", doc);
    if (kind)
      alerts.push({
        kind,
        project: g.project,
        issueId: id,
        title: doc.title,
        culprit: doc.culprit,
        level: doc.level,
        count: doc.count,
        ...(kind === "spike" && spike ? { windowCount: doc.spikeCount!, windowMinutes: spike.windowMinutes } : {}),
        release: doc.release,
        environment: doc.environment,
        firstSeen: doc.firstSeen,
        lastSeen: doc.lastSeen,
        at: now,
      });
  }
  if (alerts.length) ctx.scheduler.runAfter(0, ref.deliver, { alerts });
  return { issues: groups.length, created, alerts: alerts.length };
}

async function consumeIn(ctx: ACtx, messages: readonly QueuedEvent[], queue?: { committed(indexes: readonly number[]): void; retry(indexes: readonly number[]): void }) {
  const config = ctx.component.config;
  const shard = ctx.onShard(shardOf(config));
  return consume(
    {
      install: ctx.component.name,
      config,
      env: ctx.env,
      now: ctx.now,
      findArtifacts: (lookups) => shard.runQuery(ref.findArtifacts, { lookups }) as Promise<Record<string, string>>,
      apply: (groups) => shard.runMutation(ref.apply, { groups }) as Promise<{ issues: number; created: number; alerts: number }>,
      ...(queue ? { committed: queue.committed, retry: queue.retry } : {}),
    },
    messages,
  );
}

const issueRow = (i: Issue) => ({
  _id: i._id,
  project: i.project,
  title: i.title,
  culprit: i.culprit,
  level: i.level,
  status: i.status,
  count: i.count,
  firstSeen: i.firstSeen,
  lastSeen: i.lastSeen,
  release: i.release || null,
});

const lib = {
  /** Resolve, ignore or reopen an issue (the dashboard's row actions; the app may call it too). */
  setStatus: mutation({
    args: { id: v.string(), status },
    handler: (ctx, a) => {
      const id = ctx.db.normalizeId("issues", a.id);
      const issue = id ? ctx.db.get(id) : null;
      if (!issue) throw new EmberError("NotFound", `sentry: no issue ${a.id}`);
      if (issue.status === a.status) return issue.status;
      const { _id, _creationTime, ...rest } = issue;
      const doc = { ...rest, status: a.status };
      if (a.status === "resolved") doc.resolvedAt = ctx.now;
      else delete doc.resolvedAt;
      ctx.db.replace(issue._id, doc);
      return a.status;
    },
  }),
  /** An issue by id (the app's own screens), or null. */
  issue: query({
    args: { id: v.string() },
    handler: (ctx, a) => {
      const id = ctx.db.normalizeId("issues", a.id);
      const i = id ? ctx.db.get(id) : null;
      return i ? { ...issueRow(i), fingerprint: i.fingerprint, environment: i.environment, platform: i.platform, firstRelease: i.firstRelease, lastEventId: i.lastEventId, stack: i.stack } : null;
    },
  }),
  /** Captures an error or a whole event from the app's actions (`sentryCapture`): straight to the queue, no shard write. */
  capture: action({
    args: { project: v.optional(v.string()), event: v.any() },
    handler: async (ctx, a) => {
      const config = ctx.component.config;
      const project = a.project ?? config.projects[0]?.id;
      if (!project || !config.projects.some((p) => p.id === project)) throw new EmberError("ValidationError", `sentry: unknown project ${JSON.stringify(project)}`);
      const ev = a.event as SentryEvent;
      if (!ev || typeof ev !== "object") throw new EmberError("ValidationError", "sentry: event must be an object");
      const id = typeof ev.event_id === "string" ? ev.event_id : eventId();
      // The same budget as ingest: inline up to INLINE_EVENT_MAX bytes, else spilled to R2, else refused.
      const msg = await queueMessage(ctx.component.name, r2Of(ctx.env, config), project, id, { ...ev, event_id: id }, Date.now());
      if (!msg) throw new EmberError("ValidationError", "sentry: event too large for a queue message (no R2 bucket to spill it to)");
      const q = queueOf(ctx.env, ctx.component.name);
      if (q) await q.send(msg, { contentType: "json" });
      else await consumeIn(ctx, [msg]);
      return id;
    },
  }),
  /** The latest event of an issue, read back from R2 (symbolicated, with breadcrumbs and contexts), or null. */
  latestEvent: action({
    args: { id: v.string() },
    handler: async (ctx, a): Promise<unknown> => {
      const config = ctx.component.config;
      const issue = (await ctx.onShard(shardOf(config)).runQuery(unsafeRef<"query">("lib:issuePointer"), { id: a.id })) as { lastEvent?: { key: string; offset: number; length: number } } | null;
      const bucket = r2Of(ctx.env, config);
      if (!issue?.lastEvent || !bucket) return null;
      return readEvent(bucket, issue.lastEvent);
    },
  }),
  issuePointer: internalQuery({
    args: { id: v.string() },
    handler: (ctx, a) => {
      const id = ctx.db.normalizeId("issues", a.id);
      const i = id ? ctx.db.get(id) : null;
      return i ? { lastEvent: i.lastEvent ?? null } : null;
    },
  }),
  apply: internalMutation({ args: { groups: v.array(groupValidator) }, handler: (ctx, a) => applyGroups(ctx, a.groups) }),
  /**
   * sha256 of the maps a batch needs: `artifactKey` and `debugKey` keys, both within the event's project (a debug id
   * never resolves to another project's map). Bounded per call (the consumer splits a batch's lookups to fit:
   * `chunkLookups`); a bigger call is refused, not cut short.
   */
  findArtifacts: internalQuery({
    args: { lookups: v.array(lookupValidator) },
    handler: (ctx, a) => {
      const out: Record<string, string> = {};
      const lookups = a.lookups as ArtifactLookup[];
      if (lookups.length > LOOKUP_LIMITS.lookups || lookups.some((l) => l.names.length > LOOKUP_LIMITS.names || l.debugIds.length > LOOKUP_LIMITS.debugIds)) {
        throw new EmberError("ValidationError", `sentry: findArtifacts takes at most ${LOOKUP_LIMITS.lookups} lookups of ${LOOKUP_LIMITS.names} names and ${LOOKUP_LIMITS.debugIds} debug ids`);
      }
      for (const l of lookups) {
        for (const name of l.names) {
          for (const dist of l.dist ? [l.dist, ""] : [""]) {
            const hit = ctx.db.query("artifacts").withIndex("by_name", (q) => q.eq("project", l.project).eq("release", l.release).eq("dist", dist).eq("name", name)).first();
            if (hit) {
              out[artifactKey(l.project, l.release, dist, name)] = hit.sha256;
              break;
            }
          }
        }
        for (const id of l.debugIds) {
          const hit = ctx.db.query("artifacts").withIndex("by_debug_id", (q) => q.eq("project", l.project).eq("debugId", id)).first();
          if (hit) out[debugKey(l.project, id)] = hit.sha256;
        }
      }
      return out;
    },
  }),
  /** Registers uploaded maps of a release (the upload route, after every blob is in R2). */
  registerArtifacts: internalMutation({
    args: { project: v.string(), release: v.string(), dist: v.string(), files: v.array(v.object({ name: v.string(), sha256: v.string(), size: v.number(), debugId: v.optional(v.string()) })) },
    handler: (ctx, a) => {
      let added = 0;
      let bytes = 0;
      for (const f of a.files) {
        const prev = ctx.db.query("artifacts").withIndex("by_name", (q) => q.eq("project", a.project).eq("release", a.release).eq("dist", a.dist).eq("name", f.name)).first();
        const row = { project: a.project, release: a.release, dist: a.dist, name: f.name, sha256: f.sha256, size: f.size, ...(f.debugId ? { debugId: f.debugId } : {}), uploadedAt: ctx.now };
        if (prev?.sha256 === f.sha256 && prev.debugId === f.debugId) continue;
        if (prev) ctx.db.replace(prev._id, row);
        else {
          ctx.db.insert("artifacts", row);
          added++;
        }
        bytes += f.size - (prev?.size ?? 0);
      }
      const rel = ctx.db.query("releases").withIndex("by_key", (q) => q.eq("project", a.project).eq("release", a.release).eq("dist", a.dist)).first();
      if (rel) ctx.db.patch(rel._id, { files: rel.files + added, bytes: rel.bytes + bytes, lastUploadAt: ctx.now });
      else ctx.db.insert("releases", { project: a.project, release: a.release, dist: a.dist, files: added, bytes, firstUploadAt: ctx.now, lastUploadAt: ctx.now });
      return { added, files: a.files.length };
    },
  }),
  /** The consumer, inline: ingest without the queue binding, and `capture` without it. */
  consume: internalAction({ args: { messages: v.array(v.any()) }, handler: (ctx, a) => consumeIn(ctx, a.messages as QueuedEvent[]) }),
  /** Delivers alerts decided by `lib:apply`: signed webhooks, then the app's handler mutation. */
  deliver: internalAction({
    args: { alerts: v.array(alertValidator) },
    handler: async (ctx, a) => {
      let sent = 0;
      for (const alert of a.alerts) {
        const cfg = alertsFor(ctx.component.config, alert.project);
        if (!cfg) continue;
        for (const w of cfg.webhooks ?? []) {
          const secret = w.secretEnv ? (ctx.env[w.secretEnv] as string | undefined) : undefined;
          const s = await postWebhook(w.url, alert, secret, Date.now());
          if (s >= 200 && s < 300) sent++;
          else console.error(`ember-sentry: webhook ${w.url} answered ${s}`);
        }
        if (cfg.handler) {
          try {
            await ctx.runMutation(unsafeRef<"mutation">(cfg.handler.startsWith("&") ? cfg.handler : `&${cfg.handler}`), { alert });
            sent++;
          } catch (e) {
            console.error(`ember-sentry: alert handler ${cfg.handler} failed: ${(e as Error).message}`);
          }
        }
      }
      return sent;
    },
  }),
  /** Daily: deletes expired R2 date prefixes (at most 5000 objects per run; a backlog runs again right away). */
  retention: internalAction({
    args: {},
    handler: async (ctx) => {
      const config = ctx.component.config;
      const bucket = r2Of(ctx.env, config);
      if (!bucket) return { deleted: 0, prefixes: [], more: false };
      const r = await sweepExpired(bucket, ctx.component.name, ctx.now, config.retentionDays ?? DEFAULT_RETENTION_DAYS);
      if (r.more) await ctx.scheduler.runAfter(0, ref.retention, {});
      return r;
    },
  }),
};

const issueFilters = { status: v.optional(status), level: v.optional(v.string()), release: v.optional(v.string()), project: v.optional(v.string()) };

/** What the dashboard's screen reads (module `dashboard`, internal). Each page is a range of an index. */
const dashboard = {
  /** Issues, last seen first: one release or one status by their index, the other filters within that range. */
  issues: internalQuery({
    args: { ...issueFilters, paginationOpts: paginationOptsValidator },
    handler: (ctx, a) => {
      const base =
        a.release !== undefined
          ? ctx.db.query("issues").withIndex("by_release_seen", (q) => q.eq("release", a.release!))
          : a.status !== undefined
            ? ctx.db.query("issues").withIndex("by_status_seen", (q) => q.eq("status", a.status!))
            : ctx.db.query("issues").withIndex("by_seen");
      let q = base.order("desc");
      if (a.release !== undefined && a.status !== undefined) q = q.filter((f) => f.eq(f.field("status"), a.status!));
      if (a.level !== undefined) q = q.filter((f) => f.eq(f.field("level"), a.level!));
      if (a.project !== undefined) q = q.filter((f) => f.eq(f.field("project"), a.project!));
      const page = q.paginate(a.paginationOpts);
      return { ...page, page: page.page.map(issueRow) };
    },
  }),
  /** One issue: its fields, the symbolicated stack of the latest event and events per hour. */
  issue: internalQuery({
    args: { id: v.string() },
    handler: (ctx, a) => {
      const id = ctx.db.normalizeId("issues", a.id);
      const i = id ? ctx.db.get(id) : null;
      if (!i) return null;
      const now = Math.floor(ctx.now / HOUR);
      const hourly = bumpHourly(i.hourly, i.hourlyAt, Math.max(now, i.hourlyAt), 0);
      const last = Math.max(now, i.hourlyAt);
      return {
        ...issueRow(i),
        fingerprint: i.fingerprint,
        environment: i.environment || null,
        platform: i.platform || null,
        firstRelease: i.firstRelease || null,
        lastEventId: i.lastEventId,
        resolvedAt: i.resolvedAt ?? null,
        regressedAt: i.regressedAt ?? null,
        stack: i.stack,
        hourly: hourly.map((n, k) => ({ hour: (last - (HOURS - 1) + k) * HOUR, events: n })),
        lastEvent: i.lastEvent ?? null,
      };
    },
  }),
  releases: internalQuery({
    args: { project: v.optional(v.string()), paginationOpts: paginationOptsValidator },
    handler: (ctx, a) => {
      let q = ctx.db.query("releases").withIndex("by_uploaded").order("desc");
      if (a.project !== undefined) q = q.filter((f) => f.eq(f.field("project"), a.project!));
      return q.paginate(a.paginationOpts);
    },
  }),
  /** The maps of one release (by the `by_name` prefix). */
  artifacts: internalQuery({
    args: { project: v.string(), release: v.string(), dist: v.optional(v.string()), paginationOpts: paginationOptsValidator },
    handler: (ctx, a) => ctx.db.query("artifacts").withIndex("by_name", (q) => q.eq("project", a.project).eq("release", a.release).eq("dist", a.dist ?? "")).paginate(a.paginationOpts),
  }),
};

// ------------------------------------------------------------------------------------------------- upload routes

function uploadAuthorized(request: Request, ctx: ACtx): boolean {
  const h = request.headers.get("authorization") ?? "";
  const token = /^Bearer\s+(.+)$/i.exec(h)?.[1]?.trim();
  if (!token) return false;
  const names = ctx.component.config.uploadTokenEnv ?? ["EMBER_SENTRY_UPLOAD_TOKEN", "EMBER_ADMIN_TOKEN"];
  return names.some((n) => {
    const want = ctx.env[n];
    if (typeof want !== "string" || !want || want.length !== token.length) return false;
    let d = 0;
    for (let i = 0; i < want.length; i++) d |= want.charCodeAt(i) ^ token.charCodeAt(i);
    return d === 0;
  });
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const err = (status: number, code: string, message: string) => json(status, { ok: false, error: { code, message } });

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** `PUT <mount>/admin/sourcemaps/blobs/<sha256>`: one map, verified against its hash, stored gzipped once (dedup). */
const putBlob = httpAction(async (ctx, request) => {
  if (!uploadAuthorized(request, ctx)) return err(401, "unauthorized", "a valid upload token is required (Authorization: Bearer)");
  const sha = new URL(request.url).pathname.split("/").pop() ?? "";
  if (!/^[0-9a-f]{64}$/.test(sha)) return err(400, "bad_request", "the path must end with the map's sha256 (64 hex)");
  const bucket = r2Of(ctx.env, ctx.component.config);
  if (!bucket) return err(501, "no_bucket", "no R2 bucket bound (resources.files, or config.bucket)");
  let bytes: Uint8Array;
  try {
    bytes = await decodeBody(await readCapped(request.body, MAX_MAP_BYTES), request.headers.get("content-encoding"), MAX_MAP_BYTES);
  } catch (e) {
    if (e instanceof EnvelopeError) return err(e.reason === "too_large" ? 413 : 400, e.reason, e.message);
    throw e;
  }
  if ((await sha256Hex(bytes)) !== sha) return err(400, "hash_mismatch", "the body does not hash to the sha256 in the path");
  let parsed: { mappings?: unknown; sections?: unknown };
  try {
    parsed = JSON.parse(utf8.decode(bytes)) as typeof parsed;
  } catch {
    return err(400, "bad_map", "not a JSON source map");
  }
  if (typeof parsed?.mappings !== "string" && !Array.isArray(parsed?.sections)) return err(400, "bad_map", "not a source map (no mappings or sections)");
  const key = keys.map(ctx.component.name, sha);
  const existed = !!(await bucket.head(key));
  if (!existed) await putGzip(bucket, key, bytes);
  return json(200, { ok: true, sha256: sha, stored: !existed });
});

const fileV = v.object({ name: v.string(), sha256: v.string(), size: v.number(), debugId: v.optional(v.string()) });
const manifestV = v.object({ project: v.string(), release: v.string(), dist: v.optional(v.string()), files: v.array(fileV) });

/**
 * `POST <mount>/admin/sourcemaps`: `{ project, release, dist?, files: [{ name, sha256, size, debugId? }] }`. Maps not in
 * R2 yet come back as `missing` (nothing registered); once every blob is there, the files are registered in one mutation.
 */
const postManifest = httpAction(async (ctx, request) => {
  if (!uploadAuthorized(request, ctx)) return err(401, "unauthorized", "a valid upload token is required (Authorization: Bearer)");
  let body: unknown;
  try {
    body = JSON.parse(utf8.decode(await readCapped(request.body, 4 * MiB)));
  } catch {
    return err(400, "bad_request", "expected a JSON body up to 4 MiB");
  }
  const r = manifestV.validate(body);
  if (!r.ok) return err(400, "bad_request", `invalid manifest: ${r.path}: ${r.message}`);
  const m = body as { project: string; release: string; dist?: string; files: Array<{ name: string; sha256: string; size: number; debugId?: string }> };
  const config = ctx.component.config;
  if (!config.projects.some((p) => p.id === m.project)) return err(404, "unknown_project", `no project ${m.project}`);
  if (!m.release || m.release.length > 200) return err(400, "bad_request", "release must be 1-200 characters");
  if (m.files.length > 2000) return err(400, "bad_request", "at most 2000 files per call");
  for (const f of m.files) {
    if (!/^[0-9a-f]{64}$/.test(f.sha256)) return err(400, "bad_request", `${f.name}: sha256 must be 64 hex`);
    if (!f.name || f.name.length > 1024) return err(400, "bad_request", "file names must be 1-1024 characters");
    if (f.debugId !== undefined) f.debugId = normalizeDebugId(f.debugId);
  }
  const bucket = r2Of(ctx.env, config);
  if (!bucket) return err(501, "no_bucket", "no R2 bucket bound (resources.files, or config.bucket)");
  const shas = [...new Set(m.files.map((f) => f.sha256))];
  const missing: string[] = [];
  for (const s of shas) if (!(await bucket.head(keys.map(ctx.component.name, s)))) missing.push(s);
  if (missing.length) return json(200, { ok: false, missing });
  const out = await ctx.onShard(shardOf(config)).runMutation(ref.register, { project: m.project, release: m.release, dist: m.dist ?? "", files: m.files });
  return json(200, { ok: true, ...(out as object) });
});

const ingest = httpAction(async (ctx, request) =>
  handleIngest(request, {
    config: ctx.component.config,
    install: ctx.component.name,
    env: ctx.env,
    inline: async (messages) => void (await ctx.runAction(ref.consume, { messages })),
  }),
);

/** Where uploads and the envelope endpoint are, relative to the install's HTTP prefix. */
export const ROUTES = { envelope: "/api/", manifest: "/admin/sourcemaps", blobs: "/admin/sourcemaps/blobs/", eventPage: EVENT_PAGE_ROUTE };

const http = httpRouter()
  .route({ pathPrefix: ROUTES.envelope, method: "POST", handler: ingest })
  .route({ pathPrefix: ROUTES.envelope, method: "OPTIONS", handler: ingest })
  .route({ path: ROUTES.manifest, method: "POST", handler: postManifest })
  .route({ pathPrefix: ROUTES.blobs, method: "PUT", handler: putBlob })
  .route({ path: ROUTES.eventPage, method: "GET", handler: httpAction(async () => new Response(EVENT_PAGE, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache", "x-content-type-options": "nosniff" } })) });

export const functions = { lib, dashboard };

export const sentry = defineComponent({
  name: "sentry",
  schema,
  functions,
  config: installConfigValidator,
  http,
  bindings: (config, installName) => {
    if (config) checkConfig(config);
    const name = analyticsBinding(config, installName);
    return name ? [{ type: "analytics_engine" as const, name, dataset: (config?.analytics !== false && config?.analytics?.dataset) || DEFAULT_DATASET }] : [];
  },
  crons: (config) => cronJobs({ shard: shardOf(config) }).daily("retention", { hour: 3, minute: 17 }, "lib:retention"),
  // The issue tables live on `config.shard`: the screens (scope "global") read and change them there.
  dashboardShard: (config) => shardOf(config),
  queues: {
    events: {
      shard: (config) => shardOf(config),
      consumer: { maxBatchSize: 100, maxBatchTimeoutSeconds: 5, maxRetries: 5 },
      // Each slice's messages are acked as soon as its `lib:apply` commits: if a later slice throws, the Queue redelivers
      // only the rest, and the slices already applied are not counted again (consumer.ts, "Retries").
      handler: async (ctx, batch) => {
        const messages = batch.messages;
        await consumeIn(ctx as unknown as ACtx, messages.map((m) => m.body as QueuedEvent), {
          committed: (indexes) => indexes.forEach((i) => messages[i]!.ack()),
          // A spill R2 failed to read: that message alone comes back (a call on one message wins over `ackAll`).
          retry: (indexes) => indexes.forEach((i) => messages[i]!.retry()),
        });
        batch.ackAll();
      },
    },
  },
  dashboard: {
    label: "Errors",
    icon: "flag",
    scope: "global",
    description: "Issues grouped from Sentry-compatible SDKs, with the symbolicated stack of their latest event; source maps per release.",
    tabs: [
      {
        id: "issues",
        label: "Issues",
        blocks: [
          {
            kind: "table",
            id: "issues",
            label: "Issues",
            query: dashboard.issues,
            filters: ["status", "level", "release", "project"],
            columns: [
              { label: "Issue", path: "title" },
              { label: "Where", path: "culprit", format: "code" },
              { label: "Level", path: "level", format: "badge" },
              { label: "Status", path: "status", format: "badge" },
              { label: "Events", path: "count", format: "number" },
              { label: "Last seen", path: "lastSeen", format: "ago" },
              { label: "First seen", path: "firstSeen", format: "ago" },
              { label: "Release", path: "release", format: "code" },
            ],
            detail: {
              query: dashboard.issue,
              fromRow: { id: "_id" },
              sections: [
                {
                  kind: "kv",
                  items: [
                    { label: "Project", path: "project" },
                    { label: "Status", path: "status", format: "badge" },
                    { label: "Level", path: "level", format: "badge" },
                    { label: "Events", path: "count", format: "number" },
                    { label: "First seen", path: "firstSeen", format: "date" },
                    { label: "Last seen", path: "lastSeen", format: "date" },
                    { label: "Release", path: "release", format: "code" },
                    { label: "First release", path: "firstRelease", format: "code" },
                    { label: "Environment", path: "environment" },
                    { label: "Latest event", path: "lastEventId", format: "code" },
                    { label: "Regressed", path: "regressedAt", format: "ago" },
                  ],
                },
                { kind: "stacktrace", label: "Latest event (symbolicated)", path: "stack" },
                { kind: "chart", label: "Events per hour (24 h)", path: "hourly", x: "hour", y: ["events"], type: "bar" },
              ],
            },
            rowActions: [
              { id: "resolve", label: "Resolve", fn: lib.setStatus, args: { status: "resolved" }, fromRow: { id: "_id" }, description: "Marks it resolved: the next event reopens it as a regression." },
              { id: "ignore", label: "Ignore", fn: lib.setStatus, args: { status: "ignored" }, fromRow: { id: "_id" }, description: "Keeps counting events, sends no alerts." },
              { id: "reopen", label: "Reopen", fn: lib.setStatus, args: { status: "unresolved" }, fromRow: { id: "_id" } },
            ],
          },
        ],
      },
      {
        id: "event",
        label: "Latest event",
        blocks: [
          {
            kind: "embed",
            id: "event",
            route: EVENT_PAGE_ROUTE,
            functions: [dashboard.issues, lib.latestEvent],
            description: "Pick an issue to load its latest event from R2: frames with source context, breadcrumbs, tags and contexts (loading runs an action: the dashboard asks to confirm it).",
          },
        ],
      },
      {
        id: "releases",
        label: "Releases",
        blocks: [
          {
            kind: "table",
            id: "releases",
            label: "Source maps uploaded",
            query: dashboard.releases,
            columns: [
              { label: "Project", path: "project" },
              { label: "Release", path: "release", format: "code" },
              { label: "Dist", path: "dist", format: "code" },
              { label: "Files", path: "files", format: "number" },
              { label: "Size", path: "bytes", format: "bytes" },
              { label: "Last upload", path: "lastUploadAt", format: "ago" },
            ],
          },
          {
            kind: "table",
            id: "artifacts",
            label: "Files of a release",
            query: dashboard.artifacts,
            columns: [
              { label: "Name", path: "name", format: "code" },
              { label: "Debug id", path: "debugId", format: "code" },
              { label: "Size", path: "size", format: "bytes" },
              { label: "sha256", path: "sha256", format: "code" },
              { label: "Uploaded", path: "uploadedAt", format: "ago" },
            ],
          },
        ],
      },
    ],
  },
});

export type { Config as SentryConfig };
export { schema as sentrySchema };
