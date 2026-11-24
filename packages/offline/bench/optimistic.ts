// Cost of one recompute of a pending local-optimistic mutation (PR 3B-2, not run in CI): EmberClient re-runs every
// pending update on each recompute. 40 loaded `messages:list` queries of 50 rows; an edit of one row. Before = the
// base commit's mutations.ts (pass it as below), after = this tree's.
//
//   git show origin/main:packages/offline/src/mutations.ts > packages/offline/bench/.mutations-before.ts
//   bun --conditions=@freecorps/ember-source packages/offline/bench/optimistic.ts
import { existsSync } from "node:fs";
import type { Doc } from "@freecorps/ember-server";
import { engineServer, messages, schema } from "../test/app.ts";
import { localOptimisticUpdates as after } from "../src/mutations.ts";

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const CH = 40;
const srv = engineServer();
for (let i = 0; i < CH * 50; i++) srv.m("messages:send", { channel: `c${i % CH}`, body: `message ${i} ${"lorem ".repeat(10)}` });
const loaded = Array.from({ length: CH }, (_, i) => ({ args: { channel: `c${i}` }, value: srv.q("messages:list", { channel: `c${i}` }) as Doc[] }));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const store = { getQuery: () => undefined, setQuery: () => {}, updateQuery: () => {}, getAllQueries: () => loaded } as any;

function time(make: typeof after): number {
  const updates = make({ schema, mutations: { messages: { edit: messages.edit } }, queries: { messages: { list: messages.list } } });
  const target = loaded[7]!.value[3]!;
  const record = { mid: "m", shard: "s", fn: "messages:edit", args: { id: target._id, body: "edited" }, createdAt: 1 };
  const times: number[] = [];
  for (let r = 0; r < 60; r++) {
    const t0 = performance.now();
    updates["messages:edit"]!(store, record.args, record);
    times.push(performance.now() - t0);
  }
  return median(times.slice(10));
}

const beforePath = new URL("./.mutations-before.ts", import.meta.url);
const before = existsSync(beforePath) ? ((await import(beforePath.href)) as { localOptimisticUpdates: typeof after }).localOptimisticUpdates : null;
console.log(`recompute of one pending edit (${CH} loaded lists × 50 rows): ${before ? time(before).toFixed(2) : "?"} → ${time(after).toFixed(2)} ms`);
