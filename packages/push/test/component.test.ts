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
import { pushComponent, PushNotifications, registerPushDevice } from "../src/index.ts";

const push = new PushNotifications(anyComponents.push);
const app = defineApp().use(pushComponent, { config: { receiptsDelayMs: 1000 } });
const schema = defineSchema({ tables: { messages: defineTable({ to: v.string(), text: v.string() }) } });

const fns = {
  chat: {
    register: mutationGeneric({ args: { user: v.string(), token: v.string() }, handler: (ctx: any, a: any) => push.register(ctx, { userId: a.user, token: a.token, platform: "ios" }) }),
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

function harness() {
  let now = 1_700_000_000_000;
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
      env: { EXPO_ACCESS_TOKEN: "expo-secret" },
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

afterEach(() => vi.unstubAllGlobals());

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

  test("sendNow from an action reports counts; users without devices send nothing", async () => {
    fakeExpo();
    const h = harness();
    h.mutate("chat:register", { user: "u1", token: "ExponentPushToken[ok]" });
    expect(await h.runAction("@push/lib:sendNow", { userIds: ["u1", "nobody"], message: { body: "hi" } })).toEqual({ sent: 1, errors: 0, removedTokens: 0 });
    expect(await h.runAction("@push/lib:sendNow", { userIds: ["nobody"], message: { body: "hi" } })).toEqual({ sent: 0, errors: 0, removedTokens: 0 });
  });
});
