// Real end-to-end run of the PLAN §13 integrations on Cloudflare: `ember env` (Worker secrets kept across deploys,
// --reveal through the admin endpoint), Turnstile on sign-up/sign-in (Cloudflare's test secrets), `ctx.browser`
// (HTML → PDF and a screenshot), Vectorize with `shardIsolation: "filter"`, AI Search porter vs trigram tokenizer and
// `defaultMode` (pt-BR MRR on docs/spikes/ai-embeddings), and `ember dev --remote` (local workerd, remote bindings).
//
//   node --experimental-transform-types --no-warnings --conditions=@freecorps/ember-source \
//     docs/spikes/remote/scripts/integrations-e2e.ts <phase>
//   phases (comma-separated, run in order in one process): deploy,env,turnstile,browser,load,search,remote-dev
//   then: destroy,verify-gone. The admin token lives only in this process's memory, so phases that need it (env)
//   run in the same invocation as a deploy (every deploy re-uploads it).
//   (Node, not Bun: wrangler's remote bindings refuse to run under Bun.)
//
// Only `ember-spike-*` resources are created (project "spike-integ", env "e2e": Worker ember-spike-integ-e2e; the
// remote dev proxy is named ember-spike-integ-e2e-dev-proxy). The Cloudflare token comes from the CLI's lookup
// (wrangler OAuth) and stays in memory, like the admin token and the test secret values (only hashes and booleans
// are printed). Output is redacted (account id, workers.dev subdomain, local paths).

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadProject, type Project } from "../../../../packages/cli/src/config.ts";
import { init } from "../../../../packages/cli/src/init.ts";
import { deploy } from "../../../../packages/cli/src/deploy/index.ts";
import { CfClient, resolveToken } from "../../../../packages/cli/src/deploy/cf.ts";
import { aiSearchInstanceName, indexingQueueName, planAiResources } from "../../../../packages/cli/src/deploy/ai.ts";
import { destroy } from "../../../../packages/cli/src/destroy.ts";
import { dev } from "../../../../packages/cli/src/dev.ts";
import { envGet, envList, envRm, envSet, type EnvTarget } from "../../../../packages/cli/src/env.ts";
import { docs, queries } from "../../ai-embeddings/dataset.ts";

const HERE = import.meta.dirname;
const ROOT = join(HERE, "../../../../packages/cli/.tmp/ember-spike-integ");
const STATE = join(ROOT, ".e2e-state.json"); // url + ids + secret hash (no values)
const EVIDENCE = join(HERE, "../evidence");
const ENV = "e2e";
const WORKER = "ember-spike-integ-e2e";
const token = resolveToken();
const H = { authorization: `Bearer ${token}` };
const account = ((await (await fetch("https://api.cloudflare.com/client/v4/accounts", { headers: H })).json()) as any).result[0].id as string;
process.env.CLOUDFLARE_ACCOUNT_ID = account;
const subdomain = ((await (await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/subdomain`, { headers: H })).json()) as any).result?.subdomain ?? "";
const redact = (s: string) => {
  let out = s.split(account).join("<ACCOUNT_ID>").split(ROOT).join("<project>");
  if (subdomain) out = out.split(subdomain).join("<subdomain>");
  return out.replace(/\/Users\/[^\s"']+/g, "<path>").replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, (m) => (m.endsWith(".test") ? m : "<email>"));
};
const say = (...xs: unknown[]) => console.log(redact(xs.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const state = (): Record<string, any> => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {});
const save = (patch: Record<string, unknown>) => writeFileSync(STATE, JSON.stringify({ ...state(), ...patch }));
// Admin token: random per process, never written anywhere (a deploy uploads it as EMBER_ADMIN_TOKEN).
const adminToken = randomBytes(24).toString("base64url");

const TURNSTILE_PASS = "1x0000000000000000000000000000000AA";
const TURNSTILE_FAIL = "2x0000000000000000000000000000000AA";
const DUMMY = "XXXX.DUMMY.TOKEN.XXXX";

const SCHEMA = `import { defineSchema, defineTable, v } from "@freecorps/ember-server";

export default defineSchema({
  tables: {
    // From \`ember init --auth\` (ember/users.ts syncs auth users into it).
    profiles: defineTable({ userId: v.string(), email: v.string(), name: v.string(), credits: v.number() }).index("by_user", ["userId"]),
    notes: defineTable({ title: v.string(), body: v.string(), topic: v.string() })
      // More shards than Vectorize namespaces: the shard as an indexed metadata filter.
      .vectorIndex("semantic", { embed: "body", filterFields: ["topic"], shardIsolation: "filter" })
      // Same documents, two AI Search instances: English stemming (porter, default) vs trigram tokenizer.
      .aiSearchIndex("kb_porter", { fields: ["title", "body"], defaultMode: "vector" })
      .aiSearchIndex("kb_trigram", { fields: ["title", "body"], keywordTokenizer: "trigram" }),
  },
});
`;

const NOTES = `import { v } from "@freecorps/ember-server";
import { action, mutation, query } from "./_generated/server";

const mode = v.optional(v.union(v.literal("hybrid"), v.literal("vector"), v.literal("keyword")));

export const addMany = mutation({
  args: { items: v.array(v.object({ title: v.string(), body: v.string(), topic: v.string() })) },
  handler: (ctx, { items }) => items.map((n) => ctx.db.insert("notes", n)),
});
export const list = query({ args: {}, handler: (ctx) => ctx.db.query("notes").collect().map((n) => ({ _id: n._id, title: n.title })) });
export const semantic = action({
  args: { q: v.string(), topic: v.optional(v.string()) },
  handler: (ctx, { q, topic }) => ctx.vectorSearch("notes", "semantic", { text: q, limit: 10, ...(topic ? { filter: { topic } } : {}) }),
});
export const kb = action({
  args: { q: v.string(), index: v.union(v.literal("kb_porter"), v.literal("kb_trigram")), mode },
  handler: (ctx, { q, index, mode }) => ctx.aiSearch("notes", index, { query: q, limit: 10, ...(mode ? { mode } : {}) }),
});
`;

const TOOLS = `import { v } from "@freecorps/ember-server";
import { action } from "./_generated/server";

const sha = async (s: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);

/** Which env names are set and the hash of one (never the value). */
export const secretHash = action({
  args: { name: v.string() },
  handler: async (ctx, { name }) => (typeof ctx.env[name] === "string" ? await sha(ctx.env[name] as string) : null),
});

const INVOICE = (n: string) => \`<!doctype html><html><head><meta charset="utf-8"><style>
body{font-family:sans-serif;margin:40px} h1{color:#c2410c} td,th{border-bottom:1px solid #ddd;padding:6px 12px;text-align:left}
</style></head><body><h1>Fatura \${n}</h1><p>Ember · ctx.browser.pdf (Browser Rendering quick action)</p>
<table><tr><th>Item</th><th>Valor</th></tr><tr><td>Plano anual</td><td>R$ 1.200,00</td></tr><tr><td>Desconto</td><td>- R$ 240,00</td></tr>
<tr><th>Total</th><th>R$ 960,00</th></tr></table></body></html>\`;

export const pdf = action({
  args: { n: v.string() },
  handler: async (ctx, { n }) => {
    const t = Date.now();
    const r = await ctx.browser.pdf({ html: INVOICE(n) }, { format: "a4", margin: { top: "1cm", bottom: "1cm" } });
    const head = new TextDecoder().decode(r.bytes.slice(0, 8));
    let b64 = "";
    for (let i = 0; i < r.bytes.length; i += 0x8000) b64 += String.fromCharCode(...r.bytes.slice(i, i + 0x8000));
    return { size: r.bytes.length, contentType: r.contentType, head, browserMs: r.browserMs, ms: Date.now() - t, base64: btoa(b64) };
  },
});

export const shot = action({
  args: {},
  handler: async (ctx) => {
    const r = await ctx.browser.screenshot({ html: INVOICE("screenshot") }, { viewport: { width: 800, height: 600 } });
    return { size: r.bytes.length, contentType: r.contentType, png: r.bytes[1] === 0x50 && r.bytes[2] === 0x4e && r.bytes[3] === 0x47, browserMs: r.browserMs };
  },
});
`;

function writeProject() {
  if (!existsSync(join(ROOT, "ember.json"))) {
    mkdirSync(ROOT, { recursive: true });
    init({ dir: ROOT, project: "spike-integ", auth: true });
    const cfg = JSON.parse(readFileSync(join(ROOT, "ember.json"), "utf8"));
    cfg.environments = { [ENV]: {} };
    cfg.metrics = { enabled: false };
    cfg.resources = { browser: true };
    cfg.auth = { turnstile: true };
    writeFileSync(join(ROOT, "ember.json"), JSON.stringify(cfg, null, 2));
  }
  writeFileSync(join(ROOT, "ember/schema.ts"), SCHEMA);
  writeFileSync(join(ROOT, "ember/notes.ts"), NOTES);
  writeFileSync(join(ROOT, "ember/tools.ts"), TOOLS);
  rmSync(join(ROOT, "ember/messages.ts"), { force: true });
  rmSync(join(ROOT, "ember/crons.ts"), { force: true });
}
const project = (): Project => loadProject(ROOT);
const target = (): EnvTarget => ({ client: new CfClient({ accountId: account, token }), project: project(), env: ENV, worker: WORKER });

async function call(base: string, kind: "query" | "mutation" | "action", fn: string, args: unknown, shard = "global:main") {
  for (let attempt = 0; ; attempt++) {
    const t = performance.now();
    try {
      const res = await fetch(`${base}/api/${kind}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fn, args, shard }) });
      return { status: res.status, body: (await res.json()) as any, ms: performance.now() - t };
    } catch (e) {
      if (kind === "mutation" || attempt >= 3) throw e;
      await sleep(1000);
    }
  }
}
const value = async (base: string, kind: "query" | "mutation" | "action", fn: string, args: unknown, shard?: string) => {
  const r = await call(base, kind, fn, args, shard);
  if (!r.body.ok) throw new Error(`${fn}: ${JSON.stringify(r.body.error)}`);
  return r.body.value;
};
const url = () => state().url as string;

// ------------------------------------------------------------------------------------------------ phases

async function doDeploy(label: string) {
  writeProject();
  const t = Date.now();
  const r = await deploy(project(), { env: ENV, registry: false, adminToken, wait: { timeoutMs: 180_000 }, log: (l) => say(l) });
  save({ url: r.url });
  say(`${label}: deploy took ${Date.now() - t} ms (strategy ${r.plan.strategy}); bindings: ${r.plan.metadata.bindings.map((b) => `${b.type}:${b.name}`).join(", ")}`);
}

async function envPhase() {
  const t = target();
  const value0 = randomBytes(18).toString("base64url");
  say("ember env set E2E_SECRET:", await envSet(t, "E2E_SECRET", value0));
  say("ember env set TURNSTILE_SECRET_KEY (test secret, always passes):", await envSet(t, "TURNSTILE_SECRET_KEY", TURNSTILE_PASS));
  save({ secretHash: sha(value0) });
  const list = await envList(t);
  say("ember env list:", list.entries.map((e) => `${e.name}:${e.kind}${e.managed ? "(managed)" : ""}`).join(" "));
  say("list output contains the value:", JSON.stringify(list).includes(value0));
  const got = await envGet(t, "E2E_SECRET");
  say("ember env get (no --reveal):", got, "has value:", got !== null && "value" in got);
  const rev = await envGet(t, "E2E_SECRET", { reveal: true, url: url(), adminToken });
  say("ember env get --reveal matches what was set:", rev?.value === value0);
  for (const managed of ["EMBER_AUTH_SECRET", "EMBER_ADMIN_TOKEN"]) {
    try {
      await envGet(t, managed, { reveal: true, url: url(), adminToken });
      say(`--reveal ${managed}: REVEALED (unexpected)`);
    } catch (e) {
      say(`--reveal ${managed} refused:`, (e as Error).message);
    }
  }
  try {
    await envSet(t, "EMBER_ADMIN_TOKEN", "x");
  } catch (e) {
    say("set EMBER_ADMIN_TOKEN refused:", (e as Error).message);
  }
  // The secret is live at once (new version): poll the action until it sees it.
  const s = Date.now();
  for (;;) {
    const h = await value(url(), "action", "tools:secretHash", { name: "E2E_SECRET" });
    if (h === sha(value0)) break;
    if (Date.now() - s > 60_000) throw new Error("secret not visible after 60 s");
    await sleep(1000);
  }
  say(`secret visible to actions ${Date.now() - s} ms after ember env set returned`);
}

async function keptPhase() {
  // Code-only redeploy (an extra action): secrets must survive (keep_bindings).
  writeFileSync(join(ROOT, "ember/extra.ts"), `import { query } from "./_generated/server";\nexport const ping = query({ args: {}, handler: () => "pong" });\n`);
  await doDeploy("redeploy");
  const list = await envList(target());
  say("after redeploy, ember env list:", list.entries.filter((e) => !e.managed).map((e) => e.name).join(" "));
  const h = await value(url(), "action", "tools:secretHash", { name: "E2E_SECRET" });
  say("after redeploy, actions see the same E2E_SECRET:", h === state().secretHash);
}

async function turnstilePhase() {
  const signUp = async (email: string, captcha?: string) => {
    const r = await fetch(`${url()}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: url(), ...(captcha ? { "x-captcha-response": captcha } : {}) },
      body: JSON.stringify({ email, password: "correct horse battery staple", name: "E2E" }),
    });
    return { status: r.status, body: (await r.json().catch(() => null)) as any };
  };
  const signIn = async (email: string, captcha?: string) => {
    const r = await fetch(`${url()}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: url(), ...(captcha ? { "x-captcha-response": captcha } : {}) },
      body: JSON.stringify({ email, password: "correct horse battery staple" }),
    });
    return { status: r.status, body: (await r.json().catch(() => null)) as any };
  };
  const email = `e2e-${Date.now()}@spike.test`;
  const a = await signUp(email);
  say("sign-up without token:", a.status, a.body?.code);
  const b = await signUp(email, DUMMY);
  say("sign-up with the dummy token (secret 1x…AA, always passes):", b.status, b.body?.user ? "user created" : b.body);
  const c = await signIn(email);
  say("sign-in without token:", c.status, c.body?.code);
  const d = await signIn(email, DUMMY);
  say("sign-in with the dummy token:", d.status, d.body?.token ? "session token issued" : d.body);
  // Swap to the always-fail test secret.
  await envSet(target(), "TURNSTILE_SECRET_KEY", TURNSTILE_FAIL);
  const s = Date.now();
  let e: Awaited<ReturnType<typeof signIn>>;
  for (;;) {
    e = await signIn(email, DUMMY);
    if (e.status === 403 || Date.now() - s > 60_000) break;
    await sleep(1500);
  }
  say(`sign-in with the always-fail secret (2x…AA): ${e.status} ${e.body?.code} (${Date.now() - s} ms after the secret change)`);
  await envSet(target(), "TURNSTILE_SECRET_KEY", TURNSTILE_PASS);
}

async function browserPhase(base = url(), label = "deployed") {
  const r = (await value(base, "action", "tools:pdf", { n: `${label}-001` })) as any;
  say(`${label} ctx.browser.pdf: ${r.size} bytes, ${r.contentType}, starts with ${JSON.stringify(r.head)}, browserMs ${r.browserMs}, action ${r.ms} ms`);
  const bytes = Buffer.from(r.base64, "base64");
  const pages = (bytes.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
  say(`${label} pdf pages: ${pages}; sha256 ${sha(bytes.toString("latin1"))}`);
  mkdirSync(EVIDENCE, { recursive: true });
  writeFileSync(join(EVIDENCE, `integrations-${label}-invoice.pdf`), bytes);
  const s = (await value(base, "action", "tools:shot", {})) as any;
  say(`${label} ctx.browser.screenshot:`, s);
}

const DOCS = Object.entries(docs);
const topicOf = (id: string) => (["d13", "d14", "d15", "d24"].includes(id) ? "rh" : "atendimento");

async function load() {
  const items = DOCS.map(([id, body]) => ({ title: id, body, topic: topicOf(id) }));
  const t0 = Date.now();
  const ids = (await value(url(), "mutation", "notes:addMany", { items })) as string[];
  save({ ids: Object.fromEntries(DOCS.map(([k], i) => [k, ids[i]!])), loadedAt: t0 });
  await value(url(), "mutation", "notes:addMany", { items: [{ title: "outro", body: "Para redefinir sua senha use o link de recuperação.", topic: "atendimento" }] }, "global:other");
  say(`inserted ${ids.length} notes (global:main) + 1 (global:other) in ${Date.now() - t0} ms`);
  const until = async (label: string, f: () => Promise<boolean>, max = 900_000) => {
    for (let i = 0; Date.now() - t0 < max; i++) {
      try {
        if (await f()) return say(`${label}: searchable ${Date.now() - t0} ms after the write`);
      } catch (e) {
        if (i % 10 === 0) say(`${label}: ${(e as Error).message.slice(0, 160)}`);
      }
      await sleep(Math.min(10_000, 1000 * (i + 1)));
    }
    say(`${label}: NOT searchable after ${max} ms`);
  };
  await until("vectorize semantic (shardIsolation filter)", async () => ((await value(url(), "action", "notes:semantic", { q: queries[0]!.q })) as any[]).length >= 10);
  for (const index of ["kb_porter", "kb_trigram"]) {
    await until(`ai-search ${index}`, async () => ((await value(url(), "action", "notes:kb", { q: "reembolso compra cancelada", index, mode: "hybrid" })) as any[]).length >= 3);
  }
}

async function search() {
  const st = state();
  const idToKey = Object.fromEntries(Object.entries(st.ids as Record<string, string>).map(([k, v]) => [v, k]));
  const score = async (fn: string, extra: Record<string, unknown> = {}) => {
    let r1 = 0, r3 = 0, mrr = 0;
    const lat: number[] = [];
    for (const { q, rel } of queries) {
      const r = await call(url(), "action", fn, { q, ...extra });
      if (!r.body.ok) throw new Error(`${fn}: ${JSON.stringify(r.body.error)}`);
      lat.push(r.ms);
      const ranked = (r.body.value as Array<{ _id: string }>).map((x) => idToKey[x._id]);
      const rank = ranked.indexOf(rel);
      if (rank === 0) r1++;
      if (rank >= 0 && rank < 3) r3++;
      if (rank >= 0 && rank < 10) mrr += 1 / (rank + 1);
    }
    lat.sort((a, b) => a - b);
    const n = queries.length;
    return { r1: +(r1 / n).toFixed(3), r3: +(r3 / n).toFixed(3), mrr10: +(mrr / n).toFixed(3), p50: Math.round(lat[n >> 1]!), p95: Math.round(lat[Math.floor(n * 0.95)]!) };
  };
  const rows: Record<string, unknown> = {};
  rows["vectorize semantic (filter isolation)"] = await score("notes:semantic");
  for (const index of ["kb_porter", "kb_trigram"]) {
    for (const mode of ["hybrid", "keyword", "vector"]) rows[`${index} ${mode}`] = await score("notes:kb", { index, mode });
  }
  rows["kb_porter (no mode → defaultMode vector)"] = await score("notes:kb", { index: "kb_porter" });
  for (const [k, v] of Object.entries(rows)) say(k.padEnd(42), v);
  // Shard isolation with the _shard filter: the other shard sees only its own document.
  const other = (await value(url(), "action", "notes:semantic", { q: "esqueci a senha" }, "global:other")) as any[];
  say("global:other semantic results:", other.length, other.every((x) => !idToKey[x._id]) ? "(none from global:main)" : "(LEAK)");
  const rh = (await value(url(), "action", "notes:semantic", { q: "benefícios dos funcionários", topic: "rh" })) as any[];
  say("topic=rh filter next to _shard:", rh.map((x) => idToKey[x._id]).join(", "));
  // The Vectorize index carries the _shard metadata index.
  const vec = planAiResources({ tables: { notes: { indexes: [{ kind: "vector", name: "semantic", fields: [], config: { dimensions: 1024, metric: "cosine", embed: { model: "@cf/baai/bge-m3" }, metadata: { topic: { key: "topic", type: "string" } }, shardIsolation: "filter" } }] } } }, "spike-integ", ENV).vectorize[0]!.name;
  const meta = (await (await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/vectorize/v2/indexes/${vec}/metadata_index/list`, { headers: H })).json()) as any;
  say(`vectorize ${vec} metadata indexes:`, meta.result?.metadataIndexes);
  for (const name of ["kb_porter", "kb_trigram"]) {
    const inst = (await (await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/ai-search/namespaces/default/instances/${aiSearchInstanceName("spike-integ", ENV, "notes", name)}`, { headers: H })).json()) as any;
    say(`ai-search ${name}: indexing_options`, inst.result?.indexing_options, "retrieval_options", inst.result?.retrieval_options);
  }
}

async function remoteDev() {
  writeProject();
  const port = 8799;
  const server = await dev(project(), { port, persist: false, remote: { env: ENV }, log: (l) => say(`[dev] ${l}`) });
  const base = server.url.href.replace(/\/$/, "");
  try {
    const shard = "global:devremote";
    const t0 = Date.now();
    const items = [
      { title: "r1", body: "O reembolso de compras canceladas cai no mesmo cartão em até 10 dias úteis.", topic: "atendimento" },
      { title: "r2", body: "Férias podem ser divididas em três períodos, combinadas com o gestor.", topic: "rh" },
      { title: "r3", body: "O rastreio do pedido chega por SMS quando sai do centro de distribuição.", topic: "atendimento" },
    ];
    const ids = (await value(base, "mutation", "notes:addMany", { items }, shard)) as string[];
    say(`[remote dev] inserted ${ids.length} notes on ${shard} (local shard; delivered to the remote indexes in the shard's turn)`);
    let found = false;
    for (let i = 0; i < 120 && !found; i++) {
      const hits = (await value(base, "action", "notes:semantic", { q: "devolução do dinheiro de compra cancelada" }, shard)) as any[];
      found = hits[0]?._id === ids[0];
      if (!found) await sleep(5000);
    }
    say(`[remote dev] local action → remote Workers AI + Vectorize found the right note: ${found} (${Date.now() - t0} ms after the write)`);
    const lat: number[] = [];
    for (let i = 0; i < 10; i++) lat.push((await call(base, "action", "notes:semantic", { q: "rastreio do pedido" }, shard)).ms);
    lat.sort((a, b) => a - b);
    say(`[remote dev] semantic action p50 ${Math.round(lat[5]!)} ms, max ${Math.round(lat[9]!)} ms (local workerd, remote AI + Vectorize)`);
    let aisFound = false;
    for (let i = 0; i < 6 && !aisFound; i++) {
      const hits = (await value(base, "action", "notes:kb", { q: "reembolso compra cancelada", index: "kb_trigram", mode: "vector" }, shard)) as any[];
      aisFound = hits.some((h) => h._id === ids[0]);
      if (!aisFound) await sleep(10_000);
    }
    say(`[remote dev] AI Search on the local BM25 fallback (not proxied) found it: ${aisFound} (${Date.now() - t0} ms after the write)`);
    await browserPhase(base, "remote-dev");
    // Isolation: the dev shard does not see the deployed global:main documents (folder / _shard filter).
    const leak = (await value(base, "action", "notes:semantic", { q: "esqueci a senha" }, shard)) as any[];
    say(`[remote dev] ${shard} semantic results: ${leak.length} (only its 3 notes: ${leak.every((x) => ids.includes(x._id))})`);
  } finally {
    await server.close();
  }
  const proxy = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${WORKER}-dev-proxy`, { headers: H });
  say(`[remote dev] after close: GET /workers/scripts/${WORKER}-dev-proxy -> ${proxy.status}`);
}

async function teardown() {
  writeProject();
  const t = target();
  for (const n of ["E2E_SECRET", "TURNSTILE_SECRET_KEY"]) say(`ember env rm ${n}:`, await envRm(t, n).catch((e) => (e as Error).message));
  const r = await destroy(project(), { env: ENV, yes: true, log: (l: string) => say(l) });
  say("destroy:", r);
}

async function verifyGone() {
  const vec = planAiResources({ tables: { notes: { indexes: [{ kind: "vector", name: "semantic", fields: [], config: { dimensions: 1024, metric: "cosine", embed: { model: "@cf/baai/bge-m3" }, metadata: {}, shardIsolation: "filter" } }] } } }, "spike-integ", ENV).vectorize[0]!.name;
  const paths = [
    `/workers/scripts/${WORKER}`,
    `/workers/scripts/${WORKER}-dev-proxy`,
    `/vectorize/v2/indexes/${vec}`,
    `/ai-search/namespaces/default/instances/${aiSearchInstanceName("spike-integ", ENV, "notes", "kb_porter")}`,
    `/ai-search/namespaces/default/instances/${aiSearchInstanceName("spike-integ", ENV, "notes", "kb_trigram")}`,
  ];
  for (const p of paths) {
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}${p}`, { headers: H });
    const b = (await r.json().catch(() => ({}))) as any;
    say(`GET ${p} -> ${r.status} ${(b.errors ?? []).map((e: any) => `[${e.code} ${e.message}]`).join(" ")}`);
  }
  const q = (await (await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/queues?name=${indexingQueueName("spike-integ", ENV)}`, { headers: H })).json()) as any;
  say(`GET /queues?name=${indexingQueueName("spike-integ", ENV)} -> ${(q.result ?? []).length} queues`);
  const allVec = (await (await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/vectorize/v2/indexes`, { headers: H })).json()) as any;
  say("vectorize indexes named ember-spike-integ*:", (allVec.result ?? []).filter((x: any) => x.name.startsWith("ember-spike-integ")).length);
  const allAis = (await (await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/ai-search/namespaces/default/instances?search=ember-spike-integ`, { headers: H })).json()) as any;
  say("ai-search instances named ember-spike-integ*:", (allAis.result ?? []).length);
  const scripts = (await (await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts`, { headers: H })).json()) as any;
  say("workers named ember-spike-integ*:", (scripts.result ?? []).filter((x: any) => String(x.id).startsWith("ember-spike-integ")).map((x: any) => x.id));
}

const phases: Record<string, () => Promise<unknown>> = {
  deploy: () => doDeploy("first deploy"),
  env: async () => {
    await envPhase();
    await keptPhase();
  },
  turnstile: turnstilePhase,
  browser: () => browserPhase(),
  load,
  search,
  "remote-dev": remoteDev,
  destroy: teardown,
  "verify-gone": verifyGone,
};
for (const phase of (process.argv[2] ?? "").split(",").filter(Boolean)) {
  const run = phases[phase];
  if (!run) throw new Error(`unknown phase ${phase}: ${Object.keys(phases).join(", ")}`);
  const t0 = Date.now();
  say(`=== ${phase}`);
  await run();
  say(`phase ${phase} done in ${Date.now() - t0} ms`);
}
