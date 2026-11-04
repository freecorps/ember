import { exports } from "cloudflare:workers";

export const ORIGIN = "http://localhost:8787";
export const worker = (exports as unknown as { default: Fetcher }).default;
export const rnd = () => crypto.randomUUID().slice(0, 8);

/** Tiny cookie jar per "browser". */
export class Client {
  jar = new Map<string, string>();
  cookieHeader() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  async req(path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
    const headers = new Headers({ origin: ORIGIN, ...init.headers });
    if (this.jar.size && !headers.has("cookie")) headers.set("cookie", this.cookieHeader());
    if (init.body !== undefined) headers.set("content-type", "application/json");
    const res = await worker.fetch(`${ORIGIN}${path}`, {
      method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : null,
      redirect: "manual",
    });
    for (const sc of res.headers.getSetCookie()) {
      const [pair = "", ...attrs] = sc.split(";");
      const i = pair.indexOf("=");
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      const expired = attrs.some((a) => /max-age=0/i.test(a.trim())) || value === "";
      if (expired) this.jar.delete(name);
      else this.jar.set(name, value);
    }
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, json, headers: res.headers, text };
  }
}
