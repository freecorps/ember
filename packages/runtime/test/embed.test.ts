// The runtime embedded in an existing Worker under a path (Brigade RFC 0016 gap G4): `basePath` mounts every route
// there, the rest of the host Worker's paths are not the runtime's, and signed file URLs carry the prefix.
import { createExecutionContext, env } from "cloudflare:test";
import { afterAll, describe, expect, it } from "vitest";
import { getEmberConfig, setEmberConfig } from "../src/config.ts";
import { fileSignerFromEnv } from "../src/files.ts";
import { createEmberWorker, normalizeBasePath, unmount } from "../src/worker.ts";
import { input as config } from "./worker.ts";

const original = getEmberConfig();
afterAll(() => setEmberConfig(original));

describe("basePath", () => {
  it("is normalized; a path that is not a plain URL path is refused", () => {
    expect(normalizeBasePath(undefined)).toBeUndefined();
    expect(normalizeBasePath("/")).toBeUndefined();
    expect(normalizeBasePath("ember")).toBe("/ember");
    expect(normalizeBasePath("/ember/")).toBe("/ember");
    expect(normalizeBasePath("/api/v2/ember")).toBe("/api/v2/ember");
    expect(() => normalizeBasePath("/em ber")).toThrow(/basePath/);
    expect(() => normalizeBasePath("/a//b")).toThrow(/basePath/);
  });

  it("serves every route under the mount point, and nothing outside it", async () => {
    const embedded = createEmberWorker({ ...config, basePath: "/ember" });
    try {
      const call = (path: string, init?: RequestInit) => embedded.fetch(new Request(`http://host.example${path}`, init), env as any, createExecutionContext());
      expect(embedded.handles(new Request("http://host.example/ember/api/query"))).toBe(true);
      expect(embedded.handles(new Request("http://host.example/ember"))).toBe(true);
      expect(embedded.handles(new Request("http://host.example/emberx/api/query"))).toBe(false);
      expect(embedded.handles(new Request("http://host.example/api/query"))).toBe(false);
      expect((await call("/ember/health")).status).toBe(200);
      expect((await call("/health")).status).toBe(404);
      expect((await call("/api/query", { method: "POST", body: "{}" })).status).toBe(404);

      const shard = "embed:a";
      const post = (path: string, body: unknown) => call(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const sent = await post("/ember/api/mutation", { fn: "messages:send", args: { channel: "c", body: "mounted" }, shard });
      expect((await sent.json()) as unknown).toMatchObject({ ok: true });
      const listed = (await (await post("/ember/api/query", { fn: "messages:list", args: { channel: "c" }, shard })).json()) as { value: Array<{ body: string }> };
      expect(listed.value.map((m) => m.body)).toEqual(["mounted"]);

      const ws = await call(`/ember/ws?shard=${shard}`, { headers: { Upgrade: "websocket" } });
      expect(ws.status).toBe(101);
      ws.webSocket!.accept();
      ws.webSocket!.close();
    } finally {
      setEmberConfig(original);
    }
  });

  it("basePath \"/\" means none, in the registered config too", () => {
    try {
      const w = createEmberWorker({ ...config, basePath: "/" });
      expect(getEmberConfig().basePath).toBeUndefined();
      expect(w.handles(new Request("http://host.example/api/query"))).toBe(true);
      createEmberWorker({ ...config, basePath: "ember/" });
      expect(getEmberConfig().basePath).toBe("/ember");
    } finally {
      setEmberConfig(original);
    }
  });

  it("unmount keeps the encoded path as it is", () => {
    expect(unmount(new URL("http://h/ember/api/hooks/a%20b/%C3%A9?x=1#f"), "/ember").href).toBe("http://h/api/hooks/a%20b/%C3%A9?x=1#f");
    expect(unmount(new URL("http://h/ember"), "/ember").pathname).toBe("/");
    // A path that looks like a network reference never changes the host.
    const odd = unmount(new URL("https://h/ember//evil.com/x?y=1"), "/ember");
    expect(odd.origin).toBe("https://h");
    expect(odd.pathname).toBe("//evil.com/x");
    expect(odd.search).toBe("?y=1");
  });

  it("the auth hook sees the public URL, mount included", async () => {
    const seen: string[] = [];
    const embedded = createEmberWorker({
      ...config,
      basePath: "/ember",
      auth: { ...config.auth!, fetch: (request: Request) => (seen.push(new URL(request.url).pathname), new URL(request.url).pathname.startsWith("/ember/api/auth/") ? Response.json({ ok: true }) : null) },
    });
    try {
      const res = await embedded.fetch(new Request("http://host.example/ember/api/auth/get-session"), env as any, createExecutionContext());
      expect(res.status).toBe(200);
      expect(seen).toEqual(["/ember/api/auth/get-session"]);
    } finally {
      setEmberConfig(original);
    }
  });

  it("proxy file URLs are relative to the runtime (the client adds its url, mount included); absolute ones carry the mount", () => {
    const signer = fileSignerFromEnv({ ...(env as any), EMBER_STORAGE_SECRET: "s".repeat(32) }, "/ember")!;
    expect(signer.mode).toBe("proxy");
    expect(signer.getUrl("sha256/ab", { now: Date.now(), expiresIn: 60 })).toMatch(/^\/api\/storage\/get\?/);
    const absolute = fileSignerFromEnv({ ...(env as any), EMBER_STORAGE_SECRET: "s".repeat(32), EMBER_PUBLIC_URL: "https://app.example.com" }, "/ember")!;
    expect(absolute.getUrl("sha256/ab", { now: Date.now(), expiresIn: 60 })).toMatch(/^https:\/\/app\.example\.com\/ember\/api\/storage\/get\?/);
    const plain = fileSignerFromEnv({ ...(env as any), EMBER_STORAGE_SECRET: "s".repeat(32) })!;
    expect(plain.getUrl("sha256/ab", { now: Date.now(), expiresIn: 60 })).toMatch(/^\/api\/storage\/get\?/);
  });
});
