import { flattenFunctions } from "@freecorps/ember-server";
import { ActionRunner, type ShardApi } from "./actions.ts";
import { indexEnv, isValidShardName, resolvedCrons, setEmberConfig, type ActionJobMessage, type EmberConfig, type EmberEnv } from "./config.ts";
import type { Identity } from "./engine-types.ts";
import { handleR2Event, handleStorageRequest, isR2Event, type FileRpc, type R2EventMessage, type StorageDeps } from "./files.ts";
import { deliverIndexBatch, isIndexMessage, type ExternalIndexRpc, type IndexMessage } from "./ai-indexes.ts";
import { recordCall } from "./metrics.ts";
import type { MutationOutcome, ShardStatus } from "./shard.ts";
import { shardStub } from "./stubs.ts";
import type { System } from "./system.ts";
import { parse, stringify } from "./wire.ts";

export interface EmberWorker {
  fetch(request: Request, env: EmberEnv, ctx: ExecutionContext): Promise<Response>;
  scheduled(controller: ScheduledController, env: EmberEnv, ctx: ExecutionContext): Promise<void>;
  /**
   * Queue consumer: action jobs (`EMBER_ACTIONS`), R2 event notifications of the files bucket (object-create
   * confirms uploads, PLAN §7) and external-index deliveries (`EMBER_INDEXING`, PLAN §6). Messages are told apart
   * by shape.
   */
  queue(batch: MessageBatch<ActionJobMessage | R2EventMessage | IndexMessage>, env: EmberEnv, ctx: ExecutionContext): Promise<void>;
}

/** `GET /api/_ember/status` response. */
export interface StatusResponse {
  ok: true;
  expectedVersion: string;
  shards: ShardStatus[];
}

const json = (body: unknown, status = 200) =>
  new Response(stringify(body), { status, headers: { "content-type": "application/json" } });

const error = (status: number, code: string, message: string) => json({ ok: false, error: { code, message } }, status);

function bearer(request: Request, url: URL): string | null {
  const h = request.headers.get("authorization");
  if (h?.toLowerCase().startsWith("bearer ")) return h.slice(7).trim() || null;
  return url.searchParams.get("token");
}

function knownShardKinds(config: EmberConfig): Set<string> | null {
  const s = config.schema.manifest.shards;
  if (!s) return null;
  return new Set(Array.isArray(s) ? s : Object.keys(s));
}

/** Constant-time string comparison (admin token). */
function sameSecret(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

const MAX_STATUS_SHARDS = 50;

/**
 * Build the Worker entry. Usage in the user's worker module:
 *
 *   export { Shard, System } from "@freecorps/ember-runtime";
 *   export default createEmberWorker({ schema, functions, crons });
 */
export function createEmberWorker(config: EmberConfig): EmberWorker {
  setEmberConfig(config);
  const kinds = knownShardKinds(config);
  const manifest = config.schema.manifest;

  const checkShard = (shard: unknown): string | null => {
    if (typeof shard !== "string" || !isValidShardName(shard)) return null;
    if (kinds && kinds.size && !kinds.has(shard.slice(0, shard.indexOf(":"))) && !shard.startsWith("global:")) return null;
    return shard;
  };

  const stub = (env: EmberEnv, shard: string) => shardStub(env, manifest, shard);
  const actions = (env: EmberEnv) => new ActionRunner(config, env, (shard) => stub(env, shard) as unknown as ShardApi);
  const storageDeps = (env: EmberEnv): StorageDeps => ({ env, checkShard, rpc: (shard) => stub(env, shard) as unknown as FileRpc });

  /** undefined = no token; null = invalid token (or, with `sensitive`, a session that is gone). */
  const verify = async (token: string | null, sensitive = false): Promise<Identity | null | undefined> => {
    if (!token) return undefined;
    if (!config.auth) return null;
    try {
      return (await (sensitive ? config.auth.verify(token, { sensitive: true }) : config.auth.verify(token))) ?? null;
    } catch {
      return null;
    }
  };
  let fns: ReturnType<typeof flattenFunctions> | null = null;
  /** `sensitive: true` mutations/actions verify against the Auth DO (PLAN §9: revocation is immediate). */
  const isSensitive = (fn: string) => {
    fns ??= flattenFunctions(config.functions);
    const f = fns.get(fn);
    return !!f && f.type !== "httpAction" && f.sensitive === true;
  };

  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      if (url.pathname === "/health") return json({ ok: true });

      if (url.pathname === "/ws") {
        if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return error(426, "upgrade_required", "expected websocket");
        const shard = checkShard(url.searchParams.get("shard"));
        if (!shard) return error(400, "bad_shard", "expected ?shard=<kind>:<key>");
        const s = stub(env, shard);
        // Pre-warm the shard (cold wake ~60 ms, R8) in parallel with token verification.
        const [identity] = await Promise.all([verify(bearer(request, url)), s.warm(shard).catch(() => undefined)]);
        if (identity === null) return error(401, "unauthenticated", "invalid token");
        const headers = new Headers(request.headers);
        for (const k of [...headers.keys()]) if (k.startsWith("x-ember-")) headers.delete(k);
        headers.set("x-ember-shard", shard);
        if (identity) {
          headers.set("x-ember-identity", JSON.stringify(identity));
          // The Shard keeps the token to re-check the session for `sensitive` mutations.
          headers.set("x-ember-token", bearer(request, url)!);
        }
        return s.fetch(new Request(request.url, { headers }));
      }

      if (url.pathname.startsWith("/api/storage/")) return (await handleStorageRequest(request, url, storageDeps(env)))!;

      if (url.pathname.startsWith("/api/_ember/")) {
        if (request.method !== "GET") return error(405, "method_not_allowed", "use GET");
        const admin = typeof env.EMBER_ADMIN_TOKEN === "string" ? env.EMBER_ADMIN_TOKEN : "";
        if (!admin) return error(403, "admin_disabled", "set the EMBER_ADMIN_TOKEN secret on the Worker to enable admin endpoints");
        const token = request.headers.get("authorization")?.replace(/^bearer\s+/i, "").trim() ?? "";
        if (!token || !sameSecret(token, admin)) return error(401, "unauthenticated", "invalid admin token");
        if (url.pathname === "/api/_ember/data") {
          // Read-only data browser: no `table` lists tables; `cursor` pages by row id (admin.ts).
          const shard = url.searchParams.get("shard") ?? "global:main";
          if (!isValidShardName(shard)) return error(400, "bad_shard", `invalid shard ${JSON.stringify(shard)}`);
          const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined;
          const r = await stub(env, shard).browse(shard, url.searchParams.get("table"), url.searchParams.get("cursor"), limit);
          return json(r, r.ok ? 200 : r.error.code === "not_found" ? 404 : 400);
        }
        if (url.pathname === "/api/_ember/crons") {
          const state = env.SYSTEM ? await (env.SYSTEM.get(env.SYSTEM.idFromName("system")) as unknown as DurableObjectStub<System>).state() : [];
          const byName = new Map(state.map((c) => [c.name, c]));
          return json({ ok: true, crons: resolvedCrons(config).map((c) => ({ ...c, state: byName.get(c.name) ?? null })) });
        }
        if (url.pathname !== "/api/_ember/status") return error(404, "not_found", "not found");
        const names = url.searchParams.getAll("shard");
        if (!names.length) names.push("global:main");
        if (names.length > MAX_STATUS_SHARDS) return error(400, "bad_request", `at most ${MAX_STATUS_SHARDS} shards per call`);
        for (const n of names) if (!isValidShardName(n)) return error(400, "bad_shard", `invalid shard ${JSON.stringify(n)}`);
        const shards = await Promise.all([...new Set(names)].map((n) => stub(env, n).status(n)));
        const body: StatusResponse = { ok: true, expectedVersion: manifest.version, shards };
        return json(body);
      }

      if (url.pathname === "/api/query" || url.pathname === "/api/mutation" || url.pathname === "/api/action") {
        if (request.method !== "POST") return error(405, "method_not_allowed", "use POST");
        let body: Record<string, unknown>;
        try {
          const b = parse(await request.text());
          if (!b || typeof b !== "object" || Array.isArray(b)) throw new Error();
          body = b as Record<string, unknown>;
        } catch {
          return error(400, "bad_request", "body must be a JSON object {fn, args, shard}");
        }
        const shard = checkShard(body.shard);
        if (!shard) return error(400, "bad_shard", "shard must be <kind>:<key>");
        if (typeof body.fn !== "string" || !body.fn) return error(400, "bad_request", "fn must be a string");
        const args = body.args ?? {};
        if (typeof args !== "object" || args === null || Array.isArray(args)) return error(400, "bad_request", "args must be an object");

        if (url.pathname === "/api/action") {
          // Actions run here, in the Worker; they reach shards through ctx.runQuery/runMutation (RPC).
          const identity = await verify(bearer(request, url), isSensitive(body.fn));
          if (identity === null) return error(401, "unauthenticated", "invalid token");
          const out = await actions(env).run(body.fn, args, shard, identity ?? null);
          return out.ok ? json({ ok: true, value: out.value }) : json(out, 400);
        }

        const s = stub(env, shard);
        const sensitive = url.pathname === "/api/mutation" && isSensitive(body.fn);
        const [identity] = await Promise.all([verify(bearer(request, url), sensitive), s.warm(shard).catch(() => undefined)]);
        if (identity === null) return error(401, "unauthenticated", "invalid token");
        // Wall time around the RPC (the DO's own clock does not advance during synchronous SQLite work): metrics.ts.
        const kind = url.pathname === "/api/query" ? "query" : "mutation";
        const t0 = performance.now();
        const out: MutationOutcome =
          kind === "query" ? await s.query(shard, body.fn, args, identity ?? null, false, { caller: true }) : await s.mutation(shard, body.fn, args, identity ?? null, false, { caller: true });
        recordCall(env, kind, body.fn, shard, out, performance.now() - t0);
        const { metrics: _m, ...reply } = out;
        return json(reply, out.ok ? 200 : 400);
      }

      // Auth routes (`/api/auth/*` with @freecorps/ember-auth): the hook returns null for paths it does not own.
      const authResponse = config.auth?.fetch ? await config.auth.fetch(request, env) : null;
      if (authResponse) return authResponse;

      return error(404, "not_found", "not found");
    },

    async scheduled(controller, env, ctx) {
      if (!resolvedCrons(config).length || !env.SYSTEM) return;
      const system = env.SYSTEM.get(env.SYSTEM.idFromName("system")) as unknown as DurableObjectStub<System>;
      ctx.waitUntil(system.tick(controller.scheduledTime));
    },

    async queue(batch, env) {
      const runner = actions(env);
      for (const msg of batch.messages) {
        if (isIndexMessage(msg.body)) {
          const body = msg.body;
          if (!isValidShardName(body.shard)) {
            msg.ack();
            continue;
          }
          try {
            await deliverIndexBatch({ env: indexEnv(config, env), rpc: (shard) => stub(env, shard) as unknown as ExternalIndexRpc }, body);
            msg.ack();
          } catch (e) {
            console.error(`ember: indexing ${body.table}.${body.index} (${body.ids.length} docs, ${body.shard}) failed: ${(e as Error).message}`);
            msg.retry({ delaySeconds: Math.min(300, 5 * 2 ** Math.min(6, msg.attempts - 1)) });
          }
          continue;
        }
        if (isR2Event(msg.body)) {
          try {
            await handleR2Event(msg.body, storageDeps(env));
            msg.ack();
          } catch (e) {
            console.error(`ember: R2 event for ${msg.body.object.key} failed: ${(e as Error).message}`);
            msg.retry();
          }
          continue;
        }
        const job = msg.body as ActionJobMessage;
        if (!job || typeof job.fn !== "string" || typeof job.shard !== "string" || !isValidShardName(job.shard)) {
          msg.ack(); // malformed: retrying cannot help
          continue;
        }
        const out = await runner.run(job.fn, job.args ?? {}, job.shard, null, { internal: true });
        if (out.ok) msg.ack();
        else {
          console.error(`ember: action job ${job.jobId} (${job.fn}) failed: ${out.error.code}: ${out.error.message}`);
          msg.retry();
        }
      }
    },
  };
}
