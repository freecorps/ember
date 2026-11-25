// The Worker's public body-reading routes read at most `MAX_HTTP_BODY_BYTES` (the WebSocket frame limit) of a body,
// in bytes, before the token is checked: a `content-length` above it is refused unread, and a streamed body is cut off
// (and cancelled) as soon as it passes the limit (CWE-770).
import { createExecutionContext, env } from "cloudflare:test";
import { afterAll, describe, expect, it } from "vitest";
import { getEmberConfig, setEmberConfig } from "../src/config.ts";
import { MAX_STORAGE_JSON_BYTES } from "../src/files.ts";
import { MAX_FRAME_BYTES } from "../src/protocol.ts";
import { createEmberWorker, MAX_HTTP_BODY_BYTES } from "../src/worker.ts";
import { probes, input as config } from "./worker.ts";

const original = getEmberConfig();
afterAll(() => setEmberConfig(original));

const LIMIT = 1024 * 1024;
const CHUNK = 64 * 1024;
const enc = new TextEncoder();

/** A body with no `content-length`, pulled chunk by chunk; `pulled` counts what the Worker read of it. */
function streamed(chunks: Iterable<Uint8Array>) {
  const it = chunks[Symbol.iterator]();
  const stats = { pulled: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>(
    {
      pull(c) {
        const n = it.next();
        if (n.done) return c.close();
        stats.pulled += n.value.byteLength;
        c.enqueue(n.value);
      },
      cancel() {
        stats.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { body, stats };
}

function* endless() {
  for (;;) yield new Uint8Array(CHUNK).fill(0x20);
}
const split = (b: Uint8Array) => Array.from({ length: Math.ceil(b.byteLength / CHUNK) }, (_, i) => b.subarray(i * CHUNK, (i + 1) * CHUNK));
/** `value` as JSON, padded with JSON whitespace to exactly `bytes` bytes of UTF-8. */
const padded = (value: unknown, bytes: number) => {
  const b = enc.encode(JSON.stringify(value));
  const out = new Uint8Array(bytes).fill(0x20);
  out.set(b);
  return out;
};

/** Each public JSON route, with a body it answers normally (and the status of that answer), and one carrying `s` (`big`, else `ok`). */
const routes: Array<{ path: string; ok: (s: string) => unknown; big?: (s: string) => unknown; status: number }> = [
  { path: "/api/query", ok: (s) => ({ fn: "messages:list", args: { channel: s }, shard: "limits:q" }), status: 200 },
  { path: "/api/mutation", ok: (s) => ({ fn: "misc:echo", args: { s }, shard: "limits:m" }), status: 200 },
  { path: "/api/action", ok: () => ({ fn: "actions:ping", args: {}, shard: "limits:a" }), big: (s) => ({ fn: "actions:ping", args: { pad: s }, shard: "limits:a" }), status: 200 },
  { path: "/api/query/messages:list?shard=limits:q", ok: (s) => ({ channel: s }), status: 200 },
  { path: "/api/mutation/misc:echo?shard=limits:m", ok: (s) => ({ s }), status: 200 },
  { path: "/api/action/actions:ping?shard=limits:a", ok: () => ({}), big: (s) => ({ pad: s }), status: 200 },
];

describe("request body limits", () => {
  const worker = createEmberWorker(config);
  const send = async (path: string, body: BodyInit, token?: string) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    const req = new Request(`http://ember${path}`, { method: "POST", headers, body });
    const res = await worker.fetch(req, env as never, createExecutionContext());
    return { status: res.status, body: (await res.json()) as { ok: boolean; error?: { code: string } } };
  };

  it("is the WebSocket frame limit, 1 MiB", () => {
    expect(MAX_HTTP_BODY_BYTES).toBe(MAX_FRAME_BYTES);
    expect(MAX_HTTP_BODY_BYTES).toBe(LIMIT);
    expect(MAX_STORAGE_JSON_BYTES).toBe(LIMIT);
  });

  for (const route of routes) {
    describe(route.path, () => {
      it("refuses an endless body without content-length, having read at most the limit and a couple of chunks", async () => {
        const big = streamed(endless());
        const r = await send(route.path, big.body);
        expect(r.status).toBe(413);
        expect(r.body).toMatchObject({ ok: false, error: { code: "too_large" } });
        expect(big.stats.pulled).toBeLessThanOrEqual(LIMIT + 2 * CHUNK);
        expect(big.stats.cancelled).toBe(true);
      });

      it("counts UTF-8 bytes, not string length (multibyte, streamed and declared)", async () => {
        // 600 000 "é" are 1.2 MB of UTF-8 but 600 000 UTF-16 units.
        const text = JSON.stringify((route.big ?? route.ok)("é".repeat(600_000)));
        const multibyte = enc.encode(text);
        expect(multibyte.byteLength).toBeGreaterThan(LIMIT);
        expect(text.length).toBeLessThan(LIMIT);
        const s = streamed(split(multibyte));
        const r1 = await send(route.path, s.body);
        expect(r1.status).toBe(413);
        expect(r1.body.error?.code).toBe("too_large");
        expect(s.stats.pulled).toBeLessThanOrEqual(LIMIT + 2 * CHUNK);
        // With a content-length: refused before reading.
        const r2 = await send(route.path, multibyte);
        expect(r2.status).toBe(413);
        expect(r2.body.error?.code).toBe("too_large");
      });

      it("answers a body under the limit as usual (multibyte, streamed, and one of exactly the limit)", async () => {
        const small = streamed(split(enc.encode(JSON.stringify(route.ok("é".repeat(1000))))));
        const r1 = await send(route.path, small.body);
        expect(r1.status).toBe(route.status);
        expect(r1.body.ok).toBe(true);
        const exact = padded(route.ok("é"), LIMIT);
        const r2 = await send(route.path, streamed(split(exact)).body);
        expect(r2.status).toBe(route.status);
        expect(r2.body.ok).toBe(true);
        const r3 = await send(route.path, exact);
        expect(r3.status).toBe(route.status);
        // One byte over: refused.
        expect((await send(route.path, padded(route.ok("é"), LIMIT + 1))).status).toBe(413);
      });

      it("refuses an oversized body of an unauthenticated caller before the token is looked at, without buffering it", async () => {
        const token = `bad:limits-${route.path}`;
        const big = streamed(endless());
        const r = await send(route.path, big.body, token);
        expect(r.status).toBe(413);
        expect(big.stats.pulled).toBeLessThanOrEqual(LIMIT + 2 * CHUNK);
        expect(big.stats.cancelled).toBe(true);
        expect(probes.verifyWaitUntil.some((v) => v.token === token)).toBe(false);
        // The same caller with a small body: the token is checked (and refused).
        expect((await send(route.path, JSON.stringify(route.ok("x")), token)).status).toBe(401);
      });
    });
  }

  for (const path of ["/api/storage/multipart", "/api/storage/confirm"]) {
    it(`${path}: bounded the same way`, async () => {
      const big = streamed(endless());
      const r1 = await send(path, big.body);
      expect(r1.status).toBe(413);
      expect(r1.body.error?.code).toBe("too_large");
      expect(big.stats.pulled).toBeLessThanOrEqual(LIMIT + 2 * CHUNK);
      expect(big.stats.cancelled).toBe(true);
      const multibyte = enc.encode(JSON.stringify({ shard: "limits:f", storageId: "é".repeat(600_000), token: "t" }));
      expect((await send(path, streamed(split(multibyte)).body)).status).toBe(413);
      expect((await send(path, multibyte)).status).toBe(413);
      // Under the limit: read and answered (an unknown upload).
      const small = await send(path, streamed(split(enc.encode(JSON.stringify({ shard: "limits:f", storageId: "é".repeat(1000), token: "t" })))).body);
      expect(small.status).toBe(404);
    });
  }
});
