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
  /** Can the lookup resolve `{ sessionId }`? (false for SSO: sensitive + JWT fails closed, unless `sessionCheck`). */
  lookupBySessionId?: boolean;
  /**
   * Sensitive check of a JWT's session where there is no local session store (`remoteAuth({ sessionLookup })`, L14):
   * asks the origin whether the session `sid` of user `sub` is alive. True lets the JWT's own identity through (its
   * claims, `iat` included); false, a throw or a JWT without `sid` → null. Takes precedence over `lookup({ sessionId })`.
   */
  sessionCheck?: (claims: JWTPayload & { sub: string; sid: string }) => Promise<boolean>;
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

/** A JWKS fetch older than this is taken as lost (its request ended and cut it short): a new one may start. */
const STUCK_REFRESH_MS = 10_000;

/** Waits for `p` (its outcome ignored), at most `ms`. */
async function settledWithin(p: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([p.catch(() => undefined), new Promise<void>((r) => (timer = setTimeout(r, Math.max(0, ms))))]);
  clearTimeout(timer);
}

export function createVerifier(cfg: VerifierConfig) {
  const now = cfg.now ?? Date.now;
  const ttl = cfg.jwks.ttlMs ?? 15 * 60_000;
  const cooldown = cfg.jwks.cooldownMs ?? 30_000;
  let raw: JSONWebKeySet | null = cfg.jwks.static ?? null;
  let set = raw ? createLocalJWKSet(raw) : null;
  let fetchedAt = raw ? now() : 0;
  /** `raw` came from `jwks.fetch` (the issuer's current set), not from the deploy-time copy. */
  let fetched = false;
  let lastAttempt = 0;
  let inflight: Promise<void> | null = null;
  let inflightAt = 0;
  const stats = { jwksFetches: 0 };

  /**
   * The fetch under way, unless it started over `STUCK_REFRESH_MS` ago: one started by a request that has ended may
   * have been cut short with it and never settle, and must not hold every later refresh (nor be awaited forever).
   */
  const pending = (): Promise<void> | null => {
    if (inflight && now() - inflightAt > STUCK_REFRESH_MS) inflight = null;
    return inflight;
  };

  /**
   * `cooled`: the fetch counts toward the unknown-kid cooldown. The TTL and `/jwks` refreshes do not: they may run
   * detached from any request (and be cut short with it), and must not hold back the fetch a token with a new kid needs.
   */
  const refresh = (cooled = true): Promise<void> => {
    if (cooled) lastAttempt = now();
    const running = pending();
    if (running) return running;
    inflightAt = now();
    const p: Promise<void> = (async () => {
      stats.jwksFetches++;
      try {
        const next = await cfg.jwks.fetch();
        if (next && Array.isArray(next.keys)) {
          raw = next;
          set = createLocalJWKSet(next);
          fetchedAt = now();
          fetched = true;
        }
      } finally {
        if (inflight === p) inflight = null;
      }
    })();
    inflight = p;
    return p;
  };

  async function verifyJwt(token: string): Promise<JWTPayload | null> {
    if (!set) await refresh().catch(() => undefined);
    // Stale keys keep verifying while the refresh runs (stale-while-revalidate): a rotated-out key is still published
    // for its grace period, so the old set is never wrong, only possibly missing a new kid (handled below).
    else if (now() - fetchedAt > ttl && !pending()) void refresh(false).catch(() => undefined);
    if (!set) return null;
    const opts: { issuer?: string; audience?: string } = {};
    if (cfg.issuer) opts.issuer = cfg.issuer;
    if (cfg.audience) opts.audience = cfg.audience;
    const used = set;
    try {
      return (await jwtVerify(token, used, opts)).payload;
    } catch (e) {
      if ((e as { code?: string }).code !== "ERR_JWKS_NO_MATCHING_KEY") return null;
      // A refresh already running (the TTL one) may bring the kid, or one has landed meanwhile: that set is tried
      // before the cooldown applies.
      const running = pending();
      if (running) await settledWithin(running, STUCK_REFRESH_MS - (now() - inflightAt));
      else if (set === used && now() - lastAttempt < cooldown) return null;
      else if (set === used) await refresh().catch(() => undefined);
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
        if (typeof payload.sid !== "string" || !payload.sid) return null;
        if (cfg.sessionCheck) {
          const alive = await cfg.sessionCheck(payload as JWTPayload & { sub: string; sid: string }).catch(() => false);
          if (!alive) return null;
        } else {
          if (cfg.lookupBySessionId === false) return null;
          const live = await fromSession({ sessionId: payload.sid }, payload.sub);
          // The session is live, but the token still says when it was issued: a shard's revocation reads it.
          if (live && typeof payload.iat === "number") live.identity.iat = payload.iat;
          return live;
        }
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
    // Only the cookie-cache variant(s) the request carries are decoded (none: no work at all).
    // (No "=" in the name: a chunked cache is `<name>.0=`, `<name>.1=`…)
    const name = `${cfg.cookie.prefix}.session_data`;
    if (cookie.includes(name)) {
      const secure = cookie.includes(`__Secure-${name}`);
      const plain = cookie.split(";").some((c) => c.trimStart().startsWith(name));
      const cached = await fromCookieCache(request.headers, secure && plain ? "both" : secure, sensitive);
      if (cached !== undefined) return cached;
    }
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
    /**
     * The issuer's JWKS as last fetched, fetched now when missing or older than `maxAgeMs` (default 60 s, so a
     * rotation in another isolate shows within a minute): what `<basePath>/jwks` answers in the Worker without a
     * round trip to the Auth DO. Null when the fetch fails or the set has no key yet (Better Auth answers then).
     */
    async publicJwks(maxAgeMs = 60_000): Promise<JSONWebKeySet | null> {
      const maxAge = Math.min(maxAgeMs, ttl);
      if (!fetched || now() - fetchedAt > maxAge) await refresh(false).catch(() => undefined);
      // Still too old (the fetch failed): Better Auth answers, never a set that may miss a rotated-in key.
      return fetched && raw && raw.keys.length > 0 && now() - fetchedAt <= maxAge ? raw : null;
    },
    stats: () => ({ ...stats }),
    /** Drop cached keys (tests / forced rotation). */
    reset(staticKeys?: JSONWebKeySet | null) {
      raw = staticKeys ?? null;
      set = raw ? createLocalJWKSet(raw) : null;
      fetchedAt = raw ? now() : 0;
      fetched = false;
      lastAttempt = 0;
      stats.jwksFetches = 0;
    },
  };
}

export type Verifier = ReturnType<typeof createVerifier>;
