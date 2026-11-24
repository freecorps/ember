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
//
// Cost per call (EmberClient re-runs every pending update on each recompute): the replica holds the loaded documents
// by reference and the mutation gets a copy of a document only when it reads it (copy on write); the mutation runs
// first, and a query is run (before and after it) only when the rows it changed meet that query's read set
// (`localReadSetMatches`), remembered per loaded value from the last check that reproduced it.

import { stableStringify, unsafeRef, type OptimisticLocalStore, type OptimisticUpdate, type PendingMutationRecord } from "@freecorps/ember-client";
import {
  assertLocalMutation,
  documentsIn,
  localQueryRegistry,
  localReadSetMatches,
  overlayReader,
  runLocalMutation,
  runLocalQuery,
  flattenFunctions,
  type AnyRegisteredFunction,
  type Doc,
  type ForeignIds,
  type Identity,
  type LocalReader,
  type LocalSchema,
  type ReadSet,
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
  /** The shard's map of ids imported from Convex (`OfflineOptions.foreignIds`). */
  foreignIds?: ForeignIds;
}

const EMPTY: LocalReader = { scan: () => [], get: () => null };

/**
 * One clock and seed per pending mutation, kept for as long as it is pending. EmberClient re-runs every pending update
 * on each recompute (a new snapshot, another mutation) with the same pending record: keyed by it, a mutation's local
 * ids and `ctx.random`/`ctx.now` stay the same across re-runs (no remounted rows, stacked edits find the row), and two
 * calls never share a seed, even when the app passes the same args object twice (a form, a double submit).
 */
const runs = new WeakMap<object, { now: number; seed: number }>();
function runOf(mutation: PendingMutationRecord | undefined): { now: number; seed: number } {
  const fresh = () => ({ now: Date.now(), seed: Math.floor(Math.random() * 0x100000000) });
  if (!mutation) return fresh();
  let r = runs.get(mutation);
  if (!r) runs.set(mutation, (r = fresh()));
  return r;
}

/**
 * A loaded value → the read set of the last run that reproduced it, with its query and args: while that value is on
 * screen, a mutation whose changes miss the read set cannot change the query's result (the run over the same rows takes
 * the same path), so it is not run at all. Keyed by the value object (a new server or optimistic value is a new key).
 */
const reproduced = new WeakMap<object, { key: string; readSet: ReadSet }>();

/**
 * Reads of the replica for the mutation: the first read of a document gives a copy (kept, so reads agree), so what the
 * mutation reads — and may change in place — is never the document on screen. Queries read through it too: the copies
 * the mutation made (it may have changed them), the screen's documents otherwise (no copy: unchanged rows keep their
 * identity in the optimistic value).
 */
function copyOnRead(base: LocalReader): LocalReader & { copying: boolean } {
  const copies = new Map<object, Doc>();
  const out = (doc: Doc): Doc => {
    let c = copies.get(doc);
    if (!c && r.copying) copies.set(doc, (c = structuredClone(doc)));
    return c ?? doc;
  };
  const r: LocalReader & { copying: boolean } = {
    copying: true,
    get: (table, id) => {
      const d = base.get(table, id);
      return d ? out(d) : d;
    },
    scan: (...a) => base.scan(...a).map((row) => ({ ...row, doc: out(row.doc) })),
    ...(base.pluginQuery
      ? {
          pluginQuery: (...a: Parameters<NonNullable<LocalReader["pluginQuery"]>>) => {
            const res = base.pluginQuery!(...a);
            return { ...res, docs: res.docs.map(out) };
          },
        }
      : {}),
  };
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
    out[name] = (store: OptimisticLocalStore, args: unknown, mutation?: PendingMutationRecord) => runOptimistic(o, queries, name, fn, store, args, mutation);
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
  mutation: PendingMutationRecord | undefined,
): void {
  const m = o.schema.manifest;
  // What the screen shows now (earlier pending mutations included: the store returns the optimistic view).
  const loaded: Array<{ name: string; fn: AnyRegisteredFunction; args: Record<string, unknown>; value: unknown }> = [];
  for (const [qname, qfn] of queries) {
    for (const q of store.getAllQueries(unsafeRef<"query">(qname))) {
      if (q.value !== undefined) loaded.push({ name: qname, fn: qfn, args: (q.args ?? {}) as Record<string, unknown>, value: q.value });
    }
  }
  if (!loaded.length) return;
  // The screen's documents, by reference: the mutation reads copies (copyOnRead), queries only read.
  const replica = overlayReader(EMPTY, o.schema);
  for (const l of loaded) for (const { table, doc } of documentsIn(m, l.value, undefined, o.foreignIds)) replica.put(table, doc);
  const identity = o.identity?.() ?? null;
  const foreign = o.foreignIds ? { foreignIds: o.foreignIds } : {};
  const { now, seed } = runOf(mutation);
  const cow = copyOnRead(replica);
  const after = overlayReader(cow, o.schema);
  try {
    runLocalMutation(fn, args, { schema: o.schema, reader: after, identity, now, seed, ...foreign });
  } catch (e) {
    o.onError?.(name, e as Error);
    return;
  }
  cow.copying = false;
  const changes = after.changes();
  if (!changes.length) return;
  for (const l of loaded) {
    const key = `${l.name}\u0000${stableStringify(l.args)}`;
    const memo = typeof l.value === "object" && l.value !== null ? reproduced.get(l.value) : undefined;
    // The rows it changed are outside what this query read when it last reproduced this very value: nothing to do.
    if (memo && memo.key === key && !matches(o.schema, memo.readSet, changes)) continue;
    // Only queries the replica reproduces get an optimistic value.
    let readSet: ReadSet;
    try {
      const before = runLocalQuery(l.fn, l.args, { schema: o.schema, reader: replica, identity, now, ...foreign });
      if (!sameValue(before.value, l.value)) continue;
      readSet = before.readSet;
    } catch {
      continue;
    }
    if (typeof l.value === "object" && l.value !== null) reproduced.set(l.value, { key, readSet });
    if (!matches(o.schema, readSet, changes)) continue;
    let value: unknown;
    try {
      value = runLocalQuery(l.fn, l.args, { schema: o.schema, reader: after, identity, now, ...foreign }).value;
    } catch (e) {
      o.onError?.(l.name, e as Error);
      continue;
    }
    if (!sameValue(value, l.value)) store.setQuery(unsafeRef<"query">(l.name), l.args, value);
  }
}

/** `localReadSetMatches`, failing safe (a read set it cannot judge matches). */
function matches(schema: LocalSchema, readSet: ReadSet, changes: Parameters<typeof localReadSetMatches>[2]): boolean {
  try {
    return localReadSetMatches(schema, readSet, changes);
  } catch {
    return true;
  }
}
