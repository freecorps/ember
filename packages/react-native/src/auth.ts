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
 *
 * Concurrent calls share requests: `getSession()` calls in flight for the same session are one `/get-session`, and a
 * `fetchToken()` while one is in flight waits for it — Better Auth's jwt plugin answers `get-session` with a fresh JWT
 * in `set-auth-jwt`, so the app start (validate the stored session, then the socket asks for a token) is one request
 * instead of two. Without that header, `/token` is called as before.
 */
import type { EmberClient } from "@freecorps/ember-client";
import { base64ToBytes } from "@freecorps/ember-values";
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

/**
 * The `exp` of a JWT, in ms. Its payload is base64url (`base64ToBytes` reads either alphabet, padding optional): no
 * `atob`, which not every React Native runtime has and which takes neither `-`/`_` nor a missing `=`.
 */
export function jwtExpMs(token: string): number | null {
  const exp = jwtPayload(token)?.exp;
  return typeof exp === "number" ? exp * 1000 : null;
}

function jwtPayload(token: string): { exp?: unknown; sub?: unknown } | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const bytes = base64ToBytes(part);
    // `exp` and `sub` are ASCII here: without a TextDecoder (older Hermes) bytes as Latin-1 read them the same.
    const text = typeof TextDecoder === "function" ? new TextDecoder().decode(bytes) : latin1(bytes);
    const p = JSON.parse(text) as unknown;
    return p && typeof p === "object" ? (p as { exp?: unknown; sub?: unknown }) : null;
  } catch {
    return null;
  }
}

function latin1(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 4096) s += String.fromCharCode(...bytes.subarray(i, i + 4096));
  return s;
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
  /** The `/get-session` in flight, and the session token it was sent with. */
  private sessionInFlight: { token: string; p: Promise<{ user: AuthUser; session: Record<string, unknown> } | null> } | null = null;
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
    // In flight before `ready()` resolves: a `fetchToken()` made meanwhile waits for it (and its `set-auth-jwt`).
    if (t && this.opts.validateOnLoad !== false) void this.sharedSession(t).catch(() => undefined);
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
    this.sessionInFlight = null;
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
    if (token) {
      await this.setSession(token, user);
      // The answer that started the session may carry its first JWT (Better Auth's jwt plugin, `set-auth-jwt`): kept,
      // so the socket's `fetchToken()` right after sign-in needs no `/token` round trip. (`request` saw it before the
      // session existed, and `setSession` drops the previous session's JWT.)
      // Only one for the user the answer names (never a JWT of the session the request was sent with).
      const jwt = r.headers.get("set-auth-jwt");
      if (jwt && this.sessionToken === token && user?.id !== undefined && jwtPayload(jwt)?.sub === user.id) this.jwt = { token: jwt, exp: jwtExpMs(jwt) };
    }
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

  /**
   * Current session from the server; `null` (revoked/expired) signs out locally. Network errors throw. Calls made while
   * one is in flight for the same session share it.
   */
  async getSession(): Promise<{ user: AuthUser; session: Record<string, unknown> } | null> {
    await this.loaded;
    if (!this.sessionToken) return null;
    return this.sharedSession(this.sessionToken);
  }

  private sharedSession(token: string): Promise<{ user: AuthUser; session: Record<string, unknown> } | null> {
    if (this.sessionInFlight?.token === token) return this.sessionInFlight.p;
    const p = this.fetchSession(token).finally(() => {
      if (this.sessionInFlight?.p === p) this.sessionInFlight = null;
    });
    this.sessionInFlight = { token, p };
    return p;
  }

  private async fetchSession(token: string): Promise<{ user: AuthUser; session: Record<string, unknown> } | null> {
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
    const fresh = () => (this.jwt && (this.jwt.exp === null ? false : this.jwt.exp - margin > this.now()) ? this.jwt.token : null);
    if (fresh()) return fresh();
    if (this.jwtInFlight) return this.jwtInFlight;
    // A `/get-session` in flight may bring one (`set-auth-jwt`): wait for it rather than asking `/token` too.
    const pending = this.sessionInFlight;
    if (pending && pending.token === this.sessionToken) {
      await pending.p.catch(() => undefined);
      if (!this.sessionToken) return null;
      if (fresh()) return fresh();
      if (this.jwtInFlight) return this.jwtInFlight;
    }
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
