// The Ember Dashboard's API (apps/dashboard worker.ts) in front of this app's real runtime, on workerd: the
// dashboard reaches the project through a service binding (here SELF), reads the registry from a real D1 database,
// and every write goes through roles, Origin/CSRF, the typed confirmation and the audit log
// (docs/design/contracts.md "Dashboard").
import { env, SELF } from "cloudflare:test";
import { clearCapabilities, CSRF_HEADER, handleApi, type DashboardEnv } from "@freecorps/ember-dashboard/worker";
import { beforeAll, describe, expect, it } from "vitest";

const ORIGIN = "https://dash.example";
const WORKER = "ember-files-auth-jobs-test";

const dash: DashboardEnv = {
  DASHBOARD_TOKEN: "dash-admin",
  DASHBOARD_READ_TOKEN: "dash-read",
  // The test environment plays production: destructive actions need the typed confirmation.
  DASHBOARD_PROTECTED_ENVS: "test",
  REGISTRY: env.REGISTRY,
  EMBER_ADMIN_TOKEN: "admin-secret",
  EMBER_SERVICES: JSON.stringify({ [WORKER]: "PROJECT" }),
  PROJECT: SELF,
};

const call = (method: string, path: string, headers: Record<string, string> = {}, body?: unknown) => {
  const url = new URL(`${ORIGIN}${path}`);
  return handleApi(new Request(url, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }), dash, url);
};
const read = async <T,>(path: string, token = "dash-read") => {
  const res = await call("GET", path, { authorization: `Bearer ${token}` });
  return { status: res.status, body: (await res.json()) as T };
};
const write = async (path: string, body: unknown, token = "dash-admin") => {
  const me = (await (await call("GET", "/api/me", { authorization: `Bearer ${token}` })).json()) as { csrf: string };
  const res = await call("POST", path, { authorization: `Bearer ${token}`, origin: ORIGIN, "content-type": "application/json", [CSRF_HEADER]: me.csrf }, body);
  return { status: res.status, body: (await res.json()) as { ok: boolean; error?: { code: string; data?: { expected?: string } } } };
};

beforeAll(async () => {
  clearCapabilities();
  // The registry tables `ember deploy` creates (packages/cli registry.ts), with this app registered.
  await env.REGISTRY.batch([
    env.REGISTRY.prepare("CREATE TABLE IF NOT EXISTS projects (name TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, repo TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)"),
    env.REGISTRY.prepare(
      "CREATE TABLE IF NOT EXISTS environments (project TEXT NOT NULL, env TEXT NOT NULL, worker TEXT NOT NULL UNIQUE, url TEXT, schema_version TEXT, version_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (project, env))",
    ),
    env.REGISTRY.prepare("CREATE TABLE IF NOT EXISTS deployments (id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, env TEXT NOT NULL, worker TEXT NOT NULL, version_id TEXT, schema_version TEXT, url TEXT, message TEXT, strategy TEXT, at INTEGER NOT NULL)"),
    env.REGISTRY.prepare("CREATE TABLE IF NOT EXISTS domains (host TEXT PRIMARY KEY, project TEXT NOT NULL, env TEXT NOT NULL, worker TEXT NOT NULL, kind TEXT NOT NULL, zone_id TEXT, zone TEXT, created_at INTEGER NOT NULL)"),
    env.REGISTRY.prepare(
      "CREATE TABLE IF NOT EXISTS shards (project TEXT NOT NULL, env TEXT NOT NULL, shard TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL, schema_version TEXT, db_size INTEGER NOT NULL DEFAULT 0, last_write INTEGER, reported_at INTEGER NOT NULL, PRIMARY KEY (project, env, shard))",
    ),
    env.REGISTRY.prepare("INSERT OR IGNORE INTO projects VALUES ('files-auth-jobs', 'fp', NULL, 1, 1)"),
    env.REGISTRY.prepare(`INSERT OR IGNORE INTO environments VALUES ('files-auth-jobs', 'test', '${WORKER}', NULL, NULL, NULL, 1, 1)`),
    env.REGISTRY.prepare("INSERT OR IGNORE INTO shards VALUES ('files-auth-jobs', 'test', 'global:main', 'global', 'main', NULL, 0, NULL, 1)"),
  ]);
});

describe("dashboard → runtime (workerd)", () => {
  it("reads capabilities, status, live counters, tables and crons from the running project", async () => {
    const q = "project=files-auth-jobs&env=test";
    const caps = await read<{ level: number; features: string[]; auth: boolean; files: boolean; system: boolean }>(`/api/capabilities?${q}`);
    expect(caps.status).toBe(200);
    expect(caps.body).toMatchObject({ level: 2, auth: true, files: true, system: true });
    const status = await read<{ shards: Array<{ shard: string; ready: boolean }> }>(`/api/shards?${q}&status=1`);
    expect(status.body.shards.map((s) => s.shard)).toEqual(["global:main"]);
    expect((status.body as unknown as { status: { shards: Array<{ ready: boolean }> } }).status.shards[0]!.ready).toBe(true);
    const inspect = await read<{ shard: { subs: number; sql: unknown } }>(`/api/inspect?${q}&shard=global:main`);
    expect(inspect.status).toBe(200);
    expect(inspect.body.shard.sql).toBeTypeOf("object");
    const tables = await read<{ tables: Array<{ name: string; kind: string }> }>(`/api/data?${q}&shard=global:main`);
    expect(tables.body.tables.map((t) => t.name)).toEqual(expect.arrayContaining(["uploads", "_jobs", "_files"]));
    const crons = await read<{ crons: Array<{ name: string }> }>(`/api/crons?${q}`);
    expect(crons.body.crons.length).toBeGreaterThan(0);
  });

  it("writes: read role refused, typed confirmation on the protected env, every attempt in the audit log", async () => {
    const target = { project: "files-auth-jobs", env: "test", shard: "global:main" };
    // Read role: refused before the project is called.
    expect((await write("/api/bookmark", target, "dash-read")).status).toBe(403);
    // Admin: the runtime records the bookmark.
    const mark = await write("/api/bookmark", { ...target, label: "e2e" });
    expect(mark.status).toBe(200);
    const bookmark = (mark.body as unknown as { bookmark: { bookmark: string; reason: string } }).bookmark;
    expect(bookmark.reason).toBe("manual:e2e");
    // Restore is destructive and `test` is protected here: the shard name must be typed.
    const unconfirmed = await write("/api/restore", { ...target, bookmark: bookmark.bookmark });
    expect([unconfirmed.status, unconfirmed.body.error?.code, unconfirmed.body.error?.data?.expected]).toEqual([428, "confirmation_required", "global:main"]);
    // Confirmed, it reaches the runtime (local workerd cannot apply a restore: pitr_unavailable, nothing changes).
    const restored = await write("/api/restore", { ...target, bookmark: bookmark.bookmark, confirm: "global:main" });
    expect([restored.status, restored.body.error?.code]).toEqual([501, "pitr_unavailable"]);
    expect((await read(`/api/status?project=files-auth-jobs&env=test&shard=global:main`)).status).toBe(200);

    const log = await read<{ entries: Array<{ actor: string; action: string; outcome: string; status: number; error: string | null; shard: string }> }>("/api/audit?project=files-auth-jobs&env=test");
    expect(log.body.entries.map((e) => [e.actor, e.action, e.outcome])).toEqual([
      ["token", "shard.restore", "error"],
      ["token", "bookmark.create", "ok"],
      ["read-token", "bookmark.create", "denied"],
    ]);
    expect(log.body.entries[1]).toMatchObject({ status: 200, shard: "global:main", error: null });
  });
});
