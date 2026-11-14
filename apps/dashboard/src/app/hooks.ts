import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { api, ApiError, type Me } from "./api.ts";

export interface Loaded<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  reload: () => void;
}

/** GET `path` (null = nothing to load). Keeps the previous data while reloading. */
export function useApi<T>(path: string | null): Loaded<T> {
  const [state, setState] = useState<{ data: T | null; error: ApiError | null; loading: boolean; for: string | null }>({ data: null, error: null, loading: !!path, for: path });
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!path) {
      setState({ data: null, error: null, loading: false, for: null });
      return;
    }
    let live = true;
    setState((s) => ({ ...s, loading: true, ...(s.for !== path ? { data: null, error: null, for: path } : {}) }));
    api.get<T>(path).then(
      (data) => live && setState({ data, error: null, loading: false, for: path }),
      (e: unknown) => live && setState({ data: null, error: e instanceof ApiError ? e : new ApiError(0, "error", String(e)), loading: false, for: path }),
    );
    return () => {
      live = false;
    };
  }, [path, n]);
  const reload = useCallback(() => setN((x) => x + 1), []);
  return { data: state.data, error: state.error, loading: state.loading, reload };
}

// ------------------------------------------------------------------------------------------- route

export interface Route {
  /** "projects" | "env" | "audit" (all projects) */
  page: string;
  project?: string;
  env?: string;
  section?: string;
  /** The shard (data, shards, crons, reactivity). */
  shard?: string;
  /** The function (functions section): the same route segment, never read as a shard. */
  fn?: string;
}

export function parseHash(hash: string): Route {
  const parts = hash
    .replace(/^#\/?/, "")
    .split("/")
    .filter(Boolean)
    .map((p) => {
      try {
        return decodeURIComponent(p);
      } catch {
        return p;
      }
    });
  if (parts[0] === "p" && parts[1] && parts[2]) {
    const section = parts[3] ?? "health";
    const arg = parts[4];
    return { page: "env", project: parts[1], env: parts[2], section, ...(arg ? (section === "functions" ? { fn: arg } : { shard: arg }) : {}) };
  }
  if (parts[0] === "audit") return { page: "audit" };
  return { page: "projects" };
}

export function href(r: { project: string; env: string; section?: string | undefined; shard?: string | null | undefined }): string {
  const seg = [r.project, r.env, r.section ?? "health", ...(r.shard ? [r.shard] : [])].map(encodeURIComponent).join("/");
  return `#/p/${seg}`;
}

export function useRoute(): Route {
  const [h, setH] = useState(location.hash);
  useEffect(() => {
    const f = () => setH(location.hash);
    addEventListener("hashchange", f);
    return () => removeEventListener("hashchange", f);
  }, []);
  return parseHash(h);
}

// ------------------------------------------------------------------------------------------- keys

const typing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
};

/** Single-key shortcuts, ignored while typing or with a modifier held. */
export function useShortcuts(map: Record<string, () => void>): void {
  const ref = useRef(map);
  ref.current = map;
  useEffect(() => {
    const f = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e.target) || document.querySelector("dialog[open]")) return;
      const fn = ref.current[e.key];
      if (fn) {
        e.preventDefault();
        fn();
      }
    };
    addEventListener("keydown", f);
    return () => removeEventListener("keydown", f);
  }, []);
}

// ------------------------------------------------------------------------------------------- theme

export type Theme = "auto" | "light" | "dark";
const THEME_KEY = "ember-dashboard-theme";

/** The theme preference (not a secret: the one thing the dashboard keeps in localStorage). */
export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const t = localStorage.getItem(THEME_KEY);
      return t === "light" || t === "dark" ? t : "auto";
    } catch {
      return "auto";
    }
  });
  useEffect(() => {
    if (theme === "auto") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", theme);
    try {
      if (theme === "auto") localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, theme);
    } catch {
      // storage unavailable: the choice lasts this page
    }
  }, [theme]);
  return [theme, setTheme];
}

// ------------------------------------------------------------------------------------------- session context

export interface SessionInfo {
  me: Me;
  isAdmin: boolean;
  isProtected: (env: string) => boolean;
  toast: (t: { kind?: "ok" | "bad"; text: string; detail?: string }) => void;
}

export const SessionContext = createContext<SessionInfo | null>(null);

export function useSession(): SessionInfo {
  const s = useContext(SessionContext);
  if (!s) throw new Error("useSession outside the signed-in app");
  return s;
}
