// CPU profile of a shard under socket load, locally (Miniflare + V8 inspector): where a mutation's time goes in the
// Durable Object, without touching Cloudflare. Same schema and functions as convex-vs-ember.ts.
//
//   bun --conditions=@freecorps/ember-source run docs/spikes/remote/scripts/profile-shard.ts [incr|put|noop] [total] [window] [clients]
//
// Prints throughput and the top self-time functions; the raw profile goes to packages/cli/.tmp/ember-profile/*.cpuprofile
// (open it in Chrome DevTools → Performance).
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Miniflare } from "../../../../packages/cli/node_modules/miniflare/dist/src/index.js";
import { loadProject } from "../../../../packages/cli/src/config.ts";
import { init } from "../../../../packages/cli/src/init.ts";
import { buildWorker } from "../../../../packages/cli/src/build.ts";
import { miniflareOptions } from "../../../../packages/cli/src/local.ts";
import { codegen } from "../../../../packages/cli/src/codegen/index.ts";
import { EmberClient } from "../../../../packages/client/src/index.ts";

const ROOT = join(import.meta.dir, "../../../../packages/cli/.tmp/ember-profile");
const [kind = "incr", totalArg = "20000", windowArg = "100", clientsArg = "6"] = process.argv.slice(2);
const TOTAL = Number(totalArg);
const WINDOW = Number(windowArg);
const CLIENTS = Number(clientsArg);
const SUBS = Number(process.env.SUBS ?? 0);
const PROFILE = process.env.PROFILE !== "0";

const SCHEMA = `import { defineSchema, defineShard, defineTable, v } from "@freecorps/ember-server";
export default defineSchema({
  tables: {
    items: defineTable({ n: v.number(), sentAt: v.number(), body: v.string() }).index("by_n", ["n"]),
    counters: defineTable({ name: v.string(), value: v.number() }).index("by_name", ["name"]),
  },
  shards: { us: defineShard({ key: v.string() }) },
});
`;
const BENCH = `import { v } from "@freecorps/ember-server";
import { mutation, query } from "./_generated/server";
export const put = mutation({ args: { n: v.number(), sentAt: v.number(), body: v.string() }, handler: (ctx, a) => ctx.db.insert("items", a) });
export const noop = mutation({ args: {}, handler: () => null });
export const incr = mutation({
  args: { name: v.string() },
  handler: (ctx, { name }) => {
    const c = ctx.db.query("counters").withIndex("by_name", (q) => q.eq("name", name)).unique();
    if (!c) { ctx.db.insert("counters", { name, value: 1 }); return 1; }
    ctx.db.patch(c._id, { value: c.value + 1 });
    return c.value + 1;
  },
});
export const counter = query({ args: { name: v.string() }, handler: (ctx, { name }) => ctx.db.query("counters").withIndex("by_name", (q) => q.eq("name", name)).unique()?.value ?? 0 });
export const latest = query({ args: {}, handler: (ctx) => ctx.db.query("items").order("desc").first() });
`;

if (!existsSync(join(ROOT, "ember.json"))) {
  mkdirSync(ROOT, { recursive: true });
  init({ dir: ROOT, project: "profile", auth: false });
  for (const f of ["messages.ts", "crons.ts"]) rmSync(join(ROOT, "ember", f), { force: true });
}
writeFileSync(join(ROOT, "ember/schema.ts"), SCHEMA);
writeFileSync(join(ROOT, "ember/bench.ts"), BENCH);
const project = loadProject(ROOT);
await codegen(project);
const build = await buildWorker(project, { minify: false, keepNames: process.env.KEEP_NAMES === "1" });
const PORT = 9300 + Math.floor(Math.random() * 500);
const mf = new Miniflare({ ...miniflareOptions(project, build, { persist: false }), inspectorPort: PORT } as any);
const url = await mf.ready;

// ------------------------------------------------------------------ CDP
async function cdp() {
  const targets = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()) as Array<{ webSocketDebuggerUrl: string; title: string }>;
  const t = targets.find((x) => x.title.includes("profile")) ?? targets[0]!;
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  let id = 0;
  const waiting = new Map<number, (v: any) => void>();
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(String(e.data));
    if (m.id && waiting.has(m.id)) waiting.get(m.id)!(m.result);
  });
  const call = (method: string, params: any = {}) =>
    new Promise<any>((r) => {
      const i = ++id;
      waiting.set(i, r);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  return { call, close: () => ws.close() };
}

// ------------------------------------------------------------------ load (the real client: EmberClient, as convex-vs-ember.ts)
const shard = `us:profile-${Date.now()}`;
const argsOf = (i: number) => (kind === "put" ? { n: i, sentAt: Date.now(), body: "x".repeat(64) } : kind === "incr" ? { name: "hot" } : {});
const fn = `bench:${kind}`;
const frames = { in: 0, out: 0 };
const Counting = class extends WebSocket {
  constructor(u: string | URL, p?: string | string[]) {
    super(u, p);
    this.addEventListener("message", () => frames.in++);
  }
  override send(d: any) {
    frames.out++;
    super.send(d);
  }
};

async function load(total: number) {
  const cs = Array.from({ length: CLIENTS }, () => new EmberClient({ url: url.href, WebSocket: Counting as any, connectivity: null, idleTimeoutMs: 120_000 }));
  const watchers = Array.from({ length: SUBS }, () => new EmberClient({ url: url.href, connectivity: null }));
  await Promise.all(cs.map((c) => c.query("bench:latest" as any, {}, { shard, transport: "socket" } as any).catch(() => c.query("bench:latest" as any, {}, { shard }))));
  const offs = watchers.map((w) => w.subscribe((kind === "incr" ? "bench:counter" : "bench:latest") as any, kind === "incr" ? { name: "hot" } : {}, { shard }, () => {}));
  const keep = cs.map((c) => c.subscribe("bench:latest" as any, {}, { shard }, () => {}));
  await new Promise((r) => setTimeout(r, 300));
  let sent = 0;
  frames.in = frames.out = 0;
  const t0 = performance.now();
  await Promise.all(
    cs.map(async (c) => {
      const lane = async () => {
        while (sent < total) {
          const i = sent++;
          await c.mutation(fn as any, argsOf(i), { shard } as any);
        }
      };
      await Promise.all(Array.from({ length: WINDOW }, lane));
    }),
  );
  const ms = performance.now() - t0;
  const f = { ...frames };
  for (const o of [...offs, ...keep]) (o as any)();
  for (const c of [...cs, ...watchers]) c.close();
  return { ms, f };
}

await load(Math.min(2000, TOTAL)); // warm (JIT, tables)
const insp = PROFILE ? await cdp() : null;
if (insp) {
  await insp.call("Profiler.enable");
  await insp.call("Profiler.setSamplingInterval", { interval: 100 });
  await insp.call("Profiler.start");
}
const { ms, f } = await load(TOTAL);
console.log(`${fn} clients=${CLIENTS} window=${WINDOW} subs=${SUBS}: ${TOTAL} in ${ms.toFixed(0)} ms → ${Math.round((TOTAL / ms) * 1000)}/s, ${((ms * 1000) / TOTAL).toFixed(0)} µs/op; frames per mutation in ${(f.in / TOTAL).toFixed(3)} out ${(f.out / TOTAL).toFixed(3)}`);

if (insp) {
  const { profile } = await insp.call("Profiler.stop");
  writeFileSync(join(ROOT, `${kind}.cpuprofile`), JSON.stringify(profile));
  type Node = { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; hitCount?: number; children?: number[] };
  const nodes = new Map<number, Node>(profile.nodes.map((n: Node) => [n.id, n]));
  const self = new Map<string, number>();
  const counts = new Map<number, number>();
  for (const s of profile.samples as number[]) counts.set(s, (counts.get(s) ?? 0) + 1);
  let total = 0;
  for (const [nid, c] of counts) {
    const n = nodes.get(nid)!;
    const key = `${n.callFrame.functionName || "(anon)"} ${n.callFrame.url.split("/").pop()}:${n.callFrame.lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + c);
    total += c;
  }
  const idle = [...self].filter(([k]) => k.startsWith("(idle)")).reduce((a, [, c]) => a + c, 0);
  console.log(`samples ${total}, idle ${((idle / total) * 100).toFixed(1)}%`);
  for (const [k, c] of [...self].sort((a, b) => b[1] - a[1]).slice(0, Number(process.env.TOP ?? 40))) console.log(`${((c / total) * 100).toFixed(1).padStart(5)}%  ${k}`);
  // Inclusive time of the busiest named functions.
  const parent = new Map<number, number>();
  for (const n of nodes.values()) for (const ch of n.children ?? []) parent.set(ch, n.id);
  const incl = new Map<string, number>();
  for (const [nid, c] of counts) {
    const seen = new Set<string>();
    for (let cur: number | undefined = nid; cur !== undefined; cur = parent.get(cur)) {
      const n = nodes.get(cur)!;
      const key = n.callFrame.functionName || "(anon)";
      if (seen.has(key)) continue;
      seen.add(key);
      incl.set(key, (incl.get(key) ?? 0) + c);
    }
  }
  console.log("--- inclusive");
  for (const [k, c] of [...incl].filter(([k]) => !k.startsWith("(")).sort((a, b) => b[1] - a[1]).slice(0, 40)) console.log(`${((c / total) * 100).toFixed(1).padStart(5)}%  ${k}`);
  insp.close();
}
await mf.dispose();
process.exit(0);
