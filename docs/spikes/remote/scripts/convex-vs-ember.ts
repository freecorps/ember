// Convex vs Ember, side by side (docs/spikes/remote/convex-vs-ember.md, PLAN §19).
//
//   bun --conditions=@freecorps/ember-source run docs/spikes/remote/scripts/convex-vs-ember.ts <phase...>
//     deploy | where | inregion | bench | cleanup | inventory          (default: deploy bench cleanup)
//   BACKENDS=convex,ember-us,ember-sa   ONLY=a,b,c,d,f   (subsets)
//
// Same client harness for both backends, run from this laptop, with each official client:
//   - Convex: `ConvexClient` (convex/browser) and `ConvexHttpClient`, against the app in ../convex-bench
//     (deployment URL read from ../convex-bench/.env.local, never printed);
//   - Ember: `EmberClient` (@freecorps/ember-client) against `ember-spike-cvx-test`, deployed here with the same schema
//     and functions. Shards `us:*` carry locationHint "enam" (same coast as Convex aws-us-east-1) and `sa:*` "sam".
// Every WebSocket is wrapped to count frame bytes (payload after any permessage-deflate inflation).
// Cloudflare token: the CLI lookup (wrangler OAuth), in memory only. Output is redacted.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadavg, cpus } from "node:os";
import { randomBytes } from "node:crypto";
import { loadProject } from "../../../../packages/cli/src/config.ts";
import { init } from "../../../../packages/cli/src/init.ts";
import { deploy, workerForm } from "../../../../packages/cli/src/deploy/index.ts";
import { CfClient, resolveToken } from "../../../../packages/cli/src/deploy/cf.ts";
import { EmberClient } from "../../../../packages/client/src/index.ts";
// convex is installed in ../convex-bench (its own package.json); import the ESM builds directly.
import { ConvexClient, ConvexHttpClient } from "../convex-bench/node_modules/convex/dist/esm/browser/index.js";
import { makeFunctionReference } from "../convex-bench/node_modules/convex/dist/esm/server/index.js";

const ROOT = join(import.meta.dir, "../../../../packages/cli/.tmp/ember-spike-cvx");
const STATE = join(ROOT, ".state.json"); // url only
const EVIDENCE = join(import.meta.dir, "../evidence");
const CONVEX_DIR = join(import.meta.dir, "../convex-bench");
const WORKER = "ember-spike-cvx-test";
const REGISTRY = "ember-spike-cvx-registry";
const WHERE = "ember-spike-cvx-where"; // tiny probe: where does a DO with a given locationHint run?
process.env.EMBER_REGISTRY_NAME = REGISTRY;

const token = resolveToken();
const auth = { authorization: `Bearer ${token}` };
const account = ((await (await fetch("https://api.cloudflare.com/client/v4/accounts", { headers: auth })).json()) as any).result[0].id as string;
const cf = new CfClient({ accountId: account, token });
const subdomain = ((await cf.request<{ subdomain?: string }>("GET", "/workers/subdomain")).result?.subdomain ?? "") as string;
const convexUrl = existsSync(join(CONVEX_DIR, ".env.local"))
  ? (/^CONVEX_URL=(\S+)/m.exec(readFileSync(join(CONVEX_DIR, ".env.local"), "utf8"))?.[1] ?? "")
  : "";
const convexName = /^https:\/\/([a-z0-9-]+)\./.exec(convexUrl)?.[1] ?? "\u0000";

const redact = (s: string) => {
  let out = s.split(account).join("<ACCOUNT_ID>").split(ROOT).join("<project>").split(convexName).join("<convex-deployment>");
  if (subdomain) out = out.split(subdomain).join("<subdomain>");
  return out.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "<email>").replace(/\/Users\/[^\s"']+/g, "<path>");
};
const logLines: string[] = [];
const say = (...xs: unknown[]) => {
  const line = redact(xs.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
  logLines.push(line);
  console.log(line);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => performance.now();
const pct = (xs: number[], p: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]! * 10) / 10;
};
const summary = (xs: number[]) => ({ n: xs.length, p50: pct(xs, 50), p95: pct(xs, 95), p99: pct(xs, 99), max: xs.length ? Math.round(Math.max(...xs)) : null });
const state = (): { url?: string } => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {});

// ------------------------------------------------------------------ Ember project (same schema/functions as convex-bench/convex)

const EMBER_SCHEMA = `import { defineSchema, defineShard, defineTable, v } from "@freecorps/ember-server";

export default defineSchema({
  tables: {
    items: defineTable({ n: v.number(), sentAt: v.number(), body: v.string() }).index("by_n", ["n"]),
    counters: defineTable({ name: v.string(), value: v.number() }).index("by_name", ["name"]),
  },
  shards: {
    us: defineShard({ key: v.string(), locationHint: "enam" }),
    sa: defineShard({ key: v.string(), locationHint: "sam" }),
  },
});
`;

const EMBER_BENCH = `import { v } from "@freecorps/ember-server";
import { mutation, query } from "./_generated/server";

export const put = mutation({
  args: { n: v.number(), sentAt: v.number(), body: v.string() },
  handler: (ctx, a) => ctx.db.insert("items", a),
});
export const incr = mutation({
  args: { name: v.string() },
  handler: (ctx, { name }) => {
    const c = ctx.db.query("counters").withIndex("by_name", (q) => q.eq("name", name)).unique();
    if (!c) {
      ctx.db.insert("counters", { name, value: 1 });
      return 1;
    }
    ctx.db.patch(c._id, { value: c.value + 1 });
    return c.value + 1;
  },
});
export const counter = query({
  args: { name: v.string() },
  handler: (ctx, { name }) => ctx.db.query("counters").withIndex("by_name", (q) => q.eq("name", name)).unique()?.value ?? 0,
});
export const recent = query({
  args: { limit: v.optional(v.number()), salt: v.optional(v.number()) },
  handler: (ctx, { limit }) => ctx.db.query("items").withIndex("by_n").order("desc").take(limit ?? 10),
});
export const latest = query({
  args: {},
  handler: (ctx) => ctx.db.query("items").order("desc").first(),
});
export const page = query({
  args: { paginationOpts: v.object({ numItems: v.number(), cursor: v.union(v.string(), v.null()) }), salt: v.optional(v.number()) },
  handler: (ctx, { paginationOpts }) => ctx.db.query("items").withIndex("by_n").order("desc").paginate(paginationOpts),
});
`;

async function deployPhase() {
  if (!existsSync(join(ROOT, "ember.json"))) {
    mkdirSync(ROOT, { recursive: true });
    init({ dir: ROOT, project: "spike-cvx", auth: false });
    const cfg = JSON.parse(readFileSync(join(ROOT, "ember.json"), "utf8"));
    cfg.account = account;
    cfg.environments = { test: {} };
    cfg.metrics = { enabled: false };
    writeFileSync(join(ROOT, "ember.json"), JSON.stringify(cfg, null, 2));
    for (const f of ["messages.ts", "crons.ts"]) rmSync(join(ROOT, "ember", f), { force: true });
  }
  writeFileSync(join(ROOT, "ember/schema.ts"), EMBER_SCHEMA);
  writeFileSync(join(ROOT, "ember/bench.ts"), EMBER_BENCH);
  const t = Date.now();
  const r = await deploy(loadProject(ROOT), { env: "test", adminToken: randomBytes(24).toString("base64url"), registryName: REGISTRY, wait: { timeoutMs: 180_000 }, message: "convex-vs-ember", log: (l) => say(l) } as any);
  writeFileSync(STATE, JSON.stringify({ url: r.url }));
  say(`ember deploy took ${Date.now() - t} ms`);
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
  /** One-shot over the socket (Convex `client.query`, Ember subscribe → first server result → unsubscribe). */
  wsQuery(fn: string, args: any, shard: string): Promise<any>;
  httpQuery(fn: string, args: any, shard: string): Promise<any>;
  sub(fn: string, args: any, shard: string, cb: (v: any) => void): () => void;
  close(): void;
}
interface Backend {
  name: string;
  /** Shard name for a logical key (ignored by Convex: one deployment). */
  shard(key: string): string;
  client(): BClient;
}

const refs = new Map<string, any>();
const ref = (kind: "query" | "mutation", fn: string) => {
  const k = `${kind}:${fn}`;
  if (!refs.has(k)) refs.set(k, makeFunctionReference<any>(fn));
  return refs.get(k);
};

function convexBackend(): Backend {
  if (!convexUrl) throw new Error("no CONVEX_URL in convex-bench/.env.local (run `npx convex dev --once` there)");
  const http = new ConvexHttpClient(convexUrl);
  return {
    name: "convex",
    shard: () => "",
    client() {
      const wire: Wire = { inBytes: 0, inFrames: 0, outBytes: 0, outFrames: 0 };
      const c = new ConvexClient(convexUrl, { webSocketConstructor: countingWebSocket(wire), unsavedChangesWarning: false } as any);
      return {
        wire,
        mut: (fn, args) => c.mutation(ref("mutation", fn), args),
        wsQuery: (fn, args) => c.query(ref("query", fn), args),
        httpQuery: (fn, args) => http.query(ref("query", fn), args),
        sub: (fn, args, _s, cb) => c.onUpdate(ref("query", fn), args, cb, () => {}),
        close: () => void c.close(),
      };
    },
  };
}

function emberBackend(prefix: "us" | "sa"): Backend {
  const url = state().url;
  if (!url) throw new Error("no Ember deployment (run the deploy phase)");
  return {
    name: `ember-${prefix}`,
    shard: (key) => `${prefix}:${key}`,
    client() {
      const wire: Wire = { inBytes: 0, inFrames: 0, outBytes: 0, outFrames: 0 };
      const c = new EmberClient({ url, WebSocket: countingWebSocket(wire) as any, connectivity: null, idleTimeoutMs: 120_000 });
      const sub = (fn: string, args: any, shard: string, cb: (v: any) => void) =>
        c.subscribe(fn as any, args, { shard }, (s: any) => {
          if (s.status === "success" && !s.source) cb(s.value);
        }) as unknown as () => void;
      return {
        wire,
        mut: (fn, args, shard) => c.mutation(fn as any, args, { shard }),
        wsQuery: (fn, args, shard) =>
          new Promise((resolve, reject) => {
            let off: (() => void) | null = null;
            let done = false;
            const to = setTimeout(() => reject(new Error("wsQuery timeout")), 20_000);
            off = sub(fn, args, shard, (v) => {
              if (done) return;
              done = true;
              clearTimeout(to);
              queueMicrotask(() => off?.());
              resolve(v);
            });
            if (done) off();
          }),
        httpQuery: (fn, args, shard) => c.query(fn as any, args, { shard }),
        sub,
        close: () => c.close(),
      };
    },
  };
}

// ------------------------------------------------------------------ helpers

const machine = () => ({ loadavg: loadavg().map((x) => +x.toFixed(1)), cpus: cpus().length });
function cpuMeter() {
  const c0 = process.cpuUsage();
  const t0 = now();
  return () => {
    const c = process.cpuUsage(c0);
    return { clientCpuPct: Math.round(((c.user + c.system) / 1000 / (now() - t0)) * 100) };
  };
}

/** `clients` sockets, each keeping `window` mutations in flight for `durationMs`. */
async function closedLoop(b: Backend, o: { clients: number; window: number; durationMs: number; call: (c: BClient, i: number, seq: number) => Promise<any>; warmup?: (c: BClient, i: number) => Promise<any> }) {
  const cs = Array.from({ length: o.clients }, () => b.client());
  if (o.warmup) await Promise.all(cs.map((c, i) => o.warmup!(c, i)));
  const lat: number[] = [];
  let ok = 0, errors = 0;
  const firstErrors: string[] = [];
  const cpu = cpuMeter();
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
  const res = { clients: o.clients, window: o.window, inFlight: o.clients * o.window, ok, errors, firstErrors, perSecond: Math.round(ok / wall), ackMs: summary(lat), ...cpu(), machine: machine() };
  cs.forEach((c) => c.close());
  return res;
}

async function seed(b: Backend, shard: string, rows: number) {
  const c = b.client();
  for (let i = 0; i < rows; i += 100) await Promise.all(Array.from({ length: Math.min(100, rows - i) }, (_, j) => c.mut("bench:put", { n: i + j, sentAt: Date.now(), body: `row ${i + j}`.padEnd(64, ".") }, shard)));
  c.close();
}

// ------------------------------------------------------------------ workloads

const DUR = Number(process.env.DUR_MS ?? 20_000);
const tag = Date.now().toString(36);

// a. Hot document: read-modify-write of one counter.
async function hot(b: Backend) {
  const out: Record<string, unknown> = {};
  for (const [clients, window] of [[6, 10], [6, 100], [60, 1]] as const) {
    const name = `hot-${tag}-${clients}x${window}`;
    const shard = b.shard(`hot-${tag}-${clients}x${window}`);
    const r = await closedLoop(b, { clients, window, durationMs: DUR, warmup: (c) => c.wsQuery("bench:counter", { name }, shard), call: (c) => c.mut("bench:incr", { name }, shard) });
    await sleep(500);
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
  for (const [clients, window] of (process.env.SPREAD ?? "8x50,32x50,256x1").split(",").map((x) => x.split("x").map(Number) as [number, number])) {
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

// c + e. Fan-out: N subscriber sockets to bench:latest, one writer (20 writes, 500 ms apart).
async function fanout(b: Backend) {
  const out: Record<string, unknown> = {};
  for (const N of [100, 430]) {
    const shard = b.shard(`fan-${tag}-${N}`);
    const w = b.client();
    await w.mut("bench:put", { n: -1, sentAt: Date.now(), body: "seed" }, shard);
    const arrivals = new Map<number, number[]>(); // n → subscriber arrival times
    const last: number[] = []; // last n seen per subscriber
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
      if (i % 20 === 19) await sleep(200); // stagger opens (bench.md B4)
    }
    const subscribed = await Promise.race([Promise.all(ready).then(() => true), sleep(60_000).then(() => false)]);
    const subscribeMs = Math.round(now() - t0);
    await sleep(2000);
    const wire0 = subs.reduce((a, c) => a + c.wire.inBytes, 0);
    const frames0 = subs.reduce((a, c) => a + c.wire.inFrames, 0);
    const sends: Array<{ n: number; sent: number; ack: number }> = [];
    const cpu = cpuMeter();
    for (let k = 0; k < 20; k++) {
      const sent = now();
      await w.mut("bench:put", { n: k, sentAt: Date.now(), body: `fan ${k}`.padEnd(64, ".") }, shard);
      sends.push({ n: k, sent, ack: now() });
      await sleep(500);
    }
    await sleep(3000);
    const fromSend: number[] = [], fromAck: number[] = [];
    let got = 0;
    for (const s of sends) for (const t of arrivals.get(s.n) ?? []) {
      got++;
      fromSend.push(t - s.sent);
      fromAck.push(t - s.ack);
    }
    const bytes = subs.reduce((a, c) => a + c.wire.inBytes, 0) - wire0;
    const frames = subs.reduce((a, c) => a + c.wire.inFrames, 0) - frames0;
    out[`n${N}`] = {
      subscribers: N,
      allSubscribed: subscribed,
      subscribeMs,
      updates: got,
      subscribersAtFinalValue: last.filter((n) => n === 19).length,
      expected: N * 20,
      deliveryFromSendMs: summary(fromSend),
      deliveryFromAckMs: summary(fromAck),
      writerAckMs: summary(sends.map((s) => s.ack - s.sent)),
      bytesPerUpdate: got ? Math.round(bytes / got) : null,
      framesPerUpdate: got ? +(frames / got).toFixed(2) : null,
      ...cpu(),
      machine: machine(),
    };
    say(`[${b.name}] c fan-out ${N}:`, out[`n${N}`]);
    subs.forEach((c) => c.close());
    w.close();
    await sleep(2000);
  }
  return out;
}

// d. Query latency: indexed take(10) and paginate(20), over the socket and over HTTP, 4 concurrent, distinct args.
async function queries(b: Backend) {
  const shard = b.shard(`q-${tag}`);
  await seed(b, shard, 1000);
  const c = b.client();
  await c.wsQuery("bench:latest", {}, shard);
  const out: Record<string, unknown> = {};
  let salt = 0;
  const cases: Array<[string, (c: BClient) => Promise<any>]> = [
    ["ws recent(10)", (c) => c.wsQuery("bench:recent", { limit: 10, salt: ++salt }, shard)],
    ["ws page(20)", (c) => c.wsQuery("bench:page", { paginationOpts: { numItems: 20, cursor: null }, salt: ++salt }, shard)],
    ["http recent(10)", (c) => c.httpQuery("bench:recent", { limit: 10, salt: ++salt }, shard)],
    ["http page(20)", (c) => c.httpQuery("bench:page", { paginationOpts: { numItems: 20, cursor: null }, salt: ++salt }, shard)],
  ];
  for (const [label, fn] of cases) {
    const lat: number[] = [];
    let errors = 0;
    const per = 50;
    await Promise.all(
      Array.from({ length: 4 }, async () => {
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
    out[label] = { ...summary(lat), errors };
    say(`[${b.name}] d ${label}:`, out[label]);
  }
  c.close();
  return out;
}

// f. New client → first query result (warm backend), and after ~100 s idle on a fresh Ember shard.
async function cold(backends: Backend[]) {
  const out: Record<string, unknown> = {};
  const first = async (b: Backend, shard: string) => {
    const s = now();
    const c = b.client();
    await c.wsQuery("bench:latest", {}, shard);
    const ms = now() - s;
    c.close();
    return ms;
  };
  for (const b of backends) {
    const warm: number[] = [];
    const shard = b.shard(`q-${tag}`);
    for (let i = 0; i < 10; i++) warm.push(await first(b, shard));
    out[`${b.name} newClientWarm`] = summary(warm);
  }
  const idle = backends.map((b) => ({ b, shards: Array.from({ length: 6 }, (_, i) => b.shard(`cold-${tag}-${i}`)) }));
  for (const { b, shards } of idle) {
    const c = b.client();
    for (const s of b.name === "convex" ? [shards[0]!] : shards) await c.mut("bench:put", { n: 1, sentAt: Date.now(), body: "cold" }, s);
    c.close();
  }
  say("f: idle 100 s so Ember shards hibernate/evict (R8)…");
  await sleep(100_000);
  for (const { b, shards } of idle) {
    const xs: number[] = [];
    for (const s of shards) xs.push(await first(b, s));
    out[`${b.name} newClientAfterIdle100s`] = summary(xs);
  }
  say("f cold/first query:", out);
  return out;
}

// ------------------------------------------------------------------ where: DO placement per locationHint

const WHERE_JS = `import { DurableObject } from "cloudflare:workers";
const trace = async () => Object.fromEntries((await (await fetch("https://www.cloudflare.com/cdn-cgi/trace")).text()).trim().split("\\n").map((l) => l.split("=")));
export class P extends DurableObject { async fetch() { const t = await trace(); return Response.json({ colo: t.colo, loc: t.loc }); } }
export default { async fetch(req, env) {
  const u = new URL(req.url); const hint = u.searchParams.get("hint") || undefined;
  const id = env.P.idFromName(u.searchParams.get("name") || "x");
  const r = await (hint ? env.P.get(id, { locationHint: hint }) : env.P.get(id)).fetch("https://do/");
  return Response.json({ workerColo: req.cf?.colo, do: await r.json() });
} };`;

async function wherePhase() {
  const metadata = {
    main_module: "index.js",
    compatibility_date: "2026-10-01",
    bindings: [{ type: "durable_object_namespace", name: "P", class_name: "P" }],
    exports: { P: { type: "durable-object", storage: "sqlite", state: "created" } },
    observability: { enabled: false },
  };
  await cf.call("PUT", `/workers/scripts/${WHERE}`, workerForm(metadata as any, WHERE_JS));
  await cf.call("POST", `/workers/scripts/${WHERE}/subdomain`, { enabled: true, previews_enabled: false });
  const base = `https://${WHERE}.${subdomain}.workers.dev`;
  const out: Record<string, unknown> = {};
  for (let i = 0; i < 60; i++) {
    const r = await fetch(`${base}/?name=warm`).catch(() => null);
    if (r?.status === 200) break;
    await sleep(2000);
  }
  for (const hint of ["", "enam", "sam"]) {
    const xs = [];
    for (let i = 0; i < 3; i++) {
      const r = await fetch(`${base}/?hint=${hint}&name=${hint || "none"}-${tag}-${i}`);
      xs.push(r.status === 200 ? await r.json() : r.status);
    }
    out[hint || "none"] = xs;
  }
  say("where (DO colo per hint):", out);
  const ev = join(EVIDENCE, "convex-vs-ember-where.json");
  writeFileSync(ev, redact(JSON.stringify(out, null, 2)));
  const d = await cf.request("DELETE", `/workers/scripts/${WHERE}?force=true`);
  say(`DELETE ${WHERE}:`, d.success ? "ok" : JSON.stringify(d.errors));
}

// ------------------------------------------------------------------ in-region Convex (action → ctx.runMutation)

async function inregionPhase() {
  if (!convexUrl) throw new Error("no CONVEX_URL");
  const http = new ConvexHttpClient(convexUrl);
  const burst = makeFunctionReference<"action">("inregion:burst") as any;
  const evFile = join(EVIDENCE, "convex-vs-ember.json");
  const ev: Record<string, any> = existsSync(evFile) ? JSON.parse(readFileSync(evFile, "utf8")) : {};
  ev["convex-inregion"] = {};
  for (const [kind, actions, parallel] of [["incr", 1, 60], ["incr", 6, 100], ["put", 4, 64], ["put", 8, 100]] as const) {
    const name = `ir-${tag}-${actions}x${parallel}`;
    const rs = await Promise.all(Array.from({ length: actions }, () => http.action(burst, { kind, parallel, ms: 20_000, name }).catch((e: Error) => ({ failed: e.message }))));
    const ok = rs.filter((r: any) => !r.failed);
    const total = ok.reduce((a: number, r: any) => a + r.ok, 0);
    const wall = Math.max(...ok.map((r: any) => r.wallMs)) / 1000;
    const final = kind === "incr" ? await http.query(makeFunctionReference<"query">("bench:counter") as any, { name }) : null;
    const out = { kind, actions, parallel, inFlight: actions * parallel, total, perSecond: Math.round(total / wall), errors: ok.reduce((a: number, r: any) => a + r.errors, 0), firstError: ok.find((r: any) => r.firstError)?.firstError ?? null, failedActions: rs.length - ok.length, perAction: ok.map((r: any) => ({ ok: r.ok, p50: r.p50, p95: r.p95, p99: r.p99, max: r.max })), finalCounter: final };
    ev["convex-inregion"][`${kind}-${actions}x${parallel}`] = out;
    say("convex in-region:", out);
    writeFileSync(evFile, redact(JSON.stringify(ev, null, 2)));
  }
}

// ------------------------------------------------------------------ bench / cleanup

async function rtt() {
  // Plain HTTP round trips (keep-alive) to each backend: Convex /version (served by the deployment in us-east-1),
  // Ember POST /api/query bench:latest on a us:/sa: shard (Worker at the edge → shard DO).
  const probe = async (u: string, init?: RequestInit) => {
    const xs: number[] = [];
    let ray = "";
    for (let i = 0; i < 10; i++) {
      const s = now();
      const r = await fetch(u, init);
      await r.arrayBuffer();
      xs.push(now() - s);
      ray = r.headers.get("cf-ray") ?? ray;
    }
    return { httpMs: summary(xs.slice(1)), edgeColo: ray.split("-")[1] ?? null };
  };
  const url = state().url;
  const q = (shard: string): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fn: "bench:latest", args: {}, shard }) });
  return {
    convex: convexUrl ? await probe(`${convexUrl}/version`) : null,
    emberUs: url ? await probe(`${url}/api/query`, q("us:rtt")) : null,
    emberSa: url ? await probe(`${url}/api/query`, q("sa:rtt")) : null,
  };
}

async function benchPhase() {
  const want = (process.env.BACKENDS ?? "convex,ember-us,ember-sa").split(",");
  const only = (process.env.ONLY ?? "a,b,c,d,f").split(",");
  const backends: Backend[] = want.map((n) => (n === "convex" ? convexBackend() : emberBackend(n === "ember-sa" ? "sa" : "us")));
  const evFile = join(EVIDENCE, "convex-vs-ember.json");
  const ev: Record<string, any> = existsSync(evFile) ? JSON.parse(readFileSync(evFile, "utf8")) : {};
  const flush = () => writeFileSync(evFile, redact(JSON.stringify(ev, null, 2)));
  ev.meta = { ...(ev.meta ?? {}), lastRun: new Date().toISOString(), runtime: `bun ${Bun.version}`, machine: machine(), durationMs: DUR, rtt: await rtt() };
  say("meta:", ev.meta);
  flush();
  for (const b of backends) {
    const key = b.name + (process.env.ROUND ? `#${process.env.ROUND}` : "");
    ev[key] ??= {};
    if (only.includes("d")) (ev[key].d = await queries(b)), flush();
    if (only.includes("a")) (ev[key].a = await hot(b)), flush();
    if (only.includes("b")) (ev[key].b = await spread(b)), flush();
    if (only.includes("c")) (ev[key].c = await fanout(b)), flush();
  }
  if (only.includes("f")) (ev.f = await cold(backends)), flush();
}

async function inventory() {
  const scripts = (await cf.call<Array<{ id: string }>>("GET", "/workers/scripts")).map((s) => s.id).filter((n) => n.startsWith("ember-spike"));
  const ns = (await cf.call<Array<{ name: string; script?: string }>>("GET", "/workers/durable_objects/namespaces?per_page=1000")).filter((n) => (n.script ?? n.name).startsWith("ember-spike"));
  const d1 = (await cf.call<Array<{ name: string }>>("GET", "/d1/database?per_page=100")).filter((d) => d.name.startsWith("ember-spike"));
  say("inventory:", { scripts, namespaces: ns.map((n) => n.name), d1: d1.map((d) => d.name) });
}

async function cleanup() {
  for (const w of [WORKER, WHERE]) {
    const r = await cf.request("DELETE", `/workers/scripts/${w}?force=true`);
    say(`DELETE ${w}:`, r.success ? "ok" : JSON.stringify(r.errors));
  }
  const d1 = (await cf.call<Array<{ uuid: string; name: string }>>("GET", `/d1/database?name=${REGISTRY}`)).find((d) => d.name === REGISTRY);
  if (d1) {
    const x = await cf.request("DELETE", `/d1/database/${d1.uuid}`);
    say(`DELETE d1 ${REGISTRY}:`, x.success ? "ok" : JSON.stringify(x.errors));
  }
  await inventory();
  rmSync(ROOT, { recursive: true, force: true });
}

const phases = process.argv.slice(2);
const order = phases.length ? phases : ["deploy", "bench", "cleanup"];
mkdirSync(EVIDENCE, { recursive: true });
say(`convex-vs-ember ${order.join(" ")} — ${new Date().toISOString()}`, machine());
try {
  for (const p of order) {
    if (p === "deploy") await deployPhase();
    else if (p === "bench") await benchPhase();
    else if (p === "where") await wherePhase();
    else if (p === "inregion") await inregionPhase();
    else if (p === "cleanup") await cleanup();
    else if (p === "inventory") await inventory();
    else throw new Error(`unknown phase ${p}`);
  }
} finally {
  writeFileSync(join(EVIDENCE, `convex-vs-ember-${order.join("-")}.txt`), logLines.join("\n") + "\n");
  process.exit(0);
}
