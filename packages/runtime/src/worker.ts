import { componentQueueName, composeApp, cronList, flattenFunctions, hookShard, matchRoute, type ComposedQueue, type InboundEmailMessage } from "@freecorps/ember-server";
import { ActionRunner, type ShardApi } from "./actions.ts";
import { indexEnv, isValidShardName, resolvedCrons, setEmberConfig, type ActionJobMessage, type EmberConfig, type EmberEnv } from "./config.ts";
import type { Identity } from "./engine-types.ts";
import { handleR2Event, handleStorageRequest, isR2Event, type FileRpc, type R2EventMessage, type StorageDeps } from "./files.ts";
import { deliverIndexBatch, isIndexMessage, type ExternalIndexRpc, type IndexMessage } from "./ai-indexes.ts";
import { recordCall } from "./metrics.ts";
import { handleRestoreRequest, type RestoreRpc } from "./restore.ts";
import type { MutationOutcome, ShardStatus } from "./shard.ts";
import { shardStub, systemStub } from "./stubs.ts";
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
  /**
   * Email Routing (`email()` handler): handed to the first installed component whose `email` hook matches the
   * recipient (contracts.md "Componentes", hooks); no match → rejected.
   */
  email(message: InboundEmailMessage, env: EmberEnv, ctx: ExecutionContext): Promise<void>;
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
/** Secrets the reveal endpoint refuses besides EMBER_*: BETTER_AUTH_SECRET is the auth secret's legacy name (packages/auth). */
const NEVER_REVEALED = new Set(["BETTER_AUTH_SECRET"]);

/**
 * Build the Worker entry. Usage in the user's worker module:
 *
 *   export { Shard, System } from "@freecorps/ember-runtime";
 *   export default createEmberWorker({ schema, functions, crons });
 */
export function createEmberWorker(input: EmberConfig): EmberWorker {
  // Components (PLAN §12): one composed schema + function map; the Shard, System and actions only see this.
  const composed = composeApp({ schema: input.schema, functions: input.functions, app: input.app ?? null, http: input.http ?? null });
  const config: EmberConfig = {
    ...input,
    schema: composed.schema,
    functions: composed.functions,
    routes: composed.routes,
    // Crons declared by components run next to the app's (System DO, one Cron Trigger).
    ...(composed.crons.length ? { crons: [...cronList(input.crons), ...composed.crons] } : {}),
    componentQueues: composed.queues,
    emailHooks: composed.email,
  };
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
  const componentQueueFor = (name: string, env: EmberEnv): ComposedQueue | undefined => {
    if (!config.componentQueues?.length) return undefined;
    const project = typeof env.EMBER_PROJECT === "string" ? env.EMBER_PROJECT : "";
    const envName = typeof env.EMBER_ENV === "string" ? env.EMBER_ENV : "";
    return config.componentQueues.find((q) => componentQueueName(project, envName, q.queue) === name);
  };

  let fns: ReturnType<typeof flattenFunctions> | null = null;
  /** `sensitive: true` mutations/actions verify against the Auth DO (PLAN §9: revocation is immediate). */
  const isSensitive = (fn: string) => {
    fns ??= flattenFunctions(config.functions);
    const f = fns.get(fn);
    return !!f && f.type !== "httpAction" && f.sensitive === true;
  };

  return {
    async fetch(request, env, ctx) {
      const url = new URL(request.url);
      if (url.pathname === "/health") return json({ ok: true });

      if (url.pathname === "/ws") {
        if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return error(426, "upgrade_required", "expected websocket");
        const shard = checkShard(url.searchParams.get("shard"));
        if (!shard) return error(400, "bad_shard", "expected ?shard=<kind>:<key>");
        const s = stub(env, shard);
        // Pre-warm: with a token in the upgrade, wake the shard (cold wake ~60 ms, R8) while it is verified. Not
        // awaited: the upgrade queues behind the boot anyway, so waiting would only add a Worker→DO round trip.
        // (Clients send the token in `hello`: the upgrade itself is what wakes the shard, in parallel with the
        // client's token fetch — see EmberClientOptions.pipelineConnect.)
        const tok = bearer(request, url);
        if (tok) ctx.waitUntil(s.warm(shard).catch(() => undefined));
        const identity = await verify(tok);
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
        const admin = typeof env.EMBER_ADMIN_TOKEN === "string" ? env.EMBER_ADMIN_TOKEN : "";
        if (!admin) return error(403, "admin_disabled", "set the EMBER_ADMIN_TOKEN secret on the Worker to enable admin endpoints");
        const token = request.headers.get("authorization")?.replace(/^bearer\s+/i, "").trim() ?? "";
        if (!token || !sameSecret(token, admin)) return error(401, "unauthenticated", "invalid admin token");
        // Point-in-time recovery: list / record bookmarks, restore (restore.ts).
        const pitr = await handleRestoreRequest(request, url, (s) => stub(env, s) as unknown as RestoreRpc, isValidShardName, systemStub(env));
        if (pitr) return pitr;
        if (url.pathname === "/api/_ember/keys/rotate") {
          if (request.method !== "POST") return error(405, "method_not_allowed", "use POST");
          if (!config.auth?.rotateKeys) return error(404, "not_found", "this deployment has no local Auth DO (SSO or no auth): nothing to rotate");
          const jwks = await config.auth.rotateKeys(env);
          return json({ ok: true, kids: jwks.keys.map((k) => k.kid) });
        }
        if (url.pathname === "/api/_ember/env/reveal") {
          // `ember env get NAME --reveal`: Worker secrets are write-only in the API, so the Worker reads its own
          // binding. Only user names (never EMBER_*: auth secret, admin token, storage keys; nor BETTER_AUTH_SECRET,
          // the legacy name the auth secret is still read from), never cached.
          if (request.method !== "POST") return error(405, "method_not_allowed", "use POST");
          let name: unknown;
          try {
            name = (parse(await request.text()) as { name?: unknown } | null)?.name;
          } catch {
            name = undefined;
          }
          if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return error(400, "bad_request", "body must be { name }");
          if (name.startsWith("EMBER_") || NEVER_REVEALED.has(name)) return error(403, "managed", `${name} is managed by ember and is never revealed`);
          const value = env[name];
          if (typeof value !== "string") return error(404, "not_found", `${name} is not set on this Worker`);
          return new Response(JSON.stringify({ ok: true, name, value }), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
        }
        if (request.method !== "GET") return error(405, "method_not_allowed", "use GET");
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
        // Pre-warm while the token is verified (not awaited: the call below queues behind the boot).
        const tok = bearer(request, url);
        if (tok) ctx.waitUntil(s.warm(shard).catch(() => undefined));
        const identity = await verify(tok, sensitive);
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

      // HTTP routes (ember/http.ts and components), after Ember's own endpoints; auth paths are reserved.
      if (config.routes?.length && !url.pathname.startsWith("/api/auth/")) {
        const hit = matchRoute(config.routes, request.method, url.pathname);
        if (hit && "methodMismatch" in hit) return error(405, "method_not_allowed", `${request.method} is not allowed on ${url.pathname}`);
        if (hit) {
          // Optional auth: a valid bearer token sets ctx.auth; a missing or invalid one runs anonymous (webhooks).
          const identity = (await verify(bearer(request, url))) ?? null;
          return actions(env).runHttp(hit.route, request, identity);
        }
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
      // A component's own queue (`ember-<project>-<env>-<install>-<name>`): the whole batch goes to its handler.
      const own = componentQueueFor(batch.queue, env);
      if (own) {
        try {
          const ctx = runner.scopedCtx(own.scope, hookShard(own.def.shard, own.config));
          await own.def.handler(ctx as never, batch as never);
        } catch (e) {
          console.error(`ember: queue ${batch.queue} (component ${own.scope.join("/")}) failed: ${(e as Error).message}`);
          batch.retryAll();
        }
        return;
      }
      for (const msg of batch.messages) {
        if (isIndexMessage(msg.body)) {
          const body = msg.body;
          if (!isValidShardName(body.shard)) {
            msg.ack();
            continue;
          }
          try {
            const t0 = Date.now();
            const r = await deliverIndexBatch({ env: indexEnv(config, env), rpc: (shard) => stub(env, shard) as unknown as ExternalIndexRpc }, body, {
              retried: msg.attempts > 1,
            });
            msg.ack();
            // EMBER_TRACE: queue delay (message age when delivered) vs. time spent writing to the service.
            if (env.EMBER_TRACE === "1") {
              console.log(`ember:index ${JSON.stringify({ shard: body.shard, index: `${body.table}.${body.index}`, ...r, attempt: msg.attempts, queuedMs: t0 - msg.timestamp.getTime(), deliverMs: Date.now() - t0 })}`);
            }
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

    async email(message, env) {
      const to = String(message.to ?? "").toLowerCase();
      const hook = (config.emailHooks ?? []).find((h) => !h.def.match || h.def.match(to, h.config));
      if (!hook) {
        message.setReject("Address not found");
        return;
      }
      const ctx = actions(env).scopedCtx(hook.scope, hookShard(hook.def.shard, hook.config));
      try {
        await hook.def.handler(ctx as never, message);
      } catch (e) {
        // Thrown out of email(): Email Routing does not accept the message (the sender's server sees a failure).
        console.error(`ember: email() for ${to} (component ${hook.scope.join("/")}) failed: ${(e as Error).message}`);
        throw e;
      }
    },
  };
}
