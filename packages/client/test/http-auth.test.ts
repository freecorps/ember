// HTTP calls (`query` over HTTP, `action`, `fetchForHydration`) and the token: an expired (or about to expire) JWT is
// renewed before it goes out, and a `401 unauthenticated` renews it and sends the call again, exactly once.
import { describe, expect, it } from "vitest";
import { EmberClient, EmberError, unsafeRef } from "../src/index.ts";

const jwt = (sub: string, expInS: number) => `x.${Buffer.from(JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + expInS })).toString("base64url")}.y`;

const q = unsafeRef<"query">("notes:list");
const act = unsafeRef<"action">("notes:sync");

/** A Worker that answers every call, refusing the tokens in `refused` as the runtime does (401 unauthenticated). */
function worker(refused: Set<string> = new Set()) {
  const calls: Array<{ path: string; authorization: string | null }> = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const authorization = new Headers(init?.headers).get("authorization");
    calls.push({ path: new URL(String(input)).pathname, authorization });
    if (authorization && refused.has(authorization.slice(7))) {
      return new Response(JSON.stringify({ ok: false, error: { code: "unauthenticated", message: "invalid token" } }), { status: 401 });
    }
    return new Response(JSON.stringify({ ok: true, value: authorization, version: 1, epoch: "e", ik: "k" }), { status: 200 });
  }) as typeof fetch;
  return { calls, fetch };
}

function client(fetch: typeof globalThis.fetch, tokens: string[]) {
  let i = 0;
  const fetched: string[] = [];
  const c = new EmberClient({
    url: "https://ember.test",
    WebSocket: null,
    fetch,
    connectivity: null,
    heartbeat: false,
    defaultShard: "global:main",
    auth: () => {
      const t = tokens[Math.min(i++, tokens.length - 1)]!;
      fetched.push(t);
      return t;
    },
  });
  return { c, fetched };
}

const calls = {
  query: (c: EmberClient) => c.query(q, {}),
  action: (c: EmberClient) => c.action(act, {}),
  fetchForHydration: (c: EmberClient) => c.fetchForHydration(q, {}).then((h) => h.value),
};

describe("HTTP calls and the JWT", () => {
  for (const [name, call] of Object.entries(calls)) {
    it(`${name}: a token that expired, or is inside its refresh window, is renewed before it goes out`, async () => {
      const w = worker();
      const near = jwt("ana", 10); // inside the default 30 s window
      const expired = jwt("ana", -5);
      const fresh = jwt("ana", 3600);
      const { c } = client(w.fetch, [near, expired, fresh]);
      // The first call sends what the fetcher gave (nothing newer to ask for).
      expect(await call(c)).toBe(`Bearer ${near}`);
      // Then: `near` is due → renewed (to an expired one, sent as the fetcher's latest)… then renewed again.
      expect(await call(c)).toBe(`Bearer ${expired}`);
      expect(await call(c)).toBe(`Bearer ${fresh}`);
      // A valid token is reused, not fetched again.
      expect(await call(c)).toBe(`Bearer ${fresh}`);
      expect(w.calls.map((x) => x.authorization)).toEqual([near, expired, fresh, fresh].map((t) => `Bearer ${t}`));
      c.close();
    });

    it(`${name}: a 401 unauthenticated renews the token and retries exactly once`, async () => {
      const revoked = jwt("ana", 3600);
      const fresh = jwt("ana", 7200);
      const w = worker(new Set([revoked]));
      const { c, fetched } = client(w.fetch, [revoked, fresh]);
      expect(await call(c)).toBe(`Bearer ${fresh}`);
      expect(w.calls.map((x) => x.authorization)).toEqual([`Bearer ${revoked}`, `Bearer ${fresh}`]);
      expect(fetched).toEqual([revoked, fresh]);
      c.close();
    });

    it(`${name}: refused again after the retry (or no newer token): the error, no loop`, async () => {
      const a = jwt("ana", 3600);
      const b = jwt("ana", 7200);
      const w = worker(new Set([a, b]));
      const { c } = client(w.fetch, [a, b]);
      const e = await call(c).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(EmberError);
      expect((e as EmberError).code).toBe("unauthenticated");
      expect(w.calls).toHaveLength(2);
      c.close();

      // The fetcher has nothing newer: one request, no retry with the very token refused.
      const w2 = worker(new Set([a]));
      const { c: c2 } = client(w2.fetch, [a]);
      expect(((await call(c2).catch((x: unknown) => x)) as EmberError).code).toBe("unauthenticated");
      expect(w2.calls).toHaveLength(1);
      c2.close();
    });
  }

  it("a sign-in/out while the call was refused: not retried as the new identity", async () => {
    const a = jwt("ana", 3600);
    const w = worker(new Set([a]));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await w.fetch(input, init);
      await gate;
      return res;
    }) as typeof fetch;
    const { c } = client(slow, [a]);
    const p = c.query(q, {}).catch((x: unknown) => x);
    await new Promise((r) => setTimeout(r, 5));
    c.setAuth(() => jwt("bob", 3600));
    release();
    expect(((await p) as EmberError).code).toBe("unauthenticated");
    expect(w.calls).toHaveLength(1);
    c.close();
  });
});
