/**
 * Optional native modules, loaded lazily with literal `require`s inside try/catch (Metro treats those as optional),
 * and the small structural surface this package uses, so it type-checks and tests without them installed. Every API
 * also accepts the module as an option, which is how tests inject fakes.
 */
declare const require: (id: string) => any;

export interface SecureStoreLike {
  getItemAsync(key: string, options?: Record<string, unknown>): Promise<string | null>;
  setItemAsync(key: string, value: string, options?: Record<string, unknown>): Promise<void>;
  deleteItemAsync(key: string, options?: Record<string, unknown>): Promise<void>;
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY?: number;
}

export interface NotificationsLike {
  scheduleNotificationAsync(request: { identifier?: string; content: Record<string, unknown>; trigger: Record<string, unknown> | null }): Promise<string>;
  registerTaskAsync?(taskName: string): Promise<null | void>;
}

export interface TaskManagerLike {
  defineTask(name: string, task: (body: { data: unknown; error: unknown; executionInfo?: unknown }) => Promise<unknown> | unknown): void;
}

export interface ConstantsLike {
  expoConfig?: { extra?: { emberPush?: EmberPushExtra } } | null;
}

/** What the config plugin records in `expo.extra.emberPush` (read at runtime through expo-constants). */
export interface EmberPushExtra {
  apsEnvironment?: "development" | "production";
  /** iOS App Group shared by the app and the Notification Service Extension; also the keychain access group. */
  appGroup?: string;
  keychainService?: string;
  keyName?: string;
}

export const pick = <T>(m: any, named?: string): T | null => (m ? ((named ? m[named] : undefined) ?? m.default ?? m) : null);

export function loadSecureStore(): SecureStoreLike | null {
  try {
    const m = require("expo-secure-store");
    return m && typeof m.getItemAsync === "function" ? m : pick<SecureStoreLike>(m);
  } catch {
    return null;
  }
}

export function loadNotifications(): NotificationsLike | null {
  try {
    const m = require("expo-notifications");
    return m && typeof m.scheduleNotificationAsync === "function" ? m : pick<NotificationsLike>(m);
  } catch {
    return null;
  }
}

export function loadTaskManager(): TaskManagerLike | null {
  try {
    const m = require("expo-task-manager");
    return m && typeof m.defineTask === "function" ? m : pick<TaskManagerLike>(m);
  } catch {
    return null;
  }
}

export function loadConstants(): ConstantsLike | null {
  try {
    return pick<ConstantsLike>(require("expo-constants"));
  } catch {
    return null;
  }
}

export function loadPlatformOS(): string | undefined {
  try {
    return require("react-native")?.Platform?.OS;
  } catch {
    return undefined;
  }
}

/** Random bytes: `crypto.getRandomValues` when the runtime has it, else expo-crypto's. Throws without either. */
export function defaultRandom(n: number): Uint8Array {
  const out = new Uint8Array(n);
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c?.getRandomValues) return c.getRandomValues(out);
  try {
    const m = require("expo-crypto");
    if (typeof m.getRandomValues === "function") return m.getRandomValues(out);
    if (typeof m.getRandomBytes === "function") return m.getRandomBytes(n);
  } catch {
    /* fall through */
  }
  throw new Error("@freecorps/ember-expo-push: no secure random source (install expo-crypto)");
}
