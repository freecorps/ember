// `ember shards ls` (registry catalog) and `ember shards inspect` (status + data + inspect admin endpoints).
import { describe, expect, it } from "vitest";
import { D1Registry } from "../src/registry.ts";
import { AdminApiError, bytes, catalogShards, CatalogUnavailableError, formatShardList, formatShardReport, inspectShard, listShards } from "../src/shards.ts";
import { fakeAccount } from "./fake-account.ts";

const V = "a".repeat(64);

/** The three admin GETs, shaped like the runtime answers them (worker.ts `status`/`inspect`, admin.ts `browse`). */
function fakeWorker(o: { refuseData?: boolean; noInspect?: boolean } = {}) {
  const seen: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    seen.push(`${url.pathname}${url.search}`);
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer adm");
    const shard = url.searchParams.get("shard");
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (url.pathname === "/api/_ember/status")
      return json({ ok: true, expectedVersion: V, shards: [{ shard, expectedVersion: V, schemaVersion: V, ready: true, staged: [], migrationError: null, lastMigrationError: null, version: 42, databaseSize: 3 * 1024 * 1024 }], restores: [] });
    if (url.pathname === "/api/_ember/data") {
      if (o.refuseData) return json({ ok: false, error: { code: "RuntimeSchemaTooNew", message: "newer runtime" } }, 409);
      return json({ ok: true, tables: [{ name: "messages", kind: "schema", rows: 1200 }, { name: "_jobs", kind: "internal", rows: 3 }] });
    }
    if (url.pathname === "/api/_ember/inspect") {
      if (o.noInspect) return json({ ok: false, error: { code: "not_found", message: "not found" } }, 404);
      return json({
        ok: true,
        shard: {
          version: 42, epoch: "e1", shard, stats: {}, subs: 5, queries: 2, shared: 1, gates: 0, dormant: 1,
          jobs: [
            { id: 1, job_id: "j1", run_at: 1_800_000_000_000, fn: "messages:trim", kind: "mutation", state: "pending", attempts: 0, max_attempts: 3, last_error: null, dedup_key: null },
            { id: 2, job_id: "j2", run_at: 1_800_000_000_000, fn: "mail:send", kind: "action", state: "failed", attempts: 3, max_attempts: 3, last_error: "SMTP down", dedup_key: null },
          ],
          finishedJobs: 7, bookmarks: 4, alarm: 1_800_000_000_000, backfilling: false,
          files: { total: 2, ready: 2, pending: 0, deleting: 0, unreferenced: 0 }, outbox: { pending: 0, inFlight: 0, parked: 0 }, rows: { read: 1, written: 1 }, sql: {},
        },
      });
    }
    return json({ ok: false, error: { code: "not_found", message: "not found" } }, 404);
  }) as typeof fetch;
  return { fetchImpl, seen };
}

describe("ember shards", () => {
  it("ls: the environment's shards from the registry catalog, one kind with --kind, as a table or JSON", async () => {
    const cf = fakeAccount();
    const reg = await D1Registry.open(cf.client, "ember-registry");
    const add = (env: string, shard: string, size: number) =>
      reg.exec("INSERT INTO shards (project, env, shard, kind, key, schema_version, db_size, last_write, reported_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", "chat", env, shard, shard.split(":")[0], shard.split(":")[1], V, size, 1_790_000_000_000, 1_790_000_100_000);
    await add("prod", "org:acme", 2048);
    await add("prod", "global:main", 10 * 1024 * 1024);
    await add("dev", "org:other", 1);
    const exec = (sql: string, ...p: unknown[]) => reg.exec(sql, ...p);
    const all = await listShards(exec, "chat", "prod");
    expect(all.map((s) => s.shard)).toEqual(["global:main", "org:acme"]);
    expect(all[1]).toEqual({ shard: "org:acme", kind: "org", key: "acme", schemaVersion: V, dbSize: 2048, lastWrite: 1_790_000_000_000, reportedAt: 1_790_000_100_000 });
    expect((await listShards(exec, "chat", "prod", { kind: "org" })).map((s) => s.shard)).toEqual(["org:acme"]);
    const text = formatShardList(all);
    expect(text).toMatch(/^SHARD\s+KIND\s+SIZE\s+SCHEMA/);
    expect(text).toMatch(/global:main\s+global\s+10\.0 MiB\s+aaaaaaaaaaaa/);
    expect(text).toMatch(/2 shards, 10\.0 MiB/);
    expect(formatShardList([])).toMatch(/No shards/);
    expect([bytes(0), bytes(1536), bytes(5 * 1024 ** 3)]).toEqual(["0 B", "1.5 KiB", "5.0 GiB"]);
  });

  it("inspect: size, versions, tables, jobs and subscriptions from the existing admin endpoints", async () => {
    const w = fakeWorker();
    const r = await inspectShard({ url: "http://127.0.0.1:8787", adminToken: "adm", fetch: w.fetchImpl }, "org:acme");
    expect(w.seen.sort()).toEqual(["/api/_ember/data?shard=org%3Aacme", "/api/_ember/inspect?shard=org%3Aacme", "/api/_ember/status?shard=org%3Aacme"]);
    expect(r.status).toMatchObject({ schemaVersion: V, ready: true, databaseSize: 3 * 1024 * 1024, version: 42 });
    expect(r.tables).toEqual([{ name: "messages", kind: "schema", rows: 1200 }, { name: "_jobs", kind: "internal", rows: 3 }]);
    expect(r.live).toMatchObject({ subs: 5, queries: 2, dormant: 1, jobs: { pending: 1, failed: 1 }, finishedJobs: 7, bookmarks: 4 });
    expect(r.live!.nextJobs[1]).toEqual({ fn: "mail:send", state: "failed", runAt: 1_800_000_000_000, attempts: 3, lastError: "SMTP down" });
    const text = formatShardReport(r);
    expect(text).toMatch(/size\s+3\.0 MiB/);
    expect(text).toMatch(/schema\s+aaaaaaaaaaaa \(current\)/);
    expect(text).toMatch(/5 subscriptions, 2 cached queries, 1 dormant/);
    expect(text).toMatch(/1 pending, 1 failed; 7 finished/);
    expect(text).toMatch(/messages\s+schema\s+1200/);
    expect(text).toMatch(/mail:send\s+failed.*SMTP down/);
  });

  it("inspect: tables and live counters are best effort; the status is required; credentials only to safe URLs", async () => {
    const w = fakeWorker({ refuseData: true, noInspect: true });
    const r = await inspectShard({ url: "http://localhost:8787", adminToken: "adm", fetch: w.fetchImpl }, "global:main");
    expect(r.tables).toBeNull();
    expect(r.tablesError).toMatch(/RuntimeSchemaTooNew/);
    expect(r.live).toBeNull();
    expect(formatShardReport(r)).toMatch(/tables\s+unavailable/);
    const down = (async () => new Response(JSON.stringify({ ok: false, error: { code: "unauthorized", message: "bad token" } }), { status: 401 })) as typeof fetch;
    await expect(inspectShard({ url: "http://localhost:8787", adminToken: "x", fetch: down }, "global:main")).rejects.toBeInstanceOf(AdminApiError);
    await expect(inspectShard({ url: "http://example.com", adminToken: "adm", fetch: w.fetchImpl }, "global:main")).rejects.toThrow(/http/);
  });

  it("ls: an account without a registry, or a registry without the shard catalog, is a clear error, not a raw one", async () => {
    const cf = fakeAccount();
    // No ember-registry D1 at all (what D1Registry.open says with create: false).
    const none = catalogShards(() => D1Registry.open(cf.client, "ember-registry", { create: false, ddl: false }), "chat", "prod");
    await expect(none).rejects.toBeInstanceOf(CatalogUnavailableError);
    await expect(none).rejects.toThrow(/no registry \(ember-registry\) yet.*ember deploy --env prod/);
    // A registry that predates the catalog: no `shards` table.
    const old = catalogShards(async () => ({ exec: async () => Promise.reject(new Error("D1 query: no such table: shards: SQLITE_ERROR")) }), "chat", "prod", { registry: "my-reg" });
    await expect(old).rejects.toThrow(/my-reg has no shard catalog yet/);
    // Any other failure stays as it is.
    await expect(catalogShards(async () => Promise.reject(new Error("Authentication error")), "chat", "prod")).rejects.toThrow(/^Authentication error$/);
    const reg = await D1Registry.open(cf.client, "ember-registry");
    expect(await catalogShards(async () => reg, "chat", "prod")).toEqual([]);
  });

  it("inspect: reports the requested shard's status, never another entry of the answer", async () => {
    const w = fakeWorker();
    const other = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname !== "/api/_ember/status") return w.fetchImpl(input, init);
      const entry = (shard: string, version: number) => ({ shard, expectedVersion: V, schemaVersion: V, ready: true, staged: [], migrationError: null, version, databaseSize: 1 });
      return new Response(JSON.stringify({ ok: true, expectedVersion: V, shards: [entry("global:main", 1), entry("org:acme", 7)], restores: [] }));
    }) as typeof fetch;
    expect((await inspectShard({ url: "http://127.0.0.1:8787", adminToken: "adm", fetch: other }, "org:acme")).status.version).toBe(7);
    const missing = (async (input: string | URL | Request, init?: RequestInit) =>
      new URL(String(input)).pathname === "/api/_ember/status" ? new Response(JSON.stringify({ ok: true, expectedVersion: V, shards: [{ shard: "global:main" }], restores: [] })) : w.fetchImpl(input, init)) as typeof fetch;
    await expect(inspectShard({ url: "http://127.0.0.1:8787", adminToken: "adm", fetch: missing }, "org:acme")).rejects.toThrow(/no status for org:acme/);
  });

  it("inspect: every admin call has a deadline; a stalled optional call is an error of its own, a stalled status fails", async () => {
    const w = fakeWorker();
    const never = new Promise<Response>(() => {});
    const stallData = (async (input: string | URL | Request, init?: RequestInit) => (new URL(String(input)).pathname === "/api/_ember/data" ? never : w.fetchImpl(input, init))) as typeof fetch;
    const t0 = Date.now();
    const r = await inspectShard({ url: "http://127.0.0.1:8787", adminToken: "adm", fetch: stallData, timeoutMs: 50 }, "org:acme");
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(r.tables).toBeNull();
    expect(r.tablesError).toMatch(/no answer within 0\.05 s/);
    expect(r.live).not.toBeNull();
    // A body that never ends counts too.
    const stallBody = (async (input: string | URL | Request, init?: RequestInit) =>
      new URL(String(input)).pathname === "/api/_ember/status" ? new Response(new ReadableStream({ start() {} })) : w.fetchImpl(input, init)) as typeof fetch;
    const err = await inspectShard({ url: "http://127.0.0.1:8787", adminToken: "adm", fetch: stallBody, timeoutMs: 50 }, "org:acme").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdminApiError);
    expect((err as AdminApiError).code).toBe("timeout");
  });
});
