// `ember dev --dashboard`: the Ember Dashboard on loopback in front of the `ember dev` runtime (Miniflare). No login,
// no account registry: a local D1 the runtime fills with its shard catalog, and the session's admin token.
import { mkdirSync, rmSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadProject } from "../src/config.ts";
import { dev, type DevSession } from "../src/dev.ts";
import { init } from "../src/init.ts";
import { TMP } from "./helpers.ts";

const dir = join(TMP, `dev-dashboard-${process.pid}`);
let session: DevSession;
let dash: URL;
const lines: string[] = [];

const get = async (path: string) => {
  const res = await fetch(new URL(path, dash));
  return { status: res.status, body: (await res.json()) as any };
};

/** A request with the Host header (and target) a DNS-rebound page would send (fetch does not let one set Host). */
const withHost = (path: string, host: string) =>
  new Promise<number>((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port: Number(dash.port), path, headers: { host } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    r.on("error", reject);
    r.end();
  });

beforeAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  init({ dir, project: "devdash" });
  session = await dev(loadProject(dir), { port: 0, persist: false, log: (l) => lines.push(l), dashboard: { port: 0 } });
  dash = session.dashboard!.url;
}, 120_000);
afterAll(async () => {
  await session?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("ember dev --dashboard", () => {
  it("serves the SPA on loopback, signed in as the local admin (no login)", async () => {
    expect(dash.hostname).toBe("127.0.0.1");
    expect(lines.some((l) => l.includes(`dashboard on ${dash.href}#/p/devdash/local/health`))).toBe(true);
    const page = await fetch(dash);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(await page.text()).toContain('<script type="module" src="/app.js"></script>');
    expect((await fetch(new URL("/app.js", dash))).status).toBe(200);
    const me = await get("/api/me");
    expect(me.body).toMatchObject({ ok: true, via: "dev", actor: "local-dev", role: "admin", metrics: false });
    expect(typeof me.body.csrf).toBe("string");
  });

  it("lists the project's local environment, pointing at this session's runtime", async () => {
    const p = await get("/api/projects");
    expect(p.body.projects).toMatchObject([{ name: "devdash", envs: [{ env: "local", worker: "ember-devdash-local", url: session.url.origin }] }]);
    expect(p.body.projects[0].envs[0].schema_version).toMatch(/^[0-9a-f]{8,}/);
  });

  it("reaches the runtime's admin endpoints with the session token: capabilities, functions, schema, status", async () => {
    const caps = await get("/api/capabilities?project=devdash&env=local");
    expect(caps.status).toBe(200);
    expect(caps.body.level).toBeGreaterThanOrEqual(13);
    const fns = await get("/api/fn/list?project=devdash&env=local");
    expect(fns.body.functions.map((f: { name: string }) => f.name)).toEqual(expect.arrayContaining(["messages:list", "messages:send"]));
    const schema = await get("/api/schema?project=devdash&env=local");
    expect(schema.body.tables.map((t: { name: string }) => t.name)).toContain("messages");
    const status = await get("/api/status?project=devdash&env=local&shard=global:main");
    expect(status.body.shards).toMatchObject([{ shard: "global:main", ready: true }]);
  });

  it("the shard catalog is the runtime's own report to the local registry", async () => {
    // global:main woke above (its migration reports it); the catalog shows it with the running schema.
    let rows: Array<{ shard: string; schema_version: string }> = [];
    for (let i = 0; i < 100 && !rows.length; i++) {
      rows = (await get("/api/shards?project=devdash&env=local")).body.shards;
      if (!rows.length) await new Promise((r) => setTimeout(r, 50));
    }
    const s = await get("/api/shards?project=devdash&env=local");
    expect(rows.length, "the runtime never reported global:main to the local registry").toBeGreaterThan(0);
    expect(rows.map((r) => r.shard)).toEqual(["global:main"]);
    expect(rows[0]!.schema_version).toBe(s.body.expected);
  });

  it("writes keep every rule (Origin, CSRF, content type) and are audited in the local registry", async () => {
    const me = await get("/api/me");
    const post = (headers: Record<string, string>) =>
      fetch(new URL("/api/bookmark", dash), { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ project: "devdash", env: "local", shard: "global:main", label: "dev" }) });
    expect((await post({ origin: dash.origin })).status).toBe(403); // no CSRF token
    expect((await post({ origin: "https://evil.example", "x-ember-csrf": me.body.csrf })).status).toBe(403);
    const ok = await post({ origin: dash.origin, "x-ember-csrf": me.body.csrf });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("x-ember-audit-id")).toMatch(/^\d+$/);
    const audit = await get("/api/audit?project=devdash&env=local");
    expect(audit.body.entries[0]).toMatchObject({ action: "bookmark.create", actor: "local-dev", via: "dev", outcome: "ok", shard: "global:main" });
  });

  it("answers loopback hosts only: a DNS-rebound Host is refused", async () => {
    expect(await withHost("/api/me", `localhost:${dash.port}`)).toBe(200);
    expect(await withHost("/api/me", "evil.example")).toBe(403);
    expect(await withHost("/api/projects", `rebind.evil.example:${dash.port}`)).toBe(403);
    // A scheme-relative or absolute target cannot swap the Host's authority for a loopback one.
    expect(await withHost(`//127.0.0.1:${dash.port}/api/me`, `evil.example:${dash.port}`)).toBe(403);
    expect(await withHost(`//127.0.0.1:${dash.port}/api/me`, `localhost:${dash.port}`)).toBe(400);
    expect(await withHost(`http://127.0.0.1:${dash.port}/api/me`, `localhost:${dash.port}`)).toBe(400);
  });

  it("keeps working after a reload (Miniflare hands out a new registry handle)", async () => {
    await session.reload("vars");
    await session.reload("code");
    const p = await get("/api/projects");
    expect(p.status).toBe(200);
    expect(p.body.projects[0].envs[0].env).toBe("local");
    expect((await get("/api/audit?project=devdash&env=local")).body.entries.length).toBeGreaterThan(0);
  });
});
