/**
 * The workerd test app: the push component installed with direct APNs + FCM, and app functions that register devices
 * and send (now from an action, or enqueued from a mutation). The APNs/FCM/Google endpoints are fakes behind
 * miniflare's `outboundService` (vitest.workerd.config.ts), with the secrets as bindings.
 */
import { anyComponents, defineApp, defineSchema, defineTable, mutationGeneric, queryGeneric, actionGeneric, v } from "@freecorps/ember-server";
import { createEmberWorker } from "@freecorps/ember-runtime";
import { pushComponent, PushNotifications } from "../../src/index.ts";

export { Shard } from "@freecorps/ember-runtime";

const push = new PushNotifications(anyComponents.push);

export const schema = defineSchema({ tables: { mail: defineTable({ to: v.string(), subject: v.string() }) } });

export const functions = {
  push: {
    register: mutationGeneric({ args: { user: v.string(), device: v.any() }, handler: (ctx: any, a: any) => push.register(ctx, { userId: a.user, ...a.device }) }),
    devices: queryGeneric({ args: { user: v.string() }, handler: (ctx: any, a: any) => push.devices(ctx, a.user) }),
    notifyNow: actionGeneric({ args: { user: v.string(), message: v.any() }, handler: (ctx: any, a: any) => push.sendNow(ctx, [a.user], a.message) }),
  },
  mail: {
    receive: mutationGeneric({
      args: { to: v.string(), from: v.string(), subject: v.string() },
      handler: (ctx: any, a: any) => {
        ctx.db.insert("mail", { to: a.to, subject: a.subject });
        push.send(ctx, [a.to], { title: a.from, body: a.subject, urgency: "high", data: { mailbox: "inbox" } });
        return null;
      },
    }),
  },
};

export const app = defineApp().use(pushComponent, {
  config: { encryption: "auto", fallback: { title: "New mail", body: "Open Mail to read it" }, receiptsDelayMs: 0 },
});

export default createEmberWorker({ schema, functions, app });
