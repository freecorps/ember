// Reactivity bench (local, Miniflare/workerd, in-memory DO SQLite): what a shard pays to keep subscribers current.
// Raw protocol sockets (hello/sub/mut, features rowdiff/ident/ack/batch) instead of EmberClient, so the harness stays
// light next to hundreds of subscribers. Server CPU is the workerd process tree's CPU time (ps), per commit.
//
//   bun --conditions=@freecorps/ember-source run docs/spikes/local-bench/reactive.ts [scenario...]
//
// Scenarios (default: all):
//   fanout-anon   N anonymous sockets on the same list (one cache entry)
//   fanout-users  N signed-in users (distinct identities) on the same list that never reads ctx.auth
//   fanout-authz  N signed-in users on a list that checks ctx.auth.require() first (the usual app query)
//   fanout-gate   N signed-in users on the same list with `authorize` (shared result; only with the new API)
//   wake          K distinct subscriptions, idle until workerd hibernates the object, then a one-shot query (first
//                 answer) and a commit that changes them all (total: until every patch arrived)
//   wake-mut      the same, the commit being the first message after the wake
//   resume        R sockets reconnect at once with `resume` (after a deploy): time until every `snap` arrives
//   sub-burst     10 sockets each send 200 `sub` in one frame (a screen of lists): shard CPU per subscription
//   fanout-page   N anonymous sockets on the same `paginate()` result (`{page, isDone, continueCursor}`), the list
//                 inside an object (compare with fanout-anon, the same list as a top-level array)
//   fanout-obj    N anonymous sockets on `{ title, items }` (a list inside an object, with a scalar beside it)
//   fanout-liked  N signed-in users on a per-user query that calls `ctx.runQuery` of the shared list (which never
//                 reads ctx.auth) and joins one per-user fact ("liked by me")
//
// Env: N (subscribers, 300), COMMITS (200), LIMIT (take(n), 50), K (wake subs, 2000), R (resume sockets, 500),
// ROUNDS (3: the median is printed), OUT (append the summary lines to this file).
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { transform } from "esbuild";
import { Miniflare } from "../../../packages/cli/node_modules/miniflare/dist/src/index.js";
import { loadProject } from "../../../packages/cli/src/config.ts";
import { init } from "../../../packages/cli/src/init.ts";
import { buildWorker } from "../../../packages/cli/src/build.ts";
import { miniflareOptions } from "../../../packages/cli/src/local.ts";
import { codegen } from "../../../packages/cli/src/codegen/index.ts";

const ROOT = join(import.meta.dir, "../../../packages/cli/.tmp/ember-reactive");
const N = Number(process.env.N ?? 300);
const COMMITS = Number(process.env.COMMITS ?? 200);
const LIMIT = Number(process.env.LIMIT ?? 50);
const K = Number(process.env.K ?? 2000);
const R = Number(process.env.R ?? 500);
const ROUNDS = Number(process.env.ROUNDS ?? 3);
const GATE = process.env.GATE !== "0";

const SCHEMA = `import { defineSchema, defineShard, defineTable, v } from "@freecorps/ember-server";
export default defineSchema({
  tables: {
    items: defineTable({ n: v.number(), sentAt: v.number(), body: v.string() }).index("by_n", ["n"]),
    other: defineTable({ n: v.number() }),
    likes: defineTable({ user: v.string(), item: v.id("items") }).index("by_user", ["user"]),
  },
  shards: { us: defineShard({ key: v.string() }) },
});
`;
const BENCH = `import { v } from "@freecorps/ember-server";
import { paginationOptsValidator } from "@freecorps/ember-server";
import { mutation, query } from "./_generated/server";
import { api } from "./_generated/api";
export const page = query({ args: { paginationOpts: paginationOptsValidator }, handler: (ctx, { paginationOpts }) => ctx.db.query("items").withIndex("by_n").order("desc").paginate(paginationOpts) });
export const obj = query({ args: { limit: v.number() }, handler: (ctx, { limit }) => ({ title: "recent", items: ctx.db.query("items").withIndex("by_n").order("desc").take(limit) }) });
export const like = mutation({ args: { item: v.id("items") }, handler: (ctx, { item }) => ctx.db.insert("likes", { user: ctx.auth.require().subject, item }) });
export const liked = query({
  args: { limit: v.number() },
  handler: (ctx, { limit }) => {
    const me = ctx.auth.require().subject;
    const items = ctx.runQuery(api.bench.recent, { limit });
    const mine = new Set(ctx.db.query("likes").withIndex("by_user", (q) => q.eq("user", me)).take(100).map((l) => l.item));
    return items.map((it) => ({ ...it, liked: mine.has(it._id) }));
  },
});
export const put = mutation({ args: { n: v.number(), sentAt: v.number(), body: v.string() }, handler: (ctx, a) => ctx.db.insert("items", a) });
export const poke = mutation({ args: {}, handler: (ctx) => ctx.db.insert("other", { n: ctx.now }) });
export const recent = query({ args: { limit: v.number(), salt: v.optional(v.number()) }, handler: (ctx, { limit }) => ctx.db.query("items").withIndex("by_n").order("desc").take(limit) });
export const recentAuthz = query({
  args: { limit: v.number() },
  handler: (ctx, { limit }) => {
    ctx.auth.require();
    return ctx.db.query("items").withIndex("by_n").order("desc").take(limit);
  },
});
${GATE ? `export const recentGate = query({
  args: { limit: v.number() },
  authorize: (ctx) => { ctx.auth.require(); },
  handler: (ctx, { limit }) => ctx.db.query("items").withIndex("by_n").order("desc").take(limit),
});` : ""}
`;
// Signed-in sockets: the token "u:<subject>" is the identity (stands in for a verified JWT).
const AUTH = `const auth = { verify: (t) => (typeof t === "string" && t.startsWith("u:") ? { subject: t.slice(2), issuer: "bench" } : null) };`;

const say = (s: string) => {
  console.log(s);
  if (process.env.OUT) appendFileSync(process.env.OUT, s + "\n");
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]!;

function cpuSeconds(): number {
  const pids = (() => {
    try {
      return execFileSync("pgrep", ["-P", String(process.pid)], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  })();
  if (!pids.length) return 0;
  const out = execFileSync("ps", ["-o", "time=", "-p", pids.join(",")], { encoding: "utf8" });
  return out.trim().split("\n").filter(Boolean).reduce((a, t) => a + t.trim().split(":").map(Number).reduce((acc, x) => acc * 60 + x, 0), 0);
}

// ------------------------------------------------------------------ raw protocol socket

type Msg = Record<string, any>;
class Sock {
  ws!: WebSocket;
  ready!: Msg;
  private waiters: Array<{ pred: (m: Msg) => boolean; resolve: (m: Msg) => void }> = [];
  onMsg: ((m: Msg) => void) | null = null;
  lastVersion = 0;
  patches = 0;
  /** Characters of the frames that carried a patch. */
  patchBytes = 0;
  static async open(base: string, shard: string, token?: string): Promise<Sock> {
    const s = new Sock();
    s.ws = new WebSocket(`${base.replace(/^http/, "ws")}/ws?shard=${encodeURIComponent(shard)}`);
    s.ws.onmessage = (e) => {
      if (e.data === "pong") return;
      const parsed = JSON.parse(String(e.data));
      const ms = Array.isArray(parsed) ? parsed : [parsed];
      if (ms.some((m: Msg) => m.t === "patch")) s.patchBytes += String(e.data).length;
      for (const m of ms) s.dispatch(m);
    };
    await new Promise((r, j) => {
      s.ws.onopen = r;
      s.ws.onerror = j;
    });
    s.send({ t: "hello", clientId: crypto.randomUUID(), protocol: 1, features: ["rowdiff", "ident", "ack", "batch", "query"], ...(token ? { token } : {}) });
    s.ready = await s.wait((m) => m.t === "ready");
    return s;
  }
  private dispatch(m: Msg) {
    if (m.t === "patch") {
      this.patches++;
      this.lastVersion = Math.max(this.lastVersion, m.version);
    }
    if (m.t === "err" && !this.waiters.length) console.error("err", m);
    this.onMsg?.(m);
    for (let i = 0; i < this.waiters.length; i++) {
      const w = this.waiters[i]!;
      if (w.pred(m)) {
        this.waiters.splice(i, 1);
        w.resolve(m);
        return;
      }
    }
  }
  wait(pred: (m: Msg) => boolean, ms = 60_000): Promise<Msg> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout")), ms);
      this.waiters.push({ pred, resolve: (m) => (clearTimeout(t), resolve(m)) });
    });
  }
  send(m: Msg | Msg[]) {
    this.ws.send(JSON.stringify(m));
  }
  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

// ------------------------------------------------------------------ project

async function start() {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  init({ dir: ROOT, project: "reactive", auth: false });
  for (const f of ["messages.ts", "crons.ts"]) rmSync(join(ROOT, "ember", f), { force: true });
  writeFileSync(join(ROOT, "ember/schema.ts"), SCHEMA);
  writeFileSync(join(ROOT, "ember/bench.ts"), BENCH);
  const project = loadProject(ROOT);
  await codegen(project);
  const build = await buildWorker(project, { minify: false });
  const patched = build.code.replace(/(const|var|let) auth = (undefined|void 0);/, AUTH);
  if (patched === build.code) throw new Error("could not install the bench auth hook");
  // Minified like `ember deploy` (no keepNames).
  build.code = (await transform(patched, { minify: true, format: "esm", target: "es2022" })).code;
  const mf = new Miniflare({ ...miniflareOptions(project, build, { persist: false, vars: { EMBER_ADMIN_TOKEN: "bench-admin" } }) } as any);
  const url = (await mf.ready).href.replace(/\/$/, "");
  return { url, mf };
}

async function inspect(url: string, shard: string): Promise<any> {
  const r = await fetch(`${url}/api/_ember/inspect?shard=${encodeURIComponent(shard)}`, { headers: { authorization: "Bearer bench-admin" } });
  return r.ok ? ((await r.json()) as any).shard : null;
}

let shardSeq = 0;
const newShard = () => `us:r${Date.now().toString(36)}${shardSeq++}`;

async function seed(url: string, shard: string, rows: number) {
  const w = await Sock.open(url, shard);
  for (let i = 0; i < rows; i += 100) {
    const batch = Array.from({ length: Math.min(100, rows - i) }, (_, j) => ({ t: "mut", mid: `s${i + j}`, fn: "bench:put", args: { n: i + j, sentAt: Date.now(), body: "x".repeat(64) } }));
    const last = batch[batch.length - 1]!.mid;
    w.send(batch);
    await w.wait((m) => m.t === "mres" && m.mid === last);
  }
  return w;
}

// ------------------------------------------------------------------ fan-out

async function fanout(url: string, mode: "anon" | "users" | "authz" | "gate" | "page" | "obj" | "liked") {
  const shard = newShard();
  const writer = await seed(url, shard, LIMIT * 2);
  const fns = { authz: "bench:recentAuthz", gate: "bench:recentGate", page: "bench:page", obj: "bench:obj", liked: "bench:liked" } as Record<string, string>;
  const fn = fns[mode] ?? "bench:recent";
  const args = mode === "page" ? { paginationOpts: { numItems: LIMIT, cursor: null } } : { limit: LIMIT };
  const anon = mode === "anon" || mode === "page" || mode === "obj";
  let ids: string[] = [];
  if (mode === "liked") {
    writer.send({ t: "q", qid: "ids", fn: "bench:recent", args: { limit: LIMIT } });
    ids = ((await writer.wait((m) => m.t === "qres" && m.qid === "ids")).value as Array<{ _id: string }>).map((d) => d._id);
  }
  const subs: Sock[] = [];
  for (let i = 0; i < N; i += 50) {
    const part = await Promise.all(
      Array.from({ length: Math.min(50, N - i) }, async (_, j) => {
        const s = await Sock.open(url, shard, anon ? undefined : `u:user${i + j}`);
        if (mode === "liked") {
          // Every user likes two items of the list: each user's value differs.
          const k = (i + j) % ids.length;
          s.send([{ t: "mut", mid: "l1", fn: "bench:like", args: { item: ids[k] } }, { t: "mut", mid: "l2", fn: "bench:like", args: { item: ids[(k + 7) % ids.length] } }]);
          await s.wait((m) => m.t === "mres" && m.mid === "l2");
        }
        s.send({ t: "sub", qid: 1, fn, args });
        const snap = await s.wait((m) => m.t === "snap" || m.t === "err");
        if (snap.t === "err") throw new Error(`${fn}: ${snap.code} ${snap.message}`);
        return s;
      }),
    );
    subs.push(...part);
  }
  const before = await inspect(url, shard);
  await sleep(200);
  for (const s of subs) s.patchBytes = s.patches = 0;
  const lat: number[] = [];
  let n = LIMIT * 2;
  const run = async (count: number, record: boolean) => {
    for (let c = 0; c < count; c++) {
      const t0 = performance.now();
      const mid = `w${n}`;
      writer.send({ t: "mut", mid, fn: "bench:put", args: { n: n++, sentAt: Date.now(), body: "y".repeat(64) } });
      const res = await writer.wait((m) => m.t === "mres" && m.mid === mid);
      const v = res.version as number;
      await Promise.all(subs.map((s) => (s.lastVersion >= v ? null : s.wait((m) => m.t === "patch" && m.version >= v))));
      if (record) lat.push(performance.now() - t0);
    }
  };
  await run(20, false); // warm
  const cpu0 = cpuSeconds();
  const t0 = performance.now();
  await run(COMMITS, true);
  const wall = performance.now() - t0;
  const cpu = cpuSeconds() - cpu0;
  const after = await inspect(url, shard);
  for (const s of [...subs, writer]) s.close();
  const patches = subs.reduce((a, s) => a + s.patches, 0);
  return {
    perCommitCpuUs: (cpu / COMMITS) * 1e6,
    bytesPerPatch: patches ? subs.reduce((a, s) => a + s.patchBytes, 0) / patches : null,
    commitsPerSec: (COMMITS / wall) * 1000,
    p50: pct(lat, 50),
    p99: pct(lat, 99),
    queries: after?.queries ?? before?.queries ?? null,
    rerunsPerCommit: after && before ? (after.stats.reruns - before.stats.reruns) / (COMMITS + 20) : null,
  };
}

// ------------------------------------------------------------------ wake (hibernation: the shard restarts, sockets stay)

async function wake(url: string, first: "q" | "mut") {
  const shard = newShard();
  const writer = await seed(url, shard, LIMIT * 2);
  const socks: Sock[] = [];
  const per = 200;
  for (let i = 0; i < K; i += per) {
    const s = await Sock.open(url, shard);
    const msgs = Array.from({ length: Math.min(per, K - i) }, (_, j) => ({ t: "sub", qid: j + 1, fn: "bench:recent", args: { limit: LIMIT, salt: i + j } }));
    const last = msgs.length;
    s.send(msgs);
    await s.wait((m) => m.t === "snap" && m.qid === last);
    socks.push(s);
  }
  // workerd hibernates an idle object after ~10 s (its sockets stay accepted): nothing may reach the shard meanwhile.
  await sleep(Number(process.env.IDLE_MS ?? 15_000));
  const cpu0 = cpuSeconds();
  const t0 = performance.now();
  let firstMs: number;
  if (first === "q") {
    // First message after the wake: a one-shot query waits for the boot (blockConcurrencyWhile).
    writer.send({ t: "q", qid: "first", fn: "bench:recent", args: { limit: 1, salt: -1 } });
    await writer.wait((m) => m.t === "qres" && m.qid === "first");
    firstMs = performance.now() - t0;
  }
  // A commit that changes every subscription: each must get a patch (nothing lost after the wake).
  writer.send({ t: "mut", mid: "after-wake", fn: "bench:put", args: { n: 1e9, sentAt: Date.now(), body: "z" } });
  const res = await writer.wait((m) => m.t === "mres" && m.mid === "after-wake");
  if (first === "mut") firstMs = performance.now() - t0;
  await Promise.all(socks.map((s) => (s.lastVersion >= res.version ? null : s.wait((m) => m.t === "patch" && m.version >= res.version))));
  const totalMs = performance.now() - t0;
  const cpu = cpuSeconds() - cpu0;
  const info = await inspect(url, shard);
  for (const s of [...socks, writer]) s.close();
  // `rebuiltSubs` = K proves the object really hibernated and rebuilt its registry.
  return { firstMs: firstMs!, totalMs, cpuMs: cpu * 1000, rebuiltSubs: info?.stats?.rebuiltSubs ?? null };
}

// ------------------------------------------------------------------ resume (every socket reconnects at once)

async function resume(url: string) {
  const shard = newShard();
  const writer = await seed(url, shard, LIMIT * 2);
  const qids = 4;
  // Each socket subscribes to `qids` lists shared with the others (`salt` 0..3): R sockets, 4 distinct queries.
  const held: Array<{ resume: Msg[] }> = [];
  for (let i = 0; i < R; i += 50) {
    const part = await Promise.all(
      Array.from({ length: Math.min(50, R - i) }, async () => {
        const s = await Sock.open(url, shard);
        const msgs = Array.from({ length: qids }, (_, q) => ({ t: "sub", qid: q + 1, fn: "bench:recent", args: { limit: LIMIT, salt: q } }));
        const snaps: Msg[] = [];
        s.onMsg = (m) => m.t === "snap" && snaps.push(m);
        s.send(msgs);
        await s.wait((m) => m.t === "snap" && m.qid === qids);
        s.close();
        return { resume: msgs.map((m, q) => ({ ...m, resume: { version: snaps[q]!.version, epoch: s.ready.epoch, ik: snaps[q]!.ik } })) };
      }),
    );
    held.push(...part);
  }
  // Commits the lists do not read (another table) since the snapshots: resume has to check the change log.
  for (let i = 0; i < 50; i++) {
    writer.send({ t: "mut", mid: `p${i}`, fn: "bench:poke", args: {} });
    await writer.wait((m) => m.t === "mres" && m.mid === `p${i}`);
  }
  // The sockets reconnect first (in chunks: the local server refuses hundreds of simultaneous handshakes), then every
  // `sub` with `resume` reaches the shard at once: what the shard pays for a reconnect storm, without the handshakes.
  const socks: Sock[] = [];
  for (let i = 0; i < held.length; i += 50) socks.push(...(await Promise.all(held.slice(i, i + 50).map(() => Sock.open(url, shard)))));
  await sleep(300);
  let unchanged = 0;
  const cpu0 = cpuSeconds();
  const t0 = performance.now();
  await Promise.all(
    socks.map((s, i) => {
      s.onMsg = (m) => m.t === "snap" && m.unchanged && unchanged++;
      const done = s.wait((m) => m.t === "snap" && m.qid === qids);
      s.send(held[i]!.resume);
      return done;
    }),
  );
  const ms = performance.now() - t0;
  const cpu = cpuSeconds() - cpu0;
  for (const s of [...socks, writer]) s.close();
  return { ms, cpuMs: cpu * 1000, unchanged: unchanged / (R * qids) };
}

// ------------------------------------------------------------------ subscribe burst (a client opening a screen of lists)

async function subBurst(url: string) {
  const shard = newShard();
  const writer = await seed(url, shard, 20);
  const per = 200;
  const S = 10;
  const socks: Sock[] = [];
  for (let i = 0; i < S; i++) socks.push(await Sock.open(url, shard));
  await sleep(200);
  const cpu0 = cpuSeconds();
  const t0 = performance.now();
  await Promise.all(
    socks.map((s, i) => {
      // Small results (limit 1) so the frame's own work (registration, attachment) dominates, not the queries.
      const msgs = Array.from({ length: per }, (_, j) => ({ t: "sub", qid: j + 1, fn: "bench:recent", args: { limit: 1, salt: i * per + j } }));
      const done = s.wait((m) => m.t === "snap" && m.qid === per);
      s.send(msgs);
      return done;
    }),
  );
  const ms = performance.now() - t0;
  const cpu = cpuSeconds() - cpu0;
  for (const s of [...socks, writer]) s.close();
  return { ms, cpuMs: cpu * 1000, perSubUs: ((cpu * 1e6) / (S * per)) };
}

// ------------------------------------------------------------------ main

const all = ["fanout-anon", "fanout-users", "fanout-authz", ...(GATE ? ["fanout-gate"] : []), "wake", "wake-mut", "resume", "sub-burst", "fanout-page", "fanout-obj", "fanout-liked"];
const chosen = process.argv.slice(2).length ? process.argv.slice(2) : all;
const { url, mf } = await start();
say(`# reactive bench ${new Date().toISOString()} N=${N} COMMITS=${COMMITS} LIMIT=${LIMIT} K=${K} R=${R} rounds=${ROUNDS} ${process.env.LABEL ?? ""}`);
for (const sc of chosen) {
  const runs: Array<Record<string, number | null>> = [];
  for (let i = 0; i < ROUNDS; i++) {
    if (sc.startsWith("fanout-")) runs.push(await fanout(url, sc.slice(7) as "anon"));
    else if (sc === "wake") runs.push(await wake(url, "q"));
    else if (sc === "wake-mut") runs.push(await wake(url, "mut"));
    else if (sc === "resume") runs.push(await resume(url));
    else if (sc === "sub-burst") runs.push(await subBurst(url));
    await sleep(500);
  }
  const keys = Object.keys(runs[0]!);
  const med = Object.fromEntries(keys.map((k) => [k, runs.every((r) => r[k] !== null) ? median(runs.map((r) => r[k] as number)) : null]));
  const fmt = (x: number | null) => (x === null ? "-" : x >= 100 ? x.toFixed(0) : x.toFixed(2));
  say(`${sc}: ${keys.map((k) => `${k}=${fmt(med[k] as number | null)}`).join(" ")}  (runs: ${runs.map((r) => fmt(r[keys[0]!] as number)).join(" ")})`);
}
await mf.dispose();
process.exit(0);
