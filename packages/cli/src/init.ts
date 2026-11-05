// `ember init`: ember.json + a sample messages app in ember/.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { CONFIG_FILE, DEFAULT_COMPATIBILITY_DATE, type EmberConfigFile } from "./config.ts";
import { ensureGitignore } from "./env.ts";

export const SAMPLE_SCHEMA = `import { defineSchema, defineTable, v } from "@freecorps/ember-server";

export default defineSchema({
  tables: {
    messages: defineTable({
      channel: v.string(),
      author: v.string(),
      body: v.string(),
      edited: v.optional(v.boolean()),
    }).index("by_channel", ["channel"]),
  },
});
`;

export const SAMPLE_MESSAGES = `import { v } from "@freecorps/ember-server";
import { api } from "./_generated/api";
import { action, internalMutation, mutation, query } from "./_generated/server";

export const list = query({
  args: { channel: v.string(), limit: v.optional(v.number()) },
  handler: (ctx, { channel, limit }) =>
    ctx.db
      .query("messages")
      .withIndex("by_channel", (q) => q.eq("channel", channel))
      .order("desc")
      .take(limit ?? 50),
});

export const count = query({
  args: { channel: v.string() },
  returns: v.number(),
  handler: (ctx, { channel }) =>
    ctx.db.query("messages").withIndex("by_channel", (q) => q.eq("channel", channel)).collect().length,
});

export const send = mutation({
  args: { channel: v.string(), author: v.string(), body: v.string() },
  handler: (ctx, args) => {
    const id = ctx.db.insert("messages", args);
    return { id, at: ctx.now };
  },
});

export const edit = mutation({
  args: { id: v.id("messages"), body: v.string() },
  handler: (ctx, { id, body }) => {
    const msg = ctx.db.get(id);
    if (!msg) return null;
    ctx.db.patch(id, { body, edited: true });
    return msg.channel;
  },
});

/**
 * Actions run in the Worker and may do I/O (fetch, AI, email); they reach the shard through ctx.runQuery,
 * ctx.runMutation and ctx.scheduler (each call is its own transaction).
 */
export const digest = action({
  args: { channel: v.string() },
  handler: async (ctx, { channel }) => {
    const count = await ctx.runQuery(api.messages.count, { channel });
    return \`#\${channel}: \${count} messages\`;
  },
});

/** Internal: run by the cron in crons.ts. */
export const trim = internalMutation({
  args: { channel: v.string(), keep: v.number() },
  handler: (ctx, { channel, keep }) => {
    const old = ctx.db
      .query("messages")
      .withIndex("by_channel", (q) => q.eq("channel", channel))
      .order("desc")
      .collect()
      .slice(keep);
    for (const m of old) ctx.db.delete(m._id);
    return old.length;
  },
});
`;

export const SAMPLE_CRONS = `// Evaluated once a minute by the System Durable Object (one "* * * * *" Cron Trigger per Worker), in each
// cron's time zone (default UTC). Every cron names the shard ("<kind>:<key>") it runs on.
import { cronJobs } from "@freecorps/ember-server";

const crons = cronJobs({ shard: "global:main" });

crons.hourly("trim-general", { minute: 0 }, "messages:trim", { channel: "general", keep: 1000 });

export default crons;
`;

/** `ember init --auth`: schema with a `profiles` table filled by `internal.users.sync`. */
export const SAMPLE_SCHEMA_AUTH = `import { defineSchema, defineTable, v } from "@freecorps/ember-server";

export default defineSchema({
  tables: {
    messages: defineTable({
      channel: v.string(),
      author: v.string(),
      body: v.string(),
      edited: v.optional(v.boolean()),
    }).index("by_channel", ["channel"]),
    // App-side copy of auth users (the Auth DO owns the real ones), kept in sync by users.sync.
    profiles: defineTable({
      userId: v.string(),
      email: v.string(),
      name: v.string(),
      credits: v.number(),
    }).index("by_user", ["userId"]),
  },
});
`;

export const SAMPLE_AUTH_CONFIG = `// Better Auth options for this project's Auth Durable Object (PLAN §9). Ember injects the database (the DO's
// SQLite), the secret, the jwt() + bearer() plugins and the cookie prefix; do not set them here.
import { defineAuth } from "@freecorps/ember-auth";
import { organization } from "@freecorps/ember-auth/plugins";

export default defineAuth({
  emailAndPassword: { enabled: true },
  plugins: [organization()],
});
`;

export const SAMPLE_USERS = `import { v } from "@freecorps/ember-server";
import { internalMutation, mutation, query, type MutationCtx } from "./_generated/server";

function requireUser(ctx: MutationCtx) {
  const identity = ctx.auth.getUserIdentity();
  if (!identity) throw new Error("sign in first");
  return identity;
}

/** The caller as the runtime verified it (JWT claims), plus the synced profile. */
export const me = query({
  handler: (ctx) => {
    const identity = ctx.auth.getUserIdentity();
    if (!identity) return null;
    const profile = ctx.db
      .query("profiles")
      .withIndex("by_user", (q) => q.eq("userId", identity.subject))
      .unique();
    return { subject: identity.subject, email: identity.claims?.email ?? null, profile };
  },
});

export const addCredits = mutation({
  args: { amount: v.number() },
  handler: (ctx, { amount }) => {
    const { subject } = requireUser(ctx);
    const p = ctx.db.query("profiles").withIndex("by_user", (q) => q.eq("userId", subject)).unique();
    if (!p) throw new Error("profile not synced yet");
    ctx.db.patch(p._id, { credits: p.credits + amount });
    return p.credits + amount;
  },
});

/**
 * \`sensitive: true\`: the session is re-checked in the Auth DO on every call, so it fails right after sign-out
 * even while the 5-minute JWT is still valid.
 */
export const spendCredits = mutation({
  sensitive: true,
  args: { amount: v.number() },
  handler: (ctx, { amount }) => {
    const { subject } = requireUser(ctx);
    const p = ctx.db.query("profiles").withIndex("by_user", (q) => q.eq("userId", subject)).unique();
    if (!p || p.credits < amount) throw new Error("not enough credits");
    ctx.db.patch(p._id, { credits: p.credits - amount });
    return p.credits - amount;
  },
});

/** Profile sync: the Auth DO's outbox calls this on every user create/update/delete (retried, deduplicated). */
export const sync = internalMutation({
  args: { event: v.string(), user: v.any(), key: v.string() },
  handler: (ctx, { event, user }) => {
    const existing = ctx.db.query("profiles").withIndex("by_user", (q) => q.eq("userId", user.id)).unique();
    if (event === "delete") {
      if (existing) ctx.db.delete(existing._id);
      return;
    }
    const fields = { email: String(user.email ?? ""), name: String(user.name ?? "") };
    if (existing) ctx.db.patch(existing._id, fields);
    else ctx.db.insert("profiles", { userId: user.id, credits: 0, ...fields });
  },
});
`;

export const SAMPLE_TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "noUncheckedIndexedAccess": true,
    "lib": ["ES2023", "DOM", "DOM.Iterable"]
  },
  "include": ["**/*.ts"]
}
`;

export interface InitOptions {
  dir?: string;
  project?: string;
  force?: boolean;
  /** Add ember/auth.config.ts (email + password, organization) and a users module with profile sync. */
  auth?: boolean;
}

export function init(opts: InitOptions = {}): { root: string; created: string[] } {
  const root = resolve(opts.dir ?? process.cwd());
  const project = (opts.project ?? basename(root)).toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^[^a-z]+/, "") || "app";
  if (existsSync(join(root, CONFIG_FILE)) && !opts.force) throw new Error(`${CONFIG_FILE} already exists in ${root} (use --force)`);
  const config: EmberConfigFile = {
    project,
    compatibilityDate: DEFAULT_COMPATIBILITY_DATE,
    environments: { prod: {}, dev: {} },
  };
  const files: Record<string, string> = {
    [CONFIG_FILE]: JSON.stringify(config, null, 2) + "\n",
    "ember/schema.ts": opts.auth ? SAMPLE_SCHEMA_AUTH : SAMPLE_SCHEMA,
    "ember/messages.ts": SAMPLE_MESSAGES,
    ...(opts.auth ? { "ember/auth.config.ts": SAMPLE_AUTH_CONFIG, "ember/users.ts": SAMPLE_USERS } : {}),
    "ember/crons.ts": SAMPLE_CRONS,
    "ember/tsconfig.json": SAMPLE_TSCONFIG,
  };
  const created: string[] = [];
  for (const [rel, text] of Object.entries(files)) {
    const p = join(root, rel);
    if (existsSync(p) && !opts.force && rel !== CONFIG_FILE) continue;
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, text);
    created.push(rel);
  }
  // .ember/ (local state) and .dev.vars* (local secrets for `ember dev`) never go to git.
  if (ensureGitignore(root)) created.push(".gitignore");
  // Account registry (PLAN §21, D1 `ember-registry`) is created on first deploy, not here: init stays offline.
  return { root, created };
}
