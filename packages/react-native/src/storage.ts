import { KeyValuePendingStorage, decodeJson, encodeJson } from "@ember/client";
import { loadAsyncStorage, loadPlatform, loadSecureStore, type AsyncStorageLike, type SecureStoreLike } from "./modules.ts";

/**
 * Unconfirmed mutations in AsyncStorage (one JSON blob per prefix), so they survive an app kill and are resent on
 * the next launch (the server dedups by clientId + mid). Uses Ember's tagged JSON, so bytes/bigints round-trip.
 *
 *   new EmberClient({ url, storage: new AsyncStoragePendingStorage() })
 *
 * `expo-sqlite/kv-store` is a drop-in AsyncStorage replacement and works here too.
 */
export class AsyncStoragePendingStorage extends KeyValuePendingStorage {
  constructor(asyncStorage?: AsyncStorageLike | null, prefix = "ember") {
    const store = asyncStorage ?? loadAsyncStorage();
    if (!store) throw new Error("AsyncStoragePendingStorage: install @react-native-async-storage/async-storage or pass a store");
    super(store, prefix, { stringify: encodeJson, parse: decodeJson });
  }
}

/** Where the long-lived session token lives. */
export interface TokenStore {
  get(): Promise<string | null>;
  set(token: string): Promise<void>;
  clear(): Promise<void>;
}

export interface SecureTokenStoreOptions {
  /** Key in the keychain/keystore. Default `"ember.session"`. Allowed characters: alphanumerics, `.`, `-`, `_`. */
  key?: string;
  /** `expo-secure-store` module (default: loaded lazily). */
  secureStore?: SecureStoreLike | null;
  /** Passed to SecureStore (e.g. `{ keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK }` for background access). */
  options?: Record<string, unknown>;
}

/**
 * Session token in the iOS Keychain / Android Keystore via expo-secure-store. Throws when the module is missing
 * (e.g. on web: use `keyValueTokenStore(localStorage)` there).
 */
export function secureTokenStore(opts: SecureTokenStoreOptions = {}): TokenStore {
  const ss = opts.secureStore === undefined ? loadSecureStore() : opts.secureStore;
  if (!ss) throw new Error("secureTokenStore: install expo-secure-store or pass secureStore");
  const key = opts.key ?? "ember.session";
  return {
    get: () => ss.getItemAsync(key, opts.options),
    set: (t) => ss.setItemAsync(key, t, opts.options),
    clear: () => ss.deleteItemAsync(key, opts.options),
  };
}

/** Token store over any key-value API (localStorage, AsyncStorage). Not encrypted. */
export function keyValueTokenStore(
  kv: {
    getItem(k: string): string | null | Promise<string | null>;
    setItem(k: string, v: string): void | Promise<void>;
    removeItem(k: string): void | Promise<void>;
  },
  key = "ember.session",
): TokenStore {
  return {
    get: async () => (await kv.getItem(key)) ?? null,
    set: async (t) => void (await kv.setItem(key, t)),
    clear: async () => void (await kv.removeItem(key)),
  };
}

/** In-memory token store (tests, ephemeral sessions). */
export function memoryTokenStore(initial: string | null = null): TokenStore {
  let token = initial;
  return {
    get: async () => token,
    set: async (t) => void (token = t),
    clear: async () => void (token = null),
  };
}

/** SecureStore on iOS/Android; `localStorage` on Expo web; memory otherwise. */
export function defaultTokenStore(): TokenStore {
  if (loadPlatform()?.OS !== "web") {
    const ss = loadSecureStore();
    if (ss) return secureTokenStore({ secureStore: ss });
  }
  const ls = (globalThis as { localStorage?: Parameters<typeof keyValueTokenStore>[0] }).localStorage;
  return ls ? keyValueTokenStore(ls) : memoryTokenStore();
}
