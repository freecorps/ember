/**
 * Cacheable public queries over HTTP: `query({ cache: { maxAge, swr } })` answers anonymous
 * `GET /api/query/<fn>?args=<json>` with `Cache-Control: public` and keeps it in `caches.default`, keyed by the canonical
 * args, the shard and the Worker version. Signed-in calls are never cached; functions without `cache` refuse GET.
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { api, sleep } from "./helpers.ts";
import worker from "./worker.ts";

type Env = typeof env;

/** One `GET /api/query/<fn>` through the Worker, its `waitUntil` work (the cache writes) awaited. */
async function get(fn: string, args: unknown, opts: { shard?: string; token?: string; cookie?: string; env?: Env; raw?: string } = {}) {
  const q = new URLSearchParams();
  if (opts.raw !== undefined) q.set("args", opts.raw);
  else if (args !== undefined) q.set("args", JSON.stringify(args));
  if (opts.shard) q.set("shard", opts.shard);
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.cookie) headers.cookie = opts.cookie;
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`http://ember.test/api/query/${fn}?${q}`, { headers }), (opts.env ?? env) as never, ctx);
  const body = (await res.json()) as { ok: boolean; value?: unknown; error?: { code: string } };
  await waitOnExecutionContext(ctx);
  return { status: res.status, body, cache: res.headers.get("x-ember-cache"), cacheControl: res.headers.get("cache-control"), vary: res.headers.get("vary") };
}

const send = async (shard: string, channel: string, body: string) => expect((await api("mutation", { fn: "messages:send", args: { channel, body }, shard })).body.ok).toBe(true);
/** The test env with the Shard stubs' `query` RPCs counted. */
function counting(): { env: Env; queries: () => number } {
  let n = 0;
  const ns = env.SHARD;
  const SHARD = {
    idFromName: (x: string) => ns.idFromName(x),
    get: (id: DurableObjectId, o?: DurableObjectNamespaceGetDurableObjectOptions) =>
      new Proxy(ns.get(id, o) as unknown as Record<string, unknown>, {
        get(t, p) {
          const v = Reflect.get(t, p);
          if (p !== "query") return v;
          return (...a: unknown[]) => {
            n++;
            return (v as (...x: unknown[]) => unknown)(...a);
          };
        },
      }),
  };
  return { env: { ...env, SHARD } as unknown as Env, queries: () => n };
}

describe("GET /api/query/<fn> (cache)", () => {
  it("anonymous: a miss runs the query and stores it; a hit answers without the shard, even after a write", async () => {
    const shard = "hc:hit";
    await send(shard, "c", "one");
    const miss = await get("cached:list", { channel: "c" }, { shard });
    expect(miss).toMatchObject({ status: 200, body: { ok: true, value: ["one"] }, cache: "MISS", cacheControl: "public, max-age=60", vary: "authorization, cookie" });
    await send(shard, "c", "two");
    const counted = counting();
    const hit = await get("cached:list", { channel: "c" }, { shard, env: counted.env });
    expect(hit).toMatchObject({ status: 200, body: { ok: true, value: ["one"] }, cache: "HIT", cacheControl: "public, max-age=60" });
    // The same args spelled with other whitespace / key order share the entry.
    expect(await get("cached:list", undefined, { shard, raw: ' { "channel" : "c" } ', env: counted.env })).toMatchObject({ cache: "HIT", body: { value: ["one"] } });
    // No shard RPC for a hit (no DO request, no rows read).
    expect(counted.queries()).toBe(0);
    expect(await get("cached:list", { channel: "zz" }, { shard, env: counted.env })).toMatchObject({ cache: "MISS" });
    expect(counted.queries()).toBe(1);
    // Other args, other shard: their own entries.
    expect(await get("cached:list", { channel: "d" }, { shard })).toMatchObject({ cache: "MISS", body: { value: [] } });
    expect(await get("cached:list", { channel: "c" }, { shard: "hc:other" })).toMatchObject({ cache: "MISS", body: { value: [] } });
  });

  it("stale-while-revalidate: past maxAge the stale copy answers and one refresh stores the new value", async () => {
    const shard = "hc:swr";
    await send(shard, "s", "old");
    expect(await get("cached:swr", { channel: "s" }, { shard })).toMatchObject({ cache: "MISS", cacheControl: "public, max-age=1, stale-while-revalidate=60", body: { value: ["old"] } });
    await send(shard, "s", "new");
    expect(await get("cached:swr", { channel: "s" }, { shard })).toMatchObject({ cache: "HIT", body: { value: ["old"] } });
    await sleep(1100);
    // Stale: answered from the copy, refreshed in the background (awaited by `get`).
    expect(await get("cached:swr", { channel: "s" }, { shard })).toMatchObject({ cache: "STALE", body: { value: ["old"] } });
    expect(await get("cached:swr", { channel: "s" }, { shard })).toMatchObject({ cache: "HIT", body: { value: ["old", "new"] } });
  });

  it("signed-in calls are never cached (private, no-store) and see their own identity", async () => {
    expect(await get("cached:who", {})).toMatchObject({ cache: "MISS", body: { value: "anonymous" } });
    const amy = await get("cached:who", {}, { token: "good:amy" });
    expect(amy).toMatchObject({ status: 200, body: { value: "amy" }, cache: null, cacheControl: "private, no-store" });
    expect(await get("cached:who", {}, { token: "good:bob" })).toMatchObject({ body: { value: "bob" }, cacheControl: "private, no-store" });
    // A session cookie counts as signed in for the cache (never stored, never served from it).
    expect(await get("cached:who", {}, { cookie: "theme=dark; app.session_token=abc" })).toMatchObject({ cache: null, cacheControl: "private, no-store" });
    // An invalid token: 401, not the anonymous copy.
    expect(await get("cached:who", {}, { token: "bad" })).toMatchObject({ status: 401, cacheControl: "private, no-store" });
    // The anonymous copy is still the anonymous one.
    expect(await get("cached:who", {})).toMatchObject({ cache: "HIT", body: { value: "anonymous" } });
  });

  it("an error is never stored", async () => {
    const first = await get("cached:members", {});
    expect(first).toMatchObject({ status: 400, body: { ok: false, error: { code: "Unauthenticated" } }, cacheControl: "no-store" });
    expect((await get("cached:members", {})).cache).toBeNull();
    expect(await get("cached:members", {}, { token: "good:amy" })).toMatchObject({ body: { value: "amy" } });
  });

  it("functions without cache, mutations and actions refuse GET (405); bad args are 400/414", async () => {
    for (const path of ["messages:list", "nope:nope", "messages:send"]) expect((await get(path, { channel: "x" })).status).toBe(405);
    const ctx = createExecutionContext();
    for (const kind of ["mutation", "action"]) {
      const res = await worker.fetch(new Request(`http://ember.test/api/${kind}/cached:list?args={}`), env as never, ctx);
      expect(res.status).toBe(405);
    }
    expect((await get("cached:list", undefined, { raw: "{nope" })).status).toBe(400);
    expect((await get("cached:list", undefined, { raw: "[1]" })).status).toBe(400);
    expect((await get("cached:list", undefined, { raw: JSON.stringify({ channel: "x".repeat(9000) }) })).status).toBe(414);
    // Validation errors come from the shard as for POST (and are not stored).
    expect(await get("cached:list", { channel: 1 })).toMatchObject({ status: 400, body: { ok: false, error: { code: "ValidationError" } } });
  });

  it("routes by the function's argument, ?shard= or global:main", async () => {
    await send("room:r1", "r1", "in r1");
    expect(await get("cached:room", { room: "r1" })).toMatchObject({ body: { value: ["in r1"] } });
    expect(await get("cached:room", { room: "r1" }, { shard: "room:r2" })).toMatchObject({ status: 400, body: { error: { code: "WrongShard" } } });
    await send("global:main", "g", "in main");
    expect(await get("cached:list", { channel: "g" })).toMatchObject({ body: { value: ["in main"] } });
    expect((await get("cached:list", { channel: "g" }, { shard: "bad" })).status).toBe(400);
  });

  it("a new Worker version starts from an empty cache", async () => {
    const shard = "hc:deploy";
    await send(shard, "v", "before");
    expect(await get("cached:list", { channel: "v" }, { shard })).toMatchObject({ cache: "MISS" });
    await send(shard, "v", "after");
    expect(await get("cached:list", { channel: "v" }, { shard })).toMatchObject({ cache: "HIT", body: { value: ["before"] } });
    const next = { ...env, EMBER_VERSION: { id: "test-version-2" } } as Env;
    expect(await get("cached:list", { channel: "v" }, { shard, env: next })).toMatchObject({ cache: "MISS", body: { value: ["before", "after"] } });
    expect(await get("cached:list", { channel: "v" }, { shard, env: next })).toMatchObject({ cache: "HIT" });
  });
});
