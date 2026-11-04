import WebSocket from "ws";
import { writeFileSync } from "node:fs";
import { B, WSB, pct, sleep, now } from "../lib/stats.mjs";
const out = {};
const log = (k, v) => { out[k] = v; console.log(k, JSON.stringify(v)); };
async function http(path) { const t = now(); const r = await fetch(B + path); const j = await r.json(); return { ms: now() - t, j, colo: r.headers.get("x-worker-colo") }; }
const targets = [["default(MIA)", "def1", ""], ["hint-sam(EWR)", "h-sam", "?hint=sam"], ["hint-sam(MIA)", "samx2", "?hint=sam"]];
await http("/ping");
for (const [label, name, qs] of targets) {
  const info = (await http(`/d/${name}/info${qs}`)).j;
  const q = [], m = [], ms = [], syncMs = [], colos = {};
  for (let i = 0; i < 100; i++) { const r = await http(`/d/${name}/q${qs}`); q.push(r.ms); colos[r.colo] = (colos[r.colo] ?? 0) + 1; }
  for (let i = 0; i < 100; i++) { const r = await http(`/d/${name}/m${qs}`); m.push(r.ms); }
  for (let i = 0; i < 50; i++) { const r = await http(`/d/${name}/m${qs}${qs ? "&" : "?"}sync=1`); ms.push(r.ms); syncMs.push(r.j.syncMs); }
  const wr = (await http(`/d/${name}/wrtt${qs}${qs ? "&" : "?"}n=30`)).j;
  const pingOnly = []; for (let i = 0; i < 30; i++) pingOnly.push((await http("/ping")).ms);
  log(label, { doColo: info.doColo, workerColos: colos, httpQuery: pct(q), httpMutation: pct(m), httpMutationExplicitSync: pct(ms), serverSyncMs: pct(syncMs), workerToDoRtt: pct(wr.ts.slice(1)), workerOnlyPing: pct(pingOnly) });
}
// WebSocket mutation->ack and ->patch on second socket
const open = (name) => new Promise((res, rej) => { const ws = new WebSocket(`${WSB}/d/${name}/ws`); ws.on("open", () => res(ws)); ws.on("error", rej); });
for (const [label, name] of [["default(MIA)", "def1"], ["hint-sam(EWR)", "h-sam"]]) {
  const a = await open(name), b = await open(name);
  const pend = new Map();
  a.on("message", (d) => { const m = JSON.parse(d); if (m.t === "ack") pend.get(m.c).ack = now(); });
  b.on("message", (d) => { const m = JSON.parse(d); if (m.t === "patch" && pend.has(m.c)) { const p = pend.get(m.c); p.patch = now(); p.done(); } });
  const ack = [], patch = [];
  for (let c = 0; c < 100; c++) {
    await new Promise((done) => { const t0 = now(); pend.set(c, { t0, done }); a.send(JSON.stringify({ op: "mut", c })); });
    const p = pend.get(c); ack.push(p.ack - p.t0); patch.push(p.patch - p.t0);
  }
  log("ws:" + label, { mutationToAck: pct(ack), mutationToPatchOnOtherSocket: pct(patch) });
  // idle hibernation test on open socket
  out["_sockets_" + name] = [a, b];
}
// cold wake: new DO name idle; plus hibernated socket wake
const cold = "cold-" + Date.now();
await http(`/d/${cold}/q`);
const warm = []; for (let i = 0; i < 5; i++) warm.push((await http(`/d/${cold}/q`)).ms);
console.log("idle 75s...");
await sleep(75000);
const afterIdle = await http(`/d/${cold}/info`);
const [a] = out["_sockets_def1"];
const t0 = now();
const pong = await new Promise((res) => { a.once("message", () => res(now() - t0)); a.send(JSON.stringify({ op: "ping", c: 1 })); });
const warm2 = []; for (let i = 0; i < 5; i++) warm2.push((await http(`/d/${cold}/q`)).ms);
log("coldWake", { warmQueryBefore: pct(warm), firstRequestAfter75sIdle: Math.round(afterIdle.ms), bootAgeMsAtThatRequest: afterIdle.j.bootAgeMs, wsPingAfter75sIdleMs: Math.round(pong), warmQueryAfter: pct(warm2) });
for (const k of Object.keys(out)) if (k.startsWith("_")) { out[k].forEach((w) => w.close()); delete out[k]; }
writeFileSync(new URL("../evidence/r8.json", import.meta.url), JSON.stringify(out, null, 2));
process.exit(0);
