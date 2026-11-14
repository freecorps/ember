// S2 in production (docs/spikes/remote/latency-protocol.md §2, P2): does a read wait for someone else's write to be
// confirmed (the output gate)? One Worker with two Durable Object classes:
//   G       the "shard": a SQLite table, a writer loop at R writes/s (SQL, KV put, or KV put with allowUnconfirmed),
//           and reads answered over a WebSocket (`q`) and over RPC from the Worker (the HTTP path of Ember).
//   Prober  a client inside Cloudflare (near G): sequential reads, one in flight, timing each round trip.
//
//   POST /writer?g=NAME&rate=R&mode=sql|kv|kvu   start (rate 0: stop) the writer loop in G
//   POST /probe?g=NAME&n=N&via=ws|rpc            Prober: N sequential reads, returns the latencies
//   GET  /where?g=NAME                           colos of the Worker, G and the Prober
// Everything needs `Authorization: Bearer <BENCH_TOKEN>`.
import { DurableObject } from "cloudflare:workers";

const traceColo = async () => /colo=(\w+)/.exec(await (await fetch("https://www.cloudflare.com/cdn-cgi/trace")).text())?.[1] ?? null;

export class G extends DurableObject {
  timer = null;
  writes = 0;
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT)");
  }
  read() {
    const r = this.ctx.storage.sql.exec("SELECT id, v FROM t ORDER BY id DESC LIMIT 10").toArray();
    return { n: r.length, writes: this.writes };
  }
  async colo() {
    return (this._colo ??= await traceColo());
  }
  writer(rate, mode) {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (!rate) return { stopped: true, writes: this.writes };
    const body = "x".repeat(64);
    this.timer = setInterval(() => {
      this.writes++;
      if (mode === "sql") this.ctx.storage.sql.exec("INSERT INTO t (v) VALUES (?)", body);
      else if (mode === "kv") this.ctx.storage.put(`k${this.writes % 1000}`, body);
      else this.ctx.storage.put(`k${this.writes % 1000}`, body, { allowUnconfirmed: true });
    }, 1000 / rate);
    return { started: true, rate, mode };
  }
  async fetch(req) {
    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return new Response("?", { status: 404 });
  }
  webSocketMessage(ws, msg) {
    ws.send(JSON.stringify({ id: String(msg), ...this.read() }));
  }
}

export class Prober extends DurableObject {
  async colo() {
    return (this._colo ??= await traceColo());
  }
  async probe(env, g, n, via) {
    const stub = this.env.G.get(this.env.G.idFromName(g));
    const lat = [];
    if (via === "rpc") {
      for (let i = 0; i < n; i++) {
        const t = Date.now();
        await stub.read();
        lat.push(Date.now() - t);
      }
    } else {
      const res = await stub.fetch("https://g/ws", { headers: { upgrade: "websocket" } });
      const ws = res.webSocket;
      ws.accept();
      let resolve;
      ws.addEventListener("message", () => resolve());
      for (let i = 0; i < n; i++) {
        const t = Date.now();
        await new Promise((r) => {
          resolve = r;
          ws.send(String(i));
        });
        lat.push(Date.now() - t);
      }
      ws.close(1000, "done");
    }
    return { colo: await this.colo(), lat };
  }
}

export default {
  async fetch(req, env) {
    if (req.headers.get("authorization") !== `Bearer ${env.BENCH_TOKEN}`) return new Response("no", { status: 401 });
    const url = new URL(req.url);
    const g = url.searchParams.get("g") ?? "g";
    const gs = env.G.get(env.G.idFromName(g));
    const prober = env.PROBER.get(env.PROBER.idFromName(`p-${g}`));
    if (url.pathname === "/writer") return Response.json(await gs.writer(Number(url.searchParams.get("rate") ?? 0), url.searchParams.get("mode") ?? "sql"));
    if (url.pathname === "/probe") return Response.json(await prober.probe(null, g, Number(url.searchParams.get("n") ?? 200), url.searchParams.get("via") ?? "ws"));
    if (url.pathname === "/where") return Response.json({ worker: req.cf?.colo ?? null, g: await gs.colo(), prober: await prober.colo() });
    return new Response("not found", { status: 404 });
  },
};
