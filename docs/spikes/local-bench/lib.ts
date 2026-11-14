// Shared pieces of the round-2 harnesses (pagination.ts, reopen.ts): a project built like `ember deploy` running in
// Miniflare, the latency proxy of first-data.ts, and a WebSocket wrapper that counts what a client sends and receives.
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { transform } from "esbuild";
import { Miniflare } from "../../../packages/cli/node_modules/miniflare/dist/src/index.js";
import { loadProject } from "../../../packages/cli/src/config.ts";
import { init } from "../../../packages/cli/src/init.ts";
import { buildWorker } from "../../../packages/cli/src/build.ts";
import { miniflareOptions } from "../../../packages/cli/src/local.ts";
import { codegen } from "../../../packages/cli/src/codegen/index.ts";
import type { WebSocketConstructor, WebSocketLike } from "../../../packages/client/src/index.ts";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

export function sayTo(out: string | undefined) {
  return (s: string) => {
    console.log(s);
    if (out) appendFileSync(out, s + "\n");
  };
}

// Signed-in sockets: the token "u:<subject>" is the identity (stands in for a verified JWT).
const AUTH = `const auth = { verify: (t) => (typeof t === "string" && t.startsWith("u:") ? { subject: t.slice(2), issuer: "bench" } : null) };`;

/** Builds `files` (paths under `ember/`) into a Worker (minified, no keepNames) and starts it in Miniflare. */
export async function startProject(name: string, files: Record<string, string>, vars: Record<string, string> = {}) {
  const root = join(import.meta.dir, `../../../packages/cli/.tmp/ember-${name}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  init({ dir: root, project: name, auth: false });
  for (const f of ["messages.ts", "crons.ts"]) rmSync(join(root, "ember", f), { force: true });
  for (const [f, src] of Object.entries(files)) writeFileSync(join(root, "ember", f), src);
  const project = loadProject(root);
  await codegen(project);
  const build = await buildWorker(project, { minify: false });
  const patched = build.code.replace(/(const|var|let) auth = (undefined|void 0);/, AUTH);
  if (patched === build.code) throw new Error("could not install the bench auth hook");
  build.code = (await transform(patched, { minify: true, format: "esm", target: "es2022" })).code;
  const mf = new Miniflare(miniflareOptions(project, build, { persist: false, vars: { EMBER_ADMIN_TOKEN: "bench-admin", ...vars } }) as never);
  const origin = new URL((await mf.ready).href);
  return { mf, origin, url: origin.href.replace(/\/$/, "") };
}

/**
 * TCP proxy of first-data.ts: every chunk waits RTT/2 in each direction; a new connection carries data after
 * EDGE_MS × 2 (TCP + TLS at a nearby edge).
 */
export function latencyProxy(origin: URL, rtt: number, edgeMs: number) {
  type D = { peer?: import("bun").Socket<unknown>; ready: boolean; queue: Uint8Array[] };
  const proxy = Bun.listen<D>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(client) {
        client.data = { ready: false, queue: [] };
        void Bun.connect({
          hostname: origin.hostname,
          port: Number(origin.port),
          socket: {
            open(server) {
              client.data.peer = server;
              setTimeout(() => {
                client.data.ready = true;
                for (const q of client.data.queue) setTimeout(() => server.write(q), rtt / 2);
                client.data.queue = [];
              }, edgeMs * 2);
            },
            data(_server, chunk) {
              const copy = new Uint8Array(chunk);
              setTimeout(() => client.write(copy), rtt / 2);
            },
            close() {
              setTimeout(() => client.end(), rtt / 2);
            },
            error() {},
          },
        });
      },
      data(client, chunk) {
        const copy = new Uint8Array(chunk);
        if (!client.data.ready || !client.data.peer) client.data.queue.push(copy);
        else setTimeout(() => client.data.peer!.write(copy), rtt / 2);
      },
      close(client) {
        setTimeout(() => client.data.peer?.end(), rtt / 2);
      },
      error() {},
    },
  });
  return { url: `http://127.0.0.1:${proxy.port}`, stop: () => proxy.stop(true) };
}

export type Traffic = {
  /** Client → server messages by type (`sub`, `unsub`, `mut`, ...), batch frames unpacked. */
  sent: Map<string, number>;
  /** Server → client messages by type; `snap` = full snapshots, `unchanged` = resume answers. */
  received: Map<string, number>;
  bytesIn: number;
  bytesOut: number;
  /** Every received message, with the time it arrived. */
  log: Array<{ at: number; m: Record<string, unknown> }>;
  reset(): void;
};

/** A WebSocket constructor for EmberClient that counts the traffic of every socket it opens. */
export function countingWebSocket(): { WebSocket: WebSocketConstructor; traffic: Traffic } {
  const traffic: Traffic = {
    sent: new Map(),
    received: new Map(),
    bytesIn: 0,
    bytesOut: 0,
    log: [],
    reset() {
      this.sent.clear();
      this.received.clear();
      this.bytesIn = 0;
      this.bytesOut = 0;
      this.log = [];
    },
  };
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  class Counting implements WebSocketLike {
    private readonly ws: WebSocket;
    onopen: ((ev: unknown) => void) | null = null;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onclose: ((ev: unknown) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    constructor(url: string) {
      this.ws = new WebSocket(url);
      this.ws.onopen = (e) => this.onopen?.(e);
      this.ws.onclose = (e) => this.onclose?.(e);
      this.ws.onerror = (e) => this.onerror?.(e);
      this.ws.onmessage = (e) => {
        const data = String(e.data);
        traffic.bytesIn += data.length;
        if (data !== "pong") {
          const parsed = JSON.parse(data) as Record<string, unknown> | Array<Record<string, unknown>>;
          const at = performance.now();
          for (const m of Array.isArray(parsed) ? parsed : [parsed]) {
            bump(traffic.received, m.t === "snap" && m.unchanged ? "unchanged" : String(m.t));
            traffic.log.push({ at, m });
          }
        }
        this.onmessage?.({ data: e.data });
      };
    }
    get readyState() {
      return this.ws.readyState;
    }
    send(data: string) {
      traffic.bytesOut += data.length;
      if (data !== "ping") {
        const parsed = JSON.parse(data) as Record<string, unknown> | Array<Record<string, unknown>>;
        for (const m of Array.isArray(parsed) ? parsed : [parsed]) bump(traffic.sent, String(m.t));
      }
      this.ws.send(data);
    }
    close(code?: number, reason?: string) {
      this.ws.close(code, reason);
    }
  }
  return { WebSocket: Counting as unknown as WebSocketConstructor, traffic };
}
