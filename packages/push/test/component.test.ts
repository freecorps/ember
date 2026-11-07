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
import { fakeApns, fakeFcm, hexToken } from "./fakes.ts";
import { apnsKey, serviceAccount } from "./keys.ts";

const push = new PushNotifications(anyComponents.push);
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
  const mutate = (name: string, args: unknown) => {
    const r = engine.runMutation(name, args);
    jobs.push(...r.scheduled);
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
      scheduler: { runAfter: async (ms: number, ref: unknown, a?: unknown) => jobs.push({ id: `j${jobs.length}`, fn: res(ref), args: a ?? {}, runAt: now + ms, kind: "action" }) },
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
  return { engine, mutate, tick, jobs: () => jobs, advance: (ms: number) => (now += ms), runAction };
}

/** A fake Expo: tickets per message, DeviceNotRegistered for tokens containing "dead". */
function fakeExpo() {
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
      return Response.json({ data: Object.fromEntries(body.ids.map((id: string) => [id, id.includes("late") ? { status: "error", message: "x", details: { error: "DeviceNotRegistered" } } : { status: "ok" }])) });
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
    await h.tick();
    expect(calls[0]!.url).toMatch(/\/send$/);
    expect(calls[0]!.auth).toBe("Bearer expo-secret");
    expect(calls[0]!.body.map((m: any) => m.to).sort()).toEqual(["ExponentPushToken[dead]", "ExponentPushToken[late]", "ExponentPushToken[ok]"]);
    expect(calls[0]!.body[0]).toMatchObject({ title: "New message", body: "hello" });
    expect(h.mutate("chat:devices", { user: "u1" })).toEqual(["ExponentPushToken[ok]", "ExponentPushToken[late]"]);

    // Receipts 1 s later: "late" is DeviceNotRegistered in its receipt.
    expect(h.jobs().map((j) => j.fn)).toEqual(["@push/lib:receipts"]);
    h.advance(1000);
    await h.tick();
    expect(calls[1]!.url).toMatch(/getReceipts$/);
    expect(h.mutate("chat:devices", { user: "u1" })).toEqual(["ExponentPushToken[ok]"]);
  });

  test("pending receipts are re-checked after the install's receiptsDelayMs, up to 3 attempts", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ data: {} }))); // no receipts yet: all pending
    const h = harness();
    const tickets = [{ token: "ExponentPushToken[p]", status: "ok", id: "t-p" }];
    const t0 = h.advance(0);
    expect(await h.runAction("@push/lib:receipts", { tickets, attempt: 1 })).toEqual({ receipts: 0, pending: 1, removed: 0 });
    expect(h.jobs().map((j) => [j.fn, j.runAt - t0, (j.args as any).attempt])).toEqual([["@push/lib:receipts", 1000, 2]]);
    h.advance(1000);
    await h.tick(); // attempt 2 schedules attempt 3, which is the last
    expect(h.jobs().map((j) => [j.runAt - t0, (j.args as any).attempt])).toEqual([[2000, 3]]);
    h.advance(1000);
    await h.tick();
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
