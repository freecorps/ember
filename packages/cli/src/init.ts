// `ember init`: ember.json + a sample messages app in ember/.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { CONFIG_FILE, DEFAULT_COMPATIBILITY_DATE, type EmberConfigFile } from "./config.ts";

export const SAMPLE_SCHEMA = `import { defineSchema, defineTable, v } from "@ember/server";

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

export const SAMPLE_MESSAGES = `import { v } from "@ember/server";
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
import { cronJobs } from "@ember/server";

const crons = cronJobs({ shard: "global:main" });

crons.hourly("trim-general", { minute: 0 }, "messages:trim", { channel: "general", keep: 1000 });

export default crons;
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
    "lib": ["ES2023", "DOM"]
  },
  "include": ["**/*.ts"]
}
`;

export interface InitOptions {
  dir?: string;
  project?: string;
  force?: boolean;
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
    "ember/schema.ts": SAMPLE_SCHEMA,
    "ember/messages.ts": SAMPLE_MESSAGES,
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
  // Account registry (PLAN §21, D1 `ember-registry`) is created on first deploy, not here: init stays offline.
  return { root, created };
}
