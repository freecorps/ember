/**
 * Optional native modules, loaded lazily with literal `require`s inside try/catch: Metro treats those as optional
 * dependencies (an app without NetInfo or SecureStore still bundles). Every public API also accepts the module
 * as an argument, which is how tests inject fakes.
 *
 * The structural types below are the small surface this package uses, so it type-checks without the native
 * packages installed.
 */

declare const require: (id: string) => any;

export interface AppStateLike {
  currentState?: string | null;
  addEventListener(type: "change", listener: (state: string) => void): { remove(): void };
}

export interface NetInfoStateLike {
  isConnected: boolean | null;
  isInternetReachable?: boolean | null;
}

export interface NetInfoLike {
  addEventListener(listener: (state: NetInfoStateLike) => void): () => void;
  fetch?(): Promise<NetInfoStateLike>;
}

export interface AsyncStorageLike {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface SecureStoreLike {
  getItemAsync(key: string, options?: Record<string, unknown>): Promise<string | null>;
  setItemAsync(key: string, value: string, options?: Record<string, unknown>): Promise<void>;
  deleteItemAsync(key: string, options?: Record<string, unknown>): Promise<void>;
}

export interface PermissionResponseLike {
  status: string;
  granted?: boolean;
  canAskAgain?: boolean;
}

export interface NotificationsLike {
  getPermissionsAsync(): Promise<PermissionResponseLike>;
  requestPermissionsAsync(options?: Record<string, unknown>): Promise<PermissionResponseLike>;
  getExpoPushTokenAsync(options?: { projectId?: string }): Promise<{ data: string; type?: string }>;
  getDevicePushTokenAsync?(): Promise<{ data: unknown; type: string }>;
  setNotificationChannelAsync?(id: string, channel: Record<string, unknown>): Promise<unknown>;
  setNotificationCategoryAsync?(id: string, actions: unknown[], options?: Record<string, unknown>): Promise<unknown>;
  AndroidImportance?: { MAX?: number; HIGH?: number; DEFAULT?: number };
}

export interface DeviceLike {
  isDevice: boolean;
  deviceName?: string | null;
}

export interface ConstantsLike {
  expoConfig?: { extra?: { eas?: { projectId?: string }; emberPush?: { apsEnvironment?: string } } } | null;
  easConfig?: { projectId?: string } | null;
}

export interface PlatformLike {
  OS: string;
}

const pick = <T>(m: any, named?: string): T | null => (m ? ((named ? m[named] : undefined) ?? m.default ?? m) : null);

export function loadAppState(): AppStateLike | null {
  try {
    return pick<AppStateLike>(require("react-native"), "AppState");
  } catch {
    return null;
  }
}

export function loadPlatform(): PlatformLike | null {
  try {
    return pick<PlatformLike>(require("react-native"), "Platform");
  } catch {
    return null;
  }
}

export function loadNetInfo(): NetInfoLike | null {
  try {
    return pick<NetInfoLike>(require("@react-native-community/netinfo"));
  } catch {
    return null;
  }
}

export function loadAsyncStorage(): AsyncStorageLike | null {
  try {
    return pick<AsyncStorageLike>(require("@react-native-async-storage/async-storage"));
  } catch {
    return null;
  }
}

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
    return m && typeof m.getPermissionsAsync === "function" ? m : pick<NotificationsLike>(m);
  } catch {
    return null;
  }
}

export function loadDevice(): DeviceLike | null {
  try {
    const m = require("expo-device");
    return m && typeof m.isDevice === "boolean" ? m : pick<DeviceLike>(m);
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
