// Client cost of one batch frame from the server (feature "batch"): N patches for N subscriptions, with M optimistic
// mutations pending (their updates re-run on every recompute). This is what a reconnect (N snaps) or a busy shard sends
// to a client in one turn.
//
//   bun --conditions=@freecorps/ember-source run docs/spikes/local-bench/client-frame.ts [rounds]
//
// The frame goes straight into the client's frame handler (no network, no fake server work in the measure).
import { EmberClient, unsafeRef } from "../../../packages/client/src/index.ts";
import { FakeEmberServer } from "../../../packages/client/src/testing.ts";

const ROUNDS = Number(process.argv[2] ?? 3);
const SHARD = "org:acme";
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

async function setup(n: number, pendingMutations: number) {
  const server = new FakeEmberServer({
    batch: true,
    queries: { "items:list": (db, { k }) => db.where<{ v: number }>("items", "k", k).map((x) => x.v) },
    mutations: { "items:add": (db, { k, v }) => db.insert("items", { k, v }) },
  });
  const client = new EmberClient({ url: "https://ember.test", WebSocket: server.WebSocket, fetch: server.fetch, connectivity: null, defaultShard: SHARD, heartbeat: false });
  let ready = 0;
  for (let i = 0; i < n; i++) client.subscribe(unsafeRef("items:list"), { k: i }, {}, (s) => s.status === "success" && ready++);
  while (ready < n) await new Promise((r) => setTimeout(r, 1));
  const c = client as unknown as { conns: Map<string, { qids: Map<string, unknown>; gen: number }>; onFrame(conn: unknown, data: string): void; pending: unknown[] };
  const conn = c.conns.get(SHARD)!;
  // Pending mutations with optimistic updates (never answered: their socket frames are not delivered to the server).
  for (let i = 0; i < pendingMutations; i++) {
    (c.pending as Array<Record<string, unknown>>).push({
      record: { mid: `p${i}`, shard: SHARD, fn: "items:add", args: { k: i, v: -1 }, createdAt: 0, identity: null },
      update: (store: { updateQuery(ref: unknown, args: unknown, fn: (v: number[]) => number[]): void }, args: { k: number; v: number }) =>
        store.updateQuery(unsafeRef("items:list"), { k: args.k }, (v) => [...v, args.v]),
      authRetried: false,
      sentAuthSeq: 0,
      resolve: () => {},
      reject: () => {},
    });
  }
  const qids = [...conn.qids.keys()];
  let version = 1_000;
  const frame = () => JSON.stringify(qids.map((qid, i) => ({ t: "patch", version: ++version, changes: [{ qid, value: [version, i] }], mids: [] })));
  return { client, run: () => c.onFrame(conn, frame()) };
}

for (const [n, m] of [[50, 0], [200, 0], [200, 20], [500, 50]] as const) {
  const { client, run } = await setup(n, m);
  for (let i = 0; i < 20; i++) run(); // warm
  const xs: number[] = [];
  for (let r = 0; r < ROUNDS; r++) {
    const t0 = performance.now();
    const K = 50;
    for (let i = 0; i < K; i++) run();
    xs.push(((performance.now() - t0) / K) * 1000);
  }
  console.log(`client frame: ${n} patches, ${m} optimistic pending: ${median(xs).toFixed(0)} µs per frame (median of ${ROUNDS}; runs ${xs.map((x) => x.toFixed(0)).join(" ")})`);
  client.close();
}
process.exit(0);
