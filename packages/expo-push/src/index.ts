/**
 * `@freecorps/ember-expo-push`: the device side of Ember's end-to-end encrypted pushes (server side:
 * `@freecorps/ember-push` with the direct transport). Subject and sender never pass through Apple or Google in clear.
 *
 * - `app.plugin.cjs` (Expo config plugin `"@freecorps/ember-expo-push"`): iOS Notification Service Extension target that
 *   decrypts with CryptoKit, App Group + keychain sharing, `aps-environment` per build, time-sensitive entitlement.
 * - `ensurePushKey()`: the device key (P-256, SecureStore, shared with the NSE); register its `publicKey`.
 * - `defineEmberPushTask()`: Android decrypt-and-show for data-only sealed pushes.
 * - `openPushEnvelope()`: pure-JS HPKE (noble) for any JS client.
 */
export {
  EMBER_PUSH_ENVELOPE_VERSION,
  EMBER_PUSH_HPKE_INFO,
  fromBase64url,
  generatePushKeyPair,
  hpkeOpen,
  hpkeSeal,
  openPushEnvelope,
  parsePushEnvelope,
  pushKeyId,
  toBase64url,
  type OpenedPush,
  type PushEnvelope,
  type PushKeyPair,
} from "./crypto.ts";
export { DEFAULT_KEY_NAME, DEFAULT_KEYCHAIN_SERVICE, deletePushKeys, ensurePushKey, loadPushKeys, rotatePushKey, type DevicePushKey, type PushKeyOptions } from "./keys.ts";
export {
  EMBER_PUSH_TASK,
  defineEmberPushTask,
  extractEncryptedPush,
  presentEncryptedPush,
  registerEmberPushTask,
  type EncryptedPushData,
  type PresentOptions,
  type PresentResult,
  type TaskOptions,
} from "./android.ts";
export type { ConstantsLike, EmberPushExtra, NotificationsLike, SecureStoreLike, TaskManagerLike } from "./modules.ts";
