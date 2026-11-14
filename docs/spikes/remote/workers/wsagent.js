// S1 in production: subscribers for ../workers/wsbench.js, held by Durable Object agents inside Cloudflare (5 sockets
// per agent: the simultaneous-connection limit per invocation is 6). Each agent opens its sockets with or without
// `Sec-WebSocket-Extensions: permessage-deflate` (the fetch upgrade sends no offer unless asked), keeps them for
// `holdMs`, and reports what the 101 said, how many frames arrived and whether every one parsed.
//
//   POST /run  (Authorization: Bearer <LOADGEN_TOKEN>)  { target, tasks: [{ room, sockets, offer, holdMs }] }
import { DurableObject } from "cloudflare:workers";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function colo() {
  try {
    return /colo=(\w+)/.exec(await (await fetch("https://www.cloudflare.com/cdn-cgi/trace")).text())?.[1] ?? null;
  } catch {
    return null;
  }
}

export class Agent extends DurableObject {
  async run(target, task) {
    const where = await colo();
    const stats = { frames: 0, chars: 0, badJson: 0, closed: 0 };
    const ext = {};
    const sockets = [];
    try {
      for (let i = 0; i < task.sockets; i++) {
        const headers = { Upgrade: "websocket" };
        if (task.offer) headers["Sec-WebSocket-Extensions"] = "permessage-deflate; client_max_window_bits";
        const res = await fetch(`${target}/ws?room=${encodeURIComponent(task.room)}`, { headers });
        const ws = res.webSocket;
        if (!ws) throw new Error(`upgrade failed: ${res.status}`);
        const e = res.headers.get("sec-websocket-extensions") ?? "(none)";
        ext[e] = (ext[e] ?? 0) + 1;
        ws.accept();
        ws.addEventListener("message", (ev) => {
          stats.frames++;
          const s = typeof ev.data === "string" ? ev.data : "";
          stats.chars += s.length;
          if (stats.frames % 97 === 0) {
            try {
              JSON.parse(s);
            } catch {
              stats.badJson++;
            }
          }
        });
        ws.addEventListener("close", () => stats.closed++);
        sockets.push(ws);
      }
      await sleep(task.holdMs);
      return { ok: true, colo: where, sockets: sockets.length, ext, ...stats };
    } catch (e) {
      return { ok: false, colo: where, sockets: sockets.length, ext, ...stats, failed: String(e && e.stack ? e.stack : e) };
    } finally {
      for (const ws of sockets) {
        try {
          ws.close(1000, "done");
        } catch {}
      }
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.headers.get("authorization") !== `Bearer ${env.LOADGEN_TOKEN}`) return new Response("no", { status: 401 });
    if (url.pathname !== "/run" || request.method !== "POST") return new Response("not found", { status: 404 });
    const { target, tasks, prefix } = await request.json();
    const results = await Promise.all(
      tasks.map((task, i) =>
        env.AGENT.get(env.AGENT.idFromName(`${prefix ?? "a"}-${i}`))
          .run(target, task)
          .catch((e) => ({ ok: false, failed: String(e) })),
      ),
    );
    return Response.json({ results, coordinator: request.cf?.colo ?? null });
  },
};
