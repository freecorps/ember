// node run.mjs [--only <id-substring>] [--smoke]: the measurement matrix, one run at a time. Each case goes up in
// size in workerd (V8 heap capped at 128 MB); at the first OOM the row count is bisected between the last pass and
// the failure; the same sizes run in Node (no cap) for reference. Appends to evidence/results.jsonl.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { HERE, build, runInNode, runInWorkerd } from "./harness.mjs";
import { ensureCsv, ensurePdf, ensureXlsx, ensureZip } from "./fixtures.mjs";

const args = process.argv.slice(2);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;
const smoke = args.includes("--smoke");
const OUT = join(HERE, "evidence", smoke ? "smoke.jsonl" : "results.jsonl");
mkdirSync(join(HERE, "evidence"), { recursive: true });

const XL = [10_000, 50_000, 100_000, 200_000, 500_000];
const inputs = {
  xlsx: async (n) => ({ fixture: await ensureXlsx(n), params: { key: `rows-${n}.xlsx` } }),
  csv: async (n) => ({ fixture: await ensureCsv(n), params: { key: `rows-${n}.csv` } }),
  pdf: async (n) => ({ fixture: await ensurePdf(n), params: { key: `pages-${n}.pdf` } }),
  zip: async (n) => ({ fixture: await ensureZip(n), params: { key: `files-${n}.zip` } }),
  rows: async (n) => ({ params: { rows: n } }),
  pages: async (n) => ({ params: { pages: n } }),
  files: async (n) => ({ params: { files: n } }),
};
const CASES = [
  { id: "exceljs.read", entry: "exceljs", w: "read", input: "xlsx", sizes: XL },
  { id: "exceljs.write", entry: "exceljs", w: "write", input: "rows", sizes: XL },
  { id: "exceljs-stream.read", entry: "exceljs-stream", w: "read", input: "xlsx", sizes: XL },
  { id: "exceljs-stream.readSheetsLast", entry: "exceljs-stream", w: "readSheetsLast", input: "xlsx", sizes: XL },
  { id: "exceljs-stream.write (neutral build)", entry: "exceljs-stream", variant: "neutral", w: "write", input: "rows", sizes: XL },
  { id: "sheetjs-0.18.read", entry: "sheetjs", w: "read", input: "xlsx", sizes: XL },
  { id: "sheetjs-0.20.read", entry: "sheetjs-020", w: "read", input: "xlsx", sizes: XL },
  { id: "sheetjs-0.20.readDense", entry: "sheetjs-020", w: "readDense", input: "xlsx", sizes: XL },
  { id: "sheetjs-0.20.write", entry: "sheetjs-020", w: "write", input: "rows", sizes: XL },
  { id: "papaparse.parse", entry: "papaparse", w: "parse", input: "csv", sizes: [10_000, 100_000, 500_000, 1_000_000] },
  { id: "papaparse.stream", entry: "papaparse", w: "stream", input: "csv", sizes: [10_000, 100_000, 500_000, 1_000_000] },
  { id: "pdf-lib.generate", entry: "pdf-lib", w: "generate", input: "pages", sizes: [10, 100, 1000, 5000] },
  { id: "pdf-lib.stamp", entry: "pdf-lib", w: "stamp", input: "pdf", sizes: [100, 1000, 5000] },
  { id: "pdfjs.text", entry: "pdfjs", w: "text", input: "pdf", sizes: [10, 100, 1000, 5000] },
  { id: "jszip.zip", entry: "zip", w: "jszipZip", input: "files", sizes: [1000, 5000, 20_000] },
  { id: "jszip.unzip", entry: "zip", w: "jszipUnzip", input: "zip", sizes: [1000, 5000, 20_000] },
  { id: "fflate.zip", entry: "zip", w: "fflateZip", input: "files", sizes: [1000, 5000, 20_000] },
  { id: "fflate.unzip", entry: "zip", w: "fflateUnzip", input: "zip", sizes: [1000, 5000, 20_000] },
  { id: "fflate.stream-unzip", entry: "zip", w: "fflateStream", input: "zip", sizes: [1000, 5000, 20_000] },
];

const SLOW_MS = 120_000; // above this, larger sizes are skipped (default Worker CPU limit is 30 s; max 5 min)
const nice = (n) => (n >= 10_000 ? Math.round(n / 5000) * 5000 : n >= 1000 ? Math.round(n / 500) * 500 : Math.round(n / 5) * 5);

async function point(c, code, n) {
  const { fixture, params } = await inputs[c.input](n);
  const r = await runInWorkerd(code, { workload: c.w, params, fixture });
  const row = { id: c.id, n, ok: !!r.ok, oom: r.oom ?? null, wallMs: r.wallMs, cpuS: r.cpuS, peakRssDeltaMB: r.peakRssDeltaMB, startupMs: r.startupMs, result: r.result, error: r.ok ? undefined : (r.error ?? "").slice(0, 300), stderr: r.ok ? undefined : r.stderr?.slice(0, 300) };
  console.log(`  workerd n=${n} ${row.ok ? "ok" : row.oom ? `OOM (${row.oom})` : "FAIL"} ${row.wallMs} ms rss+${row.peakRssDeltaMB} MB${row.ok ? "" : ` ${row.error?.slice(0, 120)}`}`);
  return row;
}

for (const c of CASES) {
  if (only && !c.id.includes(only)) continue;
  const sizes = smoke ? [c.sizes[0]] : c.sizes;
  const b = await build(c.entry, { variant: c.variant ?? "fixed" });
  console.log(`${c.id}: bundle ${b.ok ? `${Math.round(b.bytes / 1024)} KiB` : b.error}`);
  if (!b.ok) { appendFileSync(OUT, JSON.stringify({ id: c.id, build: b.error }) + "\n"); continue; }
  const rows = [];
  let lastOk = null;
  for (const n of sizes) {
    const r = await point(c, b.code, n);
    rows.push(r);
    if (!r.ok) {
      // Bisect between the last passing size and this one (3 steps).
      if (r.oom && lastOk) {
        let lo = lastOk, hi = n;
        for (let i = 0; i < 3; i++) {
          const mid = nice((lo + hi) / 2);
          if (mid <= lo || mid >= hi) break;
          const m = await point(c, b.code, mid);
          m.bisect = true;
          rows.push(m);
          if (m.ok) lo = mid; else hi = mid;
        }
        rows.push({ id: c.id, threshold: { lastOk: lo, firstFail: hi } });
      }
      break;
    }
    lastOk = n;
    if (r.wallMs > SLOW_MS) { rows.push({ id: c.id, skipped: `sizes above ${n}: took ${r.wallMs} ms` }); break; }
  }
  // Node reference on the main sizes up to (and including) the first failure.
  for (const r of rows.filter((x) => x.n !== undefined && !x.bisect)) {
    const { params } = await inputs[c.input](r.n);
    const nr = await runInNode(c.entry, c.w, params);
    r.node = { ok: nr.ok, wallMs: nr.wallMs, cpuS: nr.cpuS, peakRssDeltaMB: nr.peakRssDeltaMB, error: nr.ok ? undefined : nr.error?.slice(0, 200) };
    console.log(`  node    n=${r.n} ${nr.ok ? "ok" : "FAIL"} ${nr.wallMs} ms rss+${nr.peakRssDeltaMB} MB`);
  }
  for (const r of rows) appendFileSync(OUT, JSON.stringify({ variant: c.variant ?? "fixed", bundleKiB: Math.round(b.bytes / 1024), gzipKiB: Math.round(b.gzipBytes / 1024), ...r }) + "\n");
}
