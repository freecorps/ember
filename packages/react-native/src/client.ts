import {
  EmberClient,
  type AuthTokenFetcher,
  type ConnectivitySource,
  type EmberClientOptions,
  type PendingStorage,
  type StorageAdapter,
} from "@freecorps/ember-client";
import { EmberAuthClient } from "./auth.ts";
import { createExpoConnectivity, type ExpoConnectivityOptions } from "./connectivity.ts";
import { loadAsyncStorage } from "./modules.ts";
import { AsyncStoragePendingStorage } from "./storage.ts";

export interface CreateEmberClientOptions extends Omit<EmberClientOptions, "auth" | "storage" | "connectivity"> {
  /** An `EmberAuthClient` (its `fetchToken` is used) or any token fetcher. */
  auth?: EmberAuthClient | AuthTokenFetcher;
  /**
   * Pending mutations: AsyncStorage when installed (default), else memory; `"memory"` forces memory. Or a full
   * offline `StorageAdapter`, e.g. `expoSqliteStorage({ schema, queries })` from `@freecorps/ember-offline/expo-sqlite`
   * (results persisted, registered queries run locally on the device's SQLite with FTS5).
   */
  storage?: PendingStorage | StorageAdapter | "memory";
  /** Default: `createExpoConnectivity()`. Options are passed to it; `null` disables. */
  connectivity?: ConnectivitySource | ExpoConnectivityOptions | null;
}

const isSource = (c: unknown): c is ConnectivitySource => !!c && typeof (c as ConnectivitySource).subscribe === "function";

/** `new EmberClient(...)` with React Native defaults: AppState/NetInfo connectivity and AsyncStorage pending storage. */
export function createEmberClient(opts: CreateEmberClientOptions): EmberClient {
  const { auth, storage, connectivity, ...rest } = opts;
  const o: EmberClientOptions = { ...rest };
  if (auth) o.auth = auth instanceof EmberAuthClient ? auth.fetchToken : auth;
  if (storage && storage !== "memory") o.storage = storage;
  else if (storage === undefined) {
    const as = loadAsyncStorage();
    if (as) o.storage = new AsyncStoragePendingStorage(as);
  }
  o.connectivity = connectivity === null ? null : isSource(connectivity) ? connectivity : createExpoConnectivity(connectivity ?? {});
  return new EmberClient(o);
}
