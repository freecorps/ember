// A compressed frame is decoded after the frames ahead of it, so it can be handled after an `auth` for someone else
// that the client sent meanwhile: the socket's `FrameQueue` hands each frame the tag it arrived with (who the socket
// ran as then), and the client drops the subscription deliveries of a frame that arrived as someone else.
import { describe, expect, it } from "vitest";
import { FrameQueue, withoutStale } from "../src/zframe.ts";

const deflate = async (text: string): Promise<ArrayBuffer> => {
  const cs = new CompressionStream("deflate-raw");
  const w = cs.writable.getWriter();
  void w.write(new TextEncoder().encode(text));
  void w.close();
  return await new Response(cs.readable).arrayBuffer();
};

describe("zframe: frames keep the identity they arrived under", () => {
  it("a binary frame decoded after the tag changed is handled with the tag it was pushed with, in order", async () => {
    const got: Array<[string, string]> = [];
    let tag = "u:ana";
    const q = new FrameQueue<string>((text, arrivedAs) => got.push([JSON.parse(text).t as string, arrivedAs]), () => {});
    const z = await deflate(JSON.stringify({ t: "snap", qid: 1, value: "ana's" }));
    q.push(z, tag);
    // The client sends `auth` for bob while the frame decodes; the frames after it arrive as bob.
    tag = "u:bob";
    q.push(JSON.stringify({ t: "snap", qid: 1, value: "bob's" }), tag);
    // The binary frame decodes asynchronously (a slow runner takes longer): wait for both, with a ceiling.
    for (let i = 0; i < 500 && got.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
    expect(got).toEqual([
      ["snap", "u:ana"],
      ["snap", "u:bob"],
    ]);
  });

  it("withoutStale drops snap/patch and channel traffic, naming the channels whose member list went (null when nothing is left)", () => {
    expect(withoutStale(JSON.stringify({ t: "snap", qid: 1, value: 1 }))).toEqual({ text: null, channels: [] });
    expect(withoutStale(JSON.stringify({ t: "patch", version: 2, changes: [] }))).toEqual({ text: null, channels: [] });
    const mres = JSON.stringify({ t: "mres", mid: "m1", ok: true });
    expect(withoutStale(mres)).toEqual({ text: mres, channels: [] });
    expect(JSON.parse(withoutStale(JSON.stringify([{ t: "patch", version: 2 }, { t: "mres", mid: "m1", ok: true }, { t: "qres", qid: 3, ok: true }])).text!)).toEqual([
      { t: "mres", mid: "m1", ok: true },
      { t: "qres", qid: 3, ok: true },
    ]);
    expect(withoutStale(JSON.stringify([{ t: "snap" }, { t: "patch" }])).text).toBeNull();
    // Channel frames of the identity before: its messages and member lists go; what only drives the join stays.
    const left = { t: "left", ch: "room:b", code: "channel_denied", message: "no" };
    const err = { t: "err", code: "rate_limited", message: "slow", ch: "room:a" };
    const published = { t: "published", ch: "room:a", ref: 3 };
    const out = withoutStale(
      JSON.stringify([
        { t: "msg", ch: "room:a", from: "x", user: "ana", data: "secret" },
        { t: "members", ch: "room:a", join: [{ id: "y", user: "bia" }] },
        { t: "joined", ch: "room:c", self: "x", members: [{ id: "x", user: "ana" }] },
        left,
        err,
        published,
      ]),
    );
    expect(JSON.parse(out.text!)).toEqual([left, err, published]);
    expect(out.channels.sort()).toEqual(["room:a", "room:c"]);
    expect(withoutStale(JSON.stringify({ t: "msg", ch: "room:a", from: "x", user: "ana", data: 1 }))).toEqual({ text: null, channels: [] });
  });
});
