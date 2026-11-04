import type { ConnectivityEvent, ConnectivitySource } from "@freecorps/ember-client";
import { loadAppState, loadNetInfo, type AppStateLike, type NetInfoLike, type NetInfoStateLike } from "./modules.ts";

export interface ExpoConnectivityOptions {
  /** `AppState` from react-native (default: loaded lazily). `null` ignores app lifecycle. */
  appState?: AppStateLike | null;
  /** `NetInfo` from @react-native-community/netinfo (default: loaded if installed). `null` ignores the network. */
  netInfo?: NetInfoLike | null;
  /**
   * How long sockets stay open after the app goes to the background. iOS suspends the app (and silently kills its
   * sockets) soon after; closing them ourselves frees the server side and makes the foreground reconnect clean.
   * Default 15 s. `Infinity` never closes them.
   */
  backgroundGraceMs?: number;
  /** Injected for tests. */
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

const reachable = (s: NetInfoStateLike) => s.isConnected !== false && s.isInternetReachable !== false;

/**
 * `ConnectivitySource` for React Native / Expo, built on `AppState` + NetInfo:
 *
 * - network down → `offline` (sockets close, no reconnect attempts); back up → `online` (reconnect).
 * - app to background → `background`, then after `backgroundGraceMs` → `offline` (sockets close). While suspended,
 *   network changes are only recorded.
 * - app back to `active` → `online` if the grace period had closed the sockets (reconnect; subscriptions resume from
 *   their last version and pending mutations are resent), else `foreground` (a ping checks the live socket).
 *
 * iOS's transient `inactive` state (control center, app switcher) is ignored. While suspended,
 * `connectionState().online` is false; nothing renders in the background anyway, and news should arrive by push.
 */
export function createExpoConnectivity(opts: ExpoConnectivityOptions = {}): ConnectivitySource {
  const appState = opts.appState === undefined ? loadAppState() : opts.appState;
  const netInfo = opts.netInfo === undefined ? loadNetInfo() : opts.netInfo;
  const grace = opts.backgroundGraceMs ?? 15_000;
  const setT = opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT = opts.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  return {
    isOnline: () => true,
    subscribe(emit: (e: ConnectivityEvent) => void) {
      let netOnline = true;
      let active = appState?.currentState !== "background";
      let suspended = false;
      let timer: unknown = null;
      let stopped = false;

      const effective = () => netOnline && !suspended;
      const cancelTimer = () => {
        if (timer !== null) clearT(timer);
        timer = null;
      };
      const startGrace = () => {
        cancelTimer();
        if (grace === Infinity) return;
        const suspend = () => {
          timer = null;
          if (stopped || active || suspended) return;
          const was = effective();
          suspended = true;
          if (was) emit("offline");
        };
        if (grace <= 0) suspend();
        else timer = setT(suspend, grace);
      };

      const onNet = (s: NetInfoStateLike) => {
        if (stopped) return;
        const next = reachable(s);
        if (next === netOnline) return;
        const was = effective();
        netOnline = next;
        const now = effective();
        if (was !== now) emit(now ? "online" : "offline");
      };

      const onApp = (state: string) => {
        if (stopped) return;
        if (state === "active") {
          if (active) return;
          active = true;
          cancelTimer();
          if (suspended) {
            suspended = false;
            if (netOnline) emit("online");
          } else emit("foreground");
        } else if (state === "background") {
          if (!active) return;
          active = false;
          emit("background");
          startGrace();
        }
      };

      const appSub = appState?.addEventListener("change", onApp);
      const netUnsub = netInfo?.addEventListener(onNet);
      netInfo
        ?.fetch?.()
        .then(onNet)
        .catch(() => {});
      // Launched in the background (push, background task): close sockets after the grace period too.
      if (!active) startGrace();

      return () => {
        stopped = true;
        cancelTimer();
        appSub?.remove();
        netUnsub?.();
      };
    },
  };
}
