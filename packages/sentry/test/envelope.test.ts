// The envelope parser against samples written by hand from the public spec (develop.sentry.dev/sdk/data-model/envelopes):
// several items, length-prefixed and newline-terminated payloads, binary attachments, gzip/deflate bodies, malformed ones.
import { describe, expect, it } from "vitest";
import { decodeBody, EnvelopeError, gzip, itemJson, parseEnvelope, readCapped, serializeEnvelope, utf8 } from "../src/envelope.ts";

const bytes = (s: string) => utf8.encode(s);
const text = (b: Uint8Array) => new TextDecoder("utf-8", { ignoreBOM: true }).decode(b);

describe("parseEnvelope", () => {
  it("two items with explicit lengths (an attachment with a BOM and CRLF, then an event), as in the spec", () => {
    const att = "﻿Hello\r\n";
    const ev = '{"message":"hello world","level":"error"}';
    const raw = [
      '{"event_id":"9ec79c33ec9942ab8353589fcb2e04dc","dsn":"https://e12d836b15bb49d7bbf99e64295d995b:@sentry.io/42"}',
      `{"type":"attachment","length":${bytes(att).length},"content_type":"text/plain","filename":"hello.txt"}`,
      att,
      `{"type":"event","length":${bytes(ev).length},"content_type":"application/json","filename":"application.log"}`,
      ev,
      "",
    ].join("\n");
    const env = parseEnvelope(bytes(raw));
    expect(env.header).toEqual({ event_id: "9ec79c33ec9942ab8353589fcb2e04dc", dsn: "https://e12d836b15bb49d7bbf99e64295d995b:@sentry.io/42" });
    expect(env.items.map((i) => i.header.type)).toEqual(["attachment", "event"]);
    expect(text(env.items[0]!.payload)).toBe(att);
    expect(itemJson(env.items[1]!)).toEqual({ message: "hello world", level: "error" });
  });

  it("implicit lengths: each payload runs to the next newline; the last may end the envelope without one", () => {
    const env = parseEnvelope(bytes('{"event_id":"9ec79c33ec9942ab8353589fcb2e04dc"}\n{"type":"attachment"}\nhelloworld\n{"type":"session"}\n{"sid":"s1","init":true}'));
    expect(env.items.map((i) => [i.header.type, text(i.payload)])).toEqual([
      ["attachment", "helloworld"],
      ["session", '{"sid":"s1","init":true}'],
    ]);
  });

  it("a length-prefixed payload may contain newlines and binary bytes", () => {
    const payload = new Uint8Array([0, 10, 255, 10, 13, 10]);
    const head = bytes('{}\n{"type":"attachment","length":6}\n');
    const env = parseEnvelope(new Uint8Array([...head, ...payload, ...bytes('\n{"type":"event"}\n{}\n')]));
    expect([...env.items[0]!.payload]).toEqual([...payload]);
    expect(env.items[1]!.header.type).toBe("event");
  });

  it("an envelope with only a header has no items; an item without payload has an empty one", () => {
    expect(parseEnvelope(bytes('{"event_id":"x"}')).items).toEqual([]);
    expect(parseEnvelope(bytes('{"event_id":"x"}\n')).items).toEqual([]);
    const env = parseEnvelope(bytes('{}\n{"type":"attachment","length":0}\n\n{"type":"client_report"}\n'));
    expect(env.items.map((i) => [i.header.type, i.payload.length])).toEqual([
      ["attachment", 0],
      ["client_report", 0],
    ]);
  });

  it("serializeEnvelope round-trips through the parser", () => {
    const raw = serializeEnvelope({ event_id: "abc" }, [
      { header: { type: "event" }, payload: { message: "multi\nline" } },
      { header: { type: "attachment", filename: "a.bin" }, payload: new Uint8Array([1, 10, 2]) },
    ]);
    const env = parseEnvelope(raw);
    expect(itemJson(env.items[0]!)).toEqual({ message: "multi\nline" });
    expect([...env.items[1]!.payload]).toEqual([1, 10, 2]);
  });

  it.each([
    ["empty", ""],
    ["header is not JSON", "nope\n"],
    ["header is an array", "[1]\n"],
    ["item header is not JSON", "{}\n{oops\n"],
    ["item without type", '{}\n{"length":2}\nab\n'],
    ["negative length", '{}\n{"type":"event","length":-1}\n'],
    ["payload shorter than length", '{}\n{"type":"event","length":50}\n{}\n'],
    ["payload longer than length", '{}\n{"type":"event","length":2}\n{}x\n'],
  ])("malformed: %s", (_name, raw) => {
    expect(() => parseEnvelope(bytes(raw))).toThrowError(EnvelopeError);
    try {
      parseEnvelope(bytes(raw));
    } catch (e) {
      expect((e as EnvelopeError).reason).toBe("malformed");
    }
  });
});

describe("bodies", () => {
  const raw = bytes('{"event_id":"e1"}\n{"type":"event"}\n{"message":"zipped"}\n');

  it("gzip and deflate (zlib and raw) bodies are decoded", async () => {
    expect(text(await decodeBody(await gzip(raw), "gzip", 1 << 20))).toBe(text(raw));
    const zlib = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer());
    expect(text(await decodeBody(zlib, "deflate", 1 << 20))).toBe(text(raw));
    const rawDeflate = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer());
    expect(text(await decodeBody(rawDeflate, "deflate", 1 << 20))).toBe(text(raw));
    expect(await decodeBody(raw, null, 10)).toBe(raw);
  });

  it("a zip bomb is too large after decompression; garbage is malformed; brotli is unsupported", async () => {
    const big = await gzip(new Uint8Array(1 << 20));
    expect(big.length).toBeLessThan(10_000);
    await expect(decodeBody(big, "gzip", 64 * 1024)).rejects.toMatchObject({ reason: "too_large" });
    await expect(decodeBody(bytes("not gzip"), "gzip", 1 << 20)).rejects.toMatchObject({ reason: "malformed" });
    await expect(decodeBody(raw, "br", 1 << 20)).rejects.toMatchObject({ reason: "unsupported" });
  });

  it("readCapped stops at the cap", async () => {
    await expect(readCapped(new Blob([new Uint8Array(100)]).stream(), 99)).rejects.toMatchObject({ reason: "too_large" });
    expect((await readCapped(new Blob([new Uint8Array(100)]).stream(), 100)).length).toBe(100);
  });
});
