// The page side of the bridge (protocol.ts). `emberDashboardSdk` is self-contained on purpose: it references nothing
// outside its own body, so its source (`Function.prototype.toString`) is also the inline script `EMBED_SDK_SCRIPT`
// that a route serves to its embedded page (the dashboard's CSP allows inline scripts by hash only and no network,
// so the page cannot load the SDK from anywhere). Keep it that way: no imports, helpers or constants from outside.

import type { DashboardTheme, EmbedContext, EmbedErrorInfo } from "./protocol.ts";

/** The parts of `window` the SDK uses (tests pass a fake pair of windows). */
export interface SdkWindow {
  readonly parent: { postMessage(message: unknown, targetOrigin: string): void };
  addEventListener(type: "message", listener: (event: { data: unknown; origin: string; source: unknown }) => void): void;
  removeEventListener(type: "message", listener: (event: { data: unknown; origin: string; source: unknown }) => void): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  readonly document?: {
    readonly documentElement: { readonly style: { setProperty(name: string, value: string): void; colorScheme?: string }; setAttribute(name: string, value: string): void; readonly scrollHeight: number };
    readonly body?: unknown;
  };
  readonly ResizeObserver?: new (cb: () => void) => { observe(target: unknown): void; disconnect(): void };
}

export interface ConnectOptions {
  /** Applies the dashboard's theme as CSS variables on `<html>` (and `data-theme`, `color-scheme`). Default true. */
  applyTheme?: boolean;
  /** Sends the page's height whenever it changes (a block with height "auto"; uses ResizeObserver). Default true. */
  autoResize?: boolean;
  /** How long a query may take, in ms (default 30 s). Writes wait for the person's confirmation: no timeout. */
  queryTimeoutMs?: number;
  /** The window to run in (default: the global one). */
  window?: SdkWindow;
}

/** What `connect()` returns. Function names are the component's local names (`dashboard:threads`). */
export interface DashboardBridge {
  /** Runs a query the block allows; resolves with its value. */
  query<T = unknown>(name: string, args?: Record<string, unknown>): Promise<T>;
  /** Runs a mutation the block allows, once the person confirms it in the dashboard (rejects `cancelled` if not). */
  mutate<T = unknown>(name: string, args?: Record<string, unknown>): Promise<T>;
  /** Runs an action the block allows, once the person confirms it in the dashboard. */
  action<T = unknown>(name: string, args?: Record<string, unknown>): Promise<T>;
  /** The dashboard's theme (null until the handshake). */
  readonly theme: DashboardTheme | null;
  /** Where the page is shown (resolves on the handshake). */
  readonly context: Promise<EmbedContext>;
  /** Called with the theme on the handshake and on every change; returns the unsubscribe. */
  onTheme(cb: (theme: DashboardTheme) => void): () => void;
  /** Asks for this height in pixels (default: the document's scroll height). */
  resize(height?: number): void;
  /** Tells the dashboard the page has drawn. */
  ready(): void;
  /** Stops listening; pending requests reject with `disconnected`. */
  close(): void;
}

/** A refused or failed request: `code` is one of `EmbedErrorCode`, or the function's own error code. */
export interface DashboardErrorLike extends Error {
  readonly code: string;
  readonly data?: unknown;
}

export interface DashboardSdk {
  connect(options?: ConnectOptions): DashboardBridge;
  DashboardError: new (info: EmbedErrorInfo) => DashboardErrorLike;
}

export function emberDashboardSdk(): DashboardSdk {
  const PROTOCOL = "dashboard-embed";
  const V = 1;
  const VAR = /^--[A-Za-z0-9-]{1,60}$/;
  const HELLO_EVERY_MS = 200;
  const HELLO_TRIES = 100;

  class DashboardError extends Error implements DashboardErrorLike {
    readonly code: string;
    readonly data?: unknown;
    constructor(info: EmbedErrorInfo) {
      super(info.message);
      this.name = "DashboardError";
      this.code = info.code;
      if (info.data !== undefined) this.data = info.data;
    }
  }

  function connect(options: ConnectOptions = {}): DashboardBridge {
    const win: SdkWindow | undefined = options.window ?? (typeof window === "undefined" ? undefined : (window as unknown as SdkWindow));
    if (!win) throw new Error("@freecorps/ember-dashboard-sdk: connect() runs in the browser, inside the dashboard's iframe");
    const parent = win.parent;
    const applyTheme = options.applyTheme !== false;
    const queryTimeout = options.queryTimeoutMs ?? 30_000;
    let hostOrigin: string | null = null;
    let closed = false;
    let theme: DashboardTheme | null = null;
    let seq = 0;
    let lastHeight = -1;
    const queue: unknown[] = [];
    const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: unknown }>();
    const themeListeners = new Set<(t: DashboardTheme) => void>();
    let resolveContext: (c: EmbedContext) => void = () => undefined;
    const context = new Promise<EmbedContext>((r) => (resolveContext = r));

    const post = (msg: Record<string, unknown>) => {
      const m = { ember: PROTOCOL, v: V, ...msg };
      // Before the handshake the dashboard's origin is unknown: everything but the hello waits for it.
      if (hostOrigin === null) queue.push(m);
      else parent.postMessage(m, hostOrigin);
    };

    const setTheme = (t: DashboardTheme) => {
      const vars: Record<string, string> = {};
      for (const [k, val] of Object.entries(t.vars ?? {})) if (VAR.test(k) && typeof val === "string" && val.length <= 300) vars[k] = val;
      theme = { mode: t.mode === "dark" ? "dark" : "light", vars };
      const root = win.document?.documentElement;
      if (applyTheme && root) {
        for (const [k, val] of Object.entries(vars)) root.style.setProperty(k, val);
        root.style.colorScheme = theme.mode;
        root.setAttribute("data-theme", theme.mode);
      }
      for (const cb of themeListeners) cb(theme);
    };

    const onMessage = (e: { data: unknown; origin: string; source: unknown }) => {
      // Only the dashboard around this page: never another frame, a popup or the page itself.
      if (closed || e.source !== parent) return;
      const d = e.data as Record<string, unknown> | null;
      if (!d || typeof d !== "object" || d.ember !== PROTOCOL || d.v !== V) return;
      if (hostOrigin === null) {
        // The first welcome pins the dashboard's origin (the browser's `event.origin`, not anything in the message).
        if (d.type !== "welcome" || typeof e.origin !== "string" || !e.origin || e.origin === "null") return;
        hostOrigin = e.origin;
        if (d.theme && typeof d.theme === "object") setTheme(d.theme as DashboardTheme);
        resolveContext(d.context as EmbedContext);
        for (const m of queue.splice(0)) parent.postMessage(m, hostOrigin);
        return;
      }
      if (e.origin !== hostOrigin) return;
      if (d.type === "theme" && d.theme && typeof d.theme === "object") setTheme(d.theme as DashboardTheme);
      else if (d.type === "response" && typeof d.id === "string") {
        const p = pending.get(d.id);
        if (!p) return;
        pending.delete(d.id);
        if (p.timer !== undefined) win.clearTimeout(p.timer);
        if (d.ok === true) p.resolve(d.value);
        else {
          const err = (d.error ?? {}) as Partial<EmbedErrorInfo>;
          p.reject(new DashboardError({ code: typeof err.code === "string" ? err.code : "error", message: typeof err.message === "string" ? err.message : "request failed", ...(err.data !== undefined ? { data: err.data } : {}) }));
        }
      }
    };
    win.addEventListener("message", onMessage);

    // Hello until the welcome: the dashboard may attach its listener after this script ran. It carries nothing, so
    // "*" leaks nothing (the parent's origin is not known yet).
    let tries = 0;
    let helloTimer: unknown;
    const hello = () => {
      if (closed || hostOrigin !== null || tries++ >= HELLO_TRIES) return;
      parent.postMessage({ ember: PROTOCOL, v: V, type: "hello" }, "*");
      helloTimer = win.setTimeout(hello, HELLO_EVERY_MS);
    };
    hello();

    const request = <T>(op: "query" | "mutate" | "action", name: string, args: Record<string, unknown> = {}): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        if (closed) return reject(new DashboardError({ code: "disconnected", message: "the bridge is closed" }));
        if (typeof name !== "string" || !name) return reject(new DashboardError({ code: "bad_request", message: "name: a function name (dashboard:threads)" }));
        if (!args || typeof args !== "object" || Array.isArray(args)) return reject(new DashboardError({ code: "bad_request", message: "args must be an object" }));
        const id = `r${++seq}`;
        const timer = op === "query" ? win.setTimeout(() => {
          if (!pending.delete(id)) return;
          reject(new DashboardError({ code: "timeout", message: `${name}: no answer in ${queryTimeout} ms` }));
        }, queryTimeout) : undefined;
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
        post({ type: "request", id, op, name, args });
      });

    const height = (h?: number) => {
      const root = win.document?.documentElement;
      const n = Math.ceil(typeof h === "number" && Number.isFinite(h) ? h : (root?.scrollHeight ?? 0));
      if (n <= 0 || n === lastHeight) return;
      lastHeight = n;
      post({ type: "resize", height: n });
    };
    let observer: { disconnect(): void } | null = null;
    if (options.autoResize !== false && win.ResizeObserver && win.document?.documentElement) {
      const o = new win.ResizeObserver(() => height());
      o.observe(win.document.body ?? win.document.documentElement);
      observer = o;
    }

    return {
      query: (name, args) => request("query", name, args),
      mutate: (name, args) => request("mutate", name, args),
      action: (name, args) => request("action", name, args),
      get theme() {
        return theme;
      },
      context,
      onTheme(cb) {
        themeListeners.add(cb);
        if (theme) cb(theme);
        return () => void themeListeners.delete(cb);
      },
      resize: (h) => height(h),
      ready: () => post({ type: "ready" }),
      close() {
        if (closed) return;
        closed = true;
        win.removeEventListener("message", onMessage);
        if (helloTimer !== undefined) win.clearTimeout(helloTimer);
        observer?.disconnect();
        for (const [id, p] of pending) {
          pending.delete(id);
          if (p.timer !== undefined) win.clearTimeout(p.timer);
          p.reject(new DashboardError({ code: "disconnected", message: "the bridge is closed" }));
        }
      },
    };
  }

  return { connect, DashboardError };
}
