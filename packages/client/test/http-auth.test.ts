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
  }) as typeof globalThis.fetch;
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

  it("calls refused together renew the token once (single-flight), and one refused later reuses the renewal", async () => {
    const revoked = jwt("ana", 3600);
    const fresh = jwt("ana", 7200);
    const w = worker(new Set([revoked]));
    const { c, fetched } = client(w.fetch, [revoked, fresh, jwt("ana", 9000)]);
    const got = await Promise.all([c.query(q, {}), c.action(act, {}), c.query(q, { n: 1 })]);
    expect(got).toEqual([1, 2, 3].map(() => `Bearer ${fresh}`));
    expect(fetched).toEqual([revoked, fresh]);

    // Sent with the revoked token, answered after another call renewed it: retried with that renewal, no new fetch.
    const w2 = worker(new Set([revoked]));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let first = true;
    const slow = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await w2.fetch(input, init);
      if (first) {
        first = false;
        await gate;
      }
      return res;
    }) as typeof fetch;
    const { c: c2, fetched: fetched2 } = client(slow, [revoked, fresh, jwt("ana", 9000)]);
    const late = c2.query(q, {});
    await new Promise((r) => setTimeout(r, 5));
    expect(await c2.query(q, { n: 2 })).toBe(`Bearer ${fresh}`);
    release();
    expect(await late).toBe(`Bearer ${fresh}`);
    expect(fetched2).toEqual([revoked, fresh]);
    c.close();
    c2.close();
  });

  it("a 401 whose renewal is someone else's token: not sent again as them", async () => {
    for (const call of [(c: EmberClient) => c.action(act, {}), (c: EmberClient) => c.query(q, {})]) {
      const ana = jwt("ana", 3600);
      const w = worker(new Set([ana]));
      const { c, fetched } = client(w.fetch, [ana, jwt("bob", 3600)]);
      expect(((await call(c).catch((x: unknown) => x)) as EmberError).code).toBe("unauthenticated");
      expect(w.calls.map((x) => x.authorization)).toEqual([`Bearer ${ana}`]);
      expect(fetched).toHaveLength(2);
      c.close();
    }
  });
});

describe("hydrate and whose read it is", () => {
  it("a fetchForHydration read for one identity is not hydrated once the fetcher answers for another", async () => {
    const w = worker();
    const ana = jwt("ana", 10); // inside the refresh window: the next call renews it
    const { c } = client(w.fetch, [ana, jwt("bob", 3600)]);
    const h = await c.fetchForHydration(q, {});
    expect(h.value).toBe(`Bearer ${ana}`);
    await c.query(q, { other: 1 }); // renewed: now bob's
    c.hydrate(h);
    expect(c.dehydrate()).toEqual([]);
    expect(c.watchQuery(q, {}).getSnapshot().status).toBe("loading");
    c.close();

    // An opaque token says nobody's name: a read made with one is not hydrated once the client holds another.
    const refused = new Set<string>();
    const w3 = worker(refused);
    const { c: c3 } = client(w3.fetch, ["opaque-1", "opaque-2"]);
    const h3 = await c3.fetchForHydration(q, {});
    refused.add("opaque-1");
    expect(await c3.query(q, { other: 1 })).toBe("Bearer opaque-2"); // 401, renewed, retried
    c3.hydrate(h3);
    expect(c3.dehydrate()).toEqual([]);
    c3.close();

    // The same user's renewed JWT: hydrated as usual.
    const { c: c2 } = client(worker().fetch, [ana, jwt("ana", 3600)]);
    const h2 = await c2.fetchForHydration(q, {});
    await c2.query(q, { other: 1 });
    c2.hydrate(h2);
    expect(c2.dehydrate()).toEqual([h2]);
    c2.close();
  });

  it("a fetchForHydration read is not hydrated once setAuth replaced its source, even before the new token is known", async () => {
    const w = worker();
    const { c } = client(w.fetch, [jwt("ana", 3600)]);
    const h = await c.fetchForHydration(q, {});
    // The new source has not answered yet: whom it answers for is unknown, and Ana's read is not theirs.
    c.setAuth(() => new Promise<string>(() => {}));
    c.hydrate(h);
    expect(c.dehydrate()).toEqual([]);
    expect(c.watchQuery(q, {}).getSnapshot().status).toBe("loading");
    c.close();
  });

  it("a fetchForHydration read for one identity is not installed into another identity's loading subscription", async () => {
    let hang = false;
    const w = worker();
    const fetch = ((input: RequestInfo | URL, init?: RequestInit) => (hang ? new Promise<Response>(() => {}) : w.fetch(input, init))) as typeof globalThis.fetch;
    const ana = jwt("ana", 10);
    const { c } = client(fetch, [ana, jwt("bob", 3600)]);
    const h = await c.fetchForHydration(q, {});
    await c.query(q, { other: 1 }); // renewed: now bob's (same source, same authGen)
    hang = true; // bob's own read of the query stays on its way: the subscription is loading
    const watched = c.watchQuery(q, {});
    let notified = 0;
    const off = watched.subscribe(() => notified++);
    expect(watched.getSnapshot().status).toBe("loading");
    c.hydrate(h);
    expect(watched.getSnapshot().status).toBe("loading");
    expect(notified).toBe(0);
    off();
    c.close();

    // The same identity's read still fills its loading subscription.
    hang = false;
    const { c: c2 } = client(fetch, [jwt("ana", 3600)]);
    const h2 = await c2.fetchForHydration(q, {});
    hang = true;
    const watched2 = c2.watchQuery(q, {});
    const off2 = watched2.subscribe(() => {});
    expect(watched2.getSnapshot().status).toBe("loading");
    c2.hydrate(h2);
    expect(watched2.getSnapshot()).toMatchObject({ status: "success", value: h2.value });
    off2();
    c2.close();
  });

  it("values hydrated before the first token belong to the identity it names, and leave when the fetcher answers for another", async () => {
    const w = worker();
    const ana = jwt("ana", 10);
    const { c } = client(w.fetch, [ana, jwt("ana", 20), jwt("bob", 3600)]);
    const server = { fn: "notes:list", args: {}, shard: "global:main", value: ["ana's"], version: 1, epoch: "e", ik: "k" };
    c.hydrate(server);
    expect(c.watchQuery(q, {}).getSnapshot().value).toEqual(["ana's"]);
    await c.query(q, { other: 1 }); // first token: ana
    expect(c.dehydrate()).toEqual([server]);
    await c.query(q, { other: 2 }); // ana renewed (still inside the window)
    expect(c.dehydrate()).toEqual([server]);
    await c.query(q, { other: 3 }); // bob
    expect(c.dehydrate()).toEqual([]);
    expect(c.watchQuery(q, {}).getSnapshot().status).toBe("loading");
    c.close();
  });

  it("a serialized entry (from a server render) is never shown after the identity changed, not even the same one again", async () => {
    const server = { fn: "notes:list", args: {}, shard: "global:main", value: ["ana's"], version: 1, epoch: "e", ik: "k" };
    const other = { ...server, args: { page: 2 }, value: ["ana's too"] };
    // setAuth: the page's preload handed over again (a remount), and one the app kept but never handed over.
    const { c } = client(worker().fetch, [jwt("ana", 3600)]);
    c.hydrate(server);
    await c.query(q, { other: 1 }); // ana
    expect(c.dehydrate()).toEqual([server]);
    c.setAuth(() => jwt("bob", 3600));
    await c.query(q, { other: 2 }); // bob
    c.hydrate(server, other);
    expect(c.dehydrate()).toEqual([]);
    expect(c.watchQuery(q, {}).getSnapshot().status).toBe("loading");
    expect(c.watchQuery(q, { page: 2 }).getSnapshot().status).toBe("loading");
    c.close();
    // Signed out: nobody's either.
    const { c: c2 } = client(worker().fetch, [jwt("ana", 3600)]);
    c2.hydrate(server);
    await c2.query(q, { other: 1 });
    c2.clearAuth();
    c2.hydrate(server);
    expect(c2.dehydrate()).toEqual([]);
    c2.close();
    // The same source answering for someone else (no setAuth): the first identity's entries only.
    const { c: c3 } = client(worker().fetch, [jwt("ana", 10), jwt("bob", 3600)]);
    await c3.query(q, { other: 1 }); // ana
    c3.hydrate(other);
    expect(c3.dehydrate()).toEqual([other]);
    await c3.query(q, { other: 2 }); // renewed: bob
    c3.hydrate(server);
    expect(c3.dehydrate()).toEqual([]);
    c3.close();
  });

  it("an anonymous session that already sent requests and signs in: a serialized entry is nobody's while the token is on its way", async () => {
    const server = { fn: "notes:list", args: {}, shard: "global:main", value: ["anon"], version: 1, epoch: "e", ik: "k" };
    // No auth source: anonymous, and it already read (the answer names nobody).
    const c = new EmberClient({ url: "https://ember.test", WebSocket: null, fetch: worker().fetch, connectivity: null, heartbeat: false, defaultShard: "global:main" });
    await c.query(q, { other: 1 });
    let release!: (t: string) => void;
    c.setAuth(() => new Promise<string>((r) => (release = r)));
    // The old (anonymous) preload handed over again while ana's token is pending: not shown.
    c.hydrate(server);
    expect(c.dehydrate()).toEqual([]);
    expect(c.watchQuery(q, {}).getSnapshot().status).toBe("loading");
    release(jwt("ana", 3600));
    c.close();
  });

  it("onIdentityChange: on a switch and a sign-out; not on the first sign-in nor on a renewed token", async () => {
    const c = new EmberClient({ url: "https://ember.test", WebSocket: null, fetch: worker().fetch, connectivity: null, heartbeat: false, defaultShard: "global:main" });
    let n = 0;
    const off = c.onIdentityChange(() => n++);
    let tokens = [jwt("ana", 10), jwt("ana", 3600)];
    let i = 0;
    c.setAuth(() => tokens[Math.min(i++, tokens.length - 1)]!);
    await c.query(q, { a: 1 });
    await c.query(q, { a: 2 }); // renewed: still ana
    expect(n).toBe(0);
    tokens = [jwt("bob", 10)];
    i = 0;
    c.setAuth(() => tokens[0]!);
    expect(n).toBe(1);
    c.clearAuth();
    expect(n).toBe(2);
    off();
    c.setAuth(() => jwt("cy", 3600));
    expect(n).toBe(2);
    c.close();
  });

  it("onIdentityChange: a known anonymous session that signs in (fetcher null → JWT, or no source → setAuth); once per change", async () => {
    // The same fetcher answers null (anonymous queries went out), then Ana's token.
    const base = { url: "https://ember.test", WebSocket: null, connectivity: null, heartbeat: false, defaultShard: "global:main" } as const;
    let token: string | null = null;
    const a = new EmberClient({ ...base, fetch: worker().fetch, auth: () => token });
    let n = 0;
    a.onIdentityChange(() => n++);
    await a.query(q, { a: 1 }); // anonymous
    expect(n).toBe(0);
    token = jwt("ana", 3600);
    // The next fetch (a refresh, a reconnect) gets Ana's token from the same fetcher.
    await (a as unknown as { fetchToken(): Promise<string | null> }).fetchToken();
    expect(n).toBe(1);
    await a.query(q, { a: 3 }); // still ana
    expect(n).toBe(1);
    a.close();
    // No source: anonymous requests went out, then setAuth signs in.
    const b = new EmberClient({ ...base, fetch: worker().fetch });
    let m = 0;
    b.onIdentityChange(() => m++);
    await b.query(q, { a: 1 });
    b.setAuth(() => jwt("ana", 3600));
    expect(m).toBe(1);
    // The new source's first answer (ana) is not another change: setAuth told already.
    await b.query(q, { a: 2 });
    expect(m).toBe(1);
    // A switch: told at setAuth, not again when bob's token arrives.
    b.setAuth(() => jwt("bob", 3600));
    await b.query(q, { a: 3 });
    expect(m).toBe(2);
    b.close();
    // No source and nothing sent yet: the first sign-in is not a change.
    const c = new EmberClient({ ...base, fetch: worker().fetch });
    let k = 0;
    c.onIdentityChange(() => k++);
    c.setAuth(() => jwt("ana", 3600));
    await c.query(q, { a: 1 });
    expect(k).toBe(0);
    c.close();
  });
});
