import { createNodeSqliteDriver } from "../src/testing.ts";
import {
  createEngine,
  defineSchema,
  defineTable,
  mutationGeneric,
  queryGeneric,
  v,
  type CreateEngineOptions,
  type MutationCtx,
  type QueryCtx,
  type SchemaDefinition,
} from "../src/index.ts";

export const schema = defineSchema({
  tables: {
    users: defineTable({ name: v.string(), email: v.string(), admin: v.boolean() }).index("by_email", ["email"]),
    messages: defineTable(
      {
        channel: v.string(),
        author: v.id("users"),
        body: v.string(),
        likes: v.number(),
        meta: v.optional(v.object({ edited: v.boolean(), tags: v.array(v.string()) })),
      },
      { idPrefix: "msg" },
    )
      .index("by_channel", ["channel"])
      .index("by_channel_likes", ["channel", "likes"])
      .index("by_edited", ["meta.edited"])
      .searchIndex("search_body", { searchField: "body", filterFields: ["channel"] }),
  },
});

/** A fresh in-memory shard plus helpers: each `tx` is one committed mutation, each `run` one query. */
export function fresh(opts: Partial<CreateEngineOptions> & { schema?: SchemaDefinition<any, any> } = {}) {
  const driver = createNodeSqliteDriver();
  let clock = 1_700_000_000_000;
  const engine = createEngine({ schema, driver, now: () => (clock += 1), ...opts });
  engine.migrate();
  const tx = <R>(fn: (db: MutationCtx["db"], ctx: MutationCtx) => R, args: Record<string, unknown> = {}) =>
    engine.runMutation(mutationGeneric({ handler: (ctx: MutationCtx) => fn(ctx.db, ctx) as any }) as any, args) as {
      value: R;
      changes: any[];
      scheduled: any[];
    };
  const run = <R>(fn: (db: QueryCtx["db"]) => R) =>
    engine.runQuery(queryGeneric({ handler: (ctx: QueryCtx) => fn(ctx.db) as any }) as any, {}) as { value: R; readSet: any[] };
  const insert = (table: string, doc: Record<string, unknown>) => tx((db) => db.insert(table, doc as any)).value as string;
  const patch = (id: string, doc: Record<string, unknown>) => tx((db) => db.patch(id as any, doc as any));
  const del = (id: string) => tx((db) => db.delete(id as any));
  const sql = (s: string, ...params: any[]) => driver.exec(s, ...params).rows;
  return { driver, engine, tx, run, insert, patch, del, sql };
}

export function withUser(env: ReturnType<typeof fresh>) {
  return env.insert("users", { name: "Ada", email: "ada@x.dev", admin: false });
}

export function prng(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}
