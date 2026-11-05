// Domain management: the Worker talks to the Cloudflare API with its own token (secrets CLOUDFLARE_API_TOKEN and
// CLOUDFLARE_ACCOUNT_ID). See src/cloudflare.ts for what is automated and what needs the zone owner.
import { anyComponents as components, internalActionGeneric as internalAction, internalMutationGeneric as internalMutation, internalQueryGeneric as internalQuery, v } from "@freecorps/ember-server";
import type { CfCreds } from "../src/cloudflare.ts";
import { destroyDomain, syncDomain, type DomainState } from "../src/onboard.ts";

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
    const prev = (await ctx.runQuery("domains:get" as any, { name })) as DomainState | null;
    const mailboxes = ((await ctx.runQuery(components.email.lib.mailboxes, {})) as Array<{ address: string }>).map((b) => b.address);
    const state = await syncDomain(creds(ctx.env), { name, ...(a.enableRouting ? { enableRouting: true } : {}), ...(a.sending !== undefined ? { sending: a.sending } : {}), ...(a.receiving !== undefined ? { receiving: a.receiving } : {}) }, { prev, mailboxes, worker: workerName(ctx.env), queue: eventsQueue(ctx.env) });
    await ctx.runMutation("domains:save" as any, state);
    return { name, status: state.status, notes: state.notes };
  },
});

/** Removes what this app created for the domain (rules, event subscription, the sending onboarding it created). */
export const destroy = internalAction({
  args: { name: v.string() },
  handler: async (ctx, a) => {
    const d = (await ctx.runQuery("domains:get" as any, { name: a.name.toLowerCase() })) as DomainState | null;
    if (!d) return { deleted: false, errors: [] };
    const errors = await destroyDomain(creds(ctx.env), d);
    if (!errors.length) await ctx.runMutation("domains:remove" as any, { name: d.name });
    return { deleted: !errors.length, errors };
  },
});
