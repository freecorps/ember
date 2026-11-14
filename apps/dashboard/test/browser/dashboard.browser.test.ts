// The dashboard SPA in a real browser (headless Chromium through playwright-core; reuses an installed Playwright
// browser, skipped when there is none). The real dashboard Worker (createDashboard) runs behind a Node HTTP server,
// over a node:sqlite registry and fake project Workers. Checks: token sign-in, the strict CSP holds (no violation,
// no inline code), keyboard navigation, the typed confirmation of a destructive action on a protected environment,
// the audit log, the read role, "update the runtime" for an older project, user data rendered as text, the theme.
// EMBER_DASHBOARD_SCREENSHOTS=<dir> saves screenshots of each screen.
import { mkdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { readFileSync, existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDashboard, type DashboardEnv } from "../../src/worker.ts";
import { seeded } from "../helpers.ts";
import { fakeProject, XSS } from "./fake-project.ts";

const here = dirname(fileURLToPath(import.meta.url));
const executable = (() => {
  try {
    return chromium.executablePath();
  } catch {
    return "";
  }
})();
const hasBrowser = !!executable && existsSync(executable);
const shots = process.env.EMBER_DASHBOARD_SCREENSHOTS;

const HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>Ember Dashboard</title><link rel="stylesheet" href="/app.css" /></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>`;

/** Analytics Engine SQL API, answered by the SQL's shape (the dashboard Worker calls the global fetch). */
const realFetch = globalThis.fetch;
function fakeAnalytics(): typeof fetch {
  const now = Date.now();
  const at = (i: number) => new Date(now - (12 - i) * 15 * 60_000).toISOString().replace("T", " ").slice(0, 19);
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = String(input instanceof Request ? input.url : input);
    if (!u.startsWith("https://api.cloudflare.com/client/v4/accounts/acc/analytics_engine/sql")) return realFetch(input, init);
    const sql = String(init?.body ?? "");
    let data: Array<Record<string, unknown>> = [];
    if (sql.includes("toStartOfInterval")) data = Array.from({ length: 12 }, (_, i) => ({ t: at(i), calls: 10 + i * 3, errors: i % 4 === 0 ? 2 : 0, p50: 3 + (i % 3), p95: 12 + i, rows_read: 40 + i * 5, rows_written: i }));
    else if (sql.includes("blob6 = 'error'")) data = [{ t: at(11), code: "MessageTooLong", shard: "org:acme", kind: "mutation", ms: 4.2 }];
    else if (sql.includes("blob8 AS shard")) data = [{ shard: "org:acme", calls: 300, errors: 3, rows_read: 900, rows_written: 40 }];
    else data = [{ project: "chat", env: "prod", fn: "messages:send", kind: "mutation", timing: "rpc", calls: 120, errors: 6, p50: 4, p95: 18, rows_read: 240, rows_written: 120, bytes_out: 9000 }];
    return new Response(JSON.stringify({ data, rows: data.length }));
  }) as typeof fetch;
}

describe.skipIf(!hasBrowser)("dashboard in Chromium", () => {
  let server: Server;
  let browser: Browser;
  let origin = "";
  const prod = fakeProject();
  const dev = fakeProject({ legacy: true });
  const reg = seeded();
  let env: DashboardEnv;

  beforeAll(async () => {
    reg.db.exec("INSERT INTO shards VALUES ('chat', 'prod', 'org:beta', 'org', 'beta', 'old', 4096, 1, 1), ('chat', 'prod', 'global:main', 'global', 'main', 'abc', 2048, 1, 1)");
    const spa = await build({
      entryPoints: [join(here, "../../src/app/main.tsx")],
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      target: "es2022",
      jsx: "automatic",
      minify: true,
      define: { "process.env.NODE_ENV": '"production"' },
      logLevel: "silent",
    });
    const app = createDashboard({ html: HTML, js: spa.outputFiles[0]!.text, css: readFileSync(join(here, "../../src/app/style.css"), "utf8") });
    env = {
      DASHBOARD_TOKEN: "admin-token-for-tests",
      DASHBOARD_READ_TOKEN: "read-token-for-tests",
      REGISTRY: reg.binding,
      EMBER_ADMIN_TOKEN: "proj-admin",
      EMBER_SERVICES: JSON.stringify({ "ember-chat-prod": "EMBER_SVC_0", "ember-chat-dev": "EMBER_SVC_1" }),
      EMBER_SVC_0: prod.svc,
      EMBER_SVC_1: dev.svc,
    };
    server = createServer(async (rq, rs) => {
      const chunks: Buffer[] = [];
      for await (const c of rq) chunks.push(c as Buffer);
      const headers = new Headers();
      for (const [k, v] of Object.entries(rq.headers)) if (typeof v === "string") headers.set(k, v);
      const method = rq.method ?? "GET";
      const req = new Request(`${origin}${rq.url}`, { method, headers, ...(method !== "GET" && method !== "HEAD" ? { body: Buffer.concat(chunks) } : {}) });
      const res = await app.fetch(req, env);
      rs.writeHead(res.status, Object.fromEntries(res.headers));
      rs.end(Buffer.from(await res.arrayBuffer()));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browser = await chromium.launch({ headless: true });
    if (shots) mkdirSync(shots, { recursive: true });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    server?.close();
    globalThis.fetch = realFetch;
  });

  const open = async (hash: string, o: { token?: string; scheme?: "light" | "dark" } = {}) => {
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 }, colorScheme: o.scheme ?? "light" });
    const page = await ctx.newPage();
    page.setDefaultTimeout(8_000);
    const problems: string[] = [];
    page.on("pageerror", (e) => problems.push(String(e)));
    page.on("console", (m) => {
      if (m.type() === "error" && !/the server responded with a status of (4|5)\d\d/.test(m.text())) problems.push(m.text());
    });
    await page.goto(`${origin}/${hash}`);
    await page.getByLabel("Dashboard token").fill(o.token ?? "admin-token-for-tests");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.locator(".topbar .who").waitFor();
    return { page, problems, close: () => ctx.close() };
  };
  const shot = async (page: Page, name: string) => {
    if (shots) await page.screenshot({ path: join(shots, `${name}.png`), fullPage: false });
  };

  it("signs in with the token (kept in memory only), shows health, and holds the CSP", async () => {
    const { page, problems, close } = await open("#/p/chat/prod/health");
    await expect.poll(() => page.locator(".role").textContent()).toBe("admin");
    await page.getByText("Needs attention").waitFor();
    // Analytics is not configured: one notice says how to connect it.
    await page.getByText("Connect Analytics Engine").waitFor();
    // org:beta is still backfilling an index.
    await page.locator(".attention li", { hasText: "org:beta" }).waitFor();
    await page.locator("text=backfilling 1").first().waitFor();
    const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
    expect(storage).not.toContain("admin-token-for-tests");
    expect(page.url()).not.toContain("token");
    await shot(page, "health");
    expect(problems).toEqual([]);
    await close();
  });

  it("keyboard: section keys, shard search, row navigation; destructive restore needs the typed name", async () => {
    const { page, problems, close } = await open("#/p/chat/prod/health");
    await page.keyboard.press("s");
    await page.getByRole("table", { name: "Shards" }).waitFor();
    // `/` focuses the shard picker; typing filters the catalog; Enter opens the shard.
    await page.keyboard.press("/");
    await page.keyboard.type("beta");
    await page.getByRole("option", { name: "org:beta" }).waitFor();
    await page.keyboard.press("Enter");
    await page.getByRole("complementary", { name: "Shard org:beta" }).waitFor();
    expect(page.url()).toContain("/shards/org%3Abeta");
    await page.getByText("Re-runs since boot").waitFor();
    await shot(page, "shard-detail");

    await page.getByRole("button", { name: "Record bookmark" }).click();
    await page.getByText("Bookmark recorded on org:beta").waitFor();
    expect(prod.posts.map((p) => p.path)).toEqual(["bookmark"]);

    await page.getByRole("button", { name: "Restore…" }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    const confirm = dialog.getByRole("button", { name: "Restore shard" });
    expect(await confirm.isDisabled()).toBe(true);
    await dialog.getByRole("textbox").fill("org:bet");
    expect(await confirm.isDisabled()).toBe(true);
    await dialog.getByRole("textbox").fill("org:beta");
    await shot(page, "restore-confirm");
    await confirm.click();
    await page.getByText(/org:beta restored to bookmark/).waitFor();
    expect(prod.posts.map((p) => p.path)).toEqual(["bookmark", "restore"]);
    expect(prod.posts[1]!.body).toMatchObject({ shard: "org:beta" });

    // The audit log has both writes, newest first, attributed to the token.
    await page.keyboard.press("a");
    const audit = page.getByRole("table", { name: "Audit log" });
    await audit.waitFor();
    await expect.poll(async () => (await audit.locator("tbody tr").allTextContents()).map((t) => /shard\.restore|bookmark\.create/.exec(t)?.[0])).toEqual(["shard.restore", "bookmark.create"]);
    await audit.locator("tbody tr").first().focus();
    await page.keyboard.press("Enter");
    await page.getByRole("dialog").getByText("Arguments (secrets removed)").waitFor();
    await shot(page, "audit");
    await page.keyboard.press("Escape");
    expect(problems).toEqual([]);
    await close();
  });

  it("renders user data as text, never as markup", async () => {
    const { page, problems, close } = await open("#/p/chat/prod/data/global%3Amain");
    await page.getByRole("button", { name: /messages/ }).click();
    const t = page.getByRole("table", { name: "messages rows" });
    await t.waitFor();
    await expect.poll(() => t.locator("td", { hasText: "<img" }).count()).toBeGreaterThan(0);
    expect(await page.locator("img").count()).toBe(0);
    await t.locator("tbody tr").nth(1).click();
    await page.getByRole("dialog").locator("pre", { hasText: XSS.slice(0, 10) }).waitFor();
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
    await shot(page, "data");
    expect(problems).toEqual([]);
    await close();
  });

  it("data: filter by index, schema, create / edit / delete documents (typed table name on prod), engine errors shown", async () => {
    const { page, problems, close } = await open("#/p/chat/prod/data/global%3Amain");
    await page.getByRole("button", { name: /messages/ }).click();
    const t = page.getByRole("table", { name: "messages rows" });
    await t.waitFor();
    // Newest first by default.
    expect(prod.lists.at(-1)).toMatchObject({ table: "messages", order: "desc" });
    await page.getByLabel("Index").selectOption("by_author");
    await page.getByLabel("author equals").fill("ana");
    await page.getByLabel("Order").selectOption("asc");
    await page.getByRole("button", { name: "Apply" }).click();
    await expect.poll(() => t.locator("tbody tr").count()).toBe(1);
    expect(prod.lists.at(-1)).toMatchObject({ index: "by_author", eq: '["ana"]', order: "asc" });
    await page.getByRole("button", { name: "Schema" }).click();
    const schema = page.getByRole("complementary", { name: "Schema of messages" });
    await schema.getByText("pinned?").waitFor();
    await schema.getByText("search", { exact: true }).waitFor();
    await shot(page, "data-filter-schema");

    // New document: the template has the required fields; the engine's answer comes back.
    await page.getByRole("button", { name: "New document" }).click();
    const editor = page.getByRole("dialog").getByLabel("Document JSON");
    expect(JSON.parse(await editor.inputValue())).toEqual({ author: "", body: null });
    await editor.fill('{"author": "bo", "body": "hi"}');
    await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
    await page.getByText("Inserted into messages").waitFor();
    expect(prod.posts.at(-1)).toEqual({ path: "data/insert", body: { shard: "global:main", table: "messages", doc: { author: "bo", body: "hi" } } });

    // Edit: an invalid document shows the engine's error and stays open; a valid one saves.
    await t.locator("tbody tr").first().click();
    await page.getByRole("dialog").getByRole("button", { name: "Edit" }).click();
    const edit = page.getByRole("dialog").getByLabel("Document JSON");
    expect(JSON.parse(await edit.inputValue())).toEqual({ author: "ana", body: XSS });
    await edit.fill('{"author": 5, "body": "x"}');
    await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
    await page.getByRole("dialog").getByText("author: expected string").waitFor();
    await shot(page, "data-edit-error");
    await edit.fill("{not json");
    expect(await page.getByRole("dialog").getByRole("button", { name: "Save" }).isDisabled()).toBe(true);
    await edit.fill('{"author": "ana", "body": "edited"}');
    await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
    await page.getByText("Saved messages_1").waitFor();
    expect(prod.posts.at(-1)).toEqual({ path: "data/replace", body: { shard: "global:main", table: "messages", id: "messages_1", doc: { author: "ana", body: "edited" } } });

    // Delete on prod: type the table name.
    await page.getByRole("dialog").getByRole("button", { name: "Delete…" }).click();
    const confirm = page.getByRole("dialog").getByRole("button", { name: "Delete document" });
    expect(await confirm.isDisabled()).toBe(true);
    await page.getByRole("dialog").getByRole("textbox").fill("messages");
    await confirm.click();
    await page.getByText("Deleted messages_1 from messages").waitFor();
    expect(prod.posts.at(-1)).toEqual({ path: "data/delete", body: { shard: "global:main", table: "messages", ids: ["messages_1"] } });
    expect(problems).toEqual([]);
    await close();
  });

  it("functions: charts and errors from Analytics Engine, the runner (form, JSON, run as a user), reactivity with the ember dev advice", async () => {
    env.CF_API_TOKEN = "cf";
    env.CF_ACCOUNT_ID = "acc";
    globalThis.fetch = fakeAnalytics();
    try {
      const { page, problems, close } = await open("#/p/chat/prod/functions");
      const list = page.getByRole("table", { name: "Functions" });
      await list.getByText("messages:secret").waitFor();
      await list.getByText("internal").waitFor();
      await list.locator("tr", { hasText: "messages:send" }).click();
      expect(page.url()).toContain("/functions/messages%3Asend");
      await expect.poll(() => page.locator(".chart svg").count()).toBe(3);
      await page.getByRole("table", { name: "Recent errors" }).getByText("MessageTooLong").waitFor();
      // The form comes from the args validators: a literal union is a select.
      await page.getByLabel("channel").fill("general");
      await page.getByLabel("body").fill("hello");
      await page.getByLabel("priority?").selectOption("high");
      await page.getByRole("button", { name: "Run mutation" }).click();
      // prod is protected: a mutation asks first.
      await page.getByRole("dialog").getByRole("button", { name: "Run mutation" }).click();
      await page.locator(".result").getByText('"high"').waitFor();
      expect(prod.posts.at(-1)).toEqual({ path: "run", body: { shard: "global:main", fn: "messages:send", args: { channel: "general", body: "hello", priority: "high" } } });
      await shot(page, "function");
      // JSON mode always works; a function error is shown as the result.
      await page.getByRole("tab", { name: "JSON" }).click();
      await page.getByLabel("Arguments JSON").fill('{"channel": 5, "body": "x"}');
      await page.getByRole("button", { name: "Run mutation" }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Run mutation" }).click();
      await page.locator(".result").getByText("ValidationError").waitFor();

      // Run as a user: the identity goes to the project; the audit log names it.
      await page.goto(`${origin}/#/p/chat/prod/functions/auth%3Awhoami`);
      await page.getByText("Run as a user").click();
      await page.getByLabel("Run as user id").fill("user_ana");
      await page.getByRole("button", { name: "Run query" }).click();
      await page.locator(".result").getByText("as user_ana").waitFor();
      expect(prod.posts.at(-1)).toEqual({ path: "run", body: { shard: "global:main", fn: "auth:whoami", args: {}, as: { subject: "user_ana" } } });
      // Sensitive functions cannot run as someone else.
      await page.goto(`${origin}/#/p/chat/prod/functions/auth%3Atransfer`);
      await page.getByText("Run as a user").click();
      await page.getByLabel("Run as user id").fill("user_ana");
      expect(await page.getByRole("button", { name: "Run mutation" }).isDisabled()).toBe(true);
      // (Shortcuts are ignored while typing in a field: blur it first.)
      await page.locator("main").click({ position: { x: 5, y: 5 } });
      await page.keyboard.press("a");
      await page.getByRole("table", { name: "Audit log" }).getByText("function.run_as").waitFor();

      // Reactivity: live report, then one profiled run with the advice.
      await page.keyboard.press("r");
      const rx = page.getByRole("table", { name: "Cached queries" });
      await rx.getByText("per user").waitFor();
      await rx.locator("tr", { hasText: "messages:mine" }).getByRole("button", { name: "Profile" }).click();
      await page.getByRole("dialog").getByText(/narrow the scan with withIndex/).waitFor();
      await shot(page, "reactivity-profile");
      expect(problems).toEqual([]);
      await close();
    } finally {
      delete env.CF_API_TOKEN;
      delete env.CF_ACCOUNT_ID;
      globalThis.fetch = realFetch;
    }
  });

  it("read role sees no write controls; the Worker refuses its writes anyway", async () => {
    const { page, close } = await open("#/p/chat/prod/shards/org%3Abeta", { token: "read-token-for-tests" });
    await page.getByText("Re-runs since boot").waitFor();
    expect(await page.getByRole("button", { name: "Record bookmark" }).count()).toBe(0);
    expect(await page.getByRole("button", { name: "Restore…" }).count()).toBe(0);
    const status = await page.evaluate(async () => {
      const r = await fetch("/api/bookmark", { method: "POST", headers: { authorization: "Bearer read-token-for-tests", "content-type": "application/json" }, body: JSON.stringify({ project: "chat", env: "prod", shard: "org:beta" }) });
      return r.status;
    });
    expect(status).toBe(403);
    await close();
  });

  it("an older runtime shows 'update the runtime' and the rest keeps working; dark theme", async () => {
    const { page, problems, close } = await open("#/p/chat/dev/shards/global%3Amain", { scheme: "dark" });
    await page.getByText("Update the runtime").first().waitFor();
    // Status (level 1) still renders.
    await page.locator(".stat-label", { hasText: "Size" }).waitFor();
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg).toBe("rgb(17, 16, 15)");
    await shot(page, "outdated-dark");
    await page.keyboard.press("t"); // auto → light
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme)).toBe("light");
    expect(problems).toEqual([]);
    await close();
  });

  it("writes without the CSRF token, or from another origin, never reach the project", async () => {
    const before = prod.posts.length + dev.posts.length;
    const { page, close } = await open("#/p/chat/dev/health");
    // Same origin, signed in, but no X-Ember-Csrf: refused.
    const same = await page.evaluate(async () => {
      const r = await fetch("/api/bookmark", { method: "POST", headers: { authorization: "Bearer admin-token-for-tests", "content-type": "application/json" }, body: JSON.stringify({ project: "chat", env: "dev", shard: "org:beta" }) });
      return [r.status, ((await r.json()) as { error: { code: string } }).error.code];
    });
    expect(same).toEqual([403, "bad_csrf"]);
    await close();
    // Another origin (localhost vs 127.0.0.1): a JSON write needs a preflight, which the API never grants.
    const ctx = await browser.newContext();
    const evil = await ctx.newPage();
    await evil.goto(`${origin.replace("127.0.0.1", "localhost")}/`);
    const cross = await evil.evaluate(async (target) => {
      try {
        await fetch(`${target}/api/bookmark`, { method: "POST", headers: { authorization: "Bearer admin-token-for-tests", "content-type": "application/json" }, body: "{}" });
        return "sent";
      } catch {
        return "blocked";
      }
    }, origin);
    expect(cross).toBe("blocked");
    expect(prod.posts.length + dev.posts.length).toBe(before);
    await ctx.close();
  });
});
