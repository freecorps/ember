import { DurableObject } from "cloudflare:workers";
import { emberAuth } from "../src/worker.ts";
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

/** Plain SQLite DO for the adapter conformance suite (no Better Auth instance, no boot DDL). */
export class SqlBox extends DurableObject {}

export default {
  async fetch(request: Request) {
    const handled = await auth.fetch(request);
    if (handled) return handled;
    const url = new URL(request.url);
    if (url.pathname === "/whoami") {
      const r = await auth.verifyRequestDetailed(request, { sensitive: url.searchParams.has("sensitive") });
      return Response.json(r, { status: r ? 200 : 401 });
    }
    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler;
