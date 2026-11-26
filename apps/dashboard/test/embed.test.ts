// Embed blocks on the dashboard's Worker (embed.ts): the ticket (`GET /api/dash/embed`, read role), the page
// (`GET /embed`: ticket checked, fetched from the project's `dashboards/embed`, served under the sandbox CSP with the
// hashes of its inline scripts), and writes from an embed page (`POST /api/dash/run` with `embed`: the block must list
// the function; audited as `dashboard.embed.run`).
import { beforeEach, describe, expect, it } from "vitest";
import { clearCapabilities, CSP, createDashboard, embedCsp, inlineScriptHashes, type DashboardEnv } from "../src/worker.ts";
import { frameAncestors } from "../src/embed.ts";
import { registry } from "./helpers.ts";

const PAGE = `<!doctype html><html><body><p>hi</p><script>window.a = 1;\r\n</script><script type="module">console.log(2)</script><script src="https://evil.example/x.js"></script></body></html>`;
const SPEC = {
  key: "agent",
  component: "agent",
  label: "Agent",
  icon: "bot",
  scope: "shard",
  tabs: [{ id: "lab", label: "Lab", blocks: [{ kind: "embed", id: "play", route: "/dashboard/playground", path: "/agent/dashboard/playground", height: "auto", functions: { "dashboard:threads": "@agent/dashboard:threads", "lib:send": "@agent/lib:send" } }] }],
  functions: {
    "@agent/dashboard:threads": { type: "query", args: { kind: "object", fields: {} } },
    "@agent/lib:send": { type: "mutation", args: { kind: "object", fields: {} } },
    "@agent/lib:deleteThread": { type: "mutation", args: { kind: "object", fields: {} }, destructive: true },
  },
};

function project(o: { page?: () => Response; features?: string[] } = {}) {
  const calls: string[] = [];
  const posts: unknown[] = [];
  const svc = {
    fetch: async (r: Request | string) => {
      const req = r as Request;
      const url = new URL(req.url);
      calls.push(`${req.method} ${url.pathname}${url.search} ${req.headers.get("authorization")}`);
      const p = url.pathname.replace("/api/_ember/", "");
      if (p === "capabilities") return Response.json({ ok: true, level: 16, features: o.features ?? ["capabilities", "dashboards", "dashboards/query", "dashboards/run", "dashboards/embed"] });
      if (p === "dashboards") return Response.json({ ok: true, dashboards: [SPEC] });
      if (p === "dashboards/run") {
        posts.push(await req.json());
        return Response.json({ ok: true, value: "sent", ms: 1, type: "mutation" });
      }
      if (p === "dashboards/embed") {
        if (url.searchParams.get("dashboard") !== "agent" || url.searchParams.get("route") !== "/dashboard/playground") return Response.json({ ok: false, error: { code: "unknown_embed", message: "no embed block for that route" } }, { status: 404 });
        return o.page ? o.page() : new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8", "set-cookie": "x=1", "content-security-policy": "script-src *" } });
      }
      return Response.json({ ok: false, error: { code: "not_found", message: "not found" } }, { status: 404 });
    },
  };
  return { svc, calls, posts };
}

const ORIGIN = "https://dash.example";
function setup(o: Parameters<typeof project>[0] = {}) {
  const p = project(o);
  const env: DashboardEnv = {
    DASHBOARD_TOKEN: "dash-secret",
    DASHBOARD_READ_TOKEN: "read-secret",
    REGISTRY: registry(),
    EMBER_ADMIN_TOKEN: "proj-admin",
    EMBER_SERVICES: JSON.stringify({ "ember-chat-prod": "EMBER_SVC_0" }),
    EMBER_SVC_0: p.svc,
  };
  const app = createDashboard({ html: "<!doctype html>", js: "" });
  const fetch = (path: string, init: RequestInit = {}) => app.fetch(new Request(`${ORIGIN}${path}`, init), env);
  const ticket = async (q: Record<string, string> = { dashboard: "agent", route: "/dashboard/playground" }, token = "read-secret") => {
    const res = await fetch(`/api/dash/embed?${new URLSearchParams({ project: "chat", env: "prod", ...q })}`, { headers: { authorization: `Bearer ${token}` } });
    return { status: res.status, body: (await res.json()) as { ok: boolean; url: string; expires: number; error?: { code: string } } };
  };
  return { ...p, env, fetch, ticket };
}

beforeEach(() => clearCapabilities());

describe("embed pages", () => {
  it("a read role gets a ticket; the page is served from the project with the sandbox CSP and its script hashes", async () => {
    const t = setup();
    const tk = await t.ticket();
    expect(tk.status).toBe(200);
    expect(tk.body.url).toMatch(/^\/embed\/chat\/prod\/dashboard\/playground\?dashboard=agent&exp=\d+&sig=[\w-]{43}$/);
    expect(tk.body.expires).toBeGreaterThan(Date.now());
    // The iframe's request carries no credentials: the ticket is the authorization.
    const res = await t.fetch(tk.body.url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(PAGE);
    expect(t.calls.filter((c) => c.includes("dashboards/embed"))).toEqual(["GET /api/_ember/dashboards/embed?dashboard=agent&route=%2Fdashboard%2Fplayground Bearer proj-admin"]);
    const csp = res.headers.get("content-security-policy")!;
    // The two inline scripts (CRLF hashed as LF, as the browser does), never the external one.
    const hashes = await inlineScriptHashes(PAGE);
    expect(hashes).toHaveLength(2);
    expect(hashes![0]).toBe(`'sha256-${Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("window.a = 1;\n"))).toString("base64")}'`);
    expect(csp).toBe(embedCsp(hashes!, [ORIGIN]));
    expect(csp).toContain("sandbox allow-scripts;");
    expect(csp).not.toContain("allow-same-origin");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain(`frame-ancestors ${ORIGIN}`);
    expect(csp).not.toMatch(/unsafe-inline'[^;]*;.*script|script-src[^;]*(unsafe|\*|https?:)/);
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    // frame-ancestors: DASHBOARD_ORIGIN's origins when set, never anything that could add a directive.
    const u = new URL(ORIGIN);
    expect(frameAncestors({ DASHBOARD_ORIGIN: "https://a.example, https://b.example:8443/" }, u)).toEqual(["https://a.example", "https://b.example:8443"]);
    expect(frameAncestors({ DASHBOARD_ORIGIN: "https://a.example; script-src *" }, u)).toEqual(["'none'"]);
    // The SPA may frame its own origin (and nothing else may frame the SPA).
    expect(CSP).toContain("frame-src 'self'");
    expect(CSP).toContain("frame-ancestors 'none'");
  });

  it("the ticket needs a login; the page needs a valid, unexpired ticket for exactly that page", async () => {
    const t = setup();
    expect((await t.ticket(undefined, "wrong")).status).toBe(401);
    const { url } = (await t.ticket()).body;
    const u = new URL(url, ORIGIN);
    const variant = (k: string, v: string) => {
      const scope: Record<string, string> = { project: "chat", env: "prod", route: "/dashboard/playground" };
      const q = new URLSearchParams(u.search);
      if (k in scope) scope[k] = v;
      else q.set(k, v);
      return `/embed/${scope.project}/${scope.env}${scope.route}?${q}`;
    };
    // Another page, project, dashboard, a moved expiry or a changed signature: refused, nothing fetched.
    const before = t.calls.length;
    for (const path of [variant("route", "/dashboard/other"), variant("dashboard", "workpool"), variant("env", "dev"), variant("exp", String(Number(u.searchParams.get("exp")) + 1000)), variant("sig", "A".repeat(43)), "/embed/chat/prod/dashboard/playground?dashboard=agent"]) {
      const res = await t.fetch(path);
      expect(res.status, path).toBe(403);
      expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(res.headers.get("content-security-policy")).toBe(`sandbox; default-src 'none'; frame-ancestors ${ORIGIN}`);
    }
    expect(t.calls.length).toBe(before);
    expect((await t.fetch(url, { method: "POST" })).status).toBe(405);
  });

  it("an expired ticket is refused", async () => {
    const t = setup();
    const { url } = (await t.ticket()).body;
    const real = Date.now;
    Date.now = () => real() + 6 * 60_000;
    try {
      const res = await t.fetch(url);
      expect(res.status).toBe(403);
      expect(await res.text()).toMatch(/expired/);
    } finally {
      Date.now = real;
    }
  });

  it("paths are validated: no .., no scheme or host, no query; malformed scopes are a 400", async () => {
    const t = setup();
    for (const route of ["/a/../dashboard/playground", "/./x", "https://evil.example/x", "//evil.example/x", "dashboard/playground", "/x?y=1", "/x#y", "/%2e%2e/x", "/a//b"]) {
      const r = await t.ticket({ dashboard: "agent", route });
      expect(r.status, route).toBe(400);
      expect(r.body.error!.code).toBe("bad_request");
    }
    expect((await t.ticket({ dashboard: "../x", route: "/dashboard/playground" })).status).toBe(400);
    // A forged /embed/... with an escaped route is refused before the signature is even checked.
    expect((await t.fetch("/embed/chat/prod/a%2F..%2Fx?dashboard=agent&exp=1&sig=x")).status).toBe(400);
    // `..` segments (plain or encoded) are resolved by the URL parser into another scope, whose signature fails: a
    // ticket for one page never serves another.
    const { url } = (await t.ticket()).body;
    const sig = new URL(url, ORIGIN).search;
    for (const p of ["/embed/chat/prod/x/../dashboard/playground", "/embed/chat/prod/dashboard/playground/..", "/embed/chat/prod/%2e%2e/prod/dashboard/playground", "/embed/chat/../chat/prod/dashboard/playground/%2E%2E/playground"]) {
      const res = await t.fetch(`${p}${sig}`);
      // The one that resolves back to the same page is that page; every other is refused.
      if (new URL(p, ORIGIN).pathname === "/embed/chat/prod/dashboard/playground") expect(res.status, p).toBe(200);
      else expect([400, 403], p).toContain(res.status);
    }
  });

  it("an unknown component or route is a 404 from the project; an older runtime says so; only text/html is served", async () => {
    const t = setup();
    const r = await t.ticket({ dashboard: "agent", route: "/dashboard/other" });
    const res = await t.fetch(r.body.url);
    expect(res.status).toBe(404);
    expect(await res.text()).toMatch(/unknown_embed/);
    expect((await t.fetch((await t.ticket({ dashboard: "nope", route: "/dashboard/playground" })).body.url)).status).toBe(404);
    // An unknown project: 404 at the ticket.
    const unknown = await t.fetch(`/api/dash/embed?project=nope&env=prod&dashboard=agent&route=%2Fx`, { headers: { authorization: "Bearer read-secret" } });
    expect(unknown.status).toBe(404);
    // An older runtime (no dashboards/embed): the ticket says "update the runtime".
    clearCapabilities();
    const old = setup({ features: ["capabilities", "dashboards"] });
    const o = await old.ticket();
    expect(o.status).toBe(501);
    expect(o.body.error!.code).toBe("runtime_outdated");
    // A route answering JSON (or anything but HTML) is not served as a page.
    clearCapabilities();
    const json = setup({ page: () => Response.json({ secret: 1 }) });
    const j = await json.fetch((await json.ticket()).body.url);
    expect(j.status).toBe(502);
    expect(await j.text()).toMatch(/not text\/html/);
    // Too large.
    clearCapabilities();
    const big = setup({ page: () => new Response("x".repeat(1024 * 1024 + 1), { headers: { "content-type": "text/html" } }) });
    expect((await big.fetch((await big.ticket()).body.url)).status).toBe(502);
    // A page without inline scripts runs none.
    clearCapabilities();
    const plain = setup({ page: () => new Response("<p>static</p>", { headers: { "content-type": "text/html" } }) });
    expect((await plain.fetch((await plain.ticket()).body.url)).headers.get("content-security-policy")).toContain("script-src 'none'");
  });

  it("writes from an embed page: only functions the block lists, audited as dashboard.embed.run", async () => {
    const t = setup();
    const me = (await (await t.fetch("/api/me", { headers: { authorization: "Bearer dash-secret" } })).json()) as { csrf: string };
    const run = (body: Record<string, unknown>, token = "dash-secret") =>
      t.fetch("/api/dash/run", { method: "POST", headers: { authorization: `Bearer ${token}`, origin: ORIGIN, "content-type": "application/json", "x-ember-csrf": me.csrf }, body: JSON.stringify({ project: "chat", env: "prod", shard: "org:acme", dashboard: "agent", ...body }) });
    const ok = await run({ fn: "@agent/lib:send", args: { text: "hi" }, embed: "play" });
    expect(ok.status).toBe(200);
    expect(t.posts).toEqual([{ shard: "org:acme", dashboard: "agent", fn: "@agent/lib:send", args: { text: "hi" }, destructive: false }]);
    // In the spec but not in the block: refused (the SPA's bridge refuses it first).
    const outside = await run({ fn: "@agent/lib:deleteThread", args: {}, embed: "play" });
    expect(outside.status).toBe(403);
    expect(((await outside.json()) as { error: { message: string } }).error.message).toMatch(/embed block "play"/);
    expect((await run({ fn: "@agent/lib:send", args: {}, embed: "other" })).status).toBe(403);
    expect((await run({ fn: "@agent/lib:send", args: {}, embed: "Bad Id" })).status).toBe(400);
    // The read role cannot write, from an embed or not (audited as a denial of the embed action).
    expect((await run({ fn: "@agent/lib:send", args: {}, embed: "play" }, "read-secret")).status).toBe(403);
    const audit = (await (await t.fetch("/api/audit", { headers: { authorization: "Bearer dash-secret" } })).json()) as { entries: Array<{ action: string; outcome: string; target: string | null; args: unknown }> };
    const embedRows = audit.entries.filter((e) => e.action === "dashboard.embed.run");
    expect(embedRows.length).toBeGreaterThanOrEqual(2);
    expect(embedRows.find((e) => e.target === "@agent/lib:send" && e.outcome === "ok")).toBeTruthy();
    expect(String(embedRows.find((e) => e.outcome === "ok")!.args)).toContain(`"embed":"play"`);
  });
});
