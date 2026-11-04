/**
 * Client side of push (server side: `@freecorps/ember-push`). iOS rarely runs background sync, so new data should arrive as a
 * notification and the app syncs when opened (PLAN §10). Push does not work in Expo Go (SDK 53+): use a development
 * build. iOS needs a physical device.
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

export interface RegisterForPushOptions {
  /** EAS project id (default: `Constants.expoConfig.extra.eas.projectId` / `Constants.easConfig.projectId`). */
  projectId?: string;
  /** Ask for permission when not granted yet (default true). `false` only reads the current permission. */
  requestPermission?: boolean;
  /** Android channel created before asking (Android 13+ shows the prompt only once a channel exists). Default `"default"`; null skips. */
  androidChannel?: { id: string; name: string; importance?: number } | null;
  /** `"expo"` (default) for the Expo Push Service, `"device"` for the raw APNs/FCM token (direct providers). */
  kind?: "expo" | "device";
  /** Injected modules (tests, or apps that import them already). */
  notifications?: NotificationsLike | null;
  device?: DeviceLike | null;
  constants?: ConstantsLike | null;
  platform?: PlatformLike | null;
}

export type RegisterForPushResult =
  | { status: "granted"; token: string; provider: "expo" | "apns" | "fcm"; platform: string; deviceName?: string }
  | { status: "denied"; canAskAgain: boolean }
  | { status: "unsupported"; reason: string };

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

  if (platform === "android" && opts.androidChannel !== null && N.setNotificationChannelAsync) {
    const ch = opts.androidChannel ?? { id: "default", name: "Default" };
    await N.setNotificationChannelAsync(ch.id, {
      name: ch.name,
      importance: ch.importance ?? N.AndroidImportance?.MAX ?? N.AndroidImportance?.HIGH ?? 4,
    });
  }

  let perm = await N.getPermissionsAsync();
  if (perm.status !== "granted" && opts.requestPermission !== false && perm.canAskAgain !== false) perm = await N.requestPermissionsAsync();
  if (perm.status !== "granted") return { status: "denied", canAskAgain: perm.canAskAgain !== false };

  const extra: { deviceName?: string } = device?.deviceName ? { deviceName: device.deviceName } : {};
  try {
    if (opts.kind === "device") {
      if (!N.getDevicePushTokenAsync) return { status: "unsupported", reason: "getDevicePushTokenAsync is unavailable" };
      const t = await N.getDevicePushTokenAsync();
      const provider = t.type === "ios" ? "apns" : "fcm";
      return { status: "granted", token: String(t.data), provider, platform, ...extra };
    }
    const constants = opts.constants === undefined ? loadConstants() : opts.constants;
    const projectId = opts.projectId ?? constants?.expoConfig?.extra?.eas?.projectId ?? constants?.easConfig?.projectId;
    if (!projectId) return { status: "unsupported", reason: "no EAS projectId (run `eas init` or pass projectId)" };
    const t = await N.getExpoPushTokenAsync({ projectId });
    return { status: "granted", token: t.data, provider: "expo", platform, ...extra };
  } catch (e) {
    return { status: "unsupported", reason: `could not get a push token: ${(e as Error).message}` };
  }
}
