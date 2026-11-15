// node report.mjs [evidence/results.jsonl]: prints the per-case markdown tables used in RESULTS.md.
import { readFileSync } from "node:fs";

const file = process.argv[2] ?? new URL("./evidence/results.jsonl", import.meta.url).pathname;
const rows = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const byId = new Map();
for (const r of rows) (byId.get(r.id) ?? byId.set(r.id, []).get(r.id)).push(r);
const fmtMs = (ms) => (ms == null ? "—" : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`);
const status = (r) => (r.ok ? "✅" : r.oom ? "❌ OOM" : "❌ crash");

for (const [id, list] of byId) {
  const pts = list.filter((r) => r.n !== undefined).sort((a, b) => a.n - b.n);
  const thr = list.find((r) => r.threshold)?.threshold;
  const skip = list.find((r) => r.skipped)?.skipped;
  const head = list[0];
  console.log(`\n#### ${id}  (bundle ${head.bundleKiB ?? "?"} KiB, gzip ${head.gzipKiB ?? "?"} KiB${head.variant && head.variant !== "fixed" ? `, build: ${head.variant}` : ""})\n`);
  if (head.build) { console.log(`Build fails: ${head.build}`); continue; }
  console.log("| n | workerd (heap ≤128 MB) | wall | CPU | RSS growth | Node wall | Node RSS growth |");
  console.log("|---:|---|---:|---:|---:|---:|---:|");
  for (const r of pts) {
    console.log(`| ${r.n.toLocaleString("en")}${r.bisect ? "*" : ""} | ${status(r)} | ${fmtMs(r.wallMs)} | ${r.cpuS ?? "—"} s | ${r.peakRssDeltaMB ?? "—"} MB | ${r.node ? (r.node.ok ? fmtMs(r.node.wallMs) : "fail") : ""} | ${r.node?.ok ? `${r.node.peakRssDeltaMB} MB` : ""} |`);
  }
  if (thr) console.log(`\nThreshold: fits at ${thr.lastOk.toLocaleString("en")}, OOM at ${thr.firstFail.toLocaleString("en")} (* = bisection point).`);
  if (skip) console.log(`\nSkipped ${skip}.`);
  const err = pts.find((r) => !r.ok && !r.oom)?.error;
  if (err) console.log(`\nError: \`${err.split("\n")[0].slice(0, 160)}\``);
}
