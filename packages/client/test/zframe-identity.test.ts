// A compressed frame is decoded after the frames ahead of it, so it can be handled after an `auth` for someone else
// that the client sent meanwhile: the socket's `FrameQueue` hands each frame the tag it arrived with (who the socket
// ran as then), and the client drops the subscription deliveries of a frame that arrived as someone else.
import { describe, expect, it } from "vitest";
import { FrameQueue, withoutDeliveries } from "../src/zframe.ts";

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
    await new Promise((r) => setTimeout(r, 20));
    expect(got).toEqual([
      ["snap", "u:ana"],
      ["snap", "u:bob"],
    ]);
  });

  it("withoutDeliveries keeps everything but snap/patch (null when nothing is left)", () => {
    expect(withoutDeliveries(JSON.stringify({ t: "snap", qid: 1, value: 1 }))).toBeNull();
    expect(withoutDeliveries(JSON.stringify({ t: "patch", version: 2, changes: [] }))).toBeNull();
    const mres = JSON.stringify({ t: "mres", mid: "m1", ok: true });
    expect(withoutDeliveries(mres)).toBe(mres);
    expect(JSON.parse(withoutDeliveries(JSON.stringify([{ t: "patch", version: 2 }, { t: "mres", mid: "m1", ok: true }, { t: "qres", qid: 3, ok: true }]))!)).toEqual([
      { t: "mres", mid: "m1", ok: true },
      { t: "qres", qid: 3, ok: true },
    ]);
    expect(withoutDeliveries(JSON.stringify([{ t: "snap" }, { t: "patch" }]))).toBeNull();
  });
});
