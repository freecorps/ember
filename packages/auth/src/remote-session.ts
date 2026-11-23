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
/** Most cached answers per isolate. */
export const MAX_CACHED_SESSIONS = 10_000;
const MAX_CACHED = MAX_CACHED_SESSIONS;

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

  /**
   * One deadline per lookup (`AbortSignal.timeout`): it aborts the request and bounds the request, the answer's body
   * and a custom check together, whether or not the `fetch` honours the signal.
   */
  const deadline = () => {
    const signal = AbortSignal.timeout(timeoutMs);
    let onAbort: (() => void) | undefined;
    const expired = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error(`no answer within ${timeoutMs} ms`));
      signal.addEventListener("abort", onAbort, { once: true });
    });
    // Never an unhandled rejection: every use races it.
    expired.catch(() => undefined);
    const within = <T>(p: Promise<T>): Promise<T> => Promise.race([p, expired]);
    return { signal, within, done: () => onAbort && signal.removeEventListener("abort", onAbort) };
  };

  async function ask(claims: SessionLookupClaims): Promise<SessionLookupAnswer | null> {
    stats.lookups++;
    const d = deadline();
    try {
      if (typeof settings === "function" || "check" in settings) {
        const fn = typeof settings === "function" ? settings : settings.check;
        return parseSessionLookupAnswer(await d.within(Promise.resolve(fn(claims)))) ?? fail("the custom check returned no { active: boolean }");
      }
      const secret = settings.secret ?? deps.env()[settings.secretEnv ?? SESSION_LOOKUP_SECRET_ENV];
      if (typeof secret !== "string" || !secret) return fail(`no secret (set ${settings.secretEnv ?? SESSION_LOOKUP_SECRET_ENV} with \`ember env set\`)`);
      const body = JSON.stringify({ sid: claims.sid, sub: claims.sub });
      const res = await d.within(
        (async () =>
          deps.fetch(settings.url, {
            method: "POST",
            headers: { "content-type": "application/json", [SESSION_LOOKUP_HEADER]: await signSessionLookup(body, secret, now()) },
            body,
            signal: d.signal,
          }))(),
      );
      if (res.status !== 200) {
        await res.body?.cancel().catch(() => undefined);
        return fail(`HTTP ${res.status}`);
      }
      const answer = parseSessionLookupAnswer(await d.within(res.json() as Promise<unknown>).catch(() => null));
      return answer ?? fail("the answer is not { active: boolean }");
    } catch (e) {
      return fail((e as Error)?.message ?? String(e));
    } finally {
      d.done();
    }
  }

  /**
   * Bounded cache, O(1) per insert: a full cache drops its oldest entry (Map order is insertion order; a renewed entry
   * moves to the end). Expired entries are dropped when read.
   */
  const remember = (key: string, alive: boolean, until: number) => {
    if (until <= now()) return;
    if (cache.has(key)) cache.delete(key);
    else if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value!);
    cache.set(key, { alive, until });
  };

  async function check(claims: SessionLookupClaims): Promise<boolean> {
    const key = `${claims.sub}\u0000${claims.sid}`;
    const hit = cache.get(key);
    if (hit && hit.until > now()) {
      stats.cacheHits++;
      return hit.alive;
    }
    if (hit) cache.delete(key);
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
