import * as Notifications from "expo-notifications";
import { useEffect, useRef, useState } from "react";
import { registerForPush, useMutation, type RegisterForPushResult } from "@ember/react-native";
import { api } from "./api";

// Show notifications as banners while the app is open too (otherwise iOS hides them in the foreground).
Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
});

/**
 * After sign-in: ask for permission, get the Expo push token and store it on the server (`push:register`).
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
      const r = await registerForPush();
      setResult(r);
      if (r.status === "granted") {
        const args: { token: string; platform: string; deviceName?: string } = { token: r.token, platform: r.platform };
        if (r.deviceName) args.deviceName = r.deviceName;
        await register(args).catch((e: unknown) => console.warn("[push] register failed", e));
      }
    })();
  }, [userKey, register]);
  return result;
}
