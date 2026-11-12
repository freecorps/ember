// HTTP routes (`ember/http.ts`, and components' `http`): `httpRouter()` maps method + path (exact) or path prefix
// to an `httpAction`. The Worker tries them after its own endpoints (/ws, /api/query|mutation|action|storage|
// _ember, /health) and before the auth routes and the 404. An httpAction runs in the Worker with an ActionCtx on
// the `global:main` shard unless the route says otherwise (`shard`), or the handler picks one with `ctx.onShard`.

import { encodeJson, decodeJson, v, validate, withDefaults, type GenericValidator, type ObjectShape, type ObjectType, type PropertyValidators, type Shape } from "@freecorps/ember-values";
import { errorInfo, isAppError, isEmberError, isErrorFactory, type AnyErrorFactory } from "./errors.ts";
import { IS_FUNCTION, type ActionCtx, type RegisteredHttpAction } from "./functions.ts";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD";
export const HTTP_METHODS: readonly HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"];

/** What a typed route declares (docs/design/dx.md §3.11): it goes to the manifest, the typed client and OpenAPI. */
export interface TypedRouteSpec {
  path: string;
  method: HttpMethod;
  params: ObjectShape;
  query: ObjectShape;
  body: Shape | null;
  returns: Shape | null;
  errors: string[];
  description?: string;
}

export interface HttpRoute {
  /** Exact path (`/webhooks/email`); with `:name` segments on a typed route (`/mailboxes/:id`). */
  path?: string;
  /** Any path under this prefix (ends with "/"). */
  pathPrefix?: string;
  method: HttpMethod;
  handler: RegisteredHttpAction;
  /** Shard the ActionCtx targets: a name, or a function of the request (default "global:main"). */
  shard?: string | ((request: Request) => string);
  /** Path segments when the path has `:params` (typed routes). */
  pattern?: readonly string[];
  /** Set on typed routes. */
  typed?: TypedRouteSpec;
}

type Body<B> = B extends GenericValidator ? NonNullable<B["type"]> : B extends PropertyValidators ? ObjectType<B> : undefined;
/** A typed route of any parameters (the runtime side). */
type AnyTypedRoute = TypedRoute<PropertyValidators, PropertyValidators, GenericValidator | PropertyValidators | undefined, unknown>;

/** A typed route: params, query and body are validated; the value it returns is the JSON response. */
export interface TypedRoute<P extends PropertyValidators, Q extends PropertyValidators, B extends GenericValidator | PropertyValidators | undefined, R> {
  method: HttpMethod;
  /** `/mailboxes/:id/messages`: each `:name` must be in `params`. */
  path: string;
  params?: P;
  query?: Q;
  body?: B;
  /** Validates the result (and documents it in OpenAPI). */
  returns?: GenericValidator;
  /** Application errors it may answer with (their `status`, default 400). */
  errors?: readonly AnyErrorFactory[];
  description?: string;
  shard?: string | ((request: Request) => string);
  handler: (ctx: ActionCtx, input: { params: ObjectType<P>; query: ObjectType<Q>; body: Body<B>; request: Request }) => R | Response | Promise<R | Response>;
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

const PARAM = /^:([A-Za-z_][A-Za-z0-9_]*)$/;

export class HttpRouter {
  readonly routes: HttpRoute[] = [];

  /** A raw route (`handler: httpAction(...)`), or a typed one (`handler: (ctx, { params, query, body }) => value`). */
  route(r: HttpRoute): this;
  route<P extends PropertyValidators = {}, Q extends PropertyValidators = {}, B extends GenericValidator | PropertyValidators | undefined = undefined, R = unknown>(r: TypedRoute<P, Q, B, R>): this;
  route(input: HttpRoute | AnyTypedRoute): this {
    const r = typeof input?.handler === "function" ? typedRoute(input as AnyTypedRoute) : (input as HttpRoute);
    if (!r || typeof r !== "object") throw new Error("http.route(): expected { path | pathPrefix, method, handler }");
    if ((r.path === undefined) === (r.pathPrefix === undefined)) throw new Error("http.route(): exactly one of path / pathPrefix");
    const p = (r.path ?? r.pathPrefix)!;
    if (typeof p !== "string" || !p.startsWith("/")) throw new Error(`http.route(): path must start with "/" (got ${JSON.stringify(p)})`);
    if (r.pathPrefix !== undefined && !r.pathPrefix.endsWith("/")) throw new Error(`http.route(): pathPrefix must end with "/" (got ${r.pathPrefix})`);
    if (!HTTP_METHODS.includes(r.method)) throw new Error(`http.route(): unknown method ${r.method}`);
    if (r.handler?.type !== "httpAction") throw new Error("http.route(): handler must be an httpAction(...)");
    assertNotReserved(p);
    if (r.path?.includes("/:") && !r.typed) throw new Error(`http.route(): ${r.path}: :params need a typed route (handler: (ctx, { params }) => ...)`);
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
  // Typed routes with :params, by segments (a literal segment beats a param at the same position: most literal wins).
  const segs = path.split("/");
  let pat: R | null = null;
  let patScore = -1;
  for (const r of routes) {
    const p = (r as { pattern?: readonly string[] }).pattern;
    if (!p || p.length !== segs.length || !p.every((x, i) => x.startsWith(":") ? segs[i] !== "" : x === segs[i])) continue;
    pathHit = true;
    const f = fit(r);
    if (!f) continue;
    const score = p.filter((x) => !x.startsWith(":")).length * 4 + f;
    if (score > patScore) {
      pat = r;
      patScore = score;
    }
  }
  if (pat) return { route: pat };
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

// ------------------------------------------------------------------------------------------------ typed routes

const objectOf = (p: PropertyValidators | undefined): ObjectShape => v.object(p ?? {}).shape as ObjectShape;
const isValidator = (x: unknown): x is GenericValidator => typeof x === "object" && x !== null && "shape" in x && typeof (x as GenericValidator).validate === "function";

/** Query string values are strings: numbers, booleans and int64 are parsed by their shape. */
function coerce(shape: Shape, raw: string): unknown {
  const s = shape.kind === "union" ? (shape.members.find((m) => m.kind !== "null") ?? shape) : shape;
  if (s.kind === "number") return raw.trim() === "" ? raw : Number(raw);
  if (s.kind === "int64") return /^-?\d+$/.test(raw) ? BigInt(raw) : raw;
  if (s.kind === "boolean") return raw === "true" ? true : raw === "false" ? false : raw;
  if (s.kind === "null") return raw === "null" ? null : raw;
  if (s.kind === "array") return raw.split(",").map((x) => coerce(s.item, x));
  return raw;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: { code: string; message: string; data?: unknown; kind?: "app" },
  ) {
    super(body.message);
  }
}

const json = (status: number, value: unknown) => new Response(encodeJson(value), { status, headers: { "content-type": "application/json" } });
const statusOfSystem = (code: string) => (code === "ValidationError" ? 400 : code === "Unauthenticated" ? 401 : code === "NotFound" ? 404 : 500);

function typedRoute(r: AnyTypedRoute): HttpRoute {
  if (typeof r.path !== "string" || !r.path.startsWith("/")) throw new Error(`http.route(): path must start with "/" (got ${JSON.stringify(r.path)})`);
  const segments = r.path.split("/");
  const names = segments.map((x) => PARAM.exec(x)?.[1]).filter((x): x is string => !!x);
  const params = objectOf(r.params);
  for (const n of names) if (!params.fields[n]) throw new Error(`http.route(): ${r.path}: :${n} is not in params`);
  for (const k of Object.keys(params.fields)) if (!names.includes(k)) throw new Error(`http.route(): ${r.path}: params.${k} is not a :${k} segment`);
  const query = objectOf(r.query);
  const body: Shape | null = r.body === undefined ? null : isValidator(r.body) ? r.body.shape : objectOf(r.body as PropertyValidators);
  if (body && (r.method === "GET" || r.method === "HEAD")) throw new Error(`http.route(): ${r.method} ${r.path} cannot take a body`);
  if (r.errors !== undefined && !r.errors.every(isErrorFactory)) throw new Error("http.route(): `errors` must be defineErrors() entries");
  const returns = r.returns?.shape ?? null;
  const spec: TypedRouteSpec = {
    path: r.path,
    method: r.method,
    params,
    query,
    body,
    returns,
    errors: (r.errors ?? []).map((e) => e.code),
    ...(r.description ? { description: r.description } : {}),
  };
  const invalid = (where: string, res: { path: string; message: string }) =>
    new HttpError(400, { code: "ValidationError", message: `Invalid ${where}: ${res.path}: ${res.message}`, data: { path: res.path, issues: [{ path: `${where}.${res.path}`, message: res.message }] } });
  const handler = async (ctx: ActionCtx, request: Request): Promise<Response> => {
    try {
      const url = new URL(request.url);
      const segs = url.pathname.split("/");
      const p: Record<string, unknown> = {};
      segments.forEach((x, i) => {
        const n = PARAM.exec(x)?.[1];
        if (n) p[n] = coerce(params.fields[n]!.shape, decodeURIComponent(segs[i] ?? ""));
      });
      const rp = validate(params, p);
      if (!rp.ok) throw invalid("params", rp);
      const q: Record<string, unknown> = {};
      for (const [k, f] of Object.entries(query.fields)) {
        const all = url.searchParams.getAll(k);
        if (all.length) q[k] = f.shape.kind === "array" && all.length > 1 ? all.map((x) => coerce((f.shape as { item: Shape }).item, x)) : coerce(f.shape, all[0]!);
      }
      const qv = withDefaults(query, q) as Record<string, unknown>;
      const rq = validate(query, qv);
      if (!rq.ok) throw invalid("query", rq);
      let b: unknown;
      if (body) {
        const text = await request.text();
        try {
          b = text ? decodeJson(text) : undefined;
        } catch {
          throw new HttpError(400, { code: "ValidationError", message: "body must be JSON" });
        }
        b = withDefaults(body, b);
        const rb = validate(body, b);
        if (!rb.ok) throw invalid("body", rb);
      }
      const out = await r.handler(ctx, { params: p, query: qv, body: b as never, request } as Parameters<AnyTypedRoute["handler"]>[1]);
      if (out instanceof Response) return out;
      const value = out === undefined ? null : out;
      if (returns) {
        const rr = validate(returns, value);
        if (!rr.ok) throw new HttpError(500, { code: "ValidationError", message: `Invalid return value of ${r.method} ${r.path}: ${rr.path}: ${rr.message}` });
      }
      return json(200, value);
    } catch (e) {
      if (e instanceof HttpError) return json(e.status, { error: e.body });
      if (isAppError(e)) return json((e as { status?: number }).status ?? 400, { error: errorInfo(e) });
      if (isEmberError(e) || (typeof (e as { code?: unknown })?.code === "string" && (e as { kind?: unknown }).kind !== undefined)) {
        const w = errorInfo(e);
        return json(statusOfSystem(w.code), { error: w });
      }
      throw e;
    }
  };
  const action: RegisteredHttpAction = Object.freeze({ [IS_FUNCTION]: true as const, type: "httpAction" as const, handler });
  const route: HttpRoute = { path: r.path, method: r.method, handler: action, typed: spec, ...(r.shard !== undefined ? { shard: r.shard } : {}) };
  if (names.length) route.pattern = segments;
  return route;
}
