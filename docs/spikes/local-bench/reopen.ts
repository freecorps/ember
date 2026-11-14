// Reopening with a value already on the client: bytes and time until the server-confirmed value, over the latency
// proxy of first-data.ts (RTT 180 ms). The list is 50 documents (~17 KB).
//
//   bun --conditions=@freecorps/ember-source run docs/spikes/local-bench/reopen.ts
//   RTT=180 EDGE_MS=10 N=7 OUT=evidence/reopen-x.txt LABEL=...
//
// Cases (each a fresh EmberClient, as an app start):
//   offline-reopen  `@freecorps/ember-offline` memory store kept from a previous session (the value is cached)
//   ssr-hydrate     the value was fetched on the server (`client.query`, HTTP) and is handed to the browser client
//   repeat-visit    a second visit with no offline engine (the client's own snapshot cache when it has one)
//   cold            a first visit (nothing cached): the reference
// Per case: time to the first value shown (any source), time to the confirmed value, bytes received for it
// (socket frames + HTTP bodies) and how the server answered (`snap` = full value, `unchanged` = resume).
import { defineSchema, defineShard, defineTable, v } from "../../../packages/server/src/index.ts";
import { EmberClient, unsafeRef } from "../../../packages/client/src/index.ts";
import { MemoryBackend, memoryStorage } from "../../../packages/offline/src/index.ts";
import { countingWebSocket, latencyProxy, median, sayTo, sleep, startProject } from "./lib.ts";

const RTT = Number(process.env.RTT ?? 180);
const EDGE = Number(process.env.EDGE_MS ?? 10);
const N = Number(process.env.N ?? 7);
const say = sayTo(process.env.OUT);

const SCHEMA = `import { defineSchema, defineShard, defineTable, v } from "@freecorps/ember-server";
export default defineSchema({ tables: { items: defineTable({ n: v.number(), body: v.string() }).index("by_n", ["n"]) }, shards: { us: defineShard({ key: v.string() }) } });
`;
const schema = defineSchema({ tables: { items: defineTable({ n: v.number(), body: v.string() }).index("by_n", ["n"]) }, shards: { us: defineShard({ key: v.string() }) } });
const BENCH = `import { v } from "@freecorps/ember-server";
import { mutation, query } from "./_generated/server";
export const put = mutation({ args: { n: v.number(), body: v.string() }, handler: (ctx, a) => ctx.db.insert("items", a) });
export const recent = query({ args: { limit: v.number() }, handler: (ctx, { limit }) => ctx.db.query("items").withIndex("by_n").order("desc").take(limit) });
`;

const { mf, origin, url: direct } = await startProject("reopen", { "schema.ts": SCHEMA, "bench.ts": BENCH });
const proxy = latencyProxy(origin, RTT, EDGE);
const SHARD = "us:reopen";
const recent = unsafeRef<"query">("bench:recent");
const ARGS = { limit: 50 };
const writer = new EmberClient({ url: direct, connectivity: null, defaultShard: SHARD, heartbeat: false });
for (let i = 0; i < 50; i++) await writer.mutation(unsafeRef<"mutation">("bench:put"), { n: i, body: "x".repeat(300) });

/** fetch that counts response bytes. */
function countingFetch() {
  const box = { bytes: 0 };
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await fetch(input, init);
    const text = await res.text();
    box.bytes += text.length;
    return new Response(text, { status: res.status, headers: res.headers });
  }) as typeof fetch;
  return { fetch: f, box };
}

type Opts = Record<string, unknown>;
/** One app start: until the confirmed value. */
async function open(extra: Opts, before?: (c: EmberClient) => void) {
  const { WebSocket, traffic } = countingWebSocket();
  const { fetch: f, box } = countingFetch();
  const t0 = performance.now();
  const client = new EmberClient({ url: proxy.url, WebSocket, fetch: f, connectivity: null, defaultShard: SHARD, heartbeat: false, ...extra } as never);
  before?.(client);
  let first = -1;
  const confirmed = await new Promise<number>((resolve) => {
    client.subscribe(recent, ARGS, undefined, (s) => {
      if (s.status !== "success") return;
      if (first < 0) first = performance.now() - t0;
      if (!s.source) resolve(performance.now() - t0);
    });
  });
  // Let the socket's answer land even when the value was confirmed over HTTP first.
  await sleep(RTT * 2 + 50);
  const out = {
    firstMs: first,
    confirmedMs: confirmed,
    bytesIn: traffic.bytesIn + box.bytes,
    snaps: traffic.received.get("snap") ?? 0,
    unchanged: traffic.received.get("unchanged") ?? 0,
    http: box.bytes ? 1 : 0,
  };
  await client.flushStorage();
  client.close();
  return out;
}

const cases: Record<string, () => Promise<Record<string, number>>> = {
  cold: () => open({}),
  "offline-reopen": async () => {
    const backend = new MemoryBackend(schema as never);
    await open({ storage: memoryStorage({ schema: schema as never, backend }) });
    await sleep(100);
    return open({ storage: memoryStorage({ schema: schema as never, backend }) });
  },
  "ssr-hydrate": async () => {
    // The server's render fetched the value over HTTP; the browser client starts from it.
    const ssr = new EmberClient({ url: proxy.url, connectivity: null, defaultShard: SHARD, heartbeat: false });
    const hydrate = ssr as unknown as { fetchForHydration?: (r: unknown, a: unknown) => Promise<unknown> };
    const snapshot = hydrate.fetchForHydration ? await hydrate.fetchForHydration(recent, ARGS) : await ssr.query(recent, ARGS);
    ssr.close();
    return open({}, (c) => {
      const h = c as unknown as { hydrate?: (s: unknown) => void };
      if (h.hydrate && hydrate.fetchForHydration) h.hydrate(snapshot);
    });
  },
  "repeat-visit": async () => {
    const kv = new Map<string, string>();
    const store = { getItem: (k: string) => kv.get(k) ?? null, setItem: (k: string, s: string) => void kv.set(k, s), removeItem: (k: string) => void kv.delete(k) };
    const mod = (await import("../../../packages/client/src/index.ts")) as unknown as Record<string, unknown>;
    const make = mod.keyValueSnapshotCache as ((kv: unknown) => unknown) | undefined;
    const extra = make ? { snapshotCache: make(store) } : {};
    await open(extra);
    await sleep(100);
    return open(make ? { snapshotCache: make(store) } : {});
  },
};

say(`# reopen RTT=${RTT} EDGE_MS=${EDGE} N=${N} ${new Date().toISOString()} ${process.env.LABEL ?? ""}`);
for (const [name, run] of Object.entries(cases)) {
  const xs: Array<Record<string, number>> = [];
  for (let i = 0; i < N; i++) {
    xs.push(await run());
    await sleep(50);
  }
  const keys = Object.keys(xs[0]!);
  const fmt = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(0));
  say(`${name}: ${keys.map((k) => `${k}=${fmt(median(xs.map((x) => x[k]!)))}`).join(" ")}  (confirmedMs runs: ${xs.map((x) => x.confirmedMs!.toFixed(0)).join(" ")})`);
}
writer.close();
proxy.stop();
await mf.dispose();
process.exit(0);
