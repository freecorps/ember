/**
 * Ember's side of the session lookup (`remoteAuth({ sessionLookup })`, PLAN §22 L14): turns the origin's answer into
 * the verifier's `sessionCheck`. Fail closed: a timeout, a network error, a non-200 or a malformed answer denies the
 * sensitive call and logs one line. Answers are cached per session: positive ones for `cacheMs` (default 0, none),
 * negative ones until the JWT expires (a dead session does not come back). No Cloudflare APIs here.
 */
import type { JWTPayload } from "jose";
import {
  isSessionAlive,
  parseSessionLookupAnswer,
  SESSION_LOOKUP_HEADER,
  SESSION_LOOKUP_SECRET_ENV,
  signSessionLookup,
  type SessionLookupAnswer,
} from "./session-lookup.ts";

export type SessionLookupClaims = JWTPayload & { sub: string; sid: string };

/** A custom integration: answer whether the session in these (verified) claims is alive. */
export type SessionLookupFn = (claims: SessionLookupClaims) => Promise<SessionLookupAnswer> | SessionLookupAnswer;

interface SessionLookupCommon {
  /** Longest wait for the origin before failing closed. Default 2000 ms. */
  timeoutMs?: number;
  /**
   * How long an `active` answer is reused for the same session. Default 0: every sensitive call asks the origin (a
   * session revoked there is refused on the next call). Any value is capped by the session's and the JWT's expiry.
   */
  cacheMs?: number;
}

export type SessionLookupSettings =
  | SessionLookupFn
  | (SessionLookupCommon & {
      /** The origin's endpoint (`POST`, signed `{ sid, sub }`). */
      url: string;
      /** Env var holding the shared secret. Default `SESSION_LOOKUP_SECRET` (`ember env set`). */
      secretEnv?: string;
      /** The secret itself (tests, or a Worker that resolves it otherwise); wins over `secretEnv`. */
      secret?: string;
    })
  | (SessionLookupCommon & { check: SessionLookupFn });

export const DEFAULT_SESSION_LOOKUP_TIMEOUT_MS = 2000;
const MAX_CACHED = 10_000;

export interface SessionCheckDeps {
  fetch: typeof fetch;
  env: () => Record<string, unknown>;
  now?: () => number;
  log?: (line: string) => void;
}

/** Where the lookup goes, for log lines and the dashboard's message. */
export const sessionLookupTarget = (s: SessionLookupSettings): string => (typeof s === "function" || "check" in s ? "custom sessionLookup" : s.url);

export function createSessionCheck(settings: SessionLookupSettings, deps: SessionCheckDeps) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? ((line: string) => console.warn(line));
  const common: SessionLookupCommon = typeof settings === "function" ? {} : settings;
  const timeoutMs = Math.max(1, common.timeoutMs ?? DEFAULT_SESSION_LOOKUP_TIMEOUT_MS);
  const cacheMs = Math.max(0, common.cacheMs ?? 0);
  const target = sessionLookupTarget(settings);
  const cache = new Map<string, { alive: boolean; until: number }>();
  const inflight = new Map<string, Promise<SessionLookupAnswer | null>>();
  const stats = { lookups: 0, failures: 0, cacheHits: 0 };

  const fail = (why: string): null => {
    stats.failures++;
    log(`ember auth: session lookup (${target}) failed: ${why}; sensitive call denied (fail closed)`);
    return null;
  };

  const withTimeout = <T>(p: Promise<T>, signal?: AbortController): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const t = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        signal?.abort();
        reject(new Error(`no answer within ${timeoutMs} ms`));
      }, timeoutMs);
    });
    return Promise.race([p, t]).finally(() => clearTimeout(timer));
  };

  async function ask(claims: SessionLookupClaims): Promise<SessionLookupAnswer | null> {
    stats.lookups++;
    try {
      if (typeof settings === "function" || "check" in settings) {
        const fn = typeof settings === "function" ? settings : settings.check;
        return parseSessionLookupAnswer(await withTimeout(Promise.resolve(fn(claims)))) ?? fail("the custom check returned no { active: boolean }");
      }
      const secret = settings.secret ?? deps.env()[settings.secretEnv ?? SESSION_LOOKUP_SECRET_ENV];
      if (typeof secret !== "string" || !secret) return fail(`no secret (set ${settings.secretEnv ?? SESSION_LOOKUP_SECRET_ENV} with \`ember env set\`)`);
      const body = JSON.stringify({ sid: claims.sid, sub: claims.sub });
      const ctl = new AbortController();
      const res = await withTimeout(
        (async () =>
          deps.fetch(settings.url, {
            method: "POST",
            headers: { "content-type": "application/json", [SESSION_LOOKUP_HEADER]: await signSessionLookup(body, secret, now()) },
            body,
            signal: ctl.signal,
          }))(),
        ctl,
      );
      if (res.status !== 200) {
        await res.body?.cancel().catch(() => undefined);
        return fail(`HTTP ${res.status}`);
      }
      const answer = parseSessionLookupAnswer(await withTimeout(res.json() as Promise<unknown>).catch(() => null));
      return answer ?? fail("the answer is not { active: boolean }");
    } catch (e) {
      return fail((e as Error)?.message ?? String(e));
    }
  }

  const remember = (key: string, alive: boolean, until: number) => {
    if (until <= now()) return;
    if (cache.size >= MAX_CACHED) {
      const t = now();
      for (const [k, v] of cache) if (v.until <= t) cache.delete(k);
      // Still full: drop the oldest entries (Map keeps insertion order).
      for (const k of cache.keys()) {
        if (cache.size < MAX_CACHED) break;
        cache.delete(k);
      }
    }
    cache.set(key, { alive, until });
  };

  async function check(claims: SessionLookupClaims): Promise<boolean> {
    const key = `${claims.sub}\u0000${claims.sid}`;
    const hit = cache.get(key);
    if (hit && hit.until > now()) {
      stats.cacheHits++;
      return hit.alive;
    }
    let p = inflight.get(key);
    if (!p) {
      p = ask(claims).finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    const answer = await p;
    if (!answer) return false; // an error: never cached, the next call asks again
    const t = now();
    const jwtExp = typeof claims.exp === "number" ? claims.exp * 1000 : t;
    const alive = isSessionAlive(answer, t);
    if (alive) {
      if (cacheMs > 0) remember(key, true, Math.min(t + cacheMs, answer.expiresAt ?? Infinity, jwtExp));
    } else {
      remember(key, false, jwtExp);
    }
    return alive;
  }

  return { check, stats: () => ({ ...stats }), clear: () => cache.clear() };
}
