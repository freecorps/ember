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

    // Another user's session id under this user revokes nothing and cuts no socket.
    const memory2 = new Map<string, string>();
    const storage2 = { getItem: (k: string) => memory2.get(k) ?? null, setItem: (k: string, v: string) => void memory2.set(k, v), removeItem: (k: string) => void memory2.delete(k) };
    const other = createAuth({ baseUrl: "http://localhost:8787", storage: storage2, fetch: selfFetch, origin: "http://localhost:8787" });
    const email2 = `other-${Date.now()}@example.test`;
    await other.signUp({ email: email2, password: "correct horse battery staple", name: "Other" });
    const otherId = (await read<{ users: Array<{ id: string; email: string }> }>(`/api/users?${q}&q=${encodeURIComponent(email2)}`)).body.users[0]!.id;
    const otherSession = (await read<{ sessions: Array<{ id: string }> }>(`/api/users/sessions?${q}&user=${otherId}`)).body.sessions[0]!.id;
    const cross = await write("/api/users/revoke", { ...target, userId: user.id, sessionId: otherSession });
    expect((cross.body as unknown as { value: { revoked: number; sockets: number } }).value).toMatchObject({ revoked: 0, sockets: 0 });
    expect((await read<{ sessions: unknown[] }>(`/api/users/sessions?${q}&user=${otherId}`)).body.sessions).toHaveLength(1);
    // The runtime refuses a malformed sessionId itself, too (never "every session").
    const direct = await SELF.fetch("http://x/api/_ember/auth/revoke", { method: "POST", headers: { authorization: "Bearer admin-secret", "content-type": "application/json" }, body: JSON.stringify({ userId: user.id, sessionId: 5 }) });
    expect(direct.status).toBe(400);

    const revoke = await write("/api/users/revoke", { ...target, userId: user.id });
    expect(revoke.status).toBe(200);
    expect((revoke.body as unknown as { value: { revoked: number } }).value.revoked).toBe(1);
    expect((await read<{ sessions: unknown[] }>(`/api/users/sessions?${q}&user=${user.id}`)).body.sessions).toEqual([]);

    const log = await read<{ entries: Array<{ action: string; outcome: string; args: string }> }>("/api/audit?project=files-auth-jobs&env=test&limit=5");
    expect(log.body.entries.map((e) => [e.action, e.outcome])).toEqual([
      ["user.sign_out_all", "ok"],
      ["session.revoke", "ok"],
      ["keys.rotate", "ok"],
      // EMBER_AUTH_SECRET: the project refuses (403 managed), recorded as an error.
      ["env.reveal", "error"],
      ["env.reveal", "ok"],
    ]);
    expect(JSON.stringify(log.body)).not.toContain("smtp-test-secret");
  });

  it("declarative screens: the app's spec, its queries for the read role, its writes for admins only — confirmed, audited, nothing else runs", async () => {
    const q = "project=files-auth-jobs&env=test";
    const specs = await read<{ dashboards: Array<{ key: string; label: string; scope: string; functions: Record<string, { type: string; destructive?: true }> }> }>(`/api/dash/specs?${q}`);
    expect(specs.status).toBe(200);
    expect(specs.body.dashboards.map((d) => [d.key, d.label, d.scope])).toEqual([["", "Operations", "global"]]);
    expect(specs.body.dashboards[0]!.functions).toMatchObject({ "rates:all": { type: "query" }, "rates:setRate": { type: "mutation" }, "files:sweep": { type: "mutation", destructive: true } });

    const target = { project: "files-auth-jobs", env: "test", shard: "global:main", dashboard: "" };
    // Admin: a declared mutation, then the declared query (read role) sees it.
    const set = await write("/api/dash/run", { ...target, fn: "rates:setRate", args: { base: "USD", quote: "BRL", rate: 5.4 } });
    expect([set.status, set.body.ok]).toEqual([200, true]);
    await write("/api/dash/run", { ...target, fn: "rates:setRate", args: { base: "EUR", quote: "BRL", rate: 6.1 } });
    type Page = { value: { page: Array<{ base: string; quote: string; rate: number }>; isDone: boolean; continueCursor: string } };
    const page = (args: unknown) => read<Page>(`/api/dash/query?${q}&shard=global:main&dashboard=&fn=rates:all&args=${encodeURIComponent(JSON.stringify(args))}`);
    // The table pages through the index (its screen sends paginationOpts); the base filter is a range of it.
    const look = await page({ base: "USD", paginationOpts: { numItems: 25, cursor: null } });
    expect(look.status).toBe(200);
    expect(look.body.value.page.map((r) => [r.base, r.quote, r.rate])).toEqual([["USD", "BRL", 5.4]]);
    const first = await page({ paginationOpts: { numItems: 1, cursor: null } });
    expect([first.body.value.page.map((r) => r.base), first.body.value.isDone]).toEqual([["EUR"], false]);
    const second = await page({ paginationOpts: { numItems: 1, cursor: first.body.value.continueCursor } });
    expect(second.body.value.page.map((r) => r.base)).toEqual(["USD"]);
    // The function's validators run first.
    const bad = await write("/api/dash/run", { ...target, fn: "rates:setRate", args: { base: "USD", quote: "BRL", rate: "high" } });
    expect([bad.status, bad.body.error?.code]).toEqual([400, "ValidationError"]);
    // Read role: no writes, and a write is never reachable through the read route either.
    expect((await write("/api/dash/run", { ...target, fn: "rates:setRate", args: { base: "USD", quote: "EUR", rate: 1 } }, "dash-read")).status).toBe(403);
    const sneakRead = await read<{ error: { code: string } }>(`/api/dash/query?${q}&shard=global:main&dashboard=&fn=rates:setRate&args=${encodeURIComponent(JSON.stringify({ base: "USD", quote: "EUR", rate: 1 }))}`);
    expect([sneakRead.status, sneakRead.body.error.code]).toEqual([403, "not_in_dashboard"]);
    // A function the spec does not name (internal files:get, public files:remove): refused, by the dashboard and the project.
    expect((await write("/api/dash/run", { ...target, fn: "files:remove", args: { id: "x" } })).body.error?.code).toBe("not_in_dashboard");
    const direct = await SELF.fetch("http://x/api/_ember/dashboards/run", { method: "POST", headers: { authorization: "Bearer admin-secret", "content-type": "application/json" }, body: JSON.stringify({ dashboard: "", fn: "files:get", args: { id: "x" }, shard: "global:main" }) });
    expect([direct.status, ((await direct.json()) as { error: { code: string } }).error.code]).toEqual([403, "not_in_dashboard"]);
    // Destructive on the protected env: the function's name is typed.
    const unconfirmed = await write("/api/dash/run", { ...target, fn: "files:sweep" });
    expect([unconfirmed.status, unconfirmed.body.error?.code, unconfirmed.body.error?.data?.expected]).toEqual([428, "confirmation_required", "sweep"]);
    const swept = await write("/api/dash/run", { ...target, fn: "files:sweep", confirm: "sweep" });
    expect([swept.status, (swept.body as unknown as { value: number }).value]).toEqual([200, 0]);
    // A global screen runs on global:main only.
    const elsewhere = await write("/api/dash/run", { ...target, shard: "org:acme", fn: "rates:setRate", args: { base: "USD", quote: "BRL", rate: 1 } });
    expect([elsewhere.status, elsewhere.body.error?.code]).toEqual([400, "bad_shard"]);

    const log = await read<{ entries: Array<{ actor: string; action: string; outcome: string; target: string; args: string }> }>("/api/audit?project=files-auth-jobs&env=test&limit=5");
    expect(log.body.entries.map((e) => [e.actor, e.action, e.target, e.outcome])).toEqual([
      ["token", "dashboard.run", "rates:setRate", "error"],
      ["token", "dashboard.run", "files:sweep", "ok"],
      ["read-token", "dashboard.run", null, "denied"],
      ["token", "dashboard.run", "rates:setRate", "error"],
      ["token", "dashboard.run", "rates:setRate", "ok"],
    ]);
    // Argument values are user data: names only.
    expect(log.body.entries[4]!.args).toBe(JSON.stringify({ dashboard: "", fn: "rates:setRate", fields: ["base", "quote", "rate"] }));
  });

  it("SQL Explorer: one read-only query on the shard through the dashboard, audited with its text; writes refused by the project", async () => {
    const target = { project: "files-auth-jobs", env: "test", shard: "global:main" };
    type Answer = { value: { columns: string[]; rows: unknown[][]; rowsRead: number; rowsWritten: number; truncated: boolean; ms: number; plan?: Array<{ detail: string }> } };
    // Its own rates (fxRates lives on global:main; setRate upserts, so the declarative-screens test before it changes
    // nothing): the test runs alone too. Written before the seven SQL requests the audit assertion reads.
    for (const [base, rate] of [["USD", 5.4], ["EUR", 6.1]] as const) expect((await write("/api/dash/run", { ...target, dashboard: "", fn: "rates:setRate", args: { base, quote: "BRL", rate } })).status).toBe(200);
    // By SQL with a bound parameter.
    const r = await write("/api/sql", { ...target, sql: "SELECT base, quote, rate FROM fxRates WHERE quote = ? ORDER BY base", params: ["BRL"] });
    expect(r.status).toBe(200);
    const answer = (r.body as unknown as Answer).value;
    expect(answer).toMatchObject({ columns: ["base", "quote", "rate"], rows: [["EUR", "BRL", 6.1], ["USD", "BRL", 5.4]], rowsWritten: 0, truncated: false });
    expect(answer.rowsRead).toBeGreaterThan(0);
    // The row cap: one row asked, the query had more.
    const capped = await write("/api/sql", { ...target, sql: "SELECT _id FROM fxRates", limit: 1 });
    expect((capped.body as unknown as Answer).value).toMatchObject({ truncated: true, rows: [expect.any(Array)] });
    // EXPLAIN QUERY PLAN as a tree.
    const plan = await write("/api/sql", { ...target, sql: "SELECT * FROM fxRates WHERE base = 'USD'", explain: true });
    expect((plan.body as unknown as Answer).value.plan![0]!.detail).toMatch(/SCAN|SEARCH/);
    // A write is refused by the project (the dashboard forwards the text; the runtime decides), and nothing changes.
    const refused = await write("/api/sql", { ...target, sql: "DELETE FROM fxRates" });
    expect([refused.status, refused.body.error?.code]).toEqual([400, "SqlRefused"]);
    const chained = await write("/api/sql", { ...target, sql: "SELECT 1; DROP TABLE fxRates" });
    expect(chained.body.error?.code).toBe("SqlRefused");
    const count = await write("/api/sql", { ...target, sql: "SELECT count(*) AS n FROM fxRates" });
    expect((count.body as unknown as Answer).value.rows).toEqual([[2]]);
    // Read role: refused before the project is called.
    expect((await write("/api/sql", { ...target, sql: "SELECT 1" }, "dash-read")).status).toBe(403);

    const log = await read<{ entries: Array<{ actor: string; action: string; outcome: string; target: string | null; args: string | null }> }>("/api/audit?project=files-auth-jobs&env=test&limit=7");
    expect(log.body.entries.map((e) => [e.actor, e.action, e.outcome])).toEqual([
      ["read-token", "sql.run", "denied"],
      ["token", "sql.run", "ok"],
      ["token", "sql.run", "error"],
      ["token", "sql.run", "error"],
      ["token", "sql.run", "ok"],
      ["token", "sql.run", "ok"],
      ["token", "sql.run", "ok"],
    ]);
    // The text is what ran (the point of the log); parameter values are user data, only their count. Found by text.
    const bySql = (text: string) => log.body.entries.find((e) => e.args !== null && (JSON.parse(e.args) as { sql?: string }).sql === text);
    const first = bySql("SELECT base, quote, rate FROM fxRates WHERE quote = ? ORDER BY base");
    expect(JSON.parse(first!.args!)).toEqual({ sql: "SELECT base, quote, rate FROM fxRates WHERE quote = ? ORDER BY base", params: 1, explain: false, limit: null });
    expect(first).toMatchObject({ outcome: "ok", target: "global:main" });
    expect(bySql("DELETE FROM fxRates")).toMatchObject({ action: "sql.run", outcome: "error" });
  });
  it("replication and storage cleanup: outbox and lag from the real sources, a resync, orphans deleted only when no row has them", async () => {
    const q = "project=files-auth-jobs&env=test";
    // global:main (fxRates is .replicated()) and the Auth DO (organizations) as sources, with admin API level 18 fields.
    const rep = await read<{ sources: Record<string, { enabled: boolean; maxAttempts: number; outbox: { seq: number; depth: number; parked: number } }> }>(`/api/replicas?${q}`);
    expect(rep.status).toBe(200);
    expect(rep.body.sources["global:main"]).toMatchObject({ enabled: true, maxAttempts: 10, outbox: { seq: expect.any(Number), depth: expect.any(Number), parked: 0 } });
    const resync = await write("/api/replicas/resync", { project: "files-auth-jobs", env: "test", shard: "org:dash-resync", source: "global:main" });
    expect(resync).toMatchObject({ status: 200, body: { ok: true } });
    // Stuck uploads of a shard (read role).
    const stuck = await read<{ value: { rows: unknown[]; totals: { count: number } } }>(`/api/files/stuck?${q}&shard=global:main&graceMs=0`);
    expect(stuck.status).toBe(200);
    expect(stuck.body.value.totals.count).toBeGreaterThanOrEqual(0);
    // An orphan in the real bucket: listed by a dry run, deleted on the typed confirmation; a key a file row has is kept.
    const orphan = `f/Z2xvYmFsOm1haW4/${"0d".repeat(32)}`;
    await env.EMBER_FILES.put(orphan, "orphan");
    let found = false;
    for (let cursor: string | null = null, i = 0; i < 50 && !found; i++) {
      const page: { body: { value: { orphans: Array<{ key: string }>; cursor: string | null } } } = await read(`/api/files/orphans?${q}&graceMs=0${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      found = page.body.value.orphans.some((o) => o.key === orphan);
      cursor = page.body.value.cursor;
      if (!cursor) break;
    }
    expect(found).toBe(true);
    expect(await env.EMBER_FILES.head(orphan)).not.toBeNull();
    const body = { project: "files-auth-jobs", env: "test", keys: [orphan], graceMs: 0 };
    expect((await write("/api/files/orphans/delete", body)).body.error?.data?.expected).toBe("orphans");
    const del = await write("/api/files/orphans/delete", { ...body, confirm: "orphans" });
    expect(del.status).toBe(200);
    expect((del.body as unknown as { value: { deleted: Array<{ key: string }> } }).value.deleted).toEqual([{ key: orphan, shard: "global:main", size: 6 }]);
    expect(await env.EMBER_FILES.head(orphan)).toBeNull();
    // The refusal that asked for the confirmation ran nothing (428, before the audit row); the two writes are logged.
    const log = await read<{ entries: Array<{ action: string; outcome: string }> }>(`/api/audit?${q}&limit=2`);
    expect(log.body.entries.map((e) => [e.action, e.outcome])).toEqual([["file.orphans_delete", "ok"], ["replica.resync", "ok"]]);
  });
});
