// The threads' screen in the Ember Dashboard (`defineComponent({ dashboard })`): the spec composes with absolute names,
// and the functions it names list threads, show one with its messages, archive and delete (run by name).
import { composeApp, createEngine, defineApp, defineSchema } from "@freecorps/ember-server";
import { createNodeSqliteDriver } from "@freecorps/ember-server/testing";
import { describe, expect, test } from "vitest";
import { agent } from "../src/index.ts";

describe("agent dashboard", () => {
  test("threads by user and status, the thread's timeline, archive and delete", () => {
    const composed = composeApp({ schema: defineSchema({ tables: {} }), functions: {}, app: defineApp().use(agent, { config: { workersAi: false } }) });
    const [spec] = composed.dashboards;
    expect(spec).toMatchObject({ key: "agent", component: "agent", icon: "bot" });
    expect(Object.keys(spec!.functions).sort()).toEqual(["@agent/dashboard:thread", "@agent/dashboard:threads", "@agent/lib:deleteThread", "@agent/lib:updateThread"]);
    let now = 1_700_000_000_000;
    const engine = createEngine({ schema: composed.schema, functions: composed.functions, driver: createNodeSqliteDriver(), now: () => now++ });
    engine.migrate();
    const a = engine.runMutation("@agent/lib:createThread", { userId: "ana", title: "Trip" }).value as string;
    const b = engine.runMutation("@agent/lib:createThread", { userId: "bo", title: "Recipes" }).value as string;
    const list = (args: object) => (engine.runQuery("@agent/dashboard:threads", { paginationOpts: { numItems: 10, cursor: null }, ...args }).value as { page: Array<{ _id: string; title: string; status: string }> }).page;
    expect(list({}).map((t) => t.title)).toEqual(["Recipes", "Trip"]);
    expect(list({ userId: "ana" }).map((t) => t._id)).toEqual([a]);
    expect(engine.runQuery("@agent/dashboard:thread", { threadId: a }).value).toMatchObject({ title: "Trip", messages: [] });
    engine.runMutation("@agent/lib:updateThread", { threadId: b, patch: { status: "archived" } });
    expect(list({ status: "archived" }).map((t) => t._id)).toEqual([b]);
    expect(engine.runMutation("@agent/lib:deleteThread", { threadId: a }).value).toBe(true);
    expect(engine.runQuery("@agent/dashboard:thread", { threadId: a }).value).toBeNull();
  });
});
