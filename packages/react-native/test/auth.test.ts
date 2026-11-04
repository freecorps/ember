import { describe, expect, it, vi } from "vitest";
import { AuthError, bindEmberAuth, createEmberAuthClient, secureTokenStore } from "../src/index.ts";
import { fakeSecureStore } from "./fakes.ts";

const b64url = (o: unknown) => btoa(JSON.stringify(o)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const makeJwt = (sub: string, expSec: number) => `${b64url({ alg: "EdDSA" })}.${b64url({ sub, exp: expSec })}.sig`;

/** A tiny Better Auth (bearer + jwt plugins) over fetch. */
function fakeAuthServer(opts: { now: () => number }) {
  const users = new Map<string, { id: string; email: string; name: string; password: string }>();
  const sessions = new Map<string, string>(); // session token -> user id
  const calls: Array<{ method: string; path: string; headers: Record<string, string>; body: any }> = [];
  let n = 0;
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const path = url.pathname.replace("/api/auth", "");
    calls.push({ method: init?.method ?? "GET", path, headers, body });
    const bearer = headers.authorization?.replace(/^Bearer /, "");
    const userId = bearer ? sessions.get(bearer) : undefined;
    const json = (status: number, data: unknown, extra: Record<string, string> = {}) =>
      new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...extra } });
    if (init?.method === "POST" && headers.origin !== "https://app.example.com") return json(403, { code: "INVALID_ORIGIN", message: "Invalid origin" });
    switch (path) {
      case "/sign-up/email": {
        const id = `u${++n}`;
        users.set(body.email, { id, email: body.email, name: body.name, password: body.password });
        const token = `sess-${id}-${n}`;
        sessions.set(token, id);
        return json(200, { token, user: { id, email: body.email, name: body.name } }, { "set-auth-token": token });
      }
      case "/sign-in/email": {
        const u = users.get(body.email);
        if (!u || u.password !== body.password) return json(401, { code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password" });
        const token = `sess-${u.id}-${++n}`;
        sessions.set(token, u.id);
        return json(200, { redirect: false, token, user: { id: u.id, email: u.email, name: u.name } }, { "set-auth-token": token });
      }
      case "/get-session": {
        if (!userId) return json(200, null);
        const u = [...users.values()].find((x) => x.id === userId)!;
        return json(200, { user: { id: u.id, email: u.email, name: u.name }, session: { userId } });
      }
      case "/token":
        if (!userId) return json(401, { code: "UNAUTHORIZED", message: "Unauthorized" });
        return json(200, { token: makeJwt(userId, Math.floor(opts.now() / 1000) + 300) });
      case "/sign-out":
        if (bearer) sessions.delete(bearer);
        return json(200, { success: true });
    }
    return json(404, { code: "NOT_FOUND", message: "?" });
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls, sessions, users };
}

function setup(store = fakeSecureStore()) {
  let clock = 1_800_000_000_000;
  const now = () => clock;
  const server = fakeAuthServer({ now });
  const make = () =>
    createEmberAuthClient({
      url: "https://app.example.com/",
      fetch: server.fetch,
      tokenStore: secureTokenStore({ secureStore: store }),
      now,
    });
  return { server, store, make, advance: (ms: number) => void (clock += ms) };
}

describe("EmberAuthClient", () => {
  it("signs up/in, keeps the session token in SecureStore and mints cached JWTs", async () => {
    const { server, store, make, advance } = setup();
    const auth = make();
    await auth.ready();
    expect(auth.getState()).toEqual({ status: "signedOut", user: null });
    expect(await auth.fetchToken()).toBeNull();

    const changes = vi.fn();
    auth.onIdentityChange(changes);
    const user = await auth.signUpEmail({ email: "ada@x.dev", password: "pw-123456", name: "Ada" });
    expect(user).toMatchObject({ email: "ada@x.dev" });
    expect(auth.getState()).toMatchObject({ status: "signedIn", user: { id: "u1" } });
    expect(store.map.get("ember.session")).toBe([...server.sessions.keys()][0]);
    expect(changes).toHaveBeenCalledTimes(1);
    const signUpCall = server.calls.find((c) => c.path === "/sign-up/email")!;
    expect(signUpCall.headers.origin).toBe("https://app.example.com");

    const [a, b] = await Promise.all([auth.fetchToken(), auth.fetchToken()]);
    expect(a).toBe(b);
    expect(server.calls.filter((c) => c.path === "/token")).toHaveLength(1);
    expect(server.calls.find((c) => c.path === "/token")!.headers.authorization).toMatch(/^Bearer sess-/);
    // Cached until 30 s before exp (300 s).
    advance(260_000);
    expect(await auth.fetchToken()).toBe(a);
    advance(20_000);
    expect(await auth.fetchToken()).not.toBe(a);
    expect(server.calls.filter((c) => c.path === "/token")).toHaveLength(2);
  });

  it("restores the session after a restart and validates it", async () => {
    const { store, make } = setup();
    const first = make();
    await first.signUpEmail({ email: "bo@x.dev", password: "pw-123456", name: "Bo" });

    const second = make();
    const states: string[] = [];
    second.subscribe(() => states.push(second.getState().status + (second.getState().user ? "+user" : "")));
    const changes = vi.fn();
    second.onIdentityChange(changes);
    await second.ready();
    expect(second.getState().status).toBe("signedIn");
    await vi.waitFor(() => expect(second.getState().user).toMatchObject({ email: "bo@x.dev" }));
    expect(states).toEqual(["signedIn", "signedIn+user"]);
    expect(changes).not.toHaveBeenCalled();
    expect(store.map.size).toBe(1);
  });

  it("a revoked session signs out locally (get-session null / token 401)", async () => {
    const { server, store, make } = setup();
    const auth = make();
    await auth.signUpEmail({ email: "cy@x.dev", password: "pw-123456", name: "Cy" });
    const changes = vi.fn();
    auth.onIdentityChange(changes);
    server.sessions.clear(); // revoked elsewhere
    expect(await auth.fetchToken()).toBeNull();
    expect(auth.getState().status).toBe("signedOut");
    expect(store.map.size).toBe(0);
    expect(changes).toHaveBeenCalledTimes(1);

    await auth.signInEmail({ email: "cy@x.dev", password: "pw-123456" });
    server.sessions.clear();
    expect(await auth.getSession()).toBeNull();
    expect(auth.getState().status).toBe("signedOut");
  });

  it("sign-in errors are AuthErrors and do not change the state", async () => {
    const { make } = setup();
    const auth = make();
    const err = await auth.signInEmail({ email: "nobody@x.dev", password: "x" }).catch((e) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect(err).toMatchObject({ status: 401, code: "INVALID_EMAIL_OR_PASSWORD" });
    expect(auth.getState().status).toBe("signedOut");
  });

  it("sign-out revokes on the server and clears the store; bindEmberAuth re-auths the client", async () => {
    const { server, store, make } = setup();
    const auth = make();
    const client = { setAuth: vi.fn() };
    const unbind = bindEmberAuth(client, auth);
    await auth.ready();
    expect(client.setAuth).not.toHaveBeenCalled();
    await auth.signUpEmail({ email: "di@x.dev", password: "pw-123456", name: "Di" });
    expect(client.setAuth).toHaveBeenCalledTimes(1);
    expect(client.setAuth).toHaveBeenLastCalledWith(auth.fetchToken);
    await auth.signOut();
    expect(server.sessions.size).toBe(0);
    expect(store.map.size).toBe(0);
    expect(client.setAuth).toHaveBeenCalledTimes(2);
    unbind();
    await auth.signInEmail({ email: "di@x.dev", password: "pw-123456" });
    expect(client.setAuth).toHaveBeenCalledTimes(2);

    const initial = { setAuth: vi.fn() };
    bindEmberAuth(initial, auth, { initial: true });
    expect(initial.setAuth).toHaveBeenCalledTimes(1);
  });
});
