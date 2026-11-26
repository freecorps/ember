// The devices' screen in the Ember Dashboard (`defineComponent({ dashboard })`): the spec composes with absolute names,
// and the functions it names count, list (tokens masked), remove and prune devices (run by name, as the dashboard does).
import { anyComponents, composeApp, createEngine, defineApp, defineSchema, mutationGeneric, v } from "@freecorps/ember-server";
import { createNodeSqliteDriver } from "@freecorps/ember-server/testing";
import { describe, expect, test } from "vitest";
import { PushNotifications, pushComponent } from "../src/index.ts";

const push = new PushNotifications(anyComponents.push);
const app = defineApp().use(pushComponent);
const schema = defineSchema({ tables: {} });
const chat = {
  register: mutationGeneric({ args: { user: v.string(), token: v.string(), platform: v.optional(v.string()) }, handler: (ctx: any, a: any) => push.register(ctx, { userId: a.user, token: a.token, ...(a.platform ? { platform: a.platform } : {}) }) }),
};
const EXPO = "ExponentPushToken[abcdefghijklmnopqrstuv]";
const APNS = "a".repeat(64);

describe("push dashboard", () => {
  test("overview by provider, devices with masked tokens, remove by id, prune", () => {
    const composed = composeApp({ schema, functions: { chat }, app });
    const [spec] = composed.dashboards;
    expect(spec).toMatchObject({ key: "push", component: "push", icon: "bell" });
    expect(Object.keys(spec!.functions).sort()).toEqual(["@push/dashboard:devices", "@push/dashboard:overview", "@push/dashboard:remove", "@push/lib:pruneStale"]);
    let now = 1_700_000_000_000;
    const engine = createEngine({ schema: composed.schema, functions: composed.functions, driver: createNodeSqliteDriver(), now: () => now });
    engine.migrate();
    engine.runMutation("chat:register", { user: "ana", token: EXPO, platform: "ios" });
    now += 1000;
    engine.runMutation("chat:register", { user: "bo", token: APNS, platform: "ios" });
    expect(engine.runQuery("@push/dashboard:overview", {}).value).toEqual({ total: 2, expo: 1, apns: 1, fcm: 0, pendingReceipts: 0 });
    const list = (args: object) => engine.runQuery("@push/dashboard:devices", { paginationOpts: { numItems: 10, cursor: null }, ...args }).value as { page: Array<{ _id: string; userId: string; provider: string; token: string }> };
    const all = list({});
    expect(all.page.map((d) => [d.userId, d.provider])).toEqual([["bo", "apns"], ["ana", "expo"]]);
    // Never the token itself.
    expect(JSON.stringify(all)).not.toContain(EXPO);
    expect(JSON.stringify(all)).not.toContain(APNS);
    expect(list({ provider: "expo" }).page.map((d) => d.userId)).toEqual(["ana"]);
    expect(list({ userId: "bo" }).page.map((d) => d.provider)).toEqual(["apns"]);
    expect(engine.runMutation("@push/dashboard:remove", { id: all.page[0]!._id }).value).toBe(true);
    expect(engine.runMutation("@push/dashboard:remove", { id: all.page[0]!._id }).value).toBe(false);
    now += 40 * 86_400_000;
    expect(engine.runMutation("@push/lib:pruneStale", { olderThanMs: 30 * 86_400_000 }).value).toBe(1);
    expect(engine.runQuery("@push/dashboard:overview", {}).value).toMatchObject({ total: 0 });
  });

  test("one provider's devices are a range of an index (no scan); receipt checks past 1000 read as 1000+", () => {
    const composed = composeApp({ schema, functions: { chat }, app });
    let now = 1_700_000_000_000;
    const engine = createEngine({ schema: composed.schema, functions: composed.functions, driver: createNodeSqliteDriver(), now: () => now++ });
    engine.migrate();
    for (let i = 0; i < 40; i++) engine.runMutation("chat:register", { user: `u${i}`, token: `ExponentPushToken[device-${String(i).padStart(12, "0")}]` });
    engine.runMutation("chat:register", { user: "bo", token: APNS });
    const r = engine.runQuery("@push/dashboard:devices", { provider: "apns", paginationOpts: { numItems: 10, cursor: null } });
    expect((r.value as { page: Array<{ userId: string }> }).page.map((d) => d.userId)).toEqual(["bo"]);
    expect(r.usage!.rowsRead).toBeLessThan(10);
    // Receipt checks: counted up to 1000, then "1000+" (never a number that looks exact).
    const queue = () => engine.runMutation("@push/lib:queueReceipts", { tokens: [], tickets: [{ token: EXPO, id: "t" }], attempt: 1 });
    for (let i = 0; i < 1000; i++) queue();
    expect(engine.runQuery("@push/dashboard:overview", {}).value).toMatchObject({ pendingReceipts: 1000 });
    queue();
    expect(engine.runQuery("@push/dashboard:overview", {}).value).toMatchObject({ pendingReceipts: "1000+" });
  });
});
