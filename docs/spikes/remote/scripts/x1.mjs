import WebSocket from "ws";
import { writeFileSync } from "node:fs";
import { B, WSB, pct, sleep, now } from "../lib/stats.mjs";
const [mode, batchN, clients, window, secs] = [process.argv[2], Number(process.argv[3]), Number(process.argv[4]), Number(process.argv[5]), Number(process.argv[6] ?? 20)];
const NAME = `x1-${mode}-${batchN}-${Date.now()}`;
const open = () => new Promise((res, rej) => { const ws = new WebSocket(`${WSB}/d/${NAME}/ws`, { perMessageDeflate: false }); ws.on("open", () => res(ws)); ws.on("error", rej); });
await fetch(`${B}/d/${NAME}/q`);
const socks = await Promise.all(Array.from({ length: clients }, open));
let acked = 0, msgs = 0, stop = false, c = 0;
const lat = [];
const perSec = [];
const start = now();
for (const ws of socks) {
  const sent = new Map();
  const send = () => { if (stop) return; const id = c++; sent.set(id, now()); ws.send(JSON.stringify(mode === "b" ? { op: "mutb", n: batchN, c: id } : { op: "mut1", c: id })); };
  ws.on("message", (d) => { const m = JSON.parse(d); if (m.t !== "ack") return; msgs++; acked += mode === "b" ? batchN : 1; if (lat.length < 200000) lat.push(now() - sent.get(m.c)); sent.delete(m.c); send(); });
  for (let i = 0; i < window; i++) send();
}
let prev = 0;
const iv = setInterval(() => { perSec.push(acked - prev); prev = acked; }, 1000);
await sleep(secs * 1000);
stop = true; clearInterval(iv);
const elapsed = (now() - start) / 1000;
await sleep(3000);
const stats = await (await fetch(`${B}/d/${NAME}/stats`)).json();
const steady = perSec.slice(3);
const r = { name: NAME, mode: mode === "b" ? `batched ${batchN}/transactionSync` : "1 mutation/message", clients, windowPerClient: window, inFlightMsgs: clients * window, secs: Math.round(elapsed),
  mutationsPerSecAvg: Math.round(acked / elapsed), steadyPerSec: pct(steady), msgsPerSec: Math.round(msgs / elapsed), ackLatencyMs: pct(lat), rowsInDb: stats.docs, dbSize: stats.size };
console.log(JSON.stringify(r));
writeFileSync(new URL(`../evidence/x1-${mode}-${batchN}-${clients}x${window}.json`, import.meta.url), JSON.stringify({ ...r, perSec }, null, 2));
socks.forEach((s) => s.terminate());
process.exit(0);
