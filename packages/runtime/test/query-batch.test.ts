// `POST /api/query/batch` (several queries of one shard in one request and one `Shard.queryBatch` RPC) and the run an
// HTTP query with `warm` leaves for the `sub` that follows it (`Shard.takePrefetched`).
import { createExecutionContext, env } from "cloudflare:test";
import { afterAll, describe, expect, it } from "vitest";
import { getEmberConfig, setEmberConfig } from "../src/config.ts";
import type { ServerMessage } from "../src/protocol.ts";
import type { Shard } from "../src/shard.ts";
import { createEmberWorker } from "../src/worker.ts";
import { api, connect, hello, is, shardStub } from "./helpers.ts";
import { input as config } from "./worker.ts";

type Snap = Extract<ServerMessage, { t: "snap" }> & { value?: unknown; unchanged?: boolean };

const original = getEmberConfig();
afterAll(() => setEmberConfig(original));

/** A Worker over `env` whose shard stubs count every RPC (method call) they get. */
function countingWorker() {
  const rpcs: string[] = [];
  const ns = env.SHARD;
  const SHARD = new Proxy(ns, {
    get(target, prop) {
      if (prop === "get") {
        return (id: DurableObjectId, o?: unknown) => {
          const stub = target.get(id, o as DurableObjectNamespaceGetDurableObjectOptions | undefined);
          return new Proxy(stub, {
            get(s, p) {
              const v = Reflect.get(s, p);
              if (typeof v !== "function" || typeof p !== "string") return v;
              return (...a: unknown[]) => {
                rpcs.push(p);
                return Reflect.apply(v as (...x: unknown[]) => unknown, s, a);
              };
            },
          });
        };
      }
      const v = Reflect.get(target, prop);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  const worker = createEmberWorker(config);
  const wenv = { ...env, SHARD };
  const post = async (path: string, body: unknown, token?: string) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await worker.fetch(new Request(`http://ember${path}`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) }), wenv as never, createExecutionContext());
    return { status: res.status, body: (await res.json()) as any };
  };
  return { rpcs, post };
}

describe("POST /api/query/batch", () => {
  it("answers N queries of one shard with one request and one shard RPC, each with its own outcome", async () => {
    const shard = "qbatch:one";
    await api("mutation", { fn: "messages:send", args: { channel: "a", body: "hi" }, shard }, "good:amy");
    try {
      const { rpcs, post } = countingWorker();
      const r = await post("/api/query/batch", {
        shard,
        queries: [
          { fn: "messages:list", args: { channel: "a" } },
          { fn: "typed:count", args: { channel: "a" } },
          { fn: "auth:whoami", args: {} },
          { fn: "nope:missing", args: {} },
          { fn: "messages:secret", args: {} },
          { fn: "messages:list", args: { channel: 3 } },
        ],
      }, "good:amy");
      expect(rpcs).toEqual(["queryBatch"]);
      expect(r.status).toBe(200);
      const [list, count, who, missing, internal, badArgs] = r.body.results;
      expect(list).toMatchObject({ ok: true, version: expect.any(Number), epoch: expect.any(String), ik: expect.any(String) });
      expect(list.value.map((m: { body: string }) => m.body)).toEqual(["hi"]);
      expect(count).toMatchObject({ ok: true, value: 1 });
      // The request's identity, the one `POST /api/query` gives.
      expect(who).toMatchObject({ ok: true, value: "amy" });
      const single = await api("query", { fn: "auth:whoami", args: {}, shard }, "good:amy");
      expect(who.ik).toBe(single.body.ik);
      // Errors are per query, and never carry metrics.
      expect(missing.ok).toBe(false);
      expect(internal).toMatchObject({ ok: false });
      expect(internal.error.code).toBe((await api("query", { fn: "messages:secret", args: {}, shard })).body.error.code);
      expect(badArgs.ok).toBe(false);
      for (const x of r.body.results) expect(x.metrics).toBeUndefined();
    } finally {
      setEmberConfig(original);
    }
  });

  it("verifies the token once like POST /api/query: an invalid one is a 401 and nothing runs; anonymous runs anonymous", async () => {
    const shard = "qbatch:auth";
    try {
      const { rpcs, post } = countingWorker();
      const bad = await post("/api/query/batch", { shard, queries: [{ fn: "auth:whoami", args: {} }] }, "bad:x");
      expect(bad.status).toBe(401);
      expect(rpcs).toEqual([]);
      const anon = await post("/api/query/batch", { shard, queries: [{ fn: "auth:whoami", args: {} }, { fn: "typed:me", args: {} }] });
      expect(anon.body.results[0]).toMatchObject({ ok: true, value: null });
      expect(anon.body.results[1].ok).toBe(false);
    } finally {
      setEmberConfig(original);
    }
  });

  it("refuses a revoked identity per query, as POST /api/query does", async () => {
    const shard = "qbatch:revoked";
    const token = "sess:rita:s1:1";
    expect((await api("query", { fn: "auth:whoami", args: {}, shard }, token)).body).toMatchObject({ ok: true, value: "rita" });
    await (shardStub(shard) as unknown as { revokeSockets(s: string, m: unknown): Promise<unknown> }).revokeSockets(shard, { claim: "sid", value: "s1" });
    try {
      const { post } = countingWorker();
      const r = await post("/api/query/batch", { shard, queries: [{ fn: "auth:whoami", args: {} }, { fn: "messages:list", args: { channel: "a" } }] }, token);
      const single = await api("query", { fn: "auth:whoami", args: {}, shard }, token);
      expect(single.body.ok).toBe(false);
      for (const x of r.body.results) expect(x).toEqual({ ok: false, error: single.body.error });
    } finally {
      setEmberConfig(original);
    }
  });

  it("runs each query's authorize for the caller: a member and a non-member get their own answers", async () => {
    const shard = "qbatch:gated";
    await api("mutation", { fn: "shared:join", args: { room: "r", user: "amy" }, shard });
    await api("mutation", { fn: "shared:put", args: { room: "r", body: "note" }, shard });
    try {
      const { post } = countingWorker();
      const q = { shard, queries: [{ fn: "shared:gated", args: { room: "r" }, warm: true }, { fn: "shared:list", args: { room: "r" } }] };
      const amy = await post("/api/query/batch", q, "good:amy");
      const bob = await post("/api/query/batch", q, "good:bob");
      expect(amy.body.results[0]).toMatchObject({ ok: true });
      expect(amy.body.results[0].value.map((n: { body: string }) => n.body)).toEqual(["note"]);
      expect(bob.body.results[0]).toMatchObject({ ok: false, error: { code: "NotMember" } });
      expect(bob.body.results[1]).toMatchObject({ ok: true });
    } finally {
      setEmberConfig(original);
    }
  });

  it("bounds the batch and refuses malformed bodies", async () => {
    try {
      const { rpcs, post } = countingWorker();
      const many = Array.from({ length: 33 }, () => ({ fn: "messages:list", args: { channel: "a" } }));
      expect((await post("/api/query/batch", { shard: "qbatch:b", queries: many })).status).toBe(413);
      expect((await post("/api/query/batch", "x".repeat(1024 * 1024 + 1))).status).toBe(413);
      expect((await post("/api/query/batch", { shard: "qbatch:b", queries: [] })).status).toBe(400);
      expect((await post("/api/query/batch", { shard: "nope", queries: [{ fn: "a:b" }] })).status).toBe(400);
      expect((await post("/api/query/batch", { shard: "qbatch:b", queries: [{ fn: "a:b", args: [] }] })).status).toBe(400);
      expect((await post("/api/query/batch", { shard: "qbatch:b", queries: [{ args: {} }] })).status).toBe(400);
      expect(rpcs).toEqual([]);
    } finally {
      setEmberConfig(original);
    }
  });

  it("limits the body's bytes while reading when there is no content-length (streamed, multibyte)", async () => {
    const worker = createEmberWorker(config);
    try {
      const enc = new TextEncoder();
      /** A body with no `content-length`, pulled chunk by chunk; `pulled` counts what the Worker read of it. */
      const streamed = (chunks: Iterable<Uint8Array>) => {
        const it = chunks[Symbol.iterator]();
        const stats = { pulled: 0, cancelled: false };
        const body = new ReadableStream<Uint8Array>({
          pull(c) {
            const n = it.next();
            if (n.done) return c.close();
            stats.pulled += n.value.byteLength;
            c.enqueue(n.value);
          },
          cancel() {
            stats.cancelled = true;
          },
        }, { highWaterMark: 0 });
        return { body, stats };
      };
      const send = async (body: ReadableStream<Uint8Array>) => {
        const req = new Request("http://ember/api/query/batch", { method: "POST", headers: { "content-type": "application/json" }, body });
        expect(req.headers.get("content-length")).toBeNull();
        const res = await worker.fetch(req, env as never, createExecutionContext());
        return { status: res.status, body: (await res.json()) as any };
      };
      const LIMIT = 1024 * 1024;
      const CHUNK = 64 * 1024;
      // An endless body: refused once it passes the limit, never read to the end.
      function* endless() {
        for (;;) yield new Uint8Array(CHUNK).fill(0x20);
      }
      const big = streamed(endless());
      const r1 = await send(big.body);
      expect(r1.status).toBe(413);
      expect(r1.body.error.code).toBe("too_large");
      expect(big.stats.pulled).toBeLessThanOrEqual(LIMIT + 2 * CHUNK);
      expect(big.stats.cancelled).toBe(true);
      // 600 000 "é" are 1.2 MB of UTF-8 but 600 000 UTF-16 units: bytes are what counts.
      const multibyte = enc.encode(JSON.stringify({ shard: "qbatch:bytes", queries: [{ fn: "messages:list", args: { channel: "é".repeat(600_000) } }] }));
      expect(multibyte.byteLength).toBeGreaterThan(LIMIT);
      const split = (b: Uint8Array) => Array.from({ length: Math.ceil(b.byteLength / CHUNK) }, (_, i) => b.subarray(i * CHUNK, (i + 1) * CHUNK));
      const r2 = await send(streamed(split(multibyte)).body);
      expect(r2.status).toBe(413);
      // Under the limit (multibyte, streamed): answered as usual.
      const small = enc.encode(JSON.stringify({ shard: "qbatch:bytes", queries: [{ fn: "messages:list", args: { channel: "é".repeat(1000) } }] }));
      const r3 = await send(streamed(split(small)).body);
      expect(r3.status).toBe(200);
      expect(r3.body.results).toEqual([expect.objectContaining({ ok: true, value: [] })]);
    } finally {
      setEmberConfig(original);
    }
  });

  it("answers resume per query (unchanged without a value)", async () => {
    const shard = "qbatch:resume";
    const first = await api("query", { fn: "messages:list", args: { channel: "a" }, shard }, "good:amy");
    try {
      const { post } = countingWorker();
      const { version, epoch, ik } = first.body;
      const r = await post("/api/query/batch", { shard, queries: [{ fn: "messages:list", args: { channel: "a" }, resume: { version, epoch, ik } }, { fn: "messages:list", args: { channel: "a" }, resume: { version, epoch, ik: "other" } }] }, "good:amy");
      expect(r.body.results[0]).toEqual({ ok: true, unchanged: true, version, epoch, ik });
      expect(r.body.results[1]).toMatchObject({ ok: true, value: [] });
    } finally {
      setEmberConfig(original);
    }
  });

  it("advertises feature qbatch in ready when the hello asks for it", async () => {
    const c = await connect("qbatch:ready");
    expect((await hello(c, "c", undefined, ["batch", "qbatch"])).features).toEqual(["batch", "qbatch"]);
    c.close();
  });
});

describe("an HTTP query with warm, then the sub", () => {
  const inspect = (shard: string) => (shardStub(shard) as unknown as Shard).inspect();

  it("hands the HTTP run to the sub of the same identity: SQLite runs once, the sub resumes unchanged", async () => {
    // The same sequence with and without `warm`: only the sub's run of the query differs.
    const session = async (shard: string, warm: boolean) => {
      for (let i = 0; i < 20; i++) await api("mutation", { fn: "messages:send", args: { channel: "p", body: `m${i}` }, shard });
      const r = await api("query", { fn: "messages:list", args: { channel: "p" }, shard, ...(warm ? { warm: true } : {}) }, "good:amy");
      const c = await connect(shard);
      await hello(c, "c1", "good:amy", ["ident"]);
      const before = await inspect(shard);
      c.send({ t: "sub", qid: "q", fn: "messages:list", args: { channel: "p" }, resume: { version: r.body.version, epoch: r.body.epoch, ik: r.body.ik } });
      expect(await c.waitFor<Snap>(is("snap"))).toMatchObject({ unchanged: true });
      const after = await inspect(shard);
      return { c, hits: after.stats.prefetchHits - before.stats.prefetchHits, read: after.rows.read - before.rows.read };
    };
    const cold = await session("qbatch:prefetch-cold", false);
    const warm = await session("qbatch:prefetch", true);
    expect(cold.hits).toBe(0);
    expect(warm.hits).toBe(1);
    // The sub did not read the 20 messages again: the value came from the HTTP query.
    expect(cold.read - warm.read).toBeGreaterThanOrEqual(20);
    // And it is a live subscription: the next commit patches it.
    await api("mutation", { fn: "messages:send", args: { channel: "p", body: "two" }, shard: "qbatch:prefetch" });
    await warm.c.waitFor(is("patch"));
    cold.c.close();
    warm.c.close();
  });

  it("never hands one identity's run to another, and drops a run a commit made stale", async () => {
    const shard = "qbatch:prefetch-id";
    await api("query", { fn: "auth:whoami", args: {}, shard, warm: true }, "good:amy");
    const before = await inspect(shard);
    const c = await connect(shard);
    await hello(c, "c2", "good:bob", ["ident"]);
    c.send({ t: "sub", qid: "w", fn: "auth:whoami", args: {} });
    expect(await c.waitFor<Snap>(is("snap"))).toMatchObject({ value: "bob" });
    expect((await inspect(shard)).stats.prefetchHits).toBe(before.stats.prefetchHits);

    await api("query", { fn: "messages:list", args: { channel: "s" }, shard, warm: true }, "good:bob");
    await api("mutation", { fn: "messages:send", args: { channel: "s", body: "new" }, shard });
    c.send({ t: "sub", qid: "l", fn: "messages:list", args: { channel: "s" } });
    const snap = await c.waitFor<Snap>(is("snap", (m) => m.qid === "l"));
    expect((snap.value as Array<{ body: string }>).map((m) => m.body)).toEqual(["new"]);
    expect((await inspect(shard)).stats.prefetchHits).toBe(before.stats.prefetchHits);
    c.close();
  });

  it("a commit that does not touch the run keeps it current; without warm nothing is kept", async () => {
    const shard = "qbatch:prefetch-other";
    await api("mutation", { fn: "messages:send", args: { channel: "x", body: "kept" }, shard });
    await api("query", { fn: "messages:list", args: { channel: "x" }, shard, warm: true }, "good:amy");
    await api("query", { fn: "messages:list", args: { channel: "y" }, shard }, "good:amy");
    await api("mutation", { fn: "messages:send", args: { channel: "z", body: "elsewhere" }, shard });
    const before = await inspect(shard);
    const c = await connect(shard);
    await hello(c, "c3", "good:amy", ["ident"]);
    c.send({ t: "sub", qid: "x", fn: "messages:list", args: { channel: "x" } });
    const snap = await c.waitFor<Snap>(is("snap", (m) => m.qid === "x"));
    expect((snap.value as Array<{ body: string }>).map((m) => m.body)).toEqual(["kept"]);
    expect((await inspect(shard)).stats.prefetchHits - before.stats.prefetchHits).toBe(1);
    c.send({ t: "sub", qid: "y", fn: "messages:list", args: { channel: "y" } });
    await c.waitFor(is("snap", (m) => m.qid === "y"));
    expect((await inspect(shard)).stats.prefetchHits - before.stats.prefetchHits).toBe(1);
    c.close();
  });
});
