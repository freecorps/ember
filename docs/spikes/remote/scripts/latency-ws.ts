// S1 in production (docs/spikes/remote/latency-protocol.md §1, P1): does permessage-deflate land on the Durable
// Object's CPU? Two copies of ../workers/wsbench.js — default flags (`ember-spike-lat-ws`) and
// `no_web_socket_compression` (`ember-spike-lat-ws-nocomp`) — and ../workers/wsagent.js (`ember-spike-lat-agent`),
// whose Durable Object agents hold the subscriber sockets inside Cloudflare, offering the extension or not.
//
//   bun --conditions=@freecorps/ember-source run docs/spikes/remote/scripts/latency-ws.ts <phase...>
//     deploy | check | bench | cpu | cleanup | inventory
//   N=300 RATE=10 (frames per second to every socket) SIZES=415,8700 VARIANTS=offer,nooffer,nocomp
//
// Each (variant, size) broadcasts for exactly one whole UTC minute; `cpu` reads that minute's cpuTime and
// outboundWebsocketMsgCount per namespace from GraphQL (durableObjectsPeriodicGroups) and divides.
// Cloudflare token: the CLI lookup (wrangler OAuth), in memory only. Bench tokens are random per process and uploaded
// as secrets. Output is redacted (account id, workers.dev subdomain, emails, local paths).
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

import { workerForm } from "../../../../packages/cli/src/deploy/index.ts";
import { CfClient, resolveToken } from "../../../../packages/cli/src/deploy/cf.ts";

const N = Number(process.env.N ?? 300);
const PER_AGENT = 5;
const RATE = Number(process.env.RATE ?? 10);
const SIZES = (process.env.SIZES ?? "415,8700").split(",").map(Number);
const VARIANTS = (process.env.VARIANTS ?? "offer,nooffer,nocomp").split(",");
const WS = "ember-spike-lat-ws";
const WS_NOCOMP = "ember-spike-lat-ws-nocomp";
const AGENT = "ember-spike-lat-agent";
const STATE = join(import.meta.dir, "../../../../packages/cli/.tmp/ember-spike-lat/ws-state.json");
const EVIDENCE = join(import.meta.dir, "../evidence");
const REPO = join(import.meta.dir, "../../../..");

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
const say = (...xs: unknown[]) => console.log(redact(xs.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const urlOf = (w: string) => `https://${w}.${subdomain}.workers.dev`;

type State = { benchToken?: string; loadgenToken?: string; runs?: Array<Record<string, unknown>> };
const state = (): State => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {});
const save = (s: State) => {
  mkdirSync(dirname(STATE), { recursive: true });
  writeFileSync(STATE, JSON.stringify({ ...state(), ...s }, null, 2));
};
function merge(key: string, value: unknown) {
  mkdirSync(EVIDENCE, { recursive: true });
  const f = join(EVIDENCE, "latency-ws.json");
  const ev: Record<string, unknown> = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {};
  ev[key] = value;
  writeFileSync(f, redact(JSON.stringify(ev, null, 2)));
}

// ------------------------------------------------------------------ deploy

async function deployPhase() {
  const benchToken = state().benchToken ?? randomBytes(24).toString("base64url");
  const loadgenToken = state().loadgenToken ?? randomBytes(24).toString("base64url");
  save({ benchToken, loadgenToken });
  const wsCode = readFileSync(join(import.meta.dir, "../workers/wsbench.js"), "utf8");
  for (const [name, flags] of [
    [WS, []],
    [WS_NOCOMP, ["no_web_socket_compression"]],
  ] as const) {
    const metadata = {
      main_module: "index.js",
      compatibility_date: "2026-10-01",
      compatibility_flags: flags,
      bindings: [
        { type: "durable_object_namespace", name: "ROOM", class_name: "Room" },
        { type: "secret_text", name: "BENCH_TOKEN", text: benchToken },
      ],
      exports: { Room: { type: "durable-object", storage: "sqlite", state: "created" } },
      observability: { enabled: false },
    };
    const r = await cf.request("PUT", `/workers/scripts/${name}`, workerForm(metadata as any, wsCode));
    say(`PUT ${name}:`, r.success ? { ok: true, startup_time_ms: (r.result as any)?.startup_time_ms } : r.errors);
    if (!r.success) throw new Error(`deploy ${name} failed`);
    await cf.call("POST", `/workers/scripts/${name}/subdomain`, { enabled: true, previews_enabled: false });
  }
  const agentCode = readFileSync(join(import.meta.dir, "../workers/wsagent.js"), "utf8");
  const metadata = {
    main_module: "index.js",
    compatibility_date: "2026-10-01",
    compatibility_flags: [],
    bindings: [
      { type: "durable_object_namespace", name: "AGENT", class_name: "Agent" },
      { type: "secret_text", name: "LOADGEN_TOKEN", text: loadgenToken },
    ],
    exports: { Agent: { type: "durable-object", storage: "sqlite", state: "created" } },
    observability: { enabled: false },
  };
  const r = await cf.request("PUT", `/workers/scripts/${AGENT}`, workerForm(metadata as any, agentCode));
  say(`PUT ${AGENT}:`, r.success ? { ok: true } : r.errors);
  if (!r.success) throw new Error("deploy agent failed");
  await cf.call("POST", `/workers/scripts/${AGENT}/subdomain`, { enabled: true, previews_enabled: false });
  for (const w of [WS, WS_NOCOMP]) {
    for (let i = 0; i < 60; i++) {
      const res = await fetch(`${urlOf(w)}/where`, { headers: { authorization: `Bearer ${benchToken}` } }).catch(() => null);
      if (res?.status === 200) {
        say(`${w} reachable:`, await res.json());
        break;
      }
      await sleep(2000);
    }
  }
}

// ------------------------------------------------------------------ check: the real 101 seen from this laptop

async function checkPhase() {
  const { benchToken } = state();
  const out: Record<string, unknown> = {};
  for (const w of [WS, WS_NOCOMP]) {
    const room = `laptop-${Date.now().toString(36)}`;
    const script = `
      const WebSocket = require(${JSON.stringify(join(REPO, "node_modules/.bun/ws@8.21.0/node_modules/ws"))});
      const [url, deflate] = process.argv.slice(1);
      const ws = new WebSocket(url, { perMessageDeflate: deflate === "1" });
      let ext = null, n = 0, chars = 0;
      ws.on("upgrade", (r) => (ext = r.headers["sec-websocket-extensions"] ?? "(none)"));
      ws.on("message", (d) => { n++; chars += d.length; });
      ws.on("open", () => console.log(JSON.stringify({ open: true, ext })));
      process.stdin.on("data", () => { console.log(JSON.stringify({ ext, n, chars, wire: ws._socket.bytesRead })); ws.terminate(); process.exit(0); });
    `;
    for (const deflate of ["1", "0"]) {
      const { spawn } = await import("node:child_process");
      const p = spawn("node", ["-e", script, `${urlOf(w).replace("https", "wss")}/ws?room=${room}-${deflate}`, deflate], { stdio: ["pipe", "pipe", "inherit"] });
      const lines: string[] = [];
      p.stdout.on("data", (d) => lines.push(...String(d).trim().split("\n")));
      for (let i = 0; i < 100 && !lines.length; i++) await sleep(100);
      const h = { authorization: `Bearer ${benchToken}` };
      await fetch(`${urlOf(w)}/prepare?room=${room}-${deflate}&size=415`, { method: "POST", headers: h });
      const seen = await (await fetch(`${urlOf(w)}/seen?room=${room}-${deflate}`, { headers: h })).json();
      await fetch(`${urlOf(w)}/broadcast?room=${room}-${deflate}&reps=100`, { method: "POST", headers: h });
      await sleep(3000);
      p.stdin.write("x\n");
      for (let i = 0; i < 50 && lines.length < 2; i++) await sleep(100);
      const where = await (await fetch(`${urlOf(w)}/where`, { headers: h })).json();
      const r = { clientOffers: deflate === "1", seenByDO: seen, laptop: lines.map((l) => JSON.parse(l)).pop(), worker: where };
      say(`check ${w} offer=${deflate}:`, r);
      out[`${w}/offer=${deflate}`] = r;
    }
  }
  merge(`check@${new Date().toISOString()}`, out);
}

// ------------------------------------------------------------------ bench

async function benchVariant(variant: string, tag: string) {
  const { benchToken, loadgenToken } = state();
  const worker = variant === "nocomp" ? WS_NOCOMP : WS;
  const offer = variant !== "nooffer";
  const room = `r-${variant}-${tag}`;
  const h = { authorization: `Bearer ${benchToken}` };
  // Hold time: open (≤ 60 s) + wait for a minute boundary (≤ 60 s) + one minute per size + slack.
  const holdMs = (60 + 60 + 60 * SIZES.length + 30) * 1000;
  const tasks = Array.from({ length: N / PER_AGENT }, () => ({ room, sockets: PER_AGENT, offer, holdMs }));
  const agents = fetch(`${urlOf(AGENT)}/run`, { method: "POST", headers: { authorization: `Bearer ${loadgenToken}` }, body: JSON.stringify({ target: urlOf(worker), tasks, prefix: `${variant}-${tag}` }), timeout: false } as any).then((r) => r.json());
  let seen: any = null;
  for (let i = 0; i < 60; i++) {
    seen = await (await fetch(`${urlOf(worker)}/seen?room=${room}`, { headers: h })).json();
    if (seen.sockets >= N) break;
    await sleep(1000);
  }
  say(`[${variant}] sockets open:`, seen);
  const windows: Array<Record<string, unknown>> = [];
  for (const size of SIZES) {
    const prep = await (await fetch(`${urlOf(worker)}/prepare?room=${room}&size=${size}`, { method: "POST", headers: h })).json();
    // Start 0.5 s into the next whole minute, stop 0.5 s before it ends: the whole minute bucket is this case.
    const now = Date.now();
    const minute = Math.ceil((now + 500) / 60000) * 60000;
    await sleep(minute + 500 - Date.now());
    let sent = 0;
    let calls = 0;
    const rtts: number[] = [];
    while (Date.now() < minute + 59_000) {
      const t = performance.now();
      const r = (await (await fetch(`${urlOf(worker)}/broadcast?room=${room}&reps=${RATE}`, { method: "POST", headers: h })).json()) as any;
      rtts.push(performance.now() - t);
      sent += r.sent;
      calls++;
      const wait = 1000 - (performance.now() - t);
      if (wait > 0) await sleep(wait);
    }
    const w = { variant, worker, offer, size, frameBytes: prep.bytes, minute: new Date(minute).toISOString(), calls, sent, broadcastRttP50: rtts.sort((a, b) => a - b)[Math.floor(rtts.length / 2)] };
    say(`[${variant}] window:`, w);
    windows.push(w);
  }
  await fetch(`${urlOf(worker)}/close?room=${room}`, { headers: h });
  const res = (await agents) as any;
  const results = res.results as any[];
  const agg = {
    agents: results.length,
    failed: results.filter((r) => !r.ok).length,
    firstFailure: results.find((r) => !r.ok)?.failed?.slice(0, 300) ?? null,
    sockets: results.reduce((a, r) => a + (r.sockets ?? 0), 0),
    ext101: results.reduce((acc: Record<string, number>, r) => {
      for (const [k, v] of Object.entries(r.ext ?? {})) acc[k] = (acc[k] ?? 0) + (v as number);
      return acc;
    }, {}),
    frames: results.reduce((a, r) => a + (r.frames ?? 0), 0),
    chars: results.reduce((a, r) => a + (r.chars ?? 0), 0),
    badJson: results.reduce((a, r) => a + (r.badJson ?? 0), 0),
    agentColos: results.reduce((acc: Record<string, number>, r) => ((acc[r.colo ?? "?"] = (acc[r.colo ?? "?"] ?? 0) + 1), acc), {}),
    coordinator: res.coordinator,
  };
  say(`[${variant}] agents:`, agg);
  return { variant, room, doColo: seen?.colo, offersSeenByDO: seen?.offers, windows, agents: agg };
}

async function benchPhase() {
  const tag = Date.now().toString(36);
  const runs: Array<Record<string, unknown>> = [];
  for (const v of VARIANTS) runs.push(await benchVariant(v, tag));
  save({ runs: [...(state().runs ?? []), ...runs] });
  merge(`bench@${tag}`, { N, RATE, SIZES, runs });
}

// ------------------------------------------------------------------ cpu (account analytics)

async function namespaceIds(): Promise<Record<string, string>> {
  const ns = await cf.call<Array<{ id: string; name: string; script?: string; class?: string }>>("GET", "/workers/durable_objects/namespaces?per_page=1000");
  const out: Record<string, string> = {};
  for (const n of ns) if ((n.script ?? "").startsWith("ember-spike-lat-")) out[n.script!] = n.id;
  return out;
}

async function cpuPhase() {
  const runs = state().runs ?? [];
  const ids = await namespaceIds();
  const windows = runs.flatMap((r: any) => r.windows as any[]);
  if (!windows.length) throw new Error("no bench windows recorded");
  const from = windows.map((w) => w.minute).sort()[0];
  const to = new Date(Math.max(...windows.map((w) => Date.parse(w.minute))) + 60_000).toISOString();
  const rows: any[] = [];
  for (const [script, id] of Object.entries(ids)) {
    if (script === AGENT) continue;
    const q = `query($a: String!, $ns: String!, $from: Time!, $to: Time!) { viewer { accounts(filter: { accountTag: $a }) {
      durableObjectsPeriodicGroups(limit: 1000, filter: { namespaceId: $ns, datetimeMinute_geq: $from, datetimeMinute_lt: $to }, orderBy: [datetimeMinute_ASC]) {
        dimensions { datetimeMinute } sum { cpuTime activeTime outboundWebsocketMsgCount inboundWebsocketMsgCount }
      } } } }`;
    const r = (await (await fetch("https://api.cloudflare.com/client/v4/graphql", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ query: q, variables: { a: account, ns: id, from, to } }) })).json()) as any;
    if (r.errors) say(`graphql ${script}:`, r.errors);
    for (const g of r.data?.viewer?.accounts?.[0]?.durableObjectsPeriodicGroups ?? []) rows.push({ script, minute: g.dimensions.datetimeMinute, ...g.sum });
  }
  const table = windows.map((w) => {
    const row = rows.find((x) => x.script === w.worker && Date.parse(x.minute) === Date.parse(w.minute));
    return {
      variant: w.variant,
      size: w.size,
      minute: w.minute,
      sentByDriver: w.sent,
      outboundWs: row?.outboundWebsocketMsgCount ?? null,
      cpuMs: row ? Math.round(row.cpuTime / 1000) : null,
      cpuUsPerSend: row && row.outboundWebsocketMsgCount ? +(row.cpuTime / row.outboundWebsocketMsgCount).toFixed(2) : null,
      activeMs: row ? Math.round(row.activeTime / 1000) : null,
    };
  });
  for (const t of table) say("cpu:", t);
  merge(`cpu@${new Date().toISOString()}`, { rows, table });
}

// ------------------------------------------------------------------ cleanup / inventory

async function inventory() {
  const scripts = (await cf.call<Array<{ id: string }>>("GET", "/workers/scripts")).map((s) => s.id).filter((n) => n.startsWith("ember-spike"));
  const ns = (await cf.call<Array<{ name: string; script?: string }>>("GET", "/workers/durable_objects/namespaces?per_page=1000")).filter((n) => (n.script ?? n.name).startsWith("ember-spike"));
  const d1 = (await cf.call<Array<{ name: string }>>("GET", "/d1/database?per_page=100")).filter((d) => d.name.startsWith("ember-spike"));
  const r = { scripts, namespaces: ns.map((n) => n.name), d1: d1.map((d) => d.name) };
  say("inventory:", r);
  return r;
}

async function cleanup() {
  for (const w of [WS, WS_NOCOMP, AGENT]) {
    const r = await cf.request("DELETE", `/workers/scripts/${w}?force=true`);
    say(`DELETE ${w}:`, r.success ? "ok" : JSON.stringify(r.errors).slice(0, 200));
  }
  merge(`cleanup@${new Date().toISOString()}`, await inventory());
  rmSync(STATE, { force: true });
}

const phases = process.argv.slice(2);
say(`latency-ws ${phases.join(" ")} — ${new Date().toISOString()} N=${N} RATE=${RATE} SIZES=${SIZES} VARIANTS=${VARIANTS}`);
for (const p of phases) {
  if (p === "deploy") await deployPhase();
  else if (p === "check") await checkPhase();
  else if (p === "bench") await benchPhase();
  else if (p === "cpu") await cpuPhase();
  else if (p === "cleanup") await cleanup();
  else if (p === "inventory") await inventory();
  else throw new Error(`unknown phase ${p}`);
}
