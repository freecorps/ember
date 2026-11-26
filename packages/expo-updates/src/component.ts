/**
 * Self-hosted EAS Update as an Ember component (PLAN §12): channels, branches, updates and content-addressed assets
 * in the shard (`global:main`), the Expo Updates protocol v1 over the component's HTTP routes, answered from the edge
 * cache (`caches.default`), and the functions `ember expo publish|rollback|rollout|kill|resume|channel` drive through
 * the admin function runner.
 *
 *   // ember/ember.config.ts
 *   export default defineApp().use(expoUpdates);           // routes at /expoUpdates/manifest and /expoUpdates/assets
 *   // app.json: "updates": { "url": "https://api.example.com/expoUpdates/manifest", "requestHeaders": { "expo-channel-name": "production" } }
 *
 * Data model:
 * - `channels(name, branch, rolloutBranch?, rolloutPercent?, paused, version)`: what an app build asks for (its
 *   `expo-channel-name`), mapped to a branch, optionally with a percentage of installs on a second branch. `version`
 *   changes with every write that can change what the channel serves (the edge cache key).
 * - `branches(name, paused)`: a line of updates. `paused` is the kill switch of the branch: installs it serves (on
 *   every channel, as its branch or its rollout branch) get `noUpdateAvailable` and keep what they run;
 *   `channels.paused` is the kill switch of a whole channel, whatever branch an install falls on.
 * - `updates`: per branch, platform and runtime version, newest first; `kind` is an update (its manifest: launch asset,
 *   assets, metadata, extra) or a `rollBackToEmbedded` directive; `rolloutPercent` for a partial rollout of the head;
 *   `rolledBack` takes a row out of what is served.
 * - `assets(sha256, file, contentType, size)`: content-addressed (hex SHA-256) over Ember's files (R2, PLAN §7):
 *   uploaded once, whatever the number of updates that use them.
 */
import { componentBuilders, defineComponent, defineErrors, defineSchema, defineTable, EmberError, httpRouter, paginationOptsValidator, unsafeRef, v, type ComponentCtx } from "@freecorps/ember-server";
import { buildManifest, finalOutcome, isSha256Hex, isUuid, parseUpdateRequest, ProtocolError, renderResponse, rsaSigner, SigningKeyMissing, type Platform, type RenderedResponse, type StoredAsset, type UpdateRequest } from "./protocol.ts";
import { resolvePlan, type BranchPlan, type Plan, type PlanEntry } from "./rollout.ts";

const vPlatform = v.union(v.literal("ios"), v.literal("android"));
const vAsset = v.object({ sha256: v.string(), key: v.string(), contentType: v.string(), fileExtension: v.optional(v.string()) });

const schema = defineSchema({
  tables: {
    channels: defineTable({
      name: v.string(),
      branch: v.string(),
      rolloutBranch: v.optional(v.string()),
      rolloutPercent: v.optional(v.number()),
      paused: v.boolean(),
      version: v.number(),
      updatedAt: v.number(),
    })
      .index("by_name", ["name"])
      .index("by_branch", ["branch"])
      .index("by_rollout_branch", ["rolloutBranch"], { sparse: true })
      .index("by_paused", ["paused"]),
    branches: defineTable({ name: v.string(), paused: v.boolean(), createdAt: v.number(), updatedAt: v.number() }).index("by_name", ["name"]),
    updates: defineTable({
      uuid: v.string(),
      group: v.string(),
      branch: v.string(),
      platform: vPlatform,
      runtimeVersion: v.string(),
      kind: v.union(v.literal("update"), v.literal("rollBackToEmbedded")),
      message: v.optional(v.string()),
      launchAsset: v.optional(vAsset),
      assets: v.array(vAsset),
      metadata: v.record(v.string()),
      extra: v.optional(v.any()),
      rolloutPercent: v.number(),
      rolledBack: v.boolean(),
      /** The update a rollback took out (set on the row the rollback published). */
      rollbackOf: v.optional(v.string()),
      /** The update this row republishes (a rollback to a previous update). */
      republishOf: v.optional(v.string()),
      createdAt: v.number(),
    })
      .index("by_uuid", ["uuid"])
      // The hot read: the newest live row of (branch, platform, runtime version), and the one before it.
      .index("by_head", ["branch", "platform", "runtimeVersion", "rolledBack", "createdAt"])
      .index("by_branch", ["branch", "createdAt"])
      .index("by_created", ["createdAt"]),
    assets: defineTable({
      sha256: v.string(),
      file: v.file(),
      /** Uploads of the same content still in flight besides `file` (concurrent publishers): any confirmed one serves. */
      pending: v.optional(v.array(v.file())),
      contentType: v.string(),
      size: v.number(),
      createdAt: v.number(),
    }).index("by_sha", ["sha256"]),
  },
});

export type ExpoUpdatesConfig = {
  /** Channel of requests without `expo-channel-name` (default `"production"`; null: such requests get 400). */
  defaultChannel?: string | null;
  /** Code signing: the PEM private key's env secret (default `EXPO_UPDATES_PRIVATE_KEY`) and its key id (default `main`). */
  signing?: { privateKeySecret?: string; keyId?: string };
  /**
   * Edge cache of `GET /manifest` (`caches.default`; `false` turns it off). `planTtlSeconds` (default 30): how long an
   * edge location answers from its copy of a channel's plan before asking the shard again, i.e. the longest a publish,
   * rollback, rollout change or kill switch takes to reach every location. `responseTtlSeconds` (default 1 day): the
   * signed responses, keyed by the plan's version (a new version never reads an old response).
   */
  cache?: false | { planTtlSeconds?: number; responseTtlSeconds?: number };
  /** Base URL of the asset route in manifests (default: the request's origin and the install's mount, `/assets`). */
  assetsUrl?: string;
};

const configValidator = v.optional(
  v.object({
    defaultChannel: v.optional(v.union(v.string(), v.null())),
    signing: v.optional(v.object({ privateKeySecret: v.optional(v.string()), keyId: v.optional(v.string()) })),
    cache: v.optional(v.union(v.literal(false), v.object({ planTtlSeconds: v.optional(v.number()), responseTtlSeconds: v.optional(v.number()) }))),
    assetsUrl: v.optional(v.string()),
  }),
);

/** The component's application errors. */
export const expoUpdatesErrors = defineErrors({
  RolloutInProgress: {
    data: v.object({ branch: v.string(), platform: v.string(), runtimeVersion: v.string(), update: v.string(), percent: v.number() }),
    status: 409,
    message: (d: { branch: string; platform: string; update: string; percent: number }) =>
      `${d.branch} (${d.platform}) has update ${d.update} in a ${d.percent}% rollout: finish it (rollout 100) or roll it back before publishing`,
  },
  NotInRollout: { data: v.object({ branch: v.string() }), status: 409, message: (d: { branch: string }) => `no update of ${d.branch} is in a partial rollout` },
  AssetNotUploaded: { data: v.object({ sha256: v.string() }), status: 409, message: (d: { sha256: string }) => `asset ${d.sha256} is not uploaded (prepareAssets, PUT, confirm first)` },
  UnknownChannel: { data: v.object({ name: v.string() }), status: 404, message: (d: { name: string }) => `no channel named ${d.name}` },
  UnknownBranch: { data: v.object({ name: v.string() }), status: 404, message: (d: { name: string }) => `no branch named ${d.name}` },
});

const { query, mutation, internalQuery, httpAction } = componentBuilders<typeof schema, ExpoUpdatesConfig | undefined>();
type Ctx = ComponentCtx<typeof schema, ExpoUpdatesConfig | undefined>;
type ReadCtx = Ctx["query"] | Ctx["mutation"];

export const DEFAULT_CHANNEL = "production";
export const DEFAULT_SIGNING_SECRET = "EXPO_UPDATES_PRIVATE_KEY";
export const DEFAULT_PLAN_TTL_S = 30;
export const DEFAULT_RESPONSE_TTL_S = 86_400;
/** Largest asset `prepareAssets` accepts (one PUT; Hermes bundles are a few MiB). */
export const MAX_ASSET_BYTES = 1024 ** 3;
/**
 * Most channels that may serve one branch (as their branch or rollout branch): a write to the branch bumps the version
 * of each of them in one mutation, so the fan-out is bounded where channels are pointed, not cut short there.
 */
export const MAX_CHANNELS_PER_BRANCH = 1000;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._\-/]{0,99}$/;

function checkName(what: string, name: string): void {
  if (!NAME.test(name)) throw new EmberError("ValidationError", `${what} ${JSON.stringify(name)}: use letters, digits, . _ - / (up to 100, starting with a letter or digit)`);
}
function checkPercent(p: number): void {
  if (!Number.isInteger(p) || p < 0 || p > 100) throw new EmberError("ValidationError", `rollout percent must be an integer in 0..100 (got ${p})`);
}

/** A v4 UUID from the mutation's seeded `random()`. */
function uuidOf(random: () => number): string {
  const b = Array.from({ length: 16 }, () => Math.floor(random() * 256) & 0xff);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const channelByName = (ctx: ReadCtx, name: string) => ctx.db.query("channels").withIndex("by_name", (q) => q.eq("name", name)).unique();
const branchByName = (ctx: ReadCtx, name: string) => ctx.db.query("branches").withIndex("by_name", (q) => q.eq("name", name)).unique();
/** The newest live rows of (branch, platform, runtime version): one index range, `n` rows. */
const liveRows = (ctx: ReadCtx, branch: string, platform: Platform, runtimeVersion: string, n: number) =>
  ctx.db
    .query("updates")
    .withIndex("by_head", (q) => q.eq("branch", branch).eq("platform", platform).eq("runtimeVersion", runtimeVersion).eq("rolledBack", false))
    .order("desc")
    .take(n);

/** The channels that serve `branch` (as their branch or their rollout branch): at most `limit` per index. */
function channelsServing(ctx: ReadCtx, branch: string, limit: number) {
  const out = new Map<string, ReturnType<typeof channelByName> & {}>();
  for (const c of ctx.db.query("channels").withIndex("by_branch", (q) => q.eq("branch", branch)).take(limit)) out.set(c._id, c);
  for (const c of ctx.db.query("channels").withIndex("by_rollout_branch", (q) => q.eq("rolloutBranch", branch)).take(limit)) out.set(c._id, c);
  return [...out.values()];
}

/** Whether one more channel (`channelId`: the one being changed, if it exists) may serve `branch`. */
const fanOutRoom = (ctx: ReadCtx, branch: string, channelId: string | null): boolean =>
  channelsServing(ctx, branch, MAX_CHANNELS_PER_BRANCH + 1).filter((c) => c._id !== channelId).length < MAX_CHANNELS_PER_BRANCH;

/** Refuses pointing one more channel at `branch` past the limit. */
function checkFanOut(ctx: ReadCtx, branch: string, channelId: string | null): void {
  if (!fanOutRoom(ctx, branch, channelId)) throw new EmberError("ValidationError", `branch ${branch} already serves ${MAX_CHANNELS_PER_BRANCH} channels (the most a publish re-versions at once)`);
}

/** Every channel that serves `branch` gets a new version (all of them: `checkFanOut` bounds how many there are). */
function bumpChannelsOf(ctx: Ctx["mutation"], branch: string): number {
  const rows = channelsServing(ctx, branch, MAX_CHANNELS_PER_BRANCH);
  for (const c of rows) ctx.db.patch(c._id, { version: c.version + 1, updatedAt: ctx.now });
  return rows.length;
}

function ensureBranch(ctx: Ctx["mutation"], name: string) {
  checkName("branch", name);
  const b = branchByName(ctx, name);
  if (b) return b;
  const id = ctx.db.insert("branches", { name, paused: false, createdAt: ctx.now, updatedAt: ctx.now });
  return ctx.db.get(id)!;
}

/** The most distinct runtime versions per platform a branch-wide command walks (beyond it: name `runtimeVersion`). */
const MAX_PAIRS_PER_PLATFORM = 500;

/**
 * The (platform, runtime version) pairs a branch-wide command acts on: given, or every pair the branch has rows for,
 * found by skipping through `by_head` one runtime version at a time (one read each, however many rows each has).
 */
function pairsOf(ctx: ReadCtx, branch: string, platform: Platform | undefined, runtimeVersion: string | undefined): Array<{ platform: Platform; runtimeVersion: string }> {
  const platforms: Platform[] = platform ? [platform] : ["ios", "android"];
  if (runtimeVersion !== undefined) return platforms.map((p) => ({ platform: p, runtimeVersion }));
  const out: Array<{ platform: Platform; runtimeVersion: string }> = [];
  for (const p of platforms) {
    let last: string | undefined;
    for (let n = 0; ; n++) {
      const after = last;
      const r = ctx.db
        .query("updates")
        .withIndex("by_head", (q) => (after === undefined ? q.eq("branch", branch).eq("platform", p) : q.eq("branch", branch).eq("platform", p).gt("runtimeVersion", after)))
        .first();
      if (!r) break;
      if (n >= MAX_PAIRS_PER_PLATFORM) throw new EmberError("ValidationError", `branch ${branch} has more than ${MAX_PAIRS_PER_PLATFORM} ${p} runtime versions: name the runtimeVersion`);
      out.push({ platform: p, runtimeVersion: r.runtimeVersion });
      last = r.runtimeVersion;
    }
  }
  return out;
}

const publishedUpdate = v.object({
  /** The update's id (a UUID; default: a new one). */
  id: v.optional(v.string()),
  platform: vPlatform,
  runtimeVersion: v.string(),
  launchAsset: vAsset,
  assets: v.array(vAsset),
  metadata: v.optional(v.record(v.string())),
  extra: v.optional(v.any()),
});

function checkAsset(ctx: Ctx["mutation"], a: StoredAsset, ready: Map<string, boolean>): void {
  if (!isSha256Hex(a.sha256)) throw new EmberError("ValidationError", `asset sha256 must be lowercase hex (got ${JSON.stringify(a.sha256)})`);
  if (!a.key || a.key.length > 200) throw new EmberError("ValidationError", "asset key must be 1..200 characters");
  if (a.fileExtension !== undefined && !/^\.[A-Za-z0-9]{1,16}$/.test(a.fileExtension)) throw new EmberError("ValidationError", `fileExtension must start with "." (got ${JSON.stringify(a.fileExtension)})`);
  let ok = ready.get(a.sha256);
  if (ok === undefined) {
    const row = ctx.db.query("assets").withIndex("by_sha", (q) => q.eq("sha256", a.sha256)).unique();
    ok = !!row && promoteReady(ctx, row);
    ready.set(a.sha256, ok);
  }
  if (!ok) throw expoUpdatesErrors.AssetNotUploaded({ sha256: a.sha256 });
}

const assetBySha = (ctx: ReadCtx, sha256: string) => ctx.db.query("assets").withIndex("by_sha", (q) => q.eq("sha256", sha256)).unique();
type AssetRow = NonNullable<ReturnType<typeof assetBySha>>;
const fileState = (ctx: ReadCtx, id: string) => ctx.storage.getMetadata(id)?.state;

/**
 * Whether the asset row has a ready file: its own, or one of the uploads in flight beside it (another `prepareAssets`
 * for the same content ran before this publisher's confirm), which then becomes the row's file. The uploads still
 * in flight stay referenced (their publishers confirm them); the others (finished duplicates, failed) are let go.
 */
function promoteReady(ctx: Ctx["mutation"], row: AssetRow): boolean {
  if (fileState(ctx, row.file) === "ready") return true;
  const candidates = [row.file, ...(row.pending ?? [])];
  const file = candidates.find((f) => fileState(ctx, f) === "ready");
  if (!file) return false;
  const pending = candidates.filter((f) => f !== file && fileState(ctx, f) === "pending");
  ctx.db.patch(row._id, { file, pending: pending.length ? pending : undefined });
  return true;
}

/** At most this many uploads of one content in flight at once (each keeps its file referenced until it is used). */
const MAX_PENDING_UPLOADS = 16;

/** Inserts a new head row (createdAt strictly after the current head, so clients see it as newer). */
type UpdateRow = Omit<ReturnType<typeof liveRows>[number], "_id" | "_creationTime" | "createdAt">;
function insertHead(ctx: Ctx["mutation"], row: UpdateRow, after: number | null) {
  const createdAt = Math.max(ctx.now, after === null ? 0 : after + 1);
  return ctx.db.insert("updates", { ...row, createdAt });
}

export const functions = {
  lib: {
    /**
     * Step 1 of a publish: the assets it needs that are not uploaded yet, with an upload ticket each (the CLI PUTs the
     * bytes and confirms through `/api/storage/confirm`). Content already here (same SHA-256) gets no ticket: uploads
     * are deduplicated across updates.
     */
    prepareAssets: mutation({
      args: { assets: v.array(v.object({ sha256: v.string(), size: v.number(), contentType: v.string() })) },
      handler: (ctx, { assets }) => {
        if (assets.length > 2000) throw new EmberError("ValidationError", "at most 2000 assets per call");
        const out: Array<{ sha256: string; exists: boolean; upload?: { storageId: string; shard: string; token: string; url: string; method: string; headers: Record<string, string> } }> = [];
        const seen = new Set<string>();
        for (const a of assets) {
          if (!isSha256Hex(a.sha256)) throw new EmberError("ValidationError", `sha256 must be lowercase hex (got ${JSON.stringify(a.sha256)})`);
          if (!Number.isInteger(a.size) || a.size < 0 || a.size > MAX_ASSET_BYTES) throw new EmberError("ValidationError", `asset ${a.sha256}: size must be an integer in 0..${MAX_ASSET_BYTES}`);
          if (seen.has(a.sha256)) continue;
          seen.add(a.sha256);
          const row = ctx.db.query("assets").withIndex("by_sha", (q) => q.eq("sha256", a.sha256)).unique();
          if (row && ctx.storage.getMetadata(row.file)?.state === "ready") {
            out.push({ sha256: a.sha256, exists: true });
            continue;
          }
          if (row && promoteReady(ctx, row)) {
            out.push({ sha256: a.sha256, exists: true });
            continue;
          }
          const ticket = ctx.storage.generateUploadUrl({ sha256: a.sha256, size: a.size, contentType: a.contentType });
          // The row references the file from now on (refcount): a pending upload is not collected while it is here. An
          // upload of the same content already in flight keeps its place (its publisher confirms it, and either serves).
          const inFlight = row ? [row.file, ...(row.pending ?? [])].filter((f) => f !== ticket.storageId && fileState(ctx, f) === "pending") : [];
          if (inFlight.length >= MAX_PENDING_UPLOADS) throw new EmberError("ValidationError", `asset ${a.sha256}: ${MAX_PENDING_UPLOADS} uploads of it are already in flight`);
          if (row) ctx.db.patch(row._id, { file: ticket.storageId as never, pending: inFlight.length ? inFlight : undefined, contentType: a.contentType, size: a.size });
          else ctx.db.insert("assets", { sha256: a.sha256, file: ticket.storageId as never, contentType: a.contentType, size: a.size, createdAt: ctx.now });
          if (ticket.exists || !ticket.url) out.push({ sha256: a.sha256, exists: true });
          else out.push({ sha256: a.sha256, exists: false, upload: { storageId: ticket.storageId, shard: ticket.shard, token: ticket.token, url: ticket.url, method: ticket.method ?? "PUT", headers: ticket.headers ?? {} } });
        }
        return out;
      },
    }),

    /**
     * Step 2: one update per platform (an update group) on `branch`, created if missing; with `createChannel` (default
     * true) a channel of the same name pointing at it is created when none exists. Refused while the branch's head for
     * a platform and runtime version is in a partial rollout. Every channel serving the branch gets a new version.
     */
    publish: mutation({
      args: {
        branch: v.string(),
        message: v.optional(v.string()),
        rolloutPercent: v.optional(v.number()),
        group: v.optional(v.string()),
        createChannel: v.optional(v.boolean()),
        updates: v.array(publishedUpdate),
      },
      errors: [expoUpdatesErrors.RolloutInProgress, expoUpdatesErrors.AssetNotUploaded],
      handler: (ctx, a) => {
        if (!a.updates.length || a.updates.length > 8) throw new EmberError("ValidationError", "publish 1..8 updates (one per platform and runtime version)");
        const percent = a.rolloutPercent ?? 100;
        checkPercent(percent);
        if (a.message !== undefined && a.message.length > 1000) throw new EmberError("ValidationError", "message is at most 1000 characters");
        ensureBranch(ctx, a.branch);
        // The convenience channel is skipped (the publish goes on) when the branch already serves the most channels.
        if (a.createChannel !== false && !channelByName(ctx, a.branch) && fanOutRoom(ctx, a.branch, null)) {
          ctx.db.insert("channels", { name: a.branch, branch: a.branch, paused: false, version: 0, updatedAt: ctx.now });
        }
        const group = a.group ?? uuidOf(ctx.random);
        if (!isUuid(group)) throw new EmberError("ValidationError", "group must be a UUID");
        const ready = new Map<string, boolean>();
        const pairs = new Set<string>();
        const created: Array<{ id: string; platform: Platform; runtimeVersion: string }> = [];
        for (const u of a.updates) {
          const pair = `${u.platform}\u0000${u.runtimeVersion}`;
          if (pairs.has(pair)) throw new EmberError("ValidationError", `two updates for ${u.platform} ${u.runtimeVersion}`);
          pairs.add(pair);
          if (!u.runtimeVersion || u.runtimeVersion.length > 256) throw new EmberError("ValidationError", "runtimeVersion must be 1..256 characters");
          // Clients send it as a header, whose value has no surrounding whitespace: such an update could never be asked for.
          if (u.runtimeVersion.trim() !== u.runtimeVersion) throw new EmberError("ValidationError", `runtimeVersion ${JSON.stringify(u.runtimeVersion)} has surrounding whitespace`);
          // Nor NUL, CR, LF or other controls (a header value cannot carry them).
          if (/[\u0000-\u0008\u000a-\u001f\u007f]/.test(u.runtimeVersion)) throw new EmberError("ValidationError", `runtimeVersion ${JSON.stringify(u.runtimeVersion)} has control characters`);
          for (const x of [u.launchAsset, ...u.assets]) checkAsset(ctx, x, ready);
          if (u.assets.length > 2000) throw new EmberError("ValidationError", "at most 2000 assets per update");
          const [head] = liveRows(ctx, a.branch, u.platform, u.runtimeVersion, 1);
          if (head && head.rolloutPercent < 100) {
            throw expoUpdatesErrors.RolloutInProgress({ branch: a.branch, platform: u.platform, runtimeVersion: u.runtimeVersion, update: head.uuid, percent: head.rolloutPercent });
          }
          const id = (u.id ?? uuidOf(ctx.random)).toLowerCase();
          if (!isUuid(id)) throw new EmberError("ValidationError", `update id must be a UUID (got ${JSON.stringify(u.id)})`);
          if (ctx.db.query("updates").withIndex("by_uuid", (q) => q.eq("uuid", id)).first()) throw new EmberError("ValidationError", `update ${id} already exists`);
          insertHead(
            ctx,
            {
              uuid: id,
              group,
              branch: a.branch,
              platform: u.platform,
              runtimeVersion: u.runtimeVersion,
              kind: "update",
              ...(a.message !== undefined ? { message: a.message } : {}),
              launchAsset: u.launchAsset,
              assets: u.assets,
              metadata: u.metadata ?? {},
              ...(u.extra !== undefined ? { extra: u.extra } : {}),
              rolloutPercent: percent,
              rolledBack: false,
            },
            head?.createdAt ?? null,
          );
          created.push({ id, platform: u.platform, runtimeVersion: u.runtimeVersion });
        }
        const channels = bumpChannelsOf(ctx, a.branch);
        return { group, branch: a.branch, rolloutPercent: percent, updates: created, channels };
      },
    }),

    /**
     * Takes the head of the branch (each platform and runtime version, or the ones given) out of service. Clients get
     * the previous live update again, republished as a new update (a client only moves to a newer `createdAt`), or the
     * embedded update (`rollBackToEmbedded`) with `toEmbedded` or when there is no previous one.
     */
    rollback: mutation({
      args: { branch: v.string(), platform: v.optional(vPlatform), runtimeVersion: v.optional(v.string()), toEmbedded: v.optional(v.boolean()), message: v.optional(v.string()) },
      handler: (ctx, a) => {
        if (!branchByName(ctx, a.branch)) throw expoUpdatesErrors.UnknownBranch({ name: a.branch });
        const out: Array<{ platform: Platform; runtimeVersion: string; rolledBack: string; now: string; kind: "update" | "rollBackToEmbedded" }> = [];
        for (const p of pairsOf(ctx, a.branch, a.platform, a.runtimeVersion)) {
          const [head, prev] = liveRows(ctx, a.branch, p.platform, p.runtimeVersion, 2);
          if (!head) continue;
          if (head.kind === "rollBackToEmbedded" && (a.toEmbedded || !prev)) continue; // already on the embedded update
          ctx.db.patch(head._id, { rolledBack: true });
          const uuid = uuidOf(ctx.random);
          const toEmbedded = !!a.toEmbedded || !prev;
          // What the new head is: the previous row may itself be a directive (a publish after a rollback to embedded).
          const kind = toEmbedded ? "rollBackToEmbedded" : prev!.kind;
          const base = { uuid, group: uuid, branch: a.branch, platform: p.platform, runtimeVersion: p.runtimeVersion, rolloutPercent: 100, rolledBack: false, rollbackOf: head.uuid };
          if (toEmbedded) {
            insertHead(ctx, { ...base, kind: "rollBackToEmbedded", assets: [], metadata: {}, message: a.message ?? `Roll back ${head.uuid} to the embedded update` }, head.createdAt);
          } else {
            const { _id: _x, _creationTime: _y, uuid: prevUuid, group: _g, createdAt: _c, rollbackOf: _r, republishOf: _p, message: _m, ...copy } = prev!;
            insertHead(ctx, { ...copy, ...base, republishOf: prevUuid, message: a.message ?? `Roll back ${head.uuid} to ${prevUuid}` }, head.createdAt);
          }
          out.push({ platform: p.platform, runtimeVersion: p.runtimeVersion, rolledBack: head.uuid, now: uuid, kind });
        }
        if (out.length) bumpChannelsOf(ctx, a.branch);
        return out;
      },
    }),

    /** Sets the percentage of the branch's heads in a partial rollout (100 ends it: every install gets the update). */
    setRollout: mutation({
      args: { branch: v.string(), percent: v.number(), platform: v.optional(vPlatform), runtimeVersion: v.optional(v.string()) },
      errors: [expoUpdatesErrors.NotInRollout],
      handler: (ctx, a) => {
        checkPercent(a.percent);
        const out: Array<{ platform: Platform; runtimeVersion: string; update: string; from: number; to: number }> = [];
        for (const p of pairsOf(ctx, a.branch, a.platform, a.runtimeVersion)) {
          const [head] = liveRows(ctx, a.branch, p.platform, p.runtimeVersion, 1);
          if (!head || head.rolloutPercent >= 100) continue;
          ctx.db.patch(head._id, { rolloutPercent: a.percent });
          out.push({ platform: p.platform, runtimeVersion: p.runtimeVersion, update: head.uuid, from: head.rolloutPercent, to: a.percent });
        }
        if (!out.length) throw expoUpdatesErrors.NotInRollout({ branch: a.branch });
        bumpChannelsOf(ctx, a.branch);
        return out;
      },
    }),

    /**
     * Creates or updates a channel: its branch, and optionally a branch rollout (`rolloutBranch` null clears it). The
     * channel then serves the target branch's head as it is: an install only moves to a newer `createdAt`, so one that
     * runs a newer update of the previous branch keeps it until something newer is published where it now points.
     */
    setChannel: mutation({
      args: { name: v.string(), branch: v.string(), rolloutBranch: v.optional(v.union(v.string(), v.null())), rolloutPercent: v.optional(v.number()) },
      handler: (ctx, a) => {
        checkName("channel", a.name);
        ensureBranch(ctx, a.branch);
        const clear = a.rolloutBranch === null;
        if (a.rolloutBranch) ensureBranch(ctx, a.rolloutBranch);
        if (a.rolloutPercent !== undefined) checkPercent(a.rolloutPercent);
        if (a.rolloutBranch && a.rolloutPercent === undefined) throw new EmberError("ValidationError", "rolloutBranch needs rolloutPercent");
        if (a.rolloutBranch === a.branch) throw new EmberError("ValidationError", "rolloutBranch must differ from branch");
        const c = channelByName(ctx, a.name);
        if (c?.branch !== a.branch && c?.rolloutBranch !== a.branch) checkFanOut(ctx, a.branch, c?._id ?? null);
        if (a.rolloutBranch && c?.branch !== a.rolloutBranch && c?.rolloutBranch !== a.rolloutBranch) checkFanOut(ctx, a.rolloutBranch, c?._id ?? null);
        // undefined removes an optional field (ctx.db.patch), so this clears the rollout.
        const rollout = clear ? { rolloutBranch: undefined, rolloutPercent: undefined } : a.rolloutBranch ? { rolloutBranch: a.rolloutBranch, rolloutPercent: a.rolloutPercent! } : {};
        if (c) {
          if (!clear && !a.rolloutBranch && a.rolloutPercent !== undefined && !c.rolloutBranch) throw new EmberError("ValidationError", "rolloutPercent needs rolloutBranch");
          ctx.db.patch(c._id, { branch: a.branch, ...rollout, ...(!clear && !a.rolloutBranch && a.rolloutPercent !== undefined ? { rolloutPercent: a.rolloutPercent } : {}), version: c.version + 1, updatedAt: ctx.now });
        } else {
          if (!a.rolloutBranch && a.rolloutPercent !== undefined) throw new EmberError("ValidationError", "rolloutPercent needs rolloutBranch");
          ctx.db.insert("channels", { name: a.name, branch: a.branch, ...(a.rolloutBranch ? { rolloutBranch: a.rolloutBranch, rolloutPercent: a.rolloutPercent! } : {}), paused: false, version: 0, updatedAt: ctx.now });
        }
        return channelByName(ctx, a.name);
      },
    }),

    /** Kill switch of a channel (`paused: true`: every client of it gets `noUpdateAvailable`), or resume it. */
    setChannelPaused: mutation({
      args: { name: v.string(), paused: v.boolean() },
      errors: [expoUpdatesErrors.UnknownChannel],
      handler: (ctx, { name, paused }) => {
        const c = channelByName(ctx, name);
        if (!c) throw expoUpdatesErrors.UnknownChannel({ name });
        if (c.paused !== paused) ctx.db.patch(c._id, { paused, version: c.version + 1, updatedAt: ctx.now });
        return { name, paused };
      },
    }),

    /**
     * Kill switch of a branch, or resume it: installs the branch serves (on every channel, as its branch or as its
     * rollout branch) get `noUpdateAvailable`; installs of those channels on another branch keep updating.
     */
    setBranchPaused: mutation({
      args: { name: v.string(), paused: v.boolean() },
      errors: [expoUpdatesErrors.UnknownBranch],
      handler: (ctx, { name, paused }) => {
        const b = branchByName(ctx, name);
        if (!b) throw expoUpdatesErrors.UnknownBranch({ name });
        if (b.paused !== paused) {
          ctx.db.patch(b._id, { paused, updatedAt: ctx.now });
          bumpChannelsOf(ctx, name);
        }
        return { name, paused };
      },
    }),

    /** Channels and branches (up to 200 each), for `ember expo list`. */
    list: query({
      args: {},
      handler: (ctx) => ({
        channels: ctx.db.query("channels").withIndex("by_name").take(200).map(({ _id, _creationTime, ...c }) => c),
        branches: ctx.db.query("branches").withIndex("by_name").take(200).map(({ _id, _creationTime, ...b }) => b),
      }),
    }),

    /** The newest updates of a branch (all platforms), newest first. */
    updates: query({
      args: { branch: v.optional(v.string()), paginationOpts: paginationOptsValidator },
      handler: (ctx, { branch, paginationOpts }) => {
        const q = branch !== undefined ? ctx.db.query("updates").withIndex("by_branch", (r) => r.eq("branch", branch)) : ctx.db.query("updates").withIndex("by_created");
        const page = q.order("desc").paginate(paginationOpts);
        return { ...page, page: page.page.map(summary) };
      },
    }),
  },

  /** What the routes read (internal: never part of the component's API). */
  http: {
    /** A channel's plan for one (platform, runtime version): cached at the edge, resolved per install in the Worker. */
    plan: internalQuery({
      args: { channel: v.string(), platform: vPlatform, runtimeVersion: v.string() },
      handler: (ctx, a): Plan => {
        const c = channelByName(ctx, a.channel);
        if (!c) return { channel: a.channel, found: false, version: 0, paused: false, branch: null, rollout: null };
        const branchPlan = (name: string): BranchPlan => {
          const b = branchByName(ctx, name);
          const [head, control] = liveRows(ctx, name, a.platform, a.runtimeVersion, 2);
          return { name, paused: b?.paused ?? false, head: head ? planEntry(head) : null, control: head && head.rolloutPercent < 100 && control ? planEntry(control) : null };
        };
        return {
          channel: c.name,
          found: true,
          version: c.version,
          paused: c.paused,
          branch: c.paused ? null : branchPlan(c.branch),
          rollout: !c.paused && c.rolloutBranch && (c.rolloutPercent ?? 0) > 0 ? { percent: c.rolloutPercent!, branch: branchPlan(c.rolloutBranch) } : null,
        };
      },
    }),
    /** An asset by content address. */
    asset: internalQuery({
      args: { sha256: v.string() },
      handler: (ctx, { sha256 }) => {
        const a = ctx.db.query("assets").withIndex("by_sha", (q) => q.eq("sha256", sha256)).unique();
        return a ? { file: a.file as string, contentType: a.contentType, size: a.size } : null;
      },
    }),
  },
};

function planEntry(r: { uuid: string; kind: "update" | "rollBackToEmbedded"; createdAt: number; rolloutPercent: number; runtimeVersion: string; launchAsset?: StoredAsset; assets: StoredAsset[]; metadata: Record<string, string>; extra?: unknown }): PlanEntry {
  if (r.kind === "rollBackToEmbedded" || !r.launchAsset) return { kind: "rollBackToEmbedded", uuid: r.uuid, createdAt: r.createdAt, rolloutPercent: 100 };
  return { kind: "update", uuid: r.uuid, createdAt: r.createdAt, runtimeVersion: r.runtimeVersion, launchAsset: r.launchAsset, assets: r.assets, metadata: r.metadata, extra: r.extra ?? {}, rolloutPercent: r.rolloutPercent };
}

function summary(r: { uuid: string; group: string; branch: string; platform: Platform; runtimeVersion: string; kind: string; message?: string; assets: StoredAsset[]; rolloutPercent: number; rolledBack: boolean; rollbackOf?: string; republishOf?: string; createdAt: number }) {
  return {
    id: r.uuid,
    group: r.group,
    branch: r.branch,
    platform: r.platform,
    runtimeVersion: r.runtimeVersion,
    kind: r.kind,
    message: r.message ?? null,
    assets: r.kind === "update" ? r.assets.length + 1 : 0,
    rolloutPercent: r.rolloutPercent,
    rolledBack: r.rolledBack,
    rollbackOf: r.rollbackOf ?? null,
    republishOf: r.republishOf ?? null,
    createdAt: r.createdAt,
  };
}

// ------------------------------------------------------------------------------------------------ HTTP

type EdgeCache = { match(key: Request): Promise<Response | undefined>; put(key: Request, res: Response): Promise<void> };
/** `caches.default` in workerd; none elsewhere (Node tests, `ember dev` without it): the routes then run uncached. */
const edgeCache = (): EdgeCache | null => (globalThis as { caches?: { default?: EdgeCache } }).caches?.default ?? null;
const CACHED_AT = "x-ember-cached-at";
const text = (status: number, body: string, headers: Record<string, string> = {}) => new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...headers } });

/** Probes for tests: what each request did (plan from the cache or the shard, response from the cache or rendered). */
export const expoUpdatesProbes = { planFetches: 0, renders: 0, assetFetches: 0 };

/** A short digest of a PEM (cached in the isolate): the signing key's identity in the response cache key. */
const digests = new Map<string, Promise<string>>();
function keyDigest(pem: string): Promise<string> {
  let d = digests.get(pem);
  if (!d) {
    d = crypto.subtle.digest("SHA-256", new TextEncoder().encode(pem)).then((b) => [...new Uint8Array(b).subarray(0, 8)].map((x) => x.toString(16).padStart(2, "0")).join(""));
    if (digests.size >= 8) digests.delete(digests.keys().next().value!);
    digests.set(pem, d);
  }
  return d;
}

const PLAN = unsafeRef<"query">("http:plan");
const ASSET = unsafeRef<"query">("http:asset");

const manifestAction = httpAction(async (ctx, request) => {
  const config = ctx.component.config ?? {};
  let req: UpdateRequest;
  try {
    req = parseUpdateRequest(request.headers, config.defaultChannel === undefined ? DEFAULT_CHANNEL : config.defaultChannel);
  } catch (e) {
    if (e instanceof ProtocolError) return text(e.status, e.message);
    throw e;
  }
  if (!req.channel) return text(400, "expo-channel-name is required");
  const url = new URL(request.url);
  const assetsBase = config.assetsUrl ?? `${url.origin}${url.pathname.replace(/\/manifest\/?$/, "")}/assets`;
  // `key` joins the base's own query (`?region=eu`) instead of starting a second one.
  const assetsTemplate = new URL(assetsBase, url);
  const assetUrl = (sha: string) => {
    const u = new URL(assetsTemplate);
    u.searchParams.set("key", sha);
    return u.href;
  };
  const cacheConf = config.cache === false ? null : (config.cache ?? {});
  const edge = cacheConf ? edgeCache() : null;
  const planTtl = Math.max(0, cacheConf?.planTtlSeconds ?? DEFAULT_PLAN_TTL_S);
  const responseTtl = Math.max(1, cacheConf?.responseTtlSeconds ?? DEFAULT_RESPONSE_TTL_S);
  const base = `${url.origin}/__ember/expo-updates${url.pathname}`;
  const q = (o: Record<string, string>) => new URLSearchParams(o).toString();

  // 1. The channel's plan for (platform, runtime version): the edge copy while younger than planTtl, else the shard.
  const planKey = new Request(`${base}/plan?${q({ ch: req.channel, p: req.platform, rv: req.runtimeVersion })}`);
  let plan: Plan | null = null;
  let planState = "MISS";
  if (edge && planTtl > 0) {
    const hit = await edge.match(planKey).catch(() => undefined);
    if (hit && Date.now() - Number(hit.headers.get(CACHED_AT) ?? 0) < planTtl * 1000) {
      plan = (await hit.json()) as Plan;
      planState = "HIT";
    }
  }
  if (!plan) {
    expoUpdatesProbes.planFetches++;
    // Stamped with the time the read started: the copy is never older than its stamp says (a write that commits while
    // the read runs is visible within planTtl of it, not planTtl plus the read).
    const readAt = Date.now();
    plan = (await ctx.runQuery(PLAN, { channel: req.channel, platform: req.platform, runtimeVersion: req.runtimeVersion })) as Plan;
    if (edge && planTtl > 0) {
      await edge.put(planKey, new Response(JSON.stringify(plan), { headers: { "content-type": "application/json", "cache-control": `public, max-age=${planTtl}`, [CACHED_AT]: String(readAt) } })).catch(() => undefined);
    }
  }

  // 2. This install's outcome: its rollout sides (not its id) and what it already runs decide it.
  const { outcome, sides } = resolvePlan(plan, req.clientId);
  const final = finalOutcome(outcome, req);
  const what = final.type === "update" ? `u:${final.update.uuid}` : final.type === "rollBackToEmbedded" ? `r:${final.commitTime}` : "n";
  // A signed response is keyed by the key that signed it too: replacing the PEM (same key id) never serves the old
  // signature. `-` when no key is set (only bodies that need no signature are rendered then).
  const secretName = config.signing?.privateKeySecret ?? DEFAULT_SIGNING_SECRET;
  const pemValue = req.expectSignature ? ctx.env[secretName] : undefined;
  const pem = typeof pemValue === "string" && pemValue ? pemValue : null;
  const keyId = config.signing?.keyId ?? "main";
  const signedBy = !req.expectSignature ? "0" : pem ? `${keyId}:${await keyDigest(pem)}` : "-";
  const responseKey = new Request(
    `${base}/response?${q({ ch: req.channel, p: req.platform, rv: req.runtimeVersion, v: String(plan.version), b: sides, o: what, proto: String(req.protocolVersion), fmt: req.mediaType, sig: signedBy, a: assetsBase })}`,
  );
  const send = (r: RenderedResponse, state: string) => new Response(r.body, { status: r.status, headers: { ...r.headers, "x-ember-cache": state, "x-ember-plan-cache": planState } });
  if (edge) {
    const hit = await edge.match(responseKey).catch(() => undefined);
    if (hit) return send((await hit.json()) as RenderedResponse, "HIT");
  }

  // 3. Render (and sign) it once per key.
  let rendered: RenderedResponse;
  try {
    expoUpdatesProbes.renders++;
    rendered = await renderResponse(final, req, { assetUrl, signer: pem ? rsaSigner(pem, keyId) : null });
  } catch (e) {
    if (e instanceof SigningKeyMissing) return text(500, `${e.message}: set the ${secretName} secret (\`ember env set ${secretName}\`)`);
    throw e;
  }
  if (edge) {
    await edge.put(responseKey, new Response(JSON.stringify(rendered), { headers: { "content-type": "application/json", "cache-control": `public, max-age=${responseTtl}` } })).catch(() => undefined);
  }
  return send(rendered, "MISS");
});

const assetsAction = httpAction(async (ctx, request) => {
  const url = new URL(request.url);
  const key = (url.searchParams.get("key") ?? "").toLowerCase();
  if (!isSha256Hex(key)) return text(400, "key must be the asset's hex SHA-256");
  const edge = edgeCache();
  const cacheKey = new Request(`${url.origin}/__ember/expo-updates${url.pathname}/${key}`);
  if (edge) {
    const hit = await edge.match(cacheKey).catch(() => undefined);
    if (hit) {
      const res = new Response(hit.body, hit);
      res.headers.set("x-ember-cache", "HIT");
      return res;
    }
  }
  expoUpdatesProbes.assetFetches++;
  const a = (await ctx.runQuery(ASSET, { sha256: key })) as { file: string; contentType: string; size: number } | null;
  const file = a ? await ctx.storage.get(a.file) : null;
  if (!a || !file) return text(404, "unknown asset");
  // Content-addressed (the URL is the SHA-256): never changes, cached for a year at the edge and on the device.
  const headers = { "content-type": a.contentType, "content-length": String(file.size), "cache-control": "public, max-age=31536000, immutable", etag: `"${key}"` };
  // Streamed, never buffered (an asset may be larger than the isolate's memory): the R2 stream fills the edge cache,
  // and the response is that cache entry; without a cache, or when the put fails (too large for it), a fresh stream.
  if (edge) {
    const put = await edge.put(cacheKey, new Response(file.body, { headers })).then(
      () => true,
      () => false,
    );
    const cached = put ? await edge.match(cacheKey).catch(() => undefined) : undefined;
    if (cached) {
      const res = new Response(cached.body, cached);
      res.headers.set("x-ember-cache", "MISS");
      return res;
    }
    const again = await ctx.storage.get(a.file);
    if (!again) return text(404, "unknown asset");
    return new Response(again.body, { headers: { ...headers, "x-ember-cache": "MISS" } });
  }
  return new Response(file.body, { headers: { ...headers, "x-ember-cache": "MISS" } });
});

const http = httpRouter()
  .route({ path: "/manifest", method: "GET", handler: manifestAction })
  .route({ path: "/assets", method: "GET", handler: assetsAction });

// ------------------------------------------------------------------------------------------------ dashboard

/** What the dashboard's screen reads (module `dashboard`, internal). Every read is an index range. */
const dashboardFunctions = {
  overview: internalQuery({
    args: {},
    handler: (ctx) => {
      const count = (n: number) => (n > 1000 ? "1000+" : n);
      return {
        channels: count(ctx.db.query("channels").take(1001).length),
        branches: count(ctx.db.query("branches").take(1001).length),
        updates: count(ctx.db.query("updates").take(1001).length),
        assets: count(ctx.db.query("assets").take(1001).length),
        paused: count(ctx.db.query("channels").withIndex("by_paused", (q) => q.eq("paused", true)).take(1001).length),
      };
    },
  }),
  channels: internalQuery({
    args: { paginationOpts: paginationOptsValidator },
    handler: (ctx, { paginationOpts }) => {
      const page = ctx.db.query("channels").withIndex("by_name").paginate(paginationOpts);
      return { ...page, page: page.page.map((c) => ({ name: c.name, branch: c.branch, rolloutBranch: c.rolloutBranch ?? null, rolloutPercent: c.rolloutPercent ?? null, paused: c.paused, version: c.version, updatedAt: c.updatedAt })) };
    },
  }),
  branches: internalQuery({
    args: { paginationOpts: paginationOptsValidator },
    handler: (ctx, { paginationOpts }) => {
      const page = ctx.db.query("branches").withIndex("by_name").paginate(paginationOpts);
      return { ...page, page: page.page.map((b) => ({ name: b.name, paused: b.paused, createdAt: b.createdAt, updatedAt: b.updatedAt })) };
    },
  }),
  updates: internalQuery({
    args: { branch: v.optional(v.string()), paginationOpts: paginationOptsValidator },
    handler: (ctx, { branch, paginationOpts }) => {
      const q = branch !== undefined ? ctx.db.query("updates").withIndex("by_branch", (r) => r.eq("branch", branch)) : ctx.db.query("updates").withIndex("by_created");
      const page = q.order("desc").paginate(paginationOpts);
      return { ...page, page: page.page.map(summary) };
    },
  }),
  /** One update with its manifest (asset URLs relative to the install's mount) and assets. */
  update: internalQuery({
    args: { id: v.string() },
    handler: (ctx, { id }) => {
      const r = ctx.db.query("updates").withIndex("by_uuid", (q) => q.eq("uuid", id.toLowerCase())).first();
      if (!r) return null;
      const entry = planEntry(r);
      const prefix = `/${ctx.component.name}`;
      return {
        ...summary(r),
        manifest: entry.kind === "update" ? buildManifest(entry, (sha) => `${prefix}/assets?key=${sha}`) : { type: "rollBackToEmbedded", parameters: { commitTime: new Date(r.createdAt).toISOString() } },
        assetList: r.kind === "update" && r.launchAsset ? [{ ...r.launchAsset, launch: true }, ...r.assets.map((x) => ({ ...x, launch: false }))] : [],
      };
    },
  }),
};

export const expoUpdates = defineComponent({
  name: "expoUpdates",
  schema,
  functions: { ...functions, dashboard: dashboardFunctions },
  config: configValidator,
  http,
  dashboard: {
    label: "Expo updates",
    icon: "flag",
    scope: "global",
    description: "Over-the-air updates served with the Expo Updates protocol: channels, branches, rollouts, rollbacks and the kill switch. Changes reach every edge location within the plan cache TTL (30 s by default).",
    tabs: [
      {
        id: "channels",
        label: "Channels",
        blocks: [
          {
            kind: "stats",
            id: "overview",
            query: dashboardFunctions.overview,
            items: [
              { label: "Channels", path: "channels", format: "number" },
              { label: "Paused channels", path: "paused", format: "number" },
              { label: "Branches", path: "branches", format: "number" },
              { label: "Updates", path: "updates", format: "number" },
              { label: "Assets", path: "assets", format: "number" },
            ],
          },
          {
            kind: "table",
            id: "channels",
            query: dashboardFunctions.channels,
            rowKey: "name",
            columns: [
              { label: "Channel", path: "name", format: "code" },
              { label: "Branch", path: "branch", format: "code" },
              { label: "Rollout branch", path: "rolloutBranch", format: "code" },
              { label: "Rollout %", path: "rolloutPercent", format: "number" },
              { label: "Paused", path: "paused", format: "boolean" },
              { label: "Version", path: "version", format: "number" },
              { label: "Updated", path: "updatedAt", format: "ago" },
            ],
            rowActions: [
              { id: "kill", label: "Kill switch", fn: functions.lib.setChannelPaused, fromRow: { name: "name" }, args: { paused: true }, destructive: true, description: "Every client of this channel gets noUpdateAvailable and keeps the update it runs." },
              { id: "resume", label: "Resume", fn: functions.lib.setChannelPaused, fromRow: { name: "name" }, args: { paused: false } },
              { id: "edit", label: "Point / branch rollout…", fn: functions.lib.setChannel, fromRow: { name: "name" }, description: "Point the channel at a branch, optionally with a percentage of installs on a second branch (rolloutBranch null clears it)." },
            ],
          },
          { kind: "actions", id: "newChannel", label: "New channel", actions: [{ id: "create", label: "Create or point a channel…", fn: functions.lib.setChannel }] },
        ],
      },
      {
        id: "branches",
        label: "Branches",
        blocks: [
          {
            kind: "table",
            id: "branches",
            query: dashboardFunctions.branches,
            rowKey: "name",
            columns: [
              { label: "Branch", path: "name", format: "code" },
              { label: "Paused", path: "paused", format: "boolean" },
              { label: "Created", path: "createdAt", format: "date" },
              { label: "Updated", path: "updatedAt", format: "ago" },
            ],
            rowActions: [
              { id: "rollout", label: "Rollout %…", fn: functions.lib.setRollout, fromRow: { branch: "name" }, description: "Percentage of installs that get the head update in a partial rollout (100 ends it)." },
              { id: "rollback", label: "Roll back…", fn: functions.lib.rollback, fromRow: { branch: "name" }, destructive: true, description: "Takes the head out: clients get the previous update again (or the embedded one with toEmbedded)." },
              { id: "kill", label: "Kill switch", fn: functions.lib.setBranchPaused, fromRow: { name: "name" }, args: { paused: true }, destructive: true, description: "Installs this branch serves get noUpdateAvailable, on every channel that points at it (also as a rollout branch); installs on a channel's other branch keep updating. To stop a whole channel, use its kill switch." },
              { id: "resume", label: "Resume", fn: functions.lib.setBranchPaused, fromRow: { name: "name" }, args: { paused: false } },
            ],
          },
        ],
      },
      {
        id: "updates",
        label: "Updates",
        blocks: [
          {
            kind: "table",
            id: "updates",
            query: dashboardFunctions.updates,
            rowKey: "id",
            columns: [
              { label: "Created", path: "createdAt", format: "date" },
              { label: "Branch", path: "branch", format: "code" },
              { label: "Platform", path: "platform", format: "badge" },
              { label: "Runtime", path: "runtimeVersion", format: "code" },
              { label: "Kind", path: "kind", format: "badge" },
              { label: "Rollout %", path: "rolloutPercent", format: "number" },
              { label: "Rolled back", path: "rolledBack", format: "boolean" },
              { label: "Message", path: "message" },
              { label: "Id", path: "id", format: "code" },
            ],
            detail: {
              query: dashboardFunctions.update,
              fromRow: { id: "id" },
              sections: [
                {
                  kind: "kv",
                  items: [
                    { label: "Id", path: "id", format: "code" },
                    { label: "Group", path: "group", format: "code" },
                    { label: "Branch", path: "branch", format: "code" },
                    { label: "Platform", path: "platform", format: "badge" },
                    { label: "Runtime version", path: "runtimeVersion", format: "code" },
                    { label: "Rollout %", path: "rolloutPercent", format: "number" },
                    { label: "Rolled back", path: "rolledBack", format: "boolean" },
                    { label: "Rollback of", path: "rollbackOf", format: "code" },
                    { label: "Republishes", path: "republishOf", format: "code" },
                    { label: "Created", path: "createdAt", format: "date" },
                  ],
                },
                { kind: "json", path: "manifest" },
                { kind: "json", path: "assetList" },
              ],
            },
            rowActions: [
              { id: "rollout", label: "Rollout %…", fn: functions.lib.setRollout, fromRow: { branch: "branch", platform: "platform", runtimeVersion: "runtimeVersion" } },
              { id: "rollback", label: "Roll back", fn: functions.lib.rollback, fromRow: { branch: "branch", platform: "platform", runtimeVersion: "runtimeVersion" }, destructive: true, description: "Takes the head of this branch, platform and runtime version out of service." },
            ],
          },
        ],
      },
    ],
  },
});

