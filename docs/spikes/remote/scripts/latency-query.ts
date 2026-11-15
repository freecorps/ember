// S4 in production (docs/spikes/remote/latency-protocol.md §4, P4): where a query's time goes from this laptop with
// the `main` runtime. The `ember init` app (no auth) as `ember-spike-lat-q`, behind a probe module that also times
// the Worker → shard RPC, plus a `Where` Durable Object created the same way as the shard (from the Worker, no hint),
// whose colo stands in for the shard's (a shard cannot report its own).
//
//   bun --conditions=@freecorps/ember-source run docs/spikes/remote/scripts/latency-query.ts <phase...>
//     bench | cleanup          N=200 ROUNDS=2
//
// Per round, interleaved one call of each per iteration, sequential:
//   health  GET /health              laptop ↔ Worker (edge) only
//   rpc     GET /__probe             laptop ↔ Worker + the Worker's own timing of the RPC to the shard
//   http    POST /api/query          messages:list {limit: 10}, what EmberClient.query does
//   ws      `q` over an open socket  what a subscription-less socket query does
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadProject } from "../../../../packages/cli/src/config.ts";
import { init } from "../../../../packages/cli/src/init.ts";
import { buildWorker } from "../../../../packages/cli/src/build.ts";
import { codegen } from "../../../../packages/cli/src/codegen/index.ts";
import { CfClient, resolveToken } from "../../../../packages/cli/src/deploy/cf.ts";

const NAME = "ember-spike-lat-q";
const N = Number(process.env.N ?? 200);
const ROUNDS = Number(process.env.ROUNDS ?? 2);
const TMP = join(import.meta.dir, "../../../../packages/cli/.tmp/ember-spike-lat/query");
const EVIDENCE = join(import.meta.dir, "../evidence");

const token = resolveToken();
const auth = { authorization: `Bearer ${token}` };
const account = ((await (await fetch("https://api.cloudflare.com/client/v4/accounts", { headers: auth })).json()) as any).result[0].id as string;
const cf = new CfClient({ accountId: account, token });
const subdomain = ((await cf.request<{ subdomain?: string }>("GET", "/workers/subdomain")).result?.subdomain ?? "") as string;
const redact = (s: string) => {
  let out = s.split(account).join("<ACCOUNT_ID>");
  if (subdomain) out = out.split(subdomain).join("<subdomain>");
  return out.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "<email>").replace(/\/Users\/[^\s"']+/g, "<path>");
};
const say = (...xs: unknown[]) => console.log(redact(xs.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const base = `https://${NAME}.${subdomain}.workers.dev`;
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]!;
const sum = (xs: number[]) => ({ n: xs.length, p50: +pct(xs, 50).toFixed(1), p95: +pct(xs, 95).toFixed(1), p99: +pct(xs, 99).toFixed(1) });
function merge(key: string, value: unknown) {
  mkdirSync(EVIDENCE, { recursive: true });
  const f = join(EVIDENCE, "latency-query.json");
  const ev: Record<string, unknown> = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {};
  ev[key] = value;
  writeFileSync(f, redact(JSON.stringify(ev, null, 2)));
}

const PROBE = `
import worker, { Shard, System } from "./ember.js";
import { DurableObject } from "cloudflare:workers";
export { Shard, System };
export class Where extends DurableObject {
  async colo() { return (this.c ??= /colo=(\\w+)/.exec(await (await fetch("https://www.cloudflare.com/cdn-cgi/trace")).text())?.[1] ?? null); }
}
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === "/__probe") {
      const shard = url.searchParams.get("shard") ?? "global:main";
      const t0 = Date.now();
      await env.SHARD.get(env.SHARD.idFromName(shard)).warm(shard);
      return Response.json({ rpcMs: Date.now() - t0, workerColo: req.cf?.colo ?? null });
    }
    if (url.pathname === "/__where") return Response.json({ workerColo: req.cf?.colo ?? null, doColo: await env.WHERE.get(env.WHERE.idFromName("global:main")).colo() });
    return worker.fetch(req, env, ctx);
  },
};`;

async function deployPhase() {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  init({ dir: TMP, project: "lat-q", auth: false });
  const project = loadProject(TMP);
  await codegen(project);
  const b = await buildWorker(project, { outDir: join(TMP, ".build"), minify: true });
  const classes = ["Shard", "System", "Where"];
  const metadata = {
    main_module: "index.js",
    compatibility_date: "2026-10-01",
    compatibility_flags: ["nodejs_compat"],
    bindings: [...classes.map((c) => ({ type: "durable_object_namespace", name: c.toUpperCase(), class_name: c })), { type: "plain_text", name: "EMBER_ENV", text: "bench" }, { type: "plain_text", name: "EMBER_PROJECT", text: "lat-q" }],
    exports: Object.fromEntries(classes.map((c) => [c, { type: "durable-object", storage: "sqlite", state: "created" }])),
    observability: { enabled: false },
  };
  const fd = new FormData();
  fd.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  fd.append("index.js", new Blob([PROBE], { type: "application/javascript+module" }), "index.js");
  fd.append("ember.js", new Blob([b.code], { type: "application/javascript+module" }), "ember.js");
  const r = await cf.request("PUT", `/workers/scripts/${NAME}`, fd);
  if (!r.success) throw new Error(JSON.stringify(r.errors));
  await cf.call("POST", `/workers/scripts/${NAME}/subdomain`, { enabled: true, previews_enabled: false });
  for (let i = 0; i < 60; i++) {
    const res = await fetch(`${base}/health`).catch(() => null);
    if (res?.status === 200) break;
    await sleep(1000);
  }
  for (let i = 0; i < 30; i++) {
    await fetch(`${base}/api/mutation`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fn: "messages:send", args: { channel: "c", author: "bench", body: `hello ${i}` }, shard: "global:main" }) });
  }
  say("deployed, seeded:", await (await fetch(`${base}/__where`)).json());
}

async function socket(): Promise<{ q: (i: number) => Promise<number>; close: () => void }> {
  const ws = new WebSocket(`${base.replace("https", "wss")}/ws?shard=global:main`);
  const waiters = new Map<string, () => void>();
  let ready: () => void;
  const isReady = new Promise<void>((r) => (ready = r));
  ws.onmessage = (e) => {
    if (e.data === "pong") return;
    const parsed = JSON.parse(String(e.data));
    for (const m of Array.isArray(parsed) ? parsed : [parsed]) {
      if (m.t === "ready") ready();
      if (m.t === "qres") waiters.get(String(m.qid))?.();
    }
  };
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  ws.send(JSON.stringify({ t: "hello", clientId: crypto.randomUUID(), protocol: 1, features: ["rowdiff", "vdiff", "ident", "ack", "batch", "query"] }));
  await isReady;
  return {
    q: (i) =>
      new Promise((resolve) => {
        const qid = `q${i}`;
        const t = performance.now();
        waiters.set(qid, () => (waiters.delete(qid), resolve(performance.now() - t)));
        ws.send(JSON.stringify({ t: "q", qid, fn: "messages:list", args: { channel: "c", limit: 10 } }));
      }),
    close: () => ws.close(),
  };
}

async function benchPhase() {
  await deployPhase();
  const rounds: any[] = [];
  for (let round = 0; round < ROUNDS; round++) {
    const s = await socket();
    const lat = { health: [] as number[], rpcLaptop: [] as number[], rpcWorker: [] as number[], http: [] as number[], ws: [] as number[] };
    const colos = new Set<string>();
    for (let i = 0; i < N; i++) {
      let t = performance.now();
      await (await fetch(`${base}/health`)).text();
      lat.health.push(performance.now() - t);
      t = performance.now();
      const p = (await (await fetch(`${base}/__probe`)).json()) as { rpcMs: number; workerColo: string };
      lat.rpcLaptop.push(performance.now() - t);
      lat.rpcWorker.push(p.rpcMs);
      colos.add(p.workerColo);
      t = performance.now();
      await (await fetch(`${base}/api/query`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fn: "messages:list", args: { channel: "c", limit: 10 }, shard: "global:main" }) })).text();
      lat.http.push(performance.now() - t);
      lat.ws.push(await s.q(i));
    }
    s.close();
    const where = await (await fetch(`${base}/__where`)).json();
    const row = { round, where, workerColos: [...colos], health: sum(lat.health), rpcLaptop: sum(lat.rpcLaptop), rpcWorker: sum(lat.rpcWorker), http: sum(lat.http), ws: sum(lat.ws) };
    say("round:", row);
    rounds.push(row);
    await sleep(5000);
  }
  merge(`bench@${new Date().toISOString()}`, { N, rounds });
}

async function cleanup() {
  const r = await cf.request("DELETE", `/workers/scripts/${NAME}?force=true`);
  say(`DELETE ${NAME}:`, r.success ? "ok" : r.errors);
}

const phases = process.argv.slice(2);
say(`latency-query ${phases.join(" ")} — ${new Date().toISOString()}`);
for (const p of phases) {
  if (p === "bench") await benchPhase();
  else if (p === "cleanup") await cleanup();
  else throw new Error(`unknown phase ${p}`);
}
