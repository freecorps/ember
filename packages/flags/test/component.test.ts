// The flags component over the real engine (`emberTest({ app })`): admin writes in global:main, the `.replicated()`
// copy in an org shard, evaluation inside that shard's queries and mutations (a local read), `forClient`, versions,
// the dashboard spec, and the refusals (writes off global:main, bad values).
import {
  anyApi,
  componentsOf,
  composeApp,
  defineApp,
  defineSchema,
  defineShard,
  defineTable,
  isAppError,
  mutationGeneric,
  queryGeneric,
  v,
  type ApiFromModules,
} from "@freecorps/ember-server";
import { emberTest } from "@freecorps/ember-testing";
import { describe, expect, test } from "vitest";
import { FeatureFlags, flagErrors, flags, vFlagContext, type FlagsComponentApi, type FlagContext } from "../src/index.ts";

const app = defineApp().use(flags);
// What codegen's `components` gives the app is what the helper takes.
const components: { flags: FlagsComponentApi } = componentsOf(app);
const ff = new FeatureFlags(components.flags, {
  newCheckout: { type: "boolean", default: false },
  checkoutTheme: { type: "string", default: "classic" },
  maxItems: { type: "number", default: 10 },
});

const schema = defineSchema({
  shards: { org: defineShard({ key: v.string() }) },
  tables: { orders: defineTable({ user: v.string(), flow: v.string(), theme: v.string() }) },
});

const modules = {
  admin: {
    set: mutationGeneric({ args: { flag: v.any() }, handler: (ctx: any, a: any) => ff.set(ctx, a.flag) }),
    toggle: mutationGeneric({ args: { key: v.string(), on: v.boolean() }, handler: (ctx: any, a: any) => ff.toggle(ctx, a.key, a.on) }),
    rollout: mutationGeneric({ args: { key: v.string(), percent: v.nullable(v.number()), salt: v.optional(v.string()) }, handler: (ctx: any, a: any) => ff.setRollout(ctx, a.key, a.percent, a.salt) }),
    rules: mutationGeneric({ args: { key: v.string(), rules: v.any() }, handler: (ctx: any, a: any) => ff.setRules(ctx, a.key, a.rules) }),
    remove: mutationGeneric({ args: { key: v.string() }, handler: (ctx: any, a: any) => ff.delete(ctx, a.key) }),
  },
  checkout: {
    /** A mutation in an org shard that branches on flags (a local read of the shard's copy). */
    start: mutationGeneric({
      args: { user: v.string(), plan: v.string() },
      handler: (ctx: any, a: { user: string; plan: string }) => {
        const context: FlagContext = { unitId: a.user, plan: a.plan };
        const flow = ff.evaluate(ctx, "newCheckout", context) ? "new" : "old";
        const theme: string = ff.evaluate(ctx, "checkoutTheme", context);
        return ctx.db.insert("orders", { user: a.user, flow, theme });
      },
    }),
    order: queryGeneric({ args: { id: v.string() }, handler: (ctx: any, a: any) => ctx.db.get(a.id) }),
    detail: queryGeneric({ args: { key: v.string(), context: vFlagContext }, handler: (ctx: any, a: any) => ff.detail(ctx, a.key, a.context) }),
    all: queryGeneric({ args: { context: vFlagContext }, handler: (ctx: any, a: any) => ff.all(ctx, a.context) }),
  },
  flags: {
    forClient: queryGeneric({ args: { context: vFlagContext }, handler: (ctx: any, a: any) => ff.forClient(ctx, a.context) }),
    /** The flag as stored in the shard the query runs on. */
    get: queryGeneric({ args: { key: v.string() }, handler: (ctx: any, a: any) => ctx.runQuery(components.flags.lib.get, { key: a.key }) }),
  },
};
const api = anyApi as unknown as ApiFromModules<typeof modules>;
const ORG = { shard: "org:acme" };

/** A harness whose org shard exists (a shard gets copies once it has served something, as in the runtime). */
async function setup() {
  const t = emberTest({ schema, modules, app });
  await t.query(api.checkout.all, { context: {} }, ORG);
  return t;
}

describe("flags component", () => {
  test("a flag written in global:main is evaluated in an org shard's mutation after replication", async () => {
    const t = await setup();
    // Before the first copy the org shard reads nothing: declared defaults.
    expect(await t.query(api.checkout.all, { context: {} }, ORG)).toEqual({ newCheckout: false, checkoutTheme: "classic", maxItems: 10 });

    expect(await t.mutation(api.admin.set, { flag: { key: "newCheckout", type: "boolean", defaultValue: false } })).toBe(1);
    expect(await t.mutation(api.admin.set, { flag: { key: "checkoutTheme", type: "string", defaultValue: "classic", value: "fresh", clientVisible: true, rules: [{ conditions: [{ attr: "plan", op: "eq", value: "enterprise" }], value: "corporate" }] } })).toBe(1);
    // Not copied yet: the org shard still serves defaults.
    const before = await t.mutation(api.checkout.start, { user: "u1", plan: "pro" }, ORG);
    expect(await t.query(api.checkout.order, { id: before }, ORG)).toMatchObject({ flow: "old", theme: "classic" });

    await t.syncReplicas();
    const after = await t.mutation(api.checkout.start, { user: "u1", plan: "pro" }, ORG);
    expect(await t.query(api.checkout.order, { id: after }, ORG)).toMatchObject({ flow: "new", theme: "fresh" });
    const ent = await t.mutation(api.checkout.start, { user: "u2", plan: "enterprise" }, ORG);
    expect(await t.query(api.checkout.order, { id: ent }, ORG)).toMatchObject({ theme: "corporate" });
    expect(await t.query(api.checkout.detail, { key: "checkoutTheme", context: { plan: "enterprise" } }, ORG)).toEqual({ value: "corporate", reason: "rule", rule: 0, version: 1 });

    // The evaluation reads the shard's copy only: a few rows, no other shard involved.
    const { stats } = await t.measure(() => t.query(api.checkout.detail, { key: "newCheckout", context: { unitId: "u1" } }, ORG));
    expect(stats.rowsRead).toBeLessThan(5);
  });

  test("toggle, rollout and rules bump the version; the kill switch serves defaultValue", async () => {
    const t = await setup();
    await t.mutation(api.admin.set, { flag: { key: "newCheckout", type: "boolean", defaultValue: false } });
    expect(await t.mutation(api.admin.toggle, { key: "newCheckout", on: false })).toBe(2);
    await t.syncReplicas();
    expect(await t.query(api.checkout.detail, { key: "newCheckout", context: { unitId: "u1" } }, ORG)).toEqual({ value: false, reason: "disabled", version: 2 });

    await t.mutation(api.admin.toggle, { key: "newCheckout", on: true });
    expect(await t.mutation(api.admin.rollout, { key: "newCheckout", percent: 30 })).toBe(4);
    await t.syncReplicas();
    const users = Array.from({ length: 1000 }, (_, i) => `u${i}`);
    let inside = 0;
    for (const u of users.slice(0, 300)) if ((await t.query(api.checkout.detail, { key: "newCheckout", context: { unitId: u } }, ORG)).value) inside++;
    expect(inside / 300).toBeGreaterThan(0.2);
    expect(inside / 300).toBeLessThan(0.4);
    // The default salt is the key: global:main and the org shard agree on every unit.
    for (const u of users.slice(0, 50)) {
      const here = await t.query(api.checkout.detail, { key: "newCheckout", context: { unitId: u } });
      const there = await t.query(api.checkout.detail, { key: "newCheckout", context: { unitId: u } }, ORG);
      expect(there.value).toBe(here.value);
    }
    expect(await t.mutation(api.admin.rollout, { key: "newCheckout", percent: null })).toBe(5);
    // `percent: null` removes the field (a patch with `undefined`), not just its value.
    expect(await t.query(api.flags.get, { key: "newCheckout" })).not.toHaveProperty("rollout");
    expect(await t.mutation(api.admin.rules, { key: "newCheckout", rules: [{ conditions: [{ attr: "staff", op: "eq", value: true }], value: false }] })).toBe(6);
    await t.syncReplicas();
    expect(await t.query(api.checkout.detail, { key: "newCheckout", context: { unitId: "u1", staff: true } }, ORG)).toMatchObject({ value: false, reason: "rule", version: 6 });
    expect(await t.query(api.checkout.detail, { key: "newCheckout", context: { unitId: "u1" } }, ORG)).toMatchObject({ value: true, reason: "on" });

    expect(await t.mutation(api.admin.remove, { key: "newCheckout" })).toBe(true);
    await t.syncReplicas();
    // The delete is replicated (the org shard's copy is gone, not kept stale): the flag is missing there, with no version.
    expect(await t.query(api.flags.get, { key: "newCheckout" }, ORG)).toBeNull();
    expect(await t.query(api.checkout.detail, { key: "newCheckout", context: {} }, ORG)).toEqual({ value: false, reason: "missing" });
  });

  test("forClient: only clientVisible flags; a declared flag of the wrong stored type serves its default", async () => {
    const t = await setup();
    await t.mutation(api.admin.set, { flag: { key: "checkoutTheme", type: "string", defaultValue: "classic", clientVisible: true } });
    await t.mutation(api.admin.set, { flag: { key: "secretBeta", type: "boolean", defaultValue: false } });
    await t.mutation(api.admin.set, { flag: { key: "maxItems", type: "string", defaultValue: "lots", clientVisible: true } });
    await t.syncReplicas();
    expect(await t.query(api.flags.forClient, { context: {} }, ORG)).toEqual({ checkoutTheme: "classic", maxItems: 10 });
    // `secretBeta` is enabled with no `value`: a boolean flag's on value is `true` (`defaultValue` is what a disabled
    // flag, or a unit outside its rollout, gets).
    expect(await t.query(api.checkout.all, { context: {} }, ORG)).toEqual({ newCheckout: false, checkoutTheme: "classic", maxItems: 10, secretBeta: true });
  });

  test("setFlag with a new type drops the stored value and rules (written for the old type) unless given again", async () => {
    const t = await setup();
    await t.mutation(api.admin.set, { flag: { key: "limit", type: "string", defaultValue: "low", value: "high", rollout: { percent: 100, salt: "s" }, rules: [{ conditions: [{ attr: "plan", op: "eq", value: "pro" }], value: "max" }] } });
    expect(await t.mutation(api.admin.set, { flag: { key: "limit", type: "number", defaultValue: 10 } })).toBe(2);
    const stored = await t.query(api.flags.get, { key: "limit" });
    expect(stored).toMatchObject({ type: "number", defaultValue: 10, rules: [], rollout: { percent: 100, salt: "s" } });
    expect(stored).not.toHaveProperty("value");
    expect(await t.query(api.checkout.detail, { key: "limit", context: { unitId: "u1", plan: "pro" } })).toMatchObject({ value: 10, reason: "rollout" });
    // Same type: what is left out is kept.
    await t.mutation(api.admin.set, { flag: { key: "limit", type: "number", defaultValue: 10, value: 20, rules: [{ conditions: [{ attr: "plan", op: "eq", value: "pro" }], value: 50 }] } });
    await t.mutation(api.admin.set, { flag: { key: "limit", type: "number", defaultValue: 5, description: "max items" } });
    expect(await t.query(api.flags.get, { key: "limit" })).toMatchObject({ defaultValue: 5, value: 20, rules: [{ value: 50 }], description: "max items", version: 4 });
    // A json value JSON cannot hold is refused (the dashboard prints values as JSON).
    await expect(t.mutation(api.admin.set, { flag: { key: "cfg", type: "json", defaultValue: { n: 1n } } })).rejects.toThrow(/defaultValue: expected a JSON value, got bigint 1n at n/);
  });

  test("forClient returns a new object (the query's result is not changed in place)", () => {
    const raw = { checkoutTheme: 1, other: "x" };
    const ctx = { db: {}, runQuery: () => raw };
    expect(ff.forClient(ctx, {})).toEqual({ checkoutTheme: "classic", other: "x" });
    expect(raw).toEqual({ checkoutTheme: 1, other: "x" });
  });

  test("declared specs: the default must be of the declared type", () => {
    new FeatureFlags(components.flags, {
      ok: { type: "boolean", default: false },
      also: { type: "json", default: { any: ["thing"] } },
      // @ts-expect-error a boolean flag with a string default
      bad: { type: "boolean", default: "enabled" },
    });
    const typed = new FeatureFlags(components.flags, { n: { type: "number", default: 1 } });
    const value: (ctx: { db: unknown; runQuery(fn: unknown, args?: unknown): unknown }) => number = (ctx) => typed.evaluate(ctx, "n");
    expect(typeof value).toBe("function");
  });

  test("refusals: writes off global:main, bad values, unknown flags (typed error)", async () => {
    const t = await setup();
    await expect(t.mutation(api.admin.set, { flag: { key: "x", type: "boolean", defaultValue: false } }, ORG)).rejects.toMatchObject({ code: "ReadOnlyTable" });
    await expect(t.mutation(api.admin.set, { flag: { key: "x", type: "boolean", defaultValue: "no" } })).rejects.toThrow(/defaultValue: expected a boolean/);
    await expect(t.mutation(api.admin.set, { flag: { key: "bad key", type: "boolean", defaultValue: false } })).rejects.toThrow(/key "bad key"/);
    await expect(t.mutation(api.admin.set, { flag: { key: "x", type: "number", defaultValue: 1, rollout: { percent: 120, salt: "s" } } })).rejects.toThrow(/rollout.percent/);
    await expect(t.mutation(api.admin.set, { flag: { key: "x", type: "number", defaultValue: 1, rules: [{ conditions: [], value: "2" }] } })).rejects.toThrow(/rules\[0\].value/);
    const e = await t.mutation(api.admin.toggle, { key: "nope", on: true }).catch((x: unknown) => x);
    expect(isAppError(e) && e.code === flagErrors.FlagNotFound.code).toBe(true);
    expect((e as { data: unknown }).data).toEqual({ key: "nope" });
  });

  test("the dashboard spec: global scope, toggle column, rollout and destructive rule edits", () => {
    const composed = composeApp({ schema, functions: modules, app });
    const spec = composed.dashboards.find((d) => d.key === "flags")!;
    expect(spec).toMatchObject({ scope: "global", icon: "flag" });
    const table = spec.tabs[0]!.blocks.find((b) => b.id === "flags")!;
    expect(table.kind === "table" && table.columns.find((c) => c.path === "enabled")?.toggle).toEqual({ mutation: "@flags/lib:toggle", arg: "enabled", fromRow: { key: "key" } });
    expect(spec.functions["@flags/lib:setRules"]).toMatchObject({ type: "mutation", destructive: true });
    expect(spec.functions["@flags/lib:setRollout"]?.destructive).toBeUndefined();
  });

  test("the dashboard's list and stats", async () => {
    const t = await setup();
    await t.mutation(api.admin.set, { flag: { key: "a", type: "boolean", defaultValue: false, rollout: { percent: 25, salt: "s" } } });
    await t.mutation(api.admin.set, { flag: { key: "b", type: "json", defaultValue: { x: 1 }, enabled: false } });
    const e = t.engine();
    const page = e.runQuery("@flags/dashboard:list", { paginationOpts: { numItems: 10, cursor: null } }).value as { page: Array<Record<string, unknown>> };
    expect(page.page.map((r) => [r.key, r.enabled, r.rollout, r.defaultValue])).toEqual([["a", true, 0.25, "false"], ["b", false, null, '{"x":1}']]);
    expect(e.runQuery("@flags/dashboard:stats", {}).value).toEqual({ flags: 2, enabled: 1, rollingOut: 1, clientVisible: 0, status: "source" });
  });
});
