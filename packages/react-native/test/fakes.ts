import type { AppStateLike, AsyncStorageLike, NetInfoLike, NetInfoStateLike, SecureStoreLike } from "../src/index.ts";

export function fakeAppState(initial = "active") {
  const listeners = new Set<(s: string) => void>();
  const api: AppStateLike & { set(s: string): void; listeners(): number } = {
    currentState: initial,
    addEventListener(_type, l) {
      listeners.add(l);
      return { remove: () => void listeners.delete(l) };
    },
    set(s: string) {
      api.currentState = s;
      for (const l of [...listeners]) l(s);
    },
    listeners: () => listeners.size,
  };
  return api;
}

export function fakeNetInfo(initial: NetInfoStateLike = { isConnected: true, isInternetReachable: true }) {
  const listeners = new Set<(s: NetInfoStateLike) => void>();
  let state = initial;
  const api: NetInfoLike & { set(s: Partial<NetInfoStateLike>): void; listeners(): number } = {
    addEventListener(l) {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    fetch: async () => state,
    set(s) {
      state = { ...state, ...s };
      for (const l of [...listeners]) l(state);
    },
    listeners: () => listeners.size,
  };
  return api;
}

export function fakeAsyncStorage() {
  const map = new Map<string, string>();
  const api: AsyncStorageLike & { map: Map<string, string> } = {
    map,
    getItem: async (k) => map.get(k) ?? null,
    setItem: async (k, v) => void map.set(k, v),
    removeItem: async (k) => void map.delete(k),
  };
  return api;
}

export function fakeSecureStore() {
  const map = new Map<string, string>();
  const api: SecureStoreLike & { map: Map<string, string> } = {
    map,
    getItemAsync: async (k) => map.get(k) ?? null,
    setItemAsync: async (k, v) => void map.set(k, v),
    deleteItemAsync: async (k) => void map.delete(k),
  };
  return api;
}
