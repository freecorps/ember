// Fewer registry round trips and writes (PR 4C-3): lazy, batched DDL; the CSRF key read before any insert; the body of
// an accepted write parsed once; /api/projects in one batch with grouped aggregates; a short cache of registry rows;
// capabilities keyed by Worker and URL; ETag / 304 for the SPA's assets.
import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { ensureTables, metaSecret, type D1Like, type D1Statement } from "../src/audit.ts";
import { capabilities, clearCapabilities, createDashboard, CSRF_HEADER, environment, ENV_TTL_MS, handleApi, type DashboardEnv } from "../src/worker.ts";
import { seeded } from "./helpers.ts";

const ORIGIN = "https://dash.example";

/** A D1 stand-in over node:sqlite that records every statement (and, with `batch`, every batch). */
function counting(db: DatabaseSync, o: { batch?: boolean; failDdl?: number } = {}) {
  const sqls: string[] = [];
  const batches: string[][] = [];
  let failDdl = o.failDdl ?? 0;
  const run = (sql: string, v: unknown[]) => {
    if (/^CREATE/.test(sql) && failDdl > 0) {
      failDdl--;
      throw new Error("ddl down");
    }
    return db.prepare(sql).all(...(v as never[]));
  };
  type Stmt = D1Statement & { sql: string; v: unknown[] };
  const binding: D1Like = {
    prepare: (sql) => ({
      bind: (...v) => {
        const s: Stmt = {
          sql,
          v,
          all: async <T,>() => {
            sqls.push(sql);
            return { results: run(sql, v) as T[] };
          },
        };
        return s;
      },
    }),
    ...(o.batch
      ? {
          batch: async (stmts: D1Statement[]) => {
            const list = stmts as Stmt[];
            batches.push(list.map((s) => s.sql));
            return list.map((s) => ({ results: run(s.sql, s.v) }));
          },
        }
      : {}),
  };
  return { binding, sqls, batches };
}

beforeEach(() => clearCapabilities());

describe("dashboard tables and the CSRF key", () => {
  it("DDL runs once per binding, in one batch when the binding has it, and is retried after a failure", async () => {
    const { db } = seeded();
    const c = counting(db, { batch: true, failDdl: 1 });
    await expect(ensureTables(c.binding)).rejects.toThrow("ddl down");
    await ensureTables(c.binding);
    await ensureTables(c.binding);
    expect(c.batches).toHaveLength(2);
    expect(c.batches[1]!.every((s) => s.startsWith("CREATE"))).toBe(true);
    expect(c.sqls.filter((s) => s.startsWith("CREATE"))).toEqual([]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('audit_log', 'dashboard_meta')").all()).toHaveLength(2);
  });

  it("metaSecret writes only the first time; later calls are one read", async () => {
    const { db } = seeded();
    const c = counting(db);
    const a = await metaSecret(c.binding, "k");
    const inserts = () => c.sqls.filter((s) => s.startsWith("INSERT")).length;
    expect(inserts()).toBe(1);
    const before = c.sqls.length;
    expect(await metaSecret(c.binding, "k")).toBe(a);
    expect(inserts()).toBe(1);
    expect(c.sqls.slice(before)).toEqual(["SELECT value FROM dashboard_meta WHERE key = ?"]);
    // A value stored by someone else (another isolate) wins.
    db.prepare("INSERT INTO dashboard_meta (key, value) VALUES ('other', 'abcd')").run();
    expect(await metaSecret(c.binding, "other")).toBe("abcd");
  });

  it("a read route issues no DDL; a write creates the tables before auditing", async () => {
    const { db } = seeded();
    const c = counting(db);
    const env: DashboardEnv = { DASHBOARD_TOKEN: "dash-secret", REGISTRY: c.binding };
    const url = new URL(`${ORIGIN}/api/projects`);
    expect((await handleApi(new Request(url, { headers: { authorization: "Bearer dash-secret" } }), env, url)).status).toBe(200);
    expect(c.sqls.some((s) => s.startsWith("CREATE"))).toBe(false);
  });

  it("a write whose tables cannot be created is refused before reaching the project", async () => {
    const { db } = seeded();
    const c = counting(db, { failDdl: 99 });
    let called = 0;
    const env: DashboardEnv = { DASHBOARD_TOKEN: "dash-secret", REGISTRY: c.binding, EMBER_ADMIN_TOKEN: "x" };
    const url = new URL(`${ORIGIN}/api/bookmark`);
    const res = await handleApi(
      new Request(url, { method: "POST", headers: { authorization: "Bearer dash-secret", origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ project: "chat", env: "dev", shard: "org:acme" }) }),
      env,
      url,
      (async () => {
        called++;
        return Response.json({});
      }) as typeof fetch,
    );
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("audit_unavailable");
    expect(called).toBe(0);
  });
});

describe("writes", () => {
  function setup() {
    const { db, binding } = seeded();
    const svc = {
      fetch: async (r: Request | string) => {
        const path = new URL((r as Request).url).pathname;
        if (path === "/api/_ember/capabilities") return Response.json({ ok: true, level: 3, features: ["bookmark"] });
        return Response.json({ ok: true, shard: "org:acme" });
      },
    };
    const env: DashboardEnv = {
      DASHBOARD_TOKEN: "dash-secret",
      DASHBOARD_READ_TOKEN: "read-secret",
      REGISTRY: binding,
      EMBER_ADMIN_TOKEN: "proj-admin",
      EMBER_SERVICES: JSON.stringify({ "ember-chat-dev": "EMBER_SVC_0" }),
      EMBER_SVC_0: svc,
    };
    const csrf = async (token: string) => {
      const url = new URL(`${ORIGIN}/api/me`);
      return ((await (await handleApi(new Request(url, { headers: { authorization: `Bearer ${token}` } }), env, url)).json()) as { csrf: string }).csrf;
    };
    const audit = () => db.prepare("SELECT * FROM audit_log ORDER BY id").all() as Array<Record<string, unknown>>;
    return { env, csrf, audit };
  }

  it("an accepted write reads its body once (no clone)", async () => {
    const t = setup();
    const url = new URL(`${ORIGIN}/api/bookmark`);
    const req = new Request(url, {
      method: "POST",
      headers: { authorization: "Bearer dash-secret", origin: ORIGIN, "content-type": "application/json", [CSRF_HEADER]: await t.csrf("dash-secret") },
      body: JSON.stringify({ project: "chat", env: "dev", shard: "org:acme" }),
    });
    req.clone = () => {
      throw new Error("cloned");
    };
    const res = await handleApi(req, t.env, url);
    expect(res.status).toBe(200);
    expect(t.audit()).toMatchObject([{ action: "bookmark.create", outcome: "ok", project: "chat", env: "dev", shard: "org:acme" }]);
  });

  it("a refusal still records where the write was aimed; an oversized refused body records only the action", async () => {
    const t = setup();
    const url = new URL(`${ORIGIN}/api/bookmark`);
    const send = (token: string, body: string, headers: Record<string, string> = {}) =>
      handleApi(new Request(url, { method: "POST", headers: { authorization: `Bearer ${token}`, origin: ORIGIN, "content-type": "application/json", ...headers }, body }), t.env, url);
    expect((await send("read-secret", JSON.stringify({ project: "chat", env: "dev", shard: "org:acme" }))).status).toBe(403);
    expect((await send("dash-secret", JSON.stringify({ project: "chat", env: "prod", shard: "org:acme" }), { [CSRF_HEADER]: "nope" })).status).toBe(403);
    expect((await send("read-secret", JSON.stringify({ project: "chat", env: "dev", pad: "x".repeat(70 * 1024) }))).status).toBe(403);
    expect(t.audit()).toMatchObject([
      { outcome: "denied", error: "forbidden", actor: "read-token", project: "chat", env: "dev", shard: "org:acme" },
      { outcome: "denied", error: "bad_csrf", actor: "token", project: "chat", env: "prod", shard: "org:acme" },
      { outcome: "denied", error: "forbidden", action: "bookmark.create", project: null, env: null },
    ]);
  });
});

describe("GET /api/projects", () => {
  function registryWithMore(db: DatabaseSync) {
    db.exec(`
      INSERT INTO projects VALUES ('blog', 'fp', NULL, 1, 2);
      INSERT INTO environments VALUES ('blog', 'prod', 'ember-blog-prod', NULL, 'x', 'v1', 1, 2);
      INSERT INTO deployments (project, env, worker, version_id, strategy, at) VALUES ('chat', 'prod', 'ember-chat-prod', 'v2', 'update', 9);
      INSERT INTO deployments (project, env, worker, version_id, strategy, at) VALUES ('blog', 'prod', 'ember-blog-prod', 'v1', 'create', 7);
      INSERT INTO shards VALUES ('chat', 'prod', 'org:beta', 'org', 'beta', 'abc', 1, 3, 4);
      INSERT INTO shards VALUES ('chat', 'dev', 'org:acme', 'org', 'acme', 'abc', 1, 3, 4);
      INSERT INTO domains VALUES ('chat.example', 'chat', 'prod', 'ember-chat-prod', 'custom', NULL, NULL, 1);
    `);
  }
  const expected = [
    { name: "blog", envs: [{ project: "blog", env: "prod", last_deploy: 7, shards: 0 }], domains: [] },
    {
      name: "chat",
      envs: [
        { env: "dev", last_deploy: null, shards: 1 },
        { env: "prod", last_deploy: 9, shards: 2 },
      ],
      domains: [{ host: "chat.example", env: "prod" }],
    },
  ];

  it.each([true, false])("one batch with grouped aggregates (batch: %s)", async (batch) => {
    const { db } = seeded();
    registryWithMore(db);
    const c = counting(db, { batch });
    const env: DashboardEnv = { DASHBOARD_TOKEN: "dash-secret", REGISTRY: c.binding };
    const url = new URL(`${ORIGIN}/api/projects`);
    const body = (await (await handleApi(new Request(url, { headers: { authorization: "Bearer dash-secret" } }), env, url)).json()) as { projects: unknown[] };
    expect(body.projects).toMatchObject(expected);
    if (batch) {
      expect(c.batches).toHaveLength(1);
      expect(c.sqls).toEqual([]);
    } else expect(c.sqls).toHaveLength(3);
    const all = [...c.sqls, ...c.batches.flat()].join("\n");
    expect(all).not.toMatch(/\(SELECT (MAX|COUNT)/);
  });
});

describe("registry rows and capabilities cache", () => {
  it("environment() is cached briefly per binding; misses are not cached", async () => {
    const { db } = seeded();
    const c = counting(db);
    const t0 = 1_000_000;
    const a = await environment(c.binding, "chat", "prod", t0);
    expect(a).toMatchObject({ worker: "ember-chat-prod", url: "https://ember-chat-prod.acme.workers.dev" });
    a!.worker = "mutated";
    expect(await environment(c.binding, "chat", "prod", t0 + 1)).toMatchObject({ worker: "ember-chat-prod" });
    expect(c.sqls).toHaveLength(1);
    db.prepare("UPDATE environments SET url = 'https://moved.example' WHERE env = 'prod'").run();
    expect(await environment(c.binding, "chat", "prod", t0 + ENV_TTL_MS)).toMatchObject({ url: "https://moved.example" });
    expect(c.sqls).toHaveLength(2);
    // Unknown environments are asked every time (a new one shows up at once).
    expect(await environment(c.binding, "chat", "staging", t0)).toBeNull();
    db.prepare("INSERT INTO environments VALUES ('chat', 'staging', 'ember-chat-staging', NULL, NULL, NULL, 1, 1)").run();
    expect(await environment(c.binding, "chat", "staging", t0 + 1)).toMatchObject({ worker: "ember-chat-staging" });
    // Another binding (another registry) never sees these rows.
    const other = seeded();
    other.db.prepare("UPDATE environments SET worker = 'ember-other' WHERE env = 'prod'").run();
    expect(await environment(other.binding, "chat", "prod", t0 + 1)).toMatchObject({ worker: "ember-other" });
  });

  it("capabilities are cached per Worker and URL", async () => {
    let probes = 0;
    const fetchImpl = (async (u: string) => {
      probes++;
      return Response.json({ ok: true, level: 3, features: [u.includes("old") ? "status" : "schema"] });
    }) as unknown as typeof fetch;
    const env = { EMBER_ADMIN_TOKEN: "t" };
    const a = await capabilities(env, { worker: "w", url: "https://new.example" }, fetchImpl, 1);
    const b = await capabilities(env, { worker: "w", url: "https://old.example" }, fetchImpl, 1);
    expect(a?.features).toEqual(["schema"]);
    expect(b?.features).toEqual(["status"]);
    await capabilities(env, { worker: "w", url: "https://new.example" }, fetchImpl, 2);
    expect(probes).toBe(2);
  });
});

describe("SPA assets", () => {
  it("app.js and app.css carry an ETag and answer 304 when it matches", async () => {
    const app = createDashboard({ html: "<html>", js: "console.log(1)", css: "body{}" });
    const js = await app.fetch(new Request(`${ORIGIN}/app.js`), {});
    const tag = js.headers.get("etag")!;
    expect(tag).toMatch(/^"[\w-]{22}"$/);
    expect(js.headers.get("cache-control")).toBe("no-cache");
    expect(await js.text()).toBe("console.log(1)");
    const again = await app.fetch(new Request(`${ORIGIN}/app.js`, { headers: { "if-none-match": `"other", W/${tag}` } }), {});
    expect(again.status).toBe(304);
    expect(again.headers.get("etag")).toBe(tag);
    expect(again.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await again.text()).toBe("");
    expect((await app.fetch(new Request(`${ORIGIN}/app.js`, { headers: { "if-none-match": '"stale"' } }), {})).status).toBe(200);
    const css = await app.fetch(new Request(`${ORIGIN}/app.css`), {});
    expect(css.headers.get("etag")).not.toBe(tag);
    const head = await app.fetch(new Request(`${ORIGIN}/app.css`, { method: "HEAD" }), {});
    expect(head.headers.get("etag")).toBe(css.headers.get("etag"));
    // A new build is a new tag.
    const next = createDashboard({ html: "<html>", js: "console.log(2)" });
    expect((await next.fetch(new Request(`${ORIGIN}/app.js`), {})).headers.get("etag")).not.toBe(tag);
  });
});
