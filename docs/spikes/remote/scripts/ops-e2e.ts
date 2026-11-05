// Ops E2E on Cloudflare production (PLAN §11, §18, §19): `ember restore` (PITR), shard pre-warm before/after, and
// the multi-shard load benchmark (Phase 4 done-criterion) driven from inside Cloudflare by a load-generator Worker.
//
//   bun run docs/spikes/remote/scripts/ops-e2e.ts <phase...>
//     deploy | restore | prewarm | bench | cleanup | inventory     (default: deploy restore prewarm bench cleanup)
//
// Only `ember-spike-*` resources are created: the project Worker `ember-spike-ops-test` (project "spike-ops", env
// "test", with its own Auth DO), the registry D1 `ember-spike-ops-registry`, and the load generator Worker
// `ember-spike-ops-loadgen`. The Cloudflare token comes from the CLI's lookup (wrangler OAuth); the project admin
// token and the load generator token are random per run and kept in memory only (re-uploaded as secrets when a later
// phase runs in a new process). Output is redacted (account id, workers.dev subdomain, emails, local paths).

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { loadProject } from "../../../../packages/cli/src/config.ts";
import { init } from "../../../../packages/cli/src/init.ts";
import { deploy, workerForm } from "../../../../packages/cli/src/deploy/index.ts";
import { CfClient, resolveToken } from "../../../../packages/cli/src/deploy/cf.ts";
import { main as cli } from "../../../../packages/cli/src/main.ts";
import { listBookmarks, restoreCommand } from "../../../../packages/cli/src/restore.ts";
import { EmberClient } from "../../../../packages/client/src/index.ts";

const ROOT = join(import.meta.dir, "../../../../packages/cli/.tmp/ember-spike-ops");
const STATE = join(ROOT, ".e2e-state.json"); // urls and version ids only (no secrets)
const EVIDENCE = join(import.meta.dir, "../evidence");
const WORKER = "ember-spike-ops-test";
const LOADGEN = "ember-spike-ops-loadgen";
const REGISTRY = "ember-spike-ops-registry";
process.env.EMBER_REGISTRY_NAME = REGISTRY;

const token = resolveToken();
const auth = { authorization: `Bearer ${token}` };
const account = ((await (await fetch("https://api.cloudflare.com/client/v4/accounts", { headers: auth })).json()) as any).result[0].id as string;
const cf = new CfClient({ accountId: account, token });
const subdomain = ((await cf.request<{ subdomain?: string }>("GET", "/workers/subdomain")).result?.subdomain ?? "") as string;
const redact = (s: string) => {
  let out = s.split(account).join("<ACCOUNT_ID>").split(ROOT).join("<project>");
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
const adminToken = randomBytes(24).toString("base64url");
const loadgenToken = randomBytes(24).toString("base64url");
process.env.EMBER_ADMIN_TOKEN = adminToken; // for `ember restore` (cli main); never printed

type State = { url?: string; versions?: string[]; loadgen?: string };
const state = (): State => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {});
const save = (s: Partial<State>) => writeFileSync(STATE, JSON.stringify({ ...state(), ...s }, null, 2));
const url = () => state().url!;

const pct = (xs: number[], p: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};
const summary = (xs: number[]) => ({ n: xs.length, p50: pct(xs, 50), p95: pct(xs, 95), p99: pct(xs, 99), max: xs.length ? Math.max(...xs) : null });

// ------------------------------------------------------------------ project

const SCHEMA = (v2: boolean) => `import { defineSchema, defineTable, v } from "@freecorps/ember-server";

export default defineSchema({
  tables: {
    items: defineTable({ n: v.number(), sentAt: v.number(), body: v.string() })
      .index("by_n", ["n"])${v2 ? `\n      .index("by_sent", ["sentAt"])` : ""},
    profiles: defineTable({ userId: v.string(), email: v.string(), name: v.string(), credits: v.number() }).index("by_user", ["userId"]),
  },
});
`;

const BENCH = `import { v } from "@freecorps/ember-server";
import { mutation, query } from "./_generated/server";

export const put = mutation({
  args: { n: v.number(), sentAt: v.number(), body: v.string() },
  handler: (ctx, a) => ctx.db.insert("items", a),
});
export const recent = query({
  args: { limit: v.optional(v.number()), salt: v.optional(v.number()) },
  handler: (ctx, { limit }) => ctx.db.query("items").withIndex("by_n").order("desc").take(limit ?? 10),
});
export const latest = query({
  args: {},
  handler: (ctx) => ctx.db.query("items").order("desc").first(),
});
export const count = query({ args: {}, handler: (ctx) => ctx.db.query("items").collect().length });
`;

function writeProject(v2: boolean) {
  if (!existsSync(join(ROOT, "ember.json"))) {
    mkdirSync(ROOT, { recursive: true });
    init({ dir: ROOT, project: "spike-ops", auth: true });
    const cfg = JSON.parse(readFileSync(join(ROOT, "ember.json"), "utf8"));
    cfg.account = account;
    cfg.environments = { test: {} };
    cfg.metrics = { enabled: false };
    writeFileSync(join(ROOT, "ember.json"), JSON.stringify(cfg, null, 2));
    rmSync(join(ROOT, "ember/messages.ts"), { force: true });
    rmSync(join(ROOT, "ember/crons.ts"), { force: true });
  }
  writeFileSync(join(ROOT, "ember/schema.ts"), SCHEMA(v2));
  writeFileSync(join(ROOT, "ember/bench.ts"), BENCH);
}

async function call(kind: "query" | "mutation", fn: string, args: unknown, shard: string) {
  const res = await fetch(`${url()}/api/${kind}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fn, args, shard }) });
  const body = (await res.json()) as any;
  if (!body.ok) throw new Error(`${fn}@${shard}: ${JSON.stringify(body.error)}`);
  return body.value;
}
const count = (shard: string) => call("query", "bench:count", {}, shard) as Promise<number>;
const put = (shard: string, n: number) => call("mutation", "bench:put", { n, sentAt: Date.now(), body: `row ${n}` }, shard);

async function setAdminSecret() {
  // A later phase in a new process: the previous admin token is gone (never stored); upload a fresh one.
  await cf.call("PUT", `/workers/scripts/${WORKER}/secrets`, { name: "EMBER_ADMIN_TOKEN", text: adminToken, type: "secret_text" });
  for (let i = 0; i < 30; i++) {
    const r = await fetch(`${url()}/api/_ember/status`, { headers: { authorization: `Bearer ${adminToken}` } });
    if (r.status === 200) return;
    await sleep(1000);
  }
  throw new Error("admin token did not propagate");
}

async function doDeploy(v2: boolean) {
  writeProject(v2);
  const project = loadProject(ROOT);
  const t = Date.now();
  const r = await deploy(project, { env: "test", adminToken, registryName: REGISTRY, wait: { timeoutMs: 180_000 }, message: v2 ? "ops e2e v2 (index by_sent)" : "ops e2e v1", log: (l) => say(l) });
  save({ url: r.url!, versions: [...(state().versions ?? []), r.versionId ?? "(create)"] });
  say(`deploy ${v2 ? "v2" : "v1"} took ${Date.now() - t} ms, version ${r.versionId ?? "(create: no version id returned)"}`);
  return r;
}

// ------------------------------------------------------------------ restore E2E

async function cliRun(args: string[]) {
  const prev = process.cwd();
  process.chdir(ROOT);
  const out: string[] = [];
  const orig = console.log;
  console.log = (...xs: unknown[]) => {
    out.push(xs.join(" "));
    orig(...xs.map((x) => (typeof x === "string" ? redact(x) : x)));
  };
  const t = Date.now();
  try {
    const code = await cli(args);
    return { code, out, ms: Date.now() - t };
  } finally {
    console.log = orig;
    process.chdir(prev);
    logLines.push(...out.map(redact));
  }
}

async function restorePhase() {
  const ev: Record<string, unknown> = {};
  const A = "room:a", B = "room:b", C = "room:c", D = "room:d";
  for (const s of [A, B, C]) for (let n = 1; n <= 3; n++) await put(s, n);
  say("v1 data: room:a/b/c = 3 rows each", { a: await count(A), b: await count(B), c: await count(C) });

  // A live client on room:a: after the restore it must reconnect and get a full snapshot (new epoch).
  const live = new EmberClient({ url: url(), WebSocket: globalThis.WebSocket as any });
  const seen: Array<{ t: number; v: unknown }> = [];
  live.subscribe("bench:count", {}, { shard: A }, (s) => s.status === "success" && seen.push({ t: Date.now(), v: s.value }));

  const mark = await cliRun(["restore", "--env", "test", "--shard", A, "--mark", "before-import"]);
  const markBm = /bookmark (\S+)/.exec(mark.out.join("\n"))![1]!;
  await sleep(1500);
  const markTime = Date.now();
  await sleep(1500);
  for (let n = 4; n <= 6; n++) await put(A, n);
  say("after the mark: room:a =", await count(A));
  const list = await cliRun(["restore", "--env", "test", "--shard", A, "--list"]);
  ev.list = list.out.map(redact);

  // 1) exact bookmark
  const r1 = await cliRun(["restore", "--env", "test", "--shard", A, "--to", markBm, "--yes"]);
  const undo1 = /--to (\S+) --yes/.exec(r1.out.join("\n"))![1]!;
  const afterRestore = await count(A);
  say(`restore to the mark: ${r1.ms} ms (CLI wall time, laptop → Worker → DO restart), room:a = ${afterRestore}`);
  await sleep(4000);
  const liveAfter = seen.at(-1)?.v;
  say("live subscriber after the restore sees", liveAfter);

  // 2) undo
  const r2 = await cliRun(["restore", "--env", "test", "--shard", A, "--to", undo1, "--yes"]);
  const afterUndo = await count(A);
  say(`undo: ${r2.ms} ms, room:a = ${afterUndo}`);

  // 3) time target: newest bookmark at or before markTime = the mark
  const r3 = await cliRun(["restore", "--env", "test", "--shard", A, "--to", new Date(markTime).toISOString(), "--yes"]);
  const afterTime = await count(A);
  say(`time target ${new Date(markTime).toISOString()}: ${r3.ms} ms, room:a = ${afterTime}`);
  const undo3 = /--to (\S+) --yes/.exec(r3.out.join("\n"))![1]!;
  await cliRun(["restore", "--env", "test", "--shard", A, "--to", undo3, "--yes"]);
  say("undo again: room:a =", await count(A));

  // 4) out of the 30-day window
  let expired = "";
  try {
    await cliRun(["restore", "--env", "test", "--shard", A, "--to", "2026-09-01T00:00:00Z", "--yes"]);
  } catch (e) {
    expired = (e as Error).message;
  }
  say("restore to 2026-09-01:", expired || "NOT REFUSED");

  // 5) deploy v2 (adds an index → migration), write, then restore every shard to deploy:v2
  const before = { a: await count(A), b: await count(B), c: await count(C) };
  const v2 = await doDeploy(true);
  await sleep(3000);
  for (const s of [A, B]) for (let n = 100; n < 103; n++) await put(s, n);
  // room:d is created under v2 (its first boot): deploy:v2 must take it back to empty (Bugbot on #6).
  for (let n = 1; n <= 2; n++) await put(D, n);
  await sleep(3000); // the catalog row is reported after the first migration
  const afterV2 = { a: await count(A), b: await count(B), c: await count(C), d: await count(D) };
  say("room:d reasons:", (await listBookmarks({ url: url(), adminToken }, D)).map((b) => b.reason));
  say("before v2", before, "after v2 writes", afterV2);
  const bmsA = await listBookmarks({ url: url(), adminToken }, A);
  say("room:a reasons now:", bmsA.map((b) => b.reason));
  const all = await cliRun(["restore", "--env", "test", "--all", "--to", `deploy:${v2.versionId}`, "--yes"]);
  const afterAll = { a: await count(A), b: await count(B), c: await count(C), d: await count(D) };
  say(`restore --all --to deploy:v2: ${all.ms} ms →`, afterAll);
  const status = await (await fetch(`${url()}/api/_ember/status?shard=${A}&shard=${B}`, { headers: { authorization: `Bearer ${adminToken}` } })).json();
  say("status after restoring to before the v2 migration (re-migrated on boot):", (status as any).shards.map((s: any) => ({ shard: s.shard, ready: s.ready, schema: s.schemaVersion?.slice(0, 12), expected: s.expectedVersion?.slice(0, 12) })));
  live.close();
  ev.results = { afterRestore, liveAfter, afterUndo, afterTime, expired: !!expired, before, afterV2, afterAll, ms: { restore: r1.ms, undo: r2.ms, time: r3.ms, all: all.ms } };
  writeFileSync(join(EVIDENCE, "ops-restore.json"), redact(JSON.stringify(ev, null, 2)));
}

// ------------------------------------------------------------------ pre-warm (laptop client, real Better Auth token)

async function signUp() {
  const email = `spike-${randomBytes(6).toString("hex")}@example.com`;
  const password = randomBytes(18).toString("base64url");
  const r = await fetch(`${url()}/api/auth/sign-up/email`, { method: "POST", headers: { "content-type": "application/json", origin: url() }, body: JSON.stringify({ email, password, name: "Spike" }) });
  const session = r.headers.get("set-auth-token");
  if (!r.ok || !session) throw new Error(`sign-up failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return session;
}

async function firstSnapshot(shard: string, pipeline: boolean, session: string) {
  const timings: Record<string, number> = {};
  const t0 = performance.now();
  const client = new EmberClient({
    url: url(),
    WebSocket: globalThis.WebSocket as any,
    pipelineConnect: pipeline,
    auth: async () => {
      const a = performance.now();
      const r = await fetch(`${url()}/api/auth/token`, { headers: { authorization: `Bearer ${session}` } });
      const body = (await r.json()) as { token?: string };
      timings.token = performance.now() - a;
      return body.token ?? null;
    },
  });
  const ms = await new Promise<number>((resolve, reject) => {
    const to = setTimeout(() => reject(new Error("no snapshot in 20 s")), 20_000);
    client.subscribe("bench:recent", { limit: 5 }, { shard }, (s) => {
      if (s.status === "success" && !s.source) {
        clearTimeout(to);
        resolve(performance.now() - t0);
      }
    });
  });
  client.close();
  return { ms, token: timings.token ?? null };
}

async function prewarmPhase() {
  const session = await signUp();
  const rounds = 3;
  const per = 8; // shards per round and variant
  const rows: Array<{ round: number; variant: string; cold: boolean; ms: number; token: number | null }> = [];
  for (let round = 0; round < rounds; round++) {
    const shards = Array.from({ length: per * 2 }, (_, i) => `pw:r${round}-${i}-${randomBytes(3).toString("hex")}`);
    for (const s of shards) await put(s, 1);
    say(`round ${round}: ${shards.length} shards created; idle 100 s so they hibernate/evict (R8: wake costs ~56–60 ms after ~75 s)`);
    await sleep(100_000);
    // Alternate variants so drift (network, Auth DO warmth) hits both equally.
    for (let i = 0; i < shards.length; i++) {
      const pipeline = i % 2 === 1;
      const cold = await firstSnapshot(shards[i]!, pipeline, session);
      const warm = await firstSnapshot(shards[i]!, pipeline, session);
      rows.push({ round, variant: pipeline ? "pipelined" : "serial", cold: true, ...cold });
      rows.push({ round, variant: pipeline ? "pipelined" : "serial", cold: false, ...warm });
    }
  }
  const pick = (variant: string, cold: boolean) => rows.filter((r) => r.variant === variant && r.cold === cold);
  const out = {
    serialCold: summary(pick("serial", true).map((r) => Math.round(r.ms))),
    pipelinedCold: summary(pick("pipelined", true).map((r) => Math.round(r.ms))),
    serialWarm: summary(pick("serial", false).map((r) => Math.round(r.ms))),
    pipelinedWarm: summary(pick("pipelined", false).map((r) => Math.round(r.ms))),
    tokenFetch: summary(rows.map((r) => Math.round(r.token ?? 0))),
  };
  say("first snapshot (new client: token fetch + WebSocket + hello + sub), ms:", out);
  writeFileSync(join(EVIDENCE, "ops-prewarm.json"), redact(JSON.stringify({ out, rows }, null, 2)));
}

// ------------------------------------------------------------------ key rotation

async function keysPhase() {
  await doDeploy(true); // the current runtime/auth code (rotateKeys), same schema as v2
  const ev: Record<string, unknown> = {};
  const session = await signUp();
  const tokenNow = async () => ((await (await fetch(`${url()}/api/auth/token`, { headers: { authorization: `Bearer ${session}` } })).json()) as { token?: string }).token ?? null;
  const kid = (t: string) => JSON.parse(Buffer.from(t.split(".")[0]!, "base64url").toString()).kid as string;
  const me = async (t: string | null) => {
    const r = await fetch(`${url()}/api/query`, { method: "POST", headers: { "content-type": "application/json", ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: JSON.stringify({ fn: "users:me", args: {}, shard: "global:main" }) });
    const b = (await r.json()) as any;
    return r.status === 200 ? (b.value?.subject ? "ok" : "anonymous") : `${r.status} ${b.error?.code}`;
  };
  const t1 = (await tokenNow())!;
  ev.before = { kid: kid(t1), t1: await me(t1) };
  const jwt = await cliRun(["keys", "rotate", "--env", "test", "--jwt"]);
  const t2 = (await tokenNow())!;
  ev.afterJwt = { ms: jwt.ms, newKid: kid(t2), changed: kid(t2) !== kid(t1), t1: await me(t1), t2: await me(t2), session: await me(session) };
  say("after --jwt:", ev.afterJwt);
  const sec = await cliRun(["keys", "rotate", "--env", "test", "--auth-secret", "--yes"]);
  await sleep(3000);
  const t3 = await tokenNow();
  ev.afterAuthSecret = {
    ms: sec.ms,
    t1: await me(t1),
    t2: await me(t2),
    sessionTokenStillIssuesJwt: t3 !== null,
    t3: t3 ? { kid: kid(t3), me: await me(t3) } : null,
    getSession: (await fetch(`${url()}/api/auth/get-session`, { headers: { authorization: `Bearer ${session}` } })).status,
  };
  say("after --auth-secret:", ev.afterAuthSecret);
  // A fresh sign-in works under the new secret.
  const fresh = await signUp();
  const t4 = (await (await fetch(`${url()}/api/auth/token`, { headers: { authorization: `Bearer ${fresh}` } })).json()) as { token?: string };
  ev.freshUser = { token: !!t4.token, kid: t4.token ? kid(t4.token) : null, me: await me(t4.token ?? null) };
  say("new user after the rotation:", ev.freshUser);
  const names = ((await cf.call<Array<{ name: string }>>("GET", `/workers/scripts/${WORKER}/secrets`)) ?? []).map((x) => x.name).sort();
  ev.secretNames = names;
  say("secret names now:", names);
  writeFileSync(join(EVIDENCE, "ops-keys.json"), redact(JSON.stringify(ev, null, 2)));
}

// ------------------------------------------------------------------ load generator + bench

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
  save({ loadgen: lg });
  for (let i = 0; i < 60; i++) {
    const r = await fetch(`${lg}/run`, { method: "POST", headers: { authorization: `Bearer ${loadgenToken}` }, body: JSON.stringify({ target: url(), tasks: [] }) }).catch(() => null);
    if (r?.status === 200) return lg;
    await sleep(2000);
  }
  throw new Error("load generator not reachable");
}

async function runTasks(lg: string, label: string, tasks: any[]) {
  const runId = randomBytes(4).toString("hex");
  const t = Date.now();
  const r = await fetch(`${lg}/run`, {
    method: "POST",
    headers: { authorization: `Bearer ${loadgenToken}`, "content-type": "application/json" },
    body: JSON.stringify({ target: url(), tasks: tasks.map((x, i) => ({ ...x, agent: `${runId}-${i}` })) }),
  });
  if (r.status !== 200) throw new Error(`${label}: loadgen ${r.status} ${(await r.text()).slice(0, 300)}`);
  const body = (await r.json()) as { results: any[]; coordinator: string };
  const failed = body.results.filter((x) => x.failed);
  if (failed.length) say(`${label}: ${failed.length} task(s) failed:`, failed.slice(0, 2).map((f) => String(f.failed).slice(0, 300)));
  say(`${label}: done in ${Date.now() - t} ms (coordinator ${body.coordinator}, agent colos ${[...new Set(body.results.map((x) => x.colo))].join(",")})`);
  return body.results;
}

const shardVersion = async (shards: string[]) => {
  const out: Record<string, number> = {};
  for (let i = 0; i < shards.length; i += 50) {
    const qs = new URLSearchParams(shards.slice(i, i + 50).map((s) => ["shard", s]));
    const st = (await (await fetch(`${url()}/api/_ember/status?${qs}`, { headers: { authorization: `Bearer ${adminToken}` } })).json()) as any;
    for (const s of st.shards) out[s.shard] = s.version;
  }
  return out;
};

function mutReport(results: any[]) {
  const ok = results.filter((r) => r.kind === "mut" && !r.failed);
  const all = ok.flatMap((r) => r.lat);
  const wall = Math.max(...ok.map((r) => r.wallMs)) / 1000;
  const total = ok.reduce((a, r) => a + r.ok, 0);
  const perShard = new Map<string, { ok: number; lat: number[]; wall: number; errors: number }>();
  for (const r of ok) {
    const e = perShard.get(r.shard) ?? { ok: 0, lat: [], wall: 0, errors: 0 };
    e.ok += r.ok;
    e.errors += r.errors;
    e.lat.push(...r.lat);
    e.wall = Math.max(e.wall, r.wallMs / 1000);
    perShard.set(r.shard, e);
  }
  const rates = [...perShard.values()].map((e) => e.ok / e.wall);
  return {
    shards: perShard.size,
    total,
    errors: ok.reduce((a, r) => a + r.errors, 0),
    firstErrors: ok.flatMap((r) => r.firstError ?? []).slice(0, 3),
    perSecond: Math.round(total / wall),
    ackMs: summary(all),
    perShardPerSecond: { min: Math.round(Math.min(...rates)), p50: Math.round(pct(rates, 50)!), max: Math.round(Math.max(...rates)) },
    perShardAckP50: summary([...perShard.values()].map((e) => pct(e.lat, 50)!)),
  };
}

function rateReport(results: any[], kind: string) {
  const ok = results.filter((r) => r.kind === kind && !r.failed);
  const total = ok.reduce((a, r) => a + r.ok, 0);
  const wall = Math.max(...ok.map((r) => r.wallMs)) / 1000;
  const perShard = ok.map((r) => r.ok / (r.wallMs / 1000));
  return {
    shards: new Set(ok.map((r) => r.shard)).size,
    total,
    errors: ok.reduce((a, r) => a + r.errors, 0),
    firstErrors: ok.flatMap((r) => r.firstError ?? []).slice(0, 3),
    perSecond: Math.round(total / wall),
    latencyMs: summary(ok.flatMap((r) => r.lat)),
    perShardPerSecond: perShard.length ? { min: Math.round(Math.min(...perShard)), p50: Math.round(pct(perShard, 50)!), max: Math.round(Math.max(...perShard)) } : null,
  };
}

async function benchPhase() {
  // The load generator token lives in memory only: (re)deploy it in every process (cheap, idempotent).
  const lg = await deployLoadgen();
  const only = (process.env.BENCH_ONLY ?? "").split(",").filter(Boolean);
  const want = (k: string) => !only.length || only.includes(k);
  const evFile = join(EVIDENCE, "ops-bench.json");
  const ev: Record<string, unknown> = existsSync(evFile) ? JSON.parse(readFileSync(evFile, "utf8")) : {};
  const flush = () => writeFileSync(evFile, redact(JSON.stringify(ev, null, 2)));
  const seed = async (shards: string[]) => {
    for (let i = 0; i < shards.length; i += 16) await Promise.all(shards.slice(i, i + 16).map((s) => put(s, 0)));
  };

  // Probe: how many outgoing WebSockets one agent can hold (Workers' 6-connection limit?).
  if (want("probe")) {
  const probe = await runTasks(lg, "probe: 12 sockets in one agent", [{ kind: "mut", shard: "bench:probe", sockets: 12, window: 1, durationMs: 3000 }]);
  say("probe:", probe.map((r) => ({ ok: r.ok, wallMs: r.wallMs, failed: r.failed?.slice(0, 200) })));
  ev.probe = { sockets: 12, durationMs: 3000, window: 1, ok: probe[0]?.ok, wallMs: probe[0]?.wallMs };
  flush();
  }

  // B1: multi-shard mutations (1 pipelined socket per shard, window 50, 20 s).
  for (const S of want("B1") ? [8, 32] : []) {
    const shards = Array.from({ length: S }, (_, i) => `b1s${S}:${i}`);
    await seed(shards);
    const v0 = await shardVersion(shards);
    const res = await runTasks(lg, `B1 mutations, ${S} shards`, shards.map((shard) => ({ kind: "mut", shard, sockets: 1, window: 50, durationMs: 20_000, bodyBytes: 64 })));
    const v1 = await shardVersion(shards);
    const rep = mutReport(res);
    const commits = shards.reduce((a, s) => a + (v1[s]! - v0[s]!), 0);
    ev[`B1_${S}`] = { ...rep, commits, mutationsPerCommit: +(rep.total / Math.max(1, commits)).toFixed(1) };
    say(`B1 ${S} shards:`, ev[`B1_${S}`]);
    flush();
  }

  // B2: one hot shard, 6 agents × 1 socket × window 100 = 600 in flight (group commit).
  for (const window of want("B2") ? [10, 100] : []) {
    const hot = `hot:w${window}`;
    await seed([hot]);
    const v0 = await shardVersion([hot]);
    const res = await runTasks(lg, `B2 hot shard, 6×${window} in flight`, Array.from({ length: 6 }, () => ({ kind: "mut", shard: hot, sockets: 1, window, durationMs: 20_000, bodyBytes: 64 })));
    const v1 = await shardVersion([hot]);
    const rep = mutReport(res);
    const commits = v1[hot]! - v0[hot]!;
    ev[`B2_w${window}`] = { ...rep, inFlight: 6 * window, commits, mutationsPerCommit: +(rep.total / Math.max(1, commits)).toFixed(1) };
    say(`B2 hot shard, ${6 * window} in flight:`, ev[`B2_w${window}`]);
    flush();
  }

  // B3: queries. WebSocket sub→snap→unsub cycles on 32 shards; HTTP /api/query on 8 shards.
  if (want("B3")) {
    const shards = Array.from({ length: 32 }, (_, i) => `b1s32:${i}`);
    const res = await runTasks(lg, "B3 sub→snap cycles, 32 shards", shards.map((shard) => ({ kind: "subq", shard, sockets: 1, window: 20, durationMs: 15_000 })));
    ev.B3_subq = rateReport(res, "subq");
    say("B3 sub→snap:", ev.B3_subq);
    const http = await runTasks(lg, "B3 HTTP queries, 8 shards × 2 agents", Array.from({ length: 16 }, (_, i) => ({ kind: "query", shard: `b1s32:${i % 8}`, concurrency: 8, durationMs: 15_000, maxRequests: 900 })));
    ev.B3_http = rateReport(http, "query");
    say("B3 HTTP /api/query:", ev.B3_http);
    flush();
  }

  // B4: subscription fan-out: N subscribers of bench:latest on one shard, one writer (20 writes, 500 ms apart).
  for (const N of want("B4") ? [100, 500] : []) {
    const shard = `fan:n${N}-${randomBytes(2).toString("hex")}`;
    await seed([shard]);
    // An invocation holds at most 6 open outgoing connections, established WebSockets included (probe above).
    const perAgent = 5;
    const agents = Math.ceil(N / perAgent);
    const tasks: any[] = Array.from({ length: agents }, (_, i) => ({ kind: "fanSub", shard, sockets: Math.min(perAgent, N - i * perAgent), durationMs: 35_000 }));
    tasks.push({ kind: "fanPut", shard, writes: 20, intervalMs: 500, startDelayMs: 15_000 });
    const res = await runTasks(lg, `B4 fan-out to ${N}`, tasks);
    const subs = res.filter((r) => r.kind === "fanSub" && !r.failed);
    const writer = res.find((r) => r.kind === "fanPut");
    ev[`B4_n${N}`] = {
      subscribers: subs.reduce((a, r) => a + r.sockets, 0),
      patches: subs.reduce((a, r) => a + r.patches, 0),
      expectedPatches: subs.reduce((a, r) => a + r.sockets, 0) * 20,
      deliveryMs: summary(subs.flatMap((r) => r.lat)),
      writerAckMs: writer && !writer.failed ? summary(writer.lat) : null,
      failedAgents: res.filter((r) => r.failed).length,
      subscribeMs: summary(subs.map((r) => r.subscribedMs)),
    };
    say(`B4 fan-out to ${N}:`, ev[`B4_n${N}`]);
    flush();
  }
}

// ------------------------------------------------------------------ cleanup / inventory

async function inventory() {
  const scripts = (await cf.call<Array<{ id: string }>>("GET", "/workers/scripts")).map((s) => s.id).filter((n) => n.startsWith("ember-spike"));
  const ns = (await cf.call<Array<{ name: string; script?: string }>>("GET", "/workers/durable_objects/namespaces?per_page=1000")).filter((n) => (n.script ?? n.name).startsWith("ember-spike"));
  const d1 = (await cf.call<Array<{ name: string }>>("GET", "/d1/database?per_page=100")).filter((d) => d.name.startsWith("ember-spike"));
  say("inventory:", { scripts, namespaces: ns.map((n) => n.name), d1: d1.map((d) => d.name) });
  return { scripts, ns, d1 };
}

async function cleanup() {
  for (const w of [WORKER, LOADGEN]) {
    const r = await cf.request("DELETE", `/workers/scripts/${w}?force=true`);
    say(`DELETE ${w}:`, r.success ? "ok" : JSON.stringify(r.errors));
  }
  const d1 = (await cf.call<Array<{ uuid: string; name: string }>>("GET", `/d1/database?name=${REGISTRY}`)).find((d) => d.name === REGISTRY);
  if (d1) {
    const r = await cf.request("DELETE", `/d1/database/${d1.uuid}`);
    say(`DELETE d1 ${REGISTRY}:`, r.success ? "ok" : JSON.stringify(r.errors));
  }
  for (const w of [WORKER, LOADGEN]) {
    const r = await cf.request("GET", `/workers/scripts/${w}/settings`);
    say(`GET ${w}/settings after delete:`, r.success ? "STILL EXISTS" : `${(r.errors as any)?.[0]?.code} (gone)`);
  }
  if (d1) {
    const r = await cf.request("GET", `/d1/database/${d1.uuid}`);
    say(`GET d1 ${REGISTRY} after delete:`, r.success ? "STILL EXISTS" : `${(r.errors as any)?.[0]?.code} (gone)`);
  }
  await inventory();
  rmSync(ROOT, { recursive: true, force: true });
}

// ------------------------------------------------------------------ main

const phases = process.argv.slice(2);
const order = phases.length ? phases : ["deploy", "restore", "prewarm", "bench", "cleanup"];
mkdirSync(EVIDENCE, { recursive: true });
const started = new Date().toISOString();
say(`ops e2e ${order.join(" ")} — ${started}`);
try {
  if (!order.includes("deploy") && !order.includes("keys") && order.some((p) => ["restore", "prewarm", "bench"].includes(p))) await setAdminSecret();
  for (const p of order) {
    if (p === "deploy") await doDeploy(false);
    else if (p === "restore") await restorePhase();
    else if (p === "prewarm") await prewarmPhase();
    else if (p === "bench") await benchPhase();
    else if (p === "keys") await keysPhase();
    else if (p === "cleanup") await cleanup();
    else if (p === "inventory") await inventory();
    else throw new Error(`unknown phase ${p}`);
  }
} finally {
  writeFileSync(join(EVIDENCE, `ops-e2e-${order.join("-")}.txt`), logLines.join("\n") + "\n");
}
