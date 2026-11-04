import WebSocket from "ws";
import { writeFileSync } from "node:fs";
import { B, WSB, pct, sleep, now } from "../lib/stats.mjs";
const NAME = process.argv[2] ?? `wsmax-${Date.now()}`;
const steps = (process.argv[3] ?? "1000,5000,10000").split(",").map(Number);
const out = { name: NAME, steps: [] };
const socks = [];
let recvHandler = null;
const errors = {};
function openOne() {
  return new Promise((res) => {
    const ws = new WebSocket(`${WSB}/d/${NAME}/ws`, { perMessageDeflate: false, handshakeTimeout: 30000 });
    ws.on("open", () => { socks.push(ws); res(true); });
    ws.on("message", (d) => recvHandler?.(ws, d));
    ws.on("error", (e) => { const k = String(e.code ?? e.message).slice(0, 120); errors[k] = (errors[k] ?? 0) + 1; res(false); });
    ws.on("unexpected-response", (req, r) => { const k = "http " + r.statusCode; errors[k] = (errors[k] ?? 0) + 1; res(false); });
    ws.on("close", (code, reason) => { if (ws._opened) { const k = "close " + code + " " + reason; errors[k] = (errors[k] ?? 0) + 1; } });
    ws.once("open", () => (ws._opened = true));
  });
}
async function openMany(n, conc = 100) {
  let ok = 0, fail = 0, i = 0;
  const t0 = now();
  await Promise.all(Array.from({ length: conc }, async () => { while (i < n) { i++; (await openOne()) ? ok++ : fail++; } }));
  return { ok, fail, ms: Math.round(now() - t0) };
}
async function bcast(size, seq) {
  const alive = socks.filter((s) => s.readyState === 1);
  const got = new Set();
  const t0 = now();
  let last = 0;
  const done = new Promise((res) => {
    recvHandler = (ws, d) => { const s = d.toString(); if (s.includes(`"seq":${seq},`)) { got.add(ws); last = now() - t0; if (got.size === alive.length) res(); } };
    setTimeout(res, 20000);
  });
  const r = await (await fetch(`${B}/d/${NAME}/bcast?size=${size}&seq=${seq}`)).json();
  const httpMs = now() - t0;
  await done;
  return { alive: alive.length, received: got.size, server: r, httpRttMs: Math.round(httpMs), lastReceivedMs: Math.round(last) };
}
let seq = 0;
for (const target of steps) {
  const need = target - socks.length;
  const o = await openMany(need);
  await sleep(2000);
  const count = await (await fetch(`${B}/d/${NAME}/wscount`)).json();
  const b32 = await bcast(32, ++seq);
  const b1k = await bcast(1024, ++seq);
  const rec = { target, open: o, serverCount: count, bcast32: b32, bcast1k: b1k, errorsSoFar: { ...errors } };
  out.steps.push(rec); console.log(JSON.stringify(rec));
  if (o.fail > 0) { console.log("stopping at first failures"); break; }
}
// hibernation check: idle 15s then broadcast again
await sleep(15000);
const after = await bcast(32, ++seq);
out.afterIdle15s = after; console.log("afterIdle15s", JSON.stringify(after));
writeFileSync(new URL(`../evidence/r4-${NAME}.json`, import.meta.url), JSON.stringify(out, null, 2));
const t = now();
await fetch(`${B}/d/${NAME}/wsclose`).catch(() => {});
socks.forEach((s) => { try { s.terminate(); } catch {} });
console.log("closed in", Math.round(now() - t));
process.exit(0);
