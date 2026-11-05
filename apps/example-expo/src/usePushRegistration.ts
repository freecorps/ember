import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { useEffect, useRef, useState } from "react";
import { ensurePushKey, registerEmberPushTask } from "@freecorps/ember-expo-push";
import { registerForPush, useMutation, type RegisterForPushResult } from "@freecorps/ember-react-native";
import { api } from "./api";

// Show notifications as banners while the app is open too (otherwise iOS hides them in the foreground).
Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
});

const DIRECT = Constants.expoConfig?.extra?.pushTransport === "direct";

/**
 * After sign-in: ask for permission, get the push token and store it on the server (`push:register`).
 * - Expo transport (default): an Expo push token.
 * - Direct (EMBER_PUSH_DIRECT=1): the native APNs/FCM token with its APNs environment, plus the device public key so
 *   the server seals the content (iOS: the Notification Service Extension decrypts; Android: the decrypt task).
 * Returns the outcome (and the token, so sign-out can unregister this device first).
 */
export function usePushRegistration(userKey: string | null): RegisterForPushResult | null {
  const register = useMutation(api.push.register);
  const [result, setResult] = useState<RegisterForPushResult | null>(null);
  const done = useRef<string | null>(null);
  useEffect(() => {
    if (!userKey || done.current === userKey) return;
    done.current = userKey;
    void (async () => {
      const key = DIRECT ? await ensurePushKey().catch((e: unknown) => (console.warn("[push] no device key", e), null)) : null;
      const r = await registerForPush(
        DIRECT ? { kind: "device", androidChannels: [{ id: "default", name: "Messages" }], ...(key ? { publicKey: key.publicKey } : {}) } : {},
      );
      setResult(r);
      if (r.status !== "granted") return;
      const args: Parameters<typeof register>[0] = { token: r.token, platform: r.platform, provider: r.provider };
      if (r.deviceName) args.deviceName = r.deviceName;
      if (r.environment) args.environment = r.environment;
      if (r.publicKey) args.publicKey = r.publicKey;
      await register(args).catch((e: unknown) => console.warn("[push] register failed", e));
      if (DIRECT && r.platform === "android") await registerEmberPushTask().catch((e: unknown) => console.warn("[push] task", e));
    })();
  }, [userKey, register]);
  return result;
}
