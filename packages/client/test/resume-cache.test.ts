// Resuming from a value the client already holds (contracts.md "Retomar do que o cliente tem"): the light snapshot
// cache, a server-rendered value (`fetchForHydration` → `hydrate`), and their safety: a value stored under one
// identity is never shown or resumed under another, nor with an expired or revoked token, nor after a restore (epoch).
import { describe, expect, it } from "vitest";
import { keyValueSnapshotCache, MemoryPendingStorage, unsafeRef, type LocalQueryResult, type QuerySnapshot, type QueryUpdate, type StorageAdapter } from "../src/index.ts";
import type { FakeIdentity, FakeSocket } from "../src/testing.ts";
import { makeClient, messagesServer, SHARD, tick, until } from "./helpers.ts";

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
/** A JWT-shaped token (the client reads `sub`, `iss`, `exp`; this fake server trusts it). */
const jwt = (sub: string, expSec = Math.floor(Date.now() / 1000) + 3600) => `${b64({ alg: "none" })}.${b64({ sub, iss: "test", exp: expSec })}.sig`;
const verify = (t: string): FakeIdentity | null => {
  try {
    const p = JSON.parse(Buffer.from(t.split(".")[1]!, "base64url").toString()) as { sub: string; exp: number };
    return { subject: p.sub, exp: p.exp };
  } catch {
    return null;
  }
};

function kv() {
  const m = new Map<string, string>();
  return { m, store: { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) } };
}

const list = unsafeRef<"query">("messages:list");
const failing = unsafeRef<"query">("boom:query");

function server() {
  return messagesServer({
    ident: true,
    verify,
    queries: { "users:feed": (db, _a, ctx) => db.where<{ body: string }>("messages", "channel", ctx.identity?.subject ?? "anon").map((m) => m.body), "stats:ratio": () => NaN },
  });
}

/** A session: a client over the store, subscribed to `ref`, with every snapshot it showed. */
async function session(s: ReturnType<typeof server>, store: ReturnType<typeof kv>["store"], opts: { token?: string; ref?: ReturnType<typeof unsafeRef<"query">>; args?: Record<string, unknown> } = {}) {
  const client = makeClient(s, { snapshotCache: keyValueSnapshotCache(store), ...(opts.token ? { auth: () => opts.token! } : {}) });
  const seen: QuerySnapshot[] = [];
  const off = client.subscribe(opts.ref ?? list, opts.args ?? { channel: "c" }, {}, (x) => seen.push(x));
  const socket = () => s.open(SHARD).at(-1) as FakeSocket | undefined;
  return { client, seen, off, socket, confirmed: () => seen.find((x) => x.status === "success" && !x.source) };
}

const fullSnaps = (ws: FakeSocket | undefined) => ws?.received.filter((m) => m !== "pong" && m.t === "snap" && !(m as { unchanged?: boolean }).unchanged).length ?? 0;
const unchanged = (ws: FakeSocket | undefined) => ws?.received.filter((m) => m !== "pong" && m.t === "snap" && (m as { unchanged?: boolean }).unchanged).length ?? 0;

describe("snapshot cache", () => {
  it("a repeat visit paints from the cache, then resumes: unchanged, nothing downloaded", async () => {
    const s = server();
    s.mutateDirect(SHARD, "messages:send", { channel: "c", body: "hello" });
    const { store, m } = kv();
    const a = await session(s, store);
    await until(() => a.confirmed());
    a.client.close();
    expect(m.size).toBe(1);
    const b = await session(s, store);
    // Shown before any frame from the server.
    expect(b.seen[0]).toMatchObject({ status: "success", value: ["hello"], source: "cache" });
    await until(() => b.confirmed());
    const sub = b.socket()!.sent.find((x) => x !== "ping" && x.t === "sub") as { resume?: unknown };
    expect(sub.resume).toMatchObject({ epoch: expect.any(String), ik: expect.any(String) });
    expect(unchanged(b.socket())).toBe(1);
    expect(fullSnaps(b.socket())).toBe(0);
    expect(b.confirmed()!.value).toEqual(["hello"]);
    // Live from there.
    s.mutateDirect(SHARD, "messages:send", { channel: "c", body: "again" });
    await until(() => (b.seen.at(-1)!.value as string[]).length === 2);
    b.client.close();
  });

  it("with httpFirst a cached value skips HTTP: the socket's resume confirms it (unchanged, no value)", async () => {
    const s = server();
    s.mutateDirect(SHARD, "messages:send", { channel: "c", body: "hello" });
    const { store } = kv();
    const first = makeClient(s, { snapshotCache: keyValueSnapshotCache(store), httpFirst: true });
    const seen1: QuerySnapshot[] = [];
    first.subscribe(list, { channel: "c" }, {}, (x) => seen1.push(x));
    await until(() => seen1.some((x) => x.status === "success" && !x.source));
    await tick(5);
    first.close();
    s.httpRequests.length = 0;
    const again = makeClient(s, { snapshotCache: keyValueSnapshotCache(store), httpFirst: true });
    const seen: QuerySnapshot[] = [];
    again.subscribe(list, { channel: "c" }, {}, (x) => seen.push(x));
    await until(() => seen.some((x) => x.status === "success" && !x.source));
    // Painted from the cache already: no HTTP round trip on top of the socket's `sub` with `resume`.
    expect(seen[0]).toMatchObject({ status: "success", source: "cache" });
    expect(s.httpRequests).toEqual([]);
    await until(() => unchanged(s.open(SHARD).at(-1)) === 1);
    expect(fullSnaps(s.open(SHARD).at(-1))).toBe(0);
    expect(seen.at(-1)!.value).toEqual(["hello"]);
    again.close();
  });

  it("changed since: the full value replaces the cached one; a restore (new epoch) never resumes", async () => {
    const s = server();
    const { store } = kv();
    const a = await session(s, store);
    await until(() => a.confirmed());
    a.client.close();
    s.mutateDirect(SHARD, "messages:send", { channel: "c", body: "while away" });
    const b = await session(s, store);
    await until(() => b.confirmed());
    expect(b.confirmed()!.value).toEqual(["while away"]);
    expect(fullSnaps(b.socket())).toBe(1);
    b.client.close();
    s.resetEpoch(SHARD);
    const c = await session(s, store);
    await until(() => c.confirmed());
    expect(unchanged(c.socket())).toBe(0);
    expect(c.confirmed()!.value).toEqual(["while away"]);
    c.client.close();
  });

  it("account switch: what one identity cached is never shown to (or resumed by) another", async () => {
    const s = server();
    s.mutateDirect(SHARD, "messages:send", { channel: "alice", body: "alice's secret" });
    const { store } = kv();
    const feed = unsafeRef<"query">("users:feed");
    const a = await session(s, store, { token: jwt("alice"), ref: feed, args: {} });
    await until(() => a.confirmed());
    a.client.close();
    const b = await session(s, store, { token: jwt("bob"), ref: feed, args: {} });
    await until(() => b.confirmed());
    for (const x of b.seen) expect(x.value ?? []).not.toContain("alice's secret");
    expect(b.confirmed()!.value).toEqual([]);
    const sub = b.socket()!.sent.find((x) => x !== "ping" && x.t === "sub") as { resume?: unknown };
    expect(sub.resume).toBeUndefined();
    b.client.close();
    // Alice again: her own value, from the cache.
    const c = await session(s, store, { token: jwt("alice"), ref: feed, args: {} });
    await until(() => c.seen.length > 0);
    expect(c.seen[0]).toMatchObject({ value: ["alice's secret"], source: "cache" });
    c.client.close();
  });

  it("an expired token shows nothing cached; a refused subscription drops the cached value and its entry", async () => {
    const s = server();
    s.mutateDirect(SHARD, "messages:send", { channel: "c", body: "x" });
    const { store, m } = kv();
    const a = await session(s, store, { token: jwt("alice") });
    await until(() => a.confirmed());
    a.client.close();
    const expired = await session(s, store, { token: jwt("alice", Math.floor(Date.now() / 1000) - 10) });
    await tick(20);
    expect(expired.seen.some((x) => x.source === "cache")).toBe(false);
    expired.client.close();
    // Revoked on the server (the shard refuses the token): the cached value goes away, and so does the entry.
    const revoked = messagesServer({ ident: true, verify: (t) => ({ ...verify(t)!, exp: 1 }) });
    revoked.mutateDirect(SHARD, "messages:send", { channel: "c", body: "x" });
    const r = await session(revoked, store, { token: jwt("alice") });
    await until(() => r.confirmed());
    expect(r.seen.at(-1)!.source).toBeUndefined();
    const keys = () => Object.keys((JSON.parse(m.get("ember:snapshots") ?? '{"by":{}}') as { by: Record<string, unknown> }).by);
    await until(() => !keys().some((k) => k.includes("alice")));
    r.client.close();
    expect(keys().some((k) => k.includes("alice"))).toBe(false);
  });

  it("sign-out clears the cache; errors are never cached; the size limit evicts the oldest", async () => {
    const s = server();
    s.mutateDirect(SHARD, "messages:send", { channel: "c", body: "x" });
    const { store, m } = kv();
    const a = await session(s, store, { token: jwt("alice") });
    await until(() => a.confirmed());
    const errs: QuerySnapshot[] = [];
    a.client.subscribe(failing, {}, {}, (x) => errs.push(x));
    await until(() => errs.some((x) => x.status === "error"));
    a.client.close();
    const stored = JSON.parse(m.get("ember:snapshots")!) as { by: Record<string, Record<string, unknown>> };
    expect(Object.values(stored.by).flatMap((x) => Object.keys(x))).toHaveLength(1); // the list, not the error
    const b = await session(s, store, { token: jwt("alice") });
    await until(() => b.confirmed());
    b.client.clearAuth();
    expect(JSON.parse(m.get("ember:snapshots")!).by).toEqual({});
    b.client.close();

    const small = kv();
    const cache = keyValueSnapshotCache(small.store, { maxBytes: 30 });
    const c = makeClient(s, { snapshotCache: cache });
    const got: string[] = [];
    for (const ch of ["c1", "c2", "c3"]) {
      s.mutateDirect(SHARD, "messages:send", { channel: ch, body: `${ch}-long-enough` });
      c.subscribe(list, { channel: ch }, {}, (x) => x.status === "success" && !x.source && got.push(ch));
      await until(() => got.includes(ch));
      await tick(300);
    }
    c.close();
    const kept = Object.values((JSON.parse(small.m.get("ember:snapshots")!) as { by: Record<string, Record<string, unknown>> }).by).flatMap((x) => Object.keys(x));
    expect(kept).toHaveLength(1);
    expect(kept[0]).toContain("c3");
  });

  it("a cached NaN resumes like any value: one `unchanged`, no resubscribe loop", async () => {
    const s = server();
    const { store } = kv();
    const ratio = unsafeRef<"query">("stats:ratio");
    const a = await session(s, store, { ref: ratio, args: {} });
    await until(() => a.confirmed());
    a.client.close();
    const b = await session(s, store, { ref: ratio, args: {} });
    expect(b.seen[0]).toMatchObject({ status: "success", source: "cache" });
    expect(Number.isNaN(b.seen[0]!.value)).toBe(true);
    await until(() => b.confirmed());
    await tick(20);
    expect(unchanged(b.socket())).toBe(1);
    expect(b.socket()!.sent.filter((x) => x !== "ping" && x.t === "sub")).toHaveLength(1);
    expect(Number.isNaN(b.confirmed()!.value)).toBe(true);
    b.client.close();
  });
});

describe("hydrate (SSR)", () => {
  it("a value fetched on the server is shown at once and resumed: no second download", async () => {
    const s = server();
    s.mutateDirect(SHARD, "messages:send", { channel: "c", body: "rendered" });
    const ssr = makeClient(s);
    const h = await ssr.fetchForHydration(list, { channel: "c" });
    expect(h).toMatchObject({ fn: "messages:list", shard: SHARD, value: ["rendered"], version: expect.any(Number), epoch: expect.any(String), ik: expect.any(String) });
    ssr.close();
    const browser = makeClient(s);
    browser.hydrate(h);
    const seen: QuerySnapshot[] = [];
    browser.subscribe(list, { channel: "c" }, {}, (x) => seen.push(x));
    expect(seen[0]).toMatchObject({ status: "success", value: ["rendered"] });
    await until(() => unchanged(s.open(SHARD).at(-1)) === 1);
    expect(fullSnaps(s.open(SHARD).at(-1))).toBe(0);
    s.mutateDirect(SHARD, "messages:send", { channel: "c", body: "live" });
    await until(() => (seen.at(-1)!.value as string[]).length === 2);
    browser.close();
  });

  it("hydrated for another identity: the shard sends the full value; sign-in drops pending hydrations", async () => {
    const s = server();
    const feed = unsafeRef<"query">("users:feed");
    s.mutateDirect(SHARD, "messages:send", { channel: "alice", body: "alice" });
    const ssr = makeClient(s, { auth: () => jwt("alice") });
    const h = await ssr.fetchForHydration(feed, {});
    ssr.close();
    const browser = makeClient(s, { auth: () => jwt("bob") });
    browser.hydrate(h);
    const seen: QuerySnapshot[] = [];
    browser.subscribe(feed, {}, {}, (x) => seen.push(x));
    await until(() => seen.at(-1)!.value !== undefined && (seen.at(-1)!.value as string[]).length === 0);
    expect(unchanged(s.open(SHARD).at(-1))).toBe(0);
    browser.hydrate(h);
    browser.setAuth(() => jwt("carol"));
    const later: QuerySnapshot[] = [];
    browser.subscribe(feed, { other: 1 } as never, {}, (x) => later.push(x));
    expect(later.length).toBe(0);
    browser.close();
  });
});

describe("resume races", () => {
  /** Every socket the server opens from now on holds its frames to the client until `release()`. */
  const holdingNext = (s: ReturnType<typeof server>) => {
    const attach = s.attach.bind(s);
    s.attach = (ws: FakeSocket) => {
      ws.hold();
      attach(ws);
    };
    return () => (s.attach = attach);
  };

  it("`unchanged` confirms the value the `sub` offered, not one hydrated while it was on its way", async () => {
    const s = server();
    s.mutateDirect(SHARD, "messages:send", { channel: "c", body: "hello" });
    const { store } = kv();
    const a = await session(s, store);
    await until(() => a.confirmed());
    a.client.close();
    const ssr = makeClient(s);
    const h = await ssr.fetchForHydration(list, { channel: "c" });
    ssr.close();
    const stop = holdingNext(s);
    const b = await session(s, store);
    await until(() => s.open(SHARD).at(-1)?.held?.length);
    stop();
    // A value handed over meanwhile (an older SSR render, say): shown, but not what the shard is checking.
    b.client.hydrate({ ...h, value: ["stale render"] });
    expect(b.seen.at(-1)).toMatchObject({ value: ["stale render"] });
    s.open(SHARD).at(-1)!.release();
    await until(() => b.seen.at(-1)!.value !== undefined && (b.seen.at(-1)!.value as string[])[0] === "hello" && !b.seen.at(-1)!.source);
    expect(unchanged(b.socket())).toBe(1);
    b.client.close();
  });

  it("a patch for other queries before a resubscribed query's answer moves neither its version nor the stored one", async () => {
    const s = server();
    s.mutateDirect(SHARD, "messages:send", { channel: "c", body: "hello" });
    const { m, store } = kv();
    const client = makeClient(s, { snapshotCache: keyValueSnapshotCache(store) });
    const c: QuerySnapshot[] = [];
    const d: QuerySnapshot[] = [];
    client.subscribe(list, { channel: "c" }, {}, (x) => c.push(x));
    client.subscribe(list, { channel: "d" }, {}, (x) => d.push(x));
    await until(() => c.some((x) => x.status === "success" && !x.source) && d.some((x) => x.status === "success" && !x.source));
    await tick(300);
    const versionOf = (channel: string) =>
      Object.values((JSON.parse(m.get("ember:snapshots")!) as { by: Record<string, Record<string, { version: number }>> }).by)
        .flatMap((x) => Object.entries(x))
        .find(([k]) => k.includes(`"${channel}"`))![1].version;
    const before = versionOf("c");
    const first = s.open(SHARD).at(-1)!;
    const qidOf = (ch: string) => (first.sent.find((x) => x !== "ping" && x.t === "sub" && (x.args as { channel?: string }).channel === ch) as { qid: string }).qid;
    // Channel c changes while the socket is down: its resubscription will bring that change.
    const stop = holdingNext(s);
    first.drop();
    s.mutateDirect(SHARD, "messages:send", { channel: "c", body: "while away" });
    await until(() => s.open(SHARD).at(-1) !== first && s.open(SHARD).at(-1)?.held?.length);
    stop();
    const second = s.open(SHARD).at(-1)!;
    // Before the answers: a patch for d only, at a version past c's change.
    second.onmessage?.({ data: JSON.stringify({ t: "patch", version: s.version(SHARD) + 5, changes: [{ qid: qidOf("d"), value: ["d"] }] }) });
    await tick(300);
    expect(versionOf("c")).toBe(before);
    // In memory too: the next socket resumes c from the version it had, not the patch's.
    second.drop();
    await until(() => s.open(SHARD).at(-1) !== second && s.open(SHARD).at(-1)!.sent.some((x) => x !== "ping" && x.t === "sub"));
    const third = s.open(SHARD).at(-1)!;
    const resumeOf = (ch: string) => (third.sent.find((x) => x !== "ping" && x.t === "sub" && (x.args as { channel?: string }).channel === ch) as { resume?: { version: number } }).resume;
    expect(resumeOf("c")?.version).toBe(before);
    await until(() => (c.at(-1)!.value as string[]).length === 2);
    client.close();
  });

  it("an `unchanged` the shard sent for the identity before an account switch is not taken as the new one's", async () => {
    const s = server();
    s.mutateDirect(SHARD, "messages:send", { channel: "ana", body: "ana's" });
    s.mutateDirect(SHARD, "messages:send", { channel: "bob", body: "bob's" });
    const feed = unsafeRef<"query">("users:feed");
    let token = jwt("ana");
    const ssr = makeClient(s, { auth: () => token });
    const h = await ssr.fetchForHydration(feed, {});
    ssr.close();
    // An offline adapter has ana's value (with what `resume` needs) and withdraws it while the `sub` is out.
    let push: (r: LocalQueryResult | undefined) => void = () => {};
    const stored: QueryUpdate[] = [];
    const adapter: StorageAdapter = {
      load: async () => ({ identity: { subject: "ana", issuer: "test" } }),
      persistPending: new MemoryPendingStorage(),
      applyPatch: (u) => void stored.push(u),
      runQueryLocally: () => undefined,
      watchQueryLocally: (_req, onResult) => {
        push = onResult;
        onResult({ value: h.value, source: "cache", version: h.version, epoch: h.epoch, ik: h.ik });
        return () => {};
      },
    };
    const stop = holdingNext(s);
    const client = makeClient(s, { storage: adapter, auth: () => token });
    const seen: QuerySnapshot[] = [];
    client.subscribe(feed, {}, {}, (x) => seen.push(x));
    await until(() => s.open(SHARD).at(-1));
    stop();
    const ws = s.open(SHARD).at(-1)!;
    // Every frame but the subscription's answer reaches the client (`ready`): that answer, ana's `unchanged`, waits.
    const kept: Array<{ t: string; unchanged?: boolean }> = [];
    const pump = () => {
      const frames = (ws.held ?? []).flatMap((f) => [JSON.parse(f) as unknown].flat() as Array<{ t: string }>);
      ws.held = [];
      for (const f of frames) if (f.t === "snap") kept.push(f);
      else ws.onmessage?.({ data: JSON.stringify(f) });
    };
    await until(() => (pump(), kept.length > 0));
    expect(kept[0]).toMatchObject({ unchanged: true });
    push(undefined);
    token = jwt("bob");
    client.setAuth(() => token);
    await until(() => ws.sent.some((x) => x !== "ping" && x.t === "auth"));
    // Ana's answer arrives after the `auth` frame: it says nothing about bob.
    ws.onmessage?.({ data: JSON.stringify(kept[0]) });
    await tick();
    ws.release();
    await until(() => seen.some((x) => x.status === "success" && !x.source && (x.value as string[])[0] === "bob's"));
    expect(seen.filter((x) => x.status === "success" && !x.source).map((x) => x.value)).toEqual([["bob's"]]);
    expect(stored.some((u) => (u.value as string[])[0] === "ana's")).toBe(false);
    client.close();
  });
});
