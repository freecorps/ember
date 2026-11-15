// node node-ref.mjs <entry> <workload> <params-json>: runs src/<entry>.js's workload in Node with an fs-backed
// `env.FILES`, prints {ok, wallMs, cpuS, peakRssDeltaMB, result}.
import { createReadStream, readFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { FIXTURES } from "./harness.mjs";

const [entry, workload, paramsJson] = process.argv.slice(2);
const mod = (await import(`./src/${entry}.js`)).default;
const env = {
  FILES: {
    async get(key) {
      const p = join(FIXTURES, key);
      return { body: Readable.toWeb(createReadStream(p)), arrayBuffer: async () => { const b = readFileSync(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); } };
    },
  },
};
globalThis.gc?.();
const base = process.memoryUsage().rss;
const cpu0 = process.cpuUsage();
const t0 = performance.now();
let out;
try {
  out = { ok: true, result: await mod.workloads[workload](env, JSON.parse(paramsJson)) };
} catch (e) {
  out = { ok: false, error: String(e?.stack ?? e).slice(0, 600) };
}
const cpu = process.cpuUsage(cpu0);
out.wallMs = Math.round(performance.now() - t0);
out.cpuS = +((cpu.user + cpu.system) / 1e6).toFixed(2);
// maxRSS is in KiB; the delta is against the RSS after imports (same baseline as the workerd run).
out.peakRssDeltaMB = Math.round((process.resourceUsage().maxRSS * 1024 - base) / 1048576);
console.log(JSON.stringify(out));
