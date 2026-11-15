// S1 (latency/protocol spike, 2026-11-14): who negotiates permessage-deflate on a hibernatable DO socket, and what it
// costs the shard to send. Plain workerd (no Miniflare entry worker): an entry Worker and a DO in *separate* services,
// so each hop can carry its own compatibility flags, plus the Miniflare path the runtime tests use.
//
//   node docs/spikes/local-bench/ws-compress.mjs                 # every variant, N=300, 100 broadcasts per size, 3 runs
//   N=300 REPS=100 RUNS=3 ONLY=A,B node docs/spikes/local-bench/ws-compress.mjs
//
// Server CPU = CPU time of the workerd process (ps), divided by sockets × broadcasts. The client is Node + `ws`
// (separate process, not counted) with perMessageDeflate on or off.
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(join(ROOT, "package.json"));
const WebSocket = require(join(ROOT, "node_modules/.bun/ws@8.21.0/node_modules/ws"));
const WORKERD = join(ROOT, "node_modules/.bun/@cloudflare+workerd-darwin-arm64@1.20261103.1/node_modules/@cloudflare/workerd-darwin-arm64/bin/workerd");
const TMP = join(ROOT, "packages/cli/.tmp/ws-compress");
mkdirSync(TMP, { recursive: true });

const N = Number(process.env.N ?? 300);
const REPS = Number(process.env.REPS ?? 100);
const RUNS = Number(process.env.RUNS ?? 3);
const SIZES = (process.env.SIZES ?? "350,8600").split(",").map(Number);
const OUT = process.env.OUT;
const say = (s) => {
  console.log(s);
  if (OUT) appendFileSync(OUT, s + "\n");
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

// ------------------------------------------------------------------ the two Workers

const ENTRY = `
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const stub = env.ROOM.get(env.ROOM.idFromName("room"));
    if (url.pathname === "/ws") {
      // Same as packages/runtime/src/worker.ts: copy the client's headers into a new request for the shard.
      const headers = new Headers(req.headers);
      if (url.searchParams.get("strip") === "1") headers.delete("sec-websocket-extensions");
      return stub.fetch(new Request(url, { headers }));
    }
    return stub.fetch(req);
  },
};`;

const DO = `
import { DurableObject } from "cloudflare:workers";
// Realistic patch text: a rowdiff-like change with an id, timestamps and a sentence (compresses like real JSON).
const words = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua".split(" ");
let seed = 1;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
function doc(i) {
  let body = "";
  for (let k = 0; k < 8; k++) body += words[Math.floor(rnd() * words.length)] + " ";
  return { _id: "k" + Math.floor(rnd() * 1e15).toString(36) + Math.floor(rnd() * 1e15).toString(36), _creationTime: 1763100000000 + Math.floor(rnd() * 1e9), n: i, body };
}
function frame(size, v) {
  const rows = [];
  let s = "";
  for (let i = 0; ; i++) {
    rows.push({ i, v: doc(i) });
    s = JSON.stringify({ t: "patch", version: v, changes: [{ qid: "q1", rows }], mids: [] });
    if (s.length >= size) return s;
  }
}
export class Room extends DurableObject {
  seen = [];
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      this.seen.push(req.headers.get("sec-websocket-extensions") ?? "");
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1], ["sub"]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (url.pathname === "/prepare") {
      // Frames built outside the measured window, so only the send loop is counted.
      const size = Number(url.searchParams.get("size")), reps = Number(url.searchParams.get("reps"));
      this.frames = [];
      for (let r = 0; r < reps; r++) this.frames.push(frame(size, r));
      return Response.json({ bytes: this.frames[0].length });
    }
    if (url.pathname === "/broadcast") {
      const socks = this.ctx.getWebSockets("sub");
      const t0 = Date.now();
      for (const f of this.frames) for (const ws of socks) ws.send(f);
      return Response.json({ sockets: socks.length, loopMs: Date.now() - t0 });
    }
    if (url.pathname === "/seen") return Response.json({ seen: this.seen, sockets: this.ctx.getWebSockets("sub").length });
    if (url.pathname === "/close") { for (const ws of this.ctx.getWebSockets()) ws.close(1000, "bye"); this.seen = []; return Response.json({ ok: true }); }
    return new Response("?", { status: 404 });
  }
  webSocketMessage() {}
  webSocketClose(ws, code) { try { ws.close(code, "bye"); } catch {} }
}`;

writeFileSync(join(TMP, "entry.js"), ENTRY);
writeFileSync(join(TMP, "do.js"), DO);

const DATE = process.env.COMPAT_DATE ?? "2026-10-01";
const capnpFlags = (f) => `[${f.map((x) => JSON.stringify(x)).join(", ")}]`;
function capnp(port, entryFlags, doFlags) {
  return `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [ (name = "entry", worker = .entryWorker), (name = "do", worker = .doWorker) ],
  sockets = [ (name = "http", address = "127.0.0.1:${port}", http = (), service = "entry") ],
);
const entryWorker :Workerd.Worker = (
  modules = [ (name = "entry.js", esModule = embed "entry.js") ],
  compatibilityDate = "${DATE}",
  compatibilityFlags = ${capnpFlags(entryFlags)},
  bindings = [ (name = "ROOM", durableObjectNamespace = (className = "Room", serviceName = "do")) ],
);
const doWorker :Workerd.Worker = (
  modules = [ (name = "do.js", esModule = embed "do.js") ],
  compatibilityDate = "${DATE}",
  compatibilityFlags = ${capnpFlags(doFlags)},
  durableObjectNamespaces = [ (className = "Room", uniqueKey = "ws-compress-room", enableSql = true) ],
  durableObjectStorage = (inMemory = void),
);
`;
}

// ------------------------------------------------------------------ servers

let nextPort = 18700;
async function startWorkerd(entryFlags, doFlags) {
  const port = nextPort++;
  const cfg = join(TMP, `config-${port}.capnp`);
  writeFileSync(cfg, capnp(port, entryFlags, doFlags));
  const proc = spawn(WORKERD, ["serve", cfg, "--experimental"], { cwd: TMP, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  proc.stdout.on("data", (d) => (log += d));
  proc.stderr.on("data", (d) => (log += d));
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/seen`);
      if (r.ok) return { url: `http://127.0.0.1:${port}`, pids: () => [proc.pid], stop: () => proc.kill("SIGKILL"), log: () => log };
    } catch {}
    await sleep(100);
  }
  proc.kill("SIGKILL");
  throw new Error("workerd did not start:\n" + log);
}

async function startMiniflare(flags) {
  const { Miniflare, convertV4MiniflareOptions } = await import(join(ROOT, "node_modules/.bun/miniflare@5.20261103.0-beta+664724dec0ad8d9e/node_modules/miniflare/dist/src/index.js"));
  // One Worker holding both (what `ember dev` does): entry + DO in the same script.
  const both = join(TMP, "both.js");
  writeFileSync(both, DO + "\n" + ENTRY);
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [{ name: "ws-compress", modules: [{ type: "ESModule", path: both }], compatibilityDate: DATE, compatibilityFlags: flags, durableObjects: { ROOM: { className: "Room", useSQLite: true } } }],
      host: "127.0.0.1",
      port: 0,
    }),
  );
  const url = (await mf.ready).toString().replace(/\/$/, "");
  const pids = () => {
    try {
      return execFileSync("pgrep", ["-P", String(process.pid)], { encoding: "utf8" }).trim().split("\n").filter(Boolean).map(Number);
    } catch {
      return [];
    }
  };
  return { url, pids, stop: () => mf.dispose(), log: () => "" };
}

function rssMB(pids) {
  if (!pids.length) return 0;
  const out = execFileSync("ps", ["-o", "rss=", "-p", pids.join(",")], { encoding: "utf8" });
  return Math.round(out.trim().split("\n").filter(Boolean).reduce((a, x) => a + Number(x), 0) / 1024);
}
const wire = (c) => c.socks.reduce((a, s) => a + (s._socket?.bytesRead ?? 0), 0);

function cpuSeconds(pids) {
  if (!pids.length) return 0;
  const out = execFileSync("ps", ["-o", "time=", "-p", pids.join(",")], { encoding: "utf8" });
  return out.trim().split("\n").filter(Boolean).reduce((a, t) => a + t.trim().split(":").map(Number).reduce((acc, x) => acc * 60 + x, 0), 0);
}

// ------------------------------------------------------------------ clients

async function openSockets(url, n, deflate, strip) {
  const socks = [];
  let ext = null;
  const counter = { n: 0, bytes: 0 };
  for (let i = 0; i < n; i += 50) {
    await Promise.all(
      Array.from({ length: Math.min(50, n - i) }, () =>
        new Promise((res, rej) => {
          const ws = new WebSocket(url.replace("http", "ws") + "/ws" + (strip ? "?strip=1" : ""), { perMessageDeflate: deflate });
          ws.on("upgrade", (r) => (ext ??= r.headers["sec-websocket-extensions"] ?? "(none)"));
          ws.on("open", () => res());
          ws.on("error", rej);
          ws.on("message", (d) => {
            counter.n++;
            counter.bytes += d.length;
          });
          socks.push(ws);
        }),
      ),
    );
  }
  return { socks, ext, counter, close: () => socks.forEach((s) => s.terminate()) };
}

async function measure(server, deflate, strip) {
  const rss0 = rssMB(server.pids());
  const c = await openSockets(server.url, N, deflate, strip);
  const seen = await (await fetch(server.url + "/seen")).json();
  const res = { ext101: c.ext, doSawOffer: seen.seen[0] || "(none)", sockets: seen.sockets };
  // Warm-up broadcast (JIT, deflate contexts), then RUNS measured rounds per size.
  await fetch(`${server.url}/prepare?size=350&reps=5`);
  await fetch(`${server.url}/broadcast`);
  while (c.counter.n < 5 * N) await sleep(5);
  res.rssMB = { before: rss0, afterOpenAndFirstSend: rssMB(server.pids()) };
  for (const size of SIZES) {
    const per = [];
    for (let r = 0; r < RUNS; r++) {
      await fetch(`${server.url}/prepare?size=${size}&reps=${REPS}`);
      const target = c.counter.n + REPS * N;
      const w0 = wire(c), b0 = c.counter.bytes;
      const cpu0 = cpuSeconds(server.pids());
      const t0 = performance.now();
      await fetch(`${server.url}/broadcast`);
      while (c.counter.n < target) await sleep(2);
      const wall = performance.now() - t0;
      const cpu = cpuSeconds(server.pids()) - cpu0;
      per.push({ us: (cpu * 1e6) / (REPS * N), wall, wire: (wire(c) - w0) / (REPS * N), payload: (c.counter.bytes - b0) / (REPS * N) });
    }
    res[`cpuUsPerSend@${size}`] = +median(per.map((p) => p.us)).toFixed(1);
    res[`runs@${size}`] = per.map((p) => +p.us.toFixed(1));
    res[`bytes@${size}`] = { payload: Math.round(per[0].payload), wire: Math.round(per[0].wire) };
    res[`wallMs@${size}`] = Math.round(median(per.map((p) => p.wall)));
  }
  c.close();
  await fetch(server.url + "/close");
  await sleep(300);
  return res;
}

// ------------------------------------------------------------------ variants

const NO = ["no_web_socket_compression"];
const VARIANTS = {
  A: { what: "workerd: flags default/default, header passed, client offers deflate", kind: "workerd", entry: [], do: [], deflate: true },
  B: { what: "workerd: flags default/default, header passed, client does not offer", kind: "workerd", entry: [], do: [], deflate: false },
  C: { what: "workerd: no_web_socket_compression on the entry Worker only", kind: "workerd", entry: NO, do: [], deflate: true },
  D: { what: "workerd: no_web_socket_compression on the DO's Worker only", kind: "workerd", entry: [], do: NO, deflate: true },
  E: { what: "workerd: flags default, entry Worker strips Sec-WebSocket-Extensions", kind: "workerd", entry: [], do: [], deflate: true, strip: true },
  F: { what: "workerd: no_web_socket_compression on both", kind: "workerd", entry: NO, do: NO, deflate: true },
  M1: { what: "Miniflare: one Worker (entry + DO), flags default, client offers", kind: "mf", flags: [], deflate: true },
  M2: { what: "Miniflare: same, no_web_socket_compression on the Worker", kind: "mf", flags: NO, deflate: true },
  M3: { what: "Miniflare: same, entry strips Sec-WebSocket-Extensions", kind: "mf", flags: [], deflate: true, strip: true },
};

const only = process.env.ONLY ? process.env.ONLY.split(",") : Object.keys(VARIANTS);
say(`# ws-compress  N=${N} REPS=${REPS} RUNS=${RUNS} sizes=${SIZES.join(",")} compat=${DATE}  ${new Date().toISOString()}`);
for (const k of only) {
  const v = VARIANTS[k];
  const server = v.kind === "workerd" ? await startWorkerd(v.entry, v.do) : await startMiniflare(v.flags);
  try {
    const r = await measure(server, v.deflate, !!v.strip);
    say(`${k}  ${v.what}\n    ${JSON.stringify(r)}`);
  } catch (e) {
    say(`${k}  ${v.what}\n    ERROR ${e.message}\n${server.log()}`);
  } finally {
    await server.stop();
  }
}
