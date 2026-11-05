// The inbox for the dashboard and the (future) mobile client: reactive queries over the email component's
// mailboxes, threads and search, for signed-in members only (identity from the app's auth provider: Ember auth
// or SSO). Members see only their mailboxes; admins see all. Push devices register here.
import { anyComponents as components, mutationGeneric as mutation, queryGeneric as query, v } from "@freecorps/ember-server";
import { PushNotifications } from "@freecorps/ember-push";

const push = new PushNotifications(components.push);
const email = components.email.lib;

type Ctx = { auth: { getUserIdentity(): { subject: string } | null }; db: any; runQuery: any };

function member(ctx: Ctx) {
  const who = ctx.auth.getUserIdentity();
  if (!who) throw new Error("unauthenticated");
  const m = ctx.db.query("members").withIndex("by_user", (q: any) => q.eq("userId", who.subject)).first();
  if (!m) throw new Error("not a member of any mailbox");
  return m as { userId: string; mailboxes: string[]; admin?: boolean; name?: string };
}

function allowed(ctx: Ctx, mailbox: string) {
  const m = member(ctx);
  if (!m.admin && !m.mailboxes.includes(mailbox)) throw new Error(`no access to mailbox ${mailbox}`);
  return m;
}

function threadOf(ctx: Ctx, threadId: string) {
  const t = ctx.runQuery(email.thread, { threadId });
  if (!t) throw new Error("thread not found");
  const m = allowed(ctx, t.thread.mailbox);
  return { t, m };
}

/** Mailboxes this member can see, with unread counts (aggregate). */
export const mailboxes = query({
  args: {},
  handler: (ctx) => {
    const m = member(ctx);
    const all = (ctx.runQuery(email.mailboxes, {}) as Array<{ name: string; address: string; displayName?: string }>).filter((b) => m.admin || m.mailboxes.includes(b.name));
    const unread = ctx.runQuery(email.unread, { mailboxes: all.map((b) => b.name) }) as Record<string, { unread: number; threads: number }>;
    return all.map((b) => ({ name: b.name, address: b.address, displayName: b.displayName ?? null, ...unread[b.name]! }));
  },
});

export const threads = query({
  args: { mailbox: v.string(), status: v.optional(v.string()), paginationOpts: v.optional(v.object({ numItems: v.number(), cursor: v.union(v.string(), v.null()) })) },
  handler: (ctx, a) => {
    allowed(ctx, a.mailbox);
    return ctx.runQuery(email.threads, a);
  },
});

export const thread = query({ args: { threadId: v.string() }, handler: (ctx, a) => threadOf(ctx, a.threadId).t });

export const search = query({
  args: { query: v.string(), mailbox: v.optional(v.string()) },
  handler: (ctx, a) => {
    const m = member(ctx);
    if (a.mailbox) allowed(ctx, a.mailbox);
    const rows = ctx.runQuery(email.search, { query: a.query, ...(a.mailbox ? { mailbox: a.mailbox } : {}), limit: 50 }) as Array<{ mailbox: string }>;
    return rows.filter((r) => m.admin || m.mailboxes.includes(r.mailbox));
  },
});

export const reply = mutation({
  args: { threadId: v.string(), text: v.string() },
  handler: (ctx, a) => {
    const { m } = threadOf(ctx, a.threadId);
    return ctx.runMutation(email.reply, { threadId: a.threadId, text: a.text, author: m.name ?? m.userId });
  },
});

export const note = mutation({
  args: { threadId: v.string(), text: v.string() },
  handler: (ctx, a) => {
    const { m } = threadOf(ctx, a.threadId);
    return ctx.runMutation(email.note, { threadId: a.threadId, text: a.text, author: m.name ?? m.userId });
  },
});

export const markRead = mutation({
  args: { threadId: v.string() },
  handler: (ctx, a) => {
    threadOf(ctx, a.threadId);
    return ctx.runMutation(email.markRead, a);
  },
});

export const setStatus = mutation({
  args: { threadId: v.string(), status: v.union(v.literal("open"), v.literal("waiting"), v.literal("closed"), v.literal("spam")) },
  handler: (ctx, a) => {
    threadOf(ctx, a.threadId);
    return ctx.runMutation(email.setStatus, a);
  },
});

/** The mobile app registers its Expo push token after sign-in. */
export const registerDevice = mutation({
  args: { token: v.string(), platform: v.optional(v.string()), deviceName: v.optional(v.string()) },
  handler: (ctx, a) => {
    const m = member(ctx);
    return push.register(ctx, { userId: m.userId, token: a.token, ...(a.platform ? { platform: a.platform } : {}), ...(a.deviceName ? { deviceName: a.deviceName } : {}) });
  },
});

export const unregisterDevice = mutation({ args: { token: v.string() }, handler: (ctx, a) => (member(ctx), push.unregister(ctx, a.token)) });
