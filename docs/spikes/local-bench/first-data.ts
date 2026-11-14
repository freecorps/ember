// "Cliente novo": time to the first result of a subscription for a client that just started, over a simulated link.
// A TCP proxy in front of Miniflare delays every chunk by RTT/2 in each direction (the long round trip is to the
// Durable Object) and charges EDGE_MS × 2 before a new connection carries data (TCP + TLS end at a nearby edge).
//
//   bun --conditions=@freecorps/ember-source run docs/spikes/local-bench/first-data.ts
//   RTT=180 EDGE_MS=10 N=15 (fresh clients per case) HTTP_FIRST=0 (the client without httpFirst)
//
// Cases: anonymous and signed-in (a token fetched over HTTP first, as `/api/auth/token` would), with the client's
// defaults, and the bare costs of one HTTP query on a new and on an already open connection.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { transform } from "esbuild";
import { Miniflare } from "../../../packages/cli/node_modules/miniflare/dist/src/index.js";
import { loadProject } from "../../../packages/cli/src/config.ts";
import { init } from "../../../packages/cli/src/init.ts";
import { buildWorker } from "../../../packages/cli/src/build.ts";
import { miniflareOptions } from "../../../packages/cli/src/local.ts";
import { codegen } from "../../../packages/cli/src/codegen/index.ts";
import { EmberClient, unsafeRef } from "../../../packages/client/src/index.ts";

const ROOT = join(import.meta.dir, "../../../packages/cli/.tmp/ember-first-data");
const RTT = Number(process.env.RTT ?? 180);
const EDGE = Number(process.env.EDGE_MS ?? 10);
const N = Number(process.env.N ?? 15);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

const SCHEMA = `import { defineSchema, defineShard, defineTable, v } from "@freecorps/ember-server";
export default defineSchema({ tables: { items: defineTable({ n: v.number(), body: v.string() }).index("by_n", ["n"]) }, shards: { us: defineShard({ key: v.string() }) } });
`;
const BENCH = `import { v } from "@freecorps/ember-server";
import { mutation, query } from "./_generated/server";
export const put = mutation({ args: { n: v.number(), body: v.string() }, handler: (ctx, a) => ctx.db.insert("items", a) });
export const recent = query({ args: { limit: v.number() }, handler: (ctx, { limit }) => ctx.db.query("items").withIndex("by_n").order("desc").take(limit) });
`;
const AUTH = `const auth = { verify: (t) => (typeof t === "string" && t.startsWith("u:") ? { subject: t.slice(2), issuer: "bench" } : null) };`;

rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });
init({ dir: ROOT, project: "firstdata", auth: false });
for (const f of ["messages.ts", "crons.ts"]) rmSync(join(ROOT, "ember", f), { force: true });
writeFileSync(join(ROOT, "ember/schema.ts"), SCHEMA);
writeFileSync(join(ROOT, "ember/bench.ts"), BENCH);
const project = loadProject(ROOT);
await codegen(project);
const build = await buildWorker(project, { minify: false });
const patched = build.code.replace(/(const|var|let) auth = (undefined|void 0);/, AUTH);
if (patched === build.code) throw new Error("could not install the bench auth hook");
build.code = (await transform(patched, { minify: true, format: "esm", target: "es2022" })).code;
const mf = new Miniflare(miniflareOptions(project, build, { persist: false }) as never);
const origin = new URL((await mf.ready).href);

// ------------------------------------------------------------------ latency proxy
type Pair = { client: import("bun").Socket<{ peer?: import("bun").Socket<unknown>; ready: boolean; queue: Uint8Array[] }> };
const proxy = Bun.listen<{ peer?: import("bun").Socket<unknown>; ready: boolean; queue: Uint8Array[] }>({
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
            // TCP + TLS with the edge before the first byte goes anywhere.
            setTimeout(() => {
              client.data.ready = true;
              for (const q of client.data.queue) setTimeout(() => server.write(q), RTT / 2);
              client.data.queue = [];
            }, EDGE * 2);
          },
          data(_server, chunk) {
            const copy = new Uint8Array(chunk);
            setTimeout(() => client.write(copy), RTT / 2);
          },
          close() {
            setTimeout(() => client.end(), RTT / 2);
          },
          error() {},
        },
      });
    },
    data(client, chunk) {
      const copy = new Uint8Array(chunk);
      if (!client.data.ready || !client.data.peer) client.data.queue.push(copy);
      else setTimeout(() => client.data.peer!.write(copy), RTT / 2);
    },
    close(client) {
      setTimeout(() => client.data.peer?.end(), RTT / 2);
    },
    error() {},
  },
});
void (null as unknown as Pair);
const url = `http://127.0.0.1:${proxy.port}`;

// Seed (direct, not through the proxy).
const seedClient = new EmberClient({ url: origin.href, connectivity: null });
for (let i = 0; i < 30; i++) await seedClient.mutation(unsafeRef("bench:put"), { n: i, body: "x".repeat(40) }, { shard: "us:one" } as never);
seedClient.close();

async function firstResult(signedIn: "no" | "fetch" | "stored"): Promise<number> {
  const t0 = performance.now();
  const client = new EmberClient({
    url,
    connectivity: null,
    // "fetch": the token comes from an HTTP round trip first (stands in for `/api/auth/token`); "stored": read from
    // local storage (a bearer token in SecureStore / localStorage).
    ...(signedIn === "fetch" ? { auth: async () => (await (await fetch(`${url}/health`)).text(), `u:user${Math.random()}`) } : {}),
    ...(signedIn === "stored" ? { auth: () => `u:user${Math.random()}` } : {}),
    ...(process.env.HTTP_FIRST === "0" ? { httpFirst: false } : {}),
  } as never);
  const ms = await new Promise<number>((resolve) => {
    client.subscribe(unsafeRef("bench:recent"), { limit: 20 }, { shard: "us:one" } as never, (s) => {
      if (s.status === "success") resolve(performance.now() - t0);
    });
  });
  client.close();
  return ms;
}

async function httpQuery(warm: boolean): Promise<number> {
  // A new Bun fetch pool entry per case: `warm` first opens the connection with another request.
  if (warm) await (await fetch(`${url}/health`, { keepalive: true })).text();
  const t0 = performance.now();
  const r = await fetch(`${url}/api/query`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fn: "bench:recent", args: { limit: 20 }, shard: "us:one" }), keepalive: true });
  await r.text();
  return performance.now() - t0;
}

const cases: Array<[string, () => Promise<number>]> = [
  ["first result, anonymous", () => firstResult("no")],
  ["first result, signed in (token over HTTP first)", () => firstResult("fetch")],
  ["first result, signed in (token in storage)", () => firstResult("stored")],
  ["http query, new connection", () => httpQuery(false)],
  ["http query, connection already open", () => httpQuery(true)],
];
console.log(`# first-data RTT=${RTT} EDGE_MS=${EDGE} N=${N} ${process.env.LABEL ?? ""}`);
for (const [name, run] of cases) {
  const xs: number[] = [];
  for (let i = 0; i < N; i++) {
    xs.push(await run());
    await sleep(50);
  }
  console.log(`${name}: p50 ${median(xs).toFixed(0)} ms (${(median(xs) / RTT).toFixed(2)} RTT); runs ${xs.map((x) => x.toFixed(0)).join(" ")}`);
}
proxy.stop(true);
await mf.dispose();
process.exit(0);
