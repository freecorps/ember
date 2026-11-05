// Load generator for the multi-shard benchmark (docs/spikes/remote/bench.md). Deployed as `ember-spike-ops-loadgen`
// next to the target project; every agent is a Durable Object (its own isolate, CPU and subrequest budget) that
// drives the target Ember Worker over its public workers.dev URL, so the numbers are not bounded by a laptop's link.
//
// POST /run  (Authorization: Bearer <LOADGEN_TOKEN>)  { target, tasks: Task[] } → { results: TaskResult[] }
// Task kinds (all run concurrently, each on its own agent):
//   mut    { shard, sockets, window, durationMs, bodyBytes }     pipelined `mut` frames, ack latency (send → mres)
//   subq   { shard, sockets, window, durationMs }                `sub` → `snap` → `unsub` cycles over WebSockets
//   query  { shard, concurrency, durationMs, maxRequests }       POST /api/query (HTTP one-shot)
//   fanSub { shard, sockets, durationMs }                        subscribers of bench:latest; patch age vs. sentAt
//   fanPut { shard, writes, intervalMs, startDelayMs }           one writer: bench:put with sentAt = Date.now()
// Latencies are wall-clock ms (Date.now() advances with I/O, so a receive event reads the current time).

import { DurableObject } from "cloudflare:workers";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SAMPLE_CAP = 20000;

function sampler() {
  const xs = [];
  let n = 0;
  return {
    add(v) {
      n++;
      if (xs.length < SAMPLE_CAP) xs.push(v);
      else {
        const j = Math.floor(Math.random() * n);
        if (j < SAMPLE_CAP) xs[j] = v;
      }
    },
    get count() {
      return n;
    },
    values: xs,
  };
}

async function openSocket(target, shard) {
  const url = `${target}/ws?shard=${encodeURIComponent(shard)}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20000);
  const res = await fetch(url, { headers: { Upgrade: "websocket" }, signal: ac.signal }).finally(() => clearTimeout(timer));
  const ws = res.webSocket;
  if (!ws) throw new Error(`upgrade failed: ${res.status} ${await res.text().catch(() => "")}`);
  ws.accept();
  return ws;
}

function hello(ws, clientId) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("no ready")), 15000);
    const on = (e) => {
      const m = JSON.parse(e.data);
      if (m.t === "ready") {
        clearTimeout(t);
        ws.removeEventListener("message", on);
        resolve(m);
      }
    };
    ws.addEventListener("message", on);
    ws.send(JSON.stringify({ t: "hello", clientId, protocol: 1 }));
  });
}

async function runMut(target, task) {
  const lat = sampler();
  let errors = 0;
  let sent = 0;
  const firstError = [];
  const end = Date.now() + task.durationMs;
  const body = "x".repeat(task.bodyBytes ?? 64);
  const t0 = Date.now();
  await Promise.all(
    Array.from({ length: task.sockets }, async (_, s) => {
      const ws = await openSocket(target, task.shard);
      await hello(ws, `lg-${task.shard}-${s}-${crypto.randomUUID().slice(0, 8)}`);
      const inflight = new Map();
      let seq = 0;
      let done;
      const finished = new Promise((r) => (done = r));
      const pump = () => {
        while (inflight.size < task.window && Date.now() < end) {
          const mid = `${s}.${seq++}`;
          inflight.set(mid, Date.now());
          sent++;
          ws.send(JSON.stringify({ t: "mut", mid, fn: "bench:put", args: { n: seq, sentAt: Date.now(), body } }));
        }
        if (!inflight.size && Date.now() >= end) done();
      };
      ws.addEventListener("message", (e) => {
        if (e.data === "pong") return;
        const m = JSON.parse(e.data);
        if (m.t !== "mres") return;
        const at = inflight.get(m.mid);
        if (at === undefined) return;
        inflight.delete(m.mid);
        if (m.ok) lat.add(Date.now() - at);
        else {
          errors++;
          if (firstError.length < 3) firstError.push(m.error);
        }
        pump();
      });
      ws.addEventListener("close", () => done());
      pump();
      await Promise.race([finished, sleep(task.durationMs + 30000)]);
      try {
        ws.close(1000, "done");
      } catch {}
    }),
  );
  return { kind: "mut", shard: task.shard, sent, ok: lat.count, errors, firstError, wallMs: Date.now() - t0, lat: lat.values };
}

async function runSubq(target, task) {
  const lat = sampler();
  let errors = 0;
  const end = Date.now() + task.durationMs;
  const t0 = Date.now();
  await Promise.all(
    Array.from({ length: task.sockets }, async (_, s) => {
      const ws = await openSocket(target, task.shard);
      await hello(ws, `lq-${task.shard}-${s}-${crypto.randomUUID().slice(0, 8)}`);
      const inflight = new Map();
      let seq = 0;
      let done;
      const finished = new Promise((r) => (done = r));
      const pump = () => {
        while (inflight.size < task.window && Date.now() < end) {
          const qid = `${s}.${seq++}`;
          inflight.set(qid, Date.now());
          // Distinct args per cycle: never served from another subscriber's cached result.
          ws.send(JSON.stringify({ t: "sub", qid, fn: "bench:recent", args: { limit: 10, salt: seq } }));
        }
        if (!inflight.size && Date.now() >= end) done();
      };
      ws.addEventListener("message", (e) => {
        if (e.data === "pong") return;
        const m = JSON.parse(e.data);
        if ((m.t !== "snap" && m.t !== "err") || m.qid === undefined) return;
        const at = inflight.get(m.qid);
        if (at === undefined) return;
        inflight.delete(m.qid);
        ws.send(JSON.stringify({ t: "unsub", qid: m.qid }));
        if (m.t === "snap") lat.add(Date.now() - at);
        else errors++;
        pump();
      });
      ws.addEventListener("close", () => done());
      pump();
      await Promise.race([finished, sleep(task.durationMs + 30000)]);
      try {
        ws.close(1000, "done");
      } catch {}
    }),
  );
  return { kind: "subq", shard: task.shard, ok: lat.count, errors, wallMs: Date.now() - t0, lat: lat.values };
}

async function runQuery(target, task) {
  const lat = sampler();
  let errors = 0;
  let issued = 0;
  const firstError = [];
  const end = Date.now() + task.durationMs;
  const t0 = Date.now();
  await Promise.all(
    Array.from({ length: task.concurrency }, async () => {
      while (Date.now() < end && issued < task.maxRequests) {
        issued++;
        const t = Date.now();
        try {
          const r = await fetch(`${target}/api/query`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ fn: "bench:recent", args: { limit: 10 }, shard: task.shard }),
          });
          const b = await r.json();
          if (b.ok) lat.add(Date.now() - t);
          else {
            errors++;
            if (firstError.length < 3) firstError.push(b.error);
          }
        } catch (e) {
          errors++;
          if (firstError.length < 3) firstError.push(String(e));
        }
      }
    }),
  );
  return { kind: "query", shard: task.shard, ok: lat.count, errors, firstError, wallMs: Date.now() - t0, lat: lat.values };
}

async function runFanSub(target, task) {
  const lat = sampler();
  let patches = 0;
  const sockets = [];
  const t0 = Date.now();
  await Promise.all(
    Array.from({ length: task.sockets }, async (_, s) => {
      const ws = await openSocket(target, task.shard);
      await hello(ws, `fs-${task.shard}-${s}-${crypto.randomUUID().slice(0, 8)}`);
      ws.addEventListener("message", (e) => {
        if (e.data === "pong") return;
        const m = JSON.parse(e.data);
        if (m.t !== "patch") return;
        for (const c of m.changes) {
          const v = c.value;
          if (v && typeof v.sentAt === "number") {
            patches++;
            lat.add(Date.now() - v.sentAt);
          }
        }
      });
      ws.send(JSON.stringify({ t: "sub", qid: 1, fn: "bench:latest", args: {} }));
      sockets.push(ws);
    }),
  );
  const subscribedMs = Date.now() - t0;
  await sleep(Math.max(0, task.durationMs - subscribedMs));
  for (const ws of sockets) {
    try {
      ws.close(1000, "done");
    } catch {}
  }
  return { kind: "fanSub", shard: task.shard, sockets: sockets.length, patches, subscribedMs, lat: lat.values };
}

async function runFanPut(target, task) {
  await sleep(task.startDelayMs ?? 0);
  const ws = await openSocket(target, task.shard);
  await hello(ws, `fp-${task.shard}-${crypto.randomUUID().slice(0, 8)}`);
  const ack = sampler();
  const pending = new Map();
  ws.addEventListener("message", (e) => {
    if (e.data === "pong") return;
    const m = JSON.parse(e.data);
    if (m.t === "mres" && pending.has(m.mid)) {
      ack.add(Date.now() - pending.get(m.mid));
      pending.delete(m.mid);
    }
  });
  for (let i = 0; i < task.writes; i++) {
    const mid = `w${i}`;
    pending.set(mid, Date.now());
    ws.send(JSON.stringify({ t: "mut", mid, fn: "bench:put", args: { n: i, sentAt: Date.now(), body: "fan" } }));
    await sleep(task.intervalMs);
  }
  await sleep(2000);
  try {
    ws.close(1000, "done");
  } catch {}
  return { kind: "fanPut", shard: task.shard, writes: task.writes, ok: ack.count, lat: ack.values };
}

async function colo() {
  try {
    const t = await (await fetch("https://cloudflare.com/cdn-cgi/trace")).text();
    return /colo=(\w+)/.exec(t)?.[1] ?? null;
  } catch {
    return null;
  }
}

export class Agent extends DurableObject {
  async run(target, task) {
    const where = await colo();
    const runners = { mut: runMut, subq: runSubq, query: runQuery, fanSub: runFanSub, fanPut: runFanPut };
    try {
      return { ...(await runners[task.kind](target, task)), colo: where };
    } catch (e) {
      return { kind: task.kind, shard: task.shard, failed: String(e && e.stack ? e.stack : e), colo: where };
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.headers.get("authorization") !== `Bearer ${env.LOADGEN_TOKEN}`) return new Response("no", { status: 401 });
    if (url.pathname !== "/run" || request.method !== "POST") return new Response("not found", { status: 404 });
    const { target, tasks, hint } = await request.json();
    const results = await Promise.all(
      tasks.map((task, i) => {
        const id = env.AGENT.idFromName(`${task.agent ?? i}`);
        const stub = hint ? env.AGENT.get(id, { locationHint: hint }) : env.AGENT.get(id);
        return stub.run(target, task).catch((e) => ({ kind: task.kind, shard: task.shard, failed: String(e) }));
      }),
    );
    return Response.json({ results, coordinator: request.cf?.colo ?? null });
  },
};
