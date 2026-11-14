// S1 in production (docs/spikes/remote/latency-protocol.md): a Worker + a Durable Object that only broadcasts to its
// hibernatable sockets. Deployed twice, with the default compatibility flags (`ember-spike-lat-ws`) and with
// `no_web_socket_compression` (`ember-spike-lat-ws-nocomp`); the shard-side CPU comes from the account analytics.
//
//   GET  /ws?room=R              upgrade (headers forwarded like packages/runtime/src/worker.ts)
//   POST /prepare?room=R&size=B  build 200 frames of ~B bytes (rowdiff-like JSON), outside the measured window
//   POST /broadcast?room=R&reps=K send K frames to every socket of the room (cycling the prepared frames)
//   GET  /seen?room=R            sockets, offers the DO saw, the DO colo
// Every path but /ws needs `Authorization: Bearer <BENCH_TOKEN>`.
import { DurableObject } from "cloudflare:workers";

const words = "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua".split(" ");
let seed = 1;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
function doc(i) {
  let body = "";
  for (let k = 0; k < 8; k++) body += words[Math.floor(rnd() * words.length)] + " ";
  return { _id: "k" + Math.floor(rnd() * 1e15).toString(36) + Math.floor(rnd() * 1e15).toString(36), _creationTime: 1763100000000 + Math.floor(rnd() * 1e9), n: i, body };
}
function frame(size, v) {
  const rows = [];
  for (let i = 0; ; i++) {
    rows.push({ i, v: doc(i) });
    const s = JSON.stringify({ t: "patch", version: v, changes: [{ qid: "q1", rows }], mids: [] });
    if (s.length >= size) return s;
  }
}

export class Room extends DurableObject {
  seen = [];
  frames = [];
  next = 0;
  colo = null;
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      if (this.seen.length < 50) this.seen.push(req.headers.get("sec-websocket-extensions") ?? "");
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1], ["sub"]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (url.pathname === "/prepare") {
      const size = Number(url.searchParams.get("size") ?? 415);
      this.frames = [];
      for (let r = 0; r < 200; r++) this.frames.push(frame(size, r));
      return Response.json({ bytes: this.frames[0].length });
    }
    if (url.pathname === "/broadcast") {
      const reps = Number(url.searchParams.get("reps") ?? 1);
      const socks = this.ctx.getWebSockets("sub");
      for (let r = 0; r < reps; r++) {
        const f = this.frames[this.next++ % this.frames.length];
        for (const ws of socks) {
          try {
            ws.send(f);
          } catch {}
        }
      }
      return Response.json({ sockets: socks.length, sent: socks.length * reps });
    }
    if (url.pathname === "/seen") {
      this.colo ??= /colo=(\w+)/.exec(await (await fetch("https://www.cloudflare.com/cdn-cgi/trace")).text())?.[1] ?? null;
      const offers = {};
      for (const s of this.seen) offers[s || "(none)"] = (offers[s || "(none)"] ?? 0) + 1;
      return Response.json({ sockets: this.ctx.getWebSockets("sub").length, offers, colo: this.colo });
    }
    if (url.pathname === "/close") {
      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.close(1000, "bye");
        } catch {}
      }
      this.seen = [];
      return Response.json({ ok: true });
    }
    return new Response("not found", { status: 404 });
  }
  webSocketMessage() {}
  webSocketClose(ws, code) {
    try {
      ws.close(code, "bye");
    } catch {}
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const room = url.searchParams.get("room") ?? "room";
    const stub = env.ROOM.get(env.ROOM.idFromName(room));
    if (url.pathname === "/ws") {
      if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("expected websocket", { status: 426 });
      const headers = new Headers(req.headers);
      return stub.fetch(new Request(url, { headers }));
    }
    if (req.headers.get("authorization") !== `Bearer ${env.BENCH_TOKEN}`) return new Response("no", { status: 401 });
    if (url.pathname === "/where") return Response.json({ workerColo: req.cf?.colo ?? null, offer: req.headers.get("sec-websocket-extensions") });
    return stub.fetch(req);
  },
};
