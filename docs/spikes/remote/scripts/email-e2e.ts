// Real end-to-end run of the email service (PLAN §16, R11) in the FreeCorps Cloudflare account:
//   deploy apps/mail as ember-spike-mail-test → onboard ember-spike-mail.<zone> for sending (Email Service) from
//   this machine (CLI token lookup, in memory) → event subscription → the component's events queue → send through
//   the HTTP API (SDK) to addresses on the test subdomain only → measure the event queue (latency, duplicates,
//   order) → check receiving (Email Routing) without changing the zone → delete everything and verify.
//
//   bun --conditions=@freecorps/ember-source run docs/spikes/remote/scripts/email-e2e.ts all|inventory|cleanup
//
// Only `ember-spike-*` resources. Never touches existing DNS records, routing rules, catch-alls or apex settings.
// Output is redacted (account id, zone, workers.dev subdomain, addresses, local paths).

import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { projectFrom } from "../../../../packages/cli/src/config.ts";
import { deploy } from "../../../../packages/cli/src/deploy/index.ts";
import { destroy } from "../../../../packages/cli/src/destroy.ts";
import { EmberMail } from "../../../../packages/mail-sdk/src/index.ts";
import { addDomain, cfCreds, removeDomain } from "../../../../apps/mail/scripts/domains.ts";

const ZONE = process.env.SPIKE_ZONE ?? "freecorps.com.br";
const DOMAIN = `ember-spike-mail.${ZONE}`;
const PROJECT = "spike-mail";
const ENV = "test";
const WORKER = `ember-${PROJECT}-${ENV}`;
const ROOT = join(import.meta.dir, "../../../../apps/mail");
const c = await cfCreds();
const H = { authorization: `Bearer ${c.apiToken}` };
const sub = ((await (await fetch(`https://api.cloudflare.com/client/v4/accounts/${c.accountId}/workers/subdomain`, { headers: H })).json()) as any).result?.subdomain ?? "";
const redact = (s: string) => {
  let out = s.split(c.accountId).join("<ACCOUNT_ID>").split(ROOT).join("<apps/mail>").split(ZONE).join("<zone>");
  if (sub) out = out.split(sub).join("<subdomain>");
  return out.replace(/\/Users\/[^\s"']+/g, "<path>").replace(/\b[0-9a-f]{32}\b/g, "<id>");
};
const say = (...xs: unknown[]) => console.log(redact(xs.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(get: () => Promise<T>, ok: (v: T) => boolean, ms: number): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await get();
    if (ok(v) || Date.now() > end) return v;
    await sleep(1000);
  }
}
const cf = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`https://api.cloudflare.com/client/v4${path.replace("{account}", c.accountId)}`, { method, headers: { ...H, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, ...((await r.json().catch(() => ({}))) as any) };
};
const project = () =>
  projectFrom(ROOT, { project: PROJECT, account: c.accountId, compatibilityDate: "2026-10-01", metrics: { enabled: false }, environments: { [ENV]: {} } } as any);

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
  const rules = ((await cf("GET", `/zones/${z}/email/routing/rules?per_page=200`)).result ?? []).filter((r: any) => JSON.stringify(r.matchers).includes("ember-spike")).length;
  const inv = { workers, queues, buckets, sendingDomains: sending, subscriptions: subs, spikeRoutingRules: rules, routingSubdomains: (routing.result?.subdomains ?? []).map((s: any) => s.name), routingRulesTotal: ((await cf("GET", `/zones/${z}/email/routing/rules?per_page=200`)).result ?? []).length };
  say(`inventory ${label}:`, inv);
  return inv;
}

async function cleanup(url: string | null, admin: string | null) {
  say("--- cleanup");
  if (url && admin) {
    try {
      const errors = await removeDomain(c, url, admin, DOMAIN);
      say("domain resources removed", errors.length ? errors : "ok");
    } catch (e) {
      say("removeDomain via the service failed:", (e as Error).message);
    }
  }
  // Fallback by name (a crashed run): the sending onboarding and subscriptions of the spike domain only.
  const z = await zoneId();
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
}

async function all() {
  const before = await inventory("before");
  const admin = randomBytes(24).toString("base64url");
  let url: string | null = null;
  try {
    say("--- deploy");
    const t0 = Date.now();
    const r = await deploy(project(), { env: ENV, registry: false, adminToken: admin, token: c.apiToken, accountId: c.accountId, wait: { timeoutMs: 180_000 }, log: (l) => say(l) });
    url = r.url;
    say(`deploy took ${Date.now() - t0} ms`);
    const root = new EmberMail(admin, { baseUrl: url! });
    for (let i = 0; i < 30; i++) {
      if ((await root.domains.list()).error === null) break;
      await sleep(2000);
    }
    say("--- mailboxes (inbound addresses on the test subdomain)");
    say(await root.inbox.upsertMailbox({ name: "support", address: `support@${DOMAIN}`, display_name: "Spike Support", auto_reply: { subject: "Re: {{subject}} [#{{number}}]", text: "Ticket #{{number}} received." } }));
    say(await root.inbox.upsertMailbox({ name: "privacy", address: `privacy@${DOMAIN}` }));

    say("--- domain onboarding (sending: Email Service; receiving: checked, not enabled)");
    let d = await addDomain(c, url!, admin, DOMAIN, { project: PROJECT, env: ENV });
    say({ status: d.status, routing: d.routing_status, records: d.records.map((x: any) => `${x.record} ${x.type} ${x.name}`), notes: d.notes });
    for (let i = 0; i < 36 && !(d.cloudflare.subscription_id); i++) {
      await sleep(5000);
      d = await addDomain(c, url!, admin, DOMAIN, { project: PROJECT, env: ENV });
    }
    say("after verify:", { status: d.status, capabilities: d.capabilities, subscription: !!d.cloudflare.subscription_id, notes: d.notes });
    if (!d.cloudflare.subscription_id) throw new Error("sending domain never became ready (no event subscription)");

    const key = await root.apiKeys.create({ name: "spike", permission: "sending_access", project: "spike" });
    const mail = new EmberMail(key.data!.token, { baseUrl: url! });

    say("--- waiting until the new sending domain accepts mail (probe to the test subdomain, up to 20 min)");
    const z = await zoneId();
    const tOnboard = Date.now();
    let ready = false;
    for (let i = 0; i < 40 && !ready; i++) {
      const s = ((await cf("GET", `/zones/${z}/email/sending/subdomains`)).result ?? []).find((x: any) => x.name === DOMAIN);
      const p = await mail.emails.send({ from: `spike@${DOMAIN}`, to: `probe-ready-${i}@${DOMAIN}`, subject: "readiness probe", text: "x" });
      const v = await until(() => mail.emails.get(p.data!.id), (x) => !!x.data && !["queued", "sending"].includes(x.data.last_event), 20_000);
      say(`probe ${i} +${Math.round((Date.now() - tOnboard) / 1000)} s: ${v.data?.last_event} ${v.data?.error?.code ?? ""} | sending domain: ${JSON.stringify({ enabled: s?.enabled, ...Object.fromEntries(Object.entries(s ?? {}).filter(([k]) => /status|verif|state/i.test(k))) })}`);
      if (v.data?.last_event === "sent" || v.data?.last_event === "delivered") ready = true;
      else if (v.data?.last_event === "queued") ready = false;
      if (!ready) {
        await mail.emails.cancel(p.data!.id); // a probe left queued must not send later
        await sleep(30_000);
      }
    }
    if (!ready) throw new Error("the sending domain did not accept mail within 20 min");
    say(`sending domain ready ~${Math.round((Date.now() - tOnboard) / 1000)} s after onboarding`);
    say("--- send (only to addresses on the test subdomain)");
    const run = Date.now().toString(36);
    const targets = [
      ...[1, 2, 3].map((i) => ({ kind: "no-mx", to: `bounce-${run}-${i}@${DOMAIN}` })),
      ...[1, 2, 3].map((i) => ({ kind: "cf-bounce-mx", to: `probe-${run}-${i}@cf-bounce.${DOMAIN}` })),
    ];
    const sent: Array<{ kind: string; id: string; t: number }> = [];
    for (const t of targets) {
      const t1 = Date.now();
      const s = await mail.emails.send({ from: `Ember Spike <spike@${DOMAIN}>`, to: t.to, subject: `R11 ${t.kind} ${run}`, html: "<p>R11 probe</p>", tags: [{ name: "kind", value: t.kind }] }, { idempotencyKey: `${run}-${t.to}` });
      if (s.error) throw new Error(JSON.stringify(s.error));
      sent.push({ kind: t.kind, id: s.data.id, t: t1 });
    }
    const replay = await mail.emails.send({ from: `spike@${DOMAIN}`, to: targets[0]!.to, subject: "x", text: "x" }, { idempotencyKey: `${run}-${targets[0]!.to}` });
    say("idempotent replay returns the same id:", replay.data?.id === sent[0]!.id);

    say("--- R11: waiting for delivery events (up to 10 min)");
    const deadline = Date.now() + 10 * 60_000;
    const views = new Map<string, any>();
    const events = new Map<string, any[]>();
    while (Date.now() < deadline) {
      for (const s of sent) {
        views.set(s.id, (await mail.emails.get(s.id)).data);
        events.set(s.id, (await mail.emails.events(s.id)).data?.data ?? []);
      }
      if (sent.every((s) => (events.get(s.id) ?? []).some((e) => e.terminal))) break;
      await sleep(10_000);
    }
    const rows: any[] = [];
    for (const s of sent) {
      const v = views.get(s.id);
      const evs = (events.get(s.id) ?? []).slice().sort((a, b) => Date.parse(a.received_at) - Date.parse(b.received_at));
      const inOrder = evs.every((e, i) => i === 0 || Date.parse(e.at) >= Date.parse(evs[i - 1].at));
      rows.push({
        kind: s.kind,
        status: v?.last_event,
        error: v?.error?.code ?? null,
        events: evs.map((e) => ({ type: e.type, terminal: e.terminal, reason: e.reason?.slice(0, 80) ?? null, smtp: e.smtp_status, dup: e.duplicates, platformMs: Date.parse(e.at) - s.t, queueMs: Date.parse(e.received_at) - Date.parse(e.at), toShardMs: Date.parse(e.received_at) - s.t })),
        inOrder,
      });
    }
    say("R11 results:", rows);
    const all = rows.flatMap((r) => r.events);
    if (all.length) {
      const q = all.map((e) => e.queueMs).sort((a, b) => a - b);
      const tot = all.map((e) => e.toShardMs).sort((a, b) => a - b);
      say("R11 summary:", { events: all.length, duplicates: all.reduce((n, e) => n + e.dup, 0), outOfOrderEmails: rows.filter((r) => !r.inOrder).length, queueMs: { min: q[0], p50: q[Math.floor(q.length / 2)], max: q[q.length - 1] }, sendToShardMs: { min: tot[0], p50: tot[Math.floor(tot.length / 2)], max: tot[tot.length - 1] } });
    } else say("R11: no events arrived within 10 minutes");
  } catch (e) {
    say("FAILED:", (e as Error).stack ?? String(e));
  } finally {
    await cleanup(url, admin);
    const after = await inventory("after");
    say("routing rules unchanged:", before.routingRulesTotal === after.routingRulesTotal, "| routing subdomains unchanged:", JSON.stringify(before.routingSubdomains) === JSON.stringify(after.routingSubdomains));
  }
}

const phase = process.argv[2] ?? "inventory";
if (phase === "inventory") await inventory("now");
else if (phase === "cleanup") await cleanup(null, null);
else if (phase === "all") await all();
