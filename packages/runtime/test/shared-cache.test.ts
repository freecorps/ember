// Query results shared between identities (PLAN §4, docs/design/dx.md §3.13): a run that never read the identity is
// computed once for every subscriber; `authorize` splits a per-identity check from a shared handler. A shared result
// must never reach an identity that a per-identity run would answer differently, so every test also compares what
// each socket holds with a fresh per-identity run of the engine (full mode: `authorize` included).
import { runInDurableObject } from "cloudflare:test";
import { createEngine } from "@freecorps/ember-server";
import { applyRowDiff, type RowDiff } from "@freecorps/ember-values";
import { describe, expect, it } from "vitest";
import { DoSqlDriver } from "../src/sql-driver.ts";
import type { ServerMessage } from "../src/protocol.ts";
import { getEmberConfig } from "../src/config.ts";
import { connect, hello, shardStub, sleep, type Client } from "./helpers.ts";

type Held = { value: unknown } | { error: string };

/** A socket that keeps the value (or error) of each of its subscriptions, as a client would. */
async function socket(shard: string, token?: string) {
  const c = await connect(shard);
  await hello(c, crypto.randomUUID(), token, ["rowdiff", "ident", "query", "batch"]);
  const held = new Map<string, Held>();
  const subs = new Map<string, { fn: string; args: Record<string, unknown> }>();
  let barrier = 0;
  const apply = (m: ServerMessage) => {
    if (m.t === "snap" && !("unchanged" in m && m.unchanged)) held.set(String(m.qid), { value: (m as { value: unknown }).value });
    else if (m.t === "patch") {
      for (const ch of m.changes) {
        const k = String(ch.qid);
        const cur = held.get(k);
        if (ch.diff) held.set(k, { value: applyRowDiff(cur && "value" in cur ? cur.value : undefined, ch.diff as RowDiff) });
        else held.set(k, { value: ch.value });
      }
    } else if (m.t === "err" && m.qid !== undefined) held.set(String(m.qid), { error: m.code });
  };
  c.ws.addEventListener("message", (e) => {
    const text = String(e.data);
    if (text === "pong") return;
    const list = (text.startsWith("[") ? JSON.parse(text) : [JSON.parse(text)]) as ServerMessage[];
    for (const m of list) apply(m);
  });
  return {
    c,
    token,
    held,
    subs,
    sub(qid: string, fn: string, args: Record<string, unknown>) {
      subs.set(qid, { fn, args });
      c.send({ t: "sub", qid, fn, args });
    },
    unsub(qid: string) {
      subs.delete(qid);
      held.delete(qid);
      c.send({ t: "unsub", qid });
    },
    /** Everything the shard sent before this point has arrived (frames are ordered per socket). */
    async settle() {
      const qid = `barrier${++barrier}`;
      c.send({ t: "q", qid, fn: "shared:failing", args: { room: "__none__" } });
      await c.waitFor((m) => m.t === "qres" && m.qid === qid, 5000);
    },
  };
}
type Sock = Awaited<ReturnType<typeof socket>>;

async function mutate(c: Client, fn: string, args: Record<string, unknown>): Promise<{ value: unknown; version: number }> {
  const mid = crypto.randomUUID();
  c.send({ t: "mut", mid, fn, args });
  const r = await c.waitFor<Extract<ServerMessage, { t: "mres" }>>((m) => m.t === "mres" && m.mid === mid, 5000);
  if (!r.ok) throw new Error(`${fn}: ${r.error.code} ${r.error.message}`);
  return { value: r.value, version: r.version };
}

const subjectOf = (token: string | undefined) => (token ? token.split(":")[1]! : null);

/** What a per-identity run answers now (a separate engine over the same storage, `authorize` included). */
async function truth(shard: string, token: string | undefined, fn: string, args: Record<string, unknown>): Promise<Held> {
  return runInDurableObject(shardStub(shard), (_i, state) => {
    // The deployed app (composed with its components), as the shard runs it.
    const cfg = getEmberConfig();
    const engine = createEngine({ schema: cfg.schema, functions: cfg.functions, driver: new DoSqlDriver(state.storage) });
    const subject = subjectOf(token);
    try {
      return { value: JSON.parse(JSON.stringify(engine.runQuery(fn, args, { identity: subject ? { subject } : null }).value ?? null)) };
    } catch (e) {
      return { error: (e as { code?: string }).code ?? "Error" };
    }
  });
}

async function expectTruth(shard: string, socks: Sock[]) {
  for (const s of socks) await s.settle();
  for (const s of socks) {
    for (const [qid, q] of s.subs) {
      const want = await truth(shard, s.token, q.fn, q.args);
      const got = s.held.get(qid);
      const norm = (h: Held | undefined) => (h && "value" in h ? { value: JSON.parse(JSON.stringify(h.value ?? null)) } : h);
      expect(norm(got), `${subjectOf(s.token) ?? "anon"} ${qid} ${q.fn}`).toEqual(want);
    }
  }
}

const inspect = (shard: string) => shardStub(shard).inspect();

describe("shared query results", () => {
  it("a query that never reads the identity is run once for every signed-in subscriber", async () => {
    const shard = "shared:one";
    const writer = await socket(shard);
    await mutate(writer.c, "shared:put", { room: "r", body: "hi" });
    const users = await Promise.all(["good:a", "good:b", "good:c", undefined].map((t) => socket(shard, t)));
    for (const u of users) u.sub("l", "shared:list", { room: "r" });
    await expectTruth(shard, users);
    const before = await inspect(shard);
    expect(before).toMatchObject({ queries: 1, shared: 1 }); // one-shot queries (the barriers) are not cached
    await mutate(writer.c, "shared:put", { room: "r", body: "second" });
    await expectTruth(shard, users);
    const after = await inspect(shard);
    expect(after.stats.reruns - before.stats.reruns).toBe(1);
    expect(after.stats.identityRuns).toBe(0);
  });

  it("a shared result whose re-run reads the identity goes back to one result per identity (no leak)", async () => {
    const shard = "shared:branch";
    const writer = await socket(shard);
    await mutate(writer.c, "shared:put", { room: "r", body: "public" });
    const [a, b, anon] = await Promise.all([socket(shard, "good:a"), socket(shard, "good:b"), socket(shard)]);
    for (const s of [a, b, anon]) s.sub("q", "shared:branch", { room: "r" });
    await expectTruth(shard, [a, b, anon]);
    expect((await inspect(shard)).shared).toBeGreaterThanOrEqual(1);
    // A private note of a: the shared entry's re-run reads the identity; each one now gets their own answer.
    const { value: id } = await mutate(writer.c, "shared:put", { room: "r", body: "a's secret", private: true, owner: "a" });
    await expectTruth(shard, [a, b, anon]);
    expect(b.held.get("q")).toEqual({ value: [expect.objectContaining({ body: "public" })] });
    expect(JSON.stringify(anon.held.get("q"))).not.toContain("secret");
    const split = await inspect(shard);
    expect(split.stats.splits).toBe(1);
    // New subscribers join the per-identity entries (b's own), never a stale shared one.
    const b2 = await socket(shard, "good:b");
    b2.sub("q", "shared:branch", { room: "r" });
    await expectTruth(shard, [a, b, anon, b2]);
    // Public again: the entries stop reading the identity and become one shared result.
    await mutate(writer.c, "shared:setPrivate", { id, private: false });
    await expectTruth(shard, [a, b, anon, b2]);
    await mutate(writer.c, "shared:put", { room: "r", body: "third" });
    await expectTruth(shard, [a, b, anon, b2]);
    expect((await inspect(shard)).queries).toBeLessThanOrEqual(3);
  });

  it("authorize: members share one result; each one's check is re-run only when its own reads change", async () => {
    const shard = "shared:gate";
    const writer = await socket(shard);
    for (const u of ["a", "b"]) await mutate(writer.c, "shared:join", { room: "r", user: u });
    await mutate(writer.c, "shared:put", { room: "r", body: "for members" });
    const [a, b, c, anon] = await Promise.all([socket(shard, "good:a"), socket(shard, "good:b"), socket(shard, "good:c"), socket(shard)]);
    for (const s of [a, b, c, anon]) s.sub("g", "shared:gated", { room: "r" });
    await expectTruth(shard, [a, b, c, anon]);
    expect(c.held.get("g")).toEqual({ error: "NotMember" });
    expect(anon.held.get("g")).toEqual({ error: "Unauthenticated" });
    const i0 = await inspect(shard);
    expect(i0).toMatchObject({ shared: 1, gates: 4 });
    // A new note: one re-run for everyone, no check re-run; the refused ones get nothing.
    await mutate(writer.c, "shared:put", { room: "r", body: "more" });
    await expectTruth(shard, [a, b, c, anon]);
    const i1 = await inspect(shard);
    expect(i1.stats.reruns - i0.stats.reruns).toBe(1);
    expect(i1.stats.gateRuns - i0.stats.gateRuns).toBe(0);
    // c joins: only c's check is re-run, and c gets the shared value.
    await mutate(writer.c, "shared:join", { room: "r", user: "c" });
    await expectTruth(shard, [a, b, c, anon]);
    const i2 = await inspect(shard);
    expect(i2.stats.gateRuns - i1.stats.gateRuns).toBe(1);
    expect(c.held.get("g")).toEqual({ value: expect.arrayContaining([expect.objectContaining({ body: "more" })]) });
    // a leaves: a gets the error and no later value; the others keep getting updates.
    await mutate(writer.c, "shared:leave", { room: "r", user: "a" });
    await mutate(writer.c, "shared:put", { room: "r", body: "after a left" });
    await expectTruth(shard, [a, b, c, anon]);
    expect(a.held.get("g")).toEqual({ error: "NotMember" });
    // One-shot reads honor the check too, with the shared result cached.
    for (const [s, ok] of [[a, false], [b, true]] as const) {
      s.c.send({ t: "q", qid: "once", fn: "shared:gated", args: { room: "r" } });
      const r = await s.c.waitFor<Extract<ServerMessage, { t: "qres" }>>((m) => m.t === "qres" && m.qid === "once");
      expect(r.ok).toBe(ok);
    }
    const http = await shardStub(shard).query(shard, "shared:gated", { room: "r" }, { subject: "a" });
    expect(http).toMatchObject({ ok: false, error: { code: "NotMember" } });
  });

  it("the same check inside the handler stays per identity (correct, not shared)", async () => {
    const shard = "shared:inline";
    const writer = await socket(shard);
    await mutate(writer.c, "shared:join", { room: "r", user: "a" });
    const [a, b] = await Promise.all([socket(shard, "good:a"), socket(shard, "good:b")]);
    for (const s of [a, b]) s.sub("i", "shared:inline", { room: "r" });
    await mutate(writer.c, "shared:put", { room: "r", body: "x" });
    await expectTruth(shard, [a, b]);
    expect(await inspect(shard)).toMatchObject({ shared: 0 });
    expect(b.held.get("i")).toEqual({ error: "NotMember" });
  });

  it("a socket that changes identity (auth) is checked again; an expired or revoked one gets nothing", async () => {
    const shard = "shared:switch";
    const writer = await socket(shard);
    await mutate(writer.c, "shared:join", { room: "r", user: "a" });
    await mutate(writer.c, "shared:put", { room: "r", body: "members only" });
    const s = await socket(shard, "good:a");
    s.sub("g", "shared:gated", { room: "r" });
    s.sub("l", "shared:list", { room: "r" });
    await expectTruth(shard, [s]);
    expect(s.held.get("g")).toMatchObject({ value: [expect.objectContaining({ body: "members only" })] });
    // Signs in as b (not a member): refused, though the shared result is cached.
    s.c.send({ t: "auth", token: "good:b" });
    s.token = "good:b";
    await expectTruth(shard, [s]);
    expect(s.held.get("g")).toEqual({ error: "NotMember" });
    // Back to a: admitted again.
    s.c.send({ t: "auth", token: "good:a" });
    s.token = "good:a";
    await expectTruth(shard, [s]);
    // A token that expires: no more values once it has (the shared entry keeps running for others).
    const soon = await socket(shard, "soon:a:150");
    soon.sub("g", "shared:gated", { room: "r" });
    await soon.settle();
    await sleep(250);
    await mutate(writer.c, "shared:put", { room: "r", body: "after expiry" });
    await s.settle();
    expect(JSON.stringify(soon.held.get("g"))).not.toContain("after expiry");
    await soon.c.waitFor((m) => m.t === "authExpired");
    // Revoked: same.
    await shardStub(shard).revokeSockets(shard, { subject: "a" });
    await mutate(writer.c, "shared:put", { room: "r", body: "after revoke" });
    await sleep(50);
    expect(JSON.stringify(s.held.get("g"))).not.toContain("after revoke");
    expect(JSON.stringify(s.held.get("l"))).not.toContain("after revoke");
  });

  it("resume after a shared snapshot: unchanged for the same identity, a full snapshot for another", async () => {
    const shard = "shared:resume";
    const writer = await socket(shard);
    await mutate(writer.c, "shared:put", { room: "r", body: "x" });
    const first = await connect(shard);
    const ready = await hello(first, "c1", "good:a", ["ident"]);
    first.send({ t: "sub", qid: 1, fn: "shared:list", args: { room: "r" } });
    const snap = await first.waitFor<Extract<ServerMessage, { t: "snap" }>>((m) => m.t === "snap");
    first.close();
    const resume = { version: snap.version, epoch: ready.epoch, ...("ik" in snap && snap.ik ? { ik: snap.ik } : {}) };
    const same = await connect(shard);
    await hello(same, "c1", "good:a", ["ident"]);
    same.send({ t: "sub", qid: 1, fn: "shared:list", args: { room: "r" }, resume });
    expect(await same.waitFor((m) => m.t === "snap")).toMatchObject({ unchanged: true });
    const other = await connect(shard);
    await hello(other, "c2", "good:b", ["ident"]);
    other.send({ t: "sub", qid: 1, fn: "shared:list", args: { room: "r" }, resume });
    const full = await other.waitFor((m) => m.t === "snap");
    expect(full).not.toHaveProperty("unchanged");
    expect(full).toHaveProperty("value");
  });

  it("a failing query: one error for everyone when it did not read the identity; recovers for all", async () => {
    const shard = "shared:fail";
    const writer = await socket(shard);
    const { value: id } = await mutate(writer.c, "shared:put", { room: "r", body: "boom" });
    const [a, b] = await Promise.all([socket(shard, "good:a"), socket(shard, "good:b")]);
    for (const s of [a, b]) s.sub("f", "shared:failing", { room: "r" });
    await expectTruth(shard, [a, b]);
    expect(a.held.get("f")).toEqual({ error: "Error" });
    expect(await inspect(shard)).toMatchObject({ shared: 1 });
    await mutate(writer.c, "shared:remove", { id });
    await expectTruth(shard, [a, b]);
    expect(b.held.get("f")).toEqual({ value: 0 });
  });

  it.each([42, 7, 1234])("fuzz (seed %i): every socket always holds what a per-identity run answers", async (initial) => {
    const shard = `shared:fuzz${initial}`;
    let seed = initial;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
    const writer = await socket(shard);
    const tokens = ["good:a", "good:b", "good:c", undefined] as const;
    const users = ["a", "b", "c"] as const;
    const rooms = ["r1", "r2"] as const;
    const fns = ["shared:list", "shared:branch", "shared:gated", "shared:inline"] as const;
    const socks = await Promise.all(Array.from({ length: 6 }, (_, i) => socket(shard, tokens[i % tokens.length])));
    const notes: string[] = [];
    let q = 0;
    // Every socket starts on the data-dependent list of a public room: the first private note there splits it.
    for (const r of rooms) notes.push((await mutate(writer.c, "shared:put", { room: r, body: `seed-${r}` })).value as string);
    for (const s of socks) s.sub(`q${++q}`, "shared:branch", { room: "r1" });
    for (let step = 0; step < 80; step++) {
      const op = rand();
      if (op < 0.25) {
        const s = pick(socks);
        if (s.subs.size < 4) s.sub(`q${++q}`, pick(fns), { room: pick(rooms) });
      } else if (op < 0.32) {
        const s = pick(socks);
        const k = [...s.subs.keys()][0];
        if (k) s.unsub(k);
      } else if (op < 0.55) {
        const priv = rand() < 0.4;
        const { value } = await mutate(writer.c, "shared:put", { room: pick(rooms), body: `n${step}`, ...(priv ? { private: true, owner: pick(users) } : {}) });
        notes.push(value as string);
      } else if (op < 0.68 && notes.length) {
        await mutate(writer.c, "shared:setPrivate", { id: pick(notes), private: rand() < 0.5 });
      } else if (op < 0.8) {
        await mutate(writer.c, "shared:join", { room: pick(rooms), user: pick(users) });
      } else if (op < 0.9) {
        await mutate(writer.c, "shared:leave", { room: pick(rooms), user: pick(users) });
      } else {
        const s = pick(socks);
        const t = pick(tokens);
        s.c.send({ t: "auth", token: t ?? null });
        s.token = t;
      }
      if (step % 3 === 2) await expectTruth(shard, socks);
    }
    await expectTruth(shard, socks);
    const i = await inspect(shard);
    // The run exercised every path: shared entries, splits back to per-identity ones, gates.
    expect(i.stats.gateRuns).toBeGreaterThan(0);
    expect(i.stats.splits).toBeGreaterThan(0);
    expect(i.stats.identityRuns).toBeGreaterThan(0);
  }, 60_000);
});
