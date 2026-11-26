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

  test("the timeline shows a tool call and a tool result (no text) by their parts, bounded", () => {
    const composed = composeApp({ schema: defineSchema({ tables: {} }), functions: {}, app: defineApp().use(agent, { config: { workersAi: false } }) });
    let now = 1_700_000_000_000;
    const engine = createEngine({ schema: composed.schema, functions: composed.functions, driver: createNodeSqliteDriver(), now: () => now++ });
    engine.migrate();
    const t = engine.runMutation("@agent/lib:createThread", { userId: "ana" }).value as string;
    engine.runMutation("@agent/lib:send", { threadId: t, prompt: { role: "assistant", parts: [{ type: "tool-call", toolCallId: "c1", toolName: "weather", args: { city: "Lisbon" } }] } });
    engine.runMutation("@agent/lib:send", { threadId: t, prompt: { role: "tool", parts: [{ type: "tool-result", toolCallId: "c1", toolName: "weather", result: { temp: 21, sky: "x".repeat(400) } }] } });
    const { messages } = engine.runQuery("@agent/dashboard:thread", { threadId: t }).value as { messages: Array<{ detail: string | null }> };
    expect(messages[0]!.detail).toBe('→ weather({"city":"Lisbon"})');
    expect(messages[1]!.detail).toMatch(/^← weather: \{"temp":21,"sky":"x+…$/);
    expect(messages[1]!.detail!.length).toBeLessThan(260);
  });

  test("threads by activity through an index (no scan for a status), prompts counted from 0", () => {
    const composed = composeApp({ schema: defineSchema({ tables: {} }), functions: {}, app: defineApp().use(agent, { config: { workersAi: false } }) });
    let now = 1_700_000_000_000;
    const engine = createEngine({ schema: composed.schema, functions: composed.functions, driver: createNodeSqliteDriver(), now: () => now++ });
    engine.migrate();
    const ids = Array.from({ length: 40 }, (_, i) => engine.runMutation("@agent/lib:createThread", { userId: `u${i}`, title: `t${i}` }).value as string);
    engine.runMutation("@agent/lib:updateThread", { threadId: ids[3]!, patch: { status: "archived" } });
    // The oldest thread, touched last, comes first: by activity (updatedAt), not by creation.
    engine.runMutation("@agent/lib:updateThread", { threadId: ids[0]!, patch: { title: "renamed" } });
    const run = (args: object) => engine.runQuery("@agent/dashboard:threads", { paginationOpts: { numItems: 5, cursor: null }, ...args });
    const all = run({}).value as { page: Array<{ _id: string; prompts: number }> };
    expect(all.page.map((t) => t._id).slice(0, 2)).toEqual([ids[0], ids[3]]);
    // No prompt yet: 0 (lastOrder is -1).
    expect(all.page[0]!.prompts).toBe(0);
    const archived = run({ status: "archived" });
    expect((archived.value as { page: Array<{ _id: string }> }).page.map((t) => t._id)).toEqual([ids[3]]);
    // One status is a range of by_status: it never reads the other 39 threads.
    expect(archived.usage!.rowsRead).toBeLessThan(10);
  });
});
