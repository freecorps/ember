import { env, SELF } from "cloudflare:test";
import { decodeServerMessage, encodeClientMessage, type ClientMessage, type ServerMessage } from "../src/protocol.ts";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function shardStub(name: string) {
  return env.SHARD.get(env.SHARD.idFromName(name));
}

export interface Client {
  ws: WebSocket;
  frames: ServerMessage[];
  raw: string[];
  /** Sizes of the array frames received (feature "batch"). */
  batches: number[];
  send(m: ClientMessage | string): void;
  /** Resolves with the first frame (seen from `from` onward) matching pred. */
  waitFor<T extends ServerMessage = ServerMessage>(pred: (m: ServerMessage) => boolean, timeoutMs?: number): Promise<T>;
  close(): void;
}

export async function connect(shard: string, opts: { token?: string } = {}): Promise<Client> {
  const qs = new URLSearchParams({ shard });
  if (opts.token) qs.set("token", opts.token);
  const res = await SELF.fetch(`http://ember/ws?${qs}`, { headers: { Upgrade: "websocket" } });
  if (!res.webSocket) throw new Error(`upgrade failed: ${res.status} ${await res.text()}`);
  const ws = res.webSocket;
  ws.accept();
  const frames: ServerMessage[] = [];
  const raw: string[] = [];
  const batches: number[] = [];
  const waiters: Array<{ pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void; seen: number }> = [];
  ws.addEventListener("message", (e) => {
    const text = String(e.data);
    raw.push(text);
    if (text === "pong") return;
    // Feature "batch": an array frame carries several messages, in order.
    const list = text.startsWith("[") ? (JSON.parse(text) as unknown[]).map((x) => decodeServerMessage(JSON.stringify(x))) : [decodeServerMessage(text)];
    if (list.length > 1) batches.push(list.length);
    for (const m of list) {
      frames.push(m);
      for (const w of [...waiters]) {
        if (w.pred(m)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(m);
        }
      }
    }
  });
  return {
    ws,
    frames,
    raw,
    batches,
    send: (m) => ws.send(typeof m === "string" ? m : encodeClientMessage(m)),
    waitFor<T extends ServerMessage>(pred: (m: ServerMessage) => boolean, timeoutMs = 3000): Promise<T> {
      const hit = frames.find(pred);
      if (hit) {
        frames.splice(frames.indexOf(hit), 1);
        return Promise.resolve(hit as T);
      }
      return new Promise<T>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timeout waiting for frame; got ${JSON.stringify(frames)}`)), timeoutMs);
        waiters.push({
          pred,
          seen: frames.length,
          resolve: (m) => {
            clearTimeout(t);
            frames.splice(frames.indexOf(m), 1);
            resolve(m as T);
          },
        });
      });
    },
    close: () => ws.close(1000, "done"),
  };
}

export async function hello(c: Client, clientId = crypto.randomUUID(), token?: string, features?: string[]) {
  const msg: ClientMessage = { t: "hello", clientId, protocol: 1, ...(token ? { token } : {}), ...(features ? { features } : {}) };
  c.send(msg);
  return c.waitFor<Extract<ServerMessage, { t: "ready" }>>((m) => m.t === "ready");
}

export const is =
  <K extends ServerMessage["t"]>(t: K, extra: (m: Extract<ServerMessage, { t: K }>) => boolean = () => true) =>
  (m: ServerMessage) =>
    m.t === t && extra(m as Extract<ServerMessage, { t: K }>);

export async function api(path: "query" | "mutation", body: unknown, token?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await SELF.fetch(`http://ember/api/${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as any };
}
