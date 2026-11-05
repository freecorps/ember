// Domain management: the Worker talks to the Cloudflare API with its own token (secrets CLOUDFLARE_API_TOKEN and
// CLOUDFLARE_ACCOUNT_ID). See src/cloudflare.ts for what is automated and what needs the zone owner.
import { anyComponents as components, internalActionGeneric as internalAction, internalMutationGeneric as internalMutation, internalQueryGeneric as internalQuery, v } from "@freecorps/ember-server";
import { CfError, deleteEventSubscription, deleteRule, deleteSending, enableRoutingSubdomain, ensureEventSubscription, ensureSending, ensureWorkerRule, findZone, routingState, type CfCreds, type DnsRecord } from "../src/cloudflare.ts";

const recordV = v.object({ type: v.string(), name: v.string(), value: v.string(), priority: v.optional(v.number()), ttl: v.optional(v.number()), purpose: v.string() });

function creds(env: Record<string, unknown>): CfCreds {
  const apiToken = env.CLOUDFLARE_API_TOKEN;
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  if (typeof apiToken !== "string" || typeof accountId !== "string") throw new Error("set the CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID secrets on the mail Worker to manage domains");
  const f = env.__CF_FETCH as typeof fetch | undefined; // tests
  return { apiToken, accountId, ...(f ? { fetch: f } : {}) };
}
const workerName = (env: Record<string, unknown>) => `ember-${String(env.EMBER_PROJECT)}-${String(env.EMBER_ENV)}`;
const eventsQueue = (env: Record<string, unknown>) => `ember-${String(env.EMBER_PROJECT)}-${String(env.EMBER_ENV)}-email-events`;
const NAME = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export const get = internalQuery({ args: { name: v.string() }, handler: (ctx, { name }) => ctx.db.query("domains").withIndex("by_name", (q) => q.eq("name", name)).first() });
export const getById = internalQuery({ args: { id: v.string() }, handler: (ctx, { id }) => { const n = ctx.db.normalizeId("domains", id); return n ? ctx.db.get(n) : null; } });
export const list = internalQuery({ args: {}, handler: (ctx) => ctx.db.query("domains").collect() });

export const save = internalMutation({
  args: {
    name: v.string(),
    zoneId: v.optional(v.string()),
    zoneName: v.optional(v.string()),
    sendingTag: v.optional(v.string()),
    status: v.string(),
    sending: v.boolean(),
    receiving: v.boolean(),
    routingStatus: v.optional(v.string()),
    records: v.array(recordV),
    ruleIds: v.array(v.string()),
    subscriptionId: v.optional(v.string()),
    createdSending: v.optional(v.boolean()),
    notes: v.array(v.string()),
  },
  handler: (ctx, a) => {
    const prev = ctx.db.query("domains").withIndex("by_name", (q) => q.eq("name", a.name)).first();
    const doc = { ...a, createdAt: prev?.createdAt ?? ctx.now, checkedAt: ctx.now };
    if (prev) {
      ctx.db.replace(prev._id, doc);
      return prev._id;
    }
    return ctx.db.insert("domains", doc);
  },
});
export const remove = internalMutation({ args: { name: v.string() }, handler: (ctx, { name }) => { const d = ctx.db.query("domains").withIndex("by_name", (q) => q.eq("name", name)).first(); if (d) ctx.db.delete(d._id); return !!d; } });

/**
 * Adds or re-checks a domain: onboards sending, reads the records it needs, checks receiving, and — when routing
 * is ready — points each mailbox address of the domain at this Worker and subscribes delivery events.
 */
export const sync = internalAction({
  args: { name: v.string(), enableRouting: v.optional(v.boolean()), sending: v.optional(v.boolean()), receiving: v.optional(v.boolean()) },
  handler: async (ctx, a) => {
    const name = a.name.toLowerCase();
    if (!NAME.test(name)) throw new Error(`invalid domain ${a.name}`);
    const c = creds(ctx.env);
    const prev = (await ctx.runQuery("domains:get" as any, { name })) as any;
    const wantSend = a.sending ?? prev?.sending ?? true;
    const wantRecv = a.receiving ?? prev?.receiving ?? true;
    const zone = await findZone(c, name);
    const notes: string[] = [];
    if (!zone) {
      notes.push(`${name} is not in a zone of this Cloudflare account: add the zone first (Email Service needs Cloudflare DNS).`);
      await ctx.runMutation("domains:save" as any, { name, status: "failed", sending: wantSend, receiving: wantRecv, records: [], ruleIds: prev?.ruleIds ?? [], notes });
      return { name, status: "failed", notes };
    }
    let records: DnsRecord[] = [];
    let sendingTag: string | undefined = prev?.sendingTag;
    let createdSending = prev?.createdSending ?? false;
    let sendingOk = !wantSend;
    if (wantSend) {
      const s = await ensureSending(c, zone.id, name);
      sendingTag = s.sending.tag;
      createdSending ||= s.created;
      records.push(...s.records);
      sendingOk = s.sending.enabled;
      if (!sendingOk) notes.push("Email Sending is onboarding this domain (DNS records are added by Cloudflare; re-run verify).");
    }
    let routingStatus: string | undefined;
    const ruleIds: string[] = [...(prev?.ruleIds ?? [])];
    let subscriptionId: string | undefined = prev?.subscriptionId;
    let recvOk = !wantRecv;
    if (wantRecv) {
      let r = await routingState(c, zone, name);
      if (!r.enabled && a.enableRouting && name !== zone.name && r.status === "subdomain_missing") {
        await enableRoutingSubdomain(c, zone.id, name);
        notes.push(`Email Routing subdomain ${name} created (remove it in the dashboard if no longer needed: there is no API for that).`);
        r = await routingState(c, zone, name);
      }
      routingStatus = r.status;
      records.push(...r.records);
      if (r.note) notes.push(r.note);
      recvOk = r.enabled;
      if (r.enabled) {
        const boxes = (await ctx.runQuery(components.email.lib.mailboxes, {})) as Array<{ address: string }>;
        for (const b of boxes.filter((b) => b.address.endsWith(`@${name}`))) {
          try {
            const rule = await ensureWorkerRule(c, zone.id, b.address, workerName(ctx.env));
            if (rule.created) ruleIds.push(rule.id);
          } catch (e) {
            notes.push((e as Error).message);
          }
        }
      }
    }
    if (wantSend && sendingOk) {
      try {
        const s = await ensureEventSubscription(c, zone.id, name, eventsQueue(ctx.env));
        subscriptionId = s.id;
      } catch (e) {
        notes.push(`delivery events: ${(e as Error).message}`);
      }
    }
    const status = sendingOk && recvOk ? "verified" : "pending";
    await ctx.runMutation("domains:save" as any, {
      name,
      zoneId: zone.id,
      zoneName: zone.name,
      ...(sendingTag ? { sendingTag } : {}),
      status,
      sending: wantSend,
      receiving: wantRecv,
      ...(routingStatus ? { routingStatus } : {}),
      records,
      ruleIds,
      ...(subscriptionId ? { subscriptionId } : {}),
      createdSending,
      notes,
    });
    return { name, status, notes };
  },
});

/** Removes what this app created for the domain (rules, event subscription, the sending onboarding it created). */
export const destroy = internalAction({
  args: { name: v.string() },
  handler: async (ctx, a) => {
    const d = (await ctx.runQuery("domains:get" as any, { name: a.name.toLowerCase() })) as any;
    if (!d) return { deleted: false };
    const c = creds(ctx.env);
    const errors: string[] = [];
    const attempt = async (what: string, f: () => Promise<void>) => {
      try {
        await f();
      } catch (e) {
        if (!(e instanceof CfError && e.status === 404)) errors.push(`${what}: ${(e as Error).message}`);
      }
    };
    for (const id of d.ruleIds) await attempt(`rule ${id}`, () => deleteRule(c, d.zoneId, id));
    if (d.subscriptionId) await attempt("event subscription", () => deleteEventSubscription(c, d.subscriptionId));
    if (d.createdSending && d.sendingTag) await attempt("sending domain", () => deleteSending(c, d.zoneId, d.sendingTag));
    if (!errors.length) await ctx.runMutation("domains:remove" as any, { name: d.name });
    return { deleted: !errors.length, errors };
  },
});
