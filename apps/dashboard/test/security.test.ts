// Dashboard contract (docs/design/contracts.md "Dashboard"): roles, write protection (Origin, CSRF, content type),
// the audit log, typed confirmations on protected environments, and runtime capability detection.
import { beforeEach, describe, expect, it } from "vitest";
import { isAdminEmail } from "../src/auth.ts";
import { clearCapabilities, CSRF_HEADER, handleApi, ROUTES, summarizeArgs, type DashboardEnv } from "../src/worker.ts";
import { seeded } from "./helpers.ts";

const ORIGIN = "https://dash.example";
const BOOKMARK = "00000000-00000008-00005119-0123456789abcdef";

interface Call {
  method: string;
  url: string;
  body: unknown;
}

/** A project Worker behind a service binding: answers like @freecorps/ember-runtime's admin API. */
function fakeProject(o: { features?: string[] | null; fail?: boolean } = {}) {
  const calls: Call[] = [];
  const svc = {
    fetch: async (r: Request | string) => {
      const req = r as Request;
      const path = new URL(req.url).pathname;
      const body = req.method === "POST" ? await req.json() : null;
      calls.push({ method: req.method, url: req.url, body });
      if (req.headers.get("authorization") !== "Bearer proj-admin") return Response.json({ ok: false, error: { code: "unauthenticated", message: "invalid admin token" } }, { status: 401 });
      if (path === "/api/_ember/capabilities") {
        if (o.features === null) return Response.json({ ok: false, error: { code: "not_found", message: "not found" } }, { status: 404 });
        return Response.json({ ok: true, level: 3, features: o.features ?? ["capabilities", "status", "bookmark", "bookmarks", "restore", "inspect", "data", "crons", "schema", "data/list", "data/insert", "data/patch", "data/replace", "data/delete", "functions", "run", "reactivity", "reactivity/profile"], auth: false, files: false, system: true });
      }
      if (o.fail) return Response.json({ ok: false, error: { code: "restore_failed", message: "boom" } }, { status: 500 });
      if (path === "/api/_ember/bookmark") return Response.json({ ok: true, shard: (body as { shard: string }).shard, bookmark: { id: 1, at: 1, bookmark: BOOKMARK, reason: "manual" } });
      if (path === "/api/_ember/run") return Response.json({ ok: true, value: { who: (body as { as?: { subject: string } }).as?.subject ?? null }, ms: 1, type: "query" });
      if (path.startsWith("/api/_ember/data/")) return Response.json({ ok: true, value: path.endsWith("/delete") ? { deleted: 1 } : "messages_1" });
      if (path === "/api/_ember/restore") return Response.json({ ok: true, shard: (body as { shard: string }).shard, restoredTo: BOOKMARK, undo: BOOKMARK, version: 3, epoch: "e", schemaVersion: "abc" });
      if (path === "/api/_ember/inspect") return Response.json({ ok: false, error: { code: "not_found", message: "not found" } }, { status: 404 });
      return Response.json({ ok: false, error: { code: "not_found", message: "not found" } }, { status: 404 });
    },
  };
  return { svc, calls };
}

function setup(o: { features?: string[] | null; fail?: boolean; env?: Partial<DashboardEnv> } = {}) {
  const { db, binding } = seeded();
  const project = fakeProject(o);
  const env: DashboardEnv = {
    DASHBOARD_TOKEN: "dash-secret",
    DASHBOARD_READ_TOKEN: "read-secret",
    REGISTRY: binding,
    EMBER_ADMIN_TOKEN: "proj-admin",
    EMBER_SERVICES: JSON.stringify({ "ember-chat-prod": "EMBER_SVC_0", "ember-chat-dev": "EMBER_SVC_1" }),
    EMBER_SVC_0: project.svc,
    EMBER_SVC_1: project.svc,
    ...o.env,
  };
  const call = (method: string, path: string, init: { headers?: Record<string, string>; body?: unknown } = {}) => {
    const url = new URL(`${ORIGIN}${path}`);
    const req = new Request(url, { method, headers: init.headers ?? {}, ...(init.body !== undefined ? { body: typeof init.body === "string" ? init.body : JSON.stringify(init.body) } : {}) });
    return handleApi(req, env, url);
  };
  const me = async (token = "dash-secret") => (await (await call("GET", "/api/me", { headers: { authorization: `Bearer ${token}` } })).json()) as { csrf: string; role: string; actor: string };
  /** A write the way the SPA sends it. */
  const post = async (path: string, body: unknown, o2: { token?: string; headers?: Record<string, string> } = {}) => {
    const token = o2.token ?? "dash-secret";
    const { csrf } = await me(token);
    return call("POST", path, {
      headers: { authorization: `Bearer ${token}`, origin: ORIGIN, "sec-fetch-site": "same-origin", "content-type": "application/json", [CSRF_HEADER]: csrf, ...o2.headers },
      body,
    });
  };
  const audit = () => db.prepare("SELECT * FROM audit_log ORDER BY id").all() as Array<Record<string, unknown>>;
  return { db, env, project, call, me, post, audit };
}

beforeEach(() => clearCapabilities());

const writes = ROUTES.filter((r) => r.method !== "GET");
/** A valid body per write route (on the dev environment: no typed confirmation). */
const bodies: Record<string, Record<string, unknown>> = {
  "/api/bookmark": { project: "chat", env: "dev", shard: "org:acme", label: "before-import" },
  "/api/restore": { project: "chat", env: "dev", shard: "org:acme", bookmark: BOOKMARK },
  "/api/doc/insert": { project: "chat", env: "dev", shard: "org:acme", table: "messages", doc: { body: "secret plans", author: "ana" } },
  "/api/doc/patch": { project: "chat", env: "dev", shard: "org:acme", table: "messages", id: "messages_1", fields: { body: "secret plans" } },
  "/api/doc/replace": { project: "chat", env: "dev", shard: "org:acme", table: "messages", id: "messages_1", doc: { body: "secret plans", author: "ana" } },
  "/api/doc/delete": { project: "chat", env: "dev", shard: "org:acme", table: "messages", ids: ["messages_1"] },
  "/api/fn/run": { project: "chat", env: "dev", shard: "org:acme", fn: "messages:list", args: { channel: "secret plans", password: "hunter2" } },
};

describe("roles", () => {
  it("dashboard token → admin, read token → read", async () => {
    const t = setup();
    expect(await t.me()).toMatchObject({ role: "admin", actor: "token" });
    expect(await t.me("read-secret")).toMatchObject({ role: "read", actor: "read-token" });
    expect((await t.call("GET", "/api/me", { headers: { authorization: "Bearer nope" } })).status).toBe(401);
  });

  it("Access emails are admins only when DASHBOARD_ADMINS lists them", () => {
    expect(isAdminEmail(undefined, "ana@x.com")).toBe(false);
    expect(isAdminEmail("ana@x.com, bob@y.com", "Ana@X.com")).toBe(true);
    expect(isAdminEmail("@x.com", "eve@x.com")).toBe(true);
    expect(isAdminEmail("@x.com", "eve@evilx.com")).toBe(false);
    expect(isAdminEmail("@x.com", "eve@x.com.evil")).toBe(false);
    expect(isAdminEmail("*", "anyone@z.io")).toBe(true);
    expect(isAdminEmail("ana@x.com", undefined)).toBe(false);
  });

  it("every write route is admin-only, CSRF-checked and audited (the table is the contract)", () => {
    expect(writes.length).toBeGreaterThan(0);
    for (const r of writes) {
      expect(r.role).toBe("admin");
      expect(bodies[r.path], `test body for ${r.path}`).toBeDefined();
    }
    for (const r of ROUTES.filter((x) => x.method === "GET")) expect(r.role).toBe("read");
  });
});

describe.each(writes.map((r) => [r.path, r] as const))("write %s", (path) => {
  const body = () => bodies[path]!;

  it("read role cannot write; the refusal is audited", async () => {
    const t = setup();
    const res = await t.post(path, body(), { token: "read-secret" });
    expect(res.status).toBe(403);
    expect((await res.json()) as unknown).toMatchObject({ error: { code: "forbidden" } });
    expect(t.project.calls.filter((c) => c.method === "POST")).toEqual([]);
    expect(t.audit()).toMatchObject([{ actor: "read-token", role: "read", outcome: "denied", status: 403, error: "forbidden", project: "chat", env: "dev" }]);
  });

  it("refuses writes without the SPA's Origin, fetch metadata, content type and CSRF token", async () => {
    const t = setup();
    const { csrf } = await t.me();
    const good = { authorization: "Bearer dash-secret", origin: ORIGIN, "sec-fetch-site": "same-origin", "content-type": "application/json", [CSRF_HEADER]: csrf };
    const without = (k: string) => Object.fromEntries(Object.entries(good).filter(([h]) => h !== k));
    const cases: Array<[Record<string, string>, number, string]> = [
      [without("origin"), 403, "bad_origin"],
      [{ ...good, origin: "https://evil.example" }, 403, "bad_origin"],
      [{ ...good, origin: "null" }, 403, "bad_origin"],
      [{ ...good, "sec-fetch-site": "cross-site" }, 403, "bad_origin"],
      [{ ...good, "sec-fetch-site": "same-site" }, 403, "bad_origin"],
      [{ ...good, "content-type": "text/plain" }, 415, "bad_content_type"],
      [{ ...good, "content-type": "application/x-www-form-urlencoded" }, 415, "bad_content_type"],
      [without(CSRF_HEADER), 403, "bad_csrf"],
      [{ ...good, [CSRF_HEADER]: `${csrf[0] === "A" ? "B" : "A"}${csrf.slice(1)}` }, 403, "bad_csrf"],
    ];
    for (const [headers, status, code] of cases) {
      const res = await t.call("POST", path, { headers, body: body() });
      expect([res.status, ((await res.json()) as { error: { code: string } }).error.code], JSON.stringify(headers)).toEqual([status, code]);
    }
    // Another identity's token does not pass either.
    const readCsrf = (await t.me("read-secret")).csrf;
    expect(readCsrf).not.toBe(csrf);
    expect((await t.call("POST", path, { headers: { ...good, [CSRF_HEADER]: readCsrf }, body: body() })).status).toBe(403);
    expect(t.project.calls.filter((c) => c.method === "POST")).toEqual([]);
    expect(t.audit().every((r) => r.outcome === "denied")).toBe(true);
    expect(t.audit()).toHaveLength(cases.length + 1);
    // DASHBOARD_ORIGIN replaces the request's own origin.
    const t2 = setup({ env: { DASHBOARD_ORIGIN: "https://dash.acme.com" } });
    expect((await t2.post(path, body())).status).toBe(403);
    expect((await t2.post(path, body(), { headers: { origin: "https://dash.acme.com" } })).status).toBe(200);
  });

  it("runs as admin and audits who, where, what and the outcome", async () => {
    const t = setup();
    const res = await t.post(path, body());
    expect(res.status).toBe(200);
    expect(res.headers.get("x-ember-audit-id")).toBe("1");
    const posts = t.project.calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toMatch(/^https:\/\/ember-chat-dev\.internal\/api\/_ember\//);
    const [row] = t.audit();
    expect(row).toMatchObject({ actor: "token", via: "token", role: "admin", project: "chat", env: "dev", shard: "org:acme", outcome: "ok", status: 200, error: null });
    expect(typeof row!.target).toBe("string");
    // Document values are user data: the log keeps table, ids and field names only; secrets never.
    if (path.startsWith("/api/doc/")) expect(String(row!.args)).not.toContain("secret plans");
    expect(String(row!.args)).not.toContain("hunter2");
    expect(typeof row!.at).toBe("number");
    expect(row!.finished_at).toBeGreaterThanOrEqual(row!.at as number);
    expect(JSON.parse(String(row!.args))).toBeTypeOf("object");
    // The log is readable by any signed-in role.
    const list = (await (await t.call("GET", "/api/audit?project=chat&env=dev", { headers: { authorization: "Bearer read-secret" } })).json()) as { entries: unknown[] };
    expect(list.entries).toHaveLength(1);
  });

  it("a failing project call is audited as an error", async () => {
    const t = setup({ fail: true });
    const res = await t.post(path, body());
    expect(res.status).toBe(500);
    expect(t.audit()).toMatchObject([{ outcome: "error", status: 500, error: "restore_failed: boom" }]);
  });

  it("nothing reaches the project when the audit log cannot be written", async () => {
    const t = setup();
    const { csrf } = await t.me();
    t.db.exec("DROP TABLE audit_log; CREATE TABLE audit_log (id INTEGER PRIMARY KEY, only_this TEXT)");
    const res = await t.call("POST", path, {
      headers: { authorization: "Bearer dash-secret", origin: ORIGIN, "content-type": "application/json", [CSRF_HEADER]: csrf },
      body: body(),
    });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("audit_unavailable");
    expect(t.project.calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  it("an older runtime without the endpoint answers runtime_outdated, before anything is audited", async () => {
    const t = setup({ features: ["capabilities", "status"] });
    const res = await t.post(path, body());
    expect(res.status).toBe(501);
    expect((await res.json()) as unknown).toMatchObject({ error: { code: "runtime_outdated" } });
    expect(t.project.calls.filter((c) => c.method === "POST")).toEqual([]);
    expect(t.audit()).toEqual([]);
  });
});

describe("typed confirmation on protected environments", () => {
  it("restore on prod needs the shard name typed; dev does not", async () => {
    const t = setup();
    const prod = { project: "chat", env: "prod", shard: "org:acme", bookmark: BOOKMARK };
    const none = await t.post("/api/restore", prod);
    expect(none.status).toBe(428);
    expect((await none.json()) as unknown).toMatchObject({ error: { code: "confirmation_required", data: { expected: "org:acme" } } });
    expect((await t.post("/api/restore", { ...prod, confirm: "org:acm" })).status).toBe(428);
    expect(t.project.calls.filter((c) => c.method === "POST")).toEqual([]);
    expect(t.audit()).toEqual([]);
    expect((await t.post("/api/restore", { ...prod, confirm: "org:acme" })).status).toBe(200);
    expect((await t.post("/api/restore", { ...prod, env: "dev" })).status).toBe(200);
    // Non-destructive writes never ask.
    expect((await t.post("/api/bookmark", { project: "chat", env: "prod", shard: "org:acme" })).status).toBe(200);
    expect(t.audit().map((r) => [r.action, r.env, r.outcome])).toEqual([
      ["shard.restore", "prod", "ok"],
      ["shard.restore", "dev", "ok"],
      ["bookmark.create", "prod", "ok"],
    ]);
  });

  it("DASHBOARD_PROTECTED_ENVS picks the environments", async () => {
    const t = setup({ env: { DASHBOARD_PROTECTED_ENVS: "dev" } });
    expect((await t.post("/api/restore", { project: "chat", env: "dev", shard: "org:acme", bookmark: BOOKMARK })).status).toBe(428);
    expect((await t.post("/api/restore", { project: "chat", env: "prod", shard: "org:acme", bookmark: BOOKMARK })).status).toBe(200);
    expect(await t.me()).toMatchObject({ protectedEnvs: ["dev"] });
  });
});

describe("document writes", () => {
  it("delete on a protected env needs the table name typed; internal tables are refused before the project", async () => {
    const t = setup();
    const prod = { project: "chat", env: "prod", shard: "org:acme", table: "messages", ids: ["messages_1"] };
    const r = await t.post("/api/doc/delete", prod);
    expect([r.status, ((await r.json()) as { error: { data: { expected: string } } }).error.data.expected]).toEqual([428, "messages"]);
    expect((await t.post("/api/doc/delete", { ...prod, confirm: "messages" })).status).toBe(200);
    // Edits are not destructive: no confirmation on prod.
    expect((await t.post("/api/doc/patch", { ...prod, ids: undefined, id: "messages_1", fields: { body: "x" } })).status).toBe(200);
    for (const table of ["_jobs", "rl$buckets", ""]) expect((await t.post("/api/doc/insert", { ...prod, table, doc: {} })).status).toBe(400);
    expect((await t.post("/api/doc/delete", { ...prod, ids: [] })).status).toBe(400);
    expect((await t.post("/api/doc/patch", { ...prod, id: "messages_1", fields: [1] })).status).toBe(400);
    const posts = t.project.calls.filter((c) => c.method === "POST");
    expect(posts.map((c) => [new URL(c.url).pathname, c.body])).toEqual([
      ["/api/_ember/data/delete", { shard: "org:acme", table: "messages", ids: ["messages_1"] }],
      ["/api/_ember/data/patch", { shard: "org:acme", table: "messages", id: "messages_1", fields: { body: "x" } }],
    ]);
    expect(t.audit().map((a) => [a.action, a.target, a.args])).toEqual([
      ["doc.delete", "messages_1", JSON.stringify({ table: "messages", ids: ["messages_1"] })],
      ["doc.patch", "messages_1", JSON.stringify({ table: "messages", id: "messages_1", fields: ["body"] })],
    ]);
  });
});

describe("function runner", () => {
  it("acting as a user is its own audit action; the identity goes to the project, never a token", async () => {
    const t = setup();
    const r = await t.post("/api/fn/run", { project: "chat", env: "prod", shard: "org:acme", fn: "auth:whoami", args: {}, as: { subject: "user_ana", claims: { role: "member" } } });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { value: { who: string } }).value.who).toBe("user_ana");
    const post = t.project.calls.find((c) => c.method === "POST")!;
    expect(post.body).toEqual({ shard: "org:acme", fn: "auth:whoami", args: {}, as: { subject: "user_ana", claims: { role: "member" } } });
    expect(t.audit()).toMatchObject([{ action: "function.run_as", target: "auth:whoami", outcome: "ok" }]);
    expect(JSON.parse(String(t.audit()[0]!.args))).toEqual({ fn: "auth:whoami", args: {}, as: "user_ana" });
    // Plain runs are function.run; bad input never reaches the project.
    await t.post("/api/fn/run", { project: "chat", env: "prod", shard: "org:acme", fn: "messages:list" });
    expect(t.audit().map((a) => a.action)).toEqual(["function.run_as", "function.run"]);
    for (const bad of [{ fn: "_ember:dataInsert" }, { fn: "a b" }, { fn: "x:y", args: [1] }, { fn: "x:y", as: { subject: "" } }, { fn: "x:y", as: { subject: "u", claims: [1] } }]) {
      expect((await t.post("/api/fn/run", { project: "chat", env: "prod", shard: "org:acme", ...bad })).status).toBe(400);
    }
    expect(t.project.calls.filter((c) => c.method === "POST")).toHaveLength(2);
  });
});

describe("input validation", () => {
  it("bad bodies are refused before the project is called", async () => {
    const t = setup();
    for (const [path, body, code] of [
      ["/api/restore", { project: "chat", env: "dev", shard: "org:acme", bookmark: "x" }, "bad_bookmark"],
      ["/api/restore", { project: "chat", env: "dev", shard: "no colon", bookmark: BOOKMARK }, "bad_shard"],
      ["/api/bookmark", { project: "Chat", env: "dev", shard: "org:acme" }, "bad_request"],
      ["/api/bookmark", { project: "chat", env: "dev", shard: "org:acme", label: "a b" }, "bad_request"],
      ["/api/bookmark", "[1]", "bad_request"],
      ["/api/bookmark", "not json", "bad_request"],
    ] as const) {
      const res = await t.post(path, body);
      expect([res.status, ((await res.json()) as { error: { code: string } }).error.code], JSON.stringify(body)).toEqual([400, code]);
    }
    expect((await t.post("/api/bookmark", { project: "chat", env: "nope", shard: "org:acme" })).status).toBe(404);
    expect(t.project.calls.filter((c) => c.method === "POST")).toEqual([]);
  });
});

describe("audit args", () => {
  it("summaries drop secrets and bound sizes", () => {
    const s = summarizeArgs({ name: "API_KEY", value: "hunter2", password: "p", nested: { accessToken: "t", ok: 1 }, long: "x".repeat(500), list: Array.from({ length: 20 }, (_, i) => i) }) as Record<string, unknown>;
    expect(s.value).toBe("[redacted]");
    expect(s.password).toBe("[redacted]");
    expect((s.nested as Record<string, unknown>).accessToken).toBe("[redacted]");
    expect((s.nested as Record<string, unknown>).ok).toBe(1);
    expect(String(s.long)).toMatch(/… \(500 chars\)$/);
    expect((s.list as unknown[]).length).toBe(11);
    expect(JSON.stringify(s)).not.toMatch(/hunter2/);
  });
});

describe("runtime compatibility", () => {
  it("a runtime from before capabilities is level 1; an unknown admin path becomes runtime_outdated", async () => {
    const t = setup({ features: null });
    const h = { headers: { authorization: "Bearer read-secret" } };
    const caps = (await (await t.call("GET", "/api/capabilities?project=chat&env=prod", h)).json()) as { level: number; features: string[] };
    expect(caps.level).toBe(1);
    expect(caps.features).toContain("inspect");
    // inspect is in the legacy list, but this runtime 404s it: the generic 404 is translated.
    const res = await t.call("GET", "/api/inspect?project=chat&env=prod&shard=org:acme", h);
    expect(res.status).toBe(501);
    expect((await res.json()) as unknown).toMatchObject({ error: { code: "runtime_outdated", data: { feature: "inspect" } } });
  });

  it("/api/capabilities passes the project's refusal through (not a generic 502)", async () => {
    const t = setup({ env: { EMBER_ADMIN_TOKEN: "" } });
    const res = await t.call("GET", "/api/capabilities?project=chat&env=prod", { headers: { authorization: "Bearer read-secret" } });
    expect([res.status, ((await res.json()) as { error: { code: string } }).error.code]).toEqual([412, "no_admin_token"]);
    const t2 = setup({ env: { EMBER_ADMIN_TOKEN: "wrong" } });
    const res2 = await t2.call("GET", "/api/capabilities?project=chat&env=prod", { headers: { authorization: "Bearer read-secret" } });
    expect([res2.status, ((await res2.json()) as { error: { code: string } }).error.code]).toEqual([401, "unauthenticated"]);
  });

  it("a feature the runtime lists as missing is refused without calling it", async () => {
    const t = setup({ features: ["capabilities", "status"] });
    const res = await t.call("GET", "/api/bookmarks?project=chat&env=prod&shard=org:acme", { headers: { authorization: "Bearer read-secret" } });
    expect(res.status).toBe(501);
    expect(t.project.calls.map((c) => new URL(c.url).pathname)).toEqual(["/api/_ember/capabilities"]);
  });
});

describe("per-project admin tokens", () => {
  it("the token `ember deploy` stores per Worker wins over the shared one; EMBER_ADMIN_TOKENS wins over both", async () => {
    const { adminTokenFor, adminTokenKey } = await import("../src/projects.ts");
    expect(adminTokenKey("ember-chat-prod")).toBe("EMBER_ADMIN_TOKEN__EMBER_CHAT_PROD");
    const env = { EMBER_ADMIN_TOKEN: "shared", [adminTokenKey("ember-chat-prod")]: "own" };
    expect(adminTokenFor(env, "ember-chat-prod")).toBe("own");
    expect(adminTokenFor(env, "ember-other-prod")).toBe("shared");
    expect(adminTokenFor({ ...env, EMBER_ADMIN_TOKENS: JSON.stringify({ "ember-chat-prod": "mapped" }) }, "ember-chat-prod")).toBe("mapped");
    // Reaches the project with it.
    const t = setup({ env: { EMBER_ADMIN_TOKEN: "wrong", [adminTokenKey("ember-chat-prod")]: "proj-admin" } });
    expect((await t.call("GET", "/api/capabilities?project=chat&env=prod", { headers: { authorization: "Bearer read-secret" } })).status).toBe(200);
  });
});

describe("catalog search", () => {
  it("?q= filters shards by name, with LIKE wildcards escaped", async () => {
    const t = setup();
    t.db.exec("INSERT INTO shards VALUES ('chat', 'prod', 'org:beta_1', 'org', 'beta_1', 'abc', 1, 1, 1), ('chat', 'prod', 'org:betaX1', 'org', 'betaX1', 'abc', 1, 1, 1)");
    const h = { headers: { authorization: "Bearer read-secret" } };
    const names = async (q: string) => ((await (await t.call("GET", `/api/shards?project=chat&env=prod&q=${encodeURIComponent(q)}`, h)).json()) as { shards: Array<{ shard: string }> }).shards.map((s) => s.shard).sort();
    expect(await names("beta")).toEqual(["org:betaX1", "org:beta_1"]);
    expect(await names("a_1")).toEqual(["org:beta_1"]);
    expect(await names("%")).toEqual([]);
  });
});
