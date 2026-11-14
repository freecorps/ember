// Client cost of applying one change of a live list: a new document on top of a 50-document list (the oldest drops
// out), as the server sends it, straight into the client's frame handler (no network). Cases:
//   array/rowdiff  the list is the result (a top-level array of documents): per-row diff (feature "rowdiff")
//   page/full      the list inside `paginate()`'s `{page, isDone, continueCursor}`: the whole value
//   page/vdiff     the same, as a value diff (feature "vdiff", when this tree has it)
//   big/full       a 500-document `{page}` value sent whole (the cost of re-using unchanged subtrees on full values)
// Per case: µs per applied change (median of ROUNDS), bytes of the frame, and how many documents of the new value
// are new objects (changed identity: React re-renders their rows).
//
//   bun --conditions=@freecorps/ember-source run docs/spikes/local-bench/client-apply.ts [rounds]
import { EmberClient, unsafeRef } from "../../../packages/client/src/index.ts";
import { FakeEmberServer } from "../../../packages/client/src/testing.ts";
import * as values from "../../../packages/values/src/index.ts";

const ROUNDS = Number(process.argv[2] ?? 5);
const SHARD = "org:acme";
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
type Doc = { _id: string; _creationTime: number; n: number; body: string; author: { name: string; tags: string[] } };
const doc = (n: number): Doc => ({ _id: `id${n}`, _creationTime: 1_700_000_000_000 + n, n, body: "x".repeat(120), author: { name: `user${n % 7}`, tags: ["a", "b"] } });
const list = (top: number, len: number) => Array.from({ length: len }, (_, i) => doc(top - i));
const page = (top: number, len: number) => ({ page: list(top, len), isDone: false, continueCursor: `cursor${top - len + 1}` });

const v = values as unknown as Record<string, unknown>;
const encodeParts = v.encodeParts as ((x: unknown) => unknown) | undefined;
const valueDiffJson = v.valueDiffJson as ((a: unknown, ae: unknown, b: unknown, be: unknown) => string | null) | undefined;

async function setup(value: unknown, features: { vdiff: boolean }) {
  const server = new FakeEmberServer({ batch: true, queries: { "l:q": () => value }, mutations: {} });
  const client = new EmberClient({ url: "https://ember.test", WebSocket: server.WebSocket, fetch: server.fetch, connectivity: null, defaultShard: SHARD, heartbeat: false, ...(features.vdiff ? {} : {}) });
  let got = false;
  client.subscribe(unsafeRef("l:q"), {}, {}, (s) => s.status === "success" && (got = true));
  while (!got) await new Promise((r) => setTimeout(r, 1));
  const c = client as unknown as { conns: Map<string, { qids: Map<string, { confirmed: { value: unknown } | null }> }>; onFrame(conn: unknown, data: string): void };
  const conn = c.conns.get(SHARD)!;
  const [qid, sub] = [...conn.qids.entries()][0]!;
  return { client, conn, qid, sub, onFrame: (data: string) => c.onFrame(conn, data) };
}

const idsChanged = (prev: unknown, next: unknown): number => {
  const rows = (x: unknown) => (Array.isArray(x) ? x : (x as { page: Doc[] }).page) as Doc[];
  const old = new Map(rows(prev).map((d) => [d._id, d]));
  return rows(next).filter((d) => old.get(d._id) !== d).length;
};

type Case = { name: string; len: number; make: (top: number, len: number) => unknown; wire: (prev: unknown, next: unknown) => string | null };
const cases: Case[] = [
  {
    name: "array/rowdiff",
    len: 50,
    make: list,
    wire: (prev, next) => JSON.stringify({ diff: values.rowDiff(prev, next) }),
  },
  { name: "page/full", len: 50, make: page, wire: (_prev, next) => `{"value":${values.encodeJson(next)}}` },
  {
    name: "page/vdiff",
    len: 50,
    make: page,
    wire: (prev, next) => (encodeParts && valueDiffJson ? `{"vdiff":${valueDiffJson(prev, encodeParts(prev), next, encodeParts(next))}}` : null),
  },
  { name: "big/full", len: 500, make: page, wire: (_prev, next) => `{"value":${values.encodeJson(next)}}` },
];

for (const cs of cases) {
  if (cs.wire(cs.make(1000, cs.len), cs.make(1001, cs.len)) === null) {
    console.log(`client apply ${cs.name}: not in this tree`);
    continue;
  }
  const { client, sub, qid, onFrame } = await setup(cs.make(1000, cs.len), { vdiff: cs.name.includes("vdiff") });
  let top = 1000;
  let version = 10;
  let bytes = 0;
  let changed = 0;
  // One change: built against the value the client holds (excluded from the time), then handed to the client.
  const step = (): number => {
    const prev = sub.confirmed!.value;
    const change = cs.wire(prev, cs.make(++top, cs.len))!;
    const frame = `{"t":"patch","version":${++version},"changes":[{"qid":${JSON.stringify(qid)},${change.slice(1)}],"mids":[]}`;
    bytes = frame.length;
    const t0 = performance.now();
    onFrame(frame);
    const dt = performance.now() - t0;
    changed = idsChanged(prev, sub.confirmed!.value);
    return dt;
  };
  for (let i = 0; i < 30; i++) step();
  const xs: number[] = [];
  for (let r = 0; r < ROUNDS; r++) {
    const K = 100;
    let t = 0;
    for (let i = 0; i < K; i++) t += step();
    xs.push((t / K) * 1000);
  }
  console.log(`client apply ${cs.name}: ${median(xs).toFixed(1)} µs per change, ${bytes} B frame, ${changed} of ${cs.len} docs with a new identity (runs ${xs.map((x) => x.toFixed(1)).join(" ")})`);
  client.close();
}
process.exit(0);
