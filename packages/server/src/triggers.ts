// Triggers por tabela (PLAN §22 L2, contracts.md "Triggers"): `ember/triggers.ts` exports
//
//   export default defineTriggers({
//     messages: (ctx, change) => { if (change.operation === "insert") ctx.db.patch(...) },
//   });
//
// A trigger runs inside the mutation's transaction after every insert / patch / replace / delete (and increment) that
// actually wrote a row of its table. Writes a trigger makes fire triggers in turn; the queue is drained in FIFO order
// before the outermost `ctx.db.*` call returns (engine.ts). Pure data here: the engine runs them.

import { TABLE_SEP } from "./components.ts";
import { EmberError } from "./errors.ts";
import type { MutationCtx, TableNamesIn } from "./functions.ts";
import type { AnyDataModel, GenericDataModel, SchemaManifest } from "./schema.ts";

/** One write of a row, as triggers see it (the same shape as convex-helpers' `Change`). */
export type Change<D extends { _id: unknown } = { _id: string; [k: string]: unknown }> =
  | { id: D["_id"]; operation: "insert"; oldDoc: null; newDoc: D }
  | { id: D["_id"]; operation: "update"; oldDoc: D; newDoc: D }
  | { id: D["_id"]; operation: "delete"; oldDoc: D; newDoc: null };

/**
 * What a trigger gets: a mutation ctx over the app's tables (writes fire triggers too), sharing the mutation's
 * transaction, identity, `now` and seeded `random`.
 */
export type TriggerCtx<DM extends GenericDataModel = AnyDataModel> = Omit<MutationCtx<DM>, "component">;

/** A trigger of table `T`. Synchronous (a Promise is refused with `AsyncHandler`); a throw aborts the write. */
export type Trigger<DM extends GenericDataModel, T extends TableNamesIn<DM>> = (ctx: TriggerCtx<DM>, change: Change<DM[T]["document"]>) => void;

/** `defineTriggers` input: one trigger or a list (run in order) per app table. */
export type TriggersInput<DM extends GenericDataModel> = {
  [T in TableNamesIn<DM>]?: Trigger<DM, T> | ReadonlyArray<Trigger<DM, T>>;
};

const TRIGGERS = Symbol.for("ember.triggers");

/** What `defineTriggers` returns (the default export of `ember/triggers.ts`). */
export interface TriggersDefinition {
  readonly [TRIGGERS]: true;
  /** Table -> triggers, in declaration order. */
  readonly tables: Readonly<Record<string, ReadonlyArray<(ctx: unknown, change: Change) => void>>>;
}

export type DefineTriggers<DM extends GenericDataModel> = (triggers: TriggersInput<DM>) => TriggersDefinition;

/** Untyped; `_generated/server` re-exports it typed with the app's DataModel. */
export const defineTriggers: DefineTriggers<AnyDataModel> = (input) => triggersOf(input);

export function isTriggersDefinition(x: unknown): x is TriggersDefinition {
  return typeof x === "object" && x !== null && (x as Record<symbol, unknown>)[TRIGGERS] === true;
}

/**
 * Normalizes `defineTriggers(...)` or a plain `{ table: fn | fn[] }` object (what `createEngine({ triggers })`
 * takes). Throws when an entry is not a function.
 */
export function triggersOf(input: unknown): TriggersDefinition {
  if (input === undefined || input === null) return { [TRIGGERS]: true, tables: {} };
  if (isTriggersDefinition(input)) return input;
  if (typeof input !== "object" || Array.isArray(input)) throw new EmberError("InvalidTrigger", "triggers must be defineTriggers({ table: (ctx, change) => ... })");
  const tables: Record<string, Array<(ctx: unknown, change: Change) => void>> = {};
  for (const [table, x] of Object.entries(input)) {
    if (x === undefined) continue;
    const list = Array.isArray(x) ? x : [x];
    for (const fn of list) {
      if (typeof fn !== "function") throw new EmberError("InvalidTrigger", `Trigger of ${table} must be a function (ctx, change) => void`);
    }
    if (list.length) tables[table] = [...list];
  }
  return { [TRIGGERS]: true, tables };
}

/**
 * The triggers of `input` by table, checked against the (composed) schema: only the app's own tables, never a
 * component's (`<install>$<table>`) or Ember's internals (`_*`). Throws `InvalidTrigger`. Used by `createEngine` and
 * by `ember codegen`.
 */
export function resolveTriggers(manifest: Pick<SchemaManifest, "tables">, input: unknown): Map<string, Array<(ctx: unknown, change: Change) => unknown>> {
  const out = new Map<string, Array<(ctx: unknown, change: Change) => unknown>>();
  const appTables = Object.keys(manifest.tables).filter((t) => !t.includes(TABLE_SEP));
  for (const [table, fns] of Object.entries(triggersOf(input).tables)) {
    if (!appTables.includes(table)) {
      const why = table.startsWith("_")
        ? "Ember's internal tables have no triggers"
        : manifest.tables[table]
          ? "component tables have no app triggers"
          : `known tables: ${appTables.join(", ") || "none"}`;
      throw new EmberError("InvalidTrigger", `defineTriggers: ${JSON.stringify(table)} is not a table of the app (${why})`);
    }
    if (fns.length) out.set(table, [...fns]);
  }
  return out;
}
