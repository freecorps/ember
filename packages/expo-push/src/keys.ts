/**
 * The device key for sealed pushes. Created on first use, kept in SecureStore, and on iOS shared with the
 * Notification Service Extension through the App Group, which doubles as a keychain access group (Brigade spike S1
 * found the same arrangement works on a locked phone: `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`, never synced or restored
 * to another device).
 *
 * The stored value is JSON, `{ "v": 1, "keys": [{ "d": <private scalar>, "pub": <public key> }, ...] }` (base64url),
 * current key first; after `rotatePushKey` the previous key stays second so pushes sealed before the server learned
 * the new key still open. The NSE (ios/EmberNotificationService/EmberPushCrypto.swift) reads the same item:
 * expo-secure-store saves it as a generic password with service `<keychainService>:no-auth` and account `<keyName>`.
 */
import { fromBase64url, generatePushKeyPair, pushKeyId, toBase64url, type PushKeyPair } from "./crypto.ts";
import { defaultRandom, loadConstants, loadPlatformOS, loadSecureStore, type ConstantsLike, type SecureStoreLike } from "./modules.ts";

export const DEFAULT_KEYCHAIN_SERVICE = "ember.push";
export const DEFAULT_KEY_NAME = "ember.push.keys.v1";

export interface PushKeyOptions {
  secureStore?: SecureStoreLike | null;
  /** iOS: the App Group (keychain access group) the NSE reads. Default: what the config plugin recorded. */
  accessGroup?: string;
  keychainService?: string;
  keyName?: string;
  /** Random bytes (default `crypto.getRandomValues` or expo-crypto). */
  random?: (n: number) => Uint8Array;
  constants?: ConstantsLike | null;
  /** Default: Platform.OS. The access group only applies on iOS. */
  platform?: string;
}

interface Resolved {
  store: SecureStoreLike;
  key: string;
  options: Record<string, unknown>;
  random: (n: number) => Uint8Array;
}

function resolve(o: PushKeyOptions): Resolved {
  const store = o.secureStore === undefined ? loadSecureStore() : o.secureStore;
  if (!store) throw new Error("@freecorps/ember-expo-push: expo-secure-store is required for the device key");
  const extra = (o.constants === undefined ? loadConstants() : o.constants)?.expoConfig?.extra?.emberPush ?? {};
  const platform = o.platform ?? loadPlatformOS() ?? "ios";
  const options: Record<string, unknown> = { keychainService: o.keychainService ?? extra.keychainService ?? DEFAULT_KEYCHAIN_SERVICE };
  if (store.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY !== undefined) options.keychainAccessible = store.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY;
  const group = o.accessGroup ?? extra.appGroup;
  if (group && platform === "ios") options.accessGroup = group;
  return { store, key: o.keyName ?? extra.keyName ?? DEFAULT_KEY_NAME, options, random: o.random ?? defaultRandom };
}

interface Stored {
  v: 1;
  keys: Array<{ d: string; pub: string }>;
}

async function read(r: Resolved): Promise<PushKeyPair[]> {
  const raw = await r.store.getItemAsync(r.key, r.options);
  if (!raw) return [];
  try {
    const s = JSON.parse(raw) as Stored;
    if (s?.v !== 1 || !Array.isArray(s.keys)) return [];
    return s.keys.map((k) => ({ privateKey: fromBase64url(k.d), publicKey: fromBase64url(k.pub) })).filter((k) => k.privateKey.length === 32 && k.publicKey.length === 65);
  } catch {
    return [];
  }
}

async function write(r: Resolved, keys: PushKeyPair[]): Promise<void> {
  const s: Stored = { v: 1, keys: keys.map((k) => ({ d: toBase64url(k.privateKey), pub: toBase64url(k.publicKey) })) };
  await r.store.setItemAsync(r.key, JSON.stringify(s), r.options);
}

export interface DevicePushKey {
  /** Register this with the device (`publicKey` of `registerForPush` / `push.register`). */
  publicKey: string;
  keyId: string;
}

const describe = (k: PushKeyPair): DevicePushKey => ({ publicKey: toBase64url(k.publicKey), keyId: pushKeyId(k.publicKey) });

/** The device's current public key, creating the key pair on first use. */
export async function ensurePushKey(o: PushKeyOptions = {}): Promise<DevicePushKey> {
  const r = resolve(o);
  const keys = await read(r);
  if (keys[0]) return describe(keys[0]);
  const created = generatePushKeyPair(r.random);
  await write(r, [created]);
  return describe(created);
}

/** Every key this device can open with (current first). For the Android decrypt task and JS clients. */
export async function loadPushKeys(o: PushKeyOptions = {}): Promise<PushKeyPair[]> {
  return read(resolve(o));
}

/** A new current key; the previous one is kept (only one) until the next rotation. Register the returned key. */
export async function rotatePushKey(o: PushKeyOptions = {}): Promise<DevicePushKey> {
  const r = resolve(o);
  const keys = await read(r);
  const created = generatePushKeyPair(r.random);
  await write(r, [created, ...keys.slice(0, 1)]);
  return describe(created);
}

/** Forgets every key (sign-out): pushes sealed to them show the fallback text from now on. */
export async function deletePushKeys(o: PushKeyOptions = {}): Promise<void> {
  const r = resolve(o);
  await r.store.deleteItemAsync(r.key, r.options);
}
