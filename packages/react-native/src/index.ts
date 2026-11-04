/**
 * `@freecorps/ember-react-native`: Ember for React Native / Expo (PLAN §10). Works in Expo Go and EAS builds without a
 * required native module: NetInfo, AsyncStorage, SecureStore and expo-notifications are optional peers.
 *
 * Re-exports `@freecorps/ember-react` (provider + hooks) so an app imports from one place.
 */
export * from "@freecorps/ember-react";
export {
  EmberClient,
  EmberError,
  KeyValuePendingStorage,
  MemoryPendingStorage,
  anyApi,
  getFunctionName,
  isEmberError,
  makeFunctionReference,
  type AuthTokenFetcher,
  type ConnectivityEvent,
  type ConnectivitySource,
  type EmberClientOptions,
  type FunctionReference,
  type PendingStorage,
  type StorageAdapter,
  type SyncSpec,
} from "@freecorps/ember-client";
export { createEmberClient, type CreateEmberClientOptions } from "./client.ts";
export { createExpoConnectivity, type ExpoConnectivityOptions } from "./connectivity.ts";
export {
  AsyncStoragePendingStorage,
  defaultTokenStore,
  keyValueTokenStore,
  memoryTokenStore,
  secureTokenStore,
  type SecureTokenStoreOptions,
  type TokenStore,
} from "./storage.ts";
export {
  AuthError,
  EmberAuthClient,
  bindEmberAuth,
  createEmberAuthClient,
  type AuthState,
  type AuthUser,
  type EmberAuthClientOptions,
} from "./auth.ts";
export { useEmberAuthToken, type UseEmberAuthTokenResult } from "./hooks.ts";
export { registerForPush, type RegisterForPushOptions, type RegisterForPushResult } from "./push.ts";
export type {
  AppStateLike,
  AsyncStorageLike,
  NetInfoLike,
  NetInfoStateLike,
  NotificationsLike,
  SecureStoreLike,
} from "./modules.ts";
