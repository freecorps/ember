/**
 * The workerd test app: the flags component, an org shard kind, an admin mutation (global:main) and queries that
 * evaluate flags in whatever shard they run on (the shard's `.replicated()` copy).
 */
import { anyComponents, defineApp, defineSchema, defineShard, defineTable, mutationGeneric, queryGeneric, v } from "@freecorps/ember-server";
import { createEmberWorker } from "@freecorps/ember-runtime";
import { FeatureFlags, flags, vFlagContext, type FlagsComponentApi } from "../../src/index.ts";

export { Shard } from "@freecorps/ember-runtime";

const ff = new FeatureFlags(anyComponents.flags as unknown as FlagsComponentApi, { newCheckout: { type: "boolean", default: false } });

export const schema = defineSchema({
  shards: { org: defineShard({ key: v.string() }) },
  tables: { visits: defineTable({ flow: v.string() }) },
});

export const functions = {
  admin: {
    set: mutationGeneric({ args: { flag: v.any() }, handler: (ctx: any, a: any) => ff.set(ctx, a.flag) }),
    toggle: mutationGeneric({ args: { key: v.string(), on: v.boolean() }, handler: (ctx: any, a: any) => ff.toggle(ctx, a.key, a.on) }),
  },
  shop: {
    /** Evaluated in the shard it runs on: a local read of that shard's copy. */
    detail: queryGeneric({ args: { context: vFlagContext }, handler: (ctx: any, a: any) => ff.detail(ctx, "newCheckout", a.context) }),
    visit: mutationGeneric({
      args: { unitId: v.string() },
      handler: (ctx: any, a: any) => ctx.db.insert("visits", { flow: ff.evaluate(ctx, "newCheckout", { unitId: a.unitId }) ? "new" : "old" }),
    }),
    flows: queryGeneric({ args: {}, handler: (ctx: any) => ctx.db.query("visits").collect().map((r: any) => r.flow) }),
  },
};

export const app = defineApp().use(flags);

export default createEmberWorker({ schema, functions, app });
