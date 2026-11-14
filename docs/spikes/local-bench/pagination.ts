// Pagination under a live list: a client with K pages loaded (`usePaginatedQuery`, React rendered in happy-dom) of a
// list in desc order, and a new item entering at the top. The client talks to Miniflare through the latency proxy of
// first-data.ts (RTT 180 ms by default); the writer is another client on a direct connection.
//
//   bun --conditions=@freecorps/ember-source run docs/spikes/local-bench/pagination.ts
//   RTT=180 EDGE_MS=10 PAGE=20 KS=1,3,6 INSERTS=5 ROUNDS=3 OUT=evidence/pagination-x.txt LABEL=...
//
// Per new item: `sub`/`unsub` the client sent, full snapshots and `unchanged` answers it received, bytes received,
// time from the commit until the exposed list is complete again (the new item on top, then every loaded item in
// order, at least K × PAGE of them), that time in RTTs (≈ round trips in sequence after the patch's one-way trip),
// and the smallest length the exposed list had during the transition.
import { createElement } from "../../../packages/react/node_modules/react/index.js";
import { EmberClient, unsafeRef } from "../../../packages/client/src/index.ts";
import { EmberProvider, usePaginatedQuery, type PaginatedQueryReference } from "../../../packages/react/src/index.ts";
import { countingWebSocket, latencyProxy, median, sayTo, sleep, startProject } from "./lib.ts";

const { Window } = (await import("../../../packages/react/node_modules/happy-dom/lib/index.js")) as typeof import("happy-dom");
const win = new Window();
Object.assign(globalThis, { window: win, document: win.document, navigator: win.navigator, HTMLElement: win.HTMLElement });
const { createRoot } = (await import("../../../packages/react/node_modules/react-dom/client.js")) as typeof import("react-dom/client");

const RTT = Number(process.env.RTT ?? 180);
const EDGE = Number(process.env.EDGE_MS ?? 10);
const PAGE = Number(process.env.PAGE ?? 20);
const KS = (process.env.KS ?? "1,3,6").split(",").map(Number);
const INSERTS = Number(process.env.INSERTS ?? 5);
const ROUNDS = Number(process.env.ROUNDS ?? 3);
const say = sayTo(process.env.OUT);

const SCHEMA = `import { defineSchema, defineShard, defineTable, v } from "@freecorps/ember-server";
export default defineSchema({ tables: { items: defineTable({ n: v.number(), body: v.string() }).index("by_n", ["n"]) }, shards: { us: defineShard({ key: v.string() }) } });
`;
const BENCH = `import { paginationOptsValidator, v } from "@freecorps/ember-server";
import { mutation, query } from "./_generated/server";
export const put = mutation({ args: { n: v.number(), body: v.string() }, handler: (ctx, a) => ctx.db.insert("items", a) });
export const page = query({ args: { paginationOpts: paginationOptsValidator }, handler: (ctx, { paginationOpts }) => ctx.db.query("items").withIndex("by_n").order("desc").paginate(paginationOpts) });
`;

const { mf, origin, url: direct } = await startProject("pagination", { "schema.ts": SCHEMA, "bench.ts": BENCH });
const proxy = latencyProxy(origin, RTT, EDGE);
const pageRef = unsafeRef<"query">("bench:page") as unknown as PaginatedQueryReference;
const put = unsafeRef<"mutation">("bench:put");

type Item = { _id: string; n: number };
type Seen = { at: number; ns: number[]; status: string };
let seq = 0;

async function round(K: number) {
  const shard = `us:p${K}x${seq++}`;
  const writer = new EmberClient({ url: direct, connectivity: null, defaultShard: shard, heartbeat: false });
  const ns: number[] = [];
  for (let i = 0; i < 200; i++) {
    ns.push(i);
    await writer.mutation(put, { n: i, body: "x".repeat(300) });
  }
  const { WebSocket, traffic } = countingWebSocket();
  const client = new EmberClient({ url: proxy.url, WebSocket, connectivity: null, defaultShard: shard, heartbeat: false });
  const renders: Seen[] = [];
  let latest: ReturnType<typeof usePaginatedQuery<PaginatedQueryReference>> | null = null;
  function Feed() {
    const r = usePaginatedQuery(pageRef, {}, { initialNumItems: PAGE });
    latest = r;
    renders.push({ at: performance.now(), ns: (r.results as Item[]).map((x) => x.n), status: r.status });
    return null;
  }
  const root = createRoot(win.document.createElement("div") as unknown as Element);
  root.render(createElement(EmberProvider, { client }, createElement(Feed)));
  const until = async (pred: () => boolean, ms = 30_000) => {
    const t0 = performance.now();
    while (!pred()) {
      if (performance.now() - t0 > ms) throw new Error("timeout");
      await sleep(2);
    }
  };
  for (let k = 1; k <= K; k++) {
    await until(() => latest !== null && latest.status === "CanLoadMore" && latest.results.length >= k * PAGE);
    if (k < K) latest!.loadMore(PAGE);
  }
  await sleep(RTT * 3);
  // Loading the K pages (pinning included): what the client sent and received.
  const load = {
    loadSub: traffic.sent.get("sub") ?? 0,
    loadSnaps: traffic.received.get("snap") ?? 0,
    loadUnchanged: traffic.received.get("unchanged") ?? 0,
    loadBytes: traffic.bytesIn,
  };
  const out: Array<Record<string, number>> = [];
  for (let i = 0; i < INSERTS; i++) {
    traffic.reset();
    renders.length = 0;
    const n = 10_000 + i;
    ns.push(n);
    const want = [...ns].sort((a, b) => b - a);
    const t0 = performance.now();
    await writer.mutation(put, { n, body: "y".repeat(300) });
    const complete = (s: Seen) => s.ns.length >= K * PAGE && s.ns[0] === n && s.ns.every((x, j) => x === want[j]);
    await until(() => renders.length > 0 && complete(renders[renders.length - 1]!));
    // Settle: anything still in flight (a cascade, a late unsub) is counted too.
    await sleep(RTT * 3 + 200);
    const last = renders[renders.length - 1]!;
    if (!complete(last)) throw new Error("the list changed after it was complete");
    // First render of the final stretch where the list stayed complete.
    let j = renders.length - 1;
    while (j > 0 && complete(renders[j - 1]!)) j--;
    const ms = renders[j]!.at - t0;
    const before = K * PAGE;
    const minLen = Math.min(before, ...renders.map((r) => r.ns.length));
    out.push({
      sub: traffic.sent.get("sub") ?? 0,
      unsub: traffic.sent.get("unsub") ?? 0,
      snaps: traffic.received.get("snap") ?? 0,
      unchanged: traffic.received.get("unchanged") ?? 0,
      patches: traffic.received.get("patch") ?? 0,
      bytesIn: traffic.bytesIn,
      ms,
      rtts: ms / RTT,
      minLen,
      len: last.ns.length,
      ...load,
    });
    await sleep(100);
  }
  root.unmount();
  client.close();
  writer.close();
  const keys = Object.keys(out[0]!);
  return Object.fromEntries(keys.map((k) => [k, median(out.map((o) => o[k]!))]));
}

say(`# pagination RTT=${RTT} EDGE_MS=${EDGE} PAGE=${PAGE} INSERTS=${INSERTS} rounds=${ROUNDS} ${new Date().toISOString()} ${process.env.LABEL ?? ""}`);
for (const K of KS) {
  const runs: Array<Record<string, number>> = [];
  for (let r = 0; r < ROUNDS; r++) runs.push(await round(K));
  const keys = Object.keys(runs[0]!);
  const med = Object.fromEntries(keys.map((k) => [k, median(runs.map((x) => x[k]!))]));
  const fmt = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(2));
  say(`K=${K}: ${keys.map((k) => `${k}=${fmt(med[k]!)}`).join(" ")}  (ms runs: ${runs.map((x) => x.ms!.toFixed(0)).join(" ")})`);
}
proxy.stop();
await mf.dispose();
process.exit(0);
