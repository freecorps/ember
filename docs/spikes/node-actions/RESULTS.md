# Heavy Node actions in workerd (PLAN §22 L13): results

Date: 2026-11-15. Everything ran **locally**: miniflare `5.20261103.0-beta` / workerd `1.20261103.1` (the versions the repo's `@cloudflare/vitest-plugin@1.5.1` uses), esbuild `0.28.2`, Node `24.22.1`, macOS arm64 (8 cores, 16 GB). Nothing was deployed. Each Worker was bundled **the way `ember deploy` bundles** (the harness imports `WORKER_BUILD_OPTIONS` and `nodeBuiltinsPlugin` from `packages/cli/src/worker-bundle.ts`, which `build.ts` re-exports; see "Which numbers use the exact shipped options" below) and ran with Ember's defaults: `compatibility_date` `2026-10-01`, `compatibility_flags: ["nodejs_compat"]`.

Legend (as in PLAN.md): ✅ tested locally in workerd · 📄 from Cloudflare's docs · 🌐 needs a remote test.

## TL;DR

| Question | Answer |
|---|---|
| Do typical `"use node"` libraries import under Ember's bundler? | **Not all, before this change ✅.** Ember bundled with `platform: "neutral"` and only `node:*` external, so any package that imports a bare builtin (`require("stream")`) failed the build: **jszip** (via `readable-stream`) and **exceljs' streaming API**. `@aws-sdk/client-s3` built but threw at construction (`emitWarningIfUnsupportedVersion is not a function`), because `neutral` ignores package.json `browser` maps while still applying the `browser` export condition. **Fixed in this PR**: the Worker bundle now resolves like wrangler (platform `browser` + Node builtins → `node:` imports, `require()` included), plus npm `readable-stream` → `node:stream`. After the fix every library in this spike builds and runs. |
| Node APIs | `node:crypto`, `buffer`, `stream`, `zlib`, `util`, `events`, `path`, `async_hooks`, `fs` (virtual: `/tmp` writable, `/bundle` read-only) and the `http`/`https` **clients** work ✅. No `child_process`, `worker_threads`, `vm`, `eval`/`new Function` or runtime `WebAssembly.compile` ✅. |
| Memory | The 128 MB is **per isolate, shared by concurrent requests** 📄. Locally the V8 heap was capped at 128 MB (`--max-heap-size`), which makes workerd abort exactly where an isolate would run out ✅. **In-memory XLSX reads fit about 25k (exceljs, OOM at 30k) to 45k (SheetJS 0.20 `dense`, OOM at 50k) rows × 20 columns; in-memory writes only 10k (exceljs, OOM at 15k) to 25k (SheetJS, OOM at 30k) ✅.** PDF generation fits ~2,000 pages, text extraction ~4,500 pages ✅. |
| Streaming | **CSV streams in flat memory**: papaparse with `step` + `pause`/`resume` over the R2 body, batches to `runMutation`: **1M rows (200 MB) in 4.2 s, +45 MB** ✅. **XLSX streams too, once the worksheets are moved to the end of the zip** (exceljs' streaming reader + `src/xlsx-sheets-last.js`, no recompression): **200k rows in 3.9 s, +154 MB**, OOM ~390k ✅. Without the reorder, exceljs spools the sheet to `/tmp`, whose appends are quadratic in workerd: 100k rows = 32 s CPU, +4 GB ✅. exceljs' streaming writer is flat too: 100k rows in 1.1 s, +78 MB with the shipped options (500k rows in 6 s, +85 MB measured with `neutral`) ✅. |
| CPU | 30 s per invocation by default, 5 min max (`limits.cpu_ms`) 📄; Ember's deploy does not set it. Locally, CPU-bound work ran at ~0.8–1.3x of Node's time, except where noted (jszip, exceljs' spooling reader). |
| HTTP SDKs | `stripe` (incl. webhook signature check), `openai`, `@anthropic-ai/sdk` (incl. streaming) work as is; `@aws-sdk/client-s3` + presigner work after the bundler fix ✅. |
| What does not fit | XLSX beyond ~200–350k rows of this shape, anything that needs native code or a subprocess (LibreOffice, ImageMagick/sharp, ffmpeg, Python), CPU beyond 5 min, and possibly in-memory archives of hundreds of MB (if production counts `ArrayBuffer`s, 🌐). Design note for `action({ runtime: "container" })` in PLAN §22 L13, as future work. |

## How it was measured

- `src/*.js`: one plain Worker per library (`_serve.js`: `GET /run?w=<workload>&p=<json>`), inputs in an R2 bucket (`env.FILES`, what `ctx.storage.get` reads), the same deterministic 20-column rows (`_data.js`: 10 text, 1 date, 9 numbers) everywhere.
- `fixtures.mjs`: inputs generated in Node, once (XLSX written by exceljs with shared strings, as Excel does; CSV; PDF by pdf-lib; ZIP of ~10 KB CSV files).
- `harness.mjs`: bundles an entry with Ember's esbuild options (imported from the product, not copied: variant `fixed` = the shipped `WORKER_BUILD_OPTIONS` minus the repo-only source condition, `ember` = the bundler before this PR (`neutral`, no plugin, no define), `neutral` = the shipped options with platform `neutral`), starts a **fresh workerd per measurement** with `MINIFLARE_WORKERD_V8_FLAGS=--max-heap-size=128`, and samples the workerd process RSS/CPU with `ps` every ~25 ms while one request runs. An OOM is V8 aborting workerd after a last `Mark-Compact ~115 MB … allocation failure`.
- `run.mjs`: the matrix, one run at a time; sizes go up until the first OOM, then 3 bisection steps on the row count; the same sizes in Node (no cap) through `node-ref.mjs`. Raw rows: `evidence/results.jsonl`; console output: `evidence/run-main.txt` (matrix), `run-rerun.txt` (papaparse and unzip after the big-fixture upload fix), `run-sheets-last.txt`; tables below: `node report.mjs` (`evidence/tables.md`).
- `one.mjs`: one workload by hand (`node one.mjs pdfjs text '{"key":"pages-10.pdf"}' --fixture pages-10.pdf [--ember|--neutral] [--cap 0] [--node]`).

What the numbers mean:
- **"workerd ✅/❌ OOM"** is the hard verdict: the V8 heap of the isolate capped at 128 MB. In production the 128 MB also covers WebAssembly memory 📄; whether `ArrayBuffer` backing stores count is not documented (🌐). Two requests running in the same isolate share it 📄, so treat the thresholds as upper bounds and keep a margin (half is a sane budget for an action that can run concurrently).
- **"RSS growth"** is the whole workerd process (heap, ArrayBuffers, zlib buffers, R2 plumbing, allocator slack): a rough signal, not the isolate's accounting. Node's numbers include its lazy heap growth (Node has no cap), so compare Node with Node.
- **Wall** is measured outside workerd; **CPU** is the process' user+system time (includes V8's GC threads). In production the clock only advances on I/O 📄, so measure CPU-bound actions with Workers Logs, not `Date.now()`.
- `process.memoryUsage()` and `v8.getHeapStatistics()` return zeros in workerd ✅: an action cannot watch its own memory.

## Run it

```bash
cd docs/spikes/node-actions
bun install                       # own package.json; not a root workspace, not in `bun run check`
node run.mjs --smoke              # first size of every case (~1 min)
node run.mjs --only papaparse     # one case; node run.mjs = full matrix (~30 min, sequential)
node report.mjs                   # markdown tables from evidence/results.jsonl
node probe-builds.mjs exceljs-stream zip sdk-s3   # Ember's old bundler vs the shipped one vs shipped+neutral
node rerun-shipped.mjs                            # exceljs-stream points re-measured with the shipped options
node reorder.mjs rows-100000.xlsx                 # a fixture with the worksheets last (rows-100000.ss-first.xlsx)
```
Large fixtures go to `.tmp/` (git-ignored). The harness imports `packages/cli/src/worker-bundle.ts` directly, so it needs Node ≥ 22.18 (TypeScript type stripping) and runs from this checkout.

### Which numbers use the exact shipped options

The first runs bundled with a hand copy of the options that lacked two things the product ships: the `process.env.NODE_ENV` define and the `readable-stream` alias. The harness now imports the product's options, and every spike entry was rebuilt both ways and compared byte for byte (normalizing only the shim namespace name): **all bundles are identical except `exceljs-stream`** (none of these libraries reads `process.env.NODE_ENV`, pdfjs-dist and the SDKs included, so the define changes nothing in them). The other numbers therefore hold as measured. `exceljs-stream` (2,211 → 1,919 KiB with the alias) was re-measured with the shipped options (`node rerun-shipped.mjs`, `evidence/rerun-shipped.jsonl`, one run each): streaming writer 100k rows ✅ 1.1 s, 1.04 s CPU, +78 MB; `readSheetsLast` 200k ✅ 3.9 s, 4.23 s CPU, +154 MB (same as before); spooling `read` 10k ✅ 481 ms, +434 MB (same as before). Larger `read` sizes were not re-run (they pass +2 GB of RSS).

## 1. Bundling (`ember deploy` resolution)

Same entry, three resolutions (`node probe-builds.mjs …`, saved in `evidence/builds.txt`):

| Entry | Ember before (`neutral`, only `node:*` external) | This PR (`browser` + Node builtins plugin, shipped options) | shipped options with `neutral` |
|---|---|---|---|
| exceljs (default entry = browser build) | ✅ 1,434 KiB | ✅ 1,434 KiB | ✅ |
| exceljs streaming (`exceljs/lib/exceljs.nodejs.js`) | ❌ `Could not resolve "stream" \| "util" \| "fs" \| "path" \| "events" \| "zlib"` | ✅ 1,919 KiB | ✅ 2,011 KiB |
| jszip | ❌ `Could not resolve "events" \| "util" \| "stream"` (its `readable-stream`) | ✅ 186 KiB | ✅ 283 KiB |
| `import fs from "fs"` etc. (bare builtins) | ❌ `Could not resolve "fs"` | ✅ | ✅ |
| @aws-sdk/client-s3 + presigner | builds (950 KiB), **throws at `new S3Client`**: `emitWarningIfUnsupportedVersion is not a function` | ✅ 586 KiB, PUT/GET/presign against the fake | same throw |
| @anthropic-ai/sdk | ✅ 1,254 KiB | ✅ 1,024 KiB (its `browser` map drops Node-only files) | ✅ 1,254 KiB |
| SheetJS 0.20, papaparse, pdf-lib, pdfjs-dist, fflate, stripe, openai | ✅ | ✅ (same bytes) | ✅ |

Why: esbuild applies package.json `browser` **maps** only with `platform: "browser"`, but the `browser` **export condition** applies whatever the platform. With `neutral`, `@aws-sdk/client-s3` kept its Node `runtimeConfig.js` (its map to `runtimeConfig.browser.js` was ignored) while `@aws-sdk/core` resolved to `index.browser.js`, whose Node helpers are `Symbol("node-only")` placeholders. Wrangler builds with esbuild's default platform (`browser`) plus a plugin that sends bare builtins to `node:*` (read in `wrangler-dist/cli.js` 4.157: `getBuildConditions()` = `workerd, worker, browser`, `nodejsHybridPlugin`).

The fix (`packages/cli/src/build.ts`, `nodeBuiltinsPlugin` + `WORKER_BUILD_OPTIONS`): `platform: "browser"`; every builtin, bare or `node:`, is external `node:<name>`; `require()` of one becomes `import m from "node:x"; module.exports = m` (an external `require()` in an ESM bundle throws "Dynamic require of … is not supported" at run time); `process.env.NODE_ENV` stays a runtime lookup (`platform: "browser"` would otherwise inline `"development"` into unminified bundles); npm `readable-stream` and its class entry points (`readable-stream/passthrough`, `/transform`, `/writable`, `/duplex`, `/readable`, with or without `.js`) are Node's `node:stream` (below). Test: `packages/cli/test/build-node.test.ts` (a CJS package that requires bare builtins, a `browser` map, a `readable-stream` user with archiver-style `instanceof Stream` checks, and the bundle running in workerd).

`readable-stream` → `node:stream`: under `browser` resolution alone, npm `readable-stream` uses its browser build, whose `Stream` is a bare `EventEmitter`, so archiver's `source instanceof Stream` check rejected exceljs' streams and exceljs' streaming writer failed (`input source must be valid Stream or Buffer instance`); under the old `neutral` resolution it worked. The plugin therefore resolves `readable-stream` the way the package itself does on Node with `READABLE_STREAM=disable`: the export is `node:stream`'s `Readable` with the module's members copied onto it and `.Stream` the module; `readable-stream/passthrough` etc. are the matching classes. With it the writer works again (100k rows: 1.1 s, +78 MB, shipped options) and the exceljs streaming bundle is smaller (Node's streams are not bundled twice). This departs from wrangler, which keeps the browser build; Ember owns its bundling, and only `exceljs-stream` changed among the spike's bundles.

## 2. Node APIs under `nodejs_compat` (2026-10-01)

`src/node-apis.js` → `evidence/node-apis.workerd.json` (times are local workerd, where the clock runs; 16 MiB inputs):

| Probe | | Time | Value / error |
|---|---|---:|---|
| crypto.createHash sha256 16 MB | ✅ | 7 ms | `"080acf35a507ac98"` |
| crypto.createHmac sha256 | ✅ | 0 ms | `"vxoMEkKSm2RkpsCprGKYpn4JvRzU7x8YLOAUFpH8F6A="` |
| crypto.randomUUID / randomBytes | ✅ | 0 ms | `[36,32]` |
| crypto.timingSafeEqual | ✅ | 0 ms | `true` |
| crypto aes-256-gcm, cipher.update(string) without encoding | ❌ | 0 ms | `The argument 'inputEncoding' If inputEncoding is not provided then the data must be a Buffer. Receiv` |
| crypto aes-256-gcm roundtrip (Buffer input) | ✅ | 1 ms | `"hello"` |
| crypto.pbkdf2Sync 100k sha256 | ✅ | 6 ms | `32` |
| crypto.scryptSync N=16384 | ✅ | 19 ms | `32` |
| crypto ed25519 keygen+sign+verify | ✅ | 1 ms | `true` |
| crypto RSA-2048 keygen | ✅ | 26 ms | `"rsa"` |
| crypto.createSign RSA-SHA256 (PEM) | ✅ | 65 ms | `342` |
| crypto.webcrypto.subtle digest | ✅ | 0 ms | `32` |
| Buffer base64/hex/utf8/readUInt32BE/concat | ✅ | 0 ms | `["olá",65280,8]` |
| stream Readable.from + Transform + pipeline | ✅ | 2 ms | `3` |
| stream Readable.fromWeb / toWeb | ✅ | 0 ms | `["hello web","x"]` |
| zlib.gzipSync+gunzipSync 16 MB | ✅ | 28 ms | `16777216` |
| zlib.createGzip stream 4 MB | ✅ | 6 ms | `4099` |
| zlib.deflateRawSync / inflateRawSync | ✅ | 7 ms | `4194304` |
| zlib.brotliCompressSync 4 MB | ✅ | 41 ms | `4194304` |
| CompressionStream gzip (web) | ✅ | 6 ms | `4099` |
| util.promisify/inspect/format/types/TextDecoder | ✅ | 1 ms | `[7,"{ a: [ 1, { b: 2 } ] }","x=1",true,"h"]` |
| events EventEmitter + once | ✅ | 3 ms | `1` |
| url / querystring / string_decoder / assert | ✅ | 2 ms | `["/tmp/a.csv","1","a=1&a=2","olá"]` |
| path.join/resolve/extname | ✅ | 0 ms | `["b/c.xlsx",".pdf","b.csv"]` |
| node:async_hooks AsyncLocalStorage | ✅ | 0 ms | `5` |
| node:timers/promises setTimeout | ✅ | 5 ms | `true` |
| process.env / nextTick / platform | ✅ | 1 ms | `["object","linux","v22.19.0"]` |
| Intl pt-BR currency + dates | ✅ | 8 ms | `["R$ 1.234,50","01/01/2026"]` |
| fs.writeFileSync/readFileSync /tmp | ✅ | 1 ms | `"hi"` |
| fs.promises + mkdtemp + 8 MB file in /tmp | ✅ | 1 ms | `8388608` |
| fs.readdirSync('/') | ✅ | 0 ms | `["bundle","tmp","dev"]` |
| fs.createReadStream /tmp | ✅ | 0 ms | `"stream me"` |
| os.tmpdir/cpus/totalmem | ✅ | 0 ms | `["/tmp/",0,0]` |
| node:http request (client) | ✅ | 8 ms | `[200,"pong"]` |
| node:https request (client) | ✅ | 2 ms | `[200,"pong"]` |
| node:http createServer | ✅ | 0 ms | `"function"` |
| node:net connect (raw TCP to an unresolvable test host) | ❌ | 8 ms | `getaddrinfo ENOTFOUND fake.test` |
| node:dns lookup (DNS over HTTPS via fetch; the fake upstream answers 599) | ❌ | 3 ms | `queryA ENOTFOUND example.com` |
| node:child_process spawn | ❌ | 0 ms | `The child_process.spawn method is not implemented` |
| node:worker_threads Worker | ❌ | 0 ms | `The Worker method is not implemented` |
| node:vm runInNewContext | ❌ | 0 ms | `The runInThisContext method is not implemented` |
| node:v8 getHeapStatistics | ✅ | 0 ms | `0` |
| process.memoryUsage() | ✅ | 0 ms | `{"rss":0,"heapTotal":0,"heapUsed":0,"external":0,"arrayBuffers":0}` |
| eval('1+1') | ❌ | 0 ms | `Code generation from strings disallowed for this context` |
| new Function | ❌ | 0 ms | `Code generation from strings disallowed for this context` |
| WebAssembly.compile(bytes) at runtime | ❌ | 0 ms | `WebAssembly.compile(): Wasm code generation disallowed by embedder` |
| SharedArrayBuffer + Atomics | ✅ | 0 ms | `0` |
| structuredClone / Blob / FormData / DecompressionStream | ✅ | 0 ms | `["object",1,"function","function"]` |

Notes:
- `cipher.update("hello")` without an input encoding throws in workerd (Node defaults to UTF-8): pass a `Buffer` or `"utf8"`.
- `node:net` and `node:dns` failed against test hosts only (the socket went to a name that does not resolve; DNS goes over HTTPS through `fetch`, which the fake upstream answered with 599): not a verdict on real hosts.
- **`/tmp` is in memory and appending to a file there is quadratic** (`tmpAppend`, 64 KiB writes through `fs.createWriteStream`): 8 MiB 43 ms, 16 MiB 228 ms, 32 MiB 1.1 s with **+2 GB** RSS; Node: 12 ms. A library that spools to a temp file (exceljs' streaming reader does) degrades badly. Worth an upstream workerd issue.
- Streaming `node:zlib` is as fast as Node (inflate 64 MiB in 16 KiB writes: 75 ms vs 89 ms), and `Buffer.slice`/`concat` are not slow either.
- Allocation probes (`alloc`, `allocHeap`): under the local 128 MB heap cap, 160 MiB of JS arrays aborts workerd, while **512 MiB of `Uint8Array`s passes** (+515 MB RSS). Whether production's isolate limit counts `ArrayBuffer` memory is the open question (PLAN §18 R17, 🌐).

## 3. Libraries

Verdict per library (✅ works, ⚠️ partial: size limit or caveat, ❌ no). Sizes are rows × 20 columns at the 128 MB heap; budget about half for an action that can run concurrently with others in the same isolate. The same table is in `libraries.json` for the codemod.

| Library | Imports | Works | Limit found (workerd, 128 MB heap) | Workaround |
|---|---|---|---|---|
| exceljs (in memory) | ✅ | ⚠️ | read ~25k rows (OOM at 30k); write ~10k (OOM at 15k) | streaming reader/writer below; SheetJS writes 2.5x more |
| exceljs streaming reader | ✅ after fix | ⚠️ | as Excel orders the zip (sheet before shared strings): spools the sheet to `/tmp`, 100k rows = 32 s CPU, +4 GB | **move the worksheets to the end of the zip first** (`src/xlsx-sheets-last.js`): 200k rows in 3.9 s / +154 MB; OOM ~390k (shared strings cache); 350k takes 34 s (GC near the cap) |
| exceljs streaming writer | ✅ after fix | ✅ | flat: 100k rows in 1.1 s, +78 MB (shipped options); 500k rows in 6 s, +85 MB (`neutral`) | — |
| SheetJS `xlsx` 0.18.5 (npm), **not recommended (advisories)** | ✅ | ⚠️ | read ~35k (OOM at 40k), measured before it was removed from the spike | 0.18.x, the last on npm, has GHSA-4r6h-8v6p-xvw6 (prototype pollution) and GHSA-5pgg-2g8v-p4x9 (ReDoS): use 0.20.x from cdn.sheetjs.com |
| SheetJS 0.20.3 (cdn.sheetjs.com) | ✅ | ⚠️ | read ~35k, `dense: true` ~45k (OOM at 50k); write ~25k (OOM at 30k) | no streaming XLSX reader in SheetJS |
| papaparse | ✅ | ✅ | whole string ~100k (OOM at 150k); **streaming flat: 1M rows in 4.2 s, +45 MB** | stream (recipe §5) |
| pdf-lib | ✅ | ✅ | generate ~2,000 text pages (OOM at 2,500); load + stamp 5,000 pages OK | split documents; custom fonts (fontkit) not measured |
| pdfjs-dist (text) | ✅ | ⚠️ | ~4,500 pages (OOM at 5,000), ~0.7 ms/page; needs the in-thread worker + `isEvalSupported: false` | no rendering to images (no canvas): Browser Rendering |
| jszip | ✅ after fix | ⚠️ | zip ~4,000 × 10 KB files (OOM at 4,500); unzip 20,000 OK; **wall time 6–30x Node** (timer yields per entry; CPU 3–4x Node) | fflate |
| fflate | ✅ | ✅ | zip/unzip 200 MB in memory pass the heap cap (data in `Uint8Array`s, 🌐); streaming `Unzip` flat (+108 MB at 200 MB of entries) | stream for big archives |
| node:crypto/stream/zlib/buffer/util/fs(/tmp) | ✅ | ✅ | `/tmp` appends are quadratic | write to R2 (`ctx.storage.store`) |
| stripe, openai, @anthropic-ai/sdk | ✅ | ✅ | — | — |
| @aws-sdk/client-s3 (+ presigner) | ✅ after fix | ✅ | — | for the app's own files, `ctx.storage` |
| child_process, worker_threads, vm, eval, native addons (sharp, canvas…) | — | ❌ | not implemented / code generation blocked | Images (`ctx.images`), Browser Rendering (`ctx.browser`), scheduled batches, container (future, PLAN §22 L13) |

### Spreadsheets (XLSX: 20 columns, shared strings as Excel writes them)

In memory, every XLSX library holds the whole workbook as JS objects: 2–4 KB of heap per row × 20 columns.

#### exceljs.read  (bundle 1434 KiB, gzip 295 KiB)

| n | workerd (heap ≤128 MB) | wall | CPU | RSS growth | Node wall | Node RSS growth |
|---:|---|---:|---:|---:|---:|---:|
| 10,000 | ✅ | 465 ms | 0.6 s | 105 MB | 348 ms | 224 MB |
| 20,000* | ✅ | 782 ms | 0.96 s | 192 MB |  |  |
| 25,000* | ✅ | 1.0 s | 1.2 s | 236 MB |  |  |
| 30,000* | ❌ OOM | 1.8 s | — s | 262 MB |  |  |
| 50,000 | ❌ OOM | 2.3 s | — s | 334 MB | 1.4 s | 668 MB |

Threshold: fits at 25,000, OOM at 30,000 (* = bisection point).

#### exceljs.write  (bundle 1434 KiB, gzip 295 KiB)

| n | workerd (heap ≤128 MB) | wall | CPU | RSS growth | Node wall | Node RSS growth |
|---:|---|---:|---:|---:|---:|---:|
| 10,000 | ✅ | 631 ms | 0.73 s | 117 MB | 583 ms | 348 MB |
| 15,000* | ❌ OOM | 1.4 s | — s | 136 MB |  |  |
| 20,000* | ❌ OOM | 1.5 s | — s | 160 MB |  |  |
| 30,000* | ❌ OOM | 1.1 s | — s | 139 MB |  |  |
| 50,000 | ❌ OOM | 1.4 s | — s | 130 MB | 3.0 s | 1443 MB |

Threshold: fits at 10,000, OOM at 15,000 (* = bisection point).

#### sheetjs-0.18.read  (bundle 849 KiB, gzip 191 KiB) — not recommended (advisories)

Measured with npm `xlsx@0.18.5`, since removed from the spike's `package.json`: 0.18.x has GHSA-4r6h-8v6p-xvw6 (prototype pollution) and GHSA-5pgg-2g8v-p4x9 (ReDoS). Apps should use 0.20.x from the SheetJS CDN (`https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`), measured below.

| n | workerd (heap ≤128 MB) | wall | CPU | RSS growth | Node wall | Node RSS growth |
|---:|---|---:|---:|---:|---:|---:|
| 10,000 | ✅ | 361 ms | 0.41 s | 73 MB | 334 ms | 180 MB |
| 30,000* | ✅ | 1.1 s | 1.19 s | 173 MB |  |  |
| 35,000* | ✅ | 1.3 s | 1.41 s | 189 MB |  |  |
| 40,000* | ❌ OOM | 2.7 s | — s | 203 MB |  |  |
| 50,000 | ❌ OOM | 2.0 s | — s | 218 MB | 1.6 s | 552 MB |

Threshold: fits at 35,000, OOM at 40,000 (* = bisection point).

#### sheetjs-0.20.read  (bundle 962 KiB, gzip 215 KiB)

| n | workerd (heap ≤128 MB) | wall | CPU | RSS growth | Node wall | Node RSS growth |
|---:|---|---:|---:|---:|---:|---:|
| 10,000 | ✅ | 423 ms | 0.49 s | 73 MB | 394 ms | 181 MB |
| 30,000* | ✅ | 1.3 s | 1.38 s | 170 MB |  |  |
| 35,000* | ✅ | 1.5 s | 1.58 s | 189 MB |  |  |
| 40,000* | ❌ OOM | 2.5 s | — s | 208 MB |  |  |
| 50,000 | ❌ OOM | 2.2 s | — s | 218 MB | 1.9 s | 575 MB |

Threshold: fits at 35,000, OOM at 40,000 (* = bisection point).

#### sheetjs-0.20.readDense  (bundle 962 KiB, gzip 215 KiB)

| n | workerd (heap ≤128 MB) | wall | CPU | RSS growth | Node wall | Node RSS growth |
|---:|---|---:|---:|---:|---:|---:|
| 10,000 | ✅ | 336 ms | 0.38 s | 67 MB | 331 ms | 152 MB |
| 30,000* | ✅ | 1.0 s | 1.07 s | 153 MB |  |  |
| 40,000* | ✅ | 1.3 s | 1.41 s | 192 MB |  |  |
| 45,000* | ✅ | 1.6 s | 1.61 s | 209 MB |  |  |
| 50,000 | ❌ OOM | 2.2 s | — s | 218 MB | 1.5 s | 463 MB |

Threshold: fits at 45,000, OOM at 50,000 (* = bisection point).

#### sheetjs-0.20.write  (bundle 962 KiB, gzip 215 KiB)

| n | workerd (heap ≤128 MB) | wall | CPU | RSS growth | Node wall | Node RSS growth |
|---:|---|---:|---:|---:|---:|---:|
| 10,000 | ✅ | 189 ms | 0.23 s | 70 MB | 219 ms | 225 MB |
| 20,000* | ✅ | 412 ms | 0.46 s | 133 MB |  |  |
| 25,000* | ✅ | 500 ms | 0.55 s | 158 MB |  |  |
| 30,000* | ❌ OOM | 983 ms | — s | 194 MB |  |  |
| 50,000 | ❌ OOM | 1.5 s | — s | 281 MB | 1.0 s | 783 MB |

Threshold: fits at 25,000, OOM at 30,000 (* = bisection point).

Streaming. exceljs' `WorkbookReader` parses a worksheet on the fly only after it has seen `xl/sharedStrings.xml` and the workbook rels; otherwise it spools the worksheet XML to a temp file and reads it back at the end. The fixtures (written by exceljs, which, like Excel, writes the sheet before the shared strings) hit the spool, and in workerd that spool is the quadratic `/tmp` append above. Not R2's chunking (64 KiB and 1 MiB chunks: same 5.8 s at 50k rows) and not `node:zlib`. (At 200k rows the run was stopped by hand at 33 s / +4.4 GB to protect the host.)

#### exceljs-stream.read  (bundle 2206 KiB, gzip 402 KiB; 1,919 KiB with the shipped options: 10k re-measured, same)

| n | workerd (heap ≤128 MB) | wall | CPU | RSS growth | Node wall | Node RSS growth |
|---:|---|---:|---:|---:|---:|---:|
| 10,000 | ✅ | 478 ms | 0.63 s | 431 MB | 216 ms | 98 MB |
| 50,000 | ✅ | 7.9 s | 7.97 s | 2083 MB | 932 ms | 296 MB |
| 100,000 | ✅ | 31.8 s | 32.01 s | 3993 MB | 1.8 s | 480 MB |
| 200,000 | ❌ crash | 33.0 s | — s | 4390 MB | 3.7 s | 737 MB |

Error: `fetch failed`

The same files with the worksheets moved to the end of the zip by `src/xlsx-sheets-last.js` (three passes over the R2 body, raw entry bytes, no recompression; the original central directory appended so unzipper stops cleanly):

#### exceljs-stream.readSheetsLast  (bundle 2211 KiB, gzip 403 KiB; 1,919 KiB with the shipped options: 200k re-measured, same)

| n | workerd (heap ≤128 MB) | wall | CPU | RSS growth | Node wall | Node RSS growth |
|---:|---|---:|---:|---:|---:|---:|
| 10,000 | ✅ | 262 ms | 0.31 s | 48 MB | 215 ms | 130 MB |
| 50,000 | ✅ | 978 ms | 1.06 s | 75 MB | 945 ms | 273 MB |
| 100,000 | ✅ | 3.1 s | 3.92 s | 90 MB | 1.8 s | 453 MB |
| 200,000 | ✅ | 3.9 s | 4.29 s | 154 MB | 3.5 s | 613 MB |
| 350,000* | ✅ | 34.0 s | 37.22 s | 153 MB |  |  |
| 390,000* | ❌ OOM | 1.5 s | — s | 158 MB |  |  |
| 425,000* | ❌ OOM | 1.5 s | — s | 159 MB |  |  |
| 500,000 | ❌ OOM | 2.3 s | — s | 145 MB | 8.9 s | 1338 MB |

Threshold: fits at 350,000, OOM at 390,000 (* = bisection point).

The 350k point fits but spends 34 s in GC with the heap near the cap (over the 30 s CPU default): the shared strings cache (~5.5 unique strings per row here) is what grows. Plan for ~200k rows of this shape per action; fewer unique strings per row go further.

The streaming writer. With the shipped options (the `readable-stream` alias, §1), one run: **100k rows ✅ 1.1 s, 1.04 s CPU, +78 MB** (`evidence/rerun-shipped.jsonl`). The full series below was measured with the `neutral` build, before the alias, when it was the only resolution where the writer ran:

#### exceljs-stream.write (neutral build)  (bundle 2353 KiB, gzip 422 KiB, build: neutral)

| n | workerd (heap ≤128 MB) | wall | CPU | RSS growth | Node wall | Node RSS growth |
|---:|---|---:|---:|---:|---:|---:|
| 10,000 | ✅ | 160 ms | 0.18 s | 26 MB | 151 ms | 91 MB |
| 50,000 | ✅ | 622 ms | 0.63 s | 68 MB | 633 ms | 134 MB |
| 100,000 | ✅ | 1.2 s | 1.22 s | 81 MB | 1.2 s | 257 MB |
| 200,000 | ✅ | 2.4 s | 2.43 s | 81 MB | 2.4 s | 336 MB |
| 500,000 | ✅ | 6.0 s | 6.15 s | 85 MB | 6.1 s | 517 MB |

### CSV

#### papaparse.parse  (bundle 32 KiB, gzip 10 KiB)

| n | workerd (heap ≤128 MB) | wall | CPU | RSS growth | Node wall | Node RSS growth |
|---:|---|---:|---:|---:|---:|---:|
| 10,000 | ✅ | 48 ms | 0.06 s | 49 MB | 36 ms | 72 MB |
| 100,000 | ✅ | 388 ms | 0.39 s | 411 MB | 320 ms | 336 MB |
| 150,000* | ❌ OOM | 901 ms | — s | 575 MB |  |  |
| 200,000* | ❌ OOM | 860 ms | — s | 695 MB |  |  |
| 300,000* | ❌ OOM | 724 ms | — s | 995 MB |  |  |
| 500,000 | ❌ OOM | 405 ms | — s | 1596 MB | 1.6 s | 1231 MB |

Threshold: fits at 100,000, OOM at 150,000 (* = bisection point).

#### papaparse.stream  (bundle 32 KiB, gzip 10 KiB)

| n | workerd (heap ≤128 MB) | wall | CPU | RSS growth | Node wall | Node RSS growth |
|---:|---|---:|---:|---:|---:|---:|
| 10,000 | ✅ | 57 ms | 0.1 s | 19 MB | 44 ms | 50 MB |
| 100,000 | ✅ | 424 ms | 0.5 s | 47 MB | 344 ms | 53 MB |
| 500,000 | ✅ | 2.1 s | 2.2 s | 39 MB | 1.7 s | 89 MB |
| 1,000,000 | ✅ | 4.2 s | 4.31 s | 45 MB | 3.3 s | 157 MB |

### PDF (A4 pages of 40 text lines, standard Helvetica)

#### pdf-lib.generate  (bundle 806 KiB, gzip 212 KiB)

| n | workerd (heap ≤128 MB) | wall | CPU | RSS growth | Node wall | Node RSS growth |
|---:|---|---:|---:|---:|---:|---:|
| 10 | ✅ | 24 ms | 0.05 s | 0 MB | 24 ms | 49 MB |
| 100 | ✅ | 101 ms | 0.17 s | 39 MB | 95 ms | 93 MB |
| 1,000 | ✅ | 735 ms | 0.86 s | 132 MB | 758 ms | 345 MB |
| 2,000* | ✅ | 1.7 s | 1.79 s | 195 MB |  |  |
| 2,500* | ❌ OOM | 1.7 s | — s | 132 MB |  |  |
| 3,000* | ❌ OOM | 1.7 s | — s | 132 MB |  |  |
| 5,000 | ❌ OOM | 1.6 s | — s | 132 MB | 4.1 s | 886 MB |

Threshold: fits at 2,000, OOM at 2,500 (* = bisection point).

#### pdf-lib.stamp  (bundle 806 KiB, gzip 212 KiB)

| n | workerd (heap ≤128 MB) | wall | CPU | RSS growth | Node wall | Node RSS growth |
|---:|---|---:|---:|---:|---:|---:|
| 100 | ✅ | 54 ms | 0.09 s | 17 MB | 51 ms | 72 MB |
| 1,000 | ✅ | 321 ms | 0.34 s | 91 MB | 334 ms | 204 MB |
| 5,000 | ✅ | 1.7 s | 1.3 s | 180 MB | 1.7 s | 457 MB |

#### pdfjs.text  (bundle 3358 KiB, gzip 706 KiB)

| n | workerd (heap ≤128 MB) | wall | CPU | RSS growth | Node wall | Node RSS growth |
|---:|---|---:|---:|---:|---:|---:|
| 10 | ✅ | 28 ms | 0.05 s | 9 MB | 32 ms | 52 MB |
| 100 | ✅ | 81 ms | 0.15 s | 15 MB | 114 ms | 67 MB |
| 1,000 | ✅ | 634 ms | 0.85 s | 53 MB | 813 ms | 207 MB |
| 3,000* | ✅ | 2.0 s | 2.3 s | 102 MB |  |  |
| 4,000* | ✅ | 2.8 s | 3.26 s | 132 MB |  |  |
| 4,500* | ✅ | 3.4 s | 3.99 s | 140 MB |  |  |
| 5,000 | ❌ OOM | 10.6 s | — s | 149 MB | 4.5 s | 425 MB |

Threshold: fits at 4,500, OOM at 5,000 (* = bisection point).

pdfjs-dist 6.5 runs with `pdfjs-dist/legacy/build/pdf.mjs`, after importing `pdf.worker.mjs` (registers `globalThis.pdfjsWorker`, so it parses in-thread without a Web Worker) and `isEvalSupported: false` (no `new Function` in workerd). It is the biggest bundle here (3.4 MiB).

### ZIP (N files of ~10 KB CSV text)

#### jszip.zip  (bundle 186 KiB, gzip 45 KiB)

| n | workerd (heap ≤128 MB) | wall | CPU | RSS growth | Node wall | Node RSS growth |
|---:|---|---:|---:|---:|---:|---:|
| 1,000 | ✅ | 5.7 s | 2.21 s | 92 MB | 933 ms | 222 MB |
| 3,000* | ✅ | 18.8 s | 7.87 s | 206 MB |  |  |
| 4,000* | ✅ | 25.3 s | 10.6 s | 235 MB |  |  |
| 4,500* | ❌ OOM | 1.2 s | — s | 133 MB |  |  |
| 5,000 | ❌ OOM | 1.3 s | — s | 130 MB | 4.8 s | 557 MB |

Threshold: fits at 4,000, OOM at 4,500 (* = bisection point).

#### jszip.unzip  (bundle 186 KiB, gzip 45 KiB)

| n | workerd (heap ≤128 MB) | wall | CPU | RSS growth | Node wall | Node RSS growth |
|---:|---|---:|---:|---:|---:|---:|
| 1,000 | ✅ | 5.6 s | 0.66 s | 33 MB | 177 ms | 88 MB |
| 5,000 | ✅ | 27.2 s | 2.45 s | 124 MB | 830 ms | 199 MB |
| 20,000 | ✅ | 108.2 s | 8.76 s | 406 MB | 3.3 s | 485 MB |

#### fflate.zip  (bundle 186 KiB, gzip 45 KiB)

| n | workerd (heap ≤128 MB) | wall | CPU | RSS growth | Node wall | Node RSS growth |
|---:|---|---:|---:|---:|---:|---:|
| 1,000 | ✅ | 465 ms | 0.52 s | 127 MB | 537 ms | 162 MB |
| 5,000 | ✅ | 2.3 s | 2.39 s | 248 MB | 2.8 s | 385 MB |
| 20,000 | ✅ | 9.4 s | 9.49 s | 777 MB | 11.3 s | 984 MB |

#### fflate.unzip  (bundle 186 KiB, gzip 45 KiB)

| n | workerd (heap ≤128 MB) | wall | CPU | RSS growth | Node wall | Node RSS growth |
|---:|---|---:|---:|---:|---:|---:|
| 1,000 | ✅ | 115 ms | 0.13 s | 52 MB | 89 ms | 84 MB |
| 5,000 | ✅ | 501 ms | 0.53 s | 216 MB | 416 ms | 237 MB |
| 20,000 | ✅ | 2.0 s | 2.06 s | 827 MB | 1.6 s | 753 MB |

#### fflate.stream-unzip  (bundle 186 KiB, gzip 45 KiB)

| n | workerd (heap ≤128 MB) | wall | CPU | RSS growth | Node wall | Node RSS growth |
|---:|---|---:|---:|---:|---:|---:|
| 1,000 | ✅ | 169 ms | 0.2 s | 77 MB | 151 ms | 126 MB |
| 5,000 | ✅ | 891 ms | 1.23 s | 83 MB | 671 ms | 135 MB |
| 20,000 | ✅ | 3.7 s | 5.45 s | 108 MB | 2.8 s | 186 MB |

jszip's wall time is mostly waiting: it yields to the event loop between entries through a `setImmediate` polyfill built on `setTimeout`; CPU is 3–4x Node's. fflate zips/unzips 200 MB in memory under the heap cap because its data lives in `Uint8Array`s (+777–827 MB RSS): whether that fits in production is R17 (🌐); its streaming `Unzip` is flat.

## 4. HTTP SDKs (against local fakes through miniflare's `outboundService`)

`src/sdk-*.js`, each against a fake upstream served by the harness (`outboundService`), so only import + request/response handling is tested, not the real APIs:

| SDK | Version | Bundle (this PR) | Result |
|---|---|---:|---|
| `stripe` (no `httpClient` option: its `workerd` export picks fetch) | 23.1.0 | 719 KiB | ✅ `customers.create`; webhook `generateTestHeaderStringAsync` + `constructEventAsync(…, Stripe.createSubtleCryptoProvider())` |
| `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` | 3.1169 | 586 KiB | ✅ PutObject, GetObject (`transformToString`), `getSignedUrl`. ❌ before the fix (see §1) |
| `openai` | 7.57.0 | 950 KiB | ✅ `chat.completions.create`, plain and `stream: true` (SSE) |
| `@anthropic-ai/sdk` | 1.8.0 | 1,024 KiB | ✅ `messages.create` and `messages.stream` |

Bundle size is not a limit any more (64 MiB uncompressed on both plans 📄), but everything an app imports is evaluated when the one Ember Worker starts (the isolate that serves actions, HTTP and the DOs), within 1 s of startup CPU 📄. Locally, the median time to a ready workerd (process start included) went from ~65 ms with papaparse (32 KiB) or fflate to ~75 ms with SheetJS or pdf-lib, ~105 ms with exceljs (1.4–2.2 MiB) and ~145 ms with pdfjs-dist (3.4 MiB) ✅: tens of milliseconds per heavy library, which add up. Importing a heavy library inside the handler (`await import("pdfjs-dist/legacy/build/pdf.mjs")`) defers its evaluation to the action that needs it (esbuild keeps it lazy in the single bundle); not measured here.

## 5. Recipe: big CSV import in an action

Measured as `papaparse.stream` (`src/papaparse.js`): the R2 body (what `ctx.storage.get(id).body` is) goes through `TextDecoderStream` into papaparse's `step` callback; every 500 rows the parser **pauses**, the batch goes out (here a stand-in for `ctx.runMutation`), and the parser resumes. **1,000,000 rows × 20 columns (200 MB of CSV) took 4.2 s with +45 MB of process RSS, flat from 100k rows up** ✅; the whole-string parse of the same library OOMs between 100k and 150k rows.

In an Ember app (schema, names and validation are the app's; the pattern is what matters):

```ts
// ember/imports.ts
import { v } from "@freecorps/ember-server";
import Papa from "papaparse";
import { Readable } from "node:stream";
import { internal } from "./_generated/api";
import { internalAction, internalMutation } from "./_generated/server";

const BATCH = 500; // rows per mutation: keeps each transaction far below 8,192 rows written (each index adds rows)

export const insertBatch = internalMutation({
  args: { importId: v.id("imports"), rows: v.array(v.array(v.union(v.string(), v.number(), v.null()))) },
  handler: (ctx, { importId, rows }) => {
    for (const [code, name, email, total] of rows) ctx.db.insert("customers", { importId, code: String(code), name: String(name), email: String(email), total: Number(total) });
    const job = ctx.db.get(importId)!;
    ctx.db.patch(importId, { rows: job.rows + rows.length }); // progress, live on the client through a query
  },
});

export const run = internalAction({
  args: { importId: v.id("imports"), file: v.file() },
  handler: async (ctx, { importId, file }) => {
    const stored = await ctx.storage.get(file);
    if (!stored) throw new Error("file not found");
    const text = Readable.fromWeb(stored.body.pipeThrough(new TextDecoderStream()));
    let batch: unknown[][] = [];
    await new Promise<void>((resolve, reject) => {
      Papa.parse(text, {
        skipEmptyLines: true,
        dynamicTyping: true,
        step(res, parser) {
          batch.push(res.data as unknown[]);
          if (batch.length < BATCH) return;
          parser.pause(); // nothing else is read from R2 until the batch is written
          const rows = batch;
          batch = [];
          ctx.runMutation(internal.imports.insertBatch, { importId, rows: rows as never }).then(() => parser.resume(), reject);
        },
        complete: () => resolve(),
        error: reject,
      });
    });
    if (batch.length) await ctx.runMutation(internal.imports.insertBatch, { importId, rows: batch as never });
  },
});
```

Notes:
- Schedule it (`ctx.scheduler.runAfter(0, internal.imports.run, { importId, file })` from the mutation that records the upload): scheduled actions run as queue jobs, off the request path. Without an `EMBER_ACTIONS` queue they run in the shard's alarm (`packages/runtime/src/actions.ts`), so a long import would hold that shard: deploy with the queue for heavy work.
- Each batch is its own transaction: on a failure halfway, the import is partial. Keep a cursor (rows done) on the import row and skip that many rows on a retry, or import into a staging table and flip a flag at the end.
- CPU: parsing 1M rows was ~4 s here; the `runMutation` waits are I/O and do not count toward the 30 s CPU limit 📄. Past a few million rows, split the file by byte ranges (R2 range reads, cut at a newline) into several scheduled actions.
- XLSX: ask users for CSV for big imports. In memory, XLSX reads fit ~25k (exceljs) to ~45k (SheetJS `dense`) rows × 20 columns and writes only ~10k (exceljs) to ~25k (SheetJS) (table above); exceljs' streaming reader spools as Excel orders the zip (32 s of CPU for 100k rows in workerd) unless the worksheets are moved to the end first (below); exceljs' streaming writer is flat.

### XLSX variant

For XLSX, the same shape with exceljs' streaming reader, fed through `sheetsLast` so it never spools (`src/xlsx-sheets-last.js`, ~100 lines, measured above as `readSheetsLast`):

```ts
import ExcelJS from "exceljs/lib/exceljs.nodejs.js"; // the streaming API is only in the Node entry
import { sheetsLast } from "./lib/xlsx-sheets-last"; // copy of docs/spikes/node-actions/src/xlsx-sheets-last.js

const open = async () => (await ctx.storage.get(file))!.body; // one fresh stream per pass (3 passes)
const input = Readable.fromWeb(await sheetsLast(open));
const reader = new ExcelJS.stream.xlsx.WorkbookReader(input, { sharedStrings: "cache", worksheets: "emit", styles: "ignore", hyperlinks: "ignore", entries: "ignore" });
let rows: unknown[][] = [];
for await (const sheet of reader) for await (const row of sheet) {
  rows.push((row.values as unknown[]).slice(1)); // exceljs' row.values is 1-based
  if (rows.length === BATCH) { await ctx.runMutation(internal.imports.insertBatch, { importId, rows: rows as never }); rows = []; }
}
if (rows.length) await ctx.runMutation(internal.imports.insertBatch, { importId, rows: rows as never });
```

Fits ~200k rows × 20 columns in ~4 s (shared strings stay in memory). Needs the bundler fix of this PR (the Node entry of exceljs requires bare builtins). `ctx.storage.get` has no range reads, hence three full passes; with ranges, the central directory and the small entries could be fetched directly.

## 6. Conclusions

1. **Most `"use node"` code runs on Ember once the bundler resolves like wrangler.** That fix is the product change here: jszip, exceljs' streaming API and the AWS SDK did not build or did not run before; after it (plus the `readable-stream` → `node:stream` alias, which keeps exceljs' streaming writer working), every library tested imports and runs. `node:crypto`, streams, zlib, buffers and the SDKs used from actions (Stripe, OpenAI, Anthropic, S3) behave as in Node. CPU-bound work is about as fast as in Node.
2. **Memory is the real limit, not missing APIs.** 128 MB per isolate, shared by concurrent requests 📄, with no way for the action to see its own usage (`process.memoryUsage()` is zeros). In-memory XLSX reads ~25k–45k rows × 20 columns, writes ~10k–25k; PDF generation ~2,000 pages; pdfjs text ~4,500 pages.
3. **Streaming makes the common big case fit.** CSV: 1M rows in 4 s at flat memory (papaparse `step` + pause/resume over the R2 body, batches of 500 to `runMutation`). XLSX: exceljs' streaming reader after moving the worksheets to the end of the zip, ~200k rows in 4 s. Both recipes are in §5; neither needs new Ember API.
4. **What does not fit the Worker:** XLSX beyond ~200–350k rows of this shape, in-memory archives of hundreds of MB if `ArrayBuffer`s count (🌐 R17), anything needing a subprocess or native code (LibreOffice, ImageMagick/sharp, ffmpeg, canvas, Python), and CPU beyond 5 min. Ember already covers part of it natively (`ctx.images`, `ctx.browser`); the rest is the `action({ runtime: "container" })` design note in PLAN §22 L13 (future work, not built).
5. **Found along the way:** workerd's in-memory `/tmp` appends are quadratic (upstream issue); `cipher.update(string)` needs an explicit encoding; jszip is slow in wall time in workerd (use fflate); exceljs' streaming writer needs `readable-stream` to be Node's, so the bundler aliases it to `node:stream` (§1).
6. **Codemod (L9):** `ember migrate convex` (PR #95) was not merged when this spike finished, so the verdicts are in `libraries.json` (imports → `works`/`partial`/`no` + note + evidence) for it to read; matching `"use node"` imports against it and printing the verdict in its report is the follow-up.
7. **Next:** R17 (does the isolate limit count `ArrayBuffer`s; confirm one XLSX threshold in production), `limits.cpu_ms` in `ember.json` for projects with heavy actions (Ember's deploy leaves the 30 s default), and optionally `ctx.storage.get(id, { range })`, which would make the XLSX reorder one pass.
