// S2 in production (docs/spikes/remote/latency-protocol.md §2, P2): read latency on a Durable Object that is idle vs
// one receiving 5, 20 and 100 writes/s, with the writes as SQL (what Ember does), KV put, and KV put with
// `allowUnconfirmed` (the documented opt-out, as a control). ../workers/gatebench.js, `ember-spike-lat-gate`.
//
//   bun --conditions=@freecorps/ember-source run docs/spikes/remote/scripts/latency-gate.ts <phase...>
//     deploy | bench | cleanup          ROUNDS=2 N=200 RATES=0,5,20,100 MODES=sql,kv,kvu
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { CfClient, resolveToken } from "../../../../packages/cli/src/deploy/cf.ts";
import { workerForm } from "../../../../packages/cli/src/deploy/index.ts";

const NAME = "ember-spike-lat-gate";
const ROUNDS = Number(process.env.ROUNDS ?? 2);
const N = Number(process.env.N ?? 200);
const RATES = (process.env.RATES ?? "0,5,20,100").split(",").map(Number);
const MODES = (process.env.MODES ?? "sql,kv,kvu").split(",");
const EVIDENCE = join(import.meta.dir, "../evidence");
const STATE = join(import.meta.dir, "../../../../packages/cli/.tmp/ember-spike-lat/gate-state.json");

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
const sum = (xs: number[]) => ({ n: xs.length, p50: pct(xs, 50), p95: pct(xs, 95), p99: pct(xs, 99), mean: +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1) });
function merge(key: string, value: unknown) {
  mkdirSync(EVIDENCE, { recursive: true });
  const f = join(EVIDENCE, "latency-gate.json");
  const ev: Record<string, unknown> = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {};
  ev[key] = value;
  writeFileSync(f, redact(JSON.stringify(ev, null, 2)));
}
const benchToken = (): string => {
  if (existsSync(STATE)) return JSON.parse(readFileSync(STATE, "utf8")).benchToken;
  const t = randomBytes(24).toString("base64url");
  mkdirSync(join(STATE, ".."), { recursive: true });
  writeFileSync(STATE, JSON.stringify({ benchToken: t }));
  return t;
};
const call = async (path: string, method = "POST") => (await fetch(base + path, { method, headers: { authorization: `Bearer ${benchToken()}` } })).json() as Promise<any>;

async function deployPhase() {
  const metadata = {
    main_module: "index.js",
    compatibility_date: "2026-10-01",
    bindings: [
      { type: "durable_object_namespace", name: "G", class_name: "G" },
      { type: "durable_object_namespace", name: "PROBER", class_name: "Prober" },
      { type: "secret_text", name: "BENCH_TOKEN", text: benchToken() },
    ],
    exports: { G: { type: "durable-object", storage: "sqlite", state: "created" }, Prober: { type: "durable-object", storage: "sqlite", state: "created" } },
    observability: { enabled: false },
  };
  const r = await cf.request("PUT", `/workers/scripts/${NAME}`, workerForm(metadata as any, readFileSync(join(import.meta.dir, "../workers/gatebench.js"), "utf8")));
  say(`PUT ${NAME}:`, r.success ? "ok" : r.errors);
  if (!r.success) throw new Error("deploy failed");
  await cf.call("POST", `/workers/scripts/${NAME}/subdomain`, { enabled: true, previews_enabled: false });
  for (let i = 0; i < 60; i++) {
    const res = await fetch(`${base}/where?g=warm`, { headers: { authorization: `Bearer ${benchToken()}` } }).catch(() => null);
    if (res?.status === 200) return say("reachable:", await res.json());
    await sleep(2000);
  }
  throw new Error("not reachable");
}

async function benchPhase() {
  const tag = Date.now().toString(36);
  const rows: any[] = [];
  for (let round = 0; round < ROUNDS; round++) {
    for (const mode of MODES) {
      // One object per (mode, round): its table and KV stay small; the prober is its neighbour.
      const g = `g-${mode}-${tag}-${round}`;
      const where = await call(`/where?g=${g}`, "GET");
      const rates = round % 2 ? [...RATES].reverse() : RATES;
      for (const rate of rates) {
        if (mode !== "sql" && rate === 0) continue;
        await call(`/writer?g=${g}&rate=${rate}&mode=${mode}`);
        await sleep(1500);
        const ws = await call(`/probe?g=${g}&n=${N}&via=ws`);
        const rpc = await call(`/probe?g=${g}&n=${N}&via=rpc`);
        const stop = await call(`/writer?g=${g}&rate=0`);
        const row = { round, mode, rate, where, ws: sum(ws.lat), rpc: sum(rpc.lat), writes: stop.writes };
        say("row:", { round, mode, rate, g: where.g, prober: where.prober, ws: row.ws, rpc: row.rpc });
        rows.push(row);
      }
    }
  }
  merge(`bench@${tag}`, { N, RATES, MODES, rows });
}

async function cleanup() {
  const r = await cf.request("DELETE", `/workers/scripts/${NAME}?force=true`);
  say(`DELETE ${NAME}:`, r.success ? "ok" : r.errors);
}

const phases = process.argv.slice(2);
say(`latency-gate ${phases.join(" ")} — ${new Date().toISOString()}`);
for (const p of phases) {
  if (p === "deploy") await deployPhase();
  else if (p === "bench") await benchPhase();
  else if (p === "cleanup") await cleanup();
  else throw new Error(`unknown phase ${p}`);
}
