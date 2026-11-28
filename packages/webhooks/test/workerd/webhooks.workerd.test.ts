/**
 * The webhooks component end to end in workerd: real runtime (Worker + Shard DO, scheduler alarm, the nested workpool's
 * action jobs), deliveries POSTed by the Durable Object to fake receivers (Node, outboundService) that record them; the
 * signatures are checked here with `verifyWebhook`.
 */
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { verifyWebhook } from "../../src/verify.ts";

const call = async (kind: "query" | "mutation", fn: string, args: unknown, shard = "global:main") => {
  const res = await SELF.fetch(`http://ember/api/${kind}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fn, args, shard }) });
  const body = (await res.json()) as { ok: boolean; value?: any; error?: unknown };
  if (!body.ok) throw new Error(`${kind} ${fn}: ${JSON.stringify(body)}`);
  return body.value;
};
type Received = { host: string; path: string; headers: Record<string, string>; body: string };
const received = async () => (await (await fetch("https://fake.test/__log")).json()) as Received[];

async function until<T>(f: () => Promise<T>, ok: (x: T) => boolean, what: string): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const x = await f();
    if (ok(x)) return x;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("webhooks in workerd", () => {
  it("a send from a mutation is delivered by the shard, signed; a flaky receiver gets retries; a 410 is dead; replay", async () => {
    const shard = `shop:${crypto.randomUUID().slice(0, 8)}`;
    const ok = await call("mutation", "admin:add", { url: "https://ok.hooks.test/in", events: ["order.*"] }, shard);
    const flaky = await call("mutation", "admin:add", { url: "https://flaky.hooks.test/in", events: ["order.created"] }, shard);
    await call("mutation", "admin:add", { url: "https://gone.hooks.test/in", events: ["order.refunded"] }, shard);

    const sent = await call("mutation", "shop:order", { total: 99, event: "order.created" }, shard);
    expect(sent.deliveries).toHaveLength(2);
    const [toOk, toFlaky] = sent.deliveries as string[];

    const done = await until(() => call("query", "admin:delivery", { id: toOk }, shard), (d) => d?.status === "delivered", "the ok delivery");
    expect(done).toMatchObject({ attempt: 1, responseStatus: 200, responseBody: "thanks" });
    const req = (await received()).find((r) => r.host === "ok.hooks.test" && r.headers["webhook-id"] === sent.messageId)!;
    expect(await verifyWebhook(ok.secret, req.headers, req.body)).toMatchObject({ total: 99 });

    // 503, 503, then 200: two retries 100 ms apart.
    const retried = await until(() => call("query", "admin:delivery", { id: toFlaky }, shard), (d) => d?.status === "delivered", "the flaky delivery");
    expect(retried.attempt).toBe(3);
    expect(retried.history.map((h: { event: string; status?: number }) => [h.event, h.status])).toEqual([["retry", 503], ["retry", 503], ["delivered", 200]]);
    const flakyReqs = (await received()).filter((r) => r.host === "flaky.hooks.test");
    expect(new Set(flakyReqs.map((r) => r.headers["webhook-id"]))).toEqual(new Set([sent.messageId]));
    for (const r of flakyReqs) expect(await verifyWebhook(flaky.secret, r.headers, r.body)).toMatchObject({ total: 99 });

    // A refusal (410) is terminal: dead after one attempt; a replay sends it again with the same id. (`order.refunded`
    // also matches the ok endpoint's `order.*`: two deliveries.)
    const refund = await call("mutation", "shop:order", { total: 5, event: "order.refunded" }, shard);
    expect(refund.deliveries).toHaveLength(2);
    const settled = await until(
      () => Promise.all(refund.deliveries.map((id: string) => call("query", "admin:delivery", { id }, shard))),
      (ds) => ds.every((d: { status: string }) => d.status === "dead" || d.status === "delivered"),
      "the refund deliveries",
    );
    expect(settled.map((d: { status: string }) => d.status).sort()).toEqual(["dead", "delivered"]);
    const deadOne = settled.find((d: { status: string }) => d.status === "dead")!;
    expect(deadOne).toMatchObject({ attempt: 1, responseStatus: 410, responseBody: "no such hook" });
    await call("mutation", "admin:replay", { id: deadOne._id }, shard);
    await until(() => call("query", "admin:delivery", { id: deadOne._id }, shard), (d) => d?.status === "dead" && d.attempt === 2, "the replayed delivery");
    const gone = (await received()).filter((r) => r.host === "gone.hooks.test");
    expect(gone).toHaveLength(2);
    expect(gone[0]!.headers["webhook-id"]).toBe(gone[1]!.headers["webhook-id"]);
  });
});
