// Minimal Cloudflare REST client (raw API, no wrangler; PLAN D5, remote spike R1/R2). Retries 429/5xx with backoff.

import { execFileSync } from "node:child_process";

export const CF_API = "https://api.cloudflare.com/client/v4";

export interface CfResponse<T = any> {
  status: number;
  success: boolean;
  result: T;
  errors: Array<{ code: number; message: string }>;
  messages?: unknown[];
}

export class CloudflareApiError extends Error {
  override name = "CloudflareApiError";
  readonly status: number;
  readonly errors: Array<{ code: number; message: string }>;
  readonly request: string;
  constructor(request: string, status: number, errors: Array<{ code: number; message: string }>) {
    super(`${request} → ${status}: ${errors.map((e) => `[${e.code}] ${e.message}`).join("; ") || "request failed"}${hint(errors)}`);
    this.request = request;
    this.status = status;
    this.errors = errors;
  }
  has(code: number): boolean {
    return this.errors.some((e) => e.code === code);
  }
}

/** Known error codes from the remote spike (docs/spikes/remote/RESULTS.md R1/R2). */
function hint(errors: Array<{ code: number }>): string {
  const codes = new Set(errors.map((e) => e.code));
  if (codes.has(100400)) return "\n  hint: `exports` and `migrations` are mutually exclusive (ember only sends `exports`).";
  if (codes.has(100402)) return "\n  hint: a provisioned Durable Object class is missing from `exports` (every class must stay declared).";
  if (codes.has(100405)) return "\n  hint: a gradual deployment needs identical `exports` in every version; deploy the exports change at 100% first.";
  if (codes.has(10211)) return "\n  hint: versions cannot carry `migrations`; ember uses `exports` instead.";
  return "";
}

export interface CfClientOptions {
  accountId: string;
  token: string;
  fetch?: typeof fetch;
  /** Retries for 429/5xx (default 3). */
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class CfClient {
  readonly accountId: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly retries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(o: CfClientOptions) {
    this.accountId = o.accountId;
    this.token = o.token;
    this.fetchImpl = o.fetch ?? fetch;
    this.retries = o.retries ?? 3;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** `path` is relative to /accounts/{id} unless it starts with "/zones" or "/user". */
  async request<T = any>(method: string, path: string, body?: unknown): Promise<CfResponse<T>> {
    const url = `${CF_API}${/^\/(zones|user)\b/.test(path) ? "" : `/accounts/${this.accountId}`}${path}`;
    const label = `${method} ${path}`;
    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = { authorization: `Bearer ${this.token}` };
      let payload: BodyInit | undefined;
      if (body instanceof FormData) payload = body;
      else if (body !== undefined) {
        payload = JSON.stringify(body);
        headers["content-type"] = "application/json";
      }
      let res: Response;
      try {
        res = await this.fetchImpl(url, { method, headers, ...(payload === undefined ? {} : { body: payload }) });
      } catch (e) {
        if (attempt < this.retries) {
          await this.sleep(backoff(attempt));
          continue;
        }
        throw new Error(`${label}: ${(e as Error).message}`);
      }
      if ((res.status === 429 || res.status >= 500) && attempt < this.retries) {
        const retryAfter = Number(res.headers.get("retry-after"));
        await this.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff(attempt));
        continue;
      }
      const text = await res.text();
      let json: any;
      try {
        json = JSON.parse(text);
      } catch {
        json = { success: false, errors: [{ code: 0, message: text.slice(0, 500) }] };
      }
      return { status: res.status, success: !!json.success && res.ok, result: json.result, errors: json.errors ?? [], messages: json.messages };
    }
  }

  /** Like `request`, but throws CloudflareApiError when the call failed. */
  async call<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await this.request<T>(method, path, body);
    if (!r.success) throw new CloudflareApiError(`${method} ${path}`, r.status, r.errors);
    return r.result;
  }
}

const backoff = (attempt: number) => Math.min(8000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);

/** CLOUDFLARE_API_TOKEN, else the wrangler OAuth token (`npx wrangler auth token`). Never printed. */
export function resolveToken(env: NodeJS.ProcessEnv = process.env): string {
  const t = env.CLOUDFLARE_API_TOKEN ?? env.CF_API_TOKEN;
  if (t) return t;
  try {
    const out = execFileSync("npx", ["--yes", "wrangler", "auth", "token"], { stdio: ["ignore", "pipe", "ignore"], timeout: 60_000 }).toString();
    const token = out.trim().split("\n").pop()?.trim();
    if (token) return token;
  } catch {
    // fall through
  }
  throw new Error("No Cloudflare token: set CLOUDFLARE_API_TOKEN or log in with `npx wrangler login`.");
}
