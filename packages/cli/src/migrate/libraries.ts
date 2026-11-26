// Which imports run in an Ember action (workerd, nodejs_compat): a copy of docs/spikes/node-actions/libraries.json
// (the spike's evidence, PLAN §22 L9/L13), for `ember migrate convex`. test/migrate-libraries.test.ts keeps the two
// equal: change the spike's file, then regenerate this one (same JSON, minus "$comment" and "verdicts").

export type Verdict = "works" | "partial" | "no";

export interface ModuleVerdict {
  verdict: Verdict;
  note?: string;
  /** "tested": run in the spike; "inferred": from its probes or Cloudflare's docs. */
  evidence: "tested" | "inferred";
}

export const VERDICTS: Record<Verdict, string> = {
  works: "Runs in an Ember action as is.",
  partial: "Runs, with a size limit or a caveat (see note): check the workload.",
  no: "Cannot run in the Worker: needs a workaround, another service or a container (future `action({ runtime: \"container\" })`).",
};

export const LIBRARIES: { version: number; runtime: { compatibilityDate: string; compatibilityFlags: string[]; isolateMemoryMB: number; cpuMsDefault: number; cpuMsMax: number }; modules: Record<string, ModuleVerdict> } = {
  "version": 1,
  "runtime": {
    "compatibilityDate": "2026-10-01",
    "compatibilityFlags": [
      "nodejs_compat"
    ],
    "isolateMemoryMB": 128,
    "cpuMsDefault": 30000,
    "cpuMsMax": 300000
  },
  "modules": {
    "node:crypto": {
      "verdict": "works",
      "note": "createHash/Hmac, randomUUID/randomBytes, pbkdf2, scrypt, ed25519/RSA keys, sign/verify, AES-GCM, webcrypto. cipher.update(string) needs an explicit encoding: pass a Buffer or 'utf8'.",
      "evidence": "tested"
    },
    "node:buffer": {
      "verdict": "works",
      "evidence": "tested"
    },
    "node:stream": {
      "verdict": "works",
      "note": "Readable/Transform/pipeline, Readable.fromWeb/toWeb.",
      "evidence": "tested"
    },
    "node:stream/promises": {
      "verdict": "works",
      "evidence": "tested"
    },
    "node:zlib": {
      "verdict": "works",
      "note": "gzip/deflate/brotli, sync and streams.",
      "evidence": "tested"
    },
    "node:util": {
      "verdict": "works",
      "evidence": "tested"
    },
    "node:events": {
      "verdict": "works",
      "evidence": "tested"
    },
    "node:path": {
      "verdict": "works",
      "evidence": "tested"
    },
    "node:url": {
      "verdict": "works",
      "evidence": "tested"
    },
    "node:string_decoder": {
      "verdict": "works",
      "evidence": "tested"
    },
    "node:async_hooks": {
      "verdict": "works",
      "note": "AsyncLocalStorage.",
      "evidence": "tested"
    },
    "node:timers": {
      "verdict": "works",
      "evidence": "tested"
    },
    "node:timers/promises": {
      "verdict": "works",
      "evidence": "tested"
    },
    "node:assert": {
      "verdict": "works",
      "evidence": "tested"
    },
    "node:querystring": {
      "verdict": "works",
      "evidence": "tested"
    },
    "node:fs": {
      "verdict": "partial",
      "note": "Virtual file system: /tmp is writable and per request, /bundle is read-only; no access to the deploy machine's files. Store files with ctx.storage (R2).",
      "evidence": "tested"
    },
    "node:fs/promises": {
      "verdict": "partial",
      "note": "Same as node:fs.",
      "evidence": "tested"
    },
    "node:os": {
      "verdict": "partial",
      "note": "Stubs: cpus() is empty, totalmem() is 0.",
      "evidence": "tested"
    },
    "node:http": {
      "verdict": "partial",
      "note": "Client requests work (over fetch); servers do not listen. Prefer fetch.",
      "evidence": "tested"
    },
    "node:https": {
      "verdict": "partial",
      "note": "Client requests work (over fetch). Prefer fetch.",
      "evidence": "tested"
    },
    "node:net": {
      "verdict": "partial",
      "note": "Outbound TCP via Workers sockets only; no servers.",
      "evidence": "inferred"
    },
    "node:dns": {
      "verdict": "partial",
      "note": "Lookups go over DNS-over-HTTPS (not verified in this spike).",
      "evidence": "inferred"
    },
    "node:process": {
      "verdict": "partial",
      "note": "process.env holds Worker vars/secrets; memoryUsage() returns zeros.",
      "evidence": "tested"
    },
    "node:v8": {
      "verdict": "partial",
      "note": "getHeapStatistics() returns zeros.",
      "evidence": "tested"
    },
    "node:child_process": {
      "verdict": "no",
      "note": "Not implemented in Workers: no subprocesses (LibreOffice, ImageMagick, ffmpeg, Python...). Container work (future).",
      "evidence": "tested"
    },
    "node:worker_threads": {
      "verdict": "no",
      "note": "Not implemented. Split the work into scheduled actions.",
      "evidence": "tested"
    },
    "node:cluster": {
      "verdict": "no",
      "evidence": "inferred"
    },
    "node:vm": {
      "verdict": "no",
      "note": "No code generation from strings (eval/new Function are blocked too).",
      "evidence": "tested"
    },
    "node:sqlite": {
      "verdict": "no",
      "note": "Use the shard's tables (ctx.db) or ctx.sql.",
      "evidence": "inferred"
    },
    "exceljs": {
      "verdict": "partial",
      "note": "In-memory read fits ~25k rows (OOM at 30k), in-memory write ~10k (OOM at 15k). Streaming reader (exceljs/lib/exceljs.nodejs.js, needs the bundler fix): feed it the file with the worksheets moved to the end of the zip (RESULTS.md §5, src/xlsx-sheets-last.js): 200k rows in 3.9 s, OOM ~390k; without that it spools to /tmp (quadratic in workerd: 100k rows = 32 s CPU). Streaming writer (same entry) is flat: 100k rows in 1.1 s, +78 MB (needs the bundler's readable-stream -> node:stream alias, shipped with it).",
      "evidence": "tested"
    },
    "xlsx": {
      "verdict": "partial",
      "note": "SheetJS. Use 0.20.x from the SheetJS CDN (https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz): 0.18.x, the last version on npm, is not recommended (advisories GHSA-4r6h-8v6p-xvw6, prototype pollution, and GHSA-5pgg-2g8v-p4x9, ReDoS). 0.20.3: read fits ~35k rows (OOM at 40k), ~45k with `dense: true` (OOM at 50k); write ~25k (OOM at 30k). No streaming XLSX reader.",
      "evidence": "tested"
    },
    "papaparse": {
      "verdict": "works",
      "note": "Whole-string parse fits ~100k rows; streaming (`step` + pause/resume over the R2 body) is flat in memory at any size. Recipe in RESULTS.md §5.",
      "evidence": "tested"
    },
    "csv-parse": {
      "verdict": "partial",
      "note": "Not measured; streaming CSV parsers behave like papaparse's stream mode.",
      "evidence": "inferred"
    },
    "pdf-lib": {
      "verdict": "works",
      "note": "Generate ~2,000 pages of text (OOM at 2,500); load + stamp 5,000 pages. Standard fonts; custom fonts need @pdf-lib/fontkit (not measured).",
      "evidence": "tested"
    },
    "pdfjs-dist": {
      "verdict": "partial",
      "note": "Text extraction with pdfjs-dist/legacy/build/pdf.mjs after importing pdf.worker.mjs (in-thread worker), isEvalSupported: false: ~4,500 pages (OOM at 5,000), ~0.6 ms/page. No rendering to images (no canvas).",
      "evidence": "tested"
    },
    "jszip": {
      "verdict": "partial",
      "note": "Works after the bundler fix (it failed to build before). Zip fits ~4,000 × 10 KB files (OOM at 4,500); unzip of 5,000 files OK. ~6x slower than Node in wall time (setTimeout yields between entries; CPU is low). Prefer fflate.",
      "evidence": "tested"
    },
    "fflate": {
      "verdict": "works",
      "note": "zipSync/unzipSync of 200 MB OK under the heap cap (data in ArrayBuffers: whether production counts them is unverified); streaming Unzip over the R2 body is flat.",
      "evidence": "tested"
    },
    "stripe": {
      "verdict": "works",
      "note": "Fetch client picked by the workerd export; webhooks: constructEventAsync + createSubtleCryptoProvider().",
      "evidence": "tested"
    },
    "openai": {
      "verdict": "works",
      "note": "Including streaming.",
      "evidence": "tested"
    },
    "@anthropic-ai/sdk": {
      "verdict": "works",
      "note": "Including messages.stream.",
      "evidence": "tested"
    },
    "@aws-sdk/client-s3": {
      "verdict": "works",
      "note": "Needs the bundler fix of this spike (before it threw `emitWarningIfUnsupportedVersion is not a function`). For the app's own files use ctx.storage (R2).",
      "evidence": "tested"
    },
    "@aws-sdk/s3-request-presigner": {
      "verdict": "works",
      "evidence": "tested"
    },
    "sharp": {
      "verdict": "no",
      "note": "Native addon. Use ctx.images (Cloudflare Images) for resize/convert.",
      "evidence": "inferred"
    },
    "canvas": {
      "verdict": "no",
      "note": "Native addon.",
      "evidence": "inferred"
    },
    "@napi-rs/canvas": {
      "verdict": "no",
      "note": "Native addon.",
      "evidence": "inferred"
    },
    "puppeteer": {
      "verdict": "no",
      "note": "Use ctx.browser (Browser Rendering, PLAN §13) or @cloudflare/puppeteer through ctx.browser.binding.",
      "evidence": "inferred"
    },
    "playwright": {
      "verdict": "no",
      "note": "Use ctx.browser (Browser Rendering).",
      "evidence": "inferred"
    },
    "bcrypt": {
      "verdict": "no",
      "note": "Native addon. Use node:crypto scrypt (native in workerd) or bcryptjs.",
      "evidence": "inferred"
    },
    "ajv": {
      "verdict": "partial",
      "note": "Compiles validators with new Function, which workerd blocks at request time: precompile (ajv standalone) or validate with v.* validators.",
      "evidence": "inferred"
    },
    "exceljs/lib/exceljs.nodejs.js": {
      "verdict": "partial",
      "note": "exceljs' Node entry (streaming API): see `exceljs`.",
      "evidence": "tested"
    }
  }
};
