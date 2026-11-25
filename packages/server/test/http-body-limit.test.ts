// Typed HTTP routes read at most `MAX_HTTP_BODY_BYTES` (1 MiB, as /api/query|mutation|action) of a body: 413
// `too_large` before the handler runs, a `content-length` over it unread, a body without one while reading.
import { describe, expect, it } from "vitest";
import { MAX_HTTP_BODY_BYTES, httpRouter, readLimited, v, type ActionCtx } from "../src/index.ts";

const ctx = {} as ActionCtx;

function route(maxBodyBytes?: number) {
  const ran: unknown[] = [];
  const r = httpRouter().route({
    method: "POST",
    path: "/notes",
    body: { text: v.string() },
    ...(maxBodyBytes === undefined ? {} : { maxBodyBytes }),
    handler: (_ctx, { body }) => {
      ran.push(body);
      return { length: body.text.length };
    },
  }).routes[0]!;
  return { call: (req: Request) => r.handler.handler(ctx, req) as Promise<Response>, ran };
}

/** A body streamed in chunks, with no `content-length`; counts what was pulled. */
function streamed(total: number, chunk = 64 * 1024) {
  const pulled = { bytes: 0, cancelled: false };
  const enc = new TextEncoder();
  const head = enc.encode('{"text":"');
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (sent === 0) {
        sent += head.byteLength;
        pulled.bytes += head.byteLength;
        return c.enqueue(head);
      }
      if (sent >= total) {
        c.enqueue(enc.encode('"}'));
        return c.close();
      }
      const n = Math.min(chunk, total - sent);
      sent += n;
      pulled.bytes += n;
      c.enqueue(new Uint8Array(n).fill(0x61));
    },
    cancel() {
      pulled.cancelled = true;
    },
  });
  return { body, pulled };
}

describe("typed routes: bounded bodies", () => {
  it("is the limit of the Worker's API calls (1 MiB)", () => {
    expect(MAX_HTTP_BODY_BYTES).toBe(1 << 20);
  });

  it("a body within the limit reaches the handler", async () => {
    const { call, ran } = route();
    const text = "a".repeat(MAX_HTTP_BODY_BYTES - 20);
    const res = await call(new Request("http://x/notes", { method: "POST", body: JSON.stringify({ text }) }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ length: text.length });
    expect(ran).toHaveLength(1);
  });

  it("a content-length over the limit: 413 too_large, the body is never read, the handler never runs", async () => {
    const { call, ran } = route();
    const { body, pulled } = streamed(8 * MAX_HTTP_BODY_BYTES);
    const res = await call(new Request("http://x/notes", { method: "POST", body, headers: { "content-length": String(8 * MAX_HTTP_BODY_BYTES) }, duplex: "half" } as RequestInit));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: { code: "too_large", message: `the request body is at most ${MAX_HTTP_BODY_BYTES} bytes` } });
    expect(ran).toHaveLength(0);
    expect(pulled.bytes).toBeLessThan(MAX_HTTP_BODY_BYTES);
  });

  it("no content-length (streamed): read up to the limit only, then cancelled", async () => {
    const { call, ran } = route();
    const { body, pulled } = streamed(16 * MAX_HTTP_BODY_BYTES);
    const res = await call(new Request("http://x/notes", { method: "POST", body, duplex: "half" } as RequestInit));
    expect(res.status).toBe(413);
    expect(ran).toHaveLength(0);
    expect(pulled.bytes).toBeLessThanOrEqual(MAX_HTTP_BODY_BYTES + 2 * 64 * 1024);
    expect(pulled.cancelled).toBe(true);
  });

  it("counts bytes, not characters; a route may set its own limit", async () => {
    const { call } = route(100);
    // 40 characters, 120 bytes in UTF-8.
    const res = await call(new Request("http://x/notes", { method: "POST", body: JSON.stringify({ text: "€".repeat(40) }) }));
    expect(res.status).toBe(413);
    expect((await call(new Request("http://x/notes", { method: "POST", body: JSON.stringify({ text: "ok" }) }))).status).toBe(200);
    expect(() => route(-1)).toThrow(/maxBodyBytes/);
  });

  it("readLimited stops at the limit", async () => {
    expect(await readLimited(new Response("abcdef").body, 5)).toBeNull();
    expect(new TextDecoder().decode((await readLimited(new Response("abcde").body, 5))!)).toBe("abcde");
  });
});
