// Small HTTP helpers shared by the dashboard Worker modules.

export const API_HEADERS = {
  "content-type": "application/json",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
} as const;

export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: API_HEADERS });

export const err = (status: number, code: string, message: string, data?: Record<string, unknown>) =>
  json({ ok: false, error: { code, message, ...(data ? { data } : {}) } }, status);

/** Constant-time comparison (length leaks only through the loop bound, which is the longer of the two). */
export function sameSecret(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

/** Request bodies of the dashboard API are small JSON objects. */
export const MAX_BODY_BYTES = 64 * 1024;

export async function readJsonObject(request: Request): Promise<Record<string, unknown> | Response> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return err(413, "too_large", `request body over ${MAX_BODY_BYTES} bytes`);
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return err(413, "too_large", `request body over ${MAX_BODY_BYTES} bytes`);
  try {
    const v: unknown = text ? JSON.parse(text) : {};
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    return err(400, "bad_request", "body must be a JSON object");
  }
}
