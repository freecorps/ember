// The pool's screen in the Ember Dashboard (`defineComponent({ dashboard })`): the spec composes with absolute names,
// and the queries and mutations it names do what the screen shows (run here as the dashboard runs them: by name).
import { anyComponents, composeApp, defineApp, defineSchema, internalMutationGeneric, mutationGeneric, unsafeRef, v } from "@freecorps/ember-server";
import { emberTest } from "@freecorps/ember-testing";
import { describe, expect, test } from "vitest";
import { Workpool, workpool } from "../src/index.ts";

const app = defineApp().use(workpool, { name: "pool" });
const schema = defineSchema({ tables: {} });
const pool = new Workpool(anyComponents.pool, { maxParallelism: 1 });
const jobs = {
  add: mutationGeneric({ args: { n: v.number() }, handler: (ctx: any, { n }: { n: number }) => Array.from({ length: n }, (_, i) => pool.enqueueMutation(ctx, unsafeRef<"mutation">("jobs:work"), { i })) }),
  work: internalMutationGeneric({ args: { i: v.number() }, handler: (_ctx: unknown, { i }: { i: number }) => i * 2 }),
};
const fn = (name: string) => unsafeRef(`@pool/lib:${name}`);

describe("workpool dashboard", () => {
  test("the spec names only the pool's functions, under the install's name", () => {
    const [spec] = composeApp({ schema, functions: { jobs }, app }).dashboards;
    expect(spec).toMatchObject({ key: "pool", component: "workpool", scope: "shard", icon: "queue" });
    expect(Object.keys(spec!.functions).sort()).toEqual(["@pool/lib:cancel", "@pool/lib:cancelAll", "@pool/lib:item", "@pool/lib:list", "@pool/lib:stats"]);
    expect(spec!.functions["@pool/lib:cancelAll"]).toMatchObject({ type: "mutation", destructive: true });
    expect(spec!.tabs[0]!.blocks[1]).toMatchObject({ kind: "table", query: "@pool/lib:list", filters: ["status"], pageSize: 25 });
  });

  test("list pages items by status, item shows the detail, cancel and cancelAll act on them", async () => {
    const t = emberTest({ schema, modules: { jobs }, app });
    const ids = (await t.mutation(unsafeRef<"mutation">("jobs:add"), { n: 3 })) as string[];
    // maxParallelism 1: one running, two pending.
    const all = (await t.query(fn("list"), { paginationOpts: { numItems: 10, cursor: null } })) as { page: Array<{ _id: string; status: string; fn: string }>; isDone: boolean };
    expect(all.isDone).toBe(true);
    expect(all.page.map((w) => w.status).sort()).toEqual(["pending", "pending", "running"]);
    expect(all.page[0]!.fn).toBe("jobs:work");
    const pending = (await t.query(fn("list"), { status: "pending", paginationOpts: { numItems: 1, cursor: null } })) as { page: Array<{ _id: string }>; isDone: boolean; continueCursor: string };
    expect([pending.page.length, pending.isDone]).toEqual([1, false]);
    const next = (await t.query(fn("list"), { status: "pending", paginationOpts: { numItems: 1, cursor: pending.continueCursor } })) as { page: Array<{ _id: string }> };
    expect(next.page[0]!._id).not.toBe(pending.page[0]!._id);

    const detail = (await t.query(fn("item"), { id: ids[0]! })) as { args: unknown; events: Array<{ event: string }> };
    expect(detail.args).toEqual({ i: 0 });
    expect(detail.events.map((e) => e.event)).toEqual(["enqueued", "attempt 1 started"]);
    expect(await t.query(fn("item"), { id: "nope" })).toBeNull();

    expect(await t.mutation(fn("cancel"), { id: pending.page[0]!._id })).toBe(true);
    expect(await t.mutation(fn("cancelAll"), {})).toBeGreaterThanOrEqual(1);
    const after = (await t.query(fn("list"), { status: "canceled", paginationOpts: { numItems: 10, cursor: null } })) as { page: unknown[] };
    expect(after.page.length).toBeGreaterThanOrEqual(2);
  });
});
