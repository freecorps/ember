// Remote perf A/B for the timer-free group commit (docs/spikes/local-bench/RESULTS.md, "Remoto"): the same Ember app
// deployed twice — `ember-spike-perf-timer` (runtime of `main`, setTimeout group commit) and `ember-spike-perf-auto`
// (this branch) — driven from inside Cloudflare by the load generator (../workers/loadgen.js), plus a platform probe
// DO that times setTimeout(0), storage.sync() and friends in production.
//
//   bun --conditions=@freecorps/ember-source run docs/spikes/remote/scripts/perf-remote.ts <phase...>
//     deploy (VARIANT=auto|timer) | probe | bench | cleanup | inventory
//   BENCH_ONLY=seq,hot,spread,fan,subq   VARIANTS=timer,auto   ROUND=1
//
// The `timer` variant is deployed by running this script from a worktree of `main` (its runtime is what gets bundled):
//   PERF_STATE=<this tree>/packages/cli/.tmp/ember-spike-perf/state.json VARIANT=timer bun ... perf-remote.ts deploy
// Only `ember-spike-perf-*` resources are created. Cloudflare token: the CLI lookup (wrangler OAuth), in memory only.
// Admin and load-generator tokens are random per process (re-uploaded as secrets when needed). Output is redacted.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { loadProject } from "../../../../packages/cli/src/config.ts";
import { init } from "../../../../packages/cli/src/init.ts";
import { deploy, workerForm } from "../../../../packages/cli/src/deploy/index.ts";
import { CfClient, resolveToken } from "../../../../packages/cli/src/deploy/cf.ts";

const VARIANT = process.env.VARIANT ?? "auto";
const ROOT = join(import.meta.dir, `../../../../packages/cli/.tmp/ember-spike-perf-${VARIANT}`);
const STATE = process.env.PERF_STATE ?? join(import.meta.dir, "../../../../packages/cli/.tmp/ember-spike-perf/state.json");
const EVIDENCE = join(import.meta.dir, "../evidence");
// One project per variant (the registry ties a project to one source checkout); env "bench".
const projectOf = (variant: string) => `spike-perf-${variant}`;
const ENV = "bench";
const REGISTRY = "ember-spike-perf-registry";
const LOADGEN = "ember-spike-perf-loadgen";
const PROBE = "ember-spike-perf-probe";
const workerOf = (variant: string) => `ember-${projectOf(variant)}-${ENV}`;
process.env.EMBER_REGISTRY_NAME = REGISTRY;

const token = resolveToken();
const auth = { authorization: `Bearer ${token}` };
const account = ((await (await fetch("https://api.cloudflare.com/client/v4/accounts", { headers: auth })).json()) as any).result[0].id as string;
const cf = new CfClient({ accountId: account, token });
const subdomain = ((await cf.request<{ subdomain?: string }>("GET", "/workers/subdomain")).result?.subdomain ?? "") as string;
const redact = (s: string) => {
  let out = s.split(account).join("<ACCOUNT_ID>");
  if (subdomain) out = out.split(subdomain).join("<subdomain>");
  return out.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "<email>").replace(/\/Users\/[^\s"']+/g, "<path>").replace(/\/private\/[^\s"']+/g, "<path>");
};
const logLines: string[] = [];
const say = (...xs: unknown[]) => {
  const line = redact(xs.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
  logLines.push(line);
  console.log(line);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pct = (xs: number[], p: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};
const summary = (xs: number[]) => ({ n: xs.length, p50: pct(xs, 50), p95: pct(xs, 95), p99: pct(xs, 99), max: xs.length ? Math.max(...xs) : null });

type State = { urls?: Record<string, string>; commits?: Record<string, string> };
const state = (): State => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {});
const save = (s: State) => {
  mkdirSync(dirname(STATE), { recursive: true });
  const cur = state();
  writeFileSync(STATE, JSON.stringify({ urls: { ...cur.urls, ...s.urls }, commits: { ...cur.commits, ...s.commits } }, null, 2));
};

// ------------------------------------------------------------------ project (the bench app of ops-e2e / loadgen)

const SCHEMA = `import { defineSchema, defineShard, defineTable, v } from "@freecorps/ember-server";
export default defineSchema({
  tables: { items: defineTable({ n: v.number(), sentAt: v.number(), body: v.string() }).index("by_n", ["n"]) },
  shards: { p: defineShard({ key: v.string() }) },
});
`;
const BENCH = `import { v } from "@freecorps/ember-server";
import { mutation, query } from "./_generated/server";
export const put = mutation({ args: { n: v.number(), sentAt: v.number(), body: v.string() }, handler: (ctx, a) => ctx.db.insert("items", a) });
export const recent = query({ args: { limit: v.optional(v.number()), salt: v.optional(v.number()) }, handler: (ctx, { limit }) => ctx.db.query("items").withIndex("by_n").order("desc").take(limit ?? 10) });
export const latest = query({ args: {}, handler: (ctx) => ctx.db.query("items").order("desc").first() });
`;

async function deployPhase() {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });
  init({ dir: ROOT, project: projectOf(VARIANT), auth: false });
  const cfg = JSON.parse(readFileSync(join(ROOT, "ember.json"), "utf8"));
  cfg.account = account;
  cfg.environments = { [ENV]: {} };
  cfg.metrics = { enabled: false };
  writeFileSync(join(ROOT, "ember.json"), JSON.stringify(cfg, null, 2));
  for (const f of ["messages.ts", "crons.ts"]) rmSync(join(ROOT, "ember", f), { force: true });
  writeFileSync(join(ROOT, "ember/schema.ts"), SCHEMA);
  writeFileSync(join(ROOT, "ember/bench.ts"), BENCH);
  const commit = (await Bun.$`git -C ${import.meta.dir} rev-parse --short HEAD`.text()).trim();
  const t = Date.now();
  const r = await deploy(loadProject(ROOT), { env: ENV, adminToken: randomBytes(24).toString("base64url"), registryName: REGISTRY, wait: { timeoutMs: 180_000 }, message: `perf-${VARIANT}`, log: (l: string) => say(l) } as any);
  save({ urls: { [VARIANT]: r.url }, commits: { [VARIANT]: commit } });
  say(`deployed ${workerOf(VARIANT)} from ${commit} in ${Date.now() - t} ms`);
}

// ------------------------------------------------------------------ platform probe (inside one DO, production)

const PROBE_JS = `import { DurableObject } from "cloudflare:workers";
const stats = (xs) => { xs.sort((a, b) => a - b); const q = (p) => +xs[Math.min(xs.length - 1, Math.floor(p * xs.length))].toFixed(3); return { n: xs.length, p50: q(0.5), p90: q(0.9), p99: q(0.99), max: +xs[xs.length - 1].toFixed(3) }; };
export class P extends DurableObject {
  constructor(ctx, env) { super(ctx, env); ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS t(id INTEGER PRIMARY KEY, v TEXT)"); }
  async fetch(req) {
    const st = this.ctx.storage, s = st.sql, out = {};
    const rep = async (label, n, fn) => { const xs = []; for (let i = 0; i < n; i++) { await st.sync(); const t = performance.now(); await fn(i); xs.push(performance.now() - t); } out[label] = stats(xs); };
    await rep("setTimeout(0)", 100, () => new Promise((r) => setTimeout(r, 0)));
    await rep("setTimeout(1)", 50, () => new Promise((r) => setTimeout(r, 1)));
    await rep("queueMicrotask", 100, () => new Promise((r) => queueMicrotask(r)));
    await rep("sync() idle", 50, () => st.sync());
    await rep("1 INSERT + sync()", 100, async () => { st.transactionSync(() => s.exec("INSERT INTO t(v) VALUES (?)", "x".repeat(64))); await st.sync(); });
    await rep("100 INSERTs in 1 tx + sync()", 30, async () => { st.transactionSync(() => { for (let i = 0; i < 100; i++) s.exec("INSERT INTO t(v) VALUES (?)", "x".repeat(64)); }); await st.sync(); });
    // Back-to-back commits without waiting: does the second sync() cover both (coalescing)?
    await rep("2 commits, then sync()", 50, async () => { st.transactionSync(() => s.exec("INSERT INTO t(v) VALUES (?)", "a")); st.transactionSync(() => s.exec("INSERT INTO t(v) VALUES (?)", "b")); await st.sync(); });
    // CPU: the clock only moves on real I/O (not even timers), so time work between two subrequests and subtract an
    // empty baseline. Large workloads keep the fetch jitter (~ms) small next to them.
    const io = () => fetch("https://www.cloudflare.com/cdn-cgi/trace").then((r) => r.arrayBuffer());
    const cpu = async (label, n, fn) => { const xs = []; for (let i = 0; i < n; i++) { await st.sync(); await io(); const t = performance.now(); fn(i); await io(); xs.push(performance.now() - t); } out[label] = stats(xs); };
    await cpu("cpu: baseline (empty)", 10, () => {});
    await cpu("cpu: JSON round trip ×100k (64 B doc)", 5, () => { const d = { n: 1, sentAt: 2, body: "x".repeat(64) }; for (let i = 0; i < 100000; i++) JSON.parse(JSON.stringify(d)); });
    await cpu("cpu: 5000 INSERTs in transactionSync", 5, () => st.transactionSync(() => { for (let i = 0; i < 5000; i++) s.exec("INSERT INTO t(v) VALUES (?)", "x".repeat(64)); }));
    await cpu("cpu: 5000 SELECT by pk", 5, () => { for (let i = 1; i <= 5000; i++) s.exec("SELECT v FROM t WHERE id = ?", i).toArray(); });
    await cpu("cpu: 5000 transactionSync (empty savepoints)", 5, () => { for (let i = 0; i < 5000; i++) st.transactionSync(() => {}); });
    const colo = /colo=(\\w+)/.exec(await (await fetch("https://www.cloudflare.com/cdn-cgi/trace")).text())?.[1] ?? null;
    return Response.json({ colo, out });
  }
}
export default { async fetch(req, env) {
  const name = new URL(req.url).searchParams.get("name") || "p";
  const r = await env.P.get(env.P.idFromName(name)).fetch("https://do/");
  return Response.json({ workerColo: req.cf?.colo ?? null, ...(await r.json()) });
} };`;

async function probePhase() {
  const metadata = {
    main_module: "index.js",
    compatibility_date: "2026-10-01",
    bindings: [{ type: "durable_object_namespace", name: "P", class_name: "P" }],
    exports: { P: { type: "durable-object", storage: "sqlite", state: "created" } },
    observability: { enabled: false },
  };
  await cf.call("PUT", `/workers/scripts/${PROBE}`, workerForm(metadata as any, PROBE_JS));
  await cf.call("POST", `/workers/scripts/${PROBE}/subdomain`, { enabled: true, previews_enabled: false });
  const base = `https://${PROBE}.${subdomain}.workers.dev`;
  for (let i = 0; i < 60; i++) {
    const r = await fetch(`${base}/?name=warm`).catch(() => null);
    if (r?.status === 200) break;
    await sleep(2000);
  }
  const runs: unknown[] = [];
  for (let i = 0; i < 3; i++) {
    const r = await fetch(`${base}/?name=probe-${i}`);
    const body = r.status === 200 ? await r.json() : { status: r.status, text: (await r.text()).slice(0, 300) };
    runs.push(body);
    say(`probe ${i}:`, body);
  }
  merge("probe", runs);
}

// ------------------------------------------------------------------ load generator

const loadgenToken = randomBytes(24).toString("base64url");
const adminToken = randomBytes(24).toString("base64url");

async function putSecret(worker: string, name: string, text: string) {
  await cf.call("PUT", `/workers/scripts/${worker}/secrets`, { name, text, type: "secret_text" });
}

async function deployLoadgen() {
  const code = readFileSync(join(import.meta.dir, "../workers/loadgen.js"), "utf8");
  const metadata = {
    main_module: "index.js",
    compatibility_date: "2026-10-01",
    compatibility_flags: [],
    bindings: [
      { type: "durable_object_namespace", name: "AGENT", class_name: "Agent" },
      { type: "secret_text", name: "LOADGEN_TOKEN", text: loadgenToken },
    ],
    exports: { Agent: { type: "durable-object", storage: "sqlite", state: "created" } },
    limits: { cpu_ms: 300_000 },
    observability: { enabled: false },
  };
  await cf.call("PUT", `/workers/scripts/${LOADGEN}`, workerForm(metadata as any, code));
  await cf.call("POST", `/workers/scripts/${LOADGEN}/subdomain`, { enabled: true, previews_enabled: false });
  const lg = `https://${LOADGEN}.${subdomain}.workers.dev`;
  const anyUrl = Object.values(state().urls ?? {})[0]!;
  for (let i = 0; i < 60; i++) {
    const r = await fetch(`${lg}/run`, { method: "POST", headers: { authorization: `Bearer ${loadgenToken}` }, body: JSON.stringify({ target: anyUrl, tasks: [] }) }).catch(() => null);
    if (r?.status === 200) return lg;
    await sleep(2000);
  }
  throw new Error("load generator not reachable");
}

async function runTasks(lg: string, target: string, label: string, tasks: any[]) {
  const runId = randomBytes(4).toString("hex");
  const t = Date.now();
  const r = await fetch(`${lg}/run`, {
    method: "POST",
    headers: { authorization: `Bearer ${loadgenToken}`, "content-type": "application/json" },
    body: JSON.stringify({ target, tasks: tasks.map((x, i) => ({ ...x, agent: `${runId}-${i}` })) }),
  });
  if (r.status !== 200) throw new Error(`${label}: loadgen ${r.status} ${(await r.text()).slice(0, 300)}`);
  const body = (await r.json()) as { results: any[]; coordinator: string };
  const failed = body.results.filter((x) => x.failed);
  if (failed.length) say(`${label}: ${failed.length} task(s) failed:`, failed.slice(0, 2).map((f) => String(f.failed).slice(0, 300)));
  say(`${label}: done in ${Date.now() - t} ms (coordinator ${body.coordinator}, agent colos ${[...new Set(body.results.map((x) => x.colo))].join(",")})`);
  return body.results;
}

async function versions(target: string, shards: string[]) {
  const out: Record<string, number> = {};
  for (let i = 0; i < shards.length; i += 50) {
    const qs = new URLSearchParams(shards.slice(i, i + 50).map((s) => ["shard", s]));
    const st = (await (await fetch(`${target}/api/_ember/status?${qs}`, { headers: { authorization: `Bearer ${adminToken}` } })).json()) as any;
    for (const s of st.shards ?? []) out[s.shard] = s.version;
  }
  return out;
}
const commitsOf = (a: Record<string, number>, b: Record<string, number>) => Object.keys(b).reduce((n, k) => n + (b[k]! - (a[k] ?? 0)), 0);

function mutReport(results: any[]) {
  const ok = results.filter((r) => r.kind === "mut" && !r.failed);
  const all = ok.flatMap((r) => r.lat);
  const wall = Math.max(...ok.map((r) => r.wallMs)) / 1000;
  const total = ok.reduce((a, r) => a + r.ok, 0);
  return { total, errors: ok.reduce((a, r) => a + r.errors, 0), firstErrors: ok.flatMap((r) => r.firstError ?? []).slice(0, 3), failedTasks: results.length - ok.length, perSecond: Math.round(total / wall), ackMs: summary(all) };
}

async function put(target: string, shard: string) {
  const r = await fetch(`${target}/api/mutation`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fn: "bench:put", args: { n: 0, sentAt: Date.now(), body: "seed" }, shard }) });
  const b = (await r.json()) as any;
  if (!b.ok) throw new Error(`seed ${shard}: ${JSON.stringify(b.error)}`);
}

async function benchVariant(lg: string, variant: string, target: string) {
  const only = (process.env.BENCH_ONLY ?? "seq,hot,spread,fan,subq").split(",");
  const tag = `${variant}-${randomBytes(2).toString("hex")}`;
  const out: Record<string, unknown> = {};
  const mut = async (key: string, label: string, shards: string[], task: (shard: string, i: number) => any, agents = shards.length) => {
    await Promise.all(shards.map((s) => put(target, s)));
    const v0 = await versions(target, shards);
    const res = await runTasks(lg, target, `[${variant}] ${label}`, Array.from({ length: agents }, (_, i) => task(shards[i % shards.length]!, i)));
    const v1 = await versions(target, shards);
    const rep = mutReport(res);
    const commits = commitsOf(v0, v1);
    out[key] = { ...rep, commits, mutationsPerCommit: +(rep.total / Math.max(1, commits)).toFixed(2) };
    say(`[${variant}] ${label}:`, out[key]);
  };
  // seq: one socket, one mutation in flight (the latency the setTimeout(0) sat on), 4 shards in parallel agents.
  if (only.includes("seq")) await mut("seq_1x1", "sequential 1 in flight × 4 shards", Array.from({ length: 4 }, (_, i) => `p:seq-${tag}-${i}`), (shard) => ({ kind: "mut", shard, sockets: 1, window: 1, durationMs: 15_000, bodyBytes: 64 }));
  // hot: one shard, 6 agents × 1 socket × window (bench.md B2).
  for (const w of only.includes("hot") ? [1, 10, 100] : []) {
    const shard = `p:hot-${tag}-w${w}`;
    await mut(`hot_6x${w}`, `hot shard 6×${w} in flight`, [shard], () => ({ kind: "mut", shard, sockets: 1, window: w, durationMs: 15_000, bodyBytes: 64 }), 6);
  }
  // batch: the same with EmberClient's protocol (features "batch" + "ack": a turn's mutations in one frame).
  for (const w of only.includes("batch") ? [1, 10, 100] : []) {
    const shard = `p:hotb-${tag}-w${w}`;
    await mut(`hotBatch_6x${w}`, `hot shard 6×${w} in flight, batch frames`, [shard], () => ({ kind: "mut", shard, sockets: 1, window: w, durationMs: 15_000, bodyBytes: 64, batch: true }), 6);
  }
  if (only.includes("batch")) await mut("spreadBatch_8x50", "spread 8 shards × 50, batch frames", Array.from({ length: 8 }, (_, i) => `p:spb-${tag}-${i}`), (shard) => ({ kind: "mut", shard, sockets: 1, window: 50, durationMs: 15_000, bodyBytes: 64, batch: true }));
  // spread: 8 shards × 50 in flight (bench.md B1).
  if (only.includes("spread")) await mut("spread_8x50", "spread 8 shards × 50", Array.from({ length: 8 }, (_, i) => `p:sp-${tag}-${i}`), (shard) => ({ kind: "mut", shard, sockets: 1, window: 50, durationMs: 15_000, bodyBytes: 64 }));
  // fan: 100 subscribers of bench:latest, one writer (20 writes, 500 ms apart) (bench.md B4).
  if (only.includes("fan")) {
    const shard = `p:fan-${tag}`;
    await put(target, shard);
    const N = 100, perAgent = 5;
    const tasks: any[] = Array.from({ length: N / perAgent }, () => ({ kind: "fanSub", shard, sockets: perAgent, durationMs: 30_000 }));
    tasks.push({ kind: "fanPut", shard, writes: 20, intervalMs: 500, startDelayMs: 12_000 });
    const res = await runTasks(lg, target, `[${variant}] fan-out to ${N}`, tasks);
    const subs = res.filter((r) => r.kind === "fanSub" && !r.failed);
    const writer = res.find((r) => r.kind === "fanPut");
    out.fan_100 = {
      subscribers: subs.reduce((a, r) => a + r.sockets, 0),
      patches: subs.reduce((a, r) => a + r.patches, 0),
      expectedPatches: subs.reduce((a, r) => a + r.sockets, 0) * 20,
      deliveryMs: summary(subs.flatMap((r) => r.lat)),
      writerAckMs: writer && !writer.failed ? summary(writer.lat) : null,
      failedAgents: res.filter((r) => r.failed).length,
    };
    say(`[${variant}] fan-out to ${N}:`, out.fan_100);
  }
  // subq: sub → snap → unsub cycles, 4 shards × window 20.
  if (only.includes("subq")) {
    const shards = Array.from({ length: 4 }, (_, i) => `p:q-${tag}-${i}`);
    await Promise.all(shards.map((s) => put(target, s)));
    const res = await runTasks(lg, target, `[${variant}] sub→snap 4 shards × 20`, shards.map((shard) => ({ kind: "subq", shard, sockets: 1, window: 20, durationMs: 10_000 })));
    const ok = res.filter((r) => r.kind === "subq" && !r.failed);
    const total = ok.reduce((a, r) => a + r.ok, 0);
    out.subq = { total, errors: ok.reduce((a, r) => a + r.errors, 0), perSecond: Math.round(total / (Math.max(...ok.map((r) => r.wallMs)) / 1000)), latencyMs: summary(ok.flatMap((r) => r.lat)) };
    say(`[${variant}] sub→snap:`, out.subq);
  }
  return out;
}

async function benchPhase() {
  const urls = state().urls ?? {};
  const variants = (process.env.VARIANTS ?? "before,after").split(",").filter((v) => urls[v]);
  if (!variants.length) throw new Error("nothing deployed (run the deploy phase)");
  for (const v of variants) await putSecret(workerOf(v), "EMBER_ADMIN_TOKEN", adminToken);
  const lg = await deployLoadgen();
  await sleep(3000); // secrets propagate
  const round = process.env.ROUND ?? "1";
  // Alternate the variants per scenario group so drift in the platform hits both alike.
  const groups = (process.env.BENCH_ONLY ?? "seq,hot,spread,fan,subq").split(",");
  const res: Record<string, Record<string, unknown>> = {};
  for (const g of groups) {
    const order = groups.indexOf(g) % 2 ? [...variants].reverse() : variants;
    for (const v of order) {
      process.env.BENCH_ONLY = g;
      Object.assign((res[v] ??= {}), await benchVariant(lg, v, urls[v]!));
    }
  }
  for (const v of variants) merge(`${v}#${round}`, { commit: state().commits?.[v], at: new Date().toISOString(), ...res[v] });
}

function merge(key: string, value: unknown) {
  const evFile = join(EVIDENCE, "perf-remote.json");
  const ev: Record<string, unknown> = existsSync(evFile) ? JSON.parse(readFileSync(evFile, "utf8")) : {};
  ev[key] = value;
  writeFileSync(evFile, redact(JSON.stringify(ev, null, 2)));
}

// ------------------------------------------------------------------ cleanup / inventory

async function inventory() {
  const scripts = (await cf.call<Array<{ id: string }>>("GET", "/workers/scripts")).map((s) => s.id).filter((n) => n.startsWith("ember-spike"));
  const ns = (await cf.call<Array<{ name: string; script?: string }>>("GET", "/workers/durable_objects/namespaces?per_page=1000")).filter((n) => (n.script ?? n.name).startsWith("ember-spike"));
  const d1 = (await cf.call<Array<{ name: string }>>("GET", "/d1/database?per_page=100")).filter((d) => d.name.startsWith("ember-spike"));
  say("inventory:", { scripts, namespaces: ns.map((n) => n.name), d1: d1.map((d) => d.name) });
}

async function cleanup() {
  // Every ember-spike-perf-* Worker (variants, loadgen, probe), then the registry.
  const scripts = (await cf.call<Array<{ id: string }>>("GET", "/workers/scripts")).map((x) => x.id).filter((n) => n.startsWith("ember-spike-perf-"));
  for (const w of scripts) {
    const r = await cf.request("DELETE", `/workers/scripts/${w}?force=true`);
    say(`DELETE ${w}:`, r.success ? "ok" : JSON.stringify(r.errors).slice(0, 200));
  }
  const d1 = (await cf.call<Array<{ uuid: string; name: string }>>("GET", `/d1/database?name=${REGISTRY}`)).find((d) => d.name === REGISTRY);
  if (d1) {
    const x = await cf.request("DELETE", `/d1/database/${d1.uuid}`);
    say(`DELETE d1 ${REGISTRY}:`, x.success ? "ok" : JSON.stringify(x.errors));
  }
  await inventory();
  rmSync(dirname(STATE), { recursive: true, force: true });
  const tmp = join(import.meta.dir, "../../../../packages/cli/.tmp");
  for (const d of existsSync(tmp) ? readdirSync(tmp) : []) if (d.startsWith("ember-spike-perf-")) rmSync(join(tmp, d), { recursive: true, force: true });
}

const phases = process.argv.slice(2);
mkdirSync(EVIDENCE, { recursive: true });
say(`perf-remote ${phases.join(" ")} (VARIANT=${VARIANT}) — ${new Date().toISOString()}`);
let exitCode = 0;
try {
  for (const p of phases) {
    if (p === "deploy") await deployPhase();
    else if (p === "probe") await probePhase();
    else if (p === "bench") await benchPhase();
    else if (p === "cleanup") await cleanup();
    else if (p === "inventory") await inventory();
    else throw new Error(`unknown phase ${p}`);
  }
} catch (e) {
  exitCode = 1;
  say("FAILED:", String((e as Error)?.stack ?? e));
} finally {
  writeFileSync(join(EVIDENCE, `perf-remote-${phases.join("-")}${phases.includes("deploy") ? `-${VARIANT}` : ""}.txt`), logLines.join("\n") + "\n");
  process.exit(exitCode);
}
