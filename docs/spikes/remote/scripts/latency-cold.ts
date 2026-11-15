// S3 in production (docs/spikes/remote/latency-protocol.md §3, P3): does the bundle size (Better Auth in every
// isolate) show up in startup and in a cold Durable Object wake? The `ember init` app is built without auth and with
// local auth (the same buildWorker as `ember deploy`, minified) and uploaded as `ember-spike-lat-cold-noauth` and
// `ember-spike-lat-cold-auth`, each behind a small probe module that times, from the Worker, the RPC that wakes a
// shard (the Worker's clock advances across that I/O).
//
//   bun --conditions=@freecorps/ember-source run docs/spikes/remote/scripts/latency-cold.ts <phase...>
//     bench | cleanup | inventory          TRIALS=6
//
// Each trial re-uploads both scripts with a new nonce (a new version: every isolate is cold), then from the laptop:
//   1. /__probe?shard=p:old    an object created in the first trial (cold isolate + wake of an existing object)
//   2. /__probe?shard=p:old    again (warm)
//   3. /__probe?shard=p:new-k  a brand-new object (creation + schema DDL, isolate already warm)
// recording the upload's startup_time_ms, the Worker-side RPC time and the laptop's request time.
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { loadProject } from "../../../../packages/cli/src/config.ts";
import { init } from "../../../../packages/cli/src/init.ts";
import * as esbuild from "esbuild";
import { authModeOf, buildWorker, WORKER_BUILD_OPTIONS, workerEntrySource } from "../../../../packages/cli/src/build.ts";
import { discover } from "../../../../packages/cli/src/modules.ts";
import { codegen } from "../../../../packages/cli/src/codegen/index.ts";
import { CfClient, resolveToken } from "../../../../packages/cli/src/deploy/cf.ts";

const TRIALS = Number(process.env.TRIALS ?? 6);
const TMP = join(import.meta.dir, "../../../../packages/cli/.tmp/ember-spike-lat/cold");
const EVIDENCE = join(import.meta.dir, "../evidence");
const NAMES = { noauth: "ember-spike-lat-cold-noauth", auth: "ember-spike-lat-cold-auth", eager: "ember-spike-lat-cold-eager" } as const;
type Kind = keyof typeof NAMES;
// KINDS=noauth,auth,eager: `auth` is the generated entry of this tree (Better Auth lazy since the S3 change), `eager`
// the same project with the previous entry (`workerEntrySource(..., "eager")`: Better Auth evaluated in every isolate).
const KINDS = (process.env.KINDS ?? "noauth,auth").split(",") as Kind[];

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
const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]! : null);
function merge(key: string, value: unknown) {
  mkdirSync(EVIDENCE, { recursive: true });
  const f = join(EVIDENCE, "latency-cold.json");
  const ev: Record<string, unknown> = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {};
  ev[key] = value;
  writeFileSync(f, redact(JSON.stringify(ev, null, 2)));
}

const PROBE = (nonce: string) => `// nonce ${nonce}
import worker, { Shard, System${"__AUTH__"} } from "./ember.js";
export { Shard, System${"__AUTH__"} };
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === "/__probe") {
      const shard = url.searchParams.get("shard");
      const t0 = Date.now();
      const r = await env.SHARD.get(env.SHARD.idFromName(shard)).warm(shard);
      const rpcMs = Date.now() - t0;
      return Response.json({ rpcMs, workerColo: req.cf?.colo ?? null, version: r.version });
    }
    return worker.fetch(req, env, ctx);
  },
};`;

async function build(kind: Kind) {
  const dir = join(TMP, kind);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  init({ dir, project: `lat-${kind === "noauth" ? "noauth" : "auth"}`, auth: kind !== "noauth" });
  const project = loadProject(dir);
  await codegen(project);
  const b = await buildWorker(project, { outDir: join(dir, ".build"), minify: true });
  if (kind !== "eager") return b.code;
  // Same options as buildWorker, with the eager entry.
  const files = discover(project.dir);
  const entry = join(dir, ".build", "entry-eager.mjs");
  writeFileSync(entry, workerEntrySource(files, authModeOf(project, files), "eager"));
  const r = await esbuild.build({ ...WORKER_BUILD_OPTIONS, entryPoints: [entry], write: false, minify: true, nodePaths: [join(import.meta.dir, "../../../../packages/cli/node_modules"), join(import.meta.dir, "../../../..")], absWorkingDir: project.root });
  return r.outputFiles![0]!.text;
}

async function upload(kind: Kind, code: string, nonce: string, secret: string) {
  const name = NAMES[kind];
  const classes = kind !== "noauth" ? ["Shard", "System", "Auth"] : ["Shard", "System"];
  const metadata = {
    main_module: "index.js",
    compatibility_date: "2026-10-01",
    compatibility_flags: ["nodejs_compat"],
    bindings: [
      ...classes.map((c) => ({ type: "durable_object_namespace", name: c.toUpperCase(), class_name: c })),
      { type: "plain_text", name: "EMBER_ENV", text: "bench" },
      { type: "plain_text", name: "EMBER_PROJECT", text: `lat-${kind}` },
      ...(kind !== "noauth" ? [{ type: "secret_text", name: "EMBER_AUTH_SECRET", text: secret }] : []),
    ],
    exports: Object.fromEntries(classes.map((c) => [c, { type: "durable-object", storage: "sqlite", state: "created" }])),
    observability: { enabled: false },
  };
  const fd = new FormData();
  fd.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  fd.append("index.js", new Blob([PROBE(nonce).replaceAll("__AUTH__", kind !== "noauth" ? ", Auth" : "")], { type: "application/javascript+module" }), "index.js");
  fd.append("ember.js", new Blob([code], { type: "application/javascript+module" }), "ember.js");
  const r = await cf.request("PUT", `/workers/scripts/${name}`, fd);
  if (!r.success) throw new Error(`upload ${name}: ${JSON.stringify(r.errors)}`);
  return (r.result as any)?.startup_time_ms as number;
}

async function probe(kind: Kind, shard: string) {
  const t = performance.now();
  const r = await fetch(`${urlOf(NAMES[kind])}/__probe?shard=${encodeURIComponent(shard)}`);
  const laptopMs = performance.now() - t;
  if (r.status !== 200) return { status: r.status, text: (await r.text()).slice(0, 200), laptopMs };
  return { ...((await r.json()) as object), laptopMs: Math.round(laptopMs) };
}

async function benchPhase() {
  const codes = {} as Record<Kind, string>;
  for (const k of KINDS) codes[k] = await build(k);
  say("bundles:", Object.fromEntries(KINDS.map((k) => [k, codes[k].length])));
  const secret = randomBytes(32).toString("base64url");
  const trials: any[] = [];
  for (let k = 0; k < TRIALS; k++) {
    // Rotate the order each trial, so no kind always goes first.
    for (const kind of KINDS.map((_, i) => KINDS[(i + k) % KINDS.length]!)) {
      const nonce = `${Date.now()}-${k}`;
      const startup = await upload(kind, codes[kind], nonce, secret);
      if (k === 0) await cf.call("POST", `/workers/scripts/${NAMES[kind]}/subdomain`, { enabled: true, previews_enabled: false });
      // The new version must be the one answering: wait until /health answers (it may take a few seconds to roll).
      for (let i = 0; i < 60; i++) {
        const r = await fetch(`${urlOf(NAMES[kind])}/health`).catch(() => null);
        if (r?.status === 200) break;
        await sleep(1000);
      }
      if (k === 0) {
        // Create the "old" object once (it is then woken cold by every later trial).
        await probe(kind, "p:old");
        trials.push({ kind, trial: k, startup_time_ms: startup, note: "created p:old" });
        continue;
      }
      const cold = await probe(kind, "p:old");
      const warm = await probe(kind, "p:old");
      const fresh = await probe(kind, `p:new-${k}-${Date.now().toString(36)}`);
      const row = { kind, trial: k, startup_time_ms: startup, cold, warm, fresh };
      say("trial:", row);
      trials.push(row);
    }
    // Let objects go idle between trials (eviction after ~70–140 s without requests is not guaranteed; the new
    // version alone makes the isolate cold).
    await sleep(15_000);
  }
  const summary: Record<string, unknown> = {};
  for (const kind of KINDS) {
    const rows = trials.filter((t) => t.kind === kind && t.cold);
    summary[kind] = {
      startup_time_ms: median(trials.filter((t) => t.kind === kind).map((t) => t.startup_time_ms)),
      coldRpcMs: median(rows.map((r) => r.cold.rpcMs)),
      warmRpcMs: median(rows.map((r) => r.warm.rpcMs)),
      freshRpcMs: median(rows.map((r) => r.fresh.rpcMs)),
      coldLaptopMs: median(rows.map((r) => r.cold.laptopMs)),
      warmLaptopMs: median(rows.map((r) => r.warm.laptopMs)),
      workerColos: [...new Set(rows.map((r) => r.cold.workerColo))],
    };
  }
  say("summary:", summary);
  merge(`bench@${new Date().toISOString()}`, { TRIALS, trials, summary });
}

async function inventory() {
  const scripts = (await cf.call<Array<{ id: string }>>("GET", "/workers/scripts")).map((s) => s.id).filter((n) => n.startsWith("ember-spike"));
  const ns = (await cf.call<Array<{ name: string; script?: string }>>("GET", "/workers/durable_objects/namespaces?per_page=1000")).filter((n) => (n.script ?? n.name).startsWith("ember-spike"));
  const r = { scripts, namespaces: ns.map((n) => n.name) };
  say("inventory:", r);
  return r;
}

async function cleanup() {
  for (const w of Object.values(NAMES)) {
    const r = await cf.request("DELETE", `/workers/scripts/${w}?force=true`);
    say(`DELETE ${w}:`, r.success ? "ok" : JSON.stringify(r.errors).slice(0, 200));
  }
  merge(`cleanup@${new Date().toISOString()}`, await inventory());
}

const phases = process.argv.slice(2);
say(`latency-cold ${phases.join(" ")} — ${new Date().toISOString()} TRIALS=${TRIALS}`);
for (const p of phases) {
  if (p === "bench") await benchPhase();
  else if (p === "cleanup") await cleanup();
  else if (p === "inventory") await inventory();
  else throw new Error(`unknown phase ${p}`);
}
