// The workflows' screen in the Ember Dashboard (`defineComponent({ dashboard })`): the spec composes with absolute
// names, and the functions it names list, detail, cancel and delete workflows (run by name, as the dashboard does).
import { anyComponents, composeApp, createEngine, defineApp, defineSchema, internalActionGeneric, mutationGeneric, v } from "@freecorps/ember-server";
import { createNodeSqliteDriver } from "@freecorps/ember-server/testing";
import { describe, expect, test } from "vitest";
import { WorkflowManager, workflows } from "../src/index.ts";

const app = defineApp().use(workflows);
const workflow = new WorkflowManager(anyComponents.workflows);
const schema = defineSchema({ tables: {} });
const flows = {
  onboard: internalActionGeneric({ args: { user: v.string() }, handler: async () => null }),
  start: mutationGeneric({ args: { user: v.string() }, handler: (ctx: any, a: { user: string }) => workflow.start(ctx, "flows:onboard", a) }),
};

describe("workflows dashboard", () => {
  test("the spec: list and detail from the dashboard module, cancel and delete from lib", () => {
    const [spec] = composeApp({ schema, functions: { flows }, app }).dashboards;
    expect(spec).toMatchObject({ key: "workflows", component: "workflows", icon: "workflow", scope: "shard" });
    expect(Object.keys(spec!.functions).sort()).toEqual(["@workflows/dashboard:detail", "@workflows/dashboard:list", "@workflows/lib:cancel", "@workflows/lib:cleanup"]);
    expect(spec!.functions["@workflows/lib:cleanup"]).toMatchObject({ destructive: true });
  });

  test("list pages by status, detail shows the journal, cancel and delete act on one", () => {
    const composed = composeApp({ schema, functions: { flows }, app });
    const engine = createEngine({ schema: composed.schema, functions: composed.functions, driver: createNodeSqliteDriver(), now: () => 1_700_000_000_000 });
    engine.migrate();
    const ids = ["ana", "bo", "cy"].map((user) => engine.runMutation("flows:start", { user }).value as string);
    const list = (args: object) => engine.runQuery("@workflows/dashboard:list", { paginationOpts: { numItems: 2, cursor: null }, ...args }).value as { page: Array<{ _id: string; driver: string; status: string }>; isDone: boolean };
    const first = list({});
    expect([first.page.length, first.isDone]).toEqual([2, false]);
    expect(first.page[0]).toMatchObject({ driver: "flows:onboard", status: "running" });
    expect(engine.runMutation("@workflows/lib:cancel", { id: ids[0]! }).value).toBe(true);
    expect(list({ status: "canceled" }).page.map((w) => w._id)).toEqual([ids[0]]);
    const detail = engine.runQuery("@workflows/dashboard:detail", { id: ids[0]! }).value as { status: string; args: unknown; steps: unknown[] };
    expect(detail).toMatchObject({ status: "canceled", args: { user: "ana" }, steps: [] });
    expect(engine.runMutation("@workflows/lib:cleanup", { id: ids[0]! }).value).toBe(true);
    expect(engine.runQuery("@workflows/dashboard:detail", { id: ids[0]! }).value).toBeNull();
    expect(list({ status: "running" }).page).toHaveLength(2);
  });
});
