// Live logs (tail.ts): the dashboard Worker opens the tail session with its own token, relays filtered events as
// NDJSON, never hands the tail URL or the token to the browser, and deletes the session when the stream ends.
import { describe, expect, it } from "vitest";
import { tailRecord, type TailConnector, type TailEvent, type TailSocket } from "../src/tail.ts";
import { handleApi, type DashboardEnv } from "../src/worker.ts";
import { jobHistorySql, parseJobHistory } from "../src/metrics-sql.ts";
import { seeded } from "./helpers.ts";

const exec = (o: Record<string, unknown>) => `ember:exec ${JSON.stringify({ project: "chat", env: "prod", kind: "mutation", status: "ok", errorCode: "", durationMs: 3, rowsRead: 1, rowsWritten: 1, bytesOut: 10, ...o })}`;
const event = (logs: string[], extra: Partial<TailEvent> = {}): TailEvent => ({
  outcome: "ok",
  eventTimestamp: 1000,
  event: { request: { url: "https://ember-chat-prod.x.workers.dev/api/mutation?token=SECRET", method: "POST" } },
  logs: logs.map((m, i) => ({ message: [m], level: m.startsWith("boom") ? "error" : "log", timestamp: 1000 + i })),
  ...extra,
});

describe("tail records", () => {
  it("filters like ember logs and never keeps the request's query string", () => {
    const ev = event([exec({ fn: "messages:send", shard: "org:acme" }), exec({ fn: "rooms:list", shard: "org:beta", status: "error", errorCode: "Boom" }), "boom: something"]);
    const all = tailRecord(ev)!;
    expect(all.head).toBe("POST /api/mutation");
    expect(JSON.stringify(all)).not.toContain("SECRET");
    expect(all.lines.map((l) => l.kind)).toEqual(["exec", "exec", "log"]);
    expect(tailRecord(ev, { fn: "messages:send" })!.lines).toMatchObject([{ kind: "exec", fn: "messages:send" }]);
    expect(tailRecord(ev, { shard: "org" })!.lines.filter((l) => l.kind === "exec")).toHaveLength(2);
    expect(tailRecord(ev, { shard: "org:beta", errors: true })!.lines).toMatchObject([{ kind: "exec", fn: "rooms:list", errorCode: "Boom" }]);
    expect(tailRecord(ev, { fn: "nope:nope" })).toBeNull();
  });
});

class FakeSocket implements TailSocket {
  sent: string[] = [];
  closed = false;
  private listeners = new Map<string, Array<(e: { data?: unknown }) => void>>();
  addEventListener(type: string, fn: (e: { data?: unknown }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data?: unknown) {
    for (const f of this.listeners.get(type) ?? []) f({ data });
  }
}

function setup(env: Partial<DashboardEnv> = {}, drop: string[] = []) {
  const calls: Array<{ method: string; url: string; auth: string | null }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ method: init?.method ?? "GET", url, auth: new Headers(init?.headers).get("authorization") });
    if (url.endsWith("/tails") && init?.method === "POST") return Response.json({ success: true, result: { id: "tail-1", url: "wss://tail.example/secret-capability" } });
    return Response.json({ success: true, result: null });
  }) as typeof fetch;
  const socket = new FakeSocket();
  const connected: string[] = [];
  const connectTail: TailConnector = async (u) => {
    connected.push(u);
    return socket;
  };
  const e: DashboardEnv = { DASHBOARD_TOKEN: "dash", REGISTRY: seeded().binding, CF_ACCOUNT_ID: "acc", CF_TAIL_TOKEN: "tail-token", ...env };
  for (const k of drop) delete e[k];
  const get = (path: string, token = "dash") => {
    const url = new URL(`https://dash.example${path}`);
    return handleApi(new Request(url, { headers: { authorization: `Bearer ${token}` } }), e, url, fetchImpl, { connectTail });
  };
  return { calls, socket, connected, get };
}

async function readLines(res: Response, n: number): Promise<Array<Record<string, unknown>>> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const out: Array<Record<string, unknown>> = [];
  while (out.length < n) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      out.push(JSON.parse(buf.slice(0, i)));
      buf = buf.slice(i + 1);
    }
  }
  reader.releaseLock();
  return out;
}

describe("GET /api/logs", () => {
  it("relays filtered events as NDJSON; the tail URL and token stay in the Worker; the session is deleted at the end", async () => {
    const t = setup();
    const res = await t.get("/api/logs?project=chat&env=prod&fn=messages:send");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-ndjson");
    expect(t.calls[0]).toMatchObject({ method: "POST", url: "https://api.cloudflare.com/client/v4/accounts/acc/workers/scripts/ember-chat-prod/tails", auth: "Bearer tail-token" });
    expect(t.connected).toEqual(["wss://tail.example/secret-capability"]);
    t.socket.emit("message", JSON.stringify(event([exec({ fn: "messages:send", shard: "org:acme" })])));
    t.socket.emit("message", JSON.stringify(event([exec({ fn: "rooms:list", shard: "org:acme" })])));
    t.socket.emit("message", "not json");
    t.socket.emit("close");
    const lines = await readLines(res, 3);
    expect(lines.map((l) => l.type)).toEqual(["open", "event", "end"]);
    expect((lines[1]!.record as { lines: Array<{ fn: string }> }).lines[0]!.fn).toBe("messages:send");
    expect(JSON.stringify(lines)).not.toMatch(/secret-capability|tail-token|SECRET/);
    expect(t.calls.at(-1)).toMatchObject({ method: "DELETE", url: expect.stringMatching(/\/tails\/tail-1$/) });
    expect(t.socket.closed).toBe(true);
  });

  it("the browser going away closes the tail and deletes the session", async () => {
    const t = setup();
    const res = await t.get("/api/logs?project=chat&env=prod");
    await res.body!.cancel();
    await new Promise((r) => setTimeout(r, 0));
    expect(t.socket.closed).toBe(true);
    expect(t.calls.some((c) => c.method === "DELETE")).toBe(true);
  });

  it("needs a token with Workers Tail: Read; unknown environments are 404", async () => {
    const t = setup({}, ["CF_TAIL_TOKEN", "CF_API_TOKEN"]);
    const r = await t.get("/api/logs?project=chat&env=prod");
    expect([r.status, ((await r.json()) as { error: { code: string } }).error.code]).toEqual([412, "logs_unavailable"]);
    expect((await setup().get("/api/logs?project=chat&env=nope")).status).toBe(404);
  });
});

describe("job history", () => {
  it("queries job points of the environment, newest first", () => {
    const sql = jobHistorySql({ dataset: "ember_metrics", project: "chat", env: "prod", sinceHours: 24 });
    expect(sql).toContain("blob5 = 'job'");
    expect(sql).toContain("ORDER BY t DESC");
    expect(parseJobHistory({ data: [{ t: "2026-11-14 10:00:00", fn: "jobs:record", shard: "org:a", status: "error", code: "Boom", ms: 3 }] })).toEqual([
      { t: Date.UTC(2026, 10, 14, 10), fn: "jobs:record", shard: "org:a", status: "error", code: "Boom", ms: 3 },
    ]);
  });
});
