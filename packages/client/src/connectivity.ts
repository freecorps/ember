/**
 * Hooks the client uses to react to the network and app lifecycle. The browser default listens to
 * `online`/`offline` and `visibilitychange`; React Native wires AppState + NetInfo the same way:
 *
 *   connectivity: {
 *     subscribe(emit) {
 *       const a = AppState.addEventListener("change", (s) => emit(s === "active" ? "foreground" : "background"));
 *       const n = NetInfo.addEventListener((s) => emit(s.isConnected ? "online" : "offline"));
 *       return () => { a.remove(); n(); };
 *     },
 *   }
 */
export type ConnectivityEvent = "online" | "offline" | "foreground" | "background";

export interface ConnectivitySource {
  /** Initial state; default true. */
  isOnline?(): boolean;
  subscribe(emit: (e: ConnectivityEvent) => void): () => void;
}

export function browserConnectivity(): ConnectivitySource | null {
  const g = globalThis as unknown as {
    addEventListener?: (t: string, f: () => void) => void;
    removeEventListener?: (t: string, f: () => void) => void;
    navigator?: { onLine?: boolean };
    document?: { visibilityState?: string; addEventListener?: (t: string, f: () => void) => void; removeEventListener?: (t: string, f: () => void) => void };
  };
  if (typeof g.addEventListener !== "function") return null;
  return {
    isOnline: () => g.navigator?.onLine !== false,
    subscribe(emit) {
      const on = () => emit("online");
      const off = () => emit("offline");
      const vis = () => emit(g.document?.visibilityState === "hidden" ? "background" : "foreground");
      g.addEventListener!("online", on);
      g.addEventListener!("offline", off);
      g.document?.addEventListener?.("visibilitychange", vis);
      return () => {
        g.removeEventListener?.("online", on);
        g.removeEventListener?.("offline", off);
        g.document?.removeEventListener?.("visibilitychange", vis);
      };
    },
  };
}
