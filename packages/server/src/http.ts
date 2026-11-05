// HTTP routes (`ember/http.ts`, and components' `http`): `httpRouter()` maps method + path (exact) or path prefix
// to an `httpAction`. The Worker tries them after its own endpoints (/ws, /api/query|mutation|action|storage|
// _ember, /health) and before the auth routes and the 404. An httpAction runs in the Worker with an ActionCtx on
// the `global:main` shard unless the route says otherwise (`shard`), or the handler picks one with `ctx.onShard`.

import type { RegisteredHttpAction } from "./functions.ts";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";
export const HTTP_METHODS: readonly HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"];

export interface HttpRoute {
  /** Exact path (`/webhooks/email`). */
  path?: string;
  /** Any path under this prefix (ends with "/"). */
  pathPrefix?: string;
  method: HttpMethod;
  handler: RegisteredHttpAction;
  /** Shard the ActionCtx targets: a name, or a function of the request (default "global:main"). */
  shard?: string | ((request: Request) => string);
}

/** Paths the Worker owns: routes may not shadow them. */
export const RESERVED_HTTP_PATHS = ["/ws", "/health", "/api/query", "/api/mutation", "/api/action", "/api/storage/", "/api/_ember/", "/api/auth/"];

/**
 * Throws when a route path (or prefix) lies inside one of the Worker's own endpoints (it could never be reached:
 * the Worker serves those first). A broader prefix such as "/" is fine: it only gets what the Worker does not own.
 */
export function assertNotReserved(p: string): void {
  if (RESERVED_HTTP_PATHS.some((x) => (x.endsWith("/") ? p.startsWith(x) || p === x.slice(0, -1) : p === x || p.startsWith(x + "/")))) {
    throw new Error(`http route ${p} is reserved by Ember`);
  }
}

export class HttpRouter {
  readonly routes: HttpRoute[] = [];

  route(r: HttpRoute): this {
    if (!r || typeof r !== "object") throw new Error("http.route(): expected { path | pathPrefix, method, handler }");
    if ((r.path === undefined) === (r.pathPrefix === undefined)) throw new Error("http.route(): exactly one of path / pathPrefix");
    const p = (r.path ?? r.pathPrefix)!;
    if (typeof p !== "string" || !p.startsWith("/")) throw new Error(`http.route(): path must start with "/" (got ${JSON.stringify(p)})`);
    if (r.pathPrefix !== undefined && !r.pathPrefix.endsWith("/")) throw new Error(`http.route(): pathPrefix must end with "/" (got ${r.pathPrefix})`);
    if (!HTTP_METHODS.includes(r.method)) throw new Error(`http.route(): unknown method ${r.method}`);
    if (r.handler?.type !== "httpAction") throw new Error("http.route(): handler must be an httpAction(...)");
    assertNotReserved(p);
    if (this.routes.some((x) => x.method === r.method && x.path === r.path && x.pathPrefix === r.pathPrefix)) {
      throw new Error(`http.route(): ${r.method} ${p} is defined twice`);
    }
    this.routes.push(r);
    return this;
  }
}

export const httpRouter = (): HttpRouter => new HttpRouter();

/**
 * The route for a request: exact paths first, then the longest matching prefix. A HEAD request also matches GET
 * routes, but at the same path (or prefix length) an explicit HEAD route wins over the GET fallback, whatever
 * the registration order. `methodMismatch` when the path exists with other methods (405).
 */
export function matchRoute<R extends Pick<HttpRoute, "path" | "pathPrefix" | "method">>(
  routes: readonly R[],
  method: string,
  path: string,
): { route: R } | { methodMismatch: true } | null {
  const m = method.toUpperCase();
  /** 2 = same method, 1 = GET serving a HEAD, 0 = no. */
  const fit = (r: R) => (r.method === m ? 2 : m === "HEAD" && r.method === "GET" ? 1 : 0);
  let pathHit = false;
  let exact: R | null = null;
  for (const r of routes) {
    if (r.path !== path) continue;
    pathHit = true;
    if (fit(r) > (exact ? fit(exact) : 0)) exact = r;
  }
  if (exact) return { route: exact };
  let best: R | null = null;
  for (const r of routes) {
    if (r.pathPrefix === undefined || !path.startsWith(r.pathPrefix)) continue;
    const f = fit(r);
    if (!f) {
      pathHit = true;
      continue;
    }
    const len = r.pathPrefix.length;
    const bestLen = best ? best.pathPrefix!.length : -1;
    if (len > bestLen || (len === bestLen && f > fit(best!))) best = r;
  }
  if (best) return { route: best };
  return pathHit ? { methodMismatch: true } : null;
}
