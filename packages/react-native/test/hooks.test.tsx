import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { FakeEmberServer } from "@freecorps/ember-client/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmberProvider, createEmberAuthClient, createEmberClient, memoryTokenStore, useEmberAuthToken, useQuery, type EmberAuthClient } from "../src/index.ts";

afterEach(() => cleanup());

/** Auth endpoints whose `/token` answers the fake Ember server's token format (`user:<subject>`). */
function authFetch() {
  let session: string | null = null;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const json = (data: unknown, h: Record<string, string> = {}) => new Response(JSON.stringify(data), { status: 200, headers: h });
    if (path.endsWith("/sign-in/email")) {
      session = "s1";
      return json({ user: { id: "ada", email: "ada@x.dev" } }, { "set-auth-token": "s1" });
    }
    if (path.endsWith("/sign-out")) return json({ success: true });
    if (path.endsWith("/token")) {
      const bearer = (init?.headers as Record<string, string>).authorization;
      return bearer === `Bearer ${session}` ? json({ token: "user:ada" }) : new Response("{}", { status: 401 });
    }
    if (path.endsWith("/get-session")) return json(session ? { user: { id: "ada", email: "ada@x.dev" }, session: {} } : null);
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
}

function Who({ auth }: { auth: EmberAuthClient }) {
  const { status, signIn, signOut } = useEmberAuthToken(auth);
  const me = useQuery("users:me", {});
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="me">{me === undefined ? "loading" : String(me)}</span>
      <button onClick={() => void signIn({ email: "ada@x.dev", password: "pw" })}>in</button>
      <button onClick={() => void signOut()}>out</button>
    </div>
  );
}

describe("useEmberAuthToken", () => {
  it("signs in/out and the live query re-runs under the new identity", async () => {
    const server = new FakeEmberServer({ queries: { "users:me": (_db, _a, ctx) => ctx.identity?.subject ?? "anonymous" } });
    const auth = createEmberAuthClient({ url: "https://ember.test", fetch: authFetch(), tokenStore: memoryTokenStore() });
    const client = createEmberClient({
      url: "https://ember.test",
      auth,
      WebSocket: server.WebSocket,
      fetch: server.fetch,
      connectivity: null,
      storage: "memory",
      heartbeat: false,
      defaultShard: "global:main",
    });
    render(
      <EmberProvider client={client}>
        <Who auth={auth} />
      </EmberProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("me").textContent).toBe("anonymous"));
    expect(screen.getByTestId("status").textContent).toBe("signedOut");

    act(() => screen.getByText("in").click());
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("signedIn"));
    await waitFor(() => expect(screen.getByTestId("me").textContent).toBe("ada"));
    expect(server.open()).toHaveLength(1); // re-authenticated in place

    act(() => screen.getByText("out").click());
    await waitFor(() => expect(screen.getByTestId("me").textContent).toBe("anonymous"));
    expect(screen.getByTestId("status").textContent).toBe("signedOut");
    client.close();
  });

  it("bindInitially installs the fetcher for a client created without auth", async () => {
    const auth = createEmberAuthClient({ url: "https://ember.test", fetch: authFetch(), tokenStore: memoryTokenStore("s1") });
    const server = new FakeEmberServer({ queries: { "users:me": (_db, _a, ctx) => ctx.identity?.subject ?? "anonymous" } });
    const client = createEmberClient({ url: "https://ember.test", WebSocket: server.WebSocket, fetch: server.fetch, connectivity: null, storage: "memory", heartbeat: false });
    const spy = vi.spyOn(client, "setAuth");
    function Bound() {
      useEmberAuthToken(auth, { bindInitially: true });
      return null;
    }
    render(
      <EmberProvider client={client}>
        <Bound />
      </EmberProvider>,
    );
    expect(spy).toHaveBeenCalledWith(auth.fetchToken);
    client.close();
  });
});
