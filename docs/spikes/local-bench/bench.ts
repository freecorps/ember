// Local raw-performance bench: Ember (Miniflare/workerd, on-disk DO SQLite) vs Convex (open-source local backend,
// on-disk SQLite), same machine, no network. Same app and workloads as ../remote/scripts/convex-vs-ember.ts, plus a
// no-op mutation (fixed per-call cost) and query throughput.
//
//   docs/spikes/local-bench/up-convex.sh &      # Convex local backend on :3210 (state in packages/cli/.tmp/convex-local)
//   bun --conditions=@freecorps/ember-source run docs/spikes/local-bench/bench.ts
//   CONVEX_KNOBS=s256 docs/spikes/local-bench/up-convex.sh &   # same, sized like Convex Pro's S256 class
//   BACKENDS=convex,ember  ONLY=q,d,f,c,n,a,b  DUR_MS=8000  ROUND=1   (subsets)
//
// Results: ./evidence/local.json (merged per run, key = backend[#ROUND]), log in ./evidence/local-<round>.txt.
// Clients run in this Bun process with each official client (ConvexClient / EmberClient); the backends run in their own
// processes (workerd / convex-local-backend), so `clientCpuPct` is the harness and the server CPU is sampled with ps.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadavg, cpus } from "node:os";
import { execFileSync } from "node:child_process";
import { Miniflare } from "../../../packages/cli/node_modules/miniflare/dist/src/index.js";
import { loadProject } from "../../../packages/cli/src/config.ts";
import { init } from "../../../packages/cli/src/init.ts";
import { buildWorker } from "../../../packages/cli/src/build.ts";
import { miniflareOptions } from "../../../packages/cli/src/local.ts";
import { codegen } from "../../../packages/cli/src/codegen/index.ts";
import { EmberClient } from "../../../packages/client/src/index.ts";
import { ConvexClient, ConvexHttpClient } from "../remote/convex-bench/node_modules/convex/dist/esm/browser/index.js";
import { makeFunctionReference } from "../remote/convex-bench/node_modules/convex/dist/esm/server/index.js";

const REPO = join(import.meta.dir, "../../..");
const EMBER_ROOT = join(REPO, "packages/cli/.tmp/ember-local-bench");
const CONVEX_STATE = join(REPO, "packages/cli/.tmp/convex-local/state.json");
const EVIDENCE = join(import.meta.dir, "evidence");
const DUR = Number(process.env.DUR_MS ?? 8_000);
const ROUND = process.env.ROUND ?? "";
const tag = Date.now().toString(36);

const logLines: string[] = [];
const say = (...xs: unknown[]) => {
  const line = xs.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ").replace(/\/Users\/[^\s"']+/g, "<path>");
  logLines.push(line);
  console.log(line);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();
const pct = (xs: number[], p: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]! * 100) / 100;
};
const summary = (xs: number[]) => ({ n: xs.length, p50: pct(xs, 50), p95: pct(xs, 95), p99: pct(xs, 99), max: xs.length ? Math.round(Math.max(...xs) * 10) / 10 : null });
const machine = () => ({ loadavg: loadavg().map((x) => +x.toFixed(1)), cpus: cpus().length });

// ------------------------------------------------------------------ server CPU (ps, cumulative seconds of the process tree)

function cpuSecondsOf(pids: number[]): number {
  if (!pids.length) return 0;
  const out = execFileSync("ps", ["-o", "time=", "-p", pids.join(",")], { encoding: "utf8" });
  return out.trim().split("\n").filter(Boolean).reduce((a, t) => {
    const parts = t.trim().split(":").map(Number); // [h:]m:s.cc
    return a + parts.reduce((acc, x) => acc * 60 + x, 0);
  }, 0);
}
function pidsByPattern(pattern: string): number[] {
  try {
    return execFileSync("pgrep", ["-f", pattern], { encoding: "utf8" }).trim().split("\n").filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

// ------------------------------------------------------------------ Ember project (same app as ./convex)

const EMBER_SCHEMA = `import { defineSchema, defineShard, defineTable, v } from "@freecorps/ember-server";
export default defineSchema({
  tables: {
    items: defineTable({ n: v.number(), sentAt: v.number(), body: v.string() }).index("by_n", ["n"]),
    counters: defineTable({ name: v.string(), value: v.number() }).index("by_name", ["name"]),
  },
  shards: { us: defineShard({ key: v.string() }) },
});
`;
const EMBER_BENCH = `import { v } from "@freecorps/ember-server";
import { mutation, query } from "./_generated/server";
export const put = mutation({ args: { n: v.number(), sentAt: v.number(), body: v.string() }, handler: (ctx, a) => ctx.db.insert("items", a) });
export const noop = mutation({ args: {}, handler: () => null });
export const incr = mutation({
  args: { name: v.string() },
  handler: (ctx, { name }) => {
    const c = ctx.db.query("counters").withIndex("by_name", (q) => q.eq("name", name)).unique();
    if (!c) { ctx.db.insert("counters", { name, value: 1 }); return 1; }
    ctx.db.patch(c._id, { value: c.value + 1 });
    return c.value + 1;
  },
});
export const counter = query({ args: { name: v.string() }, handler: (ctx, { name }) => ctx.db.query("counters").withIndex("by_name", (q) => q.eq("name", name)).unique()?.value ?? 0 });
export const recent = query({ args: { limit: v.optional(v.number()), salt: v.optional(v.number()) }, handler: (ctx, { limit }) => ctx.db.query("items").withIndex("by_n").order("desc").take(limit ?? 10) });
export const latest = query({ args: {}, handler: (ctx) => ctx.db.query("items").order("desc").first() });
export const page = query({
  args: { paginationOpts: v.object({ numItems: v.number(), cursor: v.union(v.string(), v.null()) }), salt: v.optional(v.number()) },
  handler: (ctx, { paginationOpts }) => ctx.db.query("items").withIndex("by_n").order("desc").paginate(paginationOpts),
});
`;

async function startEmber(): Promise<{ url: string; stop: () => Promise<void> }> {
  rmSync(EMBER_ROOT, { recursive: true, force: true });
  mkdirSync(EMBER_ROOT, { recursive: true });
  init({ dir: EMBER_ROOT, project: "localbench", auth: false });
  for (const f of ["messages.ts", "crons.ts"]) rmSync(join(EMBER_ROOT, "ember", f), { force: true });
  writeFileSync(join(EMBER_ROOT, "ember/schema.ts"), EMBER_SCHEMA);
  writeFileSync(join(EMBER_ROOT, "ember/bench.ts"), EMBER_BENCH);
  const project = loadProject(EMBER_ROOT);
  await codegen(project);
  // Same bundle as `ember deploy` (minified, no keepNames); DO SQLite persisted on disk like the Convex SQLite file.
  const build = await buildWorker(project, { minify: true });
  const mf = new Miniflare(miniflareOptions(project, build, { persist: true }) as any);
  const url = (await mf.ready).href.replace(/\/$/, "");
  return { url, stop: () => mf.dispose() };
}

// ------------------------------------------------------------------ wire accounting

type Wire = { inBytes: number; inFrames: number; outBytes: number; outFrames: number };
const frameSize = (d: unknown) =>
  typeof d === "string" ? Buffer.byteLength(d) : d instanceof ArrayBuffer ? d.byteLength : ArrayBuffer.isView(d) ? d.byteLength : (d as Blob)?.size ?? 0;
function countingWebSocket(wire: Wire) {
  const Base = globalThis.WebSocket;
  return class CountingWebSocket extends Base {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      this.addEventListener("message", (e: MessageEvent) => {
        wire.inBytes += frameSize(e.data);
        wire.inFrames++;
      });
    }
    override send(data: any) {
      wire.outBytes += frameSize(data);
      wire.outFrames++;
      super.send(data);
    }
  } as unknown as typeof WebSocket;
}

// ------------------------------------------------------------------ backend adapters

interface BClient {
  wire: Wire;
  mut(fn: string, args: any, shard: string): Promise<any>;
  wsQuery(fn: string, args: any, shard: string): Promise<any>;
  httpQuery(fn: string, args: any, shard: string): Promise<any>;
  sub(fn: string, args: any, shard: string, cb: (v: any) => void): () => void;
  close(): void;
}
interface Backend {
  name: string;
  shard(key: string): string;
  client(): BClient;
  serverPids(): number[];
}

const refs = new Map<string, any>();
const ref = (fn: string) => {
  if (!refs.has(fn)) refs.set(fn, makeFunctionReference<any>(fn));
  return refs.get(fn);
};

function convexBackend(): Backend {
  if (!existsSync(CONVEX_STATE)) throw new Error("no local Convex (run docs/spikes/local-bench/up-convex.sh)");
  const { url } = JSON.parse(readFileSync(CONVEX_STATE, "utf8")) as { url: string };
  const http = new ConvexHttpClient(url);
  return {
    name: "convex",
    shard: () => "",
    serverPids: () => pidsByPattern("convex-local-backend --instance-name ember-bench-local"),
    client() {
      const wire: Wire = { inBytes: 0, inFrames: 0, outBytes: 0, outFrames: 0 };
      const c = new ConvexClient(url, { webSocketConstructor: countingWebSocket(wire), unsavedChangesWarning: false } as any);
      return {
        wire,
        mut: (fn, args) => c.mutation(ref(fn), args),
        wsQuery: (fn, args) => c.query(ref(fn), args),
        httpQuery: (fn, args) => http.query(ref(fn), args),
        sub: (fn, args, _s, cb) => c.onUpdate(ref(fn), args, cb, () => {}),
        close: () => void c.close(),
      };
    },
  };
}

function emberBackend(url: string): Backend {
  return {
    name: "ember",
    shard: (key) => `us:${key}`,
    serverPids: () => pidsByPattern("workerd serve"),
    client() {
      const wire: Wire = { inBytes: 0, inFrames: 0, outBytes: 0, outFrames: 0 };
      const c = new EmberClient({ url, WebSocket: countingWebSocket(wire) as any, connectivity: null, idleTimeoutMs: 120_000 });
      const live = new Map<string, number>();
      const sub = (fn: string, args: any, shard: string, cb: (v: any) => void) => {
        live.set(shard, (live.get(shard) ?? 0) + 1);
        const off = c.subscribe(fn as any, args, { shard }, (s: any) => {
          if (s.status === "success" && !s.source) cb(s.value);
        }) as unknown as () => void;
        return () => {
          live.set(shard, (live.get(shard) ?? 1) - 1);
          off();
        };
      };
      return {
        wire,
        mut: (fn, args, shard) => c.mutation(fn as any, args, { shard }),
        wsQuery: (fn, args, shard) =>
          (live.get(shard) ?? 0) > 0
            ? c.query(fn as any, args, { shard, transport: "socket" })
            : new Promise((resolve, reject) => {
                let off: (() => void) | null = null;
                let done = false;
                const to = setTimeout(() => {
                  done = true;
                  off?.();
                  reject(new Error("wsQuery timeout"));
                }, 20_000);
                off = sub(fn, args, shard, (v) => {
                  if (done) return;
                  done = true;
                  clearTimeout(to);
                  queueMicrotask(() => off?.());
                  resolve(v);
                });
                if (done) off();
              }),
        httpQuery: (fn, args, shard) => c.query(fn as any, args, { shard, transport: "http" }),
        sub,
        close: () => c.close(),
      };
    },
  };
}

// ------------------------------------------------------------------ helpers

function cpuMeter(b: Backend) {
  const c0 = process.cpuUsage();
  const pids = b.serverPids();
  const s0 = cpuSecondsOf(pids);
  const t0 = now();
  return () => {
    const c = process.cpuUsage(c0);
    const wall = now() - t0;
    return {
      clientCpuPct: Math.round(((c.user + c.system) / 1000 / wall) * 100),
      serverCpuPct: Math.round(((cpuSecondsOf(pids) - s0) * 1000 / wall) * 100),
    };
  };
}

async function closedLoop(b: Backend, o: { clients: number; window: number; durationMs: number; call: (c: BClient, i: number, seq: number) => Promise<any>; warmup?: (c: BClient, i: number) => Promise<any> }) {
  const cs = Array.from({ length: o.clients }, () => b.client());
  if (o.warmup) await Promise.all(cs.map((c, i) => o.warmup!(c, i)));
  const lat: number[] = [];
  let ok = 0, errors = 0;
  const firstErrors: string[] = [];
  const cpu = cpuMeter(b);
  const t0 = now();
  const end = t0 + o.durationMs;
  let seq = 0;
  await Promise.all(
    cs.flatMap((c, i) =>
      Array.from({ length: o.window }, async () => {
        while (now() < end) {
          const s = now();
          try {
            await o.call(c, i, seq++);
            ok++;
            lat.push(now() - s);
          } catch (e) {
            errors++;
            if (firstErrors.length < 3) firstErrors.push(String((e as Error).message).slice(0, 200));
          }
        }
      }),
    ),
  );
  const wall = (now() - t0) / 1000;
  const cpu1 = cpu();
  const res = { clients: o.clients, window: o.window, inFlight: o.clients * o.window, ok, errors, firstErrors, perSecond: Math.round(ok / wall), ackMs: summary(lat), ...cpu1, serverCpuUsPerOp: ok ? Math.round((cpu1.serverCpuPct / 100) * wall * 1e6 / ok) : null, machine: machine() };
  cs.forEach((c) => c.close());
  return res;
}

async function seed(b: Backend, shard: string, rows: number) {
  const c = b.client();
  for (let i = 0; i < rows; i += 100) await Promise.all(Array.from({ length: Math.min(100, rows - i) }, (_, j) => c.mut("bench:put", { n: i + j, sentAt: Date.now(), body: `row ${i + j}`.padEnd(64, ".") }, shard)));
  c.close();
}

// ------------------------------------------------------------------ workloads

// n. No-op mutation: the fixed cost of one call (protocol, routing, transaction, ack).
async function noop(b: Backend) {
  const out: Record<string, unknown> = {};
  for (const [clients, window] of [[1, 1], [6, 100]] as const) {
    const shard = b.shard(`noop-${tag}-${clients}x${window}`);
    const r = await closedLoop(b, { clients, window, durationMs: DUR, warmup: (c) => c.mut("bench:noop", {}, shard), call: (c) => c.mut("bench:noop", {}, shard) });
    out[`${clients}x${window}`] = r;
    say(`[${b.name}] n noop ${clients}x${window}:`, r);
  }
  return out;
}

// a. Hot document: read-modify-write of one counter.
async function hot(b: Backend) {
  const out: Record<string, unknown> = {};
  for (const [clients, window] of [[1, 1], [6, 10], [6, 100], [60, 1]] as const) {
    const name = `hot-${tag}-${clients}x${window}`;
    const shard = b.shard(name);
    const r = await closedLoop(b, { clients, window, durationMs: DUR, warmup: (c) => c.wsQuery("bench:counter", { name }, shard), call: (c) => c.mut("bench:incr", { name }, shard) });
    await sleep(300);
    const v = b.client();
    const final = await v.httpQuery("bench:counter", { name }, shard);
    v.close();
    out[`${clients}x${window}`] = { ...r, finalCounter: final, lostOrExtra: final - r.ok };
    say(`[${b.name}] a hot ${clients}x${window}:`, out[`${clients}x${window}`]);
  }
  return out;
}

// b. Spread writes: independent inserts (Ember: one shard per socket).
async function spread(b: Backend) {
  const out: Record<string, unknown> = {};
  for (const [clients, window] of (process.env.SPREAD ?? "1x1,8x50,32x50").split(",").map((x) => x.split("x").map(Number) as [number, number])) {
    const r = await closedLoop(b, {
      clients,
      window,
      durationMs: DUR,
      warmup: (c, i) => c.wsQuery("bench:latest", {}, b.shard(`sp-${tag}-${clients}-${i}`)),
      call: (c, i, seq) => c.mut("bench:put", { n: seq, sentAt: Date.now(), body: "x".repeat(64) }, b.shard(`sp-${tag}-${clients}-${i}`)),
    });
    out[`${clients}x${window}`] = r;
    say(`[${b.name}] b spread ${clients}x${window}:`, r);
  }
  return out;
}

// q. Query throughput over the socket: recent(10) on 1000 rows, distinct args (no result cache hit).
async function queryThroughput(b: Backend) {
  const shard = b.shard(`qt-${tag}`);
  await seed(b, shard, 1000);
  const out: Record<string, unknown> = {};
  let salt = 0;
  for (const [clients, window] of [[1, 1], [8, 50]] as const) {
    const holds: Array<() => void> = [];
    const r = await closedLoop(b, {
      clients,
      window,
      durationMs: DUR,
      warmup: async (c) => {
        await c.wsQuery("bench:latest", {}, shard);
        holds.push(c.sub("bench:latest", {}, shard, () => {}));
      },
      call: (c) => c.wsQuery("bench:recent", { limit: 10, salt: ++salt }, shard),
    });
    holds.forEach((h) => h());
    out[`${clients}x${window}`] = r;
    say(`[${b.name}] q query-throughput ${clients}x${window}:`, r);
  }
  return out;
}

// c + e. Fan-out: N subscriber sockets to bench:latest, one writer (20 writes, 250 ms apart).
async function fanout(b: Backend) {
  const out: Record<string, unknown> = {};
  for (const N of [100, 1000]) {
    const shard = b.shard(`fan-${tag}-${N}`);
    const w = b.client();
    await w.mut("bench:put", { n: -1, sentAt: Date.now(), body: "seed" }, shard);
    const arrivals = new Map<number, number[]>();
    const last: number[] = [];
    const subs: BClient[] = [];
    const ready: Promise<void>[] = [];
    const t0 = now();
    for (let i = 0; i < N; i++) {
      const c = b.client();
      const idx = subs.length;
      subs.push(c);
      ready.push(
        new Promise<void>((res) => {
          let first = true;
          c.sub("bench:latest", {}, shard, (doc: any) => {
            if (first) {
              first = false;
              res();
            }
            if (doc) last[idx] = doc.n;
            if (doc && doc.n >= 0) (arrivals.get(doc.n) ?? arrivals.set(doc.n, []).get(doc.n)!).push(now());
          });
        }),
      );
      if (i % 50 === 49) await sleep(20);
    }
    const subscribed = await Promise.race([Promise.all(ready).then(() => true), sleep(60_000).then(() => false)]);
    const subscribeMs = Math.round(now() - t0);
    await sleep(1000);
    const wire0 = subs.reduce((a, c) => a + c.wire.inBytes, 0);
    const frames0 = subs.reduce((a, c) => a + c.wire.inFrames, 0);
    const sends: Array<{ n: number; sent: number; ack: number }> = [];
    const cpu = cpuMeter(b);
    for (let k = 0; k < 20; k++) {
      const sent = now();
      await w.mut("bench:put", { n: k, sentAt: Date.now(), body: `fan ${k}`.padEnd(64, ".") }, shard);
      sends.push({ n: k, sent, ack: now() });
      await sleep(250);
    }
    await sleep(2000);
    const fromSend: number[] = [];
    const lastArrival: number[] = [];
    let got = 0;
    for (const s of sends) {
      const ts = arrivals.get(s.n) ?? [];
      for (const t of ts) {
        got++;
        fromSend.push(t - s.sent);
      }
      if (ts.length) lastArrival.push(Math.max(...ts) - s.sent);
    }
    const bytes = subs.reduce((a, c) => a + c.wire.inBytes, 0) - wire0;
    const frames = subs.reduce((a, c) => a + c.wire.inFrames, 0) - frames0;
    out[`n${N}`] = {
      subscribers: N,
      allSubscribed: subscribed,
      subscribeMs,
      updates: got,
      expected: N * 20,
      subscribersAtFinalValue: last.filter((n) => n === 19).length,
      deliveryFromSendMs: summary(fromSend),
      lastSubscriberMs: summary(lastArrival),
      writerAckMs: summary(sends.map((s) => s.ack - s.sent)),
      bytesPerUpdate: got ? Math.round(bytes / got) : null,
      framesPerUpdate: got ? +(frames / got).toFixed(2) : null,
      ...cpu(),
      machine: machine(),
    };
    say(`[${b.name}] c fan-out ${N}:`, out[`n${N}`]);
    subs.forEach((c) => c.close());
    w.close();
    await sleep(1000);
  }
  return out;
}

// d. Query latency, sequential (1 in flight) and 4 concurrent, socket and HTTP, distinct args.
async function queries(b: Backend) {
  const shard = b.shard(`q-${tag}`);
  await seed(b, shard, 1000);
  const c = b.client();
  await c.wsQuery("bench:latest", {}, shard);
  const hold = c.sub("bench:latest", {}, shard, () => {});
  const out: Record<string, unknown> = {};
  let salt = 0;
  const cases: Array<[string, (c: BClient) => Promise<any>]> = [
    ["ws recent(10)", (c) => c.wsQuery("bench:recent", { limit: 10, salt: ++salt }, shard)],
    ["ws page(20)", (c) => c.wsQuery("bench:page", { paginationOpts: { numItems: 20, cursor: null }, salt: ++salt }, shard)],
    ["ws counter (point)", (c) => c.wsQuery("bench:counter", { name: `x${++salt}` }, shard)],
    ["http recent(10)", (c) => c.httpQuery("bench:recent", { limit: 10, salt: ++salt }, shard)],
    ["http page(20)", (c) => c.httpQuery("bench:page", { paginationOpts: { numItems: 20, cursor: null }, salt: ++salt }, shard)],
  ];
  for (const conc of [1, 4]) {
    for (const [label, fn] of cases) {
      const lat: number[] = [];
      let errors = 0;
      const per = conc === 1 ? 300 : 150;
      await Promise.all(
        Array.from({ length: conc }, async () => {
          for (let i = 0; i < per; i++) {
            const s = now();
            try {
              const v = await fn(c);
              if (label.includes("page") && !(v?.page?.length === 20)) throw new Error("bad page");
              lat.push(now() - s);
            } catch {
              errors++;
            }
          }
        }),
      );
      out[`${label} c${conc}`] = { ...summary(lat), errors };
      say(`[${b.name}] d ${label} c${conc}:`, out[`${label} c${conc}`]);
    }
  }
  hold();
  c.close();
  return out;
}

// f. New client → first result (warm backend).
async function cold(b: Backend) {
  const shard = b.shard(`cold-${tag}`);
  const w = b.client();
  await w.mut("bench:put", { n: 1, sentAt: Date.now(), body: "cold" }, shard);
  w.close();
  const xs: number[] = [];
  const fresh: number[] = [];
  for (let i = 0; i < 30; i++) {
    const s = now();
    const c = b.client();
    await c.wsQuery("bench:latest", {}, shard);
    xs.push(now() - s);
    c.close();
  }
  // Ember only: a never-seen shard (DO creation + schema DDL on first wake). Convex has no equivalent.
  if (b.name === "ember") {
    for (let i = 0; i < 10; i++) {
      const s = now();
      const c = b.client();
      await c.wsQuery("bench:latest", {}, b.shard(`fresh-${tag}-${i}`));
      fresh.push(now() - s);
      c.close();
    }
  }
  const out = { newClientWarmShard: summary(xs), ...(fresh.length ? { newClientNewShard: summary(fresh) } : {}) };
  say(`[${b.name}] f first result:`, out);
  return out;
}

// ------------------------------------------------------------------ main

mkdirSync(EVIDENCE, { recursive: true });
const want = (process.env.BACKENDS ?? "convex,ember").split(",");
const only = (process.env.ONLY ?? "n,a,b,q,d,c,f").split(",");
const evFile = join(EVIDENCE, "local.json");
const ev: Record<string, any> = existsSync(evFile) ? JSON.parse(readFileSync(evFile, "utf8")) : {};
const flush = () => writeFileSync(evFile, JSON.stringify(ev, null, 2));
let ember: Awaited<ReturnType<typeof startEmber>> | null = null;
let exitCode = 0;
try {
  const backends: Backend[] = [];
  for (const n of want) {
    if (n === "convex") backends.push(convexBackend());
    else if (n === "ember") {
      ember = await startEmber();
      backends.push(emberBackend(ember.url));
    } else throw new Error(`unknown backend ${n}`);
  }
  const convexBin = existsSync(CONVEX_STATE) ? (JSON.parse(readFileSync(CONVEX_STATE, "utf8")).binary as string) : null;
  ev.meta = { lastRun: new Date().toISOString(), runtime: `bun ${Bun.version}`, machine: machine(), cpu: cpus()[0]?.model, durationMs: DUR, convexBinary: convexBin, convexKnobs: existsSync(CONVEX_STATE) ? JSON.parse(readFileSync(CONVEX_STATE, "utf8")).knobs : null, convexClient: "convex@1.49.0" };
  say("meta:", ev.meta);
  for (const b of backends) {
    const key = b.name + (ROUND ? `#${ROUND}` : "");
    ev[key] ??= {};
    // Reads first, on small tables: Convex's local SQLite index scans slow down as the write scenarios grow `items`.
    if (only.includes("q")) (ev[key].q = await queryThroughput(b)), flush();
    if (only.includes("d")) (ev[key].d = await queries(b)), flush();
    if (only.includes("f")) (ev[key].f = await cold(b)), flush();
    if (only.includes("c")) (ev[key].c = await fanout(b)), flush();
    if (only.includes("n")) (ev[key].n = await noop(b)), flush();
    if (only.includes("a")) (ev[key].a = await hot(b)), flush();
    if (only.includes("b")) (ev[key].b = await spread(b)), flush();
  }
} catch (e) {
  exitCode = 1;
  say("FAILED:", String((e as Error)?.stack ?? e));
} finally {
  writeFileSync(join(EVIDENCE, `local${ROUND ? `-${ROUND}` : ""}.txt`), logLines.join("\n") + "\n");
  await ember?.stop();
  process.exit(exitCode);
}
