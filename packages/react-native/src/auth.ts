/**
 * Better Auth from React Native without cookies (the pattern of Better Auth's Expo client plugin, minus the
 * dependency): Ember's Auth DO always runs the `bearer()` and `jwt()` plugins (PLAN §9), so
 *
 * 1. sign-in/sign-up answers with the session token in `set-auth-token`; it is kept in SecureStore;
 * 2. every auth call sends it as `Authorization: Bearer <session token>`;
 * 3. `fetchToken()` mints a short JWT at `GET /api/auth/token` (cached until shortly before `exp`), which is what
 *    `EmberClient` sends on the socket (`auth` option) and on HTTP calls.
 *
 * A 401 from `/token` or a `null` session means the session was revoked or expired: the stored token is dropped
 * and the state becomes `signedOut`.
 */
import type { EmberClient } from "@freecorps/ember-client";
import { defaultTokenStore, type TokenStore } from "./storage.ts";

export interface AuthUser {
  id: string;
  email: string;
  name?: string;
  emailVerified?: boolean;
  image?: string | null;
  [field: string]: unknown;
}

export type AuthState =
  | { status: "loading"; user: null }
  | { status: "signedOut"; user: null }
  /** `user` is null until the first `getSession()` after a restart answers. */
  | { status: "signedIn"; user: AuthUser | null };

export interface EmberAuthClientOptions {
  /** Deployment URL (the Worker that serves `/api/auth/*`). */
  url: string;
  /** Default `/api/auth`. */
  basePath?: string;
  /** Default: SecureStore on iOS/Android, localStorage on web. */
  tokenStore?: TokenStore;
  fetch?: typeof fetch;
  /**
   * `Origin` header for state-changing calls. Better Auth rejects untrusted origins; native apps have none, so the
   * default sends the deployment's own origin (always trusted). `null` omits it (browsers set their own).
   */
  origin?: string | null;
  /** Mint a new JWT this long before the cached one expires. Default 30 s. */
  jwtRefreshMarginMs?: number;
  /** Validate the stored session (`get-session`) right after loading it. Default true. */
  validateOnLoad?: boolean;
  now?: () => number;
}

export class AuthError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

function jwtExpMs(token: string): number | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const b64 = part.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((part.length + 3) % 4);
    const exp = (JSON.parse(atob(b64)) as { exp?: unknown }).exp;
    return typeof exp === "number" ? exp * 1000 : null;
  } catch {
    return null;
  }
}

export class EmberAuthClient {
  private readonly base: string;
  private readonly origin: string | null;
  private readonly store: TokenStore;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private sessionToken: string | null = null;
  private jwt: { token: string; exp: number | null } | null = null;
  private jwtInFlight: Promise<string | null> | null = null;
  private state: AuthState = { status: "loading", user: null };
  private readonly listeners = new Set<() => void>();
  private readonly identityListeners = new Set<() => void>();
  private readonly loaded: Promise<void>;

  constructor(private readonly opts: EmberAuthClientOptions) {
    const url = opts.url.replace(/\/+$/, "").replace(/^ws(s?):/, "http$1:");
    this.base = url + (opts.basePath ?? "/api/auth");
    this.origin = opts.origin === undefined ? new URL(url).origin : opts.origin;
    this.store = opts.tokenStore ?? defaultTokenStore();
    const f = opts.fetch ?? globalThis.fetch;
    this.fetchImpl = (input, init) => f(input, init);
    this.now = opts.now ?? Date.now;
    this.loaded = this.load();
  }

  private async load(): Promise<void> {
    let t: string | null = null;
    try {
      t = await this.store.get();
    } catch {
      t = null;
    }
    this.sessionToken = t;
    this.setState(t ? { status: "signedIn", user: null } : { status: "signedOut", user: null });
    if (t && this.opts.validateOnLoad !== false) void this.getSession().catch(() => undefined);
  }

  /** Resolves once the stored session token was read. */
  ready(): Promise<void> {
    return this.loaded;
  }

  // ------------------------------------------------------------------------------------------- state

  getState = (): AuthState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Called on sign-in, sign-up with a session, sign-out and detected revocation (not on the initial load). */
  onIdentityChange(listener: () => void): () => void {
    this.identityListeners.add(listener);
    return () => this.identityListeners.delete(listener);
  }

  private setState(s: AuthState): void {
    if (s.status === this.state.status && s.user === this.state.user) return;
    this.state = s;
    for (const l of [...this.listeners]) l();
  }

  private async setSession(token: string | null, user: AuthUser | null): Promise<void> {
    const changed = token !== this.sessionToken;
    this.sessionToken = token;
    this.jwt = null;
    this.jwtInFlight = null;
    if (token) await this.store.set(token);
    else await this.store.clear().catch(() => undefined);
    this.setState(token ? { status: "signedIn", user } : { status: "signedOut", user: null });
    if (changed) for (const l of [...this.identityListeners]) l();
  }

  // ------------------------------------------------------------------------------------------- http

  /** Calls any Better Auth endpoint (`path` under the base path) with the bearer session token. */
  async request<T = unknown>(path: string, init: { method?: string; body?: unknown; query?: Record<string, string> } = {}): Promise<{ status: number; data: T; headers: Headers }> {
    await this.loaded;
    const method = init.method ?? (init.body === undefined ? "GET" : "POST");
    const headers: Record<string, string> = { accept: "application/json" };
    if (init.body !== undefined) headers["content-type"] = "application/json";
    if (this.sessionToken) headers.authorization = `Bearer ${this.sessionToken}`;
    if (this.origin && method !== "GET") headers.origin = this.origin;
    const qs = init.query ? "?" + new URLSearchParams(init.query).toString() : "";
    const res = await this.fetchImpl(this.base + path + qs, {
      method,
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    const jwt = res.headers.get("set-auth-jwt");
    if (jwt && this.sessionToken) this.jwt = { token: jwt, exp: jwtExpMs(jwt) };
    if (!res.ok) {
      throw new AuthError(res.status, String(data?.code ?? `HTTP_${res.status}`), String(data?.message ?? res.statusText ?? "auth request failed"));
    }
    return { status: res.status, data: data as T, headers: res.headers };
  }

  private async establish(r: { data: any; headers: Headers }): Promise<AuthUser | null> {
    const token = r.headers.get("set-auth-token") ?? (typeof r.data?.token === "string" ? r.data.token : null);
    const user = (r.data?.user ?? null) as AuthUser | null;
    if (token) await this.setSession(token, user);
    return user;
  }

  // ------------------------------------------------------------------------------------------- flows

  /** Email + password sign-up. Without a session in the answer (email verification required) the state stays signedOut. */
  async signUpEmail(input: { email: string; password: string; name: string; [field: string]: unknown }): Promise<AuthUser | null> {
    return this.establish(await this.request("/sign-up/email", { body: input }));
  }

  async signInEmail(input: { email: string; password: string; rememberMe?: boolean }): Promise<AuthUser | null> {
    return this.establish(await this.request("/sign-in/email", { body: input }));
  }

  /** Revokes the session on the server (best effort) and forgets it locally. */
  async signOut(): Promise<void> {
    await this.loaded;
    if (this.sessionToken) await this.request("/sign-out", { body: {} }).catch(() => undefined);
    await this.setSession(null, null);
  }

  /** Current session from the server; `null` (revoked/expired) signs out locally. Network errors throw. */
  async getSession(): Promise<{ user: AuthUser; session: Record<string, unknown> } | null> {
    await this.loaded;
    if (!this.sessionToken) return null;
    const token = this.sessionToken;
    let r: { data: { user: AuthUser; session: Record<string, unknown> } | null };
    try {
      r = await this.request("/get-session");
    } catch (e) {
      if (e instanceof AuthError && e.status === 401 && token === this.sessionToken) await this.setSession(null, null);
      throw e;
    }
    if (token !== this.sessionToken) return r.data;
    if (!r.data?.user) {
      await this.setSession(null, null);
      return null;
    }
    this.setState({ status: "signedIn", user: r.data.user });
    return r.data;
  }

  /** The stored session token (opaque). Prefer `fetchToken()` for Ember calls. */
  async getSessionToken(): Promise<string | null> {
    await this.loaded;
    return this.sessionToken;
  }

  /**
   * A short-lived JWT for Ember (`new EmberClient({ auth: authClient.fetchToken })`), or null when signed out.
   * Concurrent calls share one request.
   */
  fetchToken = async (): Promise<string | null> => {
    await this.loaded;
    if (!this.sessionToken) return null;
    const margin = this.opts.jwtRefreshMarginMs ?? 30_000;
    if (this.jwt && (this.jwt.exp === null ? false : this.jwt.exp - margin > this.now())) return this.jwt.token;
    if (this.jwtInFlight) return this.jwtInFlight;
    const session = this.sessionToken;
    const p: Promise<string | null> = this.mintJwt(session).finally(() => {
      if (this.jwtInFlight === p) this.jwtInFlight = null;
    });
    this.jwtInFlight = p;
    return p;
  };

  private async mintJwt(session: string): Promise<string | null> {
    try {
      const r = await this.request<{ token?: string }>("/token");
      const t = r.data?.token;
      if (!t) throw new AuthError(r.status, "NO_TOKEN", "auth: /token returned no token");
      if (session === this.sessionToken) this.jwt = { token: t, exp: jwtExpMs(t) };
      return t;
    } catch (e) {
      if (e instanceof AuthError && e.status === 401 && session === this.sessionToken) {
        await this.setSession(null, null);
        return null;
      }
      throw e;
    }
  }
}

export function createEmberAuthClient(opts: EmberAuthClientOptions): EmberAuthClient {
  return new EmberAuthClient(opts);
}

/**
 * Keeps `client`'s token source in step with `auth`: on sign-in/sign-out the client re-authenticates its open
 * sockets in place (`{t:"auth"}`) and its queries re-run under the new identity. `initial: true` also installs the
 * fetcher now (for a client created without `auth: authClient.fetchToken`). Returns an unsubscribe function.
 */
export function bindEmberAuth(client: Pick<EmberClient, "setAuth">, auth: EmberAuthClient, opts: { initial?: boolean } = {}): () => void {
  if (opts.initial) client.setAuth(auth.fetchToken);
  return auth.onIdentityChange(() => client.setAuth(auth.fetchToken));
}
