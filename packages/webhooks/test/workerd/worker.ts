/**
 * The workerd test app: the webhooks component (short retry schedule) and app functions that add endpoints, emit an
 * event from a mutation (with an app write in the same transaction) and read deliveries.
 */
import { anyComponents, defineApp, defineSchema, defineTable, mutationGeneric, queryGeneric, v } from "@freecorps/ember-server";
import { createEmberWorker } from "@freecorps/ember-runtime";
import { Webhooks, webhooks, type WebhooksComponentApi } from "../../src/index.ts";

export { Shard } from "@freecorps/ember-runtime";

const hooks = new Webhooks(anyComponents.webhooks as unknown as WebhooksComponentApi);

export const schema = defineSchema({ tables: { orders: defineTable({ total: v.number() }) } });

export const functions = {
  admin: {
    add: mutationGeneric({ args: { url: v.string(), events: v.array(v.string()) }, handler: (ctx: any, a: any) => hooks.createEndpoint(ctx, a) }),
    replay: mutationGeneric({ args: { id: v.string() }, handler: (ctx: any, a: any) => hooks.replay(ctx, a.id) }),
    delivery: queryGeneric({ args: { id: v.string() }, handler: (ctx: any, a: any) => hooks.delivery(ctx, a.id) }),
  },
  shop: {
    order: mutationGeneric({
      args: { total: v.number(), event: v.string() },
      handler: (ctx: any, a: any) => {
        const id = ctx.db.insert("orders", { total: a.total });
        return hooks.send(ctx, a.event, { orderId: id, total: a.total });
      },
    }),
  },
};

export const app = defineApp().use(webhooks, { config: { retrySchedule: [100, 100, 100], jitter: 0 } });

export default createEmberWorker({ schema, functions, app });
