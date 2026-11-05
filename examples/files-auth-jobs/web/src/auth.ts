// A small Better Auth client for the browser (no React, no DOM types: the tests run it too).
//
// Ember's Auth Durable Object always runs Better Auth's `bearer()` and `jwt()` plugins, so:
//   1. sign-up / sign-in answer with the session token in the `set-auth-token` header; we keep it in `storage`;
//   2. calls to /api/auth/* send it as `Authorization: Bearer <session token>`;
//   3. GET /api/auth/token swaps it for a short JWT (5 minutes), which is what `EmberClient` sends to the Worker.
// A 401 from /token means the session ended (signed out elsewhere, expired): we forget it.

type Storage = { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void };

export type AuthOptions = {
  /** Where the Worker is (the page's own origin; Vite proxies /api in development). */
  baseUrl: string;
  storage: Storage;
  fetch?: typeof fetch;
  /** Browsers send their own `Origin` header; only a non-browser caller (the tests) needs to set one. */
  origin?: string;
};

const KEY = "ember.session";
const REFRESH_MARGIN_MS = 30_000;

export function createAuth(opts: AuthOptions) {
  const doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const listeners = new Set<() => void>();
  let session = opts.storage.getItem(KEY);
  let jwt: { token: string; expiresAt: number } | null = null;

  const set = (token: string | null) => {
    const changed = token !== session;
    session = token;
    jwt = null;
    if (token) opts.storage.setItem(KEY, token);
    else opts.storage.removeItem(KEY);
    if (changed) for (const l of [...listeners]) l();
  };

  async function call(path: string, body?: unknown) {
    const res = await doFetch(`${opts.baseUrl}/api/auth${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(session ? { authorization: `Bearer ${session}` } : {}),
        ...(opts.origin ? { origin: opts.origin } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = (await res.json().catch(() => null)) as { message?: string; token?: string } | null;
    if (!res.ok) throw Object.assign(new Error(data?.message ?? `Request failed (${res.status})`), { status: res.status });
    return { data, token: res.headers.get("set-auth-token") };
  }

  const enter = async (path: string, body: object) => {
    const { token } = await call(path, body);
    if (token) set(token); // no token: the account needs email verification first
  };

  return {
    /** Signed in = we hold a session token (the server may still have ended it: `fetchToken` finds out). */
    get signedIn() {
      return session !== null;
    },
    /** For `useSyncExternalStore`, and for telling `EmberClient` to re-authenticate. */
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    signUp: (input: { email: string; password: string; name: string }) => enter("/sign-up/email", input),
    signIn: (input: { email: string; password: string }) => enter("/sign-in/email", input),
    async signOut() {
      if (session) await call("/sign-out", {}).catch(() => undefined);
      set(null);
    },
    /** The token source for `new EmberClient({ auth })`: a fresh JWT, or null when signed out. */
    async fetchToken(): Promise<string | null> {
      if (!session) return null;
      if (jwt && jwt.expiresAt - REFRESH_MARGIN_MS > Date.now()) return jwt.token;
      const used = session;
      try {
        const { data } = await call("/token");
        const token = data?.token;
        if (!token) return null;
        const exp = (JSON.parse(atob(token.split(".")[1]!.replaceAll("-", "+").replaceAll("_", "/"))) as { exp: number }).exp;
        if (used === session) jwt = { token, expiresAt: exp * 1000 };
        return token;
      } catch (e) {
        if ((e as { status?: number }).status === 401 && used === session) set(null);
        return null;
      }
    },
  };
}

export type Auth = ReturnType<typeof createAuth>;
