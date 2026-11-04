import { writeFileSync } from "node:fs";
import { B, sleep, now } from "../lib/stats.mjs";
async function http(path) { const t = now(); const r = await fetch(B + path); const j = await r.json(); return { ms: Math.round(now() - t), j }; }
const names = [0, 1, 2, 3, 4, 5].map((i) => `cw${i}-${Date.now()}`);
const create = [];
for (const n of names) create.push((await http(`/d/${n}/wrtt?n=3`)).j.ts);
console.log("created (worker-side first stub.fetch incl. DO creation):", JSON.stringify(create));
console.log("idle 75s..."); await sleep(75000);
const res = [];
for (const n of names) {
  const ping = (await http(`/ping`)).ms; // re-warm TLS + worker
  const w = (await http(`/d/${n}/wrtt?n=3`)).j;
  const client = (await http(`/d/${n}/q`)).ms;
  res.push({ pingFirst: ping, workerSideStubFetchMs: w.ts, clientWarmAfter: client });
}
console.log(JSON.stringify(res));
writeFileSync(new URL("../evidence/r8-coldwake-controlled.json", import.meta.url), JSON.stringify({ create, afterIdle75s: res }, null, 2));
