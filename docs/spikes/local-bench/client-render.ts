// Client cost of one change of a live list, including React: the patch handed to the client's frame handler and the
// render it causes (React 19 in happy-dom, `act` flushes it), for a list of memoized rows (`memo(Row)`): a row
// re-renders only when its document is a new object.
//
//   bun --conditions=@freecorps/ember-source run docs/spikes/local-bench/client-render.ts [rounds]
//
// Cases: a 500-row `{page}` value arriving whole (a resubscribe, a server or client without diffs) and a 50-row one
// as a top-level array with row diffs; one new row on top each time. Per case: µs per change (apply + render), how
// many rows rendered.
import { act, createElement, memo } from "../../../packages/react/node_modules/react/index.js";
import { EmberClient, unsafeRef } from "../../../packages/client/src/index.ts";
import { FakeEmberServer } from "../../../packages/client/src/testing.ts";
import { EmberProvider, useQuery } from "../../../packages/react/src/index.ts";
import * as values from "../../../packages/values/src/index.ts";

const { Window } = (await import("../../../packages/react/node_modules/happy-dom/lib/index.js")) as typeof import("happy-dom");
const win = new Window();
Object.assign(globalThis, { window: win, document: win.document, navigator: win.navigator, HTMLElement: win.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = (await import("../../../packages/react/node_modules/react-dom/client.js")) as typeof import("react-dom/client");

const ROUNDS = Number(process.argv[2] ?? 5);
const SHARD = "org:acme";
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
type Doc = { _id: string; n: number; body: string; author: { name: string; tags: string[] } };
const doc = (n: number): Doc => ({ _id: `id${n}`, n, body: "x".repeat(120), author: { name: `user${n % 7}`, tags: ["a", "b"] } });
const rows = (top: number, len: number) => Array.from({ length: len }, (_, i) => doc(top - i));

let rendered = 0;
const Row = memo(({ row }: { row: Doc }) => {
  rendered++;
  return createElement("li", null, row.body);
});

type Case = { name: string; len: number; make: (top: number) => unknown; rows: (v: unknown) => Doc[]; wire: (prev: unknown, next: unknown) => string };
const cases: Case[] = [
  { name: "page of 500, whole value", len: 500, make: (t) => ({ page: rows(t, 500), isDone: false, continueCursor: "c" }), rows: (v) => (v as { page: Doc[] }).page, wire: (_p, n) => `{"value":${values.encodeJson(n)}}` },
  { name: "array of 50, row diff", len: 50, make: (t) => rows(t, 50), rows: (v) => v as Doc[], wire: (p, n) => JSON.stringify({ diff: values.rowDiff(p, n) }) },
];

for (const cs of cases) {
  const server = new FakeEmberServer({ batch: true, queries: { "l:q": () => cs.make(1000) }, mutations: {} });
  const client = new EmberClient({ url: "https://ember.test", WebSocket: server.WebSocket, fetch: server.fetch, connectivity: null, defaultShard: SHARD, heartbeat: false });
  const ref = unsafeRef<"query">("l:q");
  function List() {
    const v = useQuery(ref, {});
    return v === undefined ? null : createElement("ul", null, cs.rows(v).map((r) => createElement(Row, { key: r._id, row: r })));
  }
  const root = createRoot(win.document.createElement("div") as unknown as Element);
  await act(async () => root.render(createElement(EmberProvider, { client }, createElement(List))));
  const c = client as unknown as { conns: Map<string, { qids: Map<string, { confirmed: { value: unknown } | null }> }>; onFrame(conn: unknown, data: string): void };
  while (!c.conns.get(SHARD)?.qids.size || ![...c.conns.get(SHARD)!.qids.values()][0]!.confirmed) await act(async () => new Promise((r) => setTimeout(r, 1)));
  const conn = c.conns.get(SHARD)!;
  const [qid, sub] = [...conn.qids.entries()][0]!;
  let top = 1000;
  let version = 10;
  let lastRendered = 0;
  const step = (): number => {
    const prev = sub.confirmed!.value;
    const change = cs.wire(prev, cs.make(++top));
    const frame = `{"t":"patch","version":${++version},"changes":[{"qid":${JSON.stringify(qid)},${change.slice(1)}],"mids":[]}`;
    rendered = 0;
    const t0 = performance.now();
    act(() => c.onFrame(conn, frame));
    const dt = performance.now() - t0;
    lastRendered = rendered;
    return dt;
  };
  for (let i = 0; i < 20; i++) step();
  const xs: number[] = [];
  for (let r = 0; r < ROUNDS; r++) {
    const K = 30;
    let t = 0;
    for (let i = 0; i < K; i++) t += step();
    xs.push((t / K) * 1000);
  }
  console.log(`client render ${cs.name}: ${median(xs).toFixed(0)} µs per change (apply + render), ${lastRendered} of ${cs.len} rows rendered (runs ${xs.map((x) => x.toFixed(0)).join(" ")})`);
  root.unmount();
  client.close();
}
process.exit(0);
