/**
 * Client side of push (server side: `@freecorps/ember-push`). iOS rarely runs background sync, so new data should arrive as a
 * notification and the app syncs when opened (PLAN §10). Push does not work in Expo Go (SDK 53+): use a development
 * build. iOS needs a physical device (or an Apple-silicon Simulator for APNs sandbox tokens).
 *
 * Two kinds of token:
 * - `kind: "expo"` (default): an Expo push token, sent through Expo Push. Zero setup on the server.
 * - `kind: "device"`: the native APNs/FCM token (`getDevicePushTokenAsync`), sent directly by the server's direct
 *   transport. On iOS the result also says which APNs `environment` the token belongs to, from the build (see
 *   `pushEnvironment`), and can carry the device's `publicKey` for end-to-end encrypted pushes
 *   (`@freecorps/ember-expo-push`).
 */
import {
  loadConstants,
  loadDevice,
  loadNotifications,
  loadPlatform,
  type ConstantsLike,
  type DeviceLike,
  type NotificationsLike,
  type PlatformLike,
} from "./modules.ts";

/** An Android notification channel (Android 8+). Created before asking for permission (Android 13+ needs one). */
export interface AndroidChannel {
  id: string;
  name: string;
  /** `AndroidImportance` value (default MAX: heads-up). */
  importance?: number;
  description?: string;
  sound?: string | null;
  vibrationPattern?: number[] | null;
  lightColor?: string;
  /** `AndroidNotificationVisibility` value (e.g. PRIVATE to hide content on the lock screen). */
  lockscreenVisibility?: number;
  showBadge?: boolean;
  enableVibrate?: boolean;
  groupId?: string;
}

/** A notification category with its actions (iOS categories, Android action buttons). */
export interface NotificationCategory {
  id: string;
  actions: Array<{
    identifier: string;
    buttonTitle: string;
    /** A text input action (e.g. "Reply"). */
    textInput?: { submitButtonTitle: string; placeholder: string };
    options?: { opensAppToForeground?: boolean; isDestructive?: boolean; isAuthenticationRequired?: boolean };
  }>;
  options?: Record<string, unknown>;
}

export interface RegisterForPushOptions {
  /** EAS project id (default: `Constants.expoConfig.extra.eas.projectId` / `Constants.easConfig.projectId`). */
  projectId?: string;
  /** Ask for permission when not granted yet (default true). `false` only reads the current permission. */
  requestPermission?: boolean;
  /** Android channel created before asking (Android 13+ shows the prompt only once a channel exists). Default `"default"`; null skips. */
  androidChannel?: AndroidChannel | null;
  /** Several Android channels (e.g. "mail", "mentions"); replaces `androidChannel` when set. */
  androidChannels?: AndroidChannel[];
  /** Notification categories (actions) to register. */
  categories?: NotificationCategory[];
  /** `"expo"` (default) for the Expo Push Service, `"device"` for the raw APNs/FCM token (direct transport). */
  kind?: "expo" | "device";
  /** iOS, `kind: "device"`: the token's APNs environment. Default: `pushEnvironment()` (from the build). */
  environment?: "sandbox" | "production";
  /** The device public key for sealed pushes (`ensurePushKey()` from `@freecorps/ember-expo-push`); returned as is. */
  publicKey?: string;
  /** Injected modules (tests, or apps that import them already). */
  notifications?: NotificationsLike | null;
  device?: DeviceLike | null;
  constants?: ConstantsLike | null;
  platform?: PlatformLike | null;
}

export type RegisterForPushResult =
  | {
      status: "granted";
      token: string;
      provider: "expo" | "apns" | "fcm";
      platform: string;
      deviceName?: string;
      /** iOS native tokens: "sandbox" for development-signed builds, "production" otherwise. */
      environment?: "sandbox" | "production";
      publicKey?: string;
    }
  | { status: "denied"; canAskAgain: boolean }
  | { status: "unsupported"; reason: string };

/**
 * The APNs environment this build's device tokens belong to, as the `@freecorps/ember-expo-push` config plugin
 * recorded it at prebuild (`extra.emberPush.apsEnvironment`: the `aps-environment` entitlement it wrote —
 * `development` for local builds, `production` for EAS builds, which are ad hoc / App Store signed). Undefined when
 * the plugin is not used: register without an environment and the server finds it on the first send.
 */
export function pushEnvironment(constants: ConstantsLike | null = loadConstants()): "sandbox" | "production" | undefined {
  const aps = constants?.expoConfig?.extra?.emberPush?.apsEnvironment;
  if (aps === "development") return "sandbox";
  if (aps === "production") return "production";
  return undefined;
}

/**
 * Asks for notification permission and returns the push token to register on the server (e.g. a mutation that
 * calls `registerPushDevice` from `@freecorps/ember-push`). Never throws for the expected failure modes (simulator, web,
 * denied permission, missing projectId): they come back as `denied`/`unsupported`.
 */
export async function registerForPush(opts: RegisterForPushOptions = {}): Promise<RegisterForPushResult> {
  const N = opts.notifications === undefined ? loadNotifications() : opts.notifications;
  if (!N) return { status: "unsupported", reason: "expo-notifications is not installed" };
  const platform = (opts.platform === undefined ? loadPlatform() : opts.platform)?.OS ?? "unknown";
  if (platform === "web") return { status: "unsupported", reason: "push is not supported on web by this helper" };
  const device = opts.device === undefined ? loadDevice() : opts.device;
  if (device && !device.isDevice) return { status: "unsupported", reason: "push notifications need a physical device" };

  if (platform === "android" && N.setNotificationChannelAsync) {
    const channels = opts.androidChannels ?? (opts.androidChannel === null ? [] : [opts.androidChannel ?? { id: "default", name: "Default" }]);
    for (const { id, importance, ...rest } of channels) {
      await N.setNotificationChannelAsync(id, { ...rest, importance: importance ?? N.AndroidImportance?.MAX ?? N.AndroidImportance?.HIGH ?? 4 });
    }
  }
  if (opts.categories?.length && N.setNotificationCategoryAsync) {
    for (const c of opts.categories) await N.setNotificationCategoryAsync(c.id, c.actions, c.options);
  }

  let perm = await N.getPermissionsAsync();
  if (perm.status !== "granted" && opts.requestPermission !== false && perm.canAskAgain !== false) perm = await N.requestPermissionsAsync();
  if (perm.status !== "granted") return { status: "denied", canAskAgain: perm.canAskAgain !== false };

  const extra: { deviceName?: string; publicKey?: string } = {};
  if (device?.deviceName) extra.deviceName = device.deviceName;
  if (opts.publicKey) extra.publicKey = opts.publicKey;
  try {
    const constants = opts.constants === undefined ? loadConstants() : opts.constants;
    if (opts.kind === "device") {
      if (!N.getDevicePushTokenAsync) return { status: "unsupported", reason: "getDevicePushTokenAsync is unavailable" };
      const t = await N.getDevicePushTokenAsync();
      if (t.type === "ios") {
        const environment = opts.environment ?? pushEnvironment(constants);
        return { status: "granted", token: String(t.data), provider: "apns", platform, ...extra, ...(environment ? { environment } : {}) };
      }
      return { status: "granted", token: String(t.data), provider: "fcm", platform, ...extra };
    }
    const projectId = opts.projectId ?? constants?.expoConfig?.extra?.eas?.projectId ?? constants?.easConfig?.projectId;
    if (!projectId) return { status: "unsupported", reason: "no EAS projectId (run `eas init` or pass projectId)" };
    const t = await N.getExpoPushTokenAsync({ projectId });
    return { status: "granted", token: t.data, provider: "expo", platform, ...extra };
  } catch (e) {
    return { status: "unsupported", reason: `could not get a push token: ${(e as Error).message}` };
  }
}
