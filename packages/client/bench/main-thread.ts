// Main-thread cost of a server frame with N live subscriptions (PR 3B-2, not run in CI): one `patch` that changes one
// subscription, handed straight to the client's socket handler. Before = `client.ts` of the base commit (pass its
// path), after = this tree's.
//
//   git show origin/main:packages/client/src/client.ts | sed 's#"\./#"../src/#' > packages/client/bench/.client-before.ts
//   bun --conditions=@freecorps/ember-source packages/client/bench/main-thread.ts
import { existsSync } from "node:fs";
import { FakeEmberServer } from "../src/testing.ts";
import { EmberClient as After, unsafeRef } from "../src/index.ts";

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
type Ctor = typeof After;

async function run(Client: Ctor, n: number): Promise<number> {
  const server = new FakeEmberServer({ batch: true, queries: { "l:q": (db, { i }) => db.where("rows", "i", i) }, mutations: {} });
  const client = new Client({ url: "https://ember.test", WebSocket: server.WebSocket, fetch: server.fetch, connectivity: null, defaultShard: "s", heartbeat: false, httpFirst: false });
  let ready = 0;
  for (let i = 0; i < n; i++) {
    let first = true;
    client.subscribe(unsafeRef<"query">("l:q"), { i }, {}, (s) => {
      if (first && s.status === "success") (first = false), ready++;
    });
  }
  while (ready < n) await new Promise((r) => setTimeout(r, 1));
  const ws = server.open()[0]!;
  const sub = ws.sent.find((m) => m !== "ping" && (m as { t: string }).t === "sub") as { qid: string };
  const times: number[] = [];
  for (let v = 1000; v < 1200; v++) {
    const frame = JSON.stringify([{ t: "patch", version: v, changes: [{ qid: sub.qid, value: [{ _id: `r${v}`, _creationTime: v, i: 0 }] }], mids: [] }]);
    const t0 = performance.now();
    (ws as unknown as { onmessage: (e: { data: string }) => void }).onmessage({ data: frame });
    times.push(performance.now() - t0);
  }
  client.close();
  return median(times.slice(50));
}

const beforePath = new URL("./.client-before.ts", import.meta.url);
const Before = existsSync(beforePath) ? ((await import(beforePath.href)) as { EmberClient: Ctor }).EmberClient : null;
for (const n of [100, 1000, 5000]) {
  const after = await run(After, n);
  const before = Before ? await run(Before, n) : NaN;
  console.log(`patch frame with ${n} subscriptions: ${before.toFixed(3)} → ${after.toFixed(3)} ms`);
}
