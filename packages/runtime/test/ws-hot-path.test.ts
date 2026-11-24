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
        else expect(m.ok).toBe(true);
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
});
