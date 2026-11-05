import { EmberClient } from "@freecorps/ember-client";

// The page and the API share an origin (Vite's proxy in dev, the Worker's own origin once deployed).
// Without `ember/auth.config.ts` there is no sign-in: every caller is anonymous and picks a nickname.
export const client = new EmberClient({
  url: window.location.origin,
  defaultShard: "global:main",
});
