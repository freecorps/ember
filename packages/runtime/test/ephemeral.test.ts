// Ephemeral channels (feature "ephemeral", contracts.md): rooms of sockets on a shard, broadcast in memory. Nothing is
// written (no row, no version, nothing in `_ember_changes`), memberships survive hibernation in the attachments, the
// app's `authorize` gates every join (again on an identity change), and expired or revoked sockets neither publish nor
// receive.
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { EPHEMERAL_BURST, EPHEMERAL_MAX_PAYLOAD_CHARS, EPHEMERAL_TTL_CLOSE, EPHEMERAL_TTL_MS } from "../src/ephemeral.ts";
import type { ServerMessage } from "../src/protocol.ts";
import type { Shard } from "../src/shard.ts";
import { connect, hello, is, shardStub, sleep, type Client } from "./helpers.ts";

type Joined = Extract<ServerMessage, { t: "joined" }>;
type Msg = Extract<ServerMessage, { t: "msg" }>;
type Members = Extract<ServerMessage, { t: "members" }>;
type Left = Extract<ServerMessage, { t: "left" }>;

const nowS = () => Math.floor(Date.now() / 1000);

async function member(shard: string, token?: string, features: string[] = ["ephemeral"]): Promise<Client> {
  const c = await connect(shard);
  const ready = await hello(c, crypto.randomUUID(), token, features);
  if (features.includes("ephemeral")) expect(ready.features).toContain("ephemeral");
  return c;
}

async function join(c: Client, ch: string, state?: unknown): Promise<Joined> {
  c.send(state === undefined ? { t: "join", ch } : { t: "join", ch, state });
  return c.waitFor<Joined>(is("joined", (m) => m.ch === ch));
}

/** Rows written and version of the shard, and its `_ember_changes` rows (read in the object). */
async function writes(shard: string) {
  const stub = shardStub(shard);
  const info = await stub.inspect();
  const changes = await runInDurableObject(stub, (_i, state) => Number(state.storage.sql.exec("SELECT COUNT(*) AS n FROM _ember_changes").toArray()[0]?.n ?? 0));
  return { written: info.rows.written, version: info.version, changes };
}

describe("ephemeral channels", () => {
  it("broadcasts between sockets in memory: no row written, no version, nothing in the change log", async () => {
    const shard = "eph:broadcast";
    const a = await member(shard, "good:ana");
    const b = await member(shard, "good:bia");
    const c = await member(shard, "good:caio");
    const before = await writes(shard);

    const ja = await join(a, "room:1", { name: "Ana" });
    expect(ja.members).toEqual([{ id: ja.self, user: "ana", state: { name: "Ana" } }]);
    const jb = await join(b, "room:1");
    expect(jb.members.map((m) => m.user).sort()).toEqual(["ana", "bia"]);
    expect((await a.waitFor<Members>(is("members"))).join).toEqual([{ id: jb.self, user: "bia" }]);
    const jc = await join(c, "room:1");
    await a.waitFor(is("members", (m) => m.join?.[0]?.id === jc.self));
    await b.waitFor(is("members", (m) => m.join?.[0]?.id === jc.self));

    a.send({ t: "pub", ch: "room:1", data: { cursor: [1, 2], big: 2n ** 70n } });
    for (const x of [b, c]) {
      const m = await x.waitFor<Msg>(is("msg"));
      expect(m).toEqual({ t: "msg", ch: "room:1", from: ja.self, user: "ana", data: { cursor: [1, 2], big: 2n ** 70n } });
    }
    // State update (a join again): the others see it; the sender never gets its own message back.
    await join(a, "room:1", { name: "Ana B." });
    expect((await b.waitFor<Members>(is("members"))).join).toEqual([{ id: ja.self, user: "ana", state: { name: "Ana B." } }]);
    c.send({ t: "leave", ch: "room:1" });
    expect((await a.waitFor<Members>(is("members", (m) => !!m.leave))).leave).toEqual([jc.self]);
    // A close leaves too.
    b.close();
    expect((await a.waitFor<Members>(is("members", (m) => !!m.leave))).leave).toEqual([jb.self]);
    await sleep(30);
    expect(a.frames.some((f) => f.t === "msg")).toBe(false);

    expect(await writes(shard)).toEqual(before);
    const info = await shardStub(shard).inspect();
    expect(info.ephemeral).toMatchObject({ channels: 1, members: 1, messages: 1, delivered: 2 });
    a.close();
    c.close();
  });

  it("memberships survive hibernation: the rooms are rebuilt from the attachments, still without a write", async () => {
    const shard = "eph:wake";
    const a = await member(shard, "good:ana");
    const b = await member(shard, "good:bia");
    const ja = await join(a, "room:w", { name: "Ana" });
    const jb = await join(b, "room:w");
    await a.waitFor(is("members"));
    const stub = shardStub(shard);
    await evictDurableObject(stub);
    const before = await writes(shard);
    expect((await stub.inspect()).ephemeral).toMatchObject({ channels: 1, members: 2 });

    b.send({ t: "pub", ch: "room:w", data: "after the wake" });
    expect(await a.waitFor<Msg>(is("msg"))).toMatchObject({ from: jb.self, user: "bia", data: "after the wake" });
    const c = await member(shard, "good:caio");
    const jc = await join(c, "room:w");
    expect(jc.members.map((m) => [m.id, m.user, m.state]).sort()).toEqual(
      [
        [ja.self, "ana", { name: "Ana" }],
        [jb.self, "bia", undefined],
        [jc.self, "caio", undefined],
      ].sort(),
    );
    a.close();
    expect((await b.waitFor<Members>(is("members", (m) => !!m.leave))).leave).toEqual([ja.self]);
    expect(await writes(shard)).toEqual(before);
    b.close();
    c.close();
  });

  it("the app's authorize refuses: anonymous, a room only one user may join, unknown names, bad names", async () => {
    const shard = "eph:authz";
    const anon = await member(shard);
    const bia = await member(shard, "good:bia");
    const ana = await member(shard, "good:ana");
    anon.send({ t: "join", ch: "room:1" });
    expect(await anon.waitFor<Left>(is("left"))).toMatchObject({ ch: "room:1", code: "channel_denied" });
    bia.send({ t: "join", ch: "room:vip" });
    expect(await bia.waitFor<Left>(is("left"))).toMatchObject({ ch: "room:vip", code: "channel_denied" });
    await join(ana, "room:vip");
    bia.send({ t: "join", ch: "nope:1" });
    expect(await bia.waitFor<Left>(is("left"))).toMatchObject({ ch: "nope:1", code: "channel_denied" });
    bia.send({ t: "join", ch: "room:has space" });
    expect(await bia.waitFor<Left>(is("left"))).toMatchObject({ code: "bad_channel" });
    // A refused socket never got in: its publish is refused, and nobody hears it.
    bia.send({ t: "pub", ch: "room:vip", data: 1 });
    expect(await bia.waitFor(is("err", (m) => m.ch === "room:vip"))).toMatchObject({ code: "not_joined" });
    // Public channel, anonymous welcome.
    await join(anon, "open");
    // Without the feature: refused, nothing joined.
    const old = await member(shard, "good:old", []);
    old.send({ t: "join", ch: "open" });
    expect(await old.waitFor(is("err"))).toMatchObject({ code: "bad_frame", ch: "open" });
    await sleep(30);
    expect(ana.frames.some((f) => f.t === "members")).toBe(false);
    for (const x of [anon, bia, ana, old]) x.close();
  });

  it("channels are per shard; authorize sees the shard", async () => {
    const a = await member("eph:s1", "good:ana");
    const b = await member("eph:s2", "good:bia");
    await join(a, "here:s1");
    b.send({ t: "join", ch: "here:s1" });
    expect(await b.waitFor<Left>(is("left"))).toMatchObject({ code: "channel_denied" });
    await join(a, "open");
    const jb = await join(b, "open");
    expect(jb.members).toHaveLength(1);
    a.send({ t: "pub", ch: "open", data: "s1 only" });
    await sleep(50);
    expect(b.frames.some((f) => f.t === "msg")).toBe(false);
    a.close();
    b.close();
  });

  it("payload and state are capped and typed; publishes are rate limited per socket", async () => {
    const shard = "eph:limits";
    const a = await member(shard, "good:ana", ["ephemeral", "batch"]);
    const b = await member(shard, "good:bia");
    a.send({ t: "join", ch: "typed:1", state: { name: 3 } });
    expect(await a.waitFor<Left>(is("left"))).toMatchObject({ code: "invalid_state" });
    a.send({ t: "join", ch: "room:1", state: { blob: "x".repeat(600) } });
    expect(await a.waitFor<Left>(is("left"))).toMatchObject({ code: "too_large" });
    await join(a, "typed:1", { name: "Ana" });
    await join(b, "typed:1");
    a.send({ t: "pub", ch: "typed:1", data: { x: "1", y: 2 } });
    expect(await a.waitFor(is("err"))).toMatchObject({ code: "invalid_payload", ch: "typed:1" });
    // A refused state update keeps the member in, with its state.
    a.send({ t: "join", ch: "typed:1", state: { name: 1 } });
    expect(await a.waitFor(is("err"))).toMatchObject({ code: "invalid_state", ch: "typed:1" });
    await join(a, "room:1");
    a.send({ t: "pub", ch: "room:1", data: "y".repeat(EPHEMERAL_MAX_PAYLOAD_CHARS) });
    expect(await a.waitFor(is("err"))).toMatchObject({ code: "too_large", ch: "room:1" });
    a.send({ t: "pub", ch: "typed:1", data: { x: 1, y: 2 } });
    expect((await b.waitFor<Msg>(is("msg"))).data).toEqual({ x: 1, y: 2 });

    // A burst in one frame: past the bucket, refused (the bucket refills at 20/s).
    a.send(JSON.stringify(Array.from({ length: EPHEMERAL_BURST + 20 }, (_, i) => ({ t: "pub", ch: "typed:1", data: { x: i, y: 0 } }))));
    const refused = await a.waitFor(is("err", (m) => m.code === "rate_limited"));
    expect(refused).toMatchObject({ ch: "typed:1" });
    await sleep(100);
    const got = b.frames.filter((f) => f.t === "msg").length;
    expect(got).toBeGreaterThan(10);
    expect(got).toBeLessThanOrEqual(EPHEMERAL_BURST);
    a.close();
    b.close();
  });

  it("a revoked socket neither receives nor publishes; a fresh token brings it back with the current members", async () => {
    const shard = "eph:revoke";
    const iat = nowS() - 60;
    const a = await member(shard, `sess:ana:s1:${iat}`);
    const b = await member(shard, "good:bia");
    const ja = await join(a, "room:r");
    await join(b, "room:r");
    await a.waitFor(is("members"));
    const revoker = shardStub(shard) as unknown as { revokeSockets(shard: string, match: unknown): Promise<{ sockets: number }> };
    expect(await revoker.revokeSockets(shard, { claim: "sid", value: "s1" })).toEqual({ sockets: 1 });
    await a.waitFor(is("authExpired"));
    b.send({ t: "pub", ch: "room:r", data: "not for a" });
    a.send({ t: "pub", ch: "room:r", data: "from a" });
    expect(await a.waitFor(is("err", (m) => m.ch === "room:r"))).toMatchObject({ code: "auth_expired" });
    await sleep(50);
    expect(a.frames.some((f) => f.t === "msg")).toBe(false);
    expect(b.frames.some((f) => f.t === "msg")).toBe(false);
    // A new sign-in (later iat): a fresh `joined`, and messages again.
    a.send({ t: "auth", token: `sess:ana:s1:${nowS() + 1}` });
    const again = await a.waitFor<Joined>(is("joined"));
    expect(again.self).toBe(ja.self);
    expect(again.members).toHaveLength(2);
    b.send({ t: "pub", ch: "room:r", data: "for a" });
    expect((await a.waitFor<Msg>(is("msg"))).data).toBe("for a");
    a.close();
    b.close();
  });

  it("an expired socket stops receiving at once", async () => {
    const shard = "eph:expire";
    const a = await member(shard, "soon:ana:600");
    const b = await member(shard, "good:bia");
    await join(a, "room:e");
    await join(b, "room:e");
    await sleep(700);
    b.send({ t: "pub", ch: "room:e", data: "late" });
    await a.waitFor(is("authExpired"));
    await sleep(30);
    expect(a.frames.some((f) => f.t === "msg")).toBe(false);
    a.close();
    b.close();
  });

  it("an identity change on the socket authorizes its channels again", async () => {
    const shard = "eph:ident";
    const a = await member(shard, "org:ana:o1");
    const b = await member(shard, "org:bia:o1");
    const ja = await join(a, "org:o1");
    await join(b, "org:o1");
    await join(a, "room:1");
    await a.waitFor(is("members"));
    // Another organization: out of org:o1 (the others are told), still in room:1.
    a.send({ t: "auth", token: "org:ana:o2" });
    expect(await a.waitFor<Left>(is("left"))).toMatchObject({ ch: "org:o1", code: "channel_denied" });
    expect((await b.waitFor<Members>(is("members", (m) => !!m.leave))).leave).toEqual([ja.self]);
    expect((await a.waitFor<Joined>(is("joined", (m) => m.ch === "room:1"))).members[0]).toMatchObject({ user: "ana" });
    // Signed out: out of room:1 too (signed-in rooms).
    a.send({ t: "auth", token: null });
    expect(await a.waitFor<Left>(is("left"))).toMatchObject({ ch: "room:1", code: "channel_denied" });
    b.send({ t: "pub", ch: "org:o1", data: "x" });
    await sleep(50);
    expect(a.frames.some((f) => f.t === "msg")).toBe(false);
    a.close();
    b.close();
  });

  it("ref: the answer to a join or pub carries it; a pub with ref is answered published once it went out", async () => {
    const shard = "eph:ref";
    const a = await member(shard, "good:ana");
    const b = await member(shard, "good:bia");
    a.send({ t: "join", ch: "typed:r", ref: 1 });
    expect(await a.waitFor<Joined>(is("joined"))).toMatchObject({ ch: "typed:r", ref: 1 });
    b.send({ t: "join", ch: "room:vip", ref: 2 });
    expect(await b.waitFor<Left>(is("left"))).toMatchObject({ ch: "room:vip", code: "channel_denied", ref: 2 });
    // A refused update of a member that stays in: `err` with the ref.
    a.send({ t: "join", ch: "typed:r", state: { name: 1 }, ref: 3 });
    expect(await a.waitFor(is("err"))).toMatchObject({ code: "invalid_state", ch: "typed:r", ref: 3 });
    await join(b, "typed:r");
    a.send({ t: "pub", ch: "typed:r", data: { x: "no", y: 0 }, ref: 4 });
    expect(await a.waitFor(is("err", (m) => m.ref === 4))).toMatchObject({ code: "invalid_payload", ch: "typed:r" });
    a.send({ t: "pub", ch: "typed:r", data: { x: 1, y: 2 }, ref: 5 });
    expect(await a.waitFor(is("published"))).toEqual({ t: "published", ch: "typed:r", ref: 5 });
    expect((await b.waitFor<Msg>(is("msg"))).data).toEqual({ x: 1, y: 2 });
    // Without ref: no answer to a pub that went out (as before).
    b.send({ t: "pub", ch: "typed:r", data: { x: 3, y: 4 } });
    await a.waitFor<Msg>(is("msg"));
    await sleep(30);
    expect(b.frames.filter((f) => f.t === "published")).toEqual([]);
    a.send({ t: "pub", ch: "typed:r", data: { x: 1, y: 2 }, ref: -1 });
    expect(await a.waitFor(is("err", (m) => m.code === "bad_frame"))).toBeTruthy();
    a.close();
    b.close();
  });

  it("a join that would push the socket's subscriptions out of its attachment is refused: still no row written", async () => {
    const shard = "eph:attach";
    const a = await member(shard, "good:ana");
    const stub = shardStub(shard);
    const size = () => runInDurableObject(stub, (instance: Shard) => JSON.stringify([...(instance as unknown as { attachments: Map<string, unknown> }).attachments.values()][0]).length);
    const subsRows = () => runInDurableObject(stub, (_i, state) => Number(state.storage.sql.exec("SELECT COUNT(*) AS n FROM _ember_subs").toArray()[0]?.n ?? 0));
    // A subscription whose args leave about 300 chars free in the 16 KB attachment.
    const pad = "p".repeat(15_700 - (await size()));
    a.send({ t: "sub", qid: 1, fn: "messages:list", args: { channel: pad } });
    await a.waitFor(is("snap"));
    expect(await subsRows()).toBe(0);
    const before = await writes(shard);
    a.send({ t: "join", ch: "open", state: { blob: "s".repeat(480) } });
    expect(await a.waitFor<Left>(is("left"))).toMatchObject({ ch: "open", code: "too_large" });
    expect(await subsRows()).toBe(0);
    expect(await writes(shard)).toEqual(before);
    // A join that fits still goes in, the subscription still in the attachment.
    await join(a, "open");
    expect(await subsRows()).toBe(0);
    expect(await writes(shard)).toEqual(before);
    a.close();
  });

  it("a join refused by the rate limit still sweeps the channel", async () => {
    const shard = "eph:sweep-limited";
    const a = await member(shard, "good:ana", ["ephemeral", "batch"]);
    const b = await member(shard, "good:bia");
    await join(a, "room:other");
    await join(b, "room:s");
    const bClosed = new Promise<number>((resolve) => b.ws.addEventListener("close", (e) => resolve(e.code)));
    const stub = shardStub(shard);
    await runInDurableObject(stub, (instance: Shard) => {
      const eph = (instance as unknown as { eph: { seen: Map<string, number>; swept: Map<string, number> } }).eph;
      for (const sid of eph.seen.keys()) eph.seen.set(sid, Date.now() - EPHEMERAL_TTL_MS - 1_000);
      eph.swept.clear();
    });
    // `a` spends its bucket on another channel, then (same frame: no refill in between) joins `b`'s.
    a.send(JSON.stringify([...Array.from({ length: EPHEMERAL_BURST + 5 }, () => ({ t: "pub", ch: "room:other", data: 0 })), { t: "join", ch: "room:s" }]));
    expect(await a.waitFor<Left>(is("left"))).toMatchObject({ ch: "room:s", code: "rate_limited" });
    expect(await bClosed).toBe(EPHEMERAL_TTL_CLOSE);
    expect((await stub.inspect()).ephemeral).toMatchObject({ timedOut: 1 });
    a.close();
  });

  it("a member silent past the TTL is closed and leaves; an auto-response ping keeps it", async () => {
    const shard = "eph:ttl";
    const a = await member(shard, "good:ana");
    const b = await member(shard, "good:bia");
    const p = await member(shard, "good:pia");
    const ja = await join(a, "room:t");
    await join(b, "room:t");
    const jp = await join(p, "room:t");
    // `p` pings (answered by the auto-response, without waking the object); `a` stays silent.
    p.send("ping");
    await sleep(50);
    const stub = shardStub(shard);
    const closed = new Promise<number>((resolve) => a.ws.addEventListener("close", (e) => resolve(e.code)));
    await runInDurableObject(stub, (instance: Shard) => {
      const eph = (instance as unknown as { eph: { seen: Map<string, number>; swept: Map<string, number> } }).eph;
      // As if the last frames were a TTL ago (p's ping is newer, from the auto-response timestamp).
      for (const sid of eph.seen.keys()) eph.seen.set(sid, Date.now() - EPHEMERAL_TTL_MS - 1_000);
      eph.swept.clear();
    });
    // The next join to the channel sweeps it: `a` goes (closed), `b` too (silent), `p` stays.
    const c = await member(shard, "good:caio");
    const jc = await join(c, "room:t");
    expect(await closed).toBe(EPHEMERAL_TTL_CLOSE);
    expect(jc.members.map((m) => m.id).sort()).toEqual([jp.self, jc.self].sort());
    const gone = (await p.waitFor<Members>(is("members", (m) => !!m.leave?.includes(ja.self)))).leave;
    expect(gone).toEqual([ja.self]);
    expect((await stub.inspect()).ephemeral.timedOut).toBe(2);
    for (const x of [b, p, c]) x.close();
  });
});
