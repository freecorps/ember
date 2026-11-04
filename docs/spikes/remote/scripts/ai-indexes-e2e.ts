// Real end-to-end run of the external indexes on Cloudflare (PLAN §6, §14): `ember deploy` provisions Vectorize /
// AI Search / Workers AI / the indexing queue, mutations flow through the outbox → queue → consumer, actions search,
// updates/deletes propagate, a metric change re-creates the index (staged backfill), durations are real, and
// `ember destroy` removes everything.
//
//   bun run docs/spikes/remote/scripts/ai-indexes-e2e.ts <phase>      (phases: all | deploy | load | search | update |
//                                                                      metric | durations | destroy | inventory)
//
// Only `ember-spike-*` resources are created (project "spike-ai", env "test": Worker ember-spike-ai-test). The
// Cloudflare token comes from the CLI's lookup (wrangler OAuth); the admin token is random per run and kept in
// memory. Output is redacted (account id, workers.dev subdomain, local paths) before printing.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { loadProject } from "../../../../packages/cli/src/config.ts";
import { init } from "../../../../packages/cli/src/init.ts";
import { deploy } from "../../../../packages/cli/src/deploy/index.ts";
import { resolveToken } from "../../../../packages/cli/src/deploy/cf.ts";
import { destroy } from "../../../../packages/cli/src/destroy.ts";
import { docs, queries } from "../../ai-embeddings/dataset.ts";

const ROOT = join(import.meta.dir, "../../../../packages/cli/.tmp/ember-spike-ai");
const STATE = join(ROOT, ".e2e-state.json"); // url only (no secrets), removed by destroy
const token = resolveToken();
const auth = { authorization: `Bearer ${token}` };
const account = ((await (await fetch("https://api.cloudflare.com/client/v4/accounts", { headers: auth })).json()) as any).result[0].id as string;
let subdomain = ((await (await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/subdomain`, { headers: auth })).json()) as any).result?.subdomain ?? "";
const redact = (s: string) => {
  let out = s.split(account).join("<ACCOUNT_ID>").split(ROOT).join("<project>");
  if (subdomain) out = out.split(subdomain).join("<subdomain>");
  return out.replace(/\/Users\/[^\s"']+/g, "<path>");
};
const say = (...xs: unknown[]) => console.log(redact(xs.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const adminToken = process.env.E2E_ADMIN_TOKEN ?? randomBytes(24).toString("base64url");

const SCHEMA = (metric: "cosine" | "euclidean") => `import { defineSchema, defineTable, v } from "@freecorps/ember-server";

export default defineSchema({
  tables: {
    notes: defineTable({ title: v.string(), body: v.string(), lang: v.string(), topic: v.string(), vec: v.optional(v.array(v.number())) })
      .vectorIndex("semantic", { embed: "body", filterFields: ["topic"] })
      .vectorIndex("by_vec", { vectorField: "vec", dimensions: 32, metric: "${metric}", filterFields: ["lang"] })
      .aiSearchIndex("hybrid", { fields: ["title", "body"], filterFields: ["topic"] }),
  },
});
`;

const NOTES = `import { v } from "@freecorps/ember-server";
import { action, mutation, query } from "./_generated/server";

const note = { title: v.string(), body: v.string(), lang: v.string(), topic: v.string(), vec: v.optional(v.array(v.number())) };

export const addMany = mutation({
  args: { items: v.array(v.object(note)) },
  handler: (ctx, { items }) => items.map((n) => ctx.db.insert("notes", n)),
});
export const patch = mutation({
  args: { id: v.id("notes"), body: v.string() },
  handler: (ctx, { id, body }) => ctx.db.patch(id, { body }),
});
export const remove = mutation({ args: { id: v.id("notes") }, handler: (ctx, { id }) => ctx.db.delete(id) });
export const count = query({ args: {}, handler: (ctx) => ctx.db.query("notes").collect().length });
export const list = query({ args: {}, handler: (ctx) => ctx.db.query("notes").collect().map((n) => ({ _id: n._id, title: n.title })) });

export const semantic = action({
  args: { q: v.string(), topic: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: (ctx, { q, topic, limit }) => ctx.vectorSearch("notes", "semantic", { text: q, limit: limit ?? 10, ...(topic ? { filter: { topic } } : {}) }),
});
export const similar = action({
  args: { vector: v.array(v.number()), lang: v.optional(v.string()) },
  handler: (ctx, { vector, lang }) => ctx.vectorSearch("notes", "by_vec", { vector, limit: 5, ...(lang ? { filter: { lang } } : {}) }),
});
export const hybrid = action({
  args: { q: v.string(), topic: v.optional(v.string()), mode: v.optional(v.union(v.literal("hybrid"), v.literal("vector"), v.literal("keyword"))), fusion: v.optional(v.union(v.literal("rrf"), v.literal("max"))) },
  handler: (ctx, { q, topic, mode, fusion }) => ctx.aiSearch("notes", "hybrid", { query: q, limit: 10, ...(mode ? { mode } : {}), ...(fusion ? { fusion } : {}), ...(topic ? { filter: { topic } } : {}) }),
});
`;

function writeProject(metric: "cosine" | "euclidean") {
  if (!existsSync(join(ROOT, "ember.json"))) {
    mkdirSync(ROOT, { recursive: true });
    init({ dir: ROOT, project: "spike-ai" });
    const cfg = JSON.parse(readFileSync(join(ROOT, "ember.json"), "utf8"));
    cfg.account = account;
    cfg.environments = { test: { vars: { EMBER_TRACE: "1" } } };
    cfg.metrics = { dataset: "ember_spike_metrics" };
    writeFileSync(join(ROOT, "ember.json"), JSON.stringify(cfg, null, 2));
  }
  writeFileSync(join(ROOT, "ember/schema.ts"), SCHEMA(metric));
  writeFileSync(join(ROOT, "ember/notes.ts"), NOTES);
  rmSync(join(ROOT, "ember/messages.ts"), { force: true });
  rmSync(join(ROOT, "ember/crons.ts"), { force: true });
}

const url = () => (JSON.parse(readFileSync(STATE, "utf8")) as { url: string }).url;
async function call(kind: "query" | "mutation" | "action", fn: string, args: unknown, shard = "global:main") {
  for (let attempt = 0; ; attempt++) {
    const t = performance.now();
    try {
      const res = await fetch(`${url()}/api/${kind}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fn, args, shard }) });
      const body = (await res.json()) as any;
      return { status: res.status, body, ms: performance.now() - t };
    } catch (e) {
      // Client-side network blips (laptop → Cloudflare); queries are idempotent here, mutations are not retried.
      if (kind === "mutation" || attempt >= 3) throw e;
      await sleep(1000);
    }
  }
}
const value = async (kind: "query" | "mutation" | "action", fn: string, args: unknown, shard?: string) => {
  const r = await call(kind, fn, args, shard);
  if (!r.body.ok) throw new Error(`${fn}: ${JSON.stringify(r.body.error)}`);
  return r.body.value;
};

async function doDeploy(metric: "cosine" | "euclidean") {
  writeProject(metric);
  const project = loadProject(ROOT);
  const t = Date.now();
  const r = await deploy(project, { env: "test", registry: false, adminToken, wait: { timeoutMs: 180_000 }, log: (l) => say(l) });
  const u = r.url!;
  const prev = existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {};
  writeFileSync(STATE, JSON.stringify({ ...prev, url: u }));
  if (prev.loadedAt && !prev.ids) {
    // Recover the title → id map (documents are titled d01..d30).
    const rows = (await value("query", "notes:list", {})) as Array<{ _id: string; title: string }>;
    writeFileSync(STATE, JSON.stringify({ ...prev, url: u, ids: Object.fromEntries(rows.filter((x) => /^d\d\d$/.test(x.title)).map((x) => [x.title, x._id])) }));
  }
  say(`deploy (${metric}) took ${Date.now() - t} ms; ai`, r.ai);
}

const DOCS = Object.entries(docs);
const topicOf = (id: string) => (["d13", "d14", "d15", "d24"].includes(id) ? "rh" : "atendimento");
const vecOf = (i: number) => Array.from({ length: 32 }, (_, k) => (k === 0 ? Math.cos(i) : k === 1 ? Math.sin(i) : k === 2 ? (i % 3 === 0 ? 1 : 0) : 0));

async function load() {
  const items = DOCS.map(([id, body], i) => ({ title: id, body, lang: i % 5 === 0 ? "en" : "pt", topic: topicOf(id), vec: vecOf(i) }));
  const t0 = Date.now();
  const ids = (await value("mutation", "notes:addMany", { items })) as string[];
  const write = Date.now() - t0;
  const byKey = Object.fromEntries(DOCS.map(([k], i) => [k, ids[i]!]));
  writeFileSync(STATE, JSON.stringify({ ...JSON.parse(readFileSync(STATE, "utf8")), ids: byKey, loadedAt: t0 }));
  await value("mutation", "notes:addMany", { items: [{ title: "outro", body: "Para redefinir sua senha use o link de recuperação.", lang: "pt", topic: "atendimento", vec: vecOf(0) }] }, "global:other");
  say(`inserted ${ids.length} notes in one mutation (${write} ms HTTP) + 1 note on global:other`);
  // Write → searchable, per service.
  const until = async (label: string, f: () => Promise<boolean>, max = 600_000) => {
    const s = Date.now();
    for (let i = 0; Date.now() - s < max; i++) {
      if (await f()) {
        say(`${label}: searchable ${Date.now() - t0} ms after the write`);
        return Date.now() - t0;
      }
      await sleep(Math.min(5000, 500 * (i + 1)));
    }
    say(`${label}: NOT searchable after ${max} ms`);
    return null;
  };
  const vecReady = await until("vectorize (by_vec, 30 vectors)", async () => ((await value("action", "notes:similar", { vector: vecOf(0) })) as any[]).length >= 5);
  const semReady = await until("vectorize (semantic, bge-m3 embed)", async () => ((await value("action", "notes:semantic", { q: queries[0]!.q })) as any[]).length >= 10);
  const aisReady = await until("ai-search (hybrid)", async () => ((await value("action", "notes:hybrid", { q: "reembolso compra cancelada" })) as any[]).length >= 1, 900_000);
  say({ vecReady, semReady, aisReady });
}

async function search() {
  const st = JSON.parse(readFileSync(STATE, "utf8")) as { ids: Record<string, string> };
  const idToKey = Object.fromEntries(Object.entries(st.ids).map(([k, v]) => [v, k]));
  const score = async (fn: "notes:semantic" | "notes:hybrid", extra: Record<string, unknown> = {}) => {
    let r1 = 0, r3 = 0, mrr = 0;
    const lat: number[] = [];
    for (const { q, rel } of queries) {
      const r = await call("action", fn, { q, ...extra });
      lat.push(r.ms);
      const ranked = (r.body.value as Array<{ _id: string }>).map((x) => idToKey[x._id]);
      const rank = ranked.indexOf(rel);
      if (rank === 0) r1++;
      if (rank >= 0 && rank < 3) r3++;
      if (rank >= 0 && rank < 10) mrr += 1 / (rank + 1);
    }
    lat.sort((a, b) => a - b);
    const n = queries.length;
    return { recallAt1: +(r1 / n).toFixed(3), recallAt3: +(r3 / n).toFixed(3), mrrAt10: +(mrr / n).toFixed(3), actionMs: { p50: Math.round(lat[n >> 1]!), p95: Math.round(lat[Math.floor(n * 0.95)]!) } };
  };
  say("semantic (Vectorize + bge-m3 via Ember):", await score("notes:semantic"));
  say("hybrid (AI Search, hybrid):", await score("notes:hybrid"));
  say("hybrid (AI Search, keyword only):", await score("notes:hybrid", { mode: "keyword" }));
  say("hybrid (AI Search, vector only):", await score("notes:hybrid", { mode: "vector" }));
  say("hybrid (AI Search, fusion max):", await score("notes:hybrid", { fusion: "max" }));
  const hr = (await value("action", "notes:semantic", { q: "quando cai o salário e o vale?", topic: "rh" })) as Array<{ _id: string }>;
  say("filter topic=rh →", hr.map((x) => idToKey[x._id]));
  const hrAis = (await value("action", "notes:hybrid", { q: "férias", topic: "rh" })) as Array<{ _id: string; _score: number; text: string }>;
  say("ai-search filter topic=rh →", hrAis.map((x) => [idToKey[x._id], +x._score.toFixed(3)]));
  const en = (await value("action", "notes:similar", { vector: vecOf(0), lang: "en" })) as Array<{ _id: string; _score: number }>;
  say("by_vec lang=en →", en.map((x) => [idToKey[x._id], +x._score.toFixed(3)]));
  const other = (await value("action", "notes:semantic", { q: "esqueci a senha" }, "global:other")) as Array<{ _id: string }>;
  say("isolation: global:other sees", other.length, "result(s), none from global:main:", other.every((x) => !idToKey[x._id]));
  const otherAis = (await value("action", "notes:hybrid", { q: "senha" }, "global:other")) as Array<{ _id: string }>;
  say("isolation (ai-search): global:other sees", otherAis.length, "result(s), none from global:main:", otherAis.every((x) => !idToKey[x._id]));
}

async function update() {
  const st = JSON.parse(readFileSync(STATE, "utf8")) as { ids: Record<string, string> };
  // d30 / d02 were patched/removed by a first run whose client loop died on a network blip; fresh documents here.
  const target = st.ids.d29!;
  const gone = st.ids.d03!;
  const t0 = Date.now();
  await value("mutation", "notes:patch", { id: target, body: "Aos domingos o atendimento passa a ser feito apenas pelo WhatsApp, das 10h às 16h." });
  await value("mutation", "notes:remove", { id: gone });
  const wait = async (label: string, f: () => Promise<boolean>, max = 600_000) => {
    for (let i = 0; Date.now() - t0 < max; i++) {
      if (await f()) return say(`${label}: ${Date.now() - t0} ms after the write`);
      await sleep(Math.min(5000, 500 * (i + 1)));
    }
    say(`${label}: NOT after ${max} ms`);
  };
  const top = async (fn: string, q: string) => ((await value("action", fn, { q })) as Array<{ _id: string }>).map((x) => x._id);
  await wait("vectorize: patched note found for its new text", async () => (await top("notes:semantic", "tem suporte pelo whatsapp no domingo?")).slice(0, 2).includes(target));
  await wait("vectorize: deleted note gone", async () => !(await top("notes:semantic", "quanto pago se atrasar a conta mensal?")).includes(gone));
  await wait("ai-search: patched note found for its new text", async () => (await top("notes:hybrid", "atendimento pelo WhatsApp aos domingos")).includes(target), 900_000);
  await wait("ai-search: deleted note gone", async () => !(await top("notes:hybrid", "boleto vence multa juros")).includes(gone), 900_000);
}

async function metricChange() {
  // Vectorize cannot change a metric: the deploy creates a new index; the shard's staged backfill re-sends every
  // document; the old index is deleted after the new version is live.
  const t0 = Date.now();
  await doDeploy("euclidean");
  const st = JSON.parse(readFileSync(STATE, "utf8")) as { ids: Record<string, string> };
  for (let i = 0; Date.now() - t0 < 600_000; i++) {
    const r = (await value("action", "notes:similar", { vector: vecOf(0) })) as Array<{ _id: string; _score: number }>;
    if (r.length >= 5) {
      say(`euclidean index refilled by the backfill ${Date.now() - t0} ms after the deploy started; top:`, r.slice(0, 3).map((x) => [x._id === st.ids.d01 ? "d01" : "other", +x._score.toFixed(3)]));
      return;
    }
    await sleep(Math.min(5000, 500 * (i + 1)));
  }
  say("euclidean index NOT refilled after 10 min");
}

async function durations() {
  // HTTP (Worker-measured, timing rpc) and WebSocket (DO commit timing) traffic, then Analytics Engine SQL.
  if (!process.env.E2E_SKIP_TRAFFIC) for (let i = 0; i < 10; i++) {
    await value("query", "notes:count", {});
    await value("mutation", "notes:addMany", { items: [{ title: `t${i}`, body: `nota ${i}`, lang: "pt", topic: "x" }] }, "global:metrics");
  }
  const ws = new WebSocket(`${url().replace(/^http/, "ws")}/ws?shard=global:metrics`);
  const got: any[] = [];
  ws.onmessage = (e) => String(e.data) !== "pong" && got.push(JSON.parse(String(e.data)));
  await new Promise((r) => (ws.onopen = r));
  ws.send(JSON.stringify({ t: "hello", clientId: "e2e", protocol: 1 }));
  ws.send(JSON.stringify({ t: "sub", qid: 1, fn: "notes:count", args: {} }));
  for (let i = 0; i < 10; i++) ws.send(JSON.stringify({ t: "mut", mid: i + 1, fn: "notes:addMany", args: { items: [{ title: `w${i}`, body: "ws", lang: "pt", topic: "x" }] } }));
  for (let i = 0; i < 100 && got.filter((m) => m.t === "mres").length < 10; i++) await sleep(100);
  ws.close();
  say(`ws: ${got.filter((m) => m.t === "mres" && m.ok).length}/10 mutations ok, ${got.filter((m) => m.t === "patch").length} patches`);
  const sql = `SELECT blob5 AS kind, blob9 AS timing, sum(_sample_interval) AS n, avg(double1) AS avg_ms, quantileExactWeighted(0.5)(double1, _sample_interval) AS p50, max(double1) AS max_ms, min(double1) AS min_ms
FROM ember_spike_metrics WHERE blob1 = 'spike-ai' AND timestamp > NOW() - INTERVAL '2' HOUR GROUP BY kind, timing ORDER BY kind, timing`;
  for (let i = 0; i < 12; i++) {
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/analytics_engine/sql`, { method: "POST", headers: auth, body: sql });
    const text = await r.text();
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      say("analytics engine error:", text.slice(0, 300));
      return;
    }
    if (r.ok && body.data?.some((x: any) => x.timing === "commit")) {
      say("analytics engine (ember_spike_metrics, project spike-ai):");
      for (const row of body.data) say(" ", row);
      return;
    }
    await sleep(10_000);
  }
  say("analytics engine: points not visible yet");
}

async function inventory(label: string) {
  const get = async (p: string) => ((await (await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${p}`, { headers: auth })).json()) as any).result ?? [];
  const spike = (s: string) => /ember-spike/.test(s);
  say(`${label}:`, {
    workers: (await get("/workers/scripts")).map((w: any) => w.id).filter(spike),
    vectorize: (await get("/vectorize/v2/indexes")).map((x: any) => x.name).filter(spike),
    aiSearch: (await get("/ai-search/namespaces/default/instances?per_page=100")).map((x: any) => x.id).filter(spike),
    queues: (await get("/queues?per_page=100")).map((x: any) => x.queue_name).filter(spike),
    d1: (await get("/d1/database?per_page=100")).map((x: any) => x.name).filter(spike),
    durableObjectNamespaces: (await get("/workers/durable_objects/namespaces?per_page=1000")).filter((n: any) => spike(n.script ?? "")).map((n: any) => n.name),
  });
}

async function teardown() {
  writeProject("euclidean");
  const r = await destroy(loadProject(ROOT), { env: "test", yes: true, log: (l) => say(l) });
  say("destroy:", r);
  rmSync(ROOT, { recursive: true, force: true });
}

const phase = process.argv[2] ?? "all";
const phases: Record<string, () => Promise<void>> = {
  inventory: () => inventory("inventory"),
  deploy: () => doDeploy("cosine"),
  load,
  search,
  update,
  metric: metricChange,
  durations,
  destroy: async () => {
    await teardown();
    await inventory("after destroy");
  },
};
try {
  if (phase === "all") for (const p of ["inventory", "deploy", "load", "search", "update", "durations", "metric", "destroy"]) {
    say(`\n== ${p}`);
    await phases[p]!();
  }
  else await phases[phase]!();
} catch (e) {
  say("FAILED:", (e as Error).stack ?? String(e));
  process.exitCode = 1;
}
