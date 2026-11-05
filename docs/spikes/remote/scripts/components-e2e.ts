// Real end-to-end run of components (PLAN §12) on Cloudflare: `ember deploy` of an app that installs rateLimit (with
// a Cloudflare Rate Limiting binding), workflows and a small custom component with an HTTP route; then the
// component semantics in production (transactional limits, isolation, scoped HTTP routes, a durable workflow with
// action, mutation, sleep and event steps driven by the shard's alarm), and `ember destroy`.
//
//   bun run docs/spikes/remote/scripts/components-e2e.ts <phase>     (phases: all | deploy | run | destroy | inventory)
//
// Only `ember-spike-*` resources: project "spike-comp", env "test" → Worker ember-spike-comp-test. No registry (D1)
// and no metrics dataset. The Cloudflare token comes from the CLI's lookup (wrangler OAuth) and stays in memory; the
// admin token is random per run. Output is redacted (account id, workers.dev subdomain, local paths).
//
// The project lives in packages/runtime/.tmp (its node_modules has the component packages) and is deleted by
// `destroy`.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { loadProject } from "../../../../packages/cli/src/config.ts";
import { init } from "../../../../packages/cli/src/init.ts";
import { deploy } from "../../../../packages/cli/src/deploy/index.ts";
import { resolveToken } from "../../../../packages/cli/src/deploy/cf.ts";
import { destroy } from "../../../../packages/cli/src/destroy.ts";

const ROOT = join(import.meta.dir, "../../../../packages/runtime/.tmp/ember-spike-comp");
const STATE = join(ROOT, ".e2e-state.json"); // url only (no secrets)
const WORKER = "ember-spike-comp-test";
const token = resolveToken();
const auth = { authorization: `Bearer ${token}` };
const account = ((await (await fetch("https://api.cloudflare.com/client/v4/accounts", { headers: auth })).json()) as any).result[0].id as string;
const subdomain = ((await (await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/subdomain`, { headers: auth })).json()) as any).result?.subdomain ?? "";
const redact = (s: string) => {
  let out = s.split(account).join("<ACCOUNT_ID>").split(ROOT).join("<project>");
  if (subdomain) out = out.split(subdomain).join("<subdomain>");
  return out.replace(/\/Users\/[^\s"']+/g, "<path>");
};
const say = (...xs: unknown[]) => console.log(redact(xs.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const adminToken = randomBytes(24).toString("base64url");

const SCHEMA = `import { defineSchema, defineTable, v } from "@freecorps/ember-server";
export default defineSchema({ tables: { posts: defineTable({ user: v.string(), text: v.string() }), log: defineTable({ label: v.string() }) } });
`;

// A custom component with a table, a public mutation, an internal one, and an HTTP route.
const HITS = `import { componentBuilders, defineComponent, defineSchema, defineTable, httpRouter, v } from "@freecorps/ember-server";
const schema = defineSchema({ tables: { hits: defineTable({ path: v.string(), n: v.number() }).index("by_path", ["path"]) } });
const c = componentBuilders<typeof schema, { label: string }>();
const bump = (ctx: any, path: string) => {
  const row = ctx.db.query("hits").withIndex("by_path", (q: any) => q.eq("path", path)).unique();
  if (row) ctx.db.patch(row._id, { n: row.n + 1 });
  else ctx.db.insert("hits", { path, n: 1 });
  return (row?.n ?? 0) + 1;
};
const hook = c.httpAction(async (ctx, req) => {
  const n = await ctx.runMutation("lib:bump" as any, { path: new URL(req.url).pathname });
  return Response.json({ n, label: ctx.component.config.label, shard: ctx.shard });
});
export const hits = defineComponent({
  name: "hits",
  schema,
  config: v.object({ label: v.string() }),
  functions: {
    lib: {
      bump: c.mutation({ args: { path: v.string() }, handler: (ctx, a) => bump(ctx, a.path) }),
      get: c.query({ args: { path: v.string() }, handler: (ctx, a) => ctx.db.query("hits").withIndex("by_path", (q) => q.eq("path", a.path)).unique()?.n ?? 0 }),
      secret: c.internalMutation({ args: {}, handler: () => "secret" }),
    },
    hooks: { hook },
  },
  http: httpRouter().route({ pathPrefix: "/in/", method: "POST", handler: hook }),
});
`;

const APP = `import { defineApp } from "@freecorps/ember-server";
import { rateLimit } from "@freecorps/ember-rate-limit";
import { workflows } from "@freecorps/ember-workflows";
import { hits } from "../components/hits";
export default defineApp()
  .use(rateLimit, { config: { binding: { name: "EMBER_SPIKE_RL", limit: 5, period: 60 } } })
  .use(workflows)
  .use(hits, { name: "web", config: { label: "spike" } });
`;

const HTTP = `import { httpRouter } from "@freecorps/ember-server";
import { httpAction } from "./_generated/server";
const http = httpRouter();
http.route({ path: "/hello", method: "GET", handler: httpAction(async (ctx) => new Response("hello " + ((await ctx.auth.getUserIdentity())?.subject ?? "anon"))) });
export default http;
`;

const FNS = `import { v } from "@freecorps/ember-server";
import { edgeLimit, MINUTE, RateLimiter } from "@freecorps/ember-rate-limit";
import { WorkflowManager } from "@freecorps/ember-workflows";
import { action, components, internalAction, internalMutation, mutation, query } from "./_generated/server";

const limiter = new RateLimiter(components.rateLimit, { post: { kind: "token bucket", rate: 2, period: MINUTE, capacity: 2 } });
const workflow = new WorkflowManager(components.workflows);

export const post = mutation({
  args: { user: v.string(), text: v.string(), fail: v.optional(v.boolean()) },
  handler: (ctx, a) => {
    const r = limiter.limit(ctx, "post", { key: a.user });
    if (!r.ok) return r;
    ctx.db.insert("posts", { user: a.user, text: a.text });
    if (a.fail) throw new Error("post failed after taking a token");
    return r;
  },
});
export const tokens = query({ args: { user: v.string() }, handler: (ctx, a) => limiter.getValue(ctx, "post", { key: a.user }) });
export const hits = query({ args: { path: v.string() }, handler: (ctx, a) => ctx.runQuery(components.web.lib.get, a) });
export const edge = action({ args: { key: v.string() }, handler: async (ctx, a) => (await edgeLimit(ctx, "EMBER_SPIKE_RL", a.key)).ok });

export const record = internalMutation({ args: { label: v.string() }, handler: (ctx, a) => ctx.db.insert("log", { label: a.label }) });
export const lookup = internalAction({ args: { x: v.number() }, handler: async (_ctx, a) => ({ x: a.x, at: Date.now() }) });
export const flow = workflow.define({
  args: { x: v.number() },
  handler: async (step, { x }) => {
    const r = await step.runAction<{ x: number; at: number }>("fns:lookup", { x });
    await step.runMutation("fns:record", { label: "looked-up:" + r.x });
    await step.sleep(3000);
    const ev = await step.waitForEvent<{ y: number }>("go", { timeoutMs: 600_000 });
    await step.runMutation("fns:record", { label: "done:" + ev.y });
    return r.x + ev.y;
  },
});
export const start = mutation({ args: { x: v.number() }, handler: (ctx, a) => workflow.start(ctx, "fns:flow", a) });
export const status = query({ args: { id: v.string() }, handler: (ctx, a) => workflow.status(ctx, a.id) });
export const journal = query({ args: { id: v.string() }, handler: (ctx, a) => workflow.steps(ctx, a.id) });
export const event = mutation({ args: { id: v.string(), y: v.number() }, handler: (ctx, a) => workflow.sendEvent(ctx, a.id, "go", { y: a.y }) });
export const logs = query({ args: {}, handler: (ctx) => ctx.db.query("log").collect().map((l) => l.label) });
`;

function writeProject() {
  if (!existsSync(join(ROOT, "ember.json"))) {
    mkdirSync(ROOT, { recursive: true });
    init({ dir: ROOT, project: "spike-comp" });
    const cfg = JSON.parse(readFileSync(join(ROOT, "ember.json"), "utf8"));
    cfg.account = account;
    cfg.environments = { test: {} };
    cfg.metrics = { enabled: false };
    writeFileSync(join(ROOT, "ember.json"), JSON.stringify(cfg, null, 2));
  }
  mkdirSync(join(ROOT, "components"), { recursive: true });
  writeFileSync(join(ROOT, "components/hits.ts"), HITS);
  writeFileSync(join(ROOT, "ember/schema.ts"), SCHEMA);
  writeFileSync(join(ROOT, "ember/ember.config.ts"), APP);
  writeFileSync(join(ROOT, "ember/http.ts"), HTTP);
  writeFileSync(join(ROOT, "ember/fns.ts"), FNS);
  for (const f of ["messages.ts", "crons.ts"]) rmSync(join(ROOT, "ember", f), { force: true });
}

const url = () => (JSON.parse(readFileSync(STATE, "utf8")) as { url: string }).url;
async function call(kind: "query" | "mutation" | "action", fn: string, args: unknown, shard = "global:main") {
  const t = performance.now();
  const res = await fetch(`${url()}/api/${kind}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fn, args, shard }) });
  return { status: res.status, body: (await res.json()) as any, ms: Math.round(performance.now() - t) };
}
const value = async (kind: "query" | "mutation" | "action", fn: string, args: unknown, shard?: string) => {
  const r = await call(kind, fn, args, shard);
  if (!r.body.ok) throw new Error(`${fn}: ${JSON.stringify(r.body.error)}`);
  return r.body.value;
};
const check = (label: string, ok: boolean, detail?: unknown) => {
  say(`${ok ? "PASS" : "FAIL"} ${label}${detail === undefined ? "" : " " + JSON.stringify(detail)}`);
  if (!ok) process.exitCode = 1;
};

async function doDeploy() {
  writeProject();
  const project = loadProject(ROOT);
  const t = Date.now();
  const r = await deploy(project, { env: "test", registry: false, adminToken, wait: { timeoutMs: 180_000 }, log: (l) => say(l) });
  writeFileSync(STATE, JSON.stringify({ url: r.url }));
  say(`deploy took ${Date.now() - t} ms`);
  // The Worker's bindings as Cloudflare stored them (the rate limit binding the component asked for).
  const settings = (await (await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${WORKER}/settings`, { headers: auth })).json()) as any;
  const rl = (settings.result?.bindings ?? []).filter((b: any) => b.type === "ratelimit");
  say("ratelimit bindings on the Worker:", rl);
}

async function doRun() {
  const shard = `global:e2e-${Date.now()}`;
  // 1. Rate limit, transactional, in production.
  const posts = [];
  for (let i = 0; i < 3; i++) posts.push(await call("mutation", "fns:post", { user: "ana", text: `p${i}` }, shard));
  say("posts (capacity 2):", posts.map((p) => ({ value: p.body.value, ms: p.ms })));
  check("rateLimit: 2 allowed then refused with retryAfter", posts[0]!.body.value.ok && posts[1]!.body.value.ok && posts[2]!.body.value.ok === false && posts[2]!.body.value.retryAfter > 0);
  const failed = await call("mutation", "fns:post", { user: "bia", text: "x", fail: true }, shard);
  const bia = await value("query", "fns:tokens", { user: "bia" }, shard);
  check("rateLimit: a failing caller gives the token back (same transaction)", failed.body.ok === false && bia.value === 2, { error: failed.body.error, tokens: bia });

  // 2. Isolation from clients.
  for (const [kind, fn] of [["mutation", "@rateLimit/lib:limit"], ["query", "@web/lib:get"], ["mutation", "@web/lib:secret"], ["action", "@workflows/lib:drive"]] as const) {
    const r = await call(kind, fn, {}, shard);
    check(`clients cannot call ${fn}`, r.body.ok === false && r.body.error.code === "FunctionNotFound", r.body.error);
  }

  // 3. HTTP routes (app + component, mounted under /web).
  const hello = await fetch(`${url()}/hello`);
  check("http: app route", (await hello.text()) === "hello anon");
  const t0 = performance.now();
  const hook = await fetch(`${url()}/web/in/abc`, { method: "POST" });
  const hookBody = (await hook.json()) as any;
  check("http: component route in the component's scope", hook.status === 200 && hookBody.n === 1 && hookBody.label === "spike" && hookBody.shard === "global:main", { ...hookBody, ms: Math.round(performance.now() - t0) });
  check("http: app reads the component through components.web", (await value("query", "fns:hits", { path: "/web/in/abc" })) === 1);
  check("http: wrong method is 405", (await fetch(`${url()}/web/in/abc`)).status === 405);

  // 4. Workflow: action step (alarm-run, no queue), mutation step, 3 s sleep, event wait, completion.
  const started = Date.now();
  const id = (await value("mutation", "fns:start", { x: 40 }, shard)) as string;
  let st: any;
  const seen: string[] = [];
  for (let i = 0; i < 120; i++) {
    st = await value("query", "fns:status", { id }, shard);
    const tag = `${st.status}:${st.stepCount}:${st.current?.kind ?? "-"}`;
    if (seen.at(-1) !== tag) {
      seen.push(tag);
      say(`  workflow +${Date.now() - started} ms ${tag}`);
    }
    if (st.current?.kind === "event") break;
    await sleep(250);
  }
  check("workflow: reached waitForEvent after action, mutation and sleep steps", st.current?.kind === "event" && st.stepCount === 4, st);
  const sent = Date.now();
  await value("mutation", "fns:event", { id, y: 2 }, shard);
  for (let i = 0; i < 80; i++) {
    st = await value("query", "fns:status", { id }, shard);
    if (st.status !== "running") break;
    await sleep(250);
  }
  say(`  workflow completed ${Date.now() - sent} ms after the event (${Date.now() - started} ms total)`);
  const journal = (await value("query", "fns:journal", { id }, shard)) as any[];
  say("  journal:", journal.map((s) => ({ index: s.index, kind: s.kind, name: s.name, status: s.status, attempts: s.attempts, ms: s.completedAt - s.startedAt })));
  check("workflow: completed with the result", st.status === "completed" && st.result === 42, st);
  check("workflow: mutation steps ran exactly once", JSON.stringify(await value("query", "fns:logs", {}, shard)) === JSON.stringify(["looked-up:40", "done:2"]));
  const sleepStep = journal.find((s) => s.kind === "sleep");
  check("workflow: the sleep lasted >= 3 s (alarm)", sleepStep && sleepStep.completedAt - sleepStep.startedAt >= 3000, sleepStep);

  // 5. Cloudflare Rate Limiting binding (approximate, per location): 12 calls, same key, limit 5 / 60 s.
  const edge: boolean[] = [];
  for (let i = 0; i < 12; i++) edge.push(await value("action", "fns:edge", { key: `k-${shard}` }));
  say("edgeLimit results:", edge);
  check("edgeLimit: the binding works and eventually refuses", edge[0] === true && edge.includes(false), { allowed: edge.filter(Boolean).length });
}

async function doDestroy() {
  if (existsSync(join(ROOT, "ember.json"))) {
    const project = loadProject(ROOT);
    const r = await destroy(project, { env: "test", yes: true, log: (l) => say(l) });
    say("destroy:", r);
  }
  rmSync(ROOT, { recursive: true, force: true });
  await inventory();
}

async function inventory() {
  const scripts = ((await (await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts`, { headers: auth })).json()) as any).result ?? [];
  const queues = ((await (await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/queues?per_page=100`, { headers: auth })).json()) as any).result ?? [];
  const d1 = ((await (await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database?per_page=100`, { headers: auth })).json()) as any).result ?? [];
  const spikeScripts = scripts.map((s: any) => s.id).filter((n: string) => n.startsWith("ember-spike-comp"));
  const spikeQueues = queues.map((q: any) => q.queue_name).filter((n: string) => n.startsWith("ember-spike-comp"));
  const spikeD1 = d1.map((d: any) => d.name).filter((n: string) => n.startsWith("ember-spike-comp"));
  say("inventory ember-spike-comp*: workers", spikeScripts, "queues", spikeQueues, "d1", spikeD1, "| local project exists:", existsSync(ROOT));
  const script = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${WORKER}/settings`, { headers: auth });
  say(`GET ${WORKER}/settings → HTTP ${script.status}`);
}

const phase = process.argv[2] ?? "all";
if (phase === "deploy" || phase === "all") await doDeploy();
if (phase === "run" || phase === "all") {
  try {
    await doRun();
  } catch (e) {
    say("run failed:", String(e));
    process.exitCode = 1;
  }
}
if (phase === "destroy" || phase === "all") await doDestroy();
if (phase === "inventory") await inventory();
