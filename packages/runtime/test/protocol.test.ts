import { describe, expect, it } from "vitest";
import { decodeClientMessage, decodeServerMessage, encodeServerMessage, ProtocolError } from "../src/protocol.ts";

const dec = (m: unknown) => decodeClientMessage(typeof m === "string" ? m : JSON.stringify(m));
const code = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return e instanceof ProtocolError ? e.code : `not-protocol:${String(e)}`;
  }
  return "no-error";
};

describe("protocol v1 codec", () => {
  it("decodes every client frame", () => {
    expect(dec({ t: "hello", clientId: "c1", protocol: 1 })).toEqual({ t: "hello", clientId: "c1", protocol: 1 });
    expect(dec({ t: "hello", clientId: "c1", protocol: 1, token: "x" })).toMatchObject({ token: "x" });
    expect(dec({ t: "sub", qid: 1, fn: "a:b", args: {}, resume: { version: 3, epoch: "e" } })).toEqual({
      t: "sub", qid: 1, fn: "a:b", args: {}, resume: { version: 3, epoch: "e" },
    });
    expect(dec({ t: "unsub", qid: "q" })).toEqual({ t: "unsub", qid: "q" });
    expect(dec({ t: "mut", mid: 7, fn: "f", args: { n: { $int64: "9007199254740993" }, f: { $float: "NaN" } } })).toEqual({
      t: "mut", mid: 7, fn: "f", args: { n: 9007199254740993n, f: NaN },
    });
    expect(dec({ t: "auth", token: "t" })).toEqual({ t: "auth", token: "t" });
    expect(dec({ t: "auth", token: null })).toEqual({ t: "auth", token: null });
  });

  it("rejects malformed frames strictly", () => {
    expect(code(() => dec("not json"))).toBe("bad_frame");
    expect(code(() => dec([1]))).toBe("bad_frame");
    expect(code(() => dec({ t: "nope" }))).toBe("bad_frame");
    expect(code(() => dec({ t: "hello", clientId: "c", protocol: 2 }))).toBe("unsupported_protocol");
    expect(code(() => dec({ t: "hello", clientId: "", protocol: 1 }))).toBe("bad_frame");
    expect(code(() => dec({ t: "unsub", qid: "q", extra: 1 }))).toBe("bad_frame");
    expect(code(() => dec({ t: "sub", qid: -1, fn: "f", args: {} }))).toBe("bad_frame");
    expect(code(() => dec({ t: "sub", qid: 1.5, fn: "f", args: {} }))).toBe("bad_frame");
    expect(code(() => dec({ t: "sub", qid: 1, fn: "f", args: [] }))).toBe("bad_frame");
    expect(code(() => dec({ t: "sub", qid: 1, fn: "f", args: {}, resume: { version: 1 } }))).toBe("bad_frame");
    expect(code(() => dec({ t: "mut", mid: 1, fn: "f" }))).toBe("bad_frame");
    expect(code(() => dec({ t: "auth", token: 5 }))).toBe("bad_frame");
    expect(code(() => dec({ t: "auth" }))).toBe("bad_frame");
    // A tagged value is not an object: neither a frame nor args.
    expect(code(() => dec({ $int64: "1" }))).toBe("bad_frame");
    expect(code(() => dec({ t: "mut", mid: 1, fn: "f", args: { $bytes: "AQ==" } }))).toBe("bad_frame");
    expect(code(() => decodeClientMessage(new ArrayBuffer(2)))).toBe("bad_frame");
    expect(code(() => decodeClientMessage(`"${"x".repeat((1 << 20) + 1)}"`))).toBe("frame_too_large");
  });

  it("round-trips server frames with @ember/values tags (int64, bytes, float)", () => {
    const value = { n: 5n, b: new Uint8Array([1, 2, 255]), f: -Infinity, z: -0 };
    const frame = encodeServerMessage({ t: "patch", version: 2, changes: [{ qid: 1, value }], mids: ["m1", 2] });
    expect(JSON.parse(frame).changes[0].value).toEqual({ n: { $int64: "5" }, b: { $bytes: "AQL/" }, f: { $float: "-Infinity" }, z: { $float: "-0" } });
    expect(decodeServerMessage(frame)).toEqual({ t: "patch", version: 2, changes: [{ qid: 1, value }], mids: ["m1", 2] });
    expect(JSON.parse(encodeServerMessage({ t: "authExpired" }))).toEqual({ t: "authExpired" });
  });
});
