import { createEngine, defineSchema, defineTable, mutationGeneric, queryGeneric, v, type MutationCtx, type QueryCtx } from "@ember/server";
import { createNodeSqliteDriver } from "@ember/server/testing";
import { describe, expect, it } from "vitest";
import {
  pushDevicesForUser,
  pushDevicesTable,
  pushTokensForUsers,
  registerPushDevice,
  removePushTokens,
  unregisterPushDevice,
} from "../src/index.ts";

const schema = defineSchema({
  tables: {
    messages: defineTable({ body: v.string() }),
    pushDevices: pushDevicesTable(),
  },
});

function fresh() {
  let clock = 1_700_000_000_000;
  const engine = createEngine({ schema, driver: createNodeSqliteDriver(), now: () => (clock += 1) });
  engine.migrate();
  const tx = <R>(fn: (ctx: MutationCtx) => R) =>
    engine.runMutation(mutationGeneric({ handler: (ctx: MutationCtx) => fn(ctx) as any }) as any, {}).value as R;
  const run = <R>(fn: (ctx: QueryCtx) => R) => engine.runQuery(queryGeneric({ handler: (ctx: QueryCtx) => fn(ctx) as any }) as any, {}).value as R;
  return { tx, run };
}

const T1 = "ExponentPushToken[one]";
const T2 = "ExponentPushToken[two]";
const T3 = "ExponentPushToken[three]";

describe("push device table helpers", () => {
  it("upserts by token, moves a token between users and lists tokens per user", () => {
    const { tx, run } = fresh();
    const id1 = tx((ctx) => registerPushDevice(ctx, { userId: "alice", token: T1, platform: "ios" }));
    tx((ctx) => registerPushDevice(ctx, { userId: "alice", token: T2, platform: "android", deviceName: "Pixel" }));
    tx((ctx) => registerPushDevice(ctx, { userId: "bob", token: T3 }));
    // Same token again: same row, refreshed updatedAt.
    const before = run((ctx) => pushDevicesForUser(ctx.db, "alice")).find((d) => d.token === T1)!;
    expect(tx((ctx) => registerPushDevice(ctx, { userId: "alice", token: T1, platform: "ios" }))).toBe(id1);
    const after = run((ctx) => pushDevicesForUser(ctx.db, "alice")).find((d) => d.token === T1)!;
    expect(after.updatedAt).toBeGreaterThan(before.updatedAt);
    expect(after).toMatchObject({ provider: "expo", platform: "ios" });

    expect(run((ctx) => pushTokensForUsers(ctx.db, ["alice", "bob", "alice"])).sort()).toEqual([T1, T2, T3].sort());

    // Bob signs in on Alice's phone.
    expect(tx((ctx) => registerPushDevice(ctx, { userId: "bob", token: T1 }))).toBe(id1);
    expect(run((ctx) => pushTokensForUsers(ctx.db, ["alice"]))).toEqual([T2]);
    expect(run((ctx) => pushTokensForUsers(ctx.db, ["bob"])).sort()).toEqual([T1, T3].sort());
    expect(run((ctx) => pushTokensForUsers(ctx.db, ["bob"], { provider: "apns" }))).toEqual([]);
  });

  it("unregisters a device and prunes unregistered tokens", () => {
    const { tx, run } = fresh();
    for (const token of [T1, T2, T3]) tx((ctx) => registerPushDevice(ctx, { userId: "alice", token }));
    expect(tx((ctx) => unregisterPushDevice(ctx.db, T1))).toBe(true);
    expect(tx((ctx) => unregisterPushDevice(ctx.db, T1))).toBe(false);
    expect(tx((ctx) => removePushTokens(ctx.db, [T2, T2, "ExponentPushToken[missing]"]))).toBe(1);
    expect(run((ctx) => pushTokensForUsers(ctx.db, ["alice"]))).toEqual([T3]);
  });

  it("rejects an empty token", () => {
    const { tx } = fresh();
    expect(() => tx((ctx) => registerPushDevice(ctx, { userId: "alice", token: "" }))).toThrow(/empty token/);
  });
});
