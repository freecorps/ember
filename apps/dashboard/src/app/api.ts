// API client of the SPA. The dashboard token (token sign-in) lives only in this module's memory: never in storage, a
// URL or a log, so a reload asks for it again. Cloudflare Access users need none (the Access cookie rides along).
// Writes send the CSRF token `/api/me` returned (security.ts on the Worker).

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly data: Record<string, unknown> | undefined;
  constructor(status: number, code: string, message: string, data?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

let token: string | null = null;
let csrf: string | null = null;

export const session = {
  setToken(t: string | null) {
    token = t && t.trim() ? t.trim() : null;
    csrf = null;
  },
  hasToken: () => token !== null,
  setCsrf(c: string | null) {
    csrf = c;
  },
};

type Json = Record<string, unknown>;

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (method !== "GET") {
    headers["content-type"] = "application/json";
    if (csrf) headers["x-ember-csrf"] = csrf;
  }
  let res: Response;
  try {
    res = await fetch(path, { method, headers, credentials: "same-origin", ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  } catch (e) {
    throw new ApiError(0, "network", `could not reach the dashboard (${(e as Error).message})`);
  }
  const parsed = (await res.json().catch(() => null)) as Json | null;
  const error = parsed && typeof parsed.error === "object" && parsed.error ? (parsed.error as { code?: unknown; message?: unknown; data?: unknown }) : null;
  if (!res.ok || parsed?.ok === false || !parsed) {
    throw new ApiError(
      res.status,
      typeof error?.code === "string" ? error.code : "error",
      typeof error?.message === "string" ? error.message : res.statusText || `HTTP ${res.status}`,
      error?.data && typeof error.data === "object" ? (error.data as Record<string, unknown>) : undefined,
    );
  }
  return parsed as T;
}

export const api = {
  get: <T>(path: string) => call<T>("GET", path),
  post: <T>(path: string, body: unknown) => call<T>("POST", path, body),
};

/** `/api/x?a=1&b=2` with encoded values; undefined/null/"" are left out. */
export function path(base: string, params: Record<string, string | number | null | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  const s = q.toString();
  return s ? `${base}?${s}` : base;
}

export interface Me {
  via: "access" | "token";
  who: string | null;
  actor: string;
  role: "read" | "admin";
  csrf: string | null;
  metrics: boolean;
  access: boolean;
  protectedEnvs: string[];
}
