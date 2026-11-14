import { DurableObject, env } from "cloudflare:workers";
import { emberAuth } from "../src/worker.ts";
import { emberAuthLazy } from "../src/lazy.ts";
import { resolveAuthConfig } from "../src/define.ts";
import { staticSettingsOfResolved } from "../src/settings.ts";
import config from "./auth.config.ts";

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
    const a = request.headers.get("x-lazy") === "1" ? lazyAuth : auth;
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
