// The flags component (PLAN §12): feature flags and remote config in one `.replicated()` table.
//
// The source of truth is `global:main`: the admin mutations (`setFlag`, `setRules`, `setRollout`, `toggle`,
// `deleteFlag`) only run there (anywhere else the engine refuses the write with `ReadOnlyTable`). Every write is
// copied to every shard by the runtime's replication (contracts.md "Tabelas replicadas"), so evaluating a flag in any
// shard's query or mutation is a synchronous read of the local copy: 0 RTT, reactive (a query re-runs when the copy
// changes), and the same evaluator (`./eval.ts`) runs on the client over a snapshot.

import { componentBuilders, defineComponent, defineErrors, defineSchema, defineTable, EmberError, paginationOptsValidator, v, type ComponentCtx, type GenericId } from "@freecorps/ember-server";
import { evaluateAll, evaluateDetail, flagValueError, ruleError, type Evaluation, type FlagContext, type FlagDefinition, type FlagRule, type FlagType } from "./eval.ts";

// ---------------------------------------------------------------------------------------------------- shapes

const scalar = v.union(v.string(), v.number(), v.boolean(), v.null());

export const vFlagType = v.union(v.literal("boolean"), v.literal("string"), v.literal("number"), v.literal("json"));
export const vCondition = v.object({
  attr: v.string(),
  op: v.union(v.literal("eq"), v.literal("neq"), v.literal("in"), v.literal("notIn"), v.literal("startsWith"), v.literal("semverGte"), v.literal("semverLt")),
  value: v.union(scalar, v.array(scalar)),
});
export const vRule = v.object({ id: v.optional(v.string()), description: v.optional(v.string()), conditions: v.array(vCondition), value: v.any() });
export const vRollout = v.object({ percent: v.number(), salt: v.string() });
/** The evaluation context: `unitId` (the rollout unit) and attributes the rules match. */
export const vFlagContext = v.record(v.union(scalar, v.array(v.union(v.string(), v.number()))));

const schema = defineSchema({
  tables: {
    /**
     * One row per flag. `.replicated()`: written in global:main, copied to every shard (same `_id`), read locally by
     * every shard's queries and mutations.
     */
    flags: defineTable({
      key: v.string(),
      type: vFlagType,
      defaultValue: v.any(),
      /** The "on" value (absent: `true` for boolean flags, `defaultValue` otherwise). */
      value: v.optional(v.any()),
      enabled: v.boolean(),
      description: v.optional(v.string()),
      /** `forClient` returns it (and `definitions({ clientVisible: true })` lists it). */
      clientVisible: v.boolean(),
      rules: v.array(vRule),
      rollout: v.optional(vRollout),
      updatedAt: v.number(),
      /** Bumped by every admin write (1 on creation). */
      version: v.number(),
    })
      .index("by_key", ["key"])
      .replicated(),
  },
});

export const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/;
export const MAX_RULES = 100;
export const MAX_CONDITIONS = 50;

const { query, mutation, internalQuery } = componentBuilders<typeof schema, undefined>();

type ReadCtx = ComponentCtx<typeof schema, undefined>["query"];
type FlagDoc = FlagDefinition & { _id: GenericId<"flags">; _creationTime: number; clientVisible: boolean; updatedAt: number; version: number };

const find = (ctx: ReadCtx, key: string): FlagDoc | null => ctx.db.query("flags").withIndex("by_key", (q) => q.eq("key", key)).first() as FlagDoc | null;
const all = (ctx: ReadCtx): FlagDoc[] => ctx.db.query("flags").withIndex("by_key").collect() as FlagDoc[];

/** The flag as the evaluator and clients see it (no `_id`/`_creationTime`). */
function definition(d: FlagDoc): FlagDefinition & { clientVisible: boolean; updatedAt: number; version: number } {
  const out: FlagDefinition & { clientVisible: boolean; updatedAt: number; version: number } = {
    key: d.key,
    type: d.type,
    defaultValue: d.defaultValue,
    enabled: d.enabled,
    rules: d.rules,
    clientVisible: d.clientVisible,
    updatedAt: d.updatedAt,
    version: d.version,
  };
  if (d.value !== undefined) out.value = d.value;
  if (d.rollout) out.rollout = d.rollout;
  if (d.description !== undefined) out.description = d.description;
  return out;
}

const invalid = (msg: string): never => {
  throw new EmberError("ValidationError", `flags: ${msg}`);
};

function checkKey(key: string) {
  if (!KEY_PATTERN.test(key)) invalid(`key ${JSON.stringify(key)}: use [A-Za-z0-9_.:-], starting with a letter or digit (max 100)`);
}

function checkRules(type: FlagType, rules: FlagRule[]) {
  if (rules.length > MAX_RULES) invalid(`at most ${MAX_RULES} rules`);
  for (const [i, r] of rules.entries()) {
    if (r.conditions.length > MAX_CONDITIONS) invalid(`rules[${i}]: at most ${MAX_CONDITIONS} conditions`);
    const e = ruleError(type, r, `rules[${i}]`);
    if (e) invalid(e);
  }
}

function checkValue(type: FlagType, what: string, value: unknown) {
  const e = flagValueError(type, value);
  if (e) invalid(`${what}: ${e}`);
}

function checkRollout(r: { percent: number; salt: string }) {
  if (!Number.isFinite(r.percent) || r.percent < 0 || r.percent > 100) invalid(`rollout.percent must be in 0..100 (got ${r.percent})`);
  if (!r.salt) invalid("rollout.salt must be a non-empty string");
}

/** The component's application errors (`isError(e, flagErrors.FlagNotFound)` narrows `e.data`). */
export const flagErrors = defineErrors({
  FlagNotFound: { data: v.object({ key: v.string() }), status: 404, message: (d: { key: string }) => `No flag ${JSON.stringify(d.key)}` },
});

/** Reads the flag `key` for an admin write, or throws `FlagNotFound`. */
function existing(ctx: ReadCtx, key: string): FlagDoc {
  const d = find(ctx, key);
  if (!d) throw flagErrors.FlagNotFound({ key });
  return d;
}

const vDefinition = v.object({
  key: v.string(),
  type: vFlagType,
  defaultValue: v.any(),
  value: v.optional(v.any()),
  enabled: v.boolean(),
  description: v.optional(v.string()),
  clientVisible: v.boolean(),
  rules: v.array(vRule),
  rollout: v.optional(vRollout),
  updatedAt: v.number(),
  version: v.number(),
});

const vEvaluation = v.object({
  value: v.any(),
  reason: v.union(v.literal("missing"), v.literal("disabled"), v.literal("rule"), v.literal("rollout"), v.literal("outOfRollout"), v.literal("on")),
  rule: v.optional(v.number()),
  version: v.optional(v.number()),
});

export const functions = {
  lib: {
    /** The flag `key` as stored in this shard's copy (null when it does not exist). */
    get: query({
      args: { key: v.string() },
      returns: v.nullable(vDefinition),
      handler: (ctx, a) => {
        const d = find(ctx, a.key);
        return d ? definition(d) : null;
      },
    }),
    /**
     * Every flag (in key order): a snapshot the pure evaluator (`@freecorps/ember-flags/eval`) can run over, offline
     * or on a client. `clientVisible: true` lists only the flags clients may see (rules included: they can name
     * attributes).
     */
    definitions: query({
      args: { clientVisible: v.optional(v.boolean()) },
      returns: v.array(vDefinition),
      handler: (ctx, a) => all(ctx).filter((d) => !a.clientVisible || d.clientVisible).map(definition),
    }),
    /** Evaluates one flag for `context`, with the reason (`missing` when the flag does not exist). */
    evaluate: query({
      args: { key: v.string(), context: v.optional(vFlagContext) },
      returns: vEvaluation,
      handler: (ctx, a): Evaluation => {
        const d = find(ctx, a.key);
        return evaluateDetail(d ? definition(d) : null, (a.context ?? {}) as FlagContext, null);
      },
    }),
    /** Every flag's value for `context`, by key. */
    all: query({
      args: { context: v.optional(vFlagContext) },
      returns: v.record(v.any()),
      handler: (ctx, a) => evaluateAll(all(ctx).map(definition), (a.context ?? {}) as FlagContext),
    }),
    /** The values of the `clientVisible` flags for `context`: what an app's `forClient` query returns to clients. */
    forClient: query({
      args: { context: v.optional(vFlagContext) },
      returns: v.record(v.any()),
      handler: (ctx, a) =>
        evaluateAll(
          all(ctx)
            .filter((d) => d.clientVisible)
            .map(definition),
          (a.context ?? {}) as FlagContext,
        ),
    }),

    // ------------------------------------------------------------------------------------- admin (global:main only)

    /**
     * Creates or replaces a flag's definition (fields left out keep their value on an existing flag; a new flag is
     * enabled, not client-visible, with no rules). Every value is checked against `type`. Returns the new version.
     */
    setFlag: mutation({
      args: {
        key: v.string(),
        type: vFlagType,
        defaultValue: v.any(),
        value: v.optional(v.any()),
        enabled: v.optional(v.boolean()),
        description: v.optional(v.string()),
        clientVisible: v.optional(v.boolean()),
        rules: v.optional(v.array(vRule)),
        rollout: v.optional(vRollout),
      },
      returns: v.number(),
      handler: (ctx, a) => {
        checkKey(a.key);
        const cur = find(ctx, a.key);
        const rules = (a.rules ?? cur?.rules ?? []) as FlagRule[];
        const value = a.value !== undefined ? a.value : cur?.type === a.type ? cur.value : undefined;
        const rollout = a.rollout ?? cur?.rollout;
        checkValue(a.type, "defaultValue", a.defaultValue);
        if (value !== undefined) checkValue(a.type, "value", value);
        checkRules(a.type, rules);
        if (rollout) checkRollout(rollout);
        const doc = {
          key: a.key,
          type: a.type,
          defaultValue: a.defaultValue,
          ...(value !== undefined ? { value } : {}),
          enabled: a.enabled ?? cur?.enabled ?? true,
          ...((a.description ?? cur?.description) !== undefined ? { description: a.description ?? cur!.description! } : {}),
          clientVisible: a.clientVisible ?? cur?.clientVisible ?? false,
          rules,
          ...(rollout ? { rollout } : {}),
          updatedAt: ctx.now,
          version: (cur?.version ?? 0) + 1,
        };
        if (cur) ctx.db.replace(cur._id, doc);
        else ctx.db.insert("flags", doc);
        return doc.version;
      },
    }),
    /** Deletes a flag (evaluations fall back to the caller's default). Returns whether it existed. */
    deleteFlag: mutation({
      args: { key: v.string() },
      returns: v.boolean(),
      handler: (ctx, a) => {
        const cur = find(ctx, a.key);
        if (cur) ctx.db.delete(cur._id);
        return !!cur;
      },
    }),
    /** Replaces the ordered targeting rules (the first match wins). Returns the new version. */
    setRules: mutation({
      args: { key: v.string(), rules: v.array(vRule) },
      returns: v.number(),
      errors: [flagErrors.FlagNotFound],
      handler: (ctx, a) => {
        const cur = existing(ctx, a.key);
        checkRules(cur.type, a.rules as FlagRule[]);
        const version = cur.version + 1;
        ctx.db.patch(cur._id, { rules: a.rules, updatedAt: ctx.now, version });
        return version;
      },
    }),
    /**
     * Sets the percentage rollout (`percent` 0–100, two decimals), or removes it (`percent: null`). `salt` reshuffles
     * who is in (default: the current salt, else the flag key): raising the percent keeps everyone already inside.
     */
    setRollout: mutation({
      args: { key: v.string(), percent: v.nullable(v.number()), salt: v.optional(v.string()) },
      returns: v.number(),
      errors: [flagErrors.FlagNotFound],
      handler: (ctx, a) => {
        const cur = existing(ctx, a.key);
        const version = cur.version + 1;
        if (a.percent === null) {
          ctx.db.patch(cur._id, { rollout: undefined, updatedAt: ctx.now, version });
          return version;
        }
        const rollout = { percent: a.percent, salt: a.salt ?? cur.rollout?.salt ?? a.key };
        checkRollout(rollout);
        ctx.db.patch(cur._id, { rollout, updatedAt: ctx.now, version });
        return version;
      },
    }),
    /** The kill switch: a disabled flag serves its `defaultValue` to everyone. Returns the new version. */
    toggle: mutation({
      args: { key: v.string(), enabled: v.boolean() },
      returns: v.number(),
      errors: [flagErrors.FlagNotFound],
      handler: (ctx, a) => {
        const cur = existing(ctx, a.key);
        const version = cur.version + 1;
        ctx.db.patch(cur._id, { enabled: a.enabled, updatedAt: ctx.now, version });
        return version;
      },
    }),
  },
};

// ------------------------------------------------------------------------------------------------ dashboard

const show = (x: unknown) => (x === undefined ? null : JSON.stringify(x));

/** What the dashboard's screen reads (module `dashboard`, internal: never part of the component's API). */
const dashboardFunctions = {
  /** Flags in key order, a page at a time, with the values as JSON text. */
  list: internalQuery({
    args: { paginationOpts: paginationOptsValidator },
    handler: (ctx, { paginationOpts }) => {
      const page = ctx.db.query("flags").withIndex("by_key").paginate(paginationOpts);
      return {
        ...page,
        page: (page.page as FlagDoc[]).map((d) => ({
          _id: d._id,
          key: d.key,
          type: d.type,
          enabled: d.enabled,
          defaultValue: show(d.defaultValue),
          value: show(d.value),
          rules: d.rules.length,
          rollout: d.rollout ? d.rollout.percent / 100 : null,
          clientVisible: d.clientVisible,
          version: d.version,
          updatedAt: d.updatedAt,
        })),
      };
    },
  }),
  /** One flag, with its rules, for the detail panel. */
  flag: internalQuery({
    args: { key: v.string() },
    handler: (ctx, a) => {
      const d = find(ctx, a.key);
      return d ? definition(d) : null;
    },
  }),
  /** Counts for the header. */
  stats: internalQuery({
    args: {},
    handler: (ctx) => {
      const flags = all(ctx);
      return {
        flags: flags.length,
        enabled: flags.filter((f) => f.enabled).length,
        rollingOut: flags.filter((f) => f.rollout && f.rollout.percent > 0 && f.rollout.percent < 100).length,
        clientVisible: flags.filter((f) => f.clientVisible).length,
        status: ctx.db.replicaStatus("flags").state,
      };
    },
  }),
};

export const flags = defineComponent({
  name: "flags",
  schema,
  functions: { ...functions, dashboard: dashboardFunctions },
  // The flags' screen in the Ember Dashboard (contracts.md "Telas declarativas"): global, since flags are written in
  // global:main only.
  dashboard: {
    label: "Feature flags",
    icon: "flag",
    scope: "global",
    description: "Flags are written here, in global:main, and copied to every shard; each shard evaluates them locally.",
    tabs: [
      {
        id: "flags",
        label: "Flags",
        blocks: [
          {
            kind: "stats",
            id: "stats",
            query: dashboardFunctions.stats,
            items: [
              { label: "Flags", path: "flags", format: "number" },
              { label: "Enabled", path: "enabled", format: "number" },
              { label: "Rolling out", path: "rollingOut", format: "number" },
              { label: "Client-visible", path: "clientVisible", format: "number" },
            ],
          },
          {
            kind: "table",
            id: "flags",
            query: dashboardFunctions.list,
            rowKey: "key",
            columns: [
              { label: "Key", path: "key", format: "code" },
              { label: "Type", path: "type", format: "badge" },
              { label: "Enabled", path: "enabled", format: "boolean", toggle: { mutation: functions.lib.toggle, arg: "enabled", fromRow: { key: "key" } } },
              { label: "Default", path: "defaultValue", format: "code" },
              { label: "On value", path: "value", format: "code" },
              { label: "Rules", path: "rules", format: "number" },
              { label: "Rollout", path: "rollout", format: "percent" },
              { label: "Client", path: "clientVisible", format: "boolean" },
              { label: "Version", path: "version", format: "number" },
              { label: "Updated", path: "updatedAt", format: "ago" },
            ],
            detail: {
              query: dashboardFunctions.flag,
              fromRow: { key: "key" },
              sections: [
                { kind: "kv", items: [{ label: "Description", path: "description" }, { label: "Rollout salt", path: "rollout.salt", format: "code" }, { label: "Version", path: "version", format: "number" }] },
                { kind: "json", label: "Rules", path: "rules" },
              ],
            },
            rowActions: [
              { id: "rollout", label: "Rollout %", fn: functions.lib.setRollout, fromRow: { key: "key" }, description: "Percent of units (0–100) that get the on value; null removes the rollout. A new salt reshuffles who is in." },
              { id: "rules", label: "Edit rules", fn: functions.lib.setRules, fromRow: { key: "key" }, destructive: true, description: "Replaces every targeting rule of the flag (the first match wins)." },
              { id: "delete", label: "Delete", fn: functions.lib.deleteFlag, fromRow: { key: "key" }, destructive: true, description: "Deletes the flag: every shard falls back to the caller's default." },
            ],
          },
          { kind: "actions", id: "manage", label: "Manage", actions: [{ id: "set", label: "Create or replace a flag…", fn: functions.lib.setFlag }] },
        ],
      },
    ],
  },
});
