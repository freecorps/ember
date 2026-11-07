/**
 * `verify(token)` for the Ember Worker (PLAN §9):
 *   (a) short-lived JWT (jwt plugin, EdDSA) verified locally against a cached JWKS
 *       (embedded at deploy + refreshed on unknown `kid` / TTL);
 *   (b) signed cookie-cache value (`<project>.session_data`) verified locally with the secret;
 *   (c) opaque session token → authoritative lookup in the Auth DO (or the identity project).
 * `sensitive` forces (c) for every token kind, so a revoked session is rejected immediately.
 *
 * Pure apart from `fetch`-style callbacks; no Cloudflare bindings here.
 */
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify, type JSONWebKeySet, type JWTPayload } from "jose";
import { getCookieCache } from "better-auth/cookies";
import type { Identity } from "./types.ts";

export type AuthVia = "jwt" | "cookie-cache" | "session";

/** Authoritative session as the Auth DO reports it. */
export type SessionInfo = {
  userId: string;
  sessionId: string;
  /** ms since epoch */
  expiresAt: number;
  email?: string;
  name?: string;
  emailVerified?: boolean;
  org?: string | null;
};

export type SessionQuery = { token: string } | { sessionId: string } | { headers: [string, string][] };

export interface VerifierConfig {
  /** Expected `iss` (and `aud`) of Ember JWTs; omit to skip the check (keys are per project anyway). */
  issuer?: string | null;
  audience?: string | null;
  jwks: {
    /** Embedded at deploy (`EMBER_AUTH_JWKS`): first verifies need no fetch at all. */
    static?: JSONWebKeySet | null;
    fetch: () => Promise<JSONWebKeySet>;
    /** Re-fetch even with known kids after this long (default 15 min). */
    ttlMs?: number;
    /** Minimum gap between fetches triggered by unknown kids (default 30 s). */
    cooldownMs?: number;
  };
  /** (b) cookie cache; null when not available (SSO). */
  cookie?: { secret: string; prefix: string; strategy: "compact" | "jwe" } | null;
  /** (c) authoritative lookup. */
  lookup: (q: SessionQuery) => Promise<SessionInfo | null>;
  /** Treat every verify as sensitive (always (c)). */
  sensitive?: boolean;
  /** Can the lookup resolve `{ sessionId }`? (false for SSO: sensitive + JWT fails closed). */
  lookupBySessionId?: boolean;
  now?: () => number;
}

export type VerifyOptions = { sensitive?: boolean };
export type VerifyResult = { identity: Identity; via: AuthVia };

const STANDARD_CLAIMS = new Set(["iss", "aud", "iat", "exp", "nbf", "jti", "sub"]);

const b64urlJson = (s: string): unknown => {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return undefined;
  try {
    const bin = atob(s.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((s.length + 3) % 4));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
  } catch {
    return undefined;
  }
};

export type TokenKind = "jwt" | "cookie-cache" | "session-token";

export function classifyToken(token: string): TokenKind {
  const parts = token.split(".");
  if (parts.length === 3) {
    try {
      decodeProtectedHeader(token);
      return "jwt";
    } catch {
      /* fallthrough */
    }
  }
  if (parts.length === 5) return "cookie-cache"; // JWE cookie cache
  const decoded = parts.length === 1 ? b64urlJson(token) : undefined;
  if (decoded && typeof decoded === "object" && "session" in decoded) return "cookie-cache";
  return "session-token";
}

const sessionIdentity = (s: SessionInfo, issuer: string | null | undefined): Identity => {
  const claims: Record<string, unknown> = { sid: s.sessionId };
  if (s.email !== undefined) claims.email = s.email;
  if (s.name !== undefined) claims.name = s.name;
  if (s.emailVerified !== undefined) claims.emailVerified = s.emailVerified;
  if (s.org) claims.org = s.org;
  const id: Identity = { subject: s.userId, exp: Math.floor(s.expiresAt / 1000), claims };
  if (issuer) id.issuer = issuer;
  return id;
};

export function createVerifier(cfg: VerifierConfig) {
  const now = cfg.now ?? Date.now;
  const ttl = cfg.jwks.ttlMs ?? 15 * 60_000;
  const cooldown = cfg.jwks.cooldownMs ?? 30_000;
  let raw: JSONWebKeySet | null = cfg.jwks.static ?? null;
  let set = raw ? createLocalJWKSet(raw) : null;
  let fetchedAt = raw ? now() : 0;
  let lastAttempt = 0;
  let inflight: Promise<void> | null = null;
  const stats = { jwksFetches: 0 };

  const refresh = () =>
    (inflight ??= (async () => {
      lastAttempt = now();
      stats.jwksFetches++;
      try {
        const next = await cfg.jwks.fetch();
        if (next && Array.isArray(next.keys)) {
          raw = next;
          set = createLocalJWKSet(next);
          fetchedAt = now();
        }
      } finally {
        inflight = null;
      }
    })());

  async function verifyJwt(token: string): Promise<JWTPayload | null> {
    if (!set || now() - fetchedAt > ttl) await refresh().catch(() => undefined);
    if (!set) return null;
    const opts: { issuer?: string; audience?: string } = {};
    if (cfg.issuer) opts.issuer = cfg.issuer;
    if (cfg.audience) opts.audience = cfg.audience;
    try {
      return (await jwtVerify(token, set, opts)).payload;
    } catch (e) {
      if ((e as { code?: string }).code !== "ERR_JWKS_NO_MATCHING_KEY") return null;
      if (now() - lastAttempt < cooldown) return null;
      await refresh().catch(() => undefined);
      try {
        return (await jwtVerify(token, set, opts)).payload;
      } catch {
        return null;
      }
    }
  }

  async function fromSession(q: SessionQuery, expectUser?: string): Promise<VerifyResult | null> {
    const s = await cfg.lookup(q);
    if (!s || s.expiresAt <= now()) return null;
    if (expectUser !== undefined && s.userId !== expectUser) return null;
    return { identity: sessionIdentity(s, cfg.issuer), via: "session" };
  }

  async function cookieCachePayload(headers: Headers, secure: boolean | "both") {
    if (!cfg.cookie) return null;
    const base = { secret: cfg.cookie.secret, strategy: cfg.cookie.strategy, cookiePrefix: cfg.cookie.prefix };
    for (const isSecure of secure === "both" ? [true, false] : [secure]) {
      const p = await getCookieCache(headers, { ...base, isSecure }).catch(() => null);
      if (p) return p as { session: Record<string, unknown> & { id: string; userId: string; expiresAt: Date | string }; user: Record<string, unknown> & { id: string } };
    }
    return null;
  }

  async function fromCookieCache(headers: Headers, secure: boolean | "both", sensitive: boolean): Promise<VerifyResult | null | undefined> {
    const p = await cookieCachePayload(headers, secure);
    if (!p) return undefined;
    if (sensitive) return fromSession({ sessionId: p.session.id }, p.user.id);
    const org = p.session.activeOrganizationId;
    return {
      identity: sessionIdentity(
        {
          userId: p.user.id,
          sessionId: p.session.id,
          expiresAt: new Date(p.session.expiresAt).getTime(),
          email: p.user.email as string,
          name: p.user.name as string,
          emailVerified: Boolean(p.user.emailVerified),
          org: typeof org === "string" ? org : null,
        },
        cfg.issuer,
      ),
      via: "cookie-cache",
    };
  }

  async function verifyDetailed(token: string, o: VerifyOptions = {}): Promise<VerifyResult | null> {
    if (!token) return null;
    const sensitive = o.sensitive ?? cfg.sensitive ?? false;
    const kind = classifyToken(token);
    if (kind === "jwt") {
      const payload = await verifyJwt(token);
      if (!payload || typeof payload.sub !== "string") return null;
      if (sensitive) {
        if (typeof payload.sid !== "string" || cfg.lookupBySessionId === false) return null;
        const live = await fromSession({ sessionId: payload.sid }, payload.sub);
        // The session is live, but the token still says when it was issued: a shard's revocation reads it.
        if (live && typeof payload.iat === "number") live.identity.iat = payload.iat;
        return live;
      }
      const claims: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(payload)) if (!STANDARD_CLAIMS.has(k)) claims[k] = v;
      const identity: Identity = { subject: payload.sub, claims };
      if (typeof payload.iss === "string") identity.issuer = payload.iss;
      if (typeof payload.exp === "number") identity.exp = payload.exp;
      if (typeof payload.iat === "number") identity.iat = payload.iat;
      return { identity, via: "jwt" };
    }
    if (kind === "cookie-cache") {
      if (!cfg.cookie) return null;
      const headers = new Headers({ cookie: `${cfg.cookie.prefix}.session_data=${token}` });
      return (await fromCookieCache(headers, false, sensitive)) ?? null;
    }
    return fromSession({ token });
  }

  /**
   * Resolve a whole request: `Authorization: Bearer` (any token kind), else the cookie cache,
   * else the session cookie (DO lookup).
   */
  async function verifyRequestDetailed(request: Request, o: VerifyOptions = {}): Promise<VerifyResult | null> {
    const authz = request.headers.get("authorization");
    if (authz?.toLowerCase().startsWith("bearer ")) return verifyDetailed(authz.slice(7).trim(), o);
    const cookie = request.headers.get("cookie");
    if (!cookie || !cfg.cookie) return null;
    const sensitive = o.sensitive ?? cfg.sensitive ?? false;
    const cached = await fromCookieCache(request.headers, "both", sensitive);
    if (cached !== undefined) return cached;
    if (!cookie.includes(`${cfg.cookie.prefix}.session_token=`)) return null;
    return fromSession({ headers: [["cookie", cookie]] });
  }

  return {
    verifyDetailed,
    verifyRequestDetailed,
    async verify(token: string, o?: VerifyOptions): Promise<Identity | null> {
      return (await verifyDetailed(token, o))?.identity ?? null;
    },
    async verifyRequest(request: Request, o?: VerifyOptions): Promise<Identity | null> {
      return (await verifyRequestDetailed(request, o))?.identity ?? null;
    },
    /** Current JWKS (for tests and `ember deploy` embedding). */
    jwks: () => raw,
    stats: () => ({ ...stats }),
    /** Drop cached keys (tests / forced rotation). */
    reset(staticKeys?: JSONWebKeySet | null) {
      raw = staticKeys ?? null;
      set = raw ? createLocalJWKSet(raw) : null;
      fetchedAt = raw ? now() : 0;
      lastAttempt = 0;
      stats.jwksFetches = 0;
    },
  };
}

export type Verifier = ReturnType<typeof createVerifier>;
