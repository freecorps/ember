import { EmberClient } from "@freecorps/ember-client";
import { createAuth } from "./auth";

// Better Auth lives in the same Worker as the functions, under /api/auth, so the page uses one origin
// (Vite's proxy in development). The session token goes to localStorage; see auth.ts.
export const auth = createAuth({ baseUrl: window.location.origin, storage: window.localStorage });

export const client = new EmberClient({
  url: window.location.origin,
  defaultShard: "global:main",
  auth: () => auth.fetchToken(),
});

// Signing in or out re-authenticates the open connection in place: every live query re-runs as the new identity.
auth.subscribe(() => client.setAuth(() => auth.fetchToken()));
