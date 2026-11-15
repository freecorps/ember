// node rerun-shipped.mjs: re-measures exceljs-stream (the only spike bundle the readable-stream alias changes) with the
// shipped WORKER_BUILD_OPTIONS, one point at a time; kills workerd above ~2 GB RSS. Appends to evidence/rerun-shipped.jsonl.
import { execFile } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { HERE, build, runInWorkerd } from "./harness.mjs";
import { ensureXlsx } from "./fixtures.mjs";
const exec = promisify(execFile);
const OUT = join(HERE, "evidence", "rerun-shipped.jsonl");
const b = await build("exceljs-stream", { variant: "fixed" });
if (!b.ok) throw new Error(b.error);
console.log(`exceljs-stream: bundle ${Math.round(b.bytes / 1024)} KiB (shipped WORKER_BUILD_OPTIONS)`);
async function watchdog(stop) {
  while (!stop.done) {
    try {
      const { stdout } = await exec("ps", ["-A", "-o", "pid=,ppid=,rss=,command="]);
      for (const l of stdout.split("\n")) {
        const p = l.trim().split(/\s+/);
        if (p[1] === String(process.pid) && /workerd/.test(p[3] ?? "") && Number(p[2]) > 2.1 * 1024 * 1024) { console.log(`  watchdog: killing workerd ${p[0]} at ${Math.round(Number(p[2]) / 1024)} MB`); process.kill(Number(p[0]), "SIGKILL"); }
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
}
const points = [["write", { rows: 100_000 }, null], ["readSheetsLast", { key: "rows-200000.xlsx" }, 200_000], ["read", { key: "rows-10000.xlsx" }, 10_000]];
for (const [w, params, n] of points) {
  const fixture = n ? await ensureXlsx(n) : undefined;
  const stop = { done: false };
  const wd = watchdog(stop);
  const r = await runInWorkerd(b.code, { workload: w, params, fixture });
  stop.done = true; await wd;
  const row = { id: `exceljs-stream.${w}`, variant: "shipped", bundleKiB: Math.round(b.bytes / 1024), n: n ?? params.rows, ok: !!r.ok, oom: r.oom ?? null, wallMs: r.wallMs, cpuS: r.cpuS, peakRssDeltaMB: r.peakRssDeltaMB, result: r.result, error: r.ok ? undefined : r.error?.slice(0, 300) };
  console.log(`  ${w} n=${row.n} ${row.ok ? "ok" : "FAIL"} ${row.wallMs} ms cpu ${row.cpuS} s rss+${row.peakRssDeltaMB} MB${row.ok ? "" : " " + row.error}`);
  appendFileSync(OUT, JSON.stringify(row) + "\n");
}
