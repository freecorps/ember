// The limiter's screen in the Ember Dashboard (`defineComponent({ dashboard })`): the spec composes with absolute names,
// and the functions it names list buckets, show the install config and reset a key (run by name, as the dashboard does).
import { composeApp, createEngine, defineApp, defineSchema } from "@freecorps/ember-server";
import { createNodeSqliteDriver } from "@freecorps/ember-server/testing";
import { describe, expect, test } from "vitest";
import { MINUTE, rateLimit } from "../src/index.ts";

const app = defineApp().use(rateLimit, { config: { limits: { send: { kind: "token bucket", rate: 2, period: MINUTE } }, gc: false } });
const schema = defineSchema({ tables: {} });

describe("rate limit dashboard", () => {
  test("the spec, and buckets / config / reset doing what the screen shows", () => {
    const composed = composeApp({ schema, functions: {}, app });
    const [spec] = composed.dashboards;
    expect(spec).toMatchObject({ key: "rateLimit", component: "rateLimit", icon: "gauge" });
    expect(Object.keys(spec!.functions).sort()).toEqual(["@rateLimit/dashboard:buckets", "@rateLimit/dashboard:config", "@rateLimit/lib:reset"]);
    expect(spec!.tabs[0]!.blocks[0]).toMatchObject({ filters: ["name", "key"], pageSize: 25 });

    const engine = createEngine({ schema: composed.schema, functions: composed.functions, driver: createNodeSqliteDriver(), now: () => 1_700_000_000_000 });
    engine.migrate();
    for (const key of ["ana", "bo", "ana"]) engine.runMutation("@rateLimit/lib:limit", { name: "send", key });
    const page = (args: object) => engine.runQuery("@rateLimit/dashboard:buckets", { paginationOpts: { numItems: 10, cursor: null }, ...args }).value as { page: Array<{ key: string; value: number; named: boolean }> };
    expect(page({}).page.map((b) => [b.key, b.value, b.named])).toEqual([["ana", 0, true], ["bo", 1, true]]);
    // A key alone would scan every limit's buckets: the limit is asked for.
    expect(() => page({ key: "bo" })).toThrow(/pick the limit \(name\)/);
    expect(page({ name: "send" }).page.map((b) => b.key)).toEqual(["ana", "bo"]);
    expect(page({ name: "send", key: "ana" }).page.map((b) => b.key)).toEqual(["ana"]);
    expect(engine.runQuery("@rateLimit/dashboard:config", {}).value).toMatchObject({ limits: [{ name: "send", kind: "token bucket", rate: 2 }], gc: "off", buckets: 2 });
    expect(engine.runMutation("@rateLimit/lib:reset", { name: "send", key: "ana" }).value).toBe(true);
    expect(page({}).page.map((b) => b.key)).toEqual(["bo"]);
  });
});
