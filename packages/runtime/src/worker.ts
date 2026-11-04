import { isValidShardName, setEmberConfig, type EmberConfig, type EmberEnv } from "./config.ts";
import type { Identity } from "./engine-types.ts";
import type { MutationOutcome, Shard } from "./shard.ts";
import type { System } from "./system.ts";
import { parse, stringify } from "./wire.ts";

export interface EmberWorker {
  fetch(request: Request, env: EmberEnv, ctx: ExecutionContext): Promise<Response>;
  scheduled(controller: ScheduledController, env: EmberEnv, ctx: ExecutionContext): Promise<void>;
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

function shardStub(env: EmberEnv, shard: string): DurableObjectStub<Shard> {
  return env.SHARD.get(env.SHARD.idFromName(shard)) as unknown as DurableObjectStub<Shard>;
}

/**
 * Build the Worker entry. Usage in the user's worker module:
 *
 *   export { Shard, System } from "@ember/runtime";
 *   export default createEmberWorker({ schema, functions });
 */
export function createEmberWorker(config: EmberConfig): EmberWorker {
  setEmberConfig(config);
  const kinds = knownShardKinds(config);

  const checkShard = (shard: unknown): string | null => {
    if (typeof shard !== "string" || !isValidShardName(shard)) return null;
    if (kinds && kinds.size && !kinds.has(shard.slice(0, shard.indexOf(":"))) && !shard.startsWith("global:")) return null;
    return shard;
  };

  /** undefined = no token; null = invalid token. */
  const verify = async (token: string | null): Promise<Identity | null | undefined> => {
    if (!token) return undefined;
    if (!config.auth) return null;
    try {
      return (await config.auth.verify(token)) ?? null;
    } catch {
      return null;
    }
  };

  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      if (url.pathname === "/health") return json({ ok: true });

      if (url.pathname === "/ws") {
        if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return error(426, "upgrade_required", "expected websocket");
        const shard = checkShard(url.searchParams.get("shard"));
        if (!shard) return error(400, "bad_shard", "expected ?shard=<kind>:<key>");
        const stub = shardStub(env, shard);
        // Pre-warm the shard (cold wake ~60 ms, R8) in parallel with token verification.
        const [identity] = await Promise.all([
          verify(bearer(request, url)),
          stub.warm(shard).catch(() => undefined),
        ]);
        if (identity === null) return error(401, "unauthenticated", "invalid token");
        const headers = new Headers(request.headers);
        for (const k of [...headers.keys()]) if (k.startsWith("x-ember-")) headers.delete(k);
        headers.set("x-ember-shard", shard);
        if (identity) headers.set("x-ember-identity", JSON.stringify(identity));
        return stub.fetch(new Request(request.url, { headers }));
      }

      if (url.pathname === "/api/query" || url.pathname === "/api/mutation") {
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
        const stub = shardStub(env, shard);
        const [identity] = await Promise.all([verify(bearer(request, url)), stub.warm(shard).catch(() => undefined)]);
        if (identity === null) return error(401, "unauthenticated", "invalid token");
        const out: MutationOutcome =
          url.pathname === "/api/query"
            ? await stub.query(shard, body.fn, args, identity ?? null)
            : await stub.mutation(shard, body.fn, args, identity ?? null);
        return json(out, out.ok ? 200 : 400);
      }

      return error(404, "not_found", "not found");
    },

    async scheduled(controller, env, ctx) {
      if (!config.crons?.length || !env.SYSTEM) return;
      const system = env.SYSTEM.get(env.SYSTEM.idFromName("system")) as unknown as DurableObjectStub<System>;
      ctx.waitUntil(system.tick(controller.scheduledTime));
    },
  };
}
