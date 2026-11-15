// Probes of the Node APIs that "use node" files reach for, under nodejs_compat at Ember's compatibility date.
import { Buffer } from "node:buffer";
import * as crypto from "node:crypto";
import { EventEmitter, once } from "node:events";
import * as path from "node:path";
import { PassThrough, Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as util from "node:util";
import * as zlib from "node:zlib";
import { serve } from "./_serve.js";

async function probe(name, fn) {
  const t0 = performance.now();
  try {
    const v = await fn();
    return [name, { ok: true, ms: +(performance.now() - t0).toFixed(1), v: v === undefined ? undefined : JSON.stringify(v).slice(0, 160) }];
  } catch (e) {
    return [name, { ok: false, ms: +(performance.now() - t0).toFixed(1), error: String(e?.message ?? e).slice(0, 200) }];
  }
}

const MB = (n) => { const b = Buffer.alloc(n * 1024 * 1024); for (let i = 0; i < b.length; i += 4096) b[i] = i & 255; return b; };

export default serve({
  // Keeps `mb` MiB alive in ArrayBuffers (outside the V8 heap), then frees them: for a remote test of whether the
  // production isolate limit counts backing stores (locally the --max-heap-size cap does not).
  async alloc(env, { mb = 256 }) {
    const keep = [];
    for (let i = 0; i < mb; i++) keep.push(new Uint8Array(1 << 20).fill((i % 255) + 1)); // filled: pages committed
    await new Promise((r) => setTimeout(r, 300));
    return { heldMiB: keep.length, sum: keep.reduce((a, b) => a + b[0], 0) };
  },
  // Same amount as JS strings (inside the heap).
  async allocHeap(env, { mb = 256 }) {
    const keep = [];
    for (let i = 0; i < mb; i++) keep.push(new Array(131072).fill(i + 0.5)); // packed doubles: 1 MiB each, in the heap
    await new Promise((r) => setTimeout(r, 300));
    return { heldMiB: keep.length };
  },
  // Streaming inflate through node:zlib, the way unzipper feeds exceljs: `mb` MiB of CSV-like text, deflated, then
  // written to createInflateRaw in `chunk`-byte pieces.
  async inflateStream(env, { mb = 64, chunk = 16384 }) {
    const parts = [];
    for (let i = 0, n = 0; n < mb << 20; i += 1000) { let t = ""; for (let k = i; k < i + 1000; k++) t += `${k},Customer ${k},user${k}@example.test,${(k * 7919) % 100000}\n`; const b = Buffer.from(t); parts.push(b); n += b.length; }
    const raw = zlib.deflateRawSync(Buffer.concat(parts));
    parts.length = 0;
    const t0 = performance.now();
    const inf = zlib.createInflateRaw();
    let out = 0;
    inf.on("data", (c) => (out += c.length));
    const done = once(inf, "end");
    for (let i = 0; i < raw.length; i += chunk) if (!inf.write(raw.subarray(i, i + chunk))) await once(inf, "drain");
    inf.end();
    await done;
    return { inMiB: +(raw.length / 1048576).toFixed(1), outMiB: +(out / 1048576).toFixed(1), inflateMs: Math.round(performance.now() - t0) };
  },
  // Buffer patterns of stream parsers (unzipper's PullStream: concat the new chunk, slice what was consumed).
  async bufferOps(env, { mb = 8, n = 20000 }) {
    const big = Buffer.alloc(mb << 20, 7);
    let t0 = performance.now();
    let x = 0;
    for (let i = 0; i < n; i++) x += big.slice(i, big.length).length & 1;
    const sliceMs = performance.now() - t0;
    t0 = performance.now();
    for (let i = 0; i < n; i++) x += big.subarray(i).length & 1;
    const subarrayMs = performance.now() - t0;
    t0 = performance.now();
    let acc = Buffer.alloc(0);
    const chunk = Buffer.alloc(4096, 1);
    for (let i = 0; i < 2000; i++) { acc = Buffer.concat([acc, chunk]); if (acc.length > 65536) acc = acc.slice(32768); }
    const concatMs = performance.now() - t0;
    return { sliceMs: Math.round(sliceMs), subarrayMs: Math.round(subarrayMs), concatMs: Math.round(concatMs), x };
  },
  // Appending to a /tmp file (workerd's in-memory fs) in 64 KiB writes, as exceljs spools a worksheet.
  async tmpAppend(env, { mb = 32 }) {
    const fs = await import("node:fs");
    const chunk = Buffer.alloc(65536, 65);
    const t0 = performance.now();
    const ws = fs.createWriteStream("/tmp/spool.xml");
    for (let i = 0; i < mb * 16; i++) if (!ws.write(chunk)) await once(ws, "drain");
    ws.end();
    await once(ws, "finish");
    return { mb, writeMs: Math.round(performance.now() - t0), size: fs.statSync("/tmp/spool.xml").size };
  },
  async probes(env, { big = 16 }) {
    const data = MB(big);
    const text = data.toString("base64").slice(0, 4 * 1024 * 1024);
    const out = [];
    // crypto
    out.push(await probe(`crypto.createHash sha256 ${big} MB`, () => crypto.createHash("sha256").update(data).digest("hex").slice(0, 16)));
    out.push(await probe("crypto.createHmac sha256", () => crypto.createHmac("sha256", "k").update("msg").digest("base64")));
    out.push(await probe("crypto.randomUUID / randomBytes", () => [crypto.randomUUID().length, crypto.randomBytes(32).length]));
    out.push(await probe("crypto.timingSafeEqual", () => crypto.timingSafeEqual(Buffer.from("a"), Buffer.from("a"))));
    out.push(await probe("crypto aes-256-gcm, cipher.update(string) without encoding", () => crypto.createCipheriv("aes-256-gcm", crypto.randomBytes(32), crypto.randomBytes(12)).update("hello").length));
    out.push(await probe("crypto aes-256-gcm roundtrip (Buffer input)", () => {
      const key = crypto.randomBytes(32), iv = crypto.randomBytes(12);
      const c = crypto.createCipheriv("aes-256-gcm", key, iv); const enc = Buffer.concat([c.update(Buffer.from("hello")), c.final()]); const tag = c.getAuthTag();
      const d = crypto.createDecipheriv("aes-256-gcm", key, iv); d.setAuthTag(tag); return Buffer.concat([d.update(enc), d.final()]).toString();
    }));
    out.push(await probe("crypto.pbkdf2Sync 100k sha256", () => crypto.pbkdf2Sync("pw", "salt", 100_000, 32, "sha256").length));
    out.push(await probe("crypto.scryptSync N=16384", () => crypto.scryptSync("pw", "salt", 32, { N: 16384 }).length));
    out.push(await probe("crypto ed25519 keygen+sign+verify", () => {
      const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
      const sig = crypto.sign(null, Buffer.from("m"), privateKey); return crypto.verify(null, Buffer.from("m"), publicKey, sig);
    }));
    out.push(await probe("crypto RSA-2048 keygen", () => crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.asymmetricKeyType));
    out.push(await probe("crypto.createSign RSA-SHA256 (PEM)", () => {
      const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
      return crypto.createSign("RSA-SHA256").update("jwt").sign(privateKey, "base64url").length;
    }));
    out.push(await probe("crypto.webcrypto.subtle digest", async () => (await crypto.webcrypto.subtle.digest("SHA-256", new TextEncoder().encode("x"))).byteLength));
    // buffer
    out.push(await probe("Buffer base64/hex/utf8/readUInt32BE/concat", () => [Buffer.from(Buffer.from("olá").toString("base64"), "base64").toString(), Buffer.from("ff00", "hex").readUInt16BE(0), Buffer.concat([data.subarray(0, 4), data.subarray(0, 4)]).length]));
    // stream
    out.push(await probe("stream Readable.from + Transform + pipeline", async () => {
      let n = 0;
      await pipeline(Readable.from(["a", "b", "c"]), new Transform({ transform(c, _e, cb) { cb(null, c.toString().toUpperCase()); } }), new Writable({ write(c, _e, cb) { n += c.length; cb(); } }));
      return n;
    }));
    out.push(await probe("stream Readable.fromWeb / toWeb", async () => {
      const r = Readable.fromWeb(new Response("hello web").body); let s = ""; for await (const c of r) s += c;
      const w = Readable.toWeb(Readable.from([Buffer.from("x")])); return [s, (await new Response(w).text())];
    }));
    // zlib
    out.push(await probe(`zlib.gzipSync+gunzipSync ${big} MB`, () => zlib.gunzipSync(zlib.gzipSync(data)).length));
    out.push(await probe("zlib.createGzip stream 4 MB", async () => { let n = 0; const g = zlib.createGzip(); const done = (async () => { for await (const c of g) n += c.length; })(); g.end(Buffer.from(text)); await done; return n; }));
    out.push(await probe("zlib.deflateRawSync / inflateRawSync", () => zlib.inflateRawSync(zlib.deflateRawSync(Buffer.from(text))).length));
    out.push(await probe("zlib.brotliCompressSync 4 MB", () => zlib.brotliDecompressSync(zlib.brotliCompressSync(Buffer.from(text))).length));
    out.push(await probe("CompressionStream gzip (web)", async () => (await new Response(new Response(text).body.pipeThrough(new CompressionStream("gzip"))).arrayBuffer()).byteLength));
    // util / events / path
    out.push(await probe("util.promisify/inspect/format/types/TextDecoder", async () => [await util.promisify((cb) => cb(null, 7))(), util.inspect({ a: [1, { b: 2 }] }), util.format("%s=%d", "x", 1), util.types.isDate(new Date()), new util.TextDecoder().decode(new Uint8Array([104]))]));
    out.push(await probe("events EventEmitter + once", async () => { const e = new EventEmitter(); setTimeout(() => e.emit("x", 1)); return (await once(e, "x"))[0]; }));
    out.push(await probe("url / querystring / string_decoder / assert", async () => {
      const { fileURLToPath, URL: NodeURL } = await import("node:url"); const qs = await import("node:querystring"); const { StringDecoder } = await import("node:string_decoder"); const assert = (await import("node:assert")).default;
      assert.deepStrictEqual({ a: 1 }, { a: 1 });
      return [fileURLToPath("file:///tmp/a.csv"), new NodeURL("https://x.test/a?b=1").searchParams.get("b"), qs.stringify({ a: [1, 2] }), new StringDecoder("utf8").write(Buffer.from("olá"))];
    }));
    out.push(await probe("path.join/resolve/extname", () => [path.join("a", "..", "b", "c.xlsx"), path.extname("x.pdf"), path.posix.basename("/a/b.csv")]));
    out.push(await probe("node:async_hooks AsyncLocalStorage", async () => { const { AsyncLocalStorage } = await import("node:async_hooks"); const als = new AsyncLocalStorage(); return als.run(5, () => als.getStore()); }));
    out.push(await probe("node:timers/promises setTimeout", async () => { const t = await import("node:timers/promises"); await t.setTimeout(1); return true; }));
    out.push(await probe("process.env / nextTick / platform", async () => { await new Promise((r) => process.nextTick(r)); return [typeof process.env, process.platform, process.version]; }));
    out.push(await probe("Intl pt-BR currency + dates", () => [new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(1234.5), new Date(Date.UTC(2026, 0, 2)).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" })]));
    // fs (workerd virtual fs: /tmp writable per request, /bundle read-only)
    out.push(await probe("fs.writeFileSync/readFileSync /tmp", async () => { const fs = await import("node:fs"); fs.writeFileSync("/tmp/x.txt", "hi"); return fs.readFileSync("/tmp/x.txt", "utf8"); }));
    out.push(await probe("fs.promises + mkdtemp + 8 MB file in /tmp", async () => { const fs = await import("node:fs/promises"); const d = await fs.mkdtemp("/tmp/a-"); await fs.writeFile(`${d}/b.bin`, data.subarray(0, 8 << 20)); return (await fs.stat(`${d}/b.bin`)).size; }));
    out.push(await probe("fs.readdirSync('/')", async () => (await import("node:fs")).readdirSync("/")));
    out.push(await probe("fs.createReadStream /tmp", async () => { const fs = await import("node:fs"); fs.writeFileSync("/tmp/s.txt", "stream me"); let s = ""; for await (const c of fs.createReadStream("/tmp/s.txt")) s += c; return s; }));
    out.push(await probe("os.tmpdir/cpus/totalmem", async () => { const os = await import("node:os"); return [os.tmpdir(), os.cpus().length, os.totalmem?.()]; }));
    // network-ish Node APIs (outbound goes to the harness fake)
    out.push(await probe("node:http request (client)", async () => {
      const http = await import("node:http");
      return await new Promise((res, rej) => { http.get("http://fake.test/ping", (r) => { let s = ""; r.on("data", (c) => (s += c)); r.on("end", () => res([r.statusCode, s])); }).on("error", rej); });
    }));
    out.push(await probe("node:https request (client)", async () => {
      const https = await import("node:https");
      return await new Promise((res, rej) => { https.get("https://fake.test/ping", (r) => { let s = ""; r.on("data", (c) => (s += c)); r.on("end", () => res([r.statusCode, s])); }).on("error", rej); });
    }));
    out.push(await probe("node:http createServer", async () => { const http = await import("node:http"); return typeof http.createServer(() => {}).listen; }));
    out.push(await probe("node:net connect (raw TCP to an unresolvable test host)", async () => { const net = await import("node:net"); const s = net.connect(80, "fake.test"); await once(s, "connect"); s.destroy(); return true; }));
    out.push(await probe("node:dns lookup (DNS over HTTPS via fetch; the fake upstream answers 599)", async () => { const dns = await import("node:dns/promises"); return await dns.lookup("example.com"); }));
    // things that cannot exist in an isolate
    out.push(await probe("node:child_process spawn", async () => (await import("node:child_process")).spawn("ls").pid));
    out.push(await probe("node:worker_threads Worker", async () => { const wt = await import("node:worker_threads"); return typeof new wt.Worker("data:,"); }));
    out.push(await probe("node:vm runInNewContext", async () => (await import("node:vm")).runInNewContext("1+1")));
    out.push(await probe("node:v8 getHeapStatistics", async () => (await import("node:v8")).getHeapStatistics().heap_size_limit));
    out.push(await probe("process.memoryUsage()", () => process.memoryUsage()));
    out.push(await probe("eval('1+1')", () => eval("1+1")));
    out.push(await probe("new Function", () => new Function("a", "return a+1")(1)));
    out.push(await probe("WebAssembly.compile(bytes) at runtime", async () => { const wasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]); return (await WebAssembly.compile(wasm)) instanceof WebAssembly.Module; }));
    out.push(await probe("SharedArrayBuffer + Atomics", () => { const s = new SharedArrayBuffer(8); return Atomics.add(new Int32Array(s), 0, 1); }));
    out.push(await probe("structuredClone / Blob / FormData / DecompressionStream", () => [typeof structuredClone({ a: 1 }), new Blob(["x"]).size, typeof FormData, typeof DecompressionStream]));
    return Object.fromEntries(out);
  },
});
