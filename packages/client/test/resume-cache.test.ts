// Resuming from a value the client already holds (contracts.md "Retomar do que o cliente tem"): the light snapshot
// cache, a server-rendered value (`fetchForHydration` → `hydrate`), and their safety: a value stored under one
// identity is never shown or resumed under another, nor with an expired or revoked token, nor after a restore (epoch).
import { describe, expect, it } from "vitest";
import { keyValueSnapshotCache, unsafeRef, type QuerySnapshot } from "../src/index.ts";
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
  return messagesServer({ ident: true, verify, queries: { "users:feed": (db, _a, ctx) => db.where<{ body: string }>("messages", "channel", ctx.identity?.subject ?? "anon").map((m) => m.body) } });
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

  it("with httpFirst the cached value is confirmed over HTTP (unchanged, no value), then by the socket", async () => {
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
    expect(s.httpRequests.map((r) => (r.body as { resume?: unknown }).resume)).toEqual([expect.objectContaining({ ik: expect.any(String) })]);
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
