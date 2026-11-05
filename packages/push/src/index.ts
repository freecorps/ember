/**
 * `@freecorps/ember-push`: push notifications for Ember apps (PLAN §10: iOS background sync is rare, so news arrives by push).
 *
 * - Device table + helpers for your schema (`pushDevicesTable`, `registerPushDevice`, ...): run in mutations.
 * - Sending (`sendPush`, `checkPushReceipts`): plain `fetch`, so call them from an **action** (PLAN D6: I/O only in
 *   actions). Typical flow: a mutation schedules an action → the action reads tokens with `ctx.runQuery`, calls
 *   `sendPush`, deletes `unregisteredTokens` with `ctx.runMutation`, and schedules a receipts check ~15 min later.
 * - Transports: Expo Push (`sendPush`, zero setup) or direct APNs + FCM (`sendApns`, `sendFcm`, `sendToDevices`), with
 *   optional end-to-end encryption (HPKE envelopes, `sealPushContent`; the device side is `@freecorps/ember-expo-push`).
 * - Or install it as a component (`pushComponent`, PLAN §12): devices in the component's own table, sends enqueued
 *   from mutations (atomically), receipts checked later, dead tokens pruned. See `PushNotifications`.
 */
export * from "./types.ts";
export { fromBase64url, toBase64url } from "./base64url.ts";
export { generateRecipient, importKeyPair, open, seal, P256_PUBLIC_KEY_LENGTH, type HpkeOptions, type HpkeRecipient, type HpkeSealed, type SealOptions } from "./hpke.ts";
export {
  EMBER_PUSH_ENVELOPE_VERSION,
  EMBER_PUSH_HPKE_INFO,
  PUSH_KEY_ID,
  PUSH_PLAINTEXT_MAX_BYTES,
  isDevicePublicKey,
  openPushEnvelope,
  parseDevicePublicKey,
  parseOpenedContent,
  parsePushEnvelope,
  pushKeyId,
  sealPushContent,
  type EncryptedPushContent,
  type OpenedPushContent,
  type PushEnvelope,
} from "./envelope.ts";
export {
  EXPO_MAX_PAYLOAD,
  EXPO_PUSH_URL,
  EXPO_RECEIPTS_CHUNK,
  EXPO_RECEIPTS_URL,
  EXPO_SEND_CHUNK,
  checkPushReceipts,
  expoPushProvider,
  isExpoPushToken,
  payloadSize,
  sendExpoMessages,
  sendPush,
  toExpoMessage,
  type ExpoPushOptions,
} from "./expo.ts";
export {
  PUSH_DEVICES_TABLE,
  inferPushProvider,
  isPushProviderName,
  pushDevicesForUser,
  pushDevicesForUsers,
  pushDevicesTable,
  pushTokensForUsers,
  registerPushDevice,
  removePushTokens,
  removeVoipTokens,
  setPushDeviceEnvironment,
  unregisterPushDevice,
  type PushDevice,
  type PushProviderName,
  type RegisterPushDeviceInput,
} from "./devices.ts";
export { apnsOptionsFromEnv, fcmOptionsFromEnv, pushComponent, pushFunctions, PushNotifications, type PushComponentApi, type PushInstallConfig, type DeliveryResult } from "./component.ts";
export { decodeJwt, importSigningKey, pemToDer, signJwt, verifyJwt, type CredentialsError, type JwtAlgorithm } from "./jwt.ts";
export { DEFAULT_PUSH_FALLBACK, PUSH_MAX_TTL_SECONDS, PUSH_TTL_DEFAULTS, resolveInterruptionLevel, resolveTtlSeconds, resolveUrgency } from "./delivery.ts";
export {
  APNS_MAX_PAYLOAD,
  APNS_PRODUCTION_URL,
  APNS_SANDBOX_URL,
  APNS_TOKEN_REFRESH_MS,
  APNS_VOIP_MAX_PAYLOAD,
  apnsErrorCode,
  apnsHeaders,
  apnsPayload,
  apnsProviderToken,
  apnsPushProvider,
  apnsPushType,
  clearApnsTokenCache,
  isApnsToken,
  sendApns,
  type ApnsCredentials,
  type ApnsOptions,
} from "./apns.ts";
export {
  FCM_MAX_PAYLOAD,
  FCM_MAX_TTL_SECONDS,
  FCM_SCOPE,
  FCM_SEND_URL,
  FCM_TOKEN_MARGIN_MS,
  GOOGLE_TOKEN_URL,
  clearFcmTokenCache,
  fcmAccessToken,
  fcmErrorCode,
  fcmMessage,
  fcmPushProvider,
  isFcmToken,
  parseServiceAccount,
  sendFcm,
  type FcmOptions,
  type ServiceAccount,
} from "./fcm.ts";
export { sendToDevices, type DeviceSendResult, type PushTarget, type PushTransports } from "./direct.ts";
