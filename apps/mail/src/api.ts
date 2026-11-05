// HTTP API helpers: API key auth (Resend-style bearer keys), JSON responses and errors in Resend's shape.

export type Permission = "full_access" | "sending_access" | "inbox";
export type Principal = { keyId: string | null; permission: Permission; project: string; domain?: string };

export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly errorName: string,
    message: string,
  ) {
    super(message);
  }
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

export function errorResponse(e: unknown): Response {
  if (e instanceof ApiError) return json({ statusCode: e.statusCode, name: e.errorName, message: e.message }, e.statusCode);
  const code = (e as { code?: string })?.code;
  const message = (e as Error)?.message ?? String(e);
  if (code === "ValidationError" || code === "NotFound") return json({ statusCode: code === "NotFound" ? 404 : 422, name: code === "NotFound" ? "not_found" : "validation_error", message }, code === "NotFound" ? 404 : 422);
  if (code === "RateLimited" || /rate limit/.test(message)) return json({ statusCode: 429, name: "rate_limit_exceeded", message }, 429);
  if (/not found/i.test(message)) return json({ statusCode: 404, name: "not_found", message }, 404);
  if (/^(Invalid|.*is required|.*at most|.*must be|header )/.test(message)) return json({ statusCode: 422, name: "validation_error", message }, 422);
  console.error(`mail api: ${message}`);
  return json({ statusCode: 500, name: "application_error", message: "internal error" }, 500);
}

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** `em_<8 hex>_<32 base64url>`: the prefix is shown in lists, the whole token is only ever hashed. */
export function newToken(): { token: string; prefix: string } {
  const r = crypto.getRandomValues(new Uint8Array(28));
  const hex = [...r.subarray(0, 4)].map((b) => b.toString(16).padStart(2, "0")).join("");
  let b64 = btoa(String.fromCharCode(...r.subarray(4)));
  b64 = b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return { token: `em_${hex}_${b64}`, prefix: `em_${hex}` };
}

function sameSecret(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/** Resolves the caller: an API key, or the Worker's admin token (bootstrap: creates the first keys). */
export async function authenticate(
  request: Request,
  env: Record<string, unknown>,
  lookup: (hash: string) => Promise<{ id: string; permission: string; project: string; domain?: string } | null>,
): Promise<Principal> {
  const h = request.headers.get("authorization") ?? "";
  const token = h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : "";
  if (!token) throw new ApiError(401, "missing_api_key", "Missing API key in the authorization header");
  const admin = typeof env.EMBER_ADMIN_TOKEN === "string" ? env.EMBER_ADMIN_TOKEN : "";
  if (admin && sameSecret(token, admin)) return { keyId: null, permission: "full_access", project: "default" };
  if (!token.startsWith("em_")) throw new ApiError(401, "invalid_api_key", "API key is invalid");
  const k = await lookup(await sha256Hex(token));
  if (!k) throw new ApiError(401, "invalid_api_key", "API key is invalid");
  return { keyId: k.id, permission: k.permission as Permission, project: k.project, ...(k.domain ? { domain: k.domain } : {}) };
}

export function need(p: Principal, ...allowed: Permission[]): void {
  if (p.permission === "full_access" || allowed.includes(p.permission)) return;
  throw new ApiError(403, "restricted_api_key", `This API key is restricted (${p.permission})`);
}

export async function body<T = Record<string, unknown>>(request: Request): Promise<T> {
  try {
    const b = await request.json();
    if (!b || typeof b !== "object") throw new Error();
    return b as T;
  } catch {
    throw new ApiError(422, "validation_error", "The body must be JSON");
  }
}

/** `scheduled_at`: ISO 8601, or epoch ms/seconds. */
export function parseWhen(x: unknown): number | undefined {
  if (x === undefined || x === null || x === "") return undefined;
  if (typeof x === "number") return x < 1e12 ? x * 1000 : x;
  const t = Date.parse(String(x));
  if (!Number.isFinite(t)) throw new ApiError(422, "validation_error", "scheduled_at must be an ISO 8601 date");
  return t;
}

export const iso = (ms: number | undefined | null) => (ms ? new Date(ms).toISOString() : null);
