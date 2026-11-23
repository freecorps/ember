/**
 * `remoteAuth({ sessionLookup })` (PLAN §22 L14): sensitive checks of an origin's JWT ask the origin whether the
 * session is alive, through the signed protocol of `@freecorps/ember-auth/session-lookup` (both sides here), or a
 * custom function. Fail closed on any doubt; non-sensitive verifies never call the origin. `remoteAuth` comes from the
 * light entry (`@freecorps/ember-auth/remote`, what the generated SSO Worker imports); `/worker` re-exports it.
 */
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { remoteAuth } from "../src/remote.ts";
import * as workerEntry from "../src/worker.ts";
import {
  SESSION_LOOKUP_HEADER,
  signSessionLookup,
  verifySessionLookupRequest,
  type SessionLookupAnswer,
} from "../src/session-lookup.ts";

const ORIGIN = "https://origin.test";
const LOOKUP = `${ORIGIN}/ember/session`;
const SECRET = "lookup-secret-0123456789abcdef";

let jwk: JWK;
let sign: (claims: Record<string, unknown>, expSeconds?: number) => Promise<string>;

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519" });
  jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "EdDSA" };
  sign = (claims, expSeconds = 300) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "EdDSA", kid: "k1" })
      .setIssuer(ORIGIN)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + expSeconds)
      .sign(privateKey);
});

/** A fake origin: checks the signature like a real one would, answers from `sessions`. */
function fakeOrigin(sessions: Map<string, SessionLookupAnswer>, o: { secret?: string; delayMs?: number; status?: number; raw?: unknown } = {}) {
  const calls: Array<{ sid: string; sub: string } | { rejected: string }> = [];
  const originFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    if (req.url !== LOOKUP) return new Response("not found", { status: 404 });
    if (o.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, o.delayMs);
        init?.signal?.addEventListener("abort", () => (clearTimeout(t), reject(new Error("aborted"))));
      });
    }
    const q = await verifySessionLookupRequest(req, o.secret ?? SECRET);
    if (!q.ok) {
      calls.push({ rejected: q.reason });
      return new Response(q.reason, { status: q.status });
    }
    calls.push({ sid: q.sid, sub: q.sub });
    if (o.status) return new Response("boom", { status: o.status });
    if (o.raw !== undefined) return Response.json(o.raw);
    const s = sessions.get(q.sid);
    return Response.json(s ?? { active: false });
  }) as typeof globalThis.fetch;
  return { fetch: originFetch, calls };
}

const remote = (fetch: typeof globalThis.fetch, lookup: { timeoutMs?: number; cacheMs?: number } = {}) => {
  const auth = remoteAuth({
    from: ORIGIN,
    jwks: { keys: [jwk] },
    fetch,
    sessionLookup: { url: LOOKUP, secret: SECRET, ...lookup },
  });
  return { auth };
};

describe("origin helper: verifySessionLookupRequest", () => {
  const body = JSON.stringify({ sid: "s1", sub: "u1" });
  const req = async (o: { t?: number; secret?: string; method?: string; body?: string; header?: string } = {}) =>
    new Request(LOOKUP, {
      method: o.method ?? "POST",
      headers: { "content-type": "application/json", [SESSION_LOOKUP_HEADER]: o.header ?? (await signSessionLookup(o.body ?? body, o.secret ?? SECRET, o.t ?? Date.now())) },
      ...((o.method ?? "POST") === "POST" ? { body: o.body ?? body } : {}),
    });

  it("accepts a signed request and returns the query", async () => {
    const v = await verifySessionLookupRequest(await req(), SECRET);
    expect(v).toMatchObject({ ok: true, sid: "s1", sub: "u1" });
    // Rotation: the new and the old secret.
    expect((await verifySessionLookupRequest(await req({ secret: "old-secret" }), ["new-secret", "old-secret"])).ok).toBe(true);
  });

  it("refuses a bad signature, a tampered body, a missing header and a wrong method", async () => {
    expect(await verifySessionLookupRequest(await req({ secret: "other" }), SECRET)).toEqual({ ok: false, status: 401, reason: "signature" });
    const signed = await signSessionLookup(body, SECRET);
    const tampered = new Request(LOOKUP, { method: "POST", headers: { [SESSION_LOOKUP_HEADER]: signed }, body: JSON.stringify({ sid: "s2", sub: "u1" }) });
    expect((await verifySessionLookupRequest(tampered, SECRET)).ok).toBe(false);
    expect(await verifySessionLookupRequest(await req({ header: "" }), SECRET)).toMatchObject({ ok: false, reason: "signature" });
    expect(await verifySessionLookupRequest(await req({ header: "t=1,v1=zz" }), SECRET)).toMatchObject({ ok: false, reason: "signature" });
    expect(await verifySessionLookupRequest(await req({ method: "GET" }), SECRET)).toEqual({ ok: false, status: 405, reason: "method" });
  });

  it("refuses a timestamp more than 5 minutes away (either direction)", async () => {
    const now = Date.now();
    expect(await verifySessionLookupRequest(await req({ t: now - 5 * 60_000 - 1000 }), SECRET, { now })).toEqual({ ok: false, status: 401, reason: "skew" });
    expect(await verifySessionLookupRequest(await req({ t: now + 5 * 60_000 + 1000 }), SECRET, { now })).toMatchObject({ reason: "skew" });
    expect((await verifySessionLookupRequest(await req({ t: now - 4 * 60_000 }), SECRET, { now })).ok).toBe(true);
  });

  it("refuses a signed body that is not { sid, sub }", async () => {
    expect(await verifySessionLookupRequest(await req({ body: "not json" }), SECRET)).toEqual({ ok: false, status: 400, reason: "body" });
    expect(await verifySessionLookupRequest(await req({ body: JSON.stringify({ sid: "s1" }) }), SECRET)).toMatchObject({ reason: "body" });
  });
});

describe("remoteAuth({ sessionLookup })", () => {
  it("/worker re-exports the remoteAuth of /remote", () => {
    expect(workerEntry.remoteAuth).toBe(remoteAuth);
  });

  it("sensitive: the JWT's identity when the origin says active; null when it says inactive", async () => {
    const sessions = new Map<string, SessionLookupAnswer>([["s-live", { active: true, expiresAt: Date.now() + 60_000 }]]);
    const origin = fakeOrigin(sessions);
    const { auth } = remote(origin.fetch);
    const live = await sign({ sub: "u1", sid: "s-live", org: "acme" });
    const id = await auth.verify(live, { sensitive: true });
    expect(id).toMatchObject({ subject: "u1", issuer: ORIGIN, claims: { sid: "s-live", org: "acme" } });
    expect(typeof id?.iat).toBe("number");
    expect(origin.calls).toEqual([{ sid: "s-live", sub: "u1" }]);

    const dead = await sign({ sub: "u1", sid: "s-dead" });
    expect(await auth.verify(dead, { sensitive: true })).toBeNull();
    // active: true with a past expiry or a revocation is not alive either.
    sessions.set("s-exp", { active: true, expiresAt: Date.now() - 1 });
    sessions.set("s-rev", { active: true, revokedAt: Date.now() - 1 });
    expect(await auth.verify(await sign({ sub: "u1", sid: "s-exp" }), { sensitive: true })).toBeNull();
    expect(await auth.verify(await sign({ sub: "u1", sid: "s-rev" }), { sensitive: true })).toBeNull();
  });

  it("non-sensitive verifies never call the origin; a JWT without sid fails sensitive without a call", async () => {
    const origin = fakeOrigin(new Map());
    const { auth } = remote(origin.fetch);
    expect(await auth.verify(await sign({ sub: "u1", sid: "s1" }))).toMatchObject({ subject: "u1" });
    expect(await auth.verify(await sign({ sub: "u1" }), { sensitive: true })).toBeNull();
    expect(origin.calls).toEqual([]);
    expect(auth.sessionLookupStats()).toMatchObject({ lookups: 0 });
  });

  it("fails closed with a log line on timeout, HTTP errors, a malformed answer, a wrong secret and no secret", async () => {
    const lines: string[] = [];
    const warn = console.warn;
    console.warn = (l: string) => void lines.push(l);
    try {
      const token = await sign({ sub: "u1", sid: "s1" });
      const live = new Map([["s1", { active: true }]]);
      const slow = fakeOrigin(live, { delayMs: 500 });
      const t0 = Date.now();
      expect(await remote(slow.fetch, { timeoutMs: 50 }).auth.verify(token, { sensitive: true })).toBeNull();
      expect(Date.now() - t0).toBeLessThan(400);
      expect(lines.at(-1)).toMatch(/session lookup \(https:\/\/origin\.test\/ember\/session\) failed: no answer within 50 ms; sensitive call denied \(fail closed\)/);

      expect(await remote(fakeOrigin(live, { status: 503 }).fetch).auth.verify(token, { sensitive: true })).toBeNull();
      expect(lines.at(-1)).toMatch(/HTTP 503/);
      expect(await remote(fakeOrigin(live, { raw: { active: "yes" } }).fetch).auth.verify(token, { sensitive: true })).toBeNull();
      expect(lines.at(-1)).toMatch(/not \{ active: boolean \}/);
      // The origin refuses Ember's signature (secrets differ): 401, denied.
      const wrong = fakeOrigin(live, { secret: "the-origin-has-another-one" });
      expect(await remote(wrong.fetch).auth.verify(token, { sensitive: true })).toBeNull();
      expect(wrong.calls).toEqual([{ rejected: "signature" }]);
      expect(lines.at(-1)).toMatch(/HTTP 401/);
      const throwing = (async () => {
        throw new Error("connection refused");
      }) as unknown as typeof fetch;
      expect(await remote(throwing).auth.verify(token, { sensitive: true })).toBeNull();
      expect(lines.at(-1)).toMatch(/connection refused/);
      const noSecret = remoteAuth({ from: ORIGIN, jwks: { keys: [jwk] }, fetch: fakeOrigin(live).fetch, env: {}, sessionLookup: { url: LOOKUP } });
      expect(await noSecret.verify(token, { sensitive: true })).toBeNull();
      expect(lines.at(-1)).toMatch(/no secret \(set SESSION_LOOKUP_SECRET/);
      // The secret from env (`secretEnv`), as the generated Worker reads it.
      const fromEnv = remoteAuth({ from: ORIGIN, jwks: { keys: [jwk] }, fetch: fakeOrigin(live).fetch, env: { LOOKUP_KEY: SECRET }, sessionLookup: { url: LOOKUP, secretEnv: "LOOKUP_KEY" } });
      expect(await fromEnv.verify(token, { sensitive: true })).toMatchObject({ subject: "u1" });
    } finally {
      console.warn = warn;
    }
  });

  it("caches: no positive cache by default, cacheMs reuses an active answer, inactive answers stick until the JWT expires", async () => {
    const sessions = new Map<string, SessionLookupAnswer>([["s1", { active: true }]]);
    const origin = fakeOrigin(sessions);
    const token = await sign({ sub: "u1", sid: "s1" });
    const { auth } = remote(origin.fetch);
    await auth.verify(token, { sensitive: true });
    await auth.verify(token, { sensitive: true });
    expect(origin.calls).toHaveLength(2);
    // Revoked at the origin: the very next sensitive call is refused.
    sessions.set("s1", { active: false });
    expect(await auth.verify(token, { sensitive: true })).toBeNull();
    sessions.set("s1", { active: true }); // (an origin would not revive it: the negative answer is kept)
    expect(await auth.verify(token, { sensitive: true })).toBeNull();
    expect(origin.calls).toHaveLength(3);
    expect(auth.sessionLookupStats()).toMatchObject({ lookups: 3, cacheHits: 1 });

    const cached = fakeOrigin(new Map([["s2", { active: true }]]));
    const c = remote(cached.fetch, { cacheMs: 60_000 }).auth;
    const t2 = await sign({ sub: "u1", sid: "s2" });
    await c.verify(t2, { sensitive: true });
    expect(await c.verify(t2, { sensitive: true })).toMatchObject({ subject: "u1" });
    expect(cached.calls).toHaveLength(1);
    // Errors are never cached.
    const flaky = fakeOrigin(new Map([["s3", { active: true }]]), { status: 500 });
    const f = remote(flaky.fetch, { cacheMs: 60_000 }).auth;
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      const t3 = await sign({ sub: "u1", sid: "s3" });
      await f.verify(t3, { sensitive: true });
      await f.verify(t3, { sensitive: true });
    } finally {
      console.warn = warn;
    }
    expect(flaky.calls).toHaveLength(2);
  });

  it("a function is a custom integration (claims in, { active } out), with the same timeout", async () => {
    const seen: unknown[] = [];
    const auth = remoteAuth({
      from: ORIGIN,
      jwks: { keys: [jwk] },
      sessionLookup: async (claims) => (seen.push({ sub: claims.sub, sid: claims.sid, org: claims.org }), { active: claims.sid === "ok" }),
    });
    expect(await auth.verify(await sign({ sub: "u1", sid: "ok", org: "acme" }), { sensitive: true })).toMatchObject({ subject: "u1" });
    expect(await auth.verify(await sign({ sub: "u1", sid: "no" }), { sensitive: true })).toBeNull();
    expect(seen).toEqual([
      { sub: "u1", sid: "ok", org: "acme" },
      { sub: "u1", sid: "no", org: undefined },
    ]);
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      const hang = remoteAuth({ from: ORIGIN, jwks: { keys: [jwk] }, sessionLookup: { check: () => new Promise<never>(() => undefined), timeoutMs: 30 } });
      expect(await hang.verify(await sign({ sub: "u1", sid: "ok" }), { sensitive: true })).toBeNull();
    } finally {
      console.warn = warn;
    }
  });

  it("without sessionLookup a sensitive JWT check still fails closed", async () => {
    const auth = remoteAuth({ from: ORIGIN, jwks: { keys: [jwk] } });
    expect(await auth.verify(await sign({ sub: "u1", sid: "s1" }), { sensitive: true })).toBeNull();
    expect(auth.remote).toEqual({ from: ORIGIN });
    expect(auth.sessionLookupStats()).toBeNull();
  });
});
