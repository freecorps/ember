// WebSocket hot path of a commit: the `mres` frame reuses the outcome JSON the commit already encoded for the dedup
// ring (byte-identical to encoding the object form), and a ring row that lands acks rewrites only the attachments of
// the sockets that sent them, each once.
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { encodeServerMessage, type ServerMessage } from "../src/protocol.ts";
import { parse } from "../src/wire.ts";
import type { Shard } from "../src/shard.ts";
import { api, connect, hello, is, shardStub, type Client } from "./helpers.ts";

type Mres = Extract<ServerMessage, { t: "mres" }>;

async function mutate(c: Client, mid: string, fn: string, args: Record<string, unknown>): Promise<{ m: Mres; raw: string }> {
  c.send({ t: "mut", mid, fn, args });
  const m = await c.waitFor<Mres>(is("mres", (x) => x.mid === mid));
  const raw = c.raw.find((r) => r.includes(`"t":"mres"`) && (parse(r) as Mres).mid === mid)!;
  return { m, raw };
}

/** The frame as the object form encodes it (what every `mres` was before). */
const objectForm = (m: Mres): string => encodeServerMessage(m.ok ? { t: "mres", mid: m.mid, ok: true, value: m.value, version: m.version } : { t: "mres", mid: m.mid, ok: false, error: m.error });

describe("mres frames", () => {
  for (const features of [["ack"], []]) {
    it(`are byte-identical to the object form (features: ${JSON.stringify(features)}), fresh and replayed`, async () => {
      const c = await connect(`chat:mres-${features.length}`);
      await hello(c, "dev-1", "good:dan", features);
      const cases: Array<[string, string, Record<string, unknown>]> = [
        ["w1", "misc:echoWrite", { s: 'quote " back\\slash \u0001 ção 😀' }],
        ["n1", "misc:echo", { s: "effect-free" }],
        ["n2", "misc:noop", {}],
        ["q1", "typed:quota", { channel: "mres" }],
      ];
      for (const [mid, fn, args] of cases) {
        const { m, raw } = await mutate(c, mid, fn, args);
        expect(raw).toBe(objectForm(m));
        if (fn === "typed:quota") expect(m).toMatchObject({ ok: false, error: { code: "Quota", data: { limit: 3, used: 4n } } });
        else {
          expect(m.ok).toBe(true);
          expect(raw).toContain(`"version":`);
        }
      }
      if (!features.length) {
        // Without `ack`, a commit without changes has no ring row: its outcomes went to the dedup table, and the frames
        // above (version included) were built from the JSON written there.
        await runInDurableObject(shardStub(`chat:mres-0`), (instance: Shard, state) => {
          const table = (instance as unknown as { dedupTables: string[] }).dedupTables[0]!;
          const rows = state.storage.sql.exec<{ mid: string; result: string }>(`SELECT mid, result FROM ${table}`).toArray();
          const byMid = new Map(rows.map((r) => [JSON.parse(r.mid) as string, r.result]));
          for (const mid of ["n1", "n2", "q1"]) expect(byMid.has(mid)).toBe(true);
          expect(byMid.get("n1")).toContain(`"version":`);
        });
      }
      // A retry is answered from the dedup ring: same frame.
      const again = await connect(`chat:mres-${features.length}`);
      await hello(again, "dev-1", "good:dan", features);
      const first = await mutate(c, "w2", "misc:echoWrite", { s: "x" });
      const replay = await mutate(again, "w2", "misc:echoWrite", { s: "x" });
      expect(replay.raw).toBe(first.raw);
      c.close();
      again.close();
    });
  }
});

describe("acks in socket attachments", () => {
  it("the ring row that lands them rewrites only the acking socket's attachment, once", async () => {
    const shard = "chat:acked-sockets";
    const sockets: Client[] = [];
    for (let i = 0; i < 5; i++) {
      const c = await connect(shard);
      await hello(c, `dev-${i}`, "good:dan", ["ack"]);
      sockets.push(c);
    }
    const acker = sockets[0]!;
    await mutate(acker, "a1", "misc:echoWrite", { s: "one" });
    await mutate(acker, "a2", "misc:echoWrite", { s: "two" });
    acker.send({ t: "ack", mids: ["a1", "a2"] });
    await new Promise((r) => setTimeout(r, 20));

    const writes = new Map<string, number>();
    await runInDurableObject(shardStub(shard), (instance: Shard, state) => {
      expect((instance as unknown as { ackedSockets: Set<string> }).ackedSockets.size).toBe(1);
      for (const ws of state.getWebSockets()) {
        const sid = (ws.deserializeAttachment() as { sid: string }).sid;
        const orig = ws.serializeAttachment.bind(ws);
        ws.serializeAttachment = (v: unknown) => {
          writes.set(sid, (writes.get(sid) ?? 0) + 1);
          orig(v);
        };
      }
    });
    // The next commit's ring row carries the acks.
    expect((await api("mutation", { fn: "messages:send", args: { channel: "filler", body: "f" }, shard })).body.ok).toBe(true);
    await runInDurableObject(shardStub(shard), (instance: Shard, state) => {
      expect((instance as unknown as { ackedSockets: Set<string> }).ackedSockets.size).toBe(0);
      const atts = state.getWebSockets().map((ws) => ws.deserializeAttachment() as { sid: string; acks?: string[] });
      expect(atts.every((a) => !a.acks?.length)).toBe(true);
      expect([...writes.values()]).toEqual([1]);
    });
    // A later commit with no acks rewrites nothing.
    writes.clear();
    expect((await api("mutation", { fn: "messages:send", args: { channel: "filler", body: "g" }, shard })).body.ok).toBe(true);
    expect(writes.size).toBe(0);
    for (const c of sockets) c.close();
  });

  it("a throwing attachment write keeps that socket's acks queued and still clears the others", async () => {
    const shard = "chat:acked-sockets-throw";
    const a = await connect(shard);
    await hello(a, "dev-a", "good:dan", ["ack"]);
    const b = await connect(shard);
    await hello(b, "dev-b", "good:dan", ["ack"]);
    await mutate(a, "a1", "misc:echoWrite", { s: "one" });
    await mutate(b, "b1", "misc:echoWrite", { s: "two" });
    a.send({ t: "ack", mids: ["a1"] });
    b.send({ t: "ack", mids: ["b1"] });
    await new Promise((r) => setTimeout(r, 20));
    let sidA = "";
    let fail = true;
    await runInDurableObject(shardStub(shard), (instance: Shard, state) => {
      const acked = (instance as unknown as { ackedSockets: Set<string> }).ackedSockets;
      expect(acked.size).toBe(2);
      for (const ws of state.getWebSockets()) {
        const att = ws.deserializeAttachment() as { sid: string; clientId: string };
        if (att.clientId !== "dev-a") continue;
        sidA = att.sid;
        const orig = ws.serializeAttachment.bind(ws);
        ws.serializeAttachment = (v: unknown) => {
          if (fail && !(v as { acks?: unknown[] }).acks) throw new Error("serialize failed");
          orig(v);
        };
      }
    });
    // The commit lands (its ring row carries both acks); only `a`'s rewrite fails.
    expect((await api("mutation", { fn: "messages:send", args: { channel: "filler", body: "f" }, shard })).body.ok).toBe(true);
    await runInDurableObject(shardStub(shard), (instance: Shard, state) => {
      expect([...(instance as unknown as { ackedSockets: Set<string> }).ackedSockets]).toEqual([sidA]);
      const atts = state.getWebSockets().map((ws) => ws.deserializeAttachment() as { clientId: string; acks?: string[] });
      expect(atts.find((x) => x.clientId === "dev-a")!.acks?.length).toBeGreaterThan(0);
      expect(atts.find((x) => x.clientId === "dev-b")!.acks ?? []).toEqual([]);
    });
    // The next ring row, even one without acks of its own, retries `a`.
    fail = false;
    expect((await api("mutation", { fn: "messages:send", args: { channel: "filler", body: "g" }, shard })).body.ok).toBe(true);
    await runInDurableObject(shardStub(shard), (instance: Shard, state) => {
      expect((instance as unknown as { ackedSockets: Set<string> }).ackedSockets.size).toBe(0);
      const atts = state.getWebSockets().map((ws) => ws.deserializeAttachment() as { acks?: string[] });
      expect(atts.every((x) => !x.acks?.length)).toBe(true);
    });
    a.close();
    b.close();
  });
});
