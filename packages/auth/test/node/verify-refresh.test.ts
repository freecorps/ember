/**
 * The JWKS refresh after the TTL (`verify-core.ts`), with a fake clock and a counting `jwks.fetch` (the Auth DO's
 * `getJwks`). A background refresh workerd cancels with the response must not be started again by every request: it
 * runs under the request's `waitUntil`, or not at all (the cached keys keep verifying, an unknown `kid` still fetches).
 */
import { exportJWK, generateKeyPair, SignJWT, type JSONWebKeySet, type JWK } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { createVerifier } from "../../src/verify-core.ts";
import { createVerifier as createBetterAuthVerifier } from "../../src/verify.ts";

const TTL = 15 * 60_000;
const COOLDOWN = 30_000;

type Key = { kid: string; jwk: JWK; sign: (sub: string) => Promise<string> };

async function key(kid: string): Promise<Key> {
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519" });
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: "EdDSA" };
  return {
    kid,
    jwk,
    sign: (sub) =>
      new SignJWT({ sid: `s-${sub}` })
        .setProtectedHeader({ alg: "EdDSA", kid })
        .setSubject(sub)
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(privateKey),
  };
}

let k1: Key;
let k2: Key;
beforeAll(async () => {
  k1 = await key("k1");
  k2 = await key("k2");
});

/** A verifier on a fake clock, `fetch` standing in for `stub.getJwks()` (counted). */
function setup(fetchImpl?: () => Promise<JSONWebKeySet>, staticKeys: JSONWebKeySet | null = { keys: [k1.jwk] }) {
  const clock = { t: 1_700_000_000_000 };
  const calls = { fetch: 0 };
  const v = createVerifier({
    jwks: {
      static: staticKeys,
      fetch: () => (calls.fetch++, fetchImpl ? fetchImpl() : Promise.resolve({ keys: [k1.jwk, k2.jwk] })),
    },
    lookup: async () => null,
    now: () => clock.t,
  });
  /** `waitUntil` of a request: records what it is handed. */
  const ctx = () => {
    const handed: Promise<unknown>[] = [];
    return { handed, waitUntil: (p: Promise<unknown>) => void handed.push(p) };
  };
  return { v, clock, calls, ctx };
}

/** Fetches settled by hand, in any order: `fetches[i]` is the i-th `jwks.fetch()`. */
function manualFetch() {
  const fetches: { resolve: (s: JSONWebKeySet) => void; reject: (e: Error) => void }[] = [];
  const impl = () => new Promise<JSONWebKeySet>((resolve, reject) => void fetches.push({ resolve, reject }));
  return { fetches, impl };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("JWKS refresh after the TTL", () => {
  it("with waitUntil: one refresh after the TTL, handed to waitUntil; none again until the next TTL", async () => {
    const { v, clock, calls, ctx } = setup();
    const token = await k1.sign("ana");
    expect((await v.verify(token))?.subject).toBe("ana");
    expect(calls.fetch).toBe(0); // the deploy-time keys: no fetch at all

    clock.t += TTL + 1;
    const first = ctx();
    // Concurrent requests while the refresh runs: still one fetch, handed to the first request's waitUntil only.
    const others = [ctx(), ctx(), ctx()];
    const results = await Promise.all([v.verify(token, { waitUntil: first.waitUntil }), ...others.map((c) => v.verify(token, { waitUntil: c.waitUntil }))]);
    expect(results.map((r) => r?.subject)).toEqual(["ana", "ana", "ana", "ana"]); // stale keys keep verifying meanwhile
    expect(calls.fetch).toBe(1);
    expect(first.handed).toHaveLength(1);
    expect(others.every((c) => c.handed.length === 0)).toBe(true);
    await Promise.all(first.handed);
    expect(v.jwks()?.keys.map((k) => k.kid)).toEqual(["k1", "k2"]);

    // Fresh again: requests every 10 s for the rest of the TTL fetch nothing.
    for (let i = 0; i < 80; i++) {
      clock.t += 10_000;
      const c = ctx();
      expect((await v.verify(token, { waitUntil: c.waitUntil }))?.subject).toBe("ana");
      expect(c.handed).toHaveLength(0);
    }
    expect(calls.fetch).toBe(1);

    // The next TTL: one more.
    clock.t += TTL;
    const next = ctx();
    await v.verify(token, { waitUntil: next.waitUntil });
    expect(next.handed).toHaveLength(1);
    await Promise.all(next.handed);
    expect(calls.fetch).toBe(2);
  });

  it("without waitUntil: stale keys keep verifying and the Auth DO is never called (a request every 10 s, for an hour)", async () => {
    const { v, clock, calls } = setup();
    const token = await k1.sign("bia");
    clock.t += TTL + 1;
    for (let i = 0; i < 360; i++) {
      expect((await v.verify(token))?.subject).toBe("bia");
      clock.t += 10_000;
    }
    expect(calls.fetch).toBe(0);
  });

  it("an unknown kid still fetches on demand (with or without waitUntil), within the cooldown", async () => {
    const { v, clock, calls } = setup();
    // Stale too: the fetch k2 needs runs as the TTL refresh (in the request, without waitUntil), which does not
    // count toward the unknown-kid cooldown.
    clock.t += TTL + 1;
    const token = await k2.sign("caio");
    expect((await v.verify(token))?.subject).toBe("caio");
    expect(calls.fetch).toBe(1);
    expect(v.jwks()?.keys.map((k) => k.kid)).toEqual(["k1", "k2"]);

    // A kid nobody publishes: one fetch, then refused without fetching until the cooldown passes.
    const ghost = await key("ghost");
    const forged = await ghost.sign("x");
    // The set is fresh now and no unknown-kid fetch ran yet: this one fetches (and starts the cooldown).
    expect(await v.verify(forged)).toBeNull();
    expect(calls.fetch).toBe(2);
    expect(await v.verify(forged)).toBeNull();
    expect(calls.fetch).toBe(2);
    clock.t += COOLDOWN + 1;
    expect(await v.verify(forged)).toBeNull();
    expect(calls.fetch).toBe(3);
  });

  it("a failed background refresh is retried after the cooldown, not by every request", async () => {
    const { v, clock, calls, ctx } = setup(() => Promise.reject(new Error("Auth DO unavailable")));
    const token = await k1.sign("davi");
    clock.t += TTL + 1;
    for (let i = 0; i < 10; i++) {
      const c = ctx();
      expect((await v.verify(token, { waitUntil: c.waitUntil }))?.subject).toBe("davi");
      await Promise.all(c.handed); // settles (the rejection is caught): nothing left pending
      clock.t += 2_000;
    }
    expect(calls.fetch).toBe(1);
    clock.t += COOLDOWN;
    const c = ctx();
    await v.verify(token, { waitUntil: c.waitUntil });
    expect(c.handed).toHaveLength(1);
    expect(calls.fetch).toBe(2);
  });

  it("a refresh that never settles (cut short) does not leave a pending state that refetches every 10 s", async () => {
    const { v, clock, calls, ctx } = setup(() => new Promise<JSONWebKeySet>(() => undefined));
    const token = await k1.sign("eva");
    clock.t += TTL + 1;
    await v.verify(token, { waitUntil: ctx().waitUntil });
    expect(calls.fetch).toBe(1);
    // Past the 10 s after which the lost fetch no longer blocks new ones, but inside the cooldown: no new fetch.
    for (let i = 0; i < 5; i++) {
      clock.t += 5_000;
      expect((await v.verify(token, { waitUntil: ctx().waitUntil }))?.subject).toBe("eva");
    }
    expect(calls.fetch).toBe(1);
    clock.t += COOLDOWN;
    await v.verify(token, { waitUntil: ctx().waitUntil });
    expect(calls.fetch).toBe(2);
  });

  it("without waitUntil, a stale set with an unknown kid refreshes in the request, at most once per cooldown", async () => {
    const { v, clock, calls } = setup(() => Promise.reject(new Error("Auth DO unavailable")));
    clock.t += TTL + 1;
    const token = await k2.sign("gil");
    for (let i = 0; i < 10; i++) {
      expect(await v.verify(token)).toBeNull();
      clock.t += 1_000;
    }
    // The failed TTL refresh (1) and one unknown-kid fetch (2); then both wait for their cooldown.
    expect(calls.fetch).toBe(2);
  });

  it("a waitUntil that throws (context gone) does not fail the verify", async () => {
    const { v, clock, calls } = setup();
    const token = await k1.sign("fred");
    clock.t += TTL + 1;
    const waitUntil = () => {
      throw new Error("waitUntil() called after the response");
    };
    expect((await v.verify(token, { waitUntil }))?.subject).toBe("fred");
    expect(calls.fetch).toBe(1);
  });
});

describe("JWKS fetches in flight", () => {
  it("only the newest fetch publishes: an older one in flight across reset() (same millisecond) resolving last is dropped", async () => {
    const m = manualFetch();
    const { v, calls, ctx } = setup(m.impl, null);
    // Fetch A: the first verify (no keys yet).
    const a = v.verify(await k1.sign("hana"), { waitUntil: ctx().waitUntil });
    expect(calls.fetch).toBe(1);
    v.reset(); // the clock does not move: B starts at A's timestamp
    // Fetch B: after the reset A no longer holds the slot.
    const b = v.verify(await k2.sign("hana"), { waitUntil: ctx().waitUntil });
    expect(calls.fetch).toBe(2);
    m.fetches[1]!.resolve({ keys: [k2.jwk] });
    expect((await b)?.subject).toBe("hana");
    // A resolves last, with the older set: not published.
    m.fetches[0]!.resolve({ keys: [k1.jwk] });
    expect(await a).toBeNull();
    expect(v.jwks()?.keys.map((k) => k.kid)).toEqual(["k2"]);
  });

  it("a superseded fetch settling first neither publishes nor frees the slot of the newer one", async () => {
    const m = manualFetch();
    const { v, calls } = setup(m.impl);
    const pa = v.publicJwks(); // A (not fetched yet: fetches)
    v.reset({ keys: [k1.jwk] });
    const pb = v.publicJwks(); // B, same millisecond
    expect(calls.fetch).toBe(2);
    m.fetches[0]!.resolve({ keys: [k1.jwk] });
    expect(await pa).toBeNull(); // dropped: nothing fetched since the reset
    // B still holds the slot: another refresh joins it instead of fetching.
    const pc = v.publicJwks();
    expect(calls.fetch).toBe(2);
    m.fetches[1]!.resolve({ keys: [k1.jwk, k2.jwk] });
    expect((await pb)?.keys.map((k) => k.kid)).toEqual(["k1", "k2"]);
    expect((await pc)?.keys.map((k) => k.kid)).toEqual(["k1", "k2"]);
  });

  it("an unknown kid awaiting a TTL refresh that fails fetches again itself (the cooldown allowing)", async () => {
    const m = manualFetch();
    const { v, clock, calls, ctx } = setup(m.impl);
    clock.t += TTL + 1;
    const bg = ctx();
    expect((await v.verify(await k1.sign("ines"), { waitUntil: bg.waitUntil }))?.subject).toBe("ines");
    expect(calls.fetch).toBe(1); // the TTL refresh, in the background
    const pending = v.verify(await k2.sign("ines"));
    await tick();
    m.fetches[0]!.reject(new Error("Auth DO unavailable"));
    await tick();
    expect(calls.fetch).toBe(2); // its own (cooled) fetch
    m.fetches[1]!.resolve({ keys: [k1.jwk, k2.jwk] });
    expect((await pending)?.subject).toBe("ines");
    // Within the cooldown now: another unknown kid is refused without fetching.
    expect(await v.verify(await (await key("ghost")).sign("x"))).toBeNull();
    expect(calls.fetch).toBe(2);
  });

  it("the first fetch (no keys at all) is handed to waitUntil too, so it outlives the request", async () => {
    const m = manualFetch();
    const { v, calls, ctx } = setup(m.impl, null);
    const c = ctx();
    const r = v.verify(await k1.sign("joao"), { waitUntil: c.waitUntil });
    expect(calls.fetch).toBe(1);
    expect(c.handed).toHaveLength(1);
    m.fetches[0]!.resolve({ keys: [k1.jwk] });
    expect((await r)?.subject).toBe("joao");
    await Promise.all(c.handed);
  });
});

describe("verify.ts", () => {
  it("always decodes the cookie cache with Better Auth (a caller's readCookieCache is not taken)", async () => {
    let called = false;
    const v = createBetterAuthVerifier({
      jwks: { fetch: async () => ({ keys: [] }) },
      cookie: { secret: "s".repeat(32), prefix: "app", strategy: "compact" },
      lookup: async () => null,
      // Not in its type: a plain config object passed through as is.
      ...({ readCookieCache: async () => ((called = true), { session: { id: "s", userId: "u", expiresAt: Date.now() + 60_000 }, user: { id: "u" } }) } as object),
    });
    expect(await v.verifyRequest(new Request("https://x", { headers: { cookie: "app.session_data=forged" } }))).toBeNull();
    expect(called).toBe(false);
  });
});
