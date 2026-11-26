// The webhooks component over the real engine (`emberTest({ app })`), with a fake `fetch`: transactional sends,
// signatures a receiver verifies, the retry schedule on the harness clock, Retry-After, terminal refusals, the
// breaker (open, held deliveries, half-open probe, release), the dead state and replays, rotation headers, R2
// offload of large payloads, the response cap and the timeout.
import { anyApi, componentsOf, composeApp, defineApp, defineSchema, defineTable, mutationGeneric, queryGeneric, v, type ApiFromModules } from "@freecorps/ember-server";
import { emberTest, type EmberTest } from "@freecorps/ember-testing";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { verifyWebhook, webhooks, Webhooks, type WebhookDelivery, type WebhooksComponentApi, type WebhooksInstallConfig } from "../src/index.ts";

// --------------------------------------------------------------------------------------------- the fake receiver

type Seen = { url: string; headers: Record<string, string>; body: string; at: number };
type Reply = number | { status: number; headers?: Record<string, string>; body?: string } | "network" | "hang";
let seen: Seen[] = [];
/** Replies per URL, in order (the last one repeats). */
let replies = new Map<string, Reply[]>();
const reply = (url: string, ...r: Reply[]) => replies.set(url, r);

const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = String(input);
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((value, key) => (headers[key] = value));
  seen.push({ url, headers, body: String(init?.body), at: Date.now() });
  const queue = replies.get(url) ?? [200];
  const r = queue.length > 1 ? queue.shift()! : queue[0]!;
  if (r === "network") throw new TypeError("fetch failed: connection refused");
  if (r === "hang") {
    return new Promise((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
    });
  }
  const o = typeof r === "number" ? { status: r } : r;
  return new Response(o.body ?? "ok", { status: o.status, headers: o.headers ?? {} });
};

beforeEach(() => {
  seen = [];
  replies = new Map();
  vi.stubGlobal("fetch", fakeFetch);
});
afterEach(() => vi.unstubAllGlobals());

// ------------------------------------------------------------------------------------------------------ the app

const appWith = (config?: WebhooksInstallConfig) => defineApp().use(webhooks, config ? { config } : {});
const app = appWith();
const components: { webhooks: WebhooksComponentApi } = componentsOf(app);
const hooks = new Webhooks(components.webhooks);

const schema = defineSchema({ tables: { invoices: defineTable({ amount: v.number(), paid: v.boolean() }) } });
const modules = {
  billing: {
    /** The app's write and the webhook commit together (`fail`: neither). */
    pay: mutationGeneric({
      args: { amount: v.number(), fail: v.optional(v.boolean()) },
      handler: (ctx: any, a: any) => {
        const id = ctx.db.insert("invoices", { amount: a.amount, paid: true });
        const r = hooks.send(ctx, "invoice.paid", { invoiceId: id, amount: a.amount });
        if (a.fail) throw new Error("payment failed");
        return { id, ...r };
      },
    }),
    emit: mutationGeneric({ args: { event: v.string(), payload: v.any() }, handler: (ctx: any, a: any) => hooks.send(ctx, a.event, a.payload) }),
    invoices: queryGeneric({ args: {}, handler: (ctx: any) => ctx.db.query("invoices").collect().length }),
  },
  admin: {
    add: mutationGeneric({ args: { url: v.string(), events: v.optional(v.array(v.string())) }, handler: (ctx: any, a: any) => hooks.createEndpoint(ctx, a) }),
    enable: mutationGeneric({ args: { id: v.string(), on: v.boolean() }, handler: (ctx: any, a: any) => hooks.setEnabled(ctx, a.id, a.on) }),
    rotate: mutationGeneric({ args: { id: v.string(), graceMs: v.optional(v.number()) }, handler: (ctx: any, a: any) => hooks.rotateSecret(ctx, a.id, a.graceMs !== undefined ? { graceMs: a.graceMs } : {}) }),
    remove: mutationGeneric({ args: { id: v.string() }, handler: (ctx: any, a: any) => hooks.deleteEndpoint(ctx, a.id) }),
    replay: mutationGeneric({ args: { id: v.string() }, handler: (ctx: any, a: any) => hooks.replay(ctx, a.id) }),
    replayDead: mutationGeneric({ args: { id: v.string() }, handler: (ctx: any, a: any) => hooks.replayDead(ctx, a.id) }),
    endpoint: queryGeneric({ args: { id: v.string() }, handler: (ctx: any, a: any) => hooks.endpoint(ctx, a.id) }),
    delivery: queryGeneric({ args: { id: v.string() }, handler: (ctx: any, a: any) => hooks.delivery(ctx, a.id) }),
    deliveries: queryGeneric({ args: { status: v.optional(v.string()) }, handler: (ctx: any, a: any) => hooks.deliveries(ctx, { ...(a.status ? { status: a.status } : {}), paginationOpts: { numItems: 100, cursor: null } }) }),
  },
};
const api = anyApi as unknown as ApiFromModules<typeof modules>;

const harness = (config?: WebhooksInstallConfig) => emberTest({ schema, modules, app: config ? appWith(config) : app });
const delivery = (t: EmberTest, id: string) => t.query(api.admin.delivery, { id }) as Promise<WebhookDelivery>;
/** Runs what is due now (the pool's run jobs, settle) until nothing is left at this instant. */
const flush = (t: EmberTest) => t.advance(0);

describe("webhooks component", () => {
  test("send is transactional; a delivery is signed with the endpoint's secret and verifies", async () => {
    const t = harness();
    const { endpointId, secret } = await t.mutation(api.admin.add, { url: "https://a.test/hook", events: ["invoice.*"] });
    await t.mutation(api.admin.add, { url: "https://b.test/hook", events: ["user.created"] });
    await expect(t.mutation(api.billing.pay, { amount: 10, fail: true })).rejects.toThrow(/payment failed/);
    expect(await t.query(api.billing.invoices, {})).toBe(0);
    expect((await t.query(api.admin.deliveries, {})).page).toEqual([]);

    const r = (await t.mutation(api.billing.pay, { amount: 42 })) as { id: string; messageId: string; deliveries: string[] };
    expect(r.deliveries).toHaveLength(1);
    expect(r.messageId).toMatch(/^msg_/);
    expect(await delivery(t, r.deliveries[0]!)).toMatchObject({ status: "pending", attempt: 1, endpointId });
    await flush(t);
    expect(seen).toHaveLength(1);
    const req = seen[0]!;
    expect(req.url).toBe("https://a.test/hook");
    expect(req.headers).toMatchObject({ "content-type": "application/json", "webhook-id": r.messageId });
    expect(await verifyWebhook(secret, req.headers, req.body)).toEqual({ invoiceId: r.id, amount: 42 });
    expect(await delivery(t, r.deliveries[0]!)).toMatchObject({ status: "delivered", attempt: 1, responseStatus: 200, responseBody: "ok", history: [{ event: "delivered", status: 200 }] });
    // No endpoint for the event: nothing is written.
    expect(await t.mutation(api.billing.emit, { event: "nobody.listens", payload: {} })).toEqual({ messageId: null, deliveries: [] });
  });

  test("retry schedule on the harness clock: 5 s, 30 s, 2 min, 10 min, 1 h, 6 h, 24 h, then dead", async () => {
    const t = harness({ jitter: 0 });
    const { endpointId } = await t.mutation(api.admin.add, { url: "https://down.test/hook" });
    reply("https://down.test/hook", 503);
    const [id] = (await t.mutation(api.billing.emit, { event: "e", payload: { n: 1 } })).deliveries;
    await flush(t);
    const gaps: number[] = [];
    for (let i = 0; i < 7; i++) {
      const d = await delivery(t, id!);
      expect(d).toMatchObject({ status: "failed", attempt: i + 1, responseStatus: 503, lastError: "HTTP 503" });
      gaps.push(d.nextAt! - t.now());
      await t.advance(d.nextAt! - t.now());
    }
    expect(gaps).toEqual([5_000, 30_000, 120_000, 600_000, 3_600_000, 21_600_000, 86_400_000]);
    const dead = await delivery(t, id!);
    expect(dead).toMatchObject({ status: "dead", attempt: 8, lastError: "HTTP 503" });
    expect(dead.nextAt).toBeUndefined();
    expect(seen).toHaveLength(8);
    // Every attempt carries the same webhook-id (receivers dedupe on it) and a fresh timestamp.
    expect(new Set(seen.map((s) => s.headers["webhook-id"])).size).toBe(1);
    // 8 failures in a row (threshold 10): the breaker is still closed.
    expect((await t.query(api.admin.endpoint, { id: endpointId }))?.breaker).toEqual({ state: "closed", failures: 8 });
  });

  test("network errors and timeouts retry; 429 honours Retry-After; other 4xx are terminal (dead at once)", async () => {
    const t = harness({ jitter: 0, timeoutMs: 30 });
    await t.mutation(api.admin.add, { url: "https://flaky.test/hook", events: ["e"] });
    reply("https://flaky.test/hook", "network", "hang", { status: 429, headers: { "retry-after": "7" } }, 200);
    const [id] = (await t.mutation(api.billing.emit, { event: "e", payload: {} })).deliveries;
    await flush(t);
    expect(await delivery(t, id!)).toMatchObject({ status: "failed", lastError: expect.stringContaining("connection refused") });
    await t.advance(5_000);
    expect(await delivery(t, id!)).toMatchObject({ status: "failed", attempt: 2, lastError: "timeout" });
    await t.advance(30_000);
    const limited = await delivery(t, id!);
    expect(limited).toMatchObject({ status: "failed", attempt: 3, responseStatus: 429 });
    expect(limited.nextAt! - t.now()).toBe(7_000);
    await t.advance(7_000);
    expect(await delivery(t, id!)).toMatchObject({ status: "delivered", attempt: 4 });

    await t.mutation(api.admin.add, { url: "https://gone.test/hook", events: ["x"] });
    reply("https://gone.test/hook", { status: 410, body: "endpoint removed" });
    const [g] = (await t.mutation(api.billing.emit, { event: "x", payload: {} })).deliveries;
    await flush(t);
    expect(await delivery(t, g!)).toMatchObject({ status: "dead", attempt: 1, responseStatus: 410, responseBody: "endpoint removed" });
  });

  test("circuit breaker: open after N failures, new deliveries held, a half-open probe after the cooldown, then release", async () => {
    const t = harness({ jitter: 0, breaker: { threshold: 3, cooldownMs: 60_000 }, retrySchedule: [1000] });
    const { endpointId } = await t.mutation(api.admin.add, { url: "https://b.test/hook" });
    reply("https://b.test/hook", 500);
    for (let i = 0; i < 3; i++) await t.mutation(api.billing.emit, { event: "e", payload: { i } });
    await flush(t);
    const ep = await t.query(api.admin.endpoint, { id: endpointId });
    expect(ep?.breaker).toMatchObject({ state: "open", failures: 3, probeAt: t.now() + 60_000 });
    expect(seen).toHaveLength(3);

    // Open: their retries and new sends wait (no request).
    await t.advance(1000);
    const [held] = (await t.mutation(api.billing.emit, { event: "e", payload: { i: 3 } })).deliveries;
    await flush(t);
    expect(seen).toHaveLength(3);
    expect(await delivery(t, held!)).toMatchObject({ status: "pending", heldAt: expect.any(Number) });
    expect((await t.query(api.admin.deliveries, { status: "pending" })).page).toHaveLength(4);

    // The cooldown ends: one probe goes; it fails, the breaker opens again with a new cooldown.
    await t.advance(59_000);
    expect(seen).toHaveLength(4);
    expect((await t.query(api.admin.endpoint, { id: endpointId }))?.breaker).toMatchObject({ state: "open", failures: 4, probeAt: t.now() + 60_000 });

    // The endpoint recovers: the next probe succeeds, the breaker closes and every held delivery goes.
    reply("https://b.test/hook", 200);
    await t.advance(60_000);
    expect((await t.query(api.admin.endpoint, { id: endpointId }))?.breaker).toEqual({ state: "closed", failures: 0 });
    await flush(t);
    // 3 failures, the failed probe, the probe that closed it, then the 2 other held deliveries.
    expect(seen.length).toBe(7);
    const all = (await t.query(api.admin.deliveries, {})).page as WebhookDelivery[];
    // The first probe was the oldest delivery's last retry (retrySchedule: one retry): it is dead, the rest delivered.
    expect(all.map((d) => d.status).sort()).toEqual(["dead", "delivered", "delivered", "delivered"]);
    expect(all.find((d) => d._id === held)!.history.map((h) => h.event)).toContain("held");
  });

  test("dead letters: replay one (same message id, a new round), replayDead for an endpoint", async () => {
    const t = harness({ jitter: 0, retrySchedule: [1000] });
    const { endpointId, secret } = await t.mutation(api.admin.add, { url: "https://d.test/hook" });
    reply("https://d.test/hook", 500);
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push((await t.mutation(api.billing.emit, { event: "e", payload: { i } })).deliveries[0]!);
    await flush(t);
    await t.advance(1000);
    for (const id of ids) expect(await delivery(t, id)).toMatchObject({ status: "dead", attempt: 2 });
    await expect(t.mutation(api.admin.replay, { id: "deliveries_nope" })).rejects.toMatchObject({ code: "DeliveryNotFound" });

    reply("https://d.test/hook", 200);
    const before = seen.length;
    await t.mutation(api.admin.replay, { id: ids[0]! });
    await flush(t);
    const one = await delivery(t, ids[0]!);
    expect(one).toMatchObject({ status: "delivered", attempt: 3 });
    expect(one.history.map((h) => h.event)).toEqual(["retry", "dead", "replay", "delivered"]);
    expect(seen[before]!.headers["webhook-id"]).toBe(seen[0]!.headers["webhook-id"]);
    expect(await verifyWebhook(secret, seen[before]!.headers, seen[before]!.body)).toEqual({ i: 0 });

    expect(await t.mutation(api.admin.replayDead, { id: endpointId })).toBe(2);
    await flush(t);
    for (const id of ids) expect(await delivery(t, id)).toMatchObject({ status: "delivered" });
    // A replay of a pending delivery is refused.
    reply("https://d.test/hook", "hang");
    const [p] = (await t.mutation(api.billing.emit, { event: "e", payload: {} })).deliveries;
    await expect(t.mutation(api.admin.replay, { id: p! })).rejects.toThrow(/pending/);
  });

  test("rotation: both signatures during the grace period, the new one alone after it", async () => {
    const t = harness();
    const { endpointId, secret: old } = await t.mutation(api.admin.add, { url: "https://r.test/hook" });
    const { secret: next, previousExpiresAt } = await t.mutation(api.admin.rotate, { id: endpointId, graceMs: 3_600_000 });
    expect(previousExpiresAt).toBe(t.now() + 3_600_000);
    expect((await t.query(api.admin.endpoint, { id: endpointId }))?.signingSecrets).toBe(2);
    await t.mutation(api.billing.emit, { event: "e", payload: { v: 1 } });
    await flush(t);
    const during = seen.at(-1)!;
    expect(during.headers["webhook-signature"]!.split(" ")).toHaveLength(2);
    expect(await verifyWebhook(next, during.headers, during.body)).toEqual({ v: 1 });
    expect(await verifyWebhook(old, during.headers, during.body)).toEqual({ v: 1 });

    await t.advance(3_600_001);
    expect((await t.query(api.admin.endpoint, { id: endpointId }))?.signingSecrets).toBe(1);
    await t.mutation(api.billing.emit, { event: "e", payload: { v: 2 } });
    await flush(t);
    const after = seen.at(-1)!;
    expect(after.headers["webhook-signature"]!.split(" ")).toHaveLength(1);
    expect(await verifyWebhook(next, after.headers, after.body)).toEqual({ v: 2 });
    await expect(verifyWebhook(old, after.headers, after.body)).rejects.toThrow(/no matching signature/);
  });

  test("payloads over 8 KB move to R2 on their first attempt; response bodies are capped at 1 KB", async () => {
    const t = harness();
    await t.mutation(api.admin.add, { url: "https://big.test/hook" });
    reply("https://big.test/hook", { status: 500, body: "x".repeat(5000) }, 200);
    const payload = { blob: "y".repeat(20_000) };
    const [id] = (await t.mutation(api.billing.emit, { event: "e", payload })).deliveries;
    await flush(t);
    const d = await delivery(t, id!);
    expect(d.responseBody).toHaveLength(1024);
    // The message row now points at the object in R2 and no longer holds the body.
    const detail = t.engine().runQuery("@webhooks/dashboard:delivery", { deliveryId: id! }).value as { payload: { size: number; storage: string } };
    expect(detail.payload).toMatchObject({ size: JSON.stringify(payload).length, storage: "r2" });
    // Default jitter: the retry is due 4–6 s later.
    expect(d.nextAt! - t.now()).toBeGreaterThanOrEqual(4_000);
    expect(d.nextAt! - t.now()).toBeLessThanOrEqual(6_000);
    await t.advance(d.nextAt! - t.now());
    expect(JSON.parse(seen.at(-1)!.body)).toEqual(payload);
    expect(await delivery(t, id!)).toMatchObject({ status: "delivered", attempt: 2 });
    // Too large to send at all.
    await expect(t.mutation(api.billing.emit, { event: "e", payload: { blob: "z".repeat(1024 * 1024 + 1) } })).rejects.toMatchObject({ code: "PayloadTooLarge" });
  });

  test("disabled endpoints get no new sends and hold their retries; enabling releases them", async () => {
    const t = harness({ jitter: 0, retrySchedule: [1000, 1000] });
    const { endpointId } = await t.mutation(api.admin.add, { url: "https://e.test/hook" });
    reply("https://e.test/hook", 500, 200);
    const [id] = (await t.mutation(api.billing.emit, { event: "e", payload: {} })).deliveries;
    await flush(t);
    await t.mutation(api.admin.enable, { id: endpointId, on: false });
    expect(await t.mutation(api.billing.emit, { event: "e", payload: {} })).toEqual({ messageId: null, deliveries: [] });
    await t.advance(1000);
    expect(await delivery(t, id!)).toMatchObject({ status: "pending", heldAt: expect.any(Number) });
    expect(seen).toHaveLength(1);
    await t.mutation(api.admin.enable, { id: endpointId, on: true });
    await flush(t);
    expect(await delivery(t, id!)).toMatchObject({ status: "delivered", attempt: 2 });
  });

  test("deleting an endpoint deletes its deliveries and their messages", async () => {
    const t = harness();
    const { endpointId } = await t.mutation(api.admin.add, { url: "https://x.test/hook" });
    await t.mutation(api.admin.add, { url: "https://y.test/hook" });
    await t.mutation(api.billing.emit, { event: "e", payload: {} });
    await flush(t);
    expect(await t.mutation(api.admin.remove, { id: endpointId })).toBe(true);
    await flush(t);
    const left = (await t.query(api.admin.deliveries, {})).page as WebhookDelivery[];
    expect(left).toHaveLength(1);
    expect(left[0]!.endpointId).not.toBe(endpointId);
    await expect(t.mutation(api.admin.rotate, { id: endpointId })).rejects.toMatchObject({ code: "EndpointNotFound" });
  });

  test("endpoint urls: https only unless allowHttp; no credentials", async () => {
    const t = harness();
    await expect(t.mutation(api.admin.add, { url: "http://insecure.test/hook" })).rejects.toThrow(/https/);
    await expect(t.mutation(api.admin.add, { url: "https://u:p@x.test/hook" })).rejects.toThrow(/credentials/);
    await expect(t.mutation(api.admin.add, { url: "nope" })).rejects.toThrow(/not a URL/);
    const dev = harness({ allowHttp: true });
    expect((await dev.mutation(api.admin.add, { url: "http://localhost:8080/hook" })).endpointId).toMatch(/^webhooks\$endpoints_/);
  });

  test("the dashboard spec: endpoints with an enabled toggle and a confirmed rotation; deliveries filtered by status, Replay", () => {
    const spec = composeApp({ schema, functions: modules, app }).dashboards.find((d) => d.key === "webhooks")!;
    expect(spec).toMatchObject({ scope: "shard", icon: "bell" });
    const [endpoints, deliveries] = spec.tabs;
    const table = endpoints!.blocks.find((b) => b.id === "endpoints")!;
    expect(table.kind === "table" && table.columns.find((c) => c.path === "enabled")?.toggle).toEqual({ mutation: "@webhooks/lib:setEnabled", arg: "enabled", fromRow: { endpointId: "_id" } });
    expect(spec.functions["@webhooks/lib:rotateSecret"]).toMatchObject({ type: "mutation", destructive: true });
    const list = deliveries!.blocks[0]!;
    expect(list).toMatchObject({ kind: "table", filters: ["status", "endpointId"], pageSize: 25 });
    expect(list.kind === "table" && list.rowActions?.map((a) => a.fn)).toEqual(["@webhooks/lib:replay"]);
    // The nested pool's own screen is there too (its tables live next to these).
    expect(composeApp({ schema, functions: modules, app }).dashboards.some((d) => d.key === "webhooks/pool")).toBe(true);
  });
});
