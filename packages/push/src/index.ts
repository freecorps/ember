/**
 * `@freecorps/ember-push`: push notifications for Ember apps (PLAN §10: iOS background sync is rare, so news arrives by push).
 *
 * - Device table + helpers for your schema (`pushDevicesTable`, `registerPushDevice`, ...): run in mutations.
 * - Sending (`sendPush`, `checkPushReceipts`): plain `fetch`, so call them from an **action** (PLAN D6: I/O only in
 *   actions). Typical flow: a mutation schedules an action → the action reads tokens with `ctx.runQuery`, calls
 *   `sendPush`, deletes `unregisteredTokens` with `ctx.runMutation`, and schedules a receipts check ~15 min later.
 * - `PushProvider` keeps the backend pluggable: Expo Push today; direct APNs/FCM later.
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
  pushDevicesForUser,
  pushDevicesTable,
  pushTokensForUsers,
  registerPushDevice,
  removePushTokens,
  unregisterPushDevice,
  type PushDevice,
  type RegisterPushDeviceInput,
} from "./devices.ts";
export { pushComponent, pushFunctions, PushNotifications, type PushComponentApi, type PushInstallConfig, type DeliveryResult } from "./component.ts";
