// Harness: bundles a workload entry exactly like `ember deploy` bundles the Worker (WORKER_BUILD_OPTIONS in
// packages/cli/src/build.ts), runs it in a fresh workerd (miniflare) with Ember's compatibility date and flags, and
// samples the workerd process RSS/CPU from outside while one request runs.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import * as esbuild from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const exec = promisify(execFile);
export const HERE = dirname(fileURLToPath(import.meta.url));
export const TMP = join(HERE, ".tmp");
export const FIXTURES = join(TMP, "fixtures");

// Copy of WORKER_BUILD_OPTIONS (packages/cli/src/build.ts) minus the repo-only source condition.
export const EMBER_BUILD = {
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2023",
  conditions: ["workerd", "worker", "browser", "import", "module"],
  mainFields: ["browser", "module", "main"],
  external: ["cloudflare:*", "node:*"],
  logLevel: "silent",
};
// Same as packages/cli/src/config.ts DEFAULT_COMPATIBILITY_DATE and the deploy plan's default flags.
export const COMPAT = { compatibilityDate: "2026-10-01", compatibilityFlags: ["nodejs_compat"] };

const BUILTINS = builtinModules.filter((m) => !m.startsWith("_") && !m.startsWith("node:"));
const NODE_RE = new RegExp(`^(${BUILTINS.map((m) => m.replace(/[/]/g, "\\/")).join("|")}|node:.+)$`);
/**
 * Candidate fix for Ember's bundler, mirroring what wrangler does under nodejs_compat: every Node builtin, bare
 * ("fs") or prefixed ("node:fs"), becomes the external `node:` module; a `require()` of one becomes a tiny ESM shim
 * (an external `require()` in an ESM bundle would throw "Dynamic require of ... is not supported" at runtime).
 */
export const nodeBuiltins = {
  name: "node-builtins",
  setup(b) {
    b.onResolve({ filter: NODE_RE }, (args) => {
      const path = args.path.startsWith("node:") ? args.path : `node:${args.path}`;
      if (args.kind === "require-call") return { path, namespace: "node-require" };
      return { path, external: true };
    });
    b.onLoad({ filter: /.*/, namespace: "node-require" }, ({ path }) => ({ contents: `import m from ${JSON.stringify(path)}; module.exports = m;`, loader: "js" }));
  },
};

/** Experiment (not proposed): npm `readable-stream` (a userland copy of Node streams) → workerd's `node:stream`. */
const readableStreamToNode = {
  name: "readable-stream-to-node",
  setup(b) {
    b.onResolve({ filter: /^readable-stream$/ }, (args) => (args.kind === "require-call" ? { path: "node:stream", namespace: "node-require" } : { path: "node:stream", external: true }));
  },
};

export const VARIANTS = {
  ember: {},
  // platform "browser" (esbuild's default, the one wrangler uses) applies package.json "browser" maps.
  fixed: { platform: "browser", plugins: [nodeBuiltins] },
  // Only the builtins plugin, platform stays "neutral" (browser maps ignored).
  neutral: { plugins: [nodeBuiltins] },
  "fixed+rs": { platform: "browser", plugins: [readableStreamToNode, nodeBuiltins] },
};

export async function build(entry, { variant = "fixed" } = {}) {
  try {
    const r = await esbuild.build({ ...EMBER_BUILD, ...VARIANTS[variant], entryPoints: [join(HERE, "src", `${entry}.js`)], write: false, metafile: true });
    const code = r.outputFiles[0].text;
    return { ok: true, code, bytes: Buffer.byteLength(code), gzipBytes: gzipSync(code).length, warnings: r.warnings.length };
  } catch (e) {
    const errors = (e.errors ?? []).map((x) => x.text);
    return { ok: false, error: [...new Set(errors)].slice(0, 6).join(" | ") || String(e) };
  }
}

// Fake upstreams for the HTTP SDKs (miniflare's outboundService gets every fetch() the Worker makes).
export const outbound = { count: 0, hosts: {} };
async function fakeUpstream(req) {
  const url = new URL(req.url);
  outbound.count++;
  outbound.hosts[url.host] = (outbound.hosts[url.host] ?? 0) + 1;
  const json = (o, init) => new Response(JSON.stringify(o), { headers: { "content-type": "application/json" }, ...init });
  const sse = (lines) => new Response(lines.join(""), { headers: { "content-type": "text/event-stream" } });
  const body = req.method === "GET" || req.method === "HEAD" ? "" : await req.text();
  if (url.host === "api.stripe.com") return json({ id: "cus_fake", object: "customer", email: "a@example.test" });
  if (url.host.endsWith("r2.cloudflarestorage.com")) {
    if (req.method === "PUT") return new Response("", { headers: { etag: '"abc123"' } });
    return new Response("hello", { headers: { "content-type": "text/plain", etag: '"abc123"', "content-length": "5" } });
  }
  if (url.host === "api.openai.com") {
    if (JSON.parse(body).stream) return sse(['data: {"id":"c","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"he"}}]}\n\n', 'data: {"id":"c","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"llo"}}]}\n\n', "data: [DONE]\n\n"]);
    return json({ id: "c", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" }] });
  }
  if (url.host === "api.anthropic.com") {
    const msg = { id: "m", type: "message", role: "assistant", model: "claude-x", content: [{ type: "text", text: "hello" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };
    if (JSON.parse(body).stream) {
      const ev = (t, d) => `event: ${t}\ndata: ${JSON.stringify({ type: t, ...d })}\n\n`;
      return sse([ev("message_start", { message: { ...msg, content: [] } }), ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }), ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "hel" } }), ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "lo" } }), ev("content_block_stop", { index: 0 }), ev("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }), ev("message_stop", {})]);
    }
    return json(msg);
  }
  if (url.host === "fake.test") return new Response("pong");
  return new Response(`no fake for ${url.host}`, { status: 599 });
}

async function childWorkerd() {
  const { stdout } = await exec("ps", ["-A", "-o", "pid=,ppid=,command="]);
  const mine = stdout.split("\n").map((l) => l.trim().split(/\s+/)).filter((p) => p[1] === String(process.pid) && /workerd/.test(p[2] ?? ""));
  return mine.length ? Number(mine.at(-1)[0]) : null;
}

/** RSS (MB) and CPU seconds (user+sys) of a pid, or null when it is gone. */
export async function sample(pid) {
  try {
    const { stdout } = await exec("ps", ["-o", "rss=,time=", "-p", String(pid)]);
    const [rss, time] = stdout.trim().split(/\s+/);
    const [m, s] = time.split(":");
    return { rssMB: Number(rss) / 1024, cpuS: Number(m) * 60 + Number(s) };
  } catch {
    return null;
  }
}

/**
 * One measurement in a fresh workerd: startup, then one request with RSS sampled every ~25 ms.
 * `heapCapMB`: V8 --max-heap-size for the isolate (a local stand-in for the 128 MB isolate limit).
 */
export async function runInWorkerd(code, { workload, params = {}, fixture, heapCapMB = 128, timeoutMs = 600_000 } = {}) {
  mkdirSync(join(TMP, "r2"), { recursive: true });
  process.env.MINIFLARE_WORKERD_V8_FLAGS = heapCapMB ? `--max-heap-size=${heapCapMB}` : "";
  let stderr = "";
  const t0 = performance.now();
  const mf = new Miniflare(convertV4MiniflareOptions({
    defaultPersistRoot: join(TMP, "persist"),
    r2Persist: join(TMP, "r2"),
    handleStructuredLogs: (l) => (stderr += `${l.message ?? JSON.stringify(l)}\n`),
    modules: [{ type: "ESModule", path: join(HERE, "worker.mjs"), contents: code }],
    ...COMPAT,
    r2Buckets: ["FILES"],
    outboundService: fakeUpstream,
  }));
  const res = { workload, params, heapCapMB };
  try {
    await mf.ready;
    res.startupMs = Math.round(performance.now() - t0);
    if (fixture) {
      const bytes = readFileSync(join(FIXTURES, fixture));
      const put = await mf.dispatchFetch(`http://x/put?key=${encodeURIComponent(fixture)}`, { method: "PUT", body: bytes, headers: { "content-length": String(bytes.length) } });
      if (!put.ok) throw new Error(`fixture upload: ${put.status} ${await put.text()}`);
    }
    await (await mf.dispatchFetch("http://x/health")).text();
    const pid = await childWorkerd();
    const base = await sample(pid);
    res.baseRssMB = Math.round(base.rssMB);
    let peak = base.rssMB, running = true;
    const sampler = (async () => {
      while (running) {
        const s = await sample(pid);
        if (!s) break;
        peak = Math.max(peak, s.rssMB);
        await new Promise((r) => setTimeout(r, 25));
      }
    })();
    const t1 = performance.now();
    try {
      const r = await mf.dispatchFetch(`http://x/run?w=${workload}&p=${encodeURIComponent(JSON.stringify(params))}`, { signal: AbortSignal.timeout(timeoutMs) });
      Object.assign(res, await r.json());
    } catch (e) {
      res.ok = false;
      res.crashed = true;
      res.error = String(e?.message ?? e).slice(0, 300);
    }
    res.wallMs = Math.round(performance.now() - t1);
    running = false;
    await sampler;
    const after = await sample(pid);
    res.peakRssDeltaMB = Math.round(peak - base.rssMB);
    if (after) res.cpuS = +(after.cpuS - base.cpuS).toFixed(2);
  } catch (e) {
    res.ok = false;
    res.error = `startup: ${String(e?.message ?? e).slice(0, 300)}`;
  } finally {
    // V8 hitting --max-heap-size aborts workerd: a last Mark-Compact trace, "allocation failure", signal 6.
    const gc = stderr.match(/Mark-Compact ([\d.]+) \(([\d.]+)\) -> ([\d.]+)[^\n]*allocation failure/);
    if (gc || /Received signal #6|out of memory/i.test(stderr)) res.oom = gc ? `heap ${gc[1]} MB at abort` : "abort";
    if (!res.ok && stderr) res.stderr = stderr.split("\n").filter((l) => l.trim()).slice(-4).join(" ⏎ ").slice(0, 500);
    await mf.dispose().catch(() => {});
  }
  return res;
}

/** The same workload in plain Node (the "use node" reference), in a child process. */
export async function runInNode(entry, workload, params = {}) {
  try {
    const { stdout } = await exec(process.execPath, [join(HERE, "node-ref.mjs"), entry, workload, JSON.stringify(params)], { maxBuffer: 1 << 24, timeout: 900_000 });
    return JSON.parse(stdout.trim().split("\n").at(-1));
  } catch (e) {
    return { ok: false, error: String(e?.stderr || e?.message || e).slice(-400) };
  }
}

export const fixturePath = (name) => resolve(FIXTURES, name);
export const hasFixture = (name) => existsSync(fixturePath(name));
