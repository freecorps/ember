import { describe, expect, it, vi } from "vitest";
import {
  AsyncStoragePendingStorage,
  keyValueTokenStore,
  memoryTokenStore,
  registerForPush,
  secureTokenStore,
  type NotificationsLike,
} from "../src/index.ts";
import { fakeAsyncStorage, fakeSecureStore } from "./fakes.ts";

describe("AsyncStoragePendingStorage", () => {
  it("persists the clientId and pending mutations (tagged JSON) across instances", async () => {
    const as = fakeAsyncStorage();
    const s1 = new AsyncStoragePendingStorage(as, "app");
    expect(await s1.getClientId()).toBeNull();
    await s1.setClientId("c1");
    await s1.load();
    const bytes = new Uint8Array([1, 2, 255]);
    await Promise.all([
      s1.put({ mid: "m1", shard: "global:main", fn: "files:put", args: { data: bytes, n: 10n }, createdAt: 1 }),
      s1.put({ mid: "m2", shard: "global:main", fn: "messages:send", args: { body: "hi" }, createdAt: 2 }),
    ]);
    await s1.remove("m2");
    expect([...as.map.keys()].sort()).toEqual(["app:clientId", "app:pending"]);

    const s2 = new AsyncStoragePendingStorage(as, "app");
    expect(await s2.getClientId()).toBe("c1");
    const restored = await s2.load();
    expect(restored).toHaveLength(1);
    expect(restored[0]!.args.data).toEqual(bytes);
    expect(restored[0]!.args.n).toBe(10n);
  });

  it("throws a helpful error without AsyncStorage", () => {
    expect(() => new AsyncStoragePendingStorage(null)).toThrow(/async-storage/);
  });
});

describe("token stores", () => {
  it("secure, key-value and memory stores round-trip", async () => {
    const ss = fakeSecureStore();
    const ls = new Map<string, string>();
    const stores = [
      secureTokenStore({ secureStore: ss, key: "k" }),
      keyValueTokenStore({ getItem: (k) => ls.get(k) ?? null, setItem: (k, v) => void ls.set(k, v), removeItem: (k) => void ls.delete(k) }, "k"),
      memoryTokenStore(),
    ];
    for (const s of stores) {
      expect(await s.get()).toBeNull();
      await s.set("tok");
      expect(await s.get()).toBe("tok");
      await s.clear();
      expect(await s.get()).toBeNull();
    }
    expect(() => secureTokenStore({ secureStore: null })).toThrow(/expo-secure-store/);
  });
});

function fakeNotifications(perm: { status: string; canAskAgain?: boolean }, afterRequest = perm) {
  const n = {
    getPermissionsAsync: vi.fn(async () => perm),
    requestPermissionsAsync: vi.fn(async () => afterRequest),
    getExpoPushTokenAsync: vi.fn(async (o?: { projectId?: string }) => ({ data: `ExponentPushToken[${o?.projectId}]`, type: "expo" })),
    getDevicePushTokenAsync: vi.fn(async () => ({ data: "apns-hex", type: "ios" })),
    setNotificationChannelAsync: vi.fn(async () => null),
    AndroidImportance: { MAX: 5 },
  };
  return n satisfies NotificationsLike;
}

const device = { isDevice: true, deviceName: "Ada's iPhone" };
const constants = { expoConfig: { extra: { eas: { projectId: "proj-1" } } } };

describe("registerForPush", () => {
  it("asks for permission and returns the Expo token with the EAS projectId", async () => {
    const notifications = fakeNotifications({ status: "undetermined" }, { status: "granted" });
    const r = await registerForPush({ notifications, device, constants, platform: { OS: "ios" } });
    expect(r).toEqual({ status: "granted", token: "ExponentPushToken[proj-1]", provider: "expo", platform: "ios", deviceName: "Ada's iPhone" });
    expect(notifications.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(notifications.setNotificationChannelAsync).not.toHaveBeenCalled();
  });

  it("creates the Android channel first and can return the native device token", async () => {
    const notifications = fakeNotifications({ status: "granted" });
    const r = await registerForPush({ notifications, device, constants, platform: { OS: "android" }, kind: "device" });
    expect(notifications.setNotificationChannelAsync).toHaveBeenCalledWith("default", { name: "Default", importance: 5 });
    expect(notifications.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(r).toMatchObject({ status: "granted", token: "apns-hex", provider: "apns" });
  });

  it("reports denied, simulator, web, missing module and missing projectId without throwing", async () => {
    expect(await registerForPush({ notifications: fakeNotifications({ status: "denied", canAskAgain: false }), device, constants, platform: { OS: "ios" } })).toEqual({
      status: "denied",
      canAskAgain: false,
    });
    const noAsk = fakeNotifications({ status: "undetermined" });
    expect(await registerForPush({ notifications: noAsk, device, constants, platform: { OS: "ios" }, requestPermission: false })).toMatchObject({ status: "denied" });
    expect(noAsk.requestPermissionsAsync).not.toHaveBeenCalled();
    const ok = fakeNotifications({ status: "granted" });
    expect(await registerForPush({ notifications: ok, device: { isDevice: false }, constants, platform: { OS: "ios" } })).toMatchObject({ status: "unsupported" });
    expect(await registerForPush({ notifications: ok, device, constants, platform: { OS: "web" } })).toMatchObject({ status: "unsupported" });
    expect(await registerForPush({ notifications: null })).toMatchObject({ status: "unsupported", reason: expect.stringMatching(/expo-notifications/) });
    expect(await registerForPush({ notifications: ok, device, constants: {}, platform: { OS: "ios" } })).toMatchObject({
      status: "unsupported",
      reason: expect.stringMatching(/projectId/),
    });
    const failing = { ...fakeNotifications({ status: "granted" }), getExpoPushTokenAsync: vi.fn(async () => Promise.reject(new Error("no network"))) };
    expect(await registerForPush({ notifications: failing, device, constants, platform: { OS: "ios" } })).toMatchObject({
      status: "unsupported",
      reason: expect.stringMatching(/no network/),
    });
  });
});
