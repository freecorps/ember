// The Ember Dashboard's API (apps/dashboard worker.ts) in front of this app's real runtime, on workerd: the
// dashboard reaches the project through a service binding (here SELF), reads the registry from a real D1 database,
// and every write goes through roles, Origin/CSRF, the typed confirmation and the audit log
// (docs/design/contracts.md "Dashboard").
import { env, SELF } from "cloudflare:test";
import { clearCapabilities, CSRF_HEADER, handleApi, type DashboardEnv } from "@freecorps/ember-dashboard/worker";
import { selfFetch, testClient, watch } from "@freecorps/ember-example-testing";
import { ADMIN_API_LEVEL } from "@freecorps/ember-runtime";
import { beforeAll, describe, expect, it } from "vitest";
import { api } from "../ember/_generated/api";
import { createAuth } from "../web/src/auth";

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
    expect(caps.body).toMatchObject({ level: ADMIN_API_LEVEL, auth: true, files: true, system: true });
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

  it("documents: the dashboard edits through the engine — validated, indexed, and live in the app's own query", async () => {
    // A signed-in user uploads a file the way the app does (web/src/auth.ts + the files endpoints).
    const memory = new Map<string, string>();
    const storage = { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => void memory.set(k, v), removeItem: (k: string) => void memory.delete(k) };
    const auth = createAuth({ baseUrl: "http://localhost:8787", storage, fetch: selfFetch, origin: "http://localhost:8787" });
    await auth.signUp({ email: `dash-${Date.now()}@example.test`, password: "correct horse battery staple", name: "dash" });
    const client = testClient({ auth: () => auth.fetchToken(), defaultShard: "global:main" });
    const f = await client.files.upload(new Blob(["hello"], { type: "text/plain" }), { mutation: api.files.generateUploadUrl, fetch: selfFetch });
    const id = (await client.mutation(api.files.save, { storageId: f.storageId as never, name: "a.txt" })) as string;
    const w = watch(client, api.files.list, {});
    type Upload = { _id: string; name: string };
    const live = {
      /** Waits until the app's live query shows what `ok` expects (no polling of the server: the snapshots arrive). */
      until: async (ok: (v: Upload[] | undefined) => boolean) => {
        for (let i = 0; i < 300; i++) {
          if (ok(w.last()?.value as Upload[] | undefined)) return;
          await new Promise((r) => setTimeout(r, 10));
        }
        throw new Error("the live query never showed the change");
      },
      stop: w.stop,
    };
    await live.until((v) => (v ?? []).some((u) => u._id === id));

    const q = "project=files-auth-jobs&env=test";
    const schema = await read<{ tables: Array<{ name: string; indexes: Array<{ name: string }> }> }>(`/api/schema?${q}`);
    expect(schema.body.tables.find((t) => t.name === "uploads")!.indexes.map((i) => i.name)).toEqual(expect.arrayContaining(["by_user", "by_status"]));
    // Through an index: the upload is found by its status.
    const status = (await read<{ value: { page: Array<{ _id: string; status: string }> } }>(`/api/rows?${q}&shard=global:main&table=uploads&index=by_status&eq=${encodeURIComponent(JSON.stringify(["processing"]))}`)).body.value.page;
    const ready = (await read<{ value: { page: Array<{ _id: string }> } }>(`/api/rows?${q}&shard=global:main&table=uploads&index=by_status&eq=${encodeURIComponent(JSON.stringify(["ready"]))}`)).body.value.page;
    expect([...status, ...ready].map((d) => d._id)).toContain(id);

    const target = { project: "files-auth-jobs", env: "test", shard: "global:main", table: "uploads" };
    // The schema is the engine's: a bad status is refused, nothing changes.
    const bad = await write("/api/doc/patch", { ...target, id, fields: { status: "lost" } });
    expect([bad.status, bad.body.error?.code]).toEqual([400, "ValidationError"]);
    // A valid edit reaches the app's live query (change log + subscriptions).
    const ok = await write("/api/doc/patch", { ...target, id, fields: { name: "renamed.txt" } });
    expect(ok.status).toBe(200);
    await live.until((v) => (v ?? []).some((u) => u._id === id && u.name === "renamed.txt"));
    // Internal tables stay read-only.
    expect((await write("/api/doc/insert", { ...target, table: "_files", doc: {} })).status).toBe(400);
    // Delete on the protected env: the table name is typed; then the app sees it gone.
    expect((await write("/api/doc/delete", { ...target, ids: [id] })).status).toBe(428);
    expect((await write("/api/doc/delete", { ...target, ids: [id], confirm: "uploads" })).status).toBe(200);
    await live.until((v) => !(v ?? []).some((u) => u._id === id));

    const log = await read<{ entries: Array<{ action: string; outcome: string; target: string; args: string }> }>("/api/audit?project=files-auth-jobs&env=test&limit=3");
    expect(log.body.entries.map((e) => [e.action, e.outcome, e.target])).toEqual([
      ["doc.delete", "ok", id],
      ["doc.patch", "ok", id],
      ["doc.patch", "error", id],
    ]);
    expect(log.body.entries[1]!.args).not.toContain("renamed.txt");
    live.stop();
    client.close();
  });

  it("functions: run as a user (no token), internal ones too; reactivity of the live shard", async () => {
    const memory = new Map<string, string>();
    const storage = { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => void memory.set(k, v), removeItem: (k: string) => void memory.delete(k) };
    const auth = createAuth({ baseUrl: "http://localhost:8787", storage, fetch: selfFetch, origin: "http://localhost:8787" });
    await auth.signUp({ email: `run-${Date.now()}@example.test`, password: "correct horse battery staple", name: "run" });
    const client = testClient({ auth: () => auth.fetchToken(), defaultShard: "global:main" });
    const f = await client.files.upload(new Blob(["x"], { type: "text/plain" }), { mutation: api.files.generateUploadUrl, fetch: selfFetch });
    const id = (await client.mutation(api.files.save, { storageId: f.storageId as never, name: "mine.txt" })) as string;
    const w = watch(client, api.files.list, {});
    for (let i = 0; i < 300 && !(w.last()?.value as unknown[] | undefined)?.length; i++) await new Promise((r) => setTimeout(r, 10));
    const subject = (await client.query(api.files.list, {}))[0]!.userId;

    const q = "project=files-auth-jobs&env=test";
    const fns = await read<{ functions: Array<{ name: string; type: string; visibility: string }> }>(`/api/fn/list?${q}`);
    expect(fns.body.functions.map((x) => x.name)).toEqual(expect.arrayContaining(["files:list", "files:get", "files:save"]));
    expect(fns.body.functions.find((x) => x.name === "files:get")).toMatchObject({ visibility: "internal" });
    const target = { project: "files-auth-jobs", env: "test", shard: "global:main" };
    // Anonymous, files:list has nobody's uploads; as the user, it shows theirs.
    const anon = await write("/api/fn/run", { ...target, fn: "files:list", args: {} });
    expect(anon.body).toMatchObject({ ok: true, value: [] });
    const asUser = await write("/api/fn/run", { ...target, fn: "files:list", args: {}, as: { subject } });
    expect(asUser.status).toBe(200);
    expect((asUser.body as unknown as { value: Array<{ _id: string }> }).value.map((u) => u._id)).toContain(id);
    expect(JSON.stringify(asUser.body)).not.toMatch(/eyJ/);
    // Internal functions run too.
    const internal = await write("/api/fn/run", { ...target, fn: "files:get", args: { id } });
    expect((internal.body as unknown as { value: { name: string } }).value.name).toBe("mine.txt");

    // Reactivity: the client's live subscription is in the shard's report, computed per user (files:list reads ctx.auth).
    const rx = await read<{ report: { entries: Array<{ key: string; fn: string; shared: boolean; subscribers: number }> } }>(`/api/reactivity?${q}&shard=global:main`);
    const entry = rx.body.report.entries.find((e) => e.fn === "files:list")!;
    expect(entry).toMatchObject({ shared: false });
    expect(entry.subscribers).toBeGreaterThanOrEqual(1);
    const prof = await read<{ profile: { fn: string; identityRead: boolean; advice: Array<{ kind: string }> } }>(`/api/reactivity/profile?${q}&shard=global:main&key=${encodeURIComponent(entry.key)}`);
    expect(prof.body.profile).toMatchObject({ fn: "files:list", identityRead: true });
    expect(prof.body.profile.advice.map((a) => a.kind)).toContain("identity");

    const log = await read<{ entries: Array<{ action: string; target: string }> }>("/api/audit?project=files-auth-jobs&env=test&limit=3");
    expect(log.body.entries.map((e) => [e.action, e.target])).toEqual([
      ["function.run", "files:get"],
      ["function.run_as", "files:list"],
      ["function.run", "files:list"],
    ]);
    w.stop();
    client.close();
  });

  it("files and schedules: upload, download as an attachment, delete; run a cron now; run and cancel jobs", async () => {
    const q = "project=files-auth-jobs&env=test";
    const target = { project: "files-auth-jobs", env: "test", shard: "global:main" };
    const me = (await (await call("GET", "/api/me", { authorization: "Bearer dash-admin" })).json()) as { csrf: string };
    // Upload: raw bytes, parameters in the query, the same CSRF rules.
    const upUrl = `/api/files/upload?${q}&shard=global:main&contentType=text%2Fhtml`;
    const url = new URL(`${ORIGIN}${upUrl}`);
    const up = await handleApi(
      new Request(url, { method: "POST", headers: { authorization: "Bearer dash-admin", origin: ORIGIN, "content-type": "application/octet-stream", [CSRF_HEADER]: me.csrf }, body: "<script>alert(1)</script>" }),
      dash,
      url,
    );
    expect(up.status).toBe(200);
    const id = ((await up.json()) as { value: { id: string } }).value.id;
    const list = await read<{ rows: Array<{ id: string; content_type: string }> }>(`/api/files?${q}&shard=global:main`);
    expect(list.body.rows.find((r) => r.id === id)).toMatchObject({ content_type: "text/html" });
    const content = await call("GET", `/api/files/content?${q}&shard=global:main&id=${encodeURIComponent(id)}`, { authorization: "Bearer dash-read" });
    expect(content.headers.get("content-type")).toBe("application/octet-stream");
    expect(content.headers.get("content-disposition")).toBe("attachment");
    expect(content.headers.get("content-security-policy")).toContain("sandbox");
    expect(content.headers.get("x-ember-content-type")).toBe("text/html");
    expect(await content.text()).toBe("<script>alert(1)</script>");
    expect((await write("/api/files/delete", { ...target, id })).status).toBe(428);
    expect((await write("/api/files/delete", { ...target, id, confirm: id })).status).toBe(200);

    // Run the cron now: its job lands on its shard.
    const cron = await write("/api/crons/run", { project: "files-auth-jobs", env: "test", name: "retry-stuck-uploads" });
    expect(cron.status).toBe(200);
    // A job scheduled for later, then cancelled before it runs.
    const job = await write("/api/jobs/run", { ...target, fn: "files:sweep", args: {} });
    expect(job.status).toBe(200);
    const jobId = (job.body as unknown as { value: string }).value;
    expect((await write("/api/jobs/cancel", { ...target, id: jobId })).status).toBe(200);
    expect((await write("/api/jobs/run", { ...target, fn: "files:list", args: {} })).status).toBe(404);

    const log = await read<{ entries: Array<{ action: string; outcome: string }> }>("/api/audit?project=files-auth-jobs&env=test&limit=6");
    expect(log.body.entries.map((e) => [e.action, e.outcome])).toEqual([
      ["job.run", "error"],
      ["job.cancel", "ok"],
      ["job.run", "ok"],
      ["cron.run", "ok"],
      ["file.delete", "ok"],
      ["file.upload", "ok"],
    ]);
  });

  it("settings and users: env names, an audited reveal, key rotation, users and sessions from the Auth DO, revoke", async () => {
    const q = "project=files-auth-jobs&env=test";
    const env = await read<{ vars: Array<{ name: string; managed: boolean }> }>(`/api/env?${q}`);
    expect(env.body.vars).toEqual(expect.arrayContaining([{ name: "SMTP_PASSWORD", managed: false }, { name: "EMBER_AUTH_SECRET", managed: true }]));
    expect(JSON.stringify(env.body)).not.toContain("smtp-test-secret");
    const target = { project: "files-auth-jobs", env: "test" };
    const revealed = await write("/api/env/reveal", { ...target, name: "SMTP_PASSWORD" });
    expect((revealed.body as unknown as { value: string }).value).toBe("smtp-test-secret");
    expect((await write("/api/env/reveal", { ...target, name: "EMBER_AUTH_SECRET" })).status).toBe(403);
    // Destructive on the protected env: typed confirmation, then a real rotation in the Auth DO.
    expect((await write("/api/keys/rotate", target)).status).toBe(428);
    const rotated = await write("/api/keys/rotate", { ...target, confirm: "files-auth-jobs/test" });
    expect(rotated.status).toBe(200);

    // A real user with a session.
    const memory = new Map<string, string>();
    const storage = { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => void memory.set(k, v), removeItem: (k: string) => void memory.delete(k) };
    const auth = createAuth({ baseUrl: "http://localhost:8787", storage, fetch: selfFetch, origin: "http://localhost:8787" });
    const email = `admin-view-${Date.now()}@example.test`;
    await auth.signUp({ email, password: "correct horse battery staple", name: "Viewer" });
    expect(await auth.fetchToken()).toBeTruthy();
    const users = await read<{ users: Array<{ id: string; email: string }>; total: number }>(`/api/users?${q}&q=${encodeURIComponent(email.slice(0, 12).toUpperCase())}`);
    const user = users.body.users.find((u) => u.email === email)!;
    expect(user).toBeTruthy();
    expect(JSON.stringify(users.body)).not.toMatch(/password|hash/i);
    const sessions = await read<{ sessions: Array<Record<string, unknown>> }>(`/api/users/sessions?${q}&user=${user.id}`);
    expect(sessions.body.sessions).toHaveLength(1);
    expect(sessions.body.sessions[0]).not.toHaveProperty("token");
    expect(sessions.body.sessions[0]).toMatchObject({ userId: user.id, active: true });
    // The session token itself never shows: whatever the auth client holds is absent from the answer.
    for (const v of memory.values()) if (v.length > 20) expect(JSON.stringify(sessions.body)).not.toContain(v.slice(0, 24));

    const revoke = await write("/api/users/revoke", { ...target, userId: user.id });
    expect(revoke.status).toBe(200);
    expect((revoke.body as unknown as { value: { revoked: number } }).value.revoked).toBe(1);
    expect((await read<{ sessions: unknown[] }>(`/api/users/sessions?${q}&user=${user.id}`)).body.sessions).toEqual([]);

    const log = await read<{ entries: Array<{ action: string; outcome: string; args: string }> }>("/api/audit?project=files-auth-jobs&env=test&limit=4");
    expect(log.body.entries.map((e) => [e.action, e.outcome])).toEqual([
      ["user.sign_out_all", "ok"],
      ["keys.rotate", "ok"],
      // EMBER_AUTH_SECRET: the project refuses (403 managed), recorded as an error.
      ["env.reveal", "error"],
      ["env.reveal", "ok"],
    ]);
    expect(JSON.stringify(log.body)).not.toContain("smtp-test-secret");
  });
});
