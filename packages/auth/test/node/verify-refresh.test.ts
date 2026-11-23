/**
 * The JWKS refresh after the TTL (`verify-core.ts`), with a fake clock and a counting `jwks.fetch` (the Auth DO's
 * `getJwks`). A background refresh workerd cancels with the response must not be started again by every request: it
 * runs under the request's `waitUntil`, or not at all (the cached keys keep verifying, an unknown `kid` still fetches).
 */
import { exportJWK, generateKeyPair, SignJWT, type JSONWebKeySet, type JWK } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { createVerifier } from "../../src/verify-core.ts";

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
function setup(fetchImpl?: () => Promise<JSONWebKeySet>) {
  const clock = { t: 1_700_000_000_000 };
  const calls = { fetch: 0 };
  const v = createVerifier({
    jwks: {
      static: { keys: [k1.jwk] },
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
    clock.t += TTL + 1; // stale too: the on-demand fetch is the one that runs
    const token = await k2.sign("caio");
    expect((await v.verify(token))?.subject).toBe("caio");
    expect(calls.fetch).toBe(1);
    expect(v.jwks()?.keys.map((k) => k.kid)).toEqual(["k1", "k2"]);

    // A kid nobody publishes: one fetch, then refused without fetching until the cooldown passes.
    const ghost = await key("ghost");
    const forged = await ghost.sign("x");
    // (The fetch for k2 was the TTL one: it does not count toward the unknown-kid cooldown.)
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
