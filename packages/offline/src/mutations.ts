// Optimistic updates without writing one per query (PLAN §10, Brigade RFC 0016 gap G5): the client runs the same
// `mutation(...)` the server registers over the documents its loaded queries returned, then runs the registered
// local queries again over the result. Every subscription whose value changes shows it until the server answers.
//
//   import * as messages from "../ember/messages";
//   const client = new EmberClient({
//     url,
//     optimisticUpdates: localOptimisticUpdates({ schema, mutations: { messages }, queries: { messages } }),
//   });
//
// What it relies on, per call:
// - The replica is the documents in the loaded values of the registered queries (`documentsIn`), so a mutation sees
//   exactly what the screen shows. A mutation that reads a row nobody loaded behaves as if the row did not exist; one
//   that throws (a rule, `OfflineUnsupported`) changes nothing here, and the server's answer stands.
// - A query only gets an optimistic value when running it over that replica, before the mutation, gives back the
//   value the server confirmed (deep equal). Projections, counts and queries over rows not on screen fail that check
//   and keep their confirmed value, instead of showing something wrong.
// - Inserted documents get local ids; the server's confirmed value (its own ids) replaces them.

import type { OptimisticLocalStore, OptimisticUpdate } from "@freecorps/ember-client";
import {
  assertLocalMutation,
  documentsIn,
  localQueryRegistry,
  overlayReader,
  runLocalMutation,
  runLocalQuery,
  flattenFunctions,
  type AnyRegisteredFunction,
  type Identity,
  type LocalReader,
  type LocalSchema,
} from "@freecorps/ember-server";
import { compareValues } from "@freecorps/ember-values";

export interface LocalOptimisticOptions {
  schema: LocalSchema;
  /** The app's mutation modules (`{ messages }` or `{ "messages:send": send }`): public `mutation(...)` definitions. */
  mutations: unknown;
  /** The queries whose loaded values are the replica and get optimistic values (public `query(...)` definitions). */
  queries: unknown;
  /** Who the mutation runs as locally (decoded from the client's token; not verified). */
  identity?: () => Identity | null;
  /** Errors from running a mutation or query locally (default: ignored; the server's answer stands). */
  onError?: (fn: string, e: Error) => void;
}

const EMPTY: LocalReader = { scan: () => [], get: () => null };

/**
 * One clock and seed per pending mutation, kept for as long as it is pending. EmberClient re-runs every pending update
 * on each recompute (a new snapshot, another mutation), with the same args object: keyed by it, a mutation's local
 * ids and `ctx.random`/`ctx.now` stay the same across re-runs (no remounted rows, stacked edits find the row), and two
 * mutations never share a seed (no colliding ids even in the same millisecond).
 */
const runs = new WeakMap<object, { now: number; seed: number }>();
function runOf(args: unknown): { now: number; seed: number } {
  const fresh = () => ({ now: Date.now(), seed: Math.floor(Math.random() * 0x100000000) });
  if (typeof args !== "object" || args === null) return fresh();
  let r = runs.get(args);
  if (!r) runs.set(args, (r = fresh()));
  return r;
}

function sameValue(a: unknown, b: unknown): boolean {
  try {
    return compareValues(a, b) === 0;
  } catch {
    return false;
  }
}

/** One optimistic update per registered mutation, keyed by its name (`"messages:send"`), for `EmberClient`. */
export function localOptimisticUpdates(o: LocalOptimisticOptions): Record<string, OptimisticUpdate> {
  const queries = localQueryRegistry(o.queries);
  const mutations = new Map<string, AnyRegisteredFunction>();
  for (const [name, fn] of flattenFunctions(o.mutations ?? {})) {
    assertLocalMutation(name, fn);
    mutations.set(name, fn as AnyRegisteredFunction);
  }
  const out: Record<string, OptimisticUpdate> = {};
  for (const [name, fn] of mutations) {
    out[name] = (store: OptimisticLocalStore, args: unknown) => runOptimistic(o, queries, name, fn, store, args);
  }
  return out;
}

function runOptimistic(
  o: LocalOptimisticOptions,
  queries: Map<string, AnyRegisteredFunction>,
  name: string,
  fn: AnyRegisteredFunction,
  store: OptimisticLocalStore,
  args: unknown,
): void {
  const m = o.schema.manifest;
  // What the screen shows now (earlier pending mutations included: the store returns the optimistic view).
  const loaded: Array<{ name: string; fn: AnyRegisteredFunction; args: Record<string, unknown>; value: unknown }> = [];
  for (const [qname, qfn] of queries) {
    for (const q of store.getAllQueries(qname)) {
      if (q.value !== undefined) loaded.push({ name: qname, fn: qfn, args: (q.args ?? {}) as Record<string, unknown>, value: q.value });
    }
  }
  if (!loaded.length) return;
  const replica = overlayReader(EMPTY, o.schema);
  for (const l of loaded) for (const { table, doc } of documentsIn(m, l.value)) replica.put(table, doc);
  const identity = o.identity?.() ?? null;
  const { now, seed } = runOf(args);
  // Only queries the replica reproduces get an optimistic value.
  const reproducible = loaded.filter((l) => {
    try {
      return sameValue(runLocalQuery(l.fn, l.args, { schema: o.schema, reader: replica, identity, now }).value, l.value);
    } catch {
      return false;
    }
  });
  if (!reproducible.length) return;
  const after = overlayReader(replica, o.schema);
  try {
    runLocalMutation(fn, args, { schema: o.schema, reader: after, identity, now, seed });
  } catch (e) {
    o.onError?.(name, e as Error);
    return;
  }
  if (!after.changes().length) return;
  for (const l of reproducible) {
    let value: unknown;
    try {
      value = runLocalQuery(l.fn, l.args, { schema: o.schema, reader: after, identity, now }).value;
    } catch (e) {
      o.onError?.(l.name, e as Error);
      continue;
    }
    if (!sameValue(value, l.value)) store.setQuery(l.name, l.args as never, value as never);
  }
}
