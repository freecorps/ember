// Feature "zframe" (protocol v1.5): a server frame above 2 KiB goes to a client that announced the feature as a binary
// message of raw-DEFLATE bytes; smaller frames, and every frame to a client without it, stay text. Order is kept, and
// the feature survives a hibernation (it lives in the socket's attachment).
import { evictDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ServerMessage } from "../src/protocol.ts";
import { connect, hello, is, shardStub } from "./helpers.ts";

type Snap = Extract<ServerMessage, { t: "snap"; value: unknown }>;
type Patch = Extract<ServerMessage, { t: "patch" }>;

/** `n` messages in `channel`, written in one batch frame. */
async function seed(shard: string, channel: string, n: number) {
  const w = await connect(shard);
  await hello(w, "seed", undefined, ["batch"]);
  const body = (i: number) => `message ${i} of the channel, with some text to make the row a realistic size`;
  w.send(JSON.stringify(Array.from({ length: n }, (_, i) => ({ t: "mut", mid: `s${i}`, fn: "messages:send", args: { channel, body: body(i) } }))));
  for (let i = 0; i < n; i++) await w.waitFor(is("mres", (m) => m.mid === `s${i}`));
  w.close();
}

describe("zframe: compressed server frames", () => {
  it("negotiated in the hello; never confirmed to a client that did not ask", async () => {
    const a = await connect("chat:z-ready");
    expect((await hello(a, "a", undefined, ["batch", "zframe"])).features).toEqual(["batch", "zframe"]);
    const b = await connect("chat:z-ready");
    expect((await hello(b, "b", undefined, ["batch"])).features).toEqual(["batch"]);
    a.close();
    b.close();
  });

  it("a large snap arrives compressed and decodes to the same value; a small one, and every frame to an old client, stay text", async () => {
    const shard = "chat:z-snap";
    await seed(shard, "big", 120);
    const z = await connect(shard);
    await hello(z, "z", undefined, ["ident", "zframe"]);
    const plain = await connect(shard);
    await hello(plain, "p", undefined, ["ident"]);
    for (const c of [z, plain]) {
      c.send({ t: "sub", qid: "big", fn: "messages:list", args: { channel: "big" } });
      c.send({ t: "sub", qid: "small", fn: "messages:list", args: { channel: "none" } });
    }
    const [zs, ps] = await Promise.all([z.waitFor<Snap>(is("snap", (m) => m.qid === "big")), plain.waitFor<Snap>(is("snap", (m) => m.qid === "big"))]);
    expect(zs.value).toEqual(ps.value);
    expect((zs.value as unknown[]).length).toBe(120);
    await z.waitFor(is("snap", (m) => m.qid === "small"));
    await plain.waitFor(is("snap", (m) => m.qid === "small"));

    const bigOf = (c: typeof z) => c.wire.find((f) => f.chars > 2048)!;
    const zBig = bigOf(z);
    const pBig = bigOf(plain);
    expect(zBig.binary).toBe(true);
    expect(pBig.binary).toBe(false);
    expect(zBig.chars).toBe(pBig.chars);
    // Repetitive JSON of documents compresses well: a fraction of the text on the wire.
    expect(zBig.bytes).toBeLessThan(zBig.chars / 4);
    console.info(`zframe: snap of 120 rows ${zBig.chars} B as text → ${zBig.bytes} B compressed (${((100 * zBig.bytes) / zBig.chars).toFixed(1)}%)`);
    // Small frames stay text (ready, the empty snap).
    expect(z.wire.filter((f) => f.chars <= 2048).every((f) => !f.binary)).toBe(true);
    expect(plain.wire.every((f) => !f.binary)).toBe(true);
    const stats = (await shardStub(shard).inspect()).stats as { zframes: number; zframeBytesIn: number; zframeBytesOut: number };
    expect(stats.zframes).toBe(1);
    expect(stats.zframeBytesOut).toBe(zBig.bytes);
    z.close();
    plain.close();
  });

  it("frames keep their order around a compressed one (batch: a big patch, then the small mres)", async () => {
    const shard = "chat:z-order";
    await seed(shard, "o", 60);
    const c = await connect(shard);
    await hello(c, "c", undefined, ["zframe"]);
    c.send({ t: "sub", qid: 1, fn: "messages:list", args: { channel: "o" } });
    await c.waitFor(is("snap"));
    const before = c.raw.length;
    // Without rowdiff the patch carries the whole list (large); its mres (small) follows it.
    c.send({ t: "mut", mid: "m1", fn: "messages:send", args: { channel: "o", body: "one more" } });
    c.send({ t: "mut", mid: "m2", fn: "messages:send", args: { channel: "x", body: "small" } });
    await c.waitFor(is("mres", (m) => m.mid === "m2"));
    const kinds = c.raw.slice(before).map((r) => (JSON.parse(r) as { t: string; mid?: string }).t + ((JSON.parse(r) as { mid?: string }).mid ?? ""));
    expect(kinds.indexOf("patch")).toBeLessThan(kinds.indexOf("mresm1"));
    expect(kinds.indexOf("mresm1")).toBeLessThan(kinds.indexOf("mresm2"));
    expect(c.wire.slice(before).some((f) => f.binary)).toBe(true);
    c.close();
  });

  it("survives a hibernation: after a wake, a large patch still goes compressed", async () => {
    const shard = "chat:z-wake";
    await seed(shard, "w", 60);
    const c = await connect(shard);
    await hello(c, "c", undefined, ["zframe"]);
    c.send({ t: "sub", qid: 1, fn: "messages:list", args: { channel: "w" } });
    await c.waitFor(is("snap"));
    await evictDurableObject(shardStub(shard));
    const w = await connect(shard);
    await hello(w, "w");
    const before = c.wire.length;
    w.send({ t: "mut", mid: "after", fn: "messages:send", args: { channel: "w", body: "after wake" } });
    const patch = await c.waitFor<Patch>(is("patch"));
    expect((patch.changes[0]!.value as unknown[]).length).toBe(61);
    expect(c.wire.slice(before).find((f) => f.chars > 2048)?.binary).toBe(true);
    c.close();
    w.close();
  });
});
