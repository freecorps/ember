// Cost of re-running one list query after an insert: what a shard does once per distinct (fn, args, identity) that a
// commit touches (`Shard.reevaluate` + the row diff of `Shard.rerun`). The engine runs on node:sqlite through the
// same SqlDriver interface as DO SQLite, so this isolates the JS of the engine, the JSON and the diff.
//
//   bun --conditions=@freecorps/ember-source run docs/spikes/local-bench/rerun.ts [rounds]
//
// Prints, per `take(n)` and with / without a `returns` validator: query, stringify of the value, rowDiff and the
// diff's stringify, in µs per re-run (median of `rounds` rounds of 3000 re-runs each).
import { createEngine, defineSchema, defineTable, mutation, query, v } from "../../../packages/server/src/index.ts";
import { createNodeSqliteDriver } from "../../../packages/server/src/testing.ts";
import { encodeJson, encodeWithDocs, rowDiff, rowDiffJson } from "../../../packages/values/src/index.ts";

const ROUNDS = Number(process.argv[2] ?? 3);
// PATH_MODE=old: one encodeJson of the value, rowDiff (re-encodes the documents), encodeJson of the diff (the shard before
// the per-document JSON). Default: encodeWithDocs once per run, rowDiffJson from both runs' document JSON (the shard now).
const OLD = process.env.PATH_MODE === "old";
const N = Number(process.env.N ?? 3000);

const doc = v.object({ _id: v.id("messages"), _creationTime: v.number(), room: v.string(), author: v.string(), body: v.string(), sentAt: v.number() });
const schema = defineSchema({ tables: { messages: defineTable({ room: v.string(), author: v.string(), body: v.string(), sentAt: v.number() }).index("by_room", ["room"]) } });
const list = query({ args: { room: v.string(), n: v.number() }, handler: (ctx: any, a: any) => ctx.db.query("messages").withIndex("by_room", (q: any) => q.eq("room", a.room)).order("desc").take(a.n) });
const listTyped = query({ args: { room: v.string(), n: v.number() }, returns: v.array(doc), handler: (ctx: any, a: any) => ctx.db.query("messages").withIndex("by_room", (q: any) => q.eq("room", a.room)).order("desc").take(a.n) });
const send = mutation({ args: { room: v.string(), body: v.string() }, handler: (ctx: any, a: any) => ctx.db.insert("messages", { room: a.room, author: "users_01HZZZZZZZZZZZZZZZZZZZZZZZ", body: a.body, sentAt: ctx.now }) });
const engine = createEngine({ schema, functions: { "m:list": list, "m:listTyped": listTyped, "m:send": send }, driver: createNodeSqliteDriver() });
engine.migrate();
for (let i = 0; i < 500; i++) engine.runMutation("m:send", { room: "r1", body: "hello world, this is message number " + i });

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
let seq = 0;
for (const fn of ["m:list", "m:listTyped"]) {
  for (const n of [20, 50, 200]) {
    const args = { room: "r1", n };
    const per = { query: [] as number[], json: [] as number[], diff: [] as number[], diffJson: [] as number[], total: [] as number[] };
    for (let round = 0; round < ROUNDS; round++) {
      let prev = engine.runQuery(fn, args).value;
      let prevDocs = encodeWithDocs(prev).docs!;
      let tq = 0, tj = 0, td = 0, tdj = 0;
      for (let i = 0; i < N + 300; i++) {
        engine.runMutation("m:send", { room: "r1", body: "new message " + seq++ });
        const a = performance.now();
        const r = engine.runQuery(fn, args);
        const b = performance.now();
        let c: number, d: number;
        if (OLD) {
          const json = encodeJson(r.value);
          c = performance.now();
          const d0 = rowDiff(prev, r.value, json);
          d = performance.now();
          if (d0) encodeJson(d0);
        } else {
          const enc = encodeWithDocs(r.value);
          c = performance.now();
          rowDiffJson(prev as any, prevDocs, r.value as any, enc.docs!, enc.json);
          d = performance.now();
          prevDocs = enc.docs!;
        }
        const e = performance.now();
        prev = r.value;
        if (i >= 300) { tq += b - a; tj += c - b; td += d - c; tdj += e - d; }
      }
      const us = (x: number) => (x / N) * 1000;
      per.query.push(us(tq)); per.json.push(us(tj)); per.diff.push(us(td)); per.diffJson.push(us(tdj)); per.total.push(us(tq + tj + td + tdj));
    }
    const f = (xs: number[]) => median(xs).toFixed(1);
    console.log(`${fn.padEnd(12)} take(${n}): query ${f(per.query)} µs, stringify ${f(per.json)}, rowDiff ${f(per.diff)}, diff stringify ${f(per.diffJson)} → ${f(per.total)} µs per re-run (median of ${ROUNDS}; runs ${per.total.map((x) => x.toFixed(0)).join(" ")})`);
  }
}
