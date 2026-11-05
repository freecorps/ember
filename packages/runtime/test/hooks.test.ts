// Component hooks (PLAN §12, contracts.md "Componentes"): crons declared by a component, a queue it owns and
// consumes, and the Worker's email() handler.
import { createExecutionContext, createMessageBatch, env, getQueueResult, runDurableObjectAlarm, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { api, shardStub, sleep } from "./helpers.ts";
import worker from "./worker.ts";

const DAY = 86_400_000;
const SHARD = "hooks:main";

const list = async (kind: string) => (await api("query", { fn: "hooks:list", args: { kind }, shard: SHARD })).body;

async function until<T>(f: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 5000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await f();
    if (ok(v) || Date.now() > end) return v;
    await sleep(50);
  }
}

function rawEmail(from: string, to: string, subject: string, body = "hello") {
  return [`From: ${from}`, `To: ${to}`, `Subject: ${subject}`, `Message-ID: <${crypto.randomUUID()}@test>`, "Content-Type: text/plain; charset=utf-8", "", body, ""].join("\r\n");
}

function inbound(from: string, to: string, raw: string) {
  const bytes = new TextEncoder().encode(raw);
  let rejected: string | null = null;
  const msg = {
    from,
    to,
    headers: new Headers({ subject: /^Subject: (.*)$/m.exec(raw)?.[1] ?? "" }),
    raw: new Response(bytes).body!,
    rawSize: bytes.length,
    setReject: (r: string) => {
      rejected = r;
    },
    forward: async () => ({}),
    reply: async () => ({}),
  };
  return { msg, rejected: () => rejected };
}

describe("component hooks", () => {
  it("a component's cron is dispatched by the System DO to its function, in its scope", async () => {
    const system = env.SYSTEM.get(env.SYSTEM.idFromName("system"));
    const day = Math.floor(Date.now() / DAY) * DAY - DAY;
    const r = await system.tick(day + 3 * 3_600_000);
    expect(r.dispatched).toContainEqual({ name: "@hooks/sweep", shard: SHARD, minute: (day + 3 * 3_600_000) / 60_000 });
    await runDurableObjectAlarm(shardStub(SHARD));
    const rows = await until(() => list("cron"), (b) => b.value?.length > 0);
    expect(rows.value).toMatchObject([{ kind: "cron", key: "daily", data: "hooks.test" }]);
  });

  it("the component's queue: a batch goes to its handler (ack / retry per message), in its scope and shard", async () => {
    const batch = createMessageBatch("ember-test-test-hooks-events", [
      { id: "m1", timestamp: new Date(), attempts: 1, body: { key: "a" } },
      { id: "m2", timestamp: new Date(), attempts: 1, body: { key: "b", fail: true } },
    ]);
    const ctx = createExecutionContext();
    await worker.queue(batch as never, env as never, ctx);
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks).toEqual(["m1"]);
    expect(result.retryMessages.map((m) => m.msgId)).toEqual(["m2"]);
    const rows = (await list("queue")).value;
    expect(rows).toMatchObject([{ key: "a", data: { attempts: 1, queue: "ember-test-test-hooks-events", shard: SHARD, domain: "hooks.test" } }]);
  });

  it("a handler that throws retries the whole batch; other queues keep their own handling", async () => {
    const batch = createMessageBatch("ember-test-test-hooks-events", [{ id: "x1", timestamp: new Date(), attempts: 1, body: null }]);
    const ctx = createExecutionContext();
    await worker.queue(batch as never, env as never, ctx);
    const result = await getQueueResult(batch, ctx);
    expect(result.retryBatch.retry).toBe(true);
  });

  it("the producer binding reaches the real local queue and its consumer", async () => {
    const before = (await list("queue")).value.length;
    const res = await SELF_action("@hooks/lib:enqueue", { key: "via-queue" });
    expect(res.error?.code).toBe("FunctionNotFound"); // clients never reach component functions
    await env.EMBER_Q_HOOKS_EVENTS.send({ key: "via-queue" });
    const rows = await until(() => list("queue"), (b) => b.value.length > before, 8000);
    expect(rows.value.map((r: { key: string }) => r.key)).toContain("via-queue");
  });

  it("email(): the matching component stores the message; it may reject; no match is rejected", async () => {
    const raw = rawEmail("Alice <alice@example.com>", "support@hooks.test", "Help");
    const a = inbound("alice@example.com", "support@hooks.test", raw);
    await worker.email(a.msg as never, env as never, createExecutionContext());
    expect(a.rejected()).toBeNull();
    const rows = (await list("email")).value;
    expect(rows).toMatchObject([{ key: "support@hooks.test", data: { from: "alice@example.com", subject: "Help", size: raw.length, raw } }]);

    const b = inbound("alice@example.com", "reject@hooks.test", rawEmail("a@example.com", "reject@hooks.test", "x"));
    await worker.email(b.msg as never, env as never, createExecutionContext());
    expect(b.rejected()).toBe("not here");

    const c = inbound("alice@example.com", "someone@elsewhere.test", rawEmail("a@example.com", "someone@elsewhere.test", "x"));
    await worker.email(c.msg as never, env as never, createExecutionContext());
    expect(c.rejected()).toBe("Address not found");
    expect((await list("email")).value).toHaveLength(1);
  });
});

async function SELF_action(fn: string, args: unknown) {
  const { SELF } = await import("cloudflare:test");
  const res = await SELF.fetch("http://ember/api/action", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fn, args, shard: SHARD }) });
  return (await res.json()) as any;
}
