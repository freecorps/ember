// Real end-to-end run of the email component (PLAN §16, R11) in a Cloudflare account, with nothing but the component:
//   deploy examples/email-lite as ember-spike-mail-test → onboard ember-spike-mail.<zone> from this machine with
//   `@freecorps/ember-email/cloudflare` (CLI token lookup, in memory; the Worker holds no Cloudflare token) →
//   event subscription → the component's events queue → send to addresses on the test subdomain only → measure the
//   event queue (latency, duplicates, order) → receiving: checked; with SPIKE_ENABLE_ROUTING=1 the routing subdomain
//   is created and a mail between two mailboxes of the domain closes send → email() → thread → reply (the routing
//   subdomain then has to be removed in the dashboard: there is no API for it) → delete everything and verify.
//
//   bun --conditions=@freecorps/ember-source run docs/spikes/remote/scripts/email-e2e.ts all|inventory|cleanup
//
// Only `ember-spike-*` resources. Never touches existing DNS records, routing rules, catch-alls or apex settings.
// Output is redacted (account id, zone, workers.dev subdomain, local paths).

import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { projectFrom } from "../../../../packages/cli/src/config.ts";
import { resolveToken } from "../../../../packages/cli/src/deploy/cf.ts";
import { deploy } from "../../../../packages/cli/src/deploy/index.ts";
import { destroy } from "../../../../packages/cli/src/destroy.ts";
import { destroyDomain, emailResources, resolveAccountId, syncDomain, type CfCreds, type DomainState } from "../../../../packages/email/src/cloudflare/index.ts";

const ZONE = process.env.SPIKE_ZONE ?? "freecorps.com.br";
const DOMAIN = `ember-spike-mail.${ZONE}`;
const PROJECT = "spike-mail";
const ENV = "test";
const { worker: WORKER, eventsQueue: QUEUE } = emailResources(PROJECT, ENV);
const ROUTING = process.env.SPIKE_ENABLE_ROUTING === "1";
const ROOT = join(import.meta.dir, "../../../../examples/email-lite");
const apiToken = resolveToken();
const c: CfCreds = { apiToken, accountId: await resolveAccountId(apiToken, { env: process.env }) };
const H = { authorization: `Bearer ${c.apiToken}` };
const sub = ((await (await fetch(`https://api.cloudflare.com/client/v4/accounts/${c.accountId}/workers/subdomain`, { headers: H })).json()) as any).result?.subdomain ?? "";
const redact = (s: string) => {
  let out = s.split(c.accountId).join("<ACCOUNT_ID>").split(ROOT).join("<examples/email-lite>").split(ZONE).join("<zone>");
  if (sub) out = out.split(sub).join("<subdomain>");
  return out.replace(/\/Users\/[^\s"']+/g, "<path>").replace(/\b[0-9a-f]{32}\b/g, "<id>");
};
const say = (...xs: unknown[]) => console.log(redact(xs.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cf = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`https://api.cloudflare.com/client/v4${path.replace("{account}", c.accountId)}`, { method, headers: { ...H, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, ...((await r.json().catch(() => ({}))) as any) };
};
const project = () =>
  projectFrom(ROOT, { project: PROJECT, account: c.accountId, compatibilityDate: "2026-10-01", metrics: { enabled: false }, environments: { [ENV]: {} } } as any);

/** The deployed email-lite Worker (admin-only routes, see examples/email-lite/ember/http.ts). */
const app = (url: string, admin: string) => async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${url}${path}`, { method, headers: { authorization: `Bearer ${admin}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, body: (await r.json().catch(() => null)) as any };
};

async function zoneId() {
  return (await cf("GET", `/zones?name=${ZONE}`)).result[0].id as string;
}

async function inventory(label: string) {
  const z = await zoneId();
  const workers = ((await cf("GET", "/accounts/{account}/workers/scripts")).result ?? []).map((w: any) => w.id).filter((n: string) => n.startsWith("ember-spike-mail"));
  const queues = ((await cf("GET", "/accounts/{account}/queues?per_page=100")).result ?? []).map((q: any) => q.queue_name).filter((n: string) => n.startsWith("ember-spike-mail"));
  const buckets = ((await cf("GET", "/accounts/{account}/r2/buckets")).result?.buckets ?? []).map((b: any) => b.name).filter((n: string) => n.startsWith("ember-spike-mail"));
  const sending = ((await cf("GET", `/zones/${z}/email/sending/subdomains`)).result ?? []).map((s: any) => s.name).filter((n: string) => n.startsWith("ember-spike"));
  const subs = ((await cf("GET", "/accounts/{account}/event_subscriptions/subscriptions?per_page=100")).result ?? []).map((s: any) => s.name).filter((n: string) => n?.startsWith("ember-spike"));
  const routing = await cf("GET", `/zones/${z}/email/routing`);
  const rules = ((await cf("GET", `/zones/${z}/email/routing/rules?per_page=200`)).result ?? []) as any[];
  const inv = {
    workers,
    queues,
    buckets,
    sendingDomains: sending,
    subscriptions: subs,
    spikeRoutingRules: rules.filter((r) => JSON.stringify(r.matchers).includes("ember-spike")).length,
    routingSubdomains: (routing.result?.subdomains ?? []).map((s: any) => s.name),
    routingRulesTotal: rules.length,
  };
  say(`inventory ${label}:`, inv);
  return inv;
}

async function cleanup(state: DomainState | null) {
  say("--- cleanup");
  if (state) {
    const errors = await destroyDomain(c, state);
    say("domain resources removed", errors.length ? errors : "ok");
  }
  // Fallback by name (a crashed run): rules, sending onboarding and subscriptions of the spike domain only.
  const z = await zoneId();
  for (const r of ((await cf("GET", `/zones/${z}/email/routing/rules?per_page=200`)).result ?? []) as any[]) {
    if (r.matchers?.some((m: any) => m.type === "literal" && String(m.value).endsWith(`@${DOMAIN}`))) say("delete rule", (await cf("DELETE", `/zones/${z}/email/routing/rules/${r.id}`)).success);
  }
  for (const s of (await cf("GET", `/zones/${z}/email/sending/subdomains`)).result ?? []) {
    if (s.name === DOMAIN) say("delete sending domain", (await cf("DELETE", `/zones/${z}/email/sending/subdomains/${s.tag}`)).success);
  }
  for (const s of (await cf("GET", "/accounts/{account}/event_subscriptions/subscriptions?per_page=100")).result ?? []) {
    if (s.name?.startsWith("ember-spike-mail")) say("delete subscription", (await cf("DELETE", `/accounts/{account}/event_subscriptions/subscriptions/${s.id}`)).success);
  }
  const r = await destroy(project(), { env: ENV, yes: true, token: c.apiToken, accountId: c.accountId, log: (l) => say(l) });
  say("destroy:", r);
  rmSync(join(ROOT, ".ember"), { recursive: true, force: true });
  const w = await cf("GET", `/accounts/{account}/workers/scripts/${WORKER}/settings`);
  say(`GET ${WORKER}/settings → HTTP ${w.status}`);
  if (ROUTING) say(`remove the routing subdomain ${DOMAIN} in the dashboard (Email Routing → Settings → Subdomains): there is no API for it`);
}

async function waitEmail(call: ReturnType<typeof app>, id: string, done: (e: any) => boolean, ms: number) {
  const end = Date.now() + ms;
  let r: any = null;
  while (Date.now() < end) {
    r = (await call("GET", `/emails/${id}`)).body;
    if (r?.email && done(r)) break;
    await sleep(2000);
  }
  return r;
}

async function all() {
  const before = await inventory("before");
  const admin = randomBytes(24).toString("base64url");
  let state: DomainState | null = null;
  try {
    say("--- deploy examples/email-lite");
    const t0 = Date.now();
    const r = await deploy(project(), { env: ENV, registry: false, adminToken: admin, token: c.apiToken, accountId: c.accountId, wait: { timeoutMs: 180_000 }, log: (l) => say(l) });
    const call = app(r.url!, admin);
    say(`deploy took ${Date.now() - t0} ms`);
    for (let i = 0; i < 30 && (await call("GET", "/mailboxes")).status !== 200; i++) await sleep(2000);

    say("--- mailboxes");
    const support = `support@${DOMAIN}`;
    const privacy = `privacy@${DOMAIN}`;
    say((await call("POST", "/mailboxes", { name: "support", address: support, displayName: "Spike Support" })).status, (await call("POST", "/mailboxes", { name: "privacy", address: privacy })).status);

    say(`--- domain onboarding (@freecorps/ember-email/cloudflare; routing subdomain: ${ROUTING ? "created" : "checked only"})`);
    const deps = { mailboxes: [support, privacy], worker: WORKER, queue: QUEUE };
    state = await syncDomain(c, { name: DOMAIN, ...(ROUTING ? { enableRouting: true } : {}) }, { ...deps, prev: null });
    say({ status: state.status, routing: state.routingStatus, records: state.records.map((x) => `${x.purpose} ${x.type} ${x.name}`), notes: state.notes });
    for (let i = 0; i < 36 && !(state.subscriptionId && (!ROUTING || state.ruleIds.length >= 2)); i++) {
      await sleep(5000);
      state = await syncDomain(c, { name: DOMAIN, ...(ROUTING ? { enableRouting: true } : {}) }, { ...deps, prev: state });
    }
    say("after sync:", { status: state.status, routing: state.routingStatus, rules: state.ruleIds.length, subscription: !!state.subscriptionId });
    if (!state.subscriptionId) throw new Error(`the sending domain never got its event subscription (status ${state.status}): ${state.notes.join(" | ")}`);
    if (ROUTING && state.ruleIds.length < 2) throw new Error(`routing rules missing (${state.routingStatus}): ${state.notes.join(" | ")}`);

    say("--- waiting until the new sending domain accepts mail (up to 20 min)");
    const tOnboard = Date.now();
    let ready = false;
    for (let i = 0; i < 40 && !ready; i++) {
      const p = (await call("POST", "/send", { from: `spike@${DOMAIN}`, to: `probe-ready-${i}@${DOMAIN}`, subject: "readiness probe", text: "x" })).body;
      const v = await waitEmail(call, p.id, (e) => !["queued", "sending"].includes(e.email.status) || !!e.email.error, 20_000);
      say(`probe ${i} +${Math.round((Date.now() - tOnboard) / 1000)} s: ${v?.email?.status} ${v?.email?.error?.code ?? ""}`);
      ready = ["sent", "delivered", "delivery_delayed", "bounced"].includes(v?.email?.status);
      if (!ready) await sleep(30_000);
    }
    if (!ready) throw new Error("the sending domain did not accept mail within 20 min");

    say("--- R11: send (only to addresses on the test subdomain)");
    const run = Date.now().toString(36);
    const targets = [
      ...[1, 2, 3].map((i) => ({ kind: "no-mx", to: `bounce-${run}-${i}@${DOMAIN}` })),
      ...[1, 2, 3].map((i) => ({ kind: "cf-bounce-mx", to: `probe-${run}-${i}@cf-bounce.${DOMAIN}` })),
    ];
    const sent: Array<{ kind: string; id: string; t: number }> = [];
    for (const t of targets) {
      const t1 = Date.now();
      const s = await call("POST", "/send", { from: `Ember Spike <spike@${DOMAIN}>`, to: t.to, subject: `R11 ${t.kind} ${run}`, html: "<p>R11 probe</p>", idempotencyKey: `${run}-${t.to}` });
      if (s.status !== 200) throw new Error(JSON.stringify(s.body));
      sent.push({ kind: t.kind, id: s.body.id, t: t1 });
    }
    const replay = await call("POST", "/send", { from: `spike@${DOMAIN}`, to: targets[0]!.to, subject: "x", text: "x", idempotencyKey: `${run}-${targets[0]!.to}` });
    say("idempotent replay returns the same id:", replay.body?.id === sent[0]!.id && replay.body?.duplicate === true);

    say("--- R11: waiting for delivery events (up to 10 min)");
    const deadline = Date.now() + 10 * 60_000;
    const views = new Map<string, any>();
    while (Date.now() < deadline) {
      for (const s of sent) views.set(s.id, (await call("GET", `/emails/${s.id}`)).body);
      if (sent.every((s) => (views.get(s.id)?.events ?? []).some((e: any) => e.terminal))) break;
      await sleep(10_000);
    }
    const rows = sent.map((s) => {
      const v = views.get(s.id);
      const evs = ((v?.events ?? []) as any[]).slice().sort((a, b) => a.receivedAt - b.receivedAt);
      return {
        kind: s.kind,
        status: v?.email?.status,
        inOrder: evs.every((e, i) => i === 0 || e.at >= evs[i - 1].at),
        events: evs.map((e) => ({ type: e.type, terminal: e.terminal, reason: e.reason?.slice(0, 80) ?? null, dup: e.duplicates ?? 0, queueMs: e.receivedAt - e.at, toShardMs: e.receivedAt - s.t })),
      };
    });
    say("R11 results:", rows);
    const evs = rows.flatMap((r) => r.events);
    if (evs.length) {
      const q = evs.map((e) => e.queueMs).sort((a, b) => a - b);
      say("R11 summary:", { events: evs.length, duplicates: evs.reduce((n, e) => n + e.dup, 0), outOfOrderEmails: rows.filter((r) => !r.inOrder).length, queueMs: { min: q[0], p50: q[Math.floor(q.length / 2)], max: q[q.length - 1] } });
    } else say("R11: no events arrived within 10 minutes");

    if (ROUTING && state.ruleIds.length >= 2) {
      say(`--- inbound: ${support} → ${privacy}, then a reply from the privacy thread`);
      const t1 = Date.now();
      await call("POST", "/send", { from: `Spike Support <${support}>`, to: privacy, subject: `Inbound ${run}`, text: `inbound ${run}` });
      let thread: any = null;
      while (!thread && Date.now() - t1 < 120_000) {
        thread = ((await call("GET", "/threads?mailbox=privacy")).body?.page ?? []).find((t: any) => t.subject.includes(run));
        if (!thread) await sleep(1500);
      }
      say("privacy thread:", thread ? { number: thread.number, contact: thread.contact, ms: thread.lastMessageAt - t1 } : "NOT RECEIVED");
      if (thread) {
        const tr = Date.now();
        say("reply:", (await call("POST", `/threads/${thread._id}/reply`, { text: `reply ${run}` })).status);
        let back: any = null;
        while (!back && Date.now() - tr < 180_000) {
          back = ((await call("GET", "/threads?mailbox=support")).body?.page ?? []).find((t: any) => t.subject.includes(run) && t.lastMessageAt >= tr);
          if (!back) await sleep(1500);
        }
        say("support got the reply:", back ? { subject: back.subject, ms: back.lastMessageAt - tr } : "NOT RECEIVED");
      }
    }
  } catch (e) {
    say("FAILED:", (e as Error).stack ?? String(e));
  } finally {
    await cleanup(state);
    const after = await inventory("after");
    say("routing rules unchanged:", before.routingRulesTotal === after.routingRulesTotal, "| routing subdomains unchanged:", JSON.stringify(before.routingSubdomains) === JSON.stringify(after.routingSubdomains));
  }
}

const phase = process.argv[2] ?? "inventory";
if (phase === "inventory") await inventory("now");
else if (phase === "cleanup") await cleanup(null);
else if (phase === "all") await all();
