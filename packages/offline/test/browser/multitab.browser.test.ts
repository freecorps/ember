// Option `multiTab` of @freecorps/ember-client in a real browser (headless Chromium through playwright-core; reuses an
// installed Playwright browser, skipped when there is none; EMBER_REQUIRE_BROWSER=1 makes a missing one fail). Real tabs
// of one origin, with the browser's own WebSocket, BroadcastChannel and Web Locks, against one server (a
// FakeEmberServer behind a minimal WebSocket bridge in Node, so the test sees every real socket):
//   three tabs, two identities → two sockets, both held by the leader; a follower's mutation reaches everyone;
//   a follower switches account → it moves to the other identity's socket, never shows the old identity's values,
//   and the shared socket never carries its sign-in; the leader tab closes while a follower's mutation is unanswered
//   → the next tab leads, the mutation is resent and runs exactly once.
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Duplex } from "node:stream";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeEmberServer, type FakeSocket } from "@freecorps/ember-client/testing";

const here = dirname(fileURLToPath(import.meta.url));
const executable = (() => {
  try {
    return chromium.executablePath();
  } catch {
    return "";
  }
})();
const hasBrowser = !!executable && existsSync(executable);
if (!hasBrowser && process.env.EMBER_REQUIRE_BROWSER === "1") {
  throw new Error(`EMBER_REQUIRE_BROWSER is set but playwright-core finds no Chromium (${executable || "no executable path"}); run \`npx playwright-core install chromium\``);
}

const SHARD = "org:acme";

/** RFC 6455, just enough for a browser client: text frames (masked, maybe fragmented), ping, close. */
function acceptWebSocket(req: IncomingMessage, socket: Duplex, onText: (text: string) => void, onClose: () => void) {
  const accept = createHash("sha1")
    .update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  let buf = Buffer.alloc(0);
  let parts: Buffer[] = [];
  let closed = false;
  const frame = (op: number, payload: Buffer) => {
    const n = payload.length;
    const head = n < 126 ? Buffer.from([0x80 | op, n]) : n < 65536 ? Buffer.from([0x80 | op, 126, n >> 8, n & 255]) : Buffer.concat([Buffer.from([0x80 | op, 127]), (() => {
      const b = Buffer.alloc(8);
      b.writeBigUInt64BE(BigInt(n));
      return b;
    })()]);
    if (!closed) socket.write(Buffer.concat([head, payload]));
  };
  const end = () => {
    if (closed) return;
    closed = true;
    socket.end();
    onClose();
  };
  socket.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = (buf[0]! & 0x80) !== 0;
      const op = buf[0]! & 0x0f;
      const masked = (buf[1]! & 0x80) !== 0;
      let len = buf[1]! & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      const mask = masked ? buf.subarray(off, off + 4) : null;
      if (masked) off += 4;
      if (buf.length < off + len) return;
      const payload = Buffer.from(buf.subarray(off, off + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i]! ^= mask[i & 3]!;
      buf = buf.subarray(off + len);
      if (op === 8) {
        frame(8, Buffer.alloc(0));
        return end();
      }
      if (op === 9) frame(10, payload);
      else if (op === 1 || op === 0) {
        parts.push(payload);
        if (fin) {
          const text = Buffer.concat(parts).toString("utf8");
          parts = [];
          onText(text);
        }
      }
    }
  });
  socket.on("close", end);
  socket.on("error", end);
  return { send: (text: string) => frame(1, Buffer.from(text, "utf8")), close: () => (frame(8, Buffer.alloc(0)), end()) };
}

describe.skipIf(!hasBrowser)("multiTab: one socket per shard across real tabs (Chromium)", () => {
  let dir = "";
  let http: Server;
  let browser: Browser;
  let origin = "";
  let server: FakeEmberServer;
  /** Real sockets the browser opened (one FakeSocket each, on the fake server). */
  let opened = 0;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "ember-multitab-e2e-"));
    await build({
      entryPoints: { page: join(here, "multitab-page.ts") },
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      outdir: dir,
      conditions: ["@freecorps/ember-source", "browser", "import"],
      logLevel: "error",
    });
    writeFileSync(join(dir, "index.html"), `<!doctype html><meta charset="utf-8"><script type="module" src="./page.js"></script>`);
    server = new FakeEmberServer({
      queries: {
        "messages:list": (db, { channel }) => db.where<{ body: string }>("messages", "channel", channel).map((m) => m.body),
        "users:me": (_db, _args, ctx) => ctx.identity?.subject ?? null,
      },
      mutations: { "messages:send": (db, { channel, body }) => db.insert("messages", { channel, body }) },
    });
    const types: Record<string, string> = { ".js": "text/javascript", ".html": "text/html" };
    http = createServer((rq, rs) => {
      const file = join(dir, new URL(rq.url ?? "/", "http://x").pathname.replace(/^\/$/, "/index.html"));
      if (!file.startsWith(dir) || !existsSync(file)) return void rs.writeHead(404).end();
      rs.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
    });
    // Each browser WebSocket becomes one client socket of the fake server, frames piped both ways.
    http.on("upgrade", (req, socket) => {
      opened++;
      const fake = new server.WebSocket(`ws://x${req.url}`) as FakeSocket;
      const early: string[] = [];
      const ws = acceptWebSocket(
        req,
        socket,
        (text) => (fake.readyState === 1 ? fake.send(text) : early.push(text)),
        () => fake.close(),
      );
      fake.onopen = () => {
        for (const t of early.splice(0)) fake.send(t);
      };
      fake.onmessage = (ev) => ws.send(String(ev.data));
      fake.onclose = () => ws.close();
    });
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
    origin = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
    browser = await chromium.launch({ headless: true });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    http?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const open = async (ctx: BrowserContext, name: string, token: string | null) => {
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    await page.goto(`${origin}/`);
    await page.waitForFunction(() => !!(globalThis as any).t);
    await page.evaluate((o) => (globalThis as any).t.start(o), { url: origin, token, name });
    await page.evaluate(() => {
      const t = (globalThis as any).t;
      t.sub("list", "messages:list", { channel: "g" });
      t.sub("me", "users:me", {});
    });
    return { page, errors };
  };
  const value = (p: Page, key: string) => p.evaluate((k) => (globalThis as any).t.value(k), key);
  const waitFor = (p: Page, f: string, timeout = 10_000) => p.waitForFunction(new Function(`const t = globalThis.t; return ${f};`) as () => boolean, undefined, { timeout });
  const sockets = () => server.open(SHARD);

  it("shares sockets per identity, keeps account switches apart, and hands over a pending mutation exactly once", async () => {
    const ctx = await browser.newContext();
    const name = `mt-${Date.now()}`;
    const a = await open(ctx, name, "user:alice");
    await waitFor(a.page, `t.role() === "leader"`);
    const b = await open(ctx, name, "user:alice");
    const c = await open(ctx, name, "user:bob");
    for (const x of [a, b, c]) await waitFor(x.page, `t.value("list") !== undefined && t.value("me") !== undefined`);
    expect([await value(a.page, "me"), await value(b.page, "me"), await value(c.page, "me")]).toEqual(["alice", "alice", "bob"]);
    expect(await b.page.evaluate(() => (globalThis as any).t.role())).toBe("follower");
    // Three tabs, two identities: two sockets, both the leader's.
    expect(opened).toBe(2);
    expect(sockets().map((s) => s.identity?.subject).sort()).toEqual(["alice", "bob"]);
    expect(await b.page.evaluate(() => (globalThis as any).t.clientId())).toBe(await a.page.evaluate(() => (globalThis as any).t.clientId()));

    await b.page.evaluate(() => (globalThis as any).t.mutate("messages:send", { channel: "g", body: "from b" }));
    for (const x of [a, b, c]) await waitFor(x.page, `(t.value("list") ?? []).includes("from b")`);

    // b switches to bob: only bob's values from then on; alice's shared socket never carries the sign-in.
    const alice = sockets().find((s) => s.identity?.subject === "alice")!;
    const from = await b.page.evaluate(() => (globalThis as any).t.count("me"));
    await b.page.evaluate(() => (globalThis as any).t.signIn("user:bob"));
    await waitFor(b.page, `t.value("me") === "bob"`);
    const shown = (await b.page.evaluate((f) => (globalThis as any).t.values("me", f), from)) as unknown[];
    expect(shown.filter((v) => v !== null && v !== "bob")).toEqual([]);
    expect(alice.sent.filter((m) => m !== "ping" && m.t === "auth")).toHaveLength(0);
    expect(await value(a.page, "me")).toBe("alice");
    expect(opened).toBe(2); // b joined bob's socket

    // The leader's tab closes while b's mutation sits unanswered on the shared bob socket.
    const bob = sockets().find((s) => s.identity?.subject === "bob")!;
    bob.holdIncoming();
    const runs = server.executions;
    await b.page.evaluate(() => (globalThis as any).t.mutate("messages:send", { channel: "g", body: "survives" }));
    await expect.poll(() => (bob.heldIncoming ?? []).some((f) => f.includes('"mut"')), { timeout: 10_000 }).toBe(true);
    await a.page.close();
    await Promise.race([waitFor(b.page, `t.role() === "leader"`), waitFor(c.page, `t.role() === "leader"`)]);
    await waitFor(b.page, `t.results.length === 2 && t.pending() === 0`);
    for (const x of [b, c]) await waitFor(x.page, `(t.value("list") ?? []).includes("survives")`);
    expect(server.executions - runs).toBe(1);
    expect(server.rows(SHARD, "messages").filter((r) => r.body === "survives")).toHaveLength(1);
    // One socket left, for bob's two tabs.
    await expect.poll(() => sockets().length, { timeout: 10_000 }).toBe(1);
    expect([...a.errors, ...b.errors, ...c.errors]).toEqual([]);
    console.log(`[browser] ${await b.page.evaluate(() => navigator.userAgent)}\n  multiTab: ${opened} sockets opened for 3 tabs (2 identities, 1 handover)`);
    await ctx.close();
  }, 60_000);
});
