import { createEngine, defineSchema, defineTable, mutationGeneric, queryGeneric, v, type MutationCtx, type QueryCtx } from "@freecorps/ember-server";
import { createNodeSqliteDriver } from "@freecorps/ember-server/testing";
import { describe, expect, it } from "vitest";
import {
  generateRecipient,
  pushDevicesForUser,
  pushDevicesForUsers,
  pushDevicesTable,
  pushTokensForUsers,
  registerPushDevice,
  removePushTokens,
  removeVoipTokens,
  setPushDeviceEnvironment,
  toBase64url,
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
  const txFull = <R>(fn: (ctx: MutationCtx) => R) => engine.runMutation(mutationGeneric({ handler: (ctx: MutationCtx) => fn(ctx) as any }) as any, {});
  const tx = <R>(fn: (ctx: MutationCtx) => R) => txFull(fn).value as R;
  /** Rows the mutation wrote. */
  const writes = (fn: (ctx: MutationCtx) => unknown) => txFull(fn).changes.length;
  const run = <R>(fn: (ctx: QueryCtx) => R) => engine.runQuery(queryGeneric({ handler: (ctx: QueryCtx) => fn(ctx) as any }) as any, {}).value as R;
  return { tx, run, writes, advance: (ms: number) => (clock += ms) };
}

const T1 = "ExponentPushToken[one]";
const T2 = "ExponentPushToken[two]";
const T3 = "ExponentPushToken[three]";

describe("push device table helpers", () => {
  it("an identical registration under 24 h old writes nothing; a change, or 24 h, writes", () => {
    const { tx, run, writes, advance } = fresh();
    const row = () => run((ctx) => pushDevicesForUser(ctx.db, "alice"))[0]!;
    expect(writes((ctx) => registerPushDevice(ctx, { userId: "alice", token: T1, platform: "ios" }))).toBe(1);
    const t0 = row().updatedAt;
    // Every app launch registers again: before, one patch (updatedAt) each time.
    for (let i = 0; i < 5; i++) expect(writes((ctx) => registerPushDevice(ctx, { userId: "alice", token: T1, platform: "ios" }))).toBe(0);
    // Fields left out keep their stored value: still nothing to write.
    expect(writes((ctx) => registerPushDevice(ctx, { userId: "alice", token: T1 }))).toBe(0);
    expect(row().updatedAt).toBe(t0);
    // Anything that changes writes (and refreshes updatedAt).
    expect(writes((ctx) => registerPushDevice(ctx, { userId: "alice", token: T1, deviceName: "iPhone" }))).toBe(1);
    expect(row()).toMatchObject({ deviceName: "iPhone", platform: "ios" });
    expect(writes((ctx) => registerPushDevice(ctx, { userId: "bob", token: T1 }))).toBe(1); // moved to bob
    expect(writes((ctx) => registerPushDevice(ctx, { userId: "bob", token: T1, provider: "expo" }))).toBe(0); // inferred the same
    const t1 = run((ctx) => pushDevicesForUser(ctx.db, "bob"))[0]!.updatedAt;
    // 24 h later the same registration refreshes updatedAt once.
    advance(24 * 3600_000);
    expect(writes((ctx) => registerPushDevice(ctx, { userId: "bob", token: T1 }))).toBe(1);
    const t2 = run((ctx) => pushDevicesForUser(ctx.db, "bob"))[0]!.updatedAt;
    expect(t2 - t1).toBeGreaterThanOrEqual(24 * 3600_000);
    expect(writes((ctx) => registerPushDevice(ctx, { userId: "bob", token: T1 }))).toBe(0);
    // A row from the future (a bad clock) is rewritten rather than trusted for 24 h.
    tx((ctx) => ctx.db.patch(run((c) => pushDevicesForUser(c.db, "bob"))[0]!._id as never, { updatedAt: t2 + 3600_000 } as never));
    expect(writes((ctx) => registerPushDevice(ctx, { userId: "bob", token: T1 }))).toBe(1);
  });

  it("an old row without the newer optional fields gains them on the next registration", () => {
    const { tx, run, writes } = fresh();
    // A row written before the direct-transport fields existed.
    tx((ctx) => ctx.db.insert("pushDevices", { userId: "alice", token: T1, provider: "expo", updatedAt: ctx.now } as never));
    expect(writes((ctx) => registerPushDevice(ctx, { userId: "alice", token: T1 }))).toBe(0);
    expect(writes((ctx) => registerPushDevice(ctx, { userId: "alice", token: T1, platform: "ios" }))).toBe(1);
    expect(run((ctx) => pushDevicesForUser(ctx.db, "alice"))[0]).toMatchObject({ platform: "ios" });
  });

  it("upserts by token, moves a token between users and lists tokens per user", () => {
    const { tx, run } = fresh();
    const id1 = tx((ctx) => registerPushDevice(ctx, { userId: "alice", token: T1, platform: "ios" }));
    tx((ctx) => registerPushDevice(ctx, { userId: "alice", token: T2, platform: "android", deviceName: "Pixel" }));
    tx((ctx) => registerPushDevice(ctx, { userId: "bob", token: T3 }));
    // Same token again: same row (unchanged and fresh: not rewritten, see the test below).
    const before = run((ctx) => pushDevicesForUser(ctx.db, "alice")).find((d) => d.token === T1)!;
    expect(tx((ctx) => registerPushDevice(ctx, { userId: "alice", token: T1, platform: "ios" }))).toBe(id1);
    const after = run((ctx) => pushDevicesForUser(ctx.db, "alice")).find((d) => d.token === T1)!;
    expect(after.updatedAt).toBe(before.updatedAt);
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

  it("stores native tokens with environment, VoIP token and public key; infers the provider", async () => {
    const { tx, run } = fresh();
    const r = await generateRecipient();
    const publicKey = toBase64url(r.publicKey);
    const apns = "ab".repeat(32);
    tx((ctx) => registerPushDevice(ctx, { userId: "alice", token: apns, platform: "ios", environment: "sandbox", voipToken: "cd".repeat(32), publicKey }));
    tx((ctx) => registerPushDevice(ctx, { userId: "alice", token: "fcm-token:APA91b-xyz", platform: "android" }));
    tx((ctx) => registerPushDevice(ctx, { userId: "bob", token: T1 }));
    const all = run((ctx) => pushDevicesForUsers(ctx.db, ["alice", "bob"]));
    expect(all.map((d) => [d.token, d.provider, d.environment ?? null])).toEqual([
      [apns, "apns", "sandbox"],
      ["fcm-token:APA91b-xyz", "fcm", null],
      [T1, "expo", null],
    ]);
    expect(all[0]).toMatchObject({ voipToken: "cd".repeat(32), publicKey });
    expect(run((ctx) => pushDevicesForUsers(ctx.db, ["alice"], { provider: "fcm" })).map((d) => d.token)).toEqual(["fcm-token:APA91b-xyz"]);

    // Re-registering without the optional fields keeps them.
    tx((ctx) => registerPushDevice(ctx, { userId: "alice", token: apns, platform: "ios" }));
    expect(run((ctx) => pushDevicesForUser(ctx.db, "alice"))[0]).toMatchObject({ environment: "sandbox", publicKey });

    // A discovered environment is recorded; a dead VoIP token is cleared, the device stays.
    expect(tx((ctx) => setPushDeviceEnvironment(ctx.db, apns, "production"))).toBe(true);
    expect(tx((ctx) => setPushDeviceEnvironment(ctx.db, apns, "production"))).toBe(false);
    expect(tx((ctx) => removeVoipTokens(ctx.db, [{ userId: "alice", voipToken: "cd".repeat(32) }]))).toBe(1);
    const after = run((ctx) => pushDevicesForUser(ctx.db, "alice"))[0]!;
    expect(after.environment).toBe("production");
    expect(after.voipToken).toBeUndefined();
  });

  it("rejects a bad environment, provider or public key", () => {
    const { tx } = fresh();
    expect(() => tx((ctx) => registerPushDevice(ctx, { userId: "a", token: "ab".repeat(32), provider: "APNS" }))).toThrow(/provider must be/);
    expect(() => tx((ctx) => registerPushDevice(ctx, { userId: "a", token: "ab".repeat(32), environment: "development" }))).toThrow(/sandbox/);
    expect(() => tx((ctx) => registerPushDevice(ctx, { userId: "a", token: "ab".repeat(32), publicKey: "AAAA" }))).toThrow(/P-256/);
  });

  it("rejects an empty token", () => {
    const { tx } = fresh();
    expect(() => tx((ctx) => registerPushDevice(ctx, { userId: "alice", token: "" }))).toThrow(/empty token/);
  });
});
