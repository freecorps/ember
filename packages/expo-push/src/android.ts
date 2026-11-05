/**
 * Android: sealed pushes arrive as FCM data-only messages (`@freecorps/ember-push` `fcmMessage`): `{ ember: <envelope
 * JSON>, fallbackTitle, fallbackBody, channelId?, tag?, urgency }`. Nothing is shown by the system for those;
 * expo-notifications hands them to a background task (`Notifications.registerTaskAsync`), which runs in the foreground,
 * in the background and with the app killed (headless JS). The task decrypts with the device key and posts a local
 * notification with the content — or, when the push does not open, the fallback text: never silence.
 *
 *   // index.ts — at module top level, before registerRootComponent:
 *   import { defineEmberPushTask } from "@freecorps/ember-expo-push";
 *   defineEmberPushTask();
 *   // after sign-in (once per launch is fine):
 *   await registerEmberPushTask();
 *
 * iOS needs none of this: the Notification Service Extension decrypts before the notification is shown.
 */
import { openPushEnvelope, parsePushEnvelope, type OpenedPush, type PushKeyPair } from "./crypto.ts";
import { loadPushKeys, type PushKeyOptions } from "./keys.ts";
import { loadNotifications, loadPlatformOS, loadTaskManager, type NotificationsLike, type TaskManagerLike } from "./modules.ts";

export const EMBER_PUSH_TASK = "ember-push-decrypt";

/** The sealed fields of a data message, wherever expo-notifications put them in the task payload. */
export interface EncryptedPushData {
  ember: string;
  fallbackTitle?: string;
  fallbackBody?: string;
  channelId?: string;
  tag?: string;
  urgency?: string;
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/**
 * Finds the sealed fields in a background-task payload. expo-notifications passes `{ data: { ...fcmData } }`, with the
 * data also as a JSON string in `data.dataString` on some versions; a `RemoteMessage`-like `{ data }` or the FCM data
 * itself works too. Null when this is not an Ember sealed push.
 */
export function extractEncryptedPush(payload: unknown): EncryptedPushData | null {
  const candidates: unknown[] = [];
  if (isRecord(payload)) {
    candidates.push(payload);
    const data = payload.data;
    if (isRecord(data)) {
      candidates.push(data);
      if (typeof data.dataString === "string") {
        try {
          candidates.push(JSON.parse(data.dataString));
        } catch {
          /* ignore */
        }
      }
      if (isRecord(data.data)) candidates.push(data.data);
    }
    if (isRecord(payload.notification) && isRecord(payload.notification.data)) candidates.push(payload.notification.data);
  }
  for (const c of candidates) {
    if (!isRecord(c) || typeof c.ember !== "string") continue;
    const out: EncryptedPushData = { ember: c.ember };
    for (const f of ["fallbackTitle", "fallbackBody", "channelId", "tag", "urgency"] as const) if (typeof c[f] === "string") out[f] = c[f] as string;
    return out;
  }
  return null;
}

export interface PresentOptions extends PushKeyOptions {
  notifications?: NotificationsLike | null;
  /** Keys to open with (default: the stored device keys). */
  keys?: readonly PushKeyPair[];
  /** Change the content before it is shown (e.g. a per-app layout); return null to show nothing. */
  transform?: (opened: OpenedPush, data: EncryptedPushData) => Record<string, unknown> | null;
  /** Default fallback when the push carries none. */
  fallback?: { title: string; body: string };
}

export type PresentResult = { shown: "content" | "fallback"; identifier: string; reason?: string } | { shown: "nothing"; reason: string };

/** Decrypts a sealed data push and posts it as a local notification (the content, or the fallback text). */
export async function presentEncryptedPush(payload: unknown, o: PresentOptions = {}): Promise<PresentResult> {
  const data = extractEncryptedPush(payload);
  if (!data) return { shown: "nothing", reason: "not an Ember sealed push" };
  const N = o.notifications === undefined ? loadNotifications() : o.notifications;
  if (!N) return { shown: "nothing", reason: "expo-notifications is not installed" };
  const trigger = data.channelId ? { channelId: data.channelId } : null;
  const base = { ...(data.tag ? { identifier: data.tag } : {}), trigger };
  let content: Record<string, unknown> | null;
  let reason: string | undefined;
  try {
    const envelope = parsePushEnvelope(data.ember);
    if (!envelope) throw new Error("malformed envelope");
    const keys = o.keys ?? (await loadPushKeys(o));
    if (!keys.length) throw new Error("no device key");
    const opened = openPushEnvelope(envelope, keys);
    content = o.transform ? o.transform(opened, data) : { title: opened.title, subtitle: opened.subtitle, body: opened.body, data: opened.data ?? {}, sound: "default" };
    if (content === null) return { shown: "nothing", reason: "transform returned null" };
    for (const k of Object.keys(content)) if (content[k] === undefined) delete content[k];
    const identifier = await N.scheduleNotificationAsync({ ...base, content });
    return { shown: "content", identifier };
  } catch (e) {
    reason = (e as Error).message;
  }
  // Never silence: the fallback the server sent (or ours).
  const fb = { title: data.fallbackTitle ?? o.fallback?.title ?? "New notification", body: data.fallbackBody ?? o.fallback?.body ?? "Open the app to see it." };
  const identifier = await N.scheduleNotificationAsync({ ...base, content: { ...fb, data: {} } });
  return { shown: "fallback", identifier, reason };
}

export interface TaskOptions extends PresentOptions {
  taskManager?: TaskManagerLike | null;
  taskName?: string;
  /** Default Platform.OS; the task does nothing on iOS (the NSE decrypts there). */
  platform?: string;
  onResult?: (r: PresentResult) => void;
}

/**
 * Defines the background task that shows sealed pushes on Android. Call at module top level (headless JS needs the
 * definition before the app renders). Returns the task name.
 */
export function defineEmberPushTask(o: TaskOptions = {}): string {
  const TM = o.taskManager === undefined ? loadTaskManager() : o.taskManager;
  const name = o.taskName ?? EMBER_PUSH_TASK;
  if (!TM) throw new Error("@freecorps/ember-expo-push: expo-task-manager is required for the Android decrypt task");
  TM.defineTask(name, async ({ data, error }) => {
    if (error) return;
    if ((o.platform ?? loadPlatformOS()) === "ios") return;
    const r = await presentEncryptedPush(data, o);
    o.onResult?.(r);
  });
  return name;
}

/** Registers the task with expo-notifications so data-only pushes reach it. */
export async function registerEmberPushTask(o: { notifications?: NotificationsLike | null; taskName?: string } = {}): Promise<void> {
  const N = o.notifications === undefined ? loadNotifications() : o.notifications;
  if (!N?.registerTaskAsync) throw new Error("@freecorps/ember-expo-push: expo-notifications registerTaskAsync is unavailable");
  await N.registerTaskAsync(o.taskName ?? EMBER_PUSH_TASK);
}
