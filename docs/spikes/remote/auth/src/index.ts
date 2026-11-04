/**
 * Stateless Worker in front of the auth DO.
 *  - /api/auth/*   -> forwarded to the auth DO (Better Auth handler runs there)
 *  - /api/whoami   -> demo of how a query/mutation would get `ctx.auth`
 *  - PasswordHasher entrypoint: scrypt off the DO's single thread
 */
import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import { getCookieCache } from "better-auth/cookies";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { authConfig, JWT_AUDIENCE, JWT_ISSUER } from "./auth-config";
import type { Env } from "./env";

export { AuthShard } from "./auth-shard";

const AUTH_SHARD_NAME = "auth:global";
export const authShard = (env: Env) => env.AUTH_SHARD.get(env.AUTH_SHARD.idFromName(AUTH_SHARD_NAME));

export class PasswordHasher extends WorkerEntrypoint<Env> {
  hash(password: string) {
    return hashPassword(password);
  }
  verify(hash: string, password: string) {
    return verifyPassword({ hash, password });
  }
}

/** Passed by reference over RPC: the DO's calls execute back in THIS isolate. */
export class EdgeHasher extends RpcTarget {
  hash(password: string) {
    return hashPassword(password);
  }
  verify(hash: string, password: string) {
    return verifyPassword({ hash, password });
  }
}

// ---------------- ctx.auth resolution ----------------

export type Identity = {
  subject: string;
  sessionId?: string;
  email?: string;
  activeOrganizationId?: string | null;
  /** how the identity was established (for the spike's measurements) */
  via: "jwt" | "cookie-cache" | "session-lookup";
};

const cfg = authConfig();
let jwksCache: { set: ReturnType<typeof createLocalJWKSet>; raw: JSONWebKeySet; at: number } | null = null;
let jwksFetches = 0;
export const jwksStats = () => ({ jwksFetches });
export const resetJwksCache = () => {
  jwksCache = null;
  jwksFetches = 0;
};

async function getJwks(env: Env, force = false) {
  if (!jwksCache || force || Date.now() - jwksCache.at > 10 * 60_000) {
    jwksFetches++;
    const raw = (await authShard(env).getJwks()) as JSONWebKeySet;
    jwksCache = { raw, set: createLocalJWKSet(raw), at: Date.now() };
  }
  return jwksCache;
}

const looksLikeJwt = (t: string) => t.split(".").length === 3;

export async function resolveAuth(request: Request, env: Env): Promise<Identity | null> {
  const authz = request.headers.get("authorization");
  const bearer = authz?.startsWith("Bearer ") ? authz.slice(7).trim() : null;

  // 1) Short-lived JWT from the jwt plugin: verified locally, zero DO hops.
  if (bearer && looksLikeJwt(bearer)) {
    const verify = async (force: boolean) =>
      jwtVerify(bearer, (await getJwks(env, force)).set, {
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
      });
    let payload;
    try {
      payload = (await verify(false)).payload;
    } catch (e: any) {
      if (e?.code !== "ERR_JWKS_NO_MATCHING_KEY") return null;
      payload = (await verify(true)).payload; // key rotated: refetch once
    }
    return {
      subject: String(payload.sub),
      email: payload.email as string | undefined,
      via: "jwt",
    };
  }

  // 2) Signed session cookie cache: verified locally with the secret.
  const cached = await getCookieCache(request, { secret: cfg.secret, strategy: "compact", isSecure: false });
  if (cached) {
    return {
      subject: cached.user.id,
      sessionId: cached.session.id,
      email: cached.user.email,
      activeOrganizationId: (cached.session as any).activeOrganizationId ?? null,
      via: "cookie-cache",
    };
  }

  // 3) Opaque session token (cookie or bearer plugin): authoritative DO lookup.
  if (bearer || request.headers.get("cookie")?.includes("better-auth.session_token")) {
    // (cast: DO RPC type inference over Better Auth's huge types hits TS2589)
    const shard = authShard(env) as unknown as { getSession(h: [string, string][]): Promise<{ userId: string; sessionId: string; email: string; activeOrganizationId: string | null } | null> };
    const s = await shard.getSession([...request.headers.entries()]);
    if (!s) return null;
    return { subject: s.userId, sessionId: s.sessionId, email: s.email, activeOrganizationId: s.activeOrganizationId, via: "session-lookup" };
  }
  return null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/auth/")) {
      if (env.HASH_OFFLOAD === "1") return (authShard(env) as any).handle(request, new EdgeHasher()) as Promise<Response>;
      return authShard(env).fetch(request);
    }
    if (url.pathname === "/api/whoami") {
      const t = performance.now();
      const identity = await resolveAuth(request, env);
      return Response.json({ identity, ms: performance.now() - t }, { status: identity ? 200 : 401 });
    }
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
