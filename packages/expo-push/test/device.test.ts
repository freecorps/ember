import { sealPushContent } from "@freecorps/ember-push";
import { describe, expect, test, vi } from "vitest";
import {
  DEFAULT_KEYCHAIN_SERVICE,
  deletePushKeys,
  defineEmberPushTask,
  ensurePushKey,
  extractEncryptedPush,
  loadPushKeys,
  presentEncryptedPush,
  registerEmberPushTask,
  rotatePushKey,
  type SecureStoreLike,
} from "../src/index.ts";

function fakeSecureStore() {
  const map = new Map<string, { value: string; options: Record<string, unknown> | undefined }>();
  const id = (k: string, o?: Record<string, unknown>) => `${o?.keychainService ?? "app"}|${o?.accessGroup ?? ""}|${k}`;
  const store: SecureStoreLike & { map: typeof map } = {
    map,
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 3,
    getItemAsync: async (k, o) => map.get(id(k, o))?.value ?? null,
    setItemAsync: async (k, value, options) => void map.set(id(k, options), { value, options }),
    deleteItemAsync: async (k, o) => void map.delete(id(k, o)),
  };
  return store;
}

const constants = { expoConfig: { extra: { emberPush: { appGroup: "group.dev.ember.mail.ember", keychainService: "ember.push", keyName: "ember.push.keys.v1" } } } };
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));

describe("device key", () => {
  test("created once, stored where the NSE reads it (service, App Group access group, after-first-unlock)", async () => {
    const secureStore = fakeSecureStore();
    const a = await ensurePushKey({ secureStore, constants, platform: "ios", random });
    const b = await ensurePushKey({ secureStore, constants, platform: "ios", random });
    expect(a).toEqual(b);
    expect(a.publicKey).toMatch(/^[A-Za-z0-9_-]{87}$/); // 65 bytes
    const [entry] = [...secureStore.map.values()];
    expect(entry!.options).toEqual({ keychainService: DEFAULT_KEYCHAIN_SERVICE, accessGroup: "group.dev.ember.mail.ember", keychainAccessible: 3 });
    const stored = JSON.parse(entry!.value);
    expect(stored.v).toBe(1);
    expect(stored.keys).toHaveLength(1);
    expect(stored.keys[0].pub).toBe(a.publicKey);
  });

  test("no access group on Android; rotation keeps the previous key; delete forgets them", async () => {
    const secureStore = fakeSecureStore();
    const first = await ensurePushKey({ secureStore, constants, platform: "android", random });
    expect([...secureStore.map.values()][0]!.options).not.toHaveProperty("accessGroup");
    const second = await rotatePushKey({ secureStore, constants, platform: "android", random });
    const third = await rotatePushKey({ secureStore, constants, platform: "android", random });
    expect(second.keyId).not.toBe(first.keyId);
    const keys = await loadPushKeys({ secureStore, constants, platform: "android" });
    expect(keys).toHaveLength(2); // current + one previous
    expect(Buffer.from(keys[0]!.publicKey).toString("base64url")).toBe(third.publicKey);
    expect(Buffer.from(keys[1]!.publicKey).toString("base64url")).toBe(second.publicKey);
    await deletePushKeys({ secureStore, constants, platform: "android" });
    expect(await loadPushKeys({ secureStore, constants, platform: "android" })).toEqual([]);
  });

  test("clear error without SecureStore", async () => {
    await expect(ensurePushKey({ secureStore: null })).rejects.toThrow(/expo-secure-store/);
  });
});

/** A data-only FCM message as the server sends it (`fcmMessage`), and the shapes expo-notifications passes to the task. */
async function sealedData(publicKey: string) {
  const env = await sealPushContent(publicKey, { title: "Ana Souza", subtitle: "Re: orçamento", body: "Segue", data: { messageId: "m-42" } });
  return { ember: JSON.stringify(env), urgency: "high", fallbackTitle: "New mail", fallbackBody: "Open Mail", channelId: "mail", tag: "m-42" };
}

describe("Android decrypt task", () => {
  test("finds the sealed fields in every payload shape", async () => {
    const data = { ember: "{}", fallbackTitle: "t", tag: "x" };
    expect(extractEncryptedPush({ data })).toMatchObject({ ember: "{}", fallbackTitle: "t", tag: "x" });
    expect(extractEncryptedPush({ data: { dataString: JSON.stringify(data) } })).toMatchObject({ ember: "{}" });
    expect(extractEncryptedPush({ notification: { data } })).toMatchObject({ ember: "{}" });
    expect(extractEncryptedPush(data)).toMatchObject({ ember: "{}" });
    expect(extractEncryptedPush({ data: { body: "{}" } })).toBeNull();
    expect(extractEncryptedPush(null)).toBeNull();
  });

  test("decrypts and shows the content on its channel, replacing by tag", async () => {
    const secureStore = fakeSecureStore();
    const key = await ensurePushKey({ secureStore, constants, platform: "android", random });
    const scheduleNotificationAsync = vi.fn(async () => "id-1");
    const r = await presentEncryptedPush({ data: await sealedData(key.publicKey) }, { secureStore, constants, platform: "android", notifications: { scheduleNotificationAsync } });
    expect(r).toEqual({ shown: "content", identifier: "id-1" });
    expect(scheduleNotificationAsync).toHaveBeenCalledWith({
      identifier: "m-42",
      trigger: { channelId: "mail" },
      content: { title: "Ana Souza", subtitle: "Re: orçamento", body: "Segue", data: { messageId: "m-42" }, sound: "default" },
    });
  });

  test("never silence: a push that does not open shows the fallback text", async () => {
    const secureStore = fakeSecureStore();
    await ensurePushKey({ secureStore, constants, platform: "android", random });
    const other = await ensurePushKey({ secureStore: fakeSecureStore(), constants, platform: "android", random });
    const scheduleNotificationAsync = vi.fn(async () => "id-2");
    const r = await presentEncryptedPush({ data: await sealedData(other.publicKey) }, { secureStore, constants, platform: "android", notifications: { scheduleNotificationAsync } });
    expect(r).toMatchObject({ shown: "fallback", reason: expect.stringMatching(/did not open/) });
    expect(scheduleNotificationAsync).toHaveBeenCalledWith({ identifier: "m-42", trigger: { channelId: "mail" }, content: { title: "New mail", body: "Open Mail", data: {} } });
    expect(await presentEncryptedPush({ data: { body: "{}" } }, { notifications: { scheduleNotificationAsync } })).toEqual({ shown: "nothing", reason: "not an Ember sealed push" });
  });

  test("defineEmberPushTask wires the task (no-op on iOS); registerEmberPushTask registers it", async () => {
    const secureStore = fakeSecureStore();
    const key = await ensurePushKey({ secureStore, constants, platform: "android", random });
    let task: ((b: { data: unknown; error: unknown }) => Promise<unknown> | unknown) | undefined;
    const results: unknown[] = [];
    const scheduleNotificationAsync = vi.fn(async () => "id-3");
    const name = defineEmberPushTask({
      taskManager: { defineTask: (_n, t) => void (task = t) },
      notifications: { scheduleNotificationAsync },
      secureStore,
      constants,
      platform: "android",
      onResult: (r) => results.push(r),
    });
    expect(name).toBe("ember-push-decrypt");
    await task!({ data: { data: await sealedData(key.publicKey) }, error: null });
    expect(results).toEqual([{ shown: "content", identifier: "id-3" }]);

    let iosTask: typeof task;
    defineEmberPushTask({ taskManager: { defineTask: (_n, t) => void (iosTask = t) }, notifications: { scheduleNotificationAsync }, platform: "ios" });
    await iosTask!({ data: { data: await sealedData(key.publicKey) }, error: null });
    expect(scheduleNotificationAsync).toHaveBeenCalledTimes(1);

    const registerTaskAsync = vi.fn(async () => null);
    await registerEmberPushTask({ notifications: { scheduleNotificationAsync, registerTaskAsync } });
    expect(registerTaskAsync).toHaveBeenCalledWith("ember-push-decrypt");
  });
});
