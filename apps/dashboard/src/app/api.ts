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

async function failure(res: Response): Promise<ApiError> {
  const parsed = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string; data?: Record<string, unknown> } } | null;
  return new ApiError(res.status, parsed?.error?.code ?? "error", parsed?.error?.message ?? (res.statusText || `HTTP ${res.status}`), parsed?.error?.data);
}

const authHeaders = (): Record<string, string> => (token ? { authorization: `Bearer ${token}` } : {});

export const api = {
  get: <T>(path: string) => call<T>("GET", path),
  post: <T>(path: string, body: unknown) => call<T>("POST", path, body),
  /** A long response read as it arrives (live logs: NDJSON). Abort with the signal. */
  async stream(path: string, signal: AbortSignal): Promise<ReadableStreamDefaultReader<Uint8Array>> {
    const res = await fetch(path, { headers: authHeaders(), credentials: "same-origin", signal });
    if (!res.ok || !res.body) throw await failure(res);
    return res.body.getReader();
  },
  /** Bytes of a file and the type the project recorded for it (the response itself is always octet-stream). */
  async blob(path: string): Promise<{ blob: Blob; type: string }> {
    const res = await fetch(path, { headers: authHeaders(), credentials: "same-origin" });
    if (!res.ok) throw await failure(res);
    return { blob: await res.blob(), type: res.headers.get("x-ember-content-type") ?? "" };
  },
  /** A file upload: raw bytes, the parameters in the query (a write: CSRF token included). */
  async upload<T>(path: string, body: Blob): Promise<T> {
    let res: Response;
    try {
      res = await fetch(path, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/octet-stream", ...(csrf ? { "x-ember-csrf": csrf } : {}) },
        credentials: "same-origin",
        body,
      });
    } catch (e) {
      throw new ApiError(0, "network", `could not reach the dashboard (${(e as Error).message})`);
    }
    if (!res.ok) throw await failure(res);
    return (await res.json()) as T;
  },
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
