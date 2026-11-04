import WebSocket from "ws";
import { writeFileSync } from "node:fs";
import { B, WSB, pct, sleep, now } from "../lib/stats.mjs";
const out = {};
const log = (k, v) => { out[k] = v; console.log(k, JSON.stringify(v)); };
async function http(path) { const t = now(); const r = await fetch(B + path); const j = await r.json(); return { ms: now() - t, j }; }
const open = (name) => new Promise((res, rej) => { const ws = new WebSocket(`${WSB}/d/${name}/ws`); ws.on("open", () => res(ws)); ws.on("error", rej); });
const keep = [];
for (const [label, name] of [["default(MIA)", "def1"], ["hint-sam(EWR)", "h-sam"]]) {
  const a = await open(name), b = await open(name);
  const pend = new Map();
  const chk = (p) => { if (p.ack && p.patch) p.done(); };
  a.on("message", (d) => { const m = JSON.parse(d); if (m.t === "ack") { const p = pend.get(m.c); p.ack = now(); chk(p); } });
  b.on("message", (d) => { const m = JSON.parse(d); if (m.t === "patch" && pend.has(m.c)) { const p = pend.get(m.c); p.patch = now(); chk(p); } });
  const ack = [], patch = [], ackFirst = { ack: 0, patch: 0 };
  for (let c = 0; c < 100; c++) {
    await new Promise((done) => { pend.set(c, { t0: now(), done }); a.send(JSON.stringify({ op: "mut", c })); });
    const p = pend.get(c); ack.push(p.ack - p.t0); patch.push(p.patch - p.t0); ackFirst[p.ack <= p.patch ? "ack" : "patch"]++;
  }
  const ping = [];
  for (let c = 0; c < 50; c++) { const t0 = now(); await new Promise((r) => { a.once("message", r); a.send(JSON.stringify({ op: "ping", c })); }); ping.push(now() - t0); }
  log("ws:" + label, { mutationToAck: pct(ack), mutationToPatchOnOtherSocket: pct(patch), firstArrival: ackFirst, wsPingNoWrite: pct(ping) });
  keep.push(a, b);
}
// cold wake: 4 fresh DOs in parallel, plus a socket idle for 75s
const names = [0, 1, 2, 3].map((i) => `cold${i}-${Date.now()}`);
await Promise.all(names.map((n) => http(`/d/${n}/q`)));
console.log("idle 75s...");
await sleep(75000);
const first = await Promise.all(names.map((n) => http(`/d/${n}/info`)));
const second = await Promise.all(names.map((n) => http(`/d/${n}/q`)));
const t0 = now();
const pong = await new Promise((res) => { keep[0].once("message", () => res(now() - t0)); keep[0].send(JSON.stringify({ op: "ping", c: 1 })); });
const ping2 = []; for (let i = 0; i < 5; i++) { const t = now(); await new Promise((r) => { keep[0].once("message", r); keep[0].send(JSON.stringify({ op: "ping", c: 1 })); }); ping2.push(now() - t); }
log("coldWake", { firstRequestAfter75sIdle: first.map((r) => Math.round(r.ms)), bootAgeMs: first.map((r) => r.j.bootAgeMs), immediatelyAfter: second.map((r) => Math.round(r.ms)), hibernatedSocketFirstPingMs: Math.round(pong), subsequentPings: pct(ping2) });
keep.forEach((w) => w.close());
writeFileSync(new URL("../evidence/r8-ws-cold.json", import.meta.url), JSON.stringify(out, null, 2));
process.exit(0);
