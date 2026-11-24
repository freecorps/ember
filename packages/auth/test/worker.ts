import { DurableObject, env } from "cloudflare:workers";
import { emberAuth } from "../src/worker.ts";
import { emberAuthLazy } from "../src/lazy.ts";
import { resolveAuthConfig } from "../src/define.ts";
import { authStaticSettings, staticSettingsOfResolved } from "../src/settings.ts";
import config from "./auth.config.ts";
import passwordsConfig from "./passwords.config.ts";

export const userEvents: { event: string; email: unknown }[] = [];

export const auth = emberAuth(config, {
  project: "acme",
  // Any password hash/verify not precomputed by the Worker throws inside the DO.
  strictHashing: true,
  onUserChange(event, user) {
    userEvents.push({ event, email: user.email });
  },
});

export const Auth = auth.Auth;

/** No profile sync (an app without `users:sync`: the CLI wires no `onUserChange`): no user journal triggers. */
export const noSyncAuth = emberAuth(config, { project: "acme", binding: "AUTH_NOSYNC" });
export const NoSyncAuth = noSyncAuth.Auth;

/** How many times the lazy variant loaded the full implementation (Better Auth + the config). */
export const lazyLoads = { impl: 0, config: 0 };

/**
 * The generated Worker's form (`emberAuthLazy`): the same config, its own Auth DO (`AUTH_LAZY`), and the static
 * settings the CLI would embed (this config is the function form, for which the CLI embeds none: resolved here with
 * the test env instead). Requests with `x-lazy: 1` go through it.
 */
export const knownStatic = staticSettingsOfResolved(resolveAuthConfig(config, env as unknown as Record<string, unknown>));
export const lazyAuth = emberAuthLazy(
  async () => (lazyLoads.config++, { default: config }),
  { project: "acme", strictHashing: true, binding: "AUTH_LAZY", static: knownStatic },
  async () => (lazyLoads.impl++, import("../src/worker.ts")),
);
export const LazyAuth = lazyAuth.Auth;

/** What the passwords Auth DO's profile hook received (hidden fields must not be there). */
export const pwUserEvents: { event: string; user: Record<string, unknown> }[] = [];

/**
 * Password endpoints of plugins (`passwords.config.ts`: username, phone number, a third-party plugin declared through
 * `ember.passwordRules`), in their own Auth DO (`AUTH_PW`) with `strictHashing`. Requests with `x-auth: pw` go through
 * `emberAuth`, with `x-auth: pw-lazy` through `emberAuthLazy` with the static settings the CLI would embed (same DO).
 */
export const pwAuth = emberAuth(passwordsConfig, {
  project: "pw",
  binding: "AUTH_PW",
  strictHashing: true,
  onUserChange(event, user) {
    pwUserEvents.push({ event, user });
  },
});
export const PwAuth = pwAuth.Auth;
export const pwStatic = authStaticSettings(passwordsConfig);
export const pwLazy = emberAuthLazy(async () => ({ default: passwordsConfig }), { project: "pw", strictHashing: true, binding: "AUTH_PW", static: pwStatic });

/**
 * Plain SQLite DO for the adapter conformance suite (no Better Auth instance, no boot DDL), and where the config's
 * session hook records what it saw (`record`, `entries`).
 */
export class SqlBox extends DurableObject {
  private seen: string[] = [];
  async record(entry: string): Promise<void> {
    this.seen.push(entry);
  }
  async entries(): Promise<string[]> {
    return [...this.seen];
  }
}

export default {
  async fetch(request: Request) {
    const which = request.headers.get("x-auth");
    const a = which === "pw" ? pwAuth : which === "pw-lazy" ? pwLazy : request.headers.get("x-lazy") === "1" ? lazyAuth : auth;
    const handled = await a.fetch(request);
    if (handled) return handled;
    const url = new URL(request.url);
    if (url.pathname === "/whoami") {
      const r = await a.verifyRequestDetailed(request, { sensitive: url.searchParams.has("sensitive") });
      return Response.json(r, { status: r ? 200 : 401 });
    }
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler;
