import { describe, expect, it } from "vitest";
import { rowDiff } from "@freecorps/ember-values";
import { encodeServerMessage, type ServerMessage } from "../src/protocol.ts";
import { parse, stringify } from "../src/wire.ts";
import { connect, hello, is, shardStub } from "./helpers.ts";

type Snap = Extract<ServerMessage, { t: "snap"; value: unknown }>;
type Patch = Extract<ServerMessage, { t: "patch" }>;

// Compare the actual assembled wire frame against the previous object encoder.
function sameFrame(raw: string[], type: "snap" | "patch", old: ServerMessage) {
  const frame = raw.filter((s) => (parse(s) as ServerMessage).t === type).at(-1)!;
  expect(parse(frame)).toEqual(parse(encodeServerMessage(old)));
}

describe("pre-encoded subscription frames", () => {
  it("preserves omitted undefined values in patches and cached snapshots", async () => {
    const a = await connect("socket:encoded-undefined");
    await hello(a, "a", undefined, ["ident"]);
    a.send({ t: "sub", qid: 1, fn: "messages:optional", args: { channel: "x" } });
    expect(await a.waitFor(is("snap"))).toMatchObject({ value: 0 });
    a.send({ t: "mut", mid: 1, fn: "messages:send", args: { channel: "x", body: "row" } });
    await a.waitFor(is("patch"));
    sameFrame(a.raw, "patch", { t: "patch", version: 1, changes: [{ qid: 1, value: undefined }], mids: [1] });
    await a.waitFor(is("mres"));
    a.send({ t: "sub", qid: 2, fn: "messages:optional", args: { channel: "x" } });
    const snap = await a.waitFor<Snap>(is("snap"));
    sameFrame(a.raw, "snap", { ...snap, value: undefined });
    expect("value" in snap).toBe(false);
    a.close();
  });

  it("shares nested tagged values across sockets and safely encodes each qid, identity tag and mid", async () => {
    const shard = "socket:encoded-nested";
    const sockets = [await connect(shard), await connect(shard), await connect(shard)];
    const qids = [0, 'q"\\\n', "other"];
    const args = { channel: "x" };
    for (let i = 0; i < sockets.length; i++) {
      const c = sockets[i]!;
      await hello(c, `c${i}`, undefined, i === 1 ? [] : ["ident"]);
      c.send({ t: "sub", qid: qids[i]!, fn: "messages:nested", args });
      const snap = await c.waitFor<Snap>(is("snap"));
      sameFrame(c.raw, "snap", { ...snap, value: { nested: { rows: [] } } });
    }
    expect(await shardStub(shard).inspect()).toMatchObject({ queries: 1, subs: 3 });
    const a = sockets[0]!;
    const mid = 'm"\\\n';
    a.send({ t: "mut", mid, fn: "messages:send", args: { ...args, body: "quoted \" \\ \n", n: 9223372036854775807n, blob: new Uint8Array([0, 255, 17]) } });
    let value: unknown;
    for (let i = 0; i < sockets.length; i++) {
      const c = sockets[i]!;
      const patch = await c.waitFor<Patch>(is("patch"));
      value ??= patch.changes[0]!.value;
      expect(value).toMatchObject({ nested: { rows: [expect.objectContaining({ n: 9223372036854775807n, blob: new Uint8Array([0, 255, 17]) })] } });
      sameFrame(c.raw, "patch", { t: "patch", version: 1, changes: [{ qid: qids[i]!, value }], mids: i === 0 ? [mid] : [] });
    }
    await a.waitFor(is("mres"));
    // A cached snapshot after the commit must splice the tagged nested JSON too.
    a.send({ t: "sub", qid: "cached", fn: "messages:nested", args });
    const snap = await a.waitFor<Snap>(is("snap", (m) => m.qid === "cached"));
    sameFrame(a.raw, "snap", { ...snap, value });
    for (const c of sockets) c.close();
  });

  it("encodes a row diff once for several subscribers while legacy sockets get the full value", async () => {
    const shard = "socket:encoded-diff";
    const sockets = [await connect(shard), await connect(shard), await connect(shard)];
    const a = sockets[0]!;
    for (let i = 0; i < sockets.length; i++) await hello(sockets[i]!, `c${i}`, undefined, i < 2 ? ["rowdiff", "ident"] : []);
    a.send({ t: "mut", mid: "seed", fn: "messages:seed", args: { channel: "x", n: 30 } });
    await a.waitFor(is("mres"));
    let before: any[] = [];
    for (let i = 0; i < sockets.length; i++) {
      sockets[i]!.send({ t: "sub", qid: i, fn: "messages:list", args: { channel: "x" } });
      before = (await sockets[i]!.waitFor<Snap>(is("snap"))).value as any[];
    }
    a.send({ t: "mut", mid: "add", fn: "messages:send", args: { channel: "x", body: "new", n: -9n, blob: new Uint8Array([1, 128]) } });
    const full = await sockets[2]!.waitFor<Patch>(is("patch"));
    const value = full.changes[0]!.value;
    const diff = rowDiff(before, value, stringify(value));
    expect(diff).toBeTruthy();
    for (let i = 0; i < 2; i++) {
      await sockets[i]!.waitFor<Patch>(is("patch"));
      sameFrame(sockets[i]!.raw, "patch", { t: "patch", version: 2, changes: [{ qid: i, diff: diff! }], mids: i === 0 ? ["add"] : [] });
    }
    sameFrame(sockets[2]!.raw, "patch", { t: "patch", version: 2, changes: [{ qid: 2, value }], mids: [] });
    await a.waitFor(is("mres"));
    for (const c of sockets) c.close();
  });
});
