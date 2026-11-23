import {
  anyComponents,
  checkAccess,
  composeApp,
  createEngine,
  defineApp,
  defineSchema,
  defineTable,
  mutationGeneric,
  resolveReference,
  splitFunctionName,
  v,
  type Job,
} from "@freecorps/ember-server";
import { createNodeSqliteDriver } from "@freecorps/ember-server/testing";
import { afterEach, describe, expect, test, vi } from "vitest";
import { clearApnsTokenCache, clearFcmTokenCache, generateRecipient, openPushEnvelope, pushComponent,
  setPushSeal, PushNotifications, registerPushDevice, toBase64url } from "../src/index.ts";
import { RECEIPTS_DRAIN_STALE_MS, SEND_EMBED_FRESH_MS, SEND_EMBED_MAX_DEVICES, SEND_PRECHECK_MAX_USERS } from "../src/component.ts";
import { fakeApns, fakeFcm, hexToken } from "./fakes.ts";
import { apnsKey, serviceAccount } from "./keys.ts";

const push = new PushNotifications(anyComponents.push);
/** When the harness's first receipts drain runs: `receiptsDelayMs` (1000) + its batch window (a tenth). */
const DUE = 1100;
const schema = defineSchema({ tables: { messages: defineTable({ to: v.string(), text: v.string() }) } });

const fns = {
  chat: {
    register: mutationGeneric({ args: { user: v.string(), token: v.string() }, handler: (ctx: any, a: any) => push.register(ctx, { userId: a.user, token: a.token, platform: "ios" }) }),
    registerNative: mutationGeneric({
      args: { user: v.string(), device: v.any() },
      handler: (ctx: any, a: any) => push.register(ctx, { userId: a.user, ...a.device }),
    }),
    deviceRows: mutationGeneric({ args: { user: v.string() }, handler: (ctx: any, a: any) => push.devices(ctx, a.user) }),
    send: mutationGeneric({
      args: { to: v.string(), text: v.string(), fail: v.optional(v.boolean()) },
      handler: (ctx: any, a: any) => {
        ctx.db.insert("messages", { to: a.to, text: a.text });
        push.send(ctx, [a.to], { title: "New message", body: a.text });
        if (a.fail) throw new Error("rollback");
        return null;
      },
    }),
    devices: mutationGeneric({ args: { user: v.string() }, handler: (ctx: any, a: any) => push.devices(ctx, a.user).map((d: any) => d.token) }),
  },
};

function harness(opts: { config?: Record<string, unknown>; env?: Record<string, unknown> } = {}) {
  let now = 1_700_000_000_000;
  const app = defineApp().use(pushComponent, { config: { receiptsDelayMs: 1000, ...opts.config } });
  const composed = composeApp({ schema, functions: fns, app });
  const engine = createEngine({ schema: composed.schema, functions: composed.functions, driver: createNodeSqliteDriver(), now: () => now });
  engine.migrate();
  const all = new Map(Object.entries(composed.functions));
  let jobs: Job[] = [];
  /** Every job ever scheduled (what a shard's `_jobs` would have written). */
  const scheduled: Job[] = [];
  let rowsWritten = 0;
  const mutate = (name: string, args: unknown) => {
    const r = engine.runMutation(name, args);
    jobs = jobs.filter((j) => !r.cancelled.includes(j.id));
    jobs.push(...r.scheduled);
    scheduled.push(...r.scheduled);
    rowsWritten += r.changes.length;
    return r.value;
  };
  const ctxFor = (name: string): any => {
    const path = splitFunctionName(name).path;
    const res = (ref: unknown) => {
      const r = resolveReference(path, ref as any);
      checkAccess(all as any, r);
      return r.name;
    };
    return {
      runQuery: async (ref: unknown, a?: unknown) => engine.runQuery(res(ref), a ?? {}).value,
      runMutation: async (ref: unknown, a?: unknown) => mutate(res(ref), a ?? {}),
      runAction: async (ref: unknown, a?: unknown) => runAction(res(ref), a ?? {}),
      scheduler: {
        runAfter: async (ms: number, ref: unknown, a?: unknown) => {
          const job: Job = { id: `j${scheduled.length}`, fn: res(ref), args: a ?? {}, runAt: now + ms, kind: "action" };
          jobs.push(job);
          scheduled.push(job);
        },
      },
      env: opts.env ?? { EXPO_ACCESS_TOKEN: "expo-secret" },
      now,
      ...(path.length ? { component: { name: path.join("/"), config: composed.configs.get(path.join("/")) } } : {}),
    };
  };
  const runAction = async (name: string, args: unknown) => (all.get(name) as any).handler(ctxFor(name), args);
  const tick = async () => {
    for (;;) {
      const due = jobs.filter((j) => j.runAt <= now)[0];
      if (!due) return;
      jobs = jobs.filter((j) => j !== due);
      if (due.kind === "mutation") mutate(due.fn, due.args);
      else await runAction(due.fn, due.args);
    }
  };
  return {
    engine,
    mutate,
    tick,
    jobs: () => jobs,
    /** Jobs scheduled since the last call, by function name. */
    takeScheduled: () => scheduled.splice(0).map((j) => j.fn),
    /** Rows written by mutations since the last call. */
    takeRowsWritten: () => {
      const n = rowsWritten;
      rowsWritten = 0;
      return n;
    },
    /** Drops pending jobs (a lost job, a crash). */
    dropJobs: (fn: string) => (jobs = jobs.filter((j) => j.fn !== fn)),
    queue: () => engine.runQuery("@push/lib:receiptsQueue").value as { rows: number; tickets: number; drainAt: number | null; inflight: number },
    advance: (ms: number) => (now += ms),
    now: () => now,
    runAction,
  };
}

/**
 * A fake Expo: tickets per message, DeviceNotRegistered for tokens containing "dead". Receipts: DeviceNotRegistered
 * for ids containing "late", none yet (pending) for ids containing "slow" or matching `opts.pending`, else ok.
 */
function fakeExpo(opts: { pending?: (id: string) => boolean } = {}) {
  const calls: Array<{ url: string; body: any; auth: string | null }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      calls.push({ url, body, auth: new Headers(init.headers).get("authorization") });
      if (url.endsWith("/send")) {
        return Response.json({
          data: body.map((m: any, i: number) =>
            m.to.includes("dead") ? { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } } : { status: "ok", id: `t${i}-${m.to}` },
          ),
        });
      }
      const receipt = (id: string) => (id.includes("late") ? { status: "error", message: "x", details: { error: "DeviceNotRegistered" } } : { status: "ok" });
      return Response.json({ data: Object.fromEntries(body.ids.filter((id: string) => !id.includes("slow") && !opts.pending?.(id)).map((id: string) => [id, receipt(id)])) });
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearApnsTokenCache();
  clearFcmTokenCache();
});

/** Fake APNs + FCM behind the global fetch, and the secrets an install reads from the Worker env. */
async function fakeDirect() {
  const k = await apnsKey();
  const sa = await serviceAccount("mail-prod");
  const apns = fakeApns({ publicKey: k.publicKey, teamId: k.teamId, keyId: k.keyId, topic: "dev.ember.mail" });
  const fcm = fakeFcm({ publicKey: sa.publicKey, clientEmail: sa.json.client_email, projectId: "mail-prod" });
  vi.stubGlobal("fetch", vi.fn((input: string, init: RequestInit) => (new URL(String(input)).host.endsWith("apple.com") ? apns.fetch(input, init) : fcm.fetch(input, init))));
  const env = { APNS_KEY: k.pem, APNS_KEY_ID: k.keyId, APNS_TEAM_ID: k.teamId, APNS_TOPIC: "dev.ember.mail", FCM_SERVICE_ACCOUNT: sa.text };
  return { apns, fcm, env };
}

describe("push component", () => {
  test("devices live in the component's table; the old helpers still work on app tables", () => {
    const h = harness();
    h.mutate("chat:register", { user: "u1", token: "ExponentPushToken[a]" });
    h.mutate("chat:register", { user: "u1", token: "ExponentPushToken[b]" });
    h.mutate("chat:register", { user: "u2", token: "ExponentPushToken[b]" }); // moves to u2
    expect(h.mutate("chat:devices", { user: "u1" })).toEqual(["ExponentPushToken[a]"]);
    expect(h.engine.runQuery("@push/lib:count").value).toBe(2);
    expect(typeof registerPushDevice).toBe("function");
  });

  test("send from a mutation is atomic with it, then delivered by an action; dead tokens are pruned and receipts checked", async () => {
    const calls = fakeExpo();
    const h = harness();
    h.mutate("chat:register", { user: "u1", token: "ExponentPushToken[ok]" });
    h.mutate("chat:register", { user: "u1", token: "ExponentPushToken[dead]" });
    h.mutate("chat:register", { user: "u1", token: "ExponentPushToken[late]" });

    expect(() => h.mutate("chat:send", { to: "u1", text: "x", fail: true })).toThrow("rollback");
    expect(h.jobs()).toEqual([]); // nothing enqueued by the failed mutation

    h.mutate("chat:send", { to: "u1", text: "hello" });
    expect(h.jobs().map((j) => j.fn)).toEqual(["@push/lib:deliver"]);
    // The devices travel in the job: the action does not read them again.
    expect((h.jobs()[0]!.args as any).devices.map((d: any) => d.token).sort()).toEqual(["ExponentPushToken[dead]", "ExponentPushToken[late]", "ExponentPushToken[ok]"]);
    await h.tick();
    expect(calls[0]!.url).toMatch(/\/send$/);
    expect(calls[0]!.auth).toBe("Bearer expo-secret");
    expect(calls[0]!.body.map((m: any) => m.to).sort()).toEqual(["ExponentPushToken[dead]", "ExponentPushToken[late]", "ExponentPushToken[ok]"]);
    expect(calls[0]!.body[0]).toMatchObject({ title: "New message", body: "hello" });
    expect(h.mutate("chat:devices", { user: "u1" })).toEqual(["ExponentPushToken[ok]", "ExponentPushToken[late]"]);

    // Receipts 1 s later: "late" is DeviceNotRegistered in its receipt.
    expect(h.jobs().map((j) => j.fn)).toEqual(["@push/lib:drainReceipts"]);
    h.advance(DUE);
    await h.tick();
    expect(calls[1]!.url).toMatch(/getReceipts$/);
    expect(h.mutate("chat:devices", { user: "u1" })).toEqual(["ExponentPushToken[ok]"]);
    // All receipts in: the queue is empty and no drain is left.
    expect(h.queue()).toEqual({ rows: 0, tickets: 0, drainAt: null, inflight: 0 });
    expect(h.jobs()).toEqual([]);
  });

  test("a receipts job from an older version still checks; what is pending joins the batched queue", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: {} }))); // no receipts yet: all pending
    const h = harness();
    const tickets = [{ token: "ExponentPushToken[p]", status: "ok", id: "t-p" }];
    const t0 = h.now();
    expect(await h.runAction("@push/lib:receipts", { tickets, attempt: 1 })).toEqual({ receipts: 0, pending: 1, removed: 0 });
    expect(h.queue()).toMatchObject({ rows: 1, tickets: 1, drainAt: t0 + DUE });
    expect(h.jobs().map((j) => [j.fn, j.runAt - t0])).toEqual([["@push/lib:drainReceipts", DUE]]);
    // Its last attempt: nothing is queued.
    expect(await h.runAction("@push/lib:receipts", { tickets, attempt: 3 })).toEqual({ receipts: 0, pending: 1, removed: 0 });
    expect(h.queue().rows).toBe(1);
  });

  test("an older delivery job (no devices in its args) reads them in the action", async () => {
    const calls = fakeExpo();
    const h = harness();
    h.mutate("chat:register", { user: "u1", token: "ExponentPushToken[ok]" });
    expect(await h.runAction("@push/lib:deliver", { userIds: ["u1"], message: { body: "hi" } })).toEqual({ sent: 1, errors: 0, removedTokens: 0 });
    expect(calls[0]!.body.map((m: any) => m.to)).toEqual(["ExponentPushToken[ok]"]);
  });

  test("send: no job when no recipient has a device; devices embedded up to the limit, read by the action past it", async () => {
    const calls = fakeExpo();
    const h = harness();
    // Before: one deliver job (and one action, one query) per send, devices or not.
    expect(h.mutate("chat:send", { to: "nobody", text: "x" })).toBeNull();
    expect(h.takeScheduled()).toEqual([]);
    expect(h.jobs()).toEqual([]);

    const many = Array.from({ length: SEND_EMBED_MAX_DEVICES + 1 }, (_, i) => `ExponentPushToken[m${i}]`);
    for (const token of many) h.mutate("chat:register", { user: "big", token });
    h.mutate("chat:send", { to: "big", text: "x" });
    expect(h.jobs()).toHaveLength(1);
    expect((h.jobs()[0]!.args as any).devices).toBeUndefined();
    await h.tick();
    expect(calls[0]!.body).toHaveLength(SEND_EMBED_MAX_DEVICES + 1);

    // Past the embed limit the action reads them again: the caller's mutation stops reading there.
    for (let i = many.length; i < 60; i++) h.mutate("chat:register", { user: "big", token: `ExponentPushToken[m${i}]` });
    const precheck = h.engine.runMutation("@push/lib:send", { userIds: ["big"], message: { body: "x" } });
    expect(precheck.usage!.documentsRead).toBe(SEND_EMBED_MAX_DEVICES + 1);
    expect((precheck.scheduled[0]!.args as any).devices).toBeUndefined();

    // Over SEND_PRECHECK_MAX_USERS users: not read in the caller's mutation (bounded cost there), as before.
    const userIds = Array.from({ length: SEND_PRECHECK_MAX_USERS + 1 }, (_, i) => `x${i}`);
    expect(typeof h.mutate("@push/lib:send", { userIds, message: { body: "x" } })).toBe("string");
    expect(h.takeScheduled()).toContain("@push/lib:deliver");
  });

  test("a delivery job that starts late reads the devices again: a token moved meanwhile does not get the push", async () => {
    const calls = fakeExpo();
    const h = harness();
    h.mutate("chat:register", { user: "u1", token: "ExponentPushToken[shared]" });
    h.mutate("chat:register", { user: "u1", token: "ExponentPushToken[own]" });
    h.mutate("chat:send", { to: "u1", text: "for u1" });
    expect((h.jobs()[0]!.args as any).devices).toHaveLength(2);
    // Before the job runs, the shared device signs in as u2 (the token moves), and the job starts late.
    h.mutate("chat:register", { user: "u2", token: "ExponentPushToken[shared]" });
    h.advance(SEND_EMBED_FRESH_MS + 1);
    await h.tick();
    expect(calls[0]!.body.map((m: any) => m.to)).toEqual(["ExponentPushToken[own]"]);
  });

  test("receipts of many sends share one drain and one Expo request (was: a job and a request per send)", async () => {
    const calls = fakeExpo();
    const h = harness();
    for (let i = 0; i < 10; i++) h.mutate("chat:register", { user: `u${i}`, token: `ExponentPushToken[u${i}]` });
    h.takeScheduled();
    h.takeRowsWritten();
    // Two bursts 50 ms apart: both inside the first drain's window.
    for (let i = 0; i < 10; i++) {
      if (i === 5) h.advance(50);
      h.mutate("chat:send", { to: `u${i}`, text: "x" });
      await h.tick();
    }
    // 10 deliveries, then one drain for every receipt (before: 10 `lib:receipts` jobs).
    expect(h.takeScheduled().sort()).toEqual([...Array(10).fill("@push/lib:deliver"), "@push/lib:drainReceipts"]);
    expect(h.queue()).toMatchObject({ rows: 10, tickets: 10 });
    const sendWrites = h.takeRowsWritten();
    h.advance(1000); // receiptsDelayMs: never checked earlier
    await h.tick();
    expect(calls.filter((c) => c.url.endsWith("getReceipts"))).toHaveLength(0);
    h.advance(DUE - 1000);
    await h.tick();
    const receiptCalls = calls.filter((c) => c.url.endsWith("getReceipts"));
    expect(receiptCalls).toHaveLength(1);
    expect(receiptCalls[0]!.body.ids).toHaveLength(10);
    expect(h.queue()).toEqual({ rows: 0, tickets: 0, drainAt: null, inflight: 0 });
    expect(h.jobs()).toEqual([]);
    // Rows (jobs not counted: the shard's `_jobs`): per send, the app's message and one pendingReceipts row, plus the
    // drain row once; the drain moves its row (claim) and deletes the 10 rows and itself (settle). Before, each send
    // also left a `lib:receipts` job row, and each of those an action, a receipts request and its `_jobs` updates.
    expect({ sendWrites, drainWrites: h.takeRowsWritten() }).toEqual({ sendWrites: 10 + 10 + 1, drainWrites: 1 + 10 + 1 });
  });

  test("pending tickets are checked again after receiptsDelayMs, 3 checks in all, then dropped", async () => {
    const calls = fakeExpo();
    const h = harness();
    h.mutate("chat:register", { user: "u1", token: "ExponentPushToken[slow]" });
    h.mutate("chat:register", { user: "u1", token: "ExponentPushToken[ok]" });
    h.mutate("chat:send", { to: "u1", text: "x" });
    await h.tick();
    for (let check = 1; check <= 3; check++) {
      expect(h.queue()).toMatchObject({ rows: 1, tickets: check === 1 ? 2 : 1 });
      h.advance(DUE);
      await h.tick();
      expect(calls.filter((c) => c.url.endsWith("getReceipts")).at(-1)!.body.ids).toHaveLength(check === 1 ? 2 : 1);
    }
    expect(calls.filter((c) => c.url.endsWith("getReceipts"))).toHaveLength(3);
    expect(h.queue()).toEqual({ rows: 0, tickets: 0, drainAt: null, inflight: 0 });
    expect(h.jobs()).toEqual([]);
  });

  test("a drain checks at most 1000 tickets (one Expo request); the rest are drained right after", async () => {
    const calls = fakeExpo();
    const h = harness();
    const tickets = (tag: string, n: number) => Array.from({ length: n }, (_, i) => ({ token: `ExponentPushToken[${tag}${i}]`, id: `${tag}-${i}` }));
    h.mutate("@push/lib:queueReceipts", { tokens: [], tickets: tickets("a", 1500), attempt: 1 });
    h.mutate("@push/lib:queueReceipts", { tokens: [], tickets: tickets("b", 700), attempt: 1 });
    expect(h.queue()).toMatchObject({ rows: 3, tickets: 2200 }); // 1000 + 500 + 700: no row over one request
    expect(h.jobs().map((j) => j.fn)).toEqual(["@push/lib:drainReceipts"]);
    h.advance(DUE);
    await h.tick();
    expect(calls.map((c) => c.body.ids.length)).toEqual([1000, 500, 700]);
    expect(h.queue()).toEqual({ rows: 0, tickets: 0, drainAt: null, inflight: 0 });
  });

  test("a drain that dies after claiming: the safety drain checks again, counting attempts, never looping", async () => {
    const calls = fakeExpo();
    const h = harness();
    h.mutate("@push/lib:queueReceipts", { tokens: [], tickets: [{ token: "ExponentPushToken[c]", id: "c-1" }], attempt: 1 });
    const crash = () => {
      const job = h.jobs().find((j) => j.fn === "@push/lib:drainReceipts")!;
      h.dropJobs("@push/lib:drainReceipts");
      // The action claimed its batch (a mutation that committed) and died before settling.
      expect(h.mutate("@push/lib:claimReceipts", job.args)).toMatchObject({ tickets: [{ id: "c-1" }] });
      expect(h.queue()).toMatchObject({ rows: 1, inflight: 1 });
    };
    h.advance(DUE);
    crash(); // check 1
    expect(h.jobs().map((j) => j.fn)).toEqual(["@push/lib:drainReceipts"]); // the safety drain
    h.advance(60_000);
    crash(); // check 2 (attempt counted for the crashed check 1)
    h.advance(60_000);
    crash(); // check 3
    h.advance(60_000);
    await h.tick(); // the last attempt was used up: dropped without another request
    expect(calls).toHaveLength(0);
    expect(h.queue()).toEqual({ rows: 0, tickets: 0, drainAt: null, inflight: 0 });
    expect(h.jobs()).toEqual([]);
  });

  test("a drain slower than its safety net: its late settle does not count the rows twice", async () => {
    fakeExpo({ pending: () => true });
    const h = harness();
    h.mutate("@push/lib:queueReceipts", { tokens: [], tickets: [{ token: "ExponentPushToken[s]", id: "s-1" }], attempt: 1 });
    h.advance(DUE);
    const job = h.jobs()[0]!;
    h.dropJobs("@push/lib:drainReceipts");
    const claimed = h.mutate("@push/lib:claimReceipts", job.args) as any;
    // Meanwhile the safety drain ran, took the rows as crashed (attempt 2) and checked them.
    h.advance(60_000);
    await h.tick();
    expect(h.queue()).toMatchObject({ rows: 1, inflight: 0 });
    // The first drain settles late: a row it no longer owns, under a nonce that is not the chain's.
    expect(h.mutate("@push/lib:settleReceipts", { nonce: claimed.nonce, rows: claimed.rows, pending: ["s-1"], tokens: [] })).toBe(0);
    expect(h.queue()).toMatchObject({ rows: 1, tickets: 1 });
    expect(h.jobs().map((j) => j.fn)).toEqual(["@push/lib:drainReceipts"]);
  });

  test("a late settle leaves the marker of the drain that took its rows: that drain crashing still counts", async () => {
    const calls = fakeExpo({ pending: () => true });
    const h = harness();
    h.mutate("@push/lib:queueReceipts", { tokens: [], tickets: [{ token: "ExponentPushToken[s]", id: "s-1" }], attempt: 1 });
    h.advance(DUE);
    const claimAs = () => {
      const job = h.jobs().find((j) => j.fn === "@push/lib:drainReceipts")!;
      h.dropJobs("@push/lib:drainReceipts");
      return h.mutate("@push/lib:claimReceipts", job.args) as any;
    };
    const first = claimAs(); // check 1, still running
    h.advance(60_000);
    claimAs(); // the safety drain takes the row (attempt 2) and dies before settling
    // The first drain settles late, superseded: the row is not its own any more, nor is the marker.
    expect(h.mutate("@push/lib:settleReceipts", { nonce: first.nonce, rows: first.rows, pending: ["s-1"], tokens: [] })).toBe(0);
    expect(h.queue()).toMatchObject({ rows: 1, inflight: 1 });
    // The next drain counts the crashed check 2: this is check 3, the last one.
    h.advance(60_000);
    await h.tick();
    expect(calls.filter((c) => c.url.endsWith("getReceipts"))).toHaveLength(1);
    expect(h.queue()).toEqual({ rows: 0, tickets: 0, drainAt: null, inflight: 0 });
    expect(h.jobs()).toEqual([]);
  });

  test("a send while a check runs does not move its safety drain earlier (it would take the check for crashed)", async () => {
    const calls = fakeExpo();
    const h = harness();
    h.mutate("@push/lib:queueReceipts", { tokens: [], tickets: [{ token: "ExponentPushToken[a]", id: "a-1" }], attempt: 1 });
    h.advance(DUE);
    const job = h.jobs()[0]!;
    h.dropJobs("@push/lib:drainReceipts");
    const claimed = h.mutate("@push/lib:claimReceipts", job.args) as any; // the check is running
    const safety = h.jobs()[0]!.runAt;
    h.advance(100);
    h.mutate("@push/lib:queueReceipts", { tokens: [], tickets: [{ token: "ExponentPushToken[b]", id: "b-1" }], attempt: 1 });
    expect(h.jobs().map((j) => j.runAt)).toEqual([safety]); // before: moved to b-1's window, ~1.1 s from now
    h.advance(DUE);
    await h.tick();
    expect(calls).toHaveLength(0);
    // The running check settles and points the chain at b-1's row.
    h.mutate("@push/lib:settleReceipts", { nonce: claimed.nonce, rows: claimed.rows, pending: [], tokens: [] });
    await h.tick();
    expect(calls.map((c) => c.body.ids)).toEqual([["b-1"]]);
    expect(h.queue()).toEqual({ rows: 0, tickets: 0, drainAt: null, inflight: 0 });
  });

  test("a lost drain job is replaced by the next send; a superseded drain does nothing", async () => {
    const calls = fakeExpo();
    const h = harness();
    h.mutate("@push/lib:queueReceipts", { tokens: [], tickets: [{ token: "ExponentPushToken[l]", id: "l-1" }], attempt: 1 });
    const lost = h.jobs()[0]!;
    h.dropJobs("@push/lib:drainReceipts"); // never runs
    h.advance(DUE + RECEIPTS_DRAIN_STALE_MS + 1);
    h.mutate("@push/lib:queueReceipts", { tokens: [], tickets: [{ token: "ExponentPushToken[m]", id: "m-1" }], attempt: 1 });
    expect(h.jobs().map((j) => [j.fn, j.runAt - h.now()])).toEqual([["@push/lib:drainReceipts", 0]]);
    // The lost one, if it ever runs, is not the chain's drain.
    expect(await h.runAction("@push/lib:drainReceipts", lost.args)).toEqual({ receipts: 0, pending: 0, removed: 0 });
    expect(calls).toHaveLength(0);
    await h.tick(); // l-1 (overdue) now; m-1 when due
    h.advance(DUE);
    await h.tick();
    expect(calls.flatMap((c) => c.body.ids).sort()).toEqual(["l-1", "m-1"]);
    expect(h.queue()).toEqual({ rows: 0, tickets: 0, drainAt: null, inflight: 0 });
  });

  test("receiptsDelayMs: 0 queues nothing", async () => {
    fakeExpo();
    const h = harness({ config: { receiptsDelayMs: 0 } });
    h.mutate("chat:register", { user: "u1", token: "ExponentPushToken[ok]" });
    h.mutate("chat:send", { to: "u1", text: "x" });
    await h.tick();
    expect(h.queue().rows).toBe(0);
    expect(h.jobs()).toEqual([]);
  });

    test("sendNow from an action reports counts; users without devices send nothing", async () => {
    fakeExpo();
    const h = harness();
    h.mutate("chat:register", { user: "u1", token: "ExponentPushToken[ok]" });
    expect(await h.runAction("@push/lib:sendNow", { userIds: ["u1", "nobody"], message: { body: "hi" } })).toEqual({ sent: 1, errors: 0, removedTokens: 0 });
    expect(await h.runAction("@push/lib:sendNow", { userIds: ["nobody"], message: { body: "hi" } })).toEqual({ sent: 0, errors: 0, removedTokens: 0 });
  });
});

describe("push component, direct transport", () => {
  const fcmToken = (tag: string) => `${tag}:APA91b${"z".repeat(140)}`;

  test("native devices go to APNs/FCM with the env secrets, sealed when they registered a key; dead tokens pruned, environments recorded", async () => {
    const { apns, fcm, env } = await fakeDirect();
    const h = harness({ env, config: { encryption: "required", fallback: { title: "New mail", body: "Open Mail" } } });
    const iphone = await generateRecipient();
    const pixel = await generateRecipient();
    h.mutate("chat:registerNative", { user: "u1", device: { token: hexToken("ok", 1), platform: "ios", environment: "production", publicKey: toBase64url(iphone.publicKey) } });
    h.mutate("chat:registerNative", { user: "u1", device: { token: hexToken("sandbox", 2), platform: "ios" } }); // environment unknown
    h.mutate("chat:registerNative", { user: "u1", device: { token: hexToken("dead", 3), platform: "ios", environment: "production" } });
    h.mutate("chat:registerNative", { user: "u1", device: { token: fcmToken("pixel"), platform: "android", publicKey: toBase64url(pixel.publicKey) } });
    h.mutate("chat:registerNative", { user: "u1", device: { token: fcmToken("dead"), platform: "android" } });

    h.mutate("chat:send", { to: "u1", text: "Re: orçamento" });
    await h.tick();

    const sealed = apns.requests.find((r) => r.path.endsWith(hexToken("ok", 1)))!;
    expect(sealed.body.aps.alert).toEqual({ title: "New mail", body: "Open Mail" });
    expect(await openPushEnvelope(iphone, sealed.body.ember)).toMatchObject({ title: "New message", body: "Re: orçamento" });
    const fcmSend = fcm.requests.find((r) => r.body?.message?.token === fcmToken("pixel"))!;
    expect(await openPushEnvelope(pixel, JSON.parse(fcmSend.body.message.data.ember))).toMatchObject({ body: "Re: orçamento" });
    // No key + required → fallback only.
    expect(apns.requests.find((r) => r.path.endsWith(hexToken("sandbox", 2)) && r.host.includes("sandbox"))!.body.aps.alert).toEqual({ title: "New mail", body: "Open Mail" });

    const rows = h.mutate("chat:deviceRows", { user: "u1" }) as any[];
    expect(rows.map((d) => [d.token, d.provider, d.environment ?? null]).sort()).toEqual(
      [
        [hexToken("ok", 1), "apns", "production"],
        [hexToken("sandbox", 2), "apns", "sandbox"],
        [fcmToken("pixel"), "fcm", null],
      ].sort(),
    );
    expect(h.jobs()).toEqual([]); // no Expo tickets: no receipts check
  });

  test("setPushSeal: the app's own payload for the installed component's direct devices, removed with null", async () => {
    const { apns, env } = await fakeDirect();
    const h = harness({ env });
    h.mutate("chat:registerNative", { user: "u1", device: { token: hexToken("ok", 7), platform: "ios", environment: "production" } });
    setPushSeal((device, message) => ({ apns: { aps: { alert: { title: "Own" } }, own: { to: device.token.slice(0, 4), body: message.body } } }));
    try {
      h.mutate("chat:send", { to: "u1", text: "x" });
      await h.tick();
      expect(apns.requests.at(-1)!.body).toEqual({ aps: { alert: { title: "Own" } }, own: { to: hexToken("ok", 7).slice(0, 4), body: "x" } });
    } finally {
      setPushSeal(null);
    }
    h.mutate("chat:send", { to: "u1", text: "y" });
    await h.tick();
    expect(apns.requests.at(-1)!.body.aps.alert).toMatchObject({ body: "y" });
  });

  test("missing secrets: devices are kept and the result says ProviderNotConfigured", async () => {
    const { env } = await fakeDirect();
    const h = harness({ env: { APNS_KEY: env.APNS_KEY } });
    h.mutate("chat:registerNative", { user: "u1", device: { token: hexToken("ok", 1), platform: "ios" } });
    h.mutate("chat:registerNative", { user: "u1", device: { token: fcmToken("a"), platform: "android" } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await h.runAction("@push/lib:sendNow", { userIds: ["u1"], message: { body: "hi" } })).toEqual({
      sent: 0,
      errors: 2,
      removedTokens: 0,
      errorCodes: { ProviderNotConfigured: 2 },
    });
    expect(warn.mock.calls.map((c) => String(c[0]))).toEqual([
      "[push] APNs devices skipped: set APNS_KEY_ID, APNS_TEAM_ID, APNS_TOPIC (or config.apns.topic)",
      "[push] FCM devices skipped: set FCM_SERVICE_ACCOUNT",
    ]);
    warn.mockRestore();
    expect((h.mutate("chat:deviceRows", { user: "u1" }) as any[]).length).toBe(2);
  });

  test("register validates environment and public key", () => {
    const h = harness();
    expect(() => h.mutate("chat:registerNative", { user: "u1", device: { token: hexToken("ok"), environment: "dev" } })).toThrow(/sandbox/);
    expect(() => h.mutate("chat:registerNative", { user: "u1", device: { token: hexToken("ok"), publicKey: "nope" } })).toThrow(/P-256/);
  });
});
