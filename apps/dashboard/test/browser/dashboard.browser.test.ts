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
import { clearCapabilities, createDashboard, type DashboardEnv } from "../../src/worker.ts";
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
// CI sets EMBER_REQUIRE_BROWSER=1 (.github/workflows/ci.yml): there a missing browser fails the run instead of skipping.
if (!hasBrowser && process.env.EMBER_REQUIRE_BROWSER === "1") {
  throw new Error(`EMBER_REQUIRE_BROWSER is set but playwright-core finds no Chromium (${executable || "no executable path"}); run \`npx playwright-core install chromium\``);
}
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
    else if (sql.includes("blob7 AS code")) data = [{ t: at(11), code: "MessageTooLong", shard: "org:acme", kind: "mutation", ms: 4.2 }];
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
  const tailCalls: string[] = [];
  let closedTails = 0;

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
    // The Cloudflare APIs the Worker calls: the tails API here, Analytics Engine through the global fetch (patched per test).
    const cfFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = String(input instanceof Request ? input.url : input);
      if (/\/workers\/scripts\/[^/]+\/tails(\/|$)/.test(u)) {
        tailCalls.push(`${init?.method ?? "GET"} ${u.replace(/^.*\/tails/, "/tails")}`);
        return Response.json({ success: true, result: init?.method === "POST" ? { id: "tail-1", url: "wss://tail.example/capability" } : null });
      }
      return globalThis.fetch(input, init);
    }) as typeof fetch;
    const connectTail = async () => {
      const listeners = new Map<string, Array<(e: { data?: unknown }) => void>>();
      const emit = (t: string, data?: unknown) => listeners.get(t)?.forEach((f) => f({ data }));
      const exec = (fn: string, status = "ok") => `ember:exec ${JSON.stringify({ fn, shard: "org:acme", kind: "mutation", status, errorCode: status === "ok" ? "" : "Boom", durationMs: 4, rowsRead: 2, rowsWritten: 1 })}`;
      return {
        addEventListener: (t: string, f: (e: { data?: unknown }) => void) => void listeners.set(t, [...(listeners.get(t) ?? []), f]),
        send: () => {
          setTimeout(() => {
            emit("message", JSON.stringify({ outcome: "ok", eventTimestamp: Date.now(), event: { request: { url: "https://p.example/api/mutation?token=SECRET", method: "POST" } }, logs: [{ message: [exec("messages:send")], level: "log", timestamp: Date.now() }, { message: [`messages:send failed for ${XSS}`], level: "error", timestamp: Date.now() }] }));
            emit("message", JSON.stringify({ outcome: "ok", eventTimestamp: Date.now(), event: { request: { url: "https://p.example/api/query", method: "POST" } }, logs: [{ message: [exec("rooms:list")], level: "log", timestamp: Date.now() }] }));
          }, 50);
        },
        close: () => {
          closedTails++;
        },
      };
    };
    const app = createDashboard({ html: HTML, js: spa.outputFiles[0]!.text, css: readFileSync(join(here, "../../src/app/style.css"), "utf8") }, { fetch: cfFetch, connectTail });
    env = {
      DASHBOARD_TOKEN: "admin-token-for-tests",
      DASHBOARD_READ_TOKEN: "read-token-for-tests",
      REGISTRY: reg.binding,
      EMBER_ADMIN_TOKEN: "proj-admin",
      EMBER_SERVICES: JSON.stringify({ "ember-chat-prod": "EMBER_SVC_0", "ember-chat-dev": "EMBER_SVC_1" }),
      EMBER_SVC_0: prod.svc,
      EMBER_SVC_1: dev.svc,
      CF_ACCOUNT_ID: "acc",
      CF_TAIL_TOKEN: "tail-token",
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
      if (!res.body) return void rs.end();
      // Streamed as it comes (live logs), and cancelled when the browser goes away (as Workers do).
      const reader = res.body.getReader();
      rq.socket.once("close", () => void reader.cancel().catch(() => undefined));
      for (;;) {
        const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true as const }));
        if (done) break;
        rs.write(value);
      }
      rs.end();
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
    // The catalog says org:beta reported an older schema; its live status (backfilling an index) is asked on demand.
    await page.locator(".attention li", { hasText: "org:beta" }).waitFor();
    await page.getByText("behind (catalog)").first().waitFor();
    await page.getByRole("button", { name: "Check live status" }).click();
    await page.locator("text=backfilling 1").first().waitFor();
    const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
    expect(storage).not.toContain("admin-token-for-tests");
    expect(page.url()).not.toContain("token");
    await shot(page, "health");
    expect(problems).toEqual([]);
    await close();
  });

  it("costs the project little: health and the shard search read the catalog; live status only on demand", async () => {
    const before = prod.calls.length;
    const { page, problems, close } = await open("#/p/chat/prod/health");
    await page.getByText("Needs attention").waitFor();
    await page.getByText("behind (catalog)").first().waitFor();
    // Opening Health asks the project for its capabilities only: no shard woken.
    const status = () => prod.calls.slice(before).filter((c) => c.startsWith("GET status"));
    expect(status()).toEqual([]);
    await page.keyboard.press("s");
    await page.getByRole("table", { name: "Shards" }).waitFor();
    // Typing in the filter: catalog queries (D1, debounced), never the live status of 50 shards per keystroke.
    await page.getByLabel("Filter shards").pressSequentially("org:b", { delay: 30 });
    await page.getByRole("table", { name: "Shards" }).getByText("org:beta").waitFor();
    await page.waitForTimeout(400);
    expect(status()).toEqual([]);
    // The button asks once for the listed shards.
    await page.getByRole("button", { name: "Check live status" }).click();
    await page.getByRole("table", { name: "Shards" }).getByText("backfilling 1").waitFor();
    expect(status()).toEqual(["GET status?org:beta"]);
    // Selecting a shard asks for that one only.
    await page.getByRole("table", { name: "Shards" }).getByText("org:beta").click();
    await page.getByRole("complementary", { name: "Shard org:beta" }).waitFor();
    await page.getByText("Re-runs since boot").waitFor();
    expect(status()).toEqual(["GET status?org:beta", "GET status?org:beta"]);
    expect(prod.calls.slice(before).filter((c) => c.startsWith("GET status") || c.startsWith("GET inspect")).every((c) => !c.includes(","))).toBe(true);
    expect(problems).toEqual([]);
    await close();
  });

  it("command palette (⌘K / Ctrl+K): environments, sections, screens, shards, tables, functions, users", async () => {
    const { page, problems, close } = await open("#/p/chat/prod/health");
    await page.getByText("Needs attention").waitFor();
    const dialog = page.getByRole("dialog", { name: "Command palette" });
    const box = dialog.getByRole("combobox", { name: "Go to" });
    const openPalette = async (combo: string) => {
      await page.keyboard.press(combo);
      await box.waitFor();
      await expect.poll(() => box.evaluate((el) => el === document.activeElement)).toBe(true);
    };
    // A function, by keyboard only. Typing "s" or "f" in the box is text, not a section shortcut.
    await openPalette("Control+k");
    await box.pressSequentially("send");
    await dialog.getByRole("option", { name: /messages:send/ }).waitFor();
    expect(await dialog.getByRole("listbox").getAttribute("aria-label")).toBe("Results");
    await page.keyboard.press("Enter");
    await expect.poll(() => page.url()).toContain("/functions/messages%3Asend");
    await dialog.waitFor({ state: "hidden" });

    // A shard, then a table (opened on the route's shard), arrows move the selection.
    await openPalette("Meta+k");
    await box.pressSequentially("org:be");
    const beta = dialog.getByRole("option", { name: /org:beta/ });
    await beta.waitFor();
    await page.keyboard.press("Enter");
    await expect.poll(() => page.url()).toContain("/shards/org%3Abeta");
    await page.getByRole("complementary", { name: "Shard org:beta" }).waitFor();

    await openPalette("Control+k");
    await box.pressSequentially("messages");
    await dialog.getByRole("option", { name: /^messages.*data on/ }).waitFor();
    // Tables come after sections and screens: move to it with the arrows.
    const options = dialog.getByRole("option");
    const names = await options.allTextContents();
    const at = names.findIndex((n) => n.startsWith("messages") && n.includes("data on"));
    for (let i = 0; i < at; i++) await page.keyboard.press("ArrowDown");
    expect(await options.nth(at).getAttribute("aria-selected")).toBe("true");
    expect(await box.getAttribute("aria-activedescendant")).toBe(`palette-${at}`);
    await page.keyboard.press("Enter");
    await expect.poll(() => page.url()).toContain("/data/org%3Abeta/messages");
    await expect.poll(() => page.locator(".table-list button.active").textContent()).toContain("messages");

    // A declarative screen and a user (searched from 3 characters on).
    await openPalette("Control+k");
    await box.pressSequentially("work pool items");
    await dialog.getByRole("option", { name: /Work pool › Items/ }).click();
    await expect.poll(() => page.url()).toContain("/components/org%3Abeta/pool/items");
    await openPalette("Control+k");
    await box.pressSequentially("ana@");
    await dialog.getByRole("option", { name: /ana@acme\.test/ }).waitFor();
    await page.keyboard.press("Enter");
    await expect.poll(() => page.url()).toContain("/users/ana%40acme.test");
    await expect.poll(() => page.getByLabel("Search users").inputValue()).toBe("ana@acme.test");

    // An environment from anywhere; Esc closes and hands the keyboard back to the page.
    await openPalette("Control+k");
    await box.pressSequentially("chat/dev");
    await dialog.getByRole("option", { name: /chat\/dev/ }).waitFor();
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    await page.keyboard.press("h");
    await expect.poll(() => page.url()).toContain("/p/chat/prod/health");
    await shot(page, "palette");
    expect(problems).toEqual([]);
    await close();
    // The screen it opened ran its queries: the declarative screens' tests below count theirs from zero.
    prod.dashQueries.length = 0;
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

  it("data v2: open by _id, links of v.id() and v.file() fields, range bounds, full-text search, bulk delete (typed on prod), auto-refresh", async () => {
    const { page, problems, close } = await open("#/p/chat/prod/data/global%3Amain/messages");
    const t = page.getByRole("table", { name: "messages rows" });
    await t.waitFor();
    // _id search: a direct get, and its document opens.
    await page.getByLabel("Document _id").fill("messages_3");
    await page.getByRole("button", { name: "Open", exact: true }).click();
    await page.getByRole("dialog").locator("pre", { hasText: "deploy finished" }).waitFor();
    expect(prod.lists.at(-1)).toMatchObject({ table: "messages", id: "messages_3" });
    await page.keyboard.press("Escape");
    await expect.poll(() => t.locator("tbody tr").count()).toBe(1);
    await page.getByRole("button", { name: "Clear" }).click();
    await expect.poll(() => t.locator("tbody tr").count()).toBe(3);

    // A v.id() value links to its document; a v.file() value to the Files screen.
    await t.getByRole("link", { name: "messages_1" }).click();
    await expect.poll(() => page.url()).toContain("/data/global%3Amain/messages/messages_1");
    await page.getByRole("dialog").getByText("messages_1").first().waitFor();
    expect(prod.lists.at(-1)).toMatchObject({ id: "messages_1" });
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Clear" }).click();
    await page.getByRole("table", { name: "messages rows" }).getByRole("link", { name: "_storage_png" }).click();
    await expect.poll(() => page.url()).toContain("/files/global%3Amain/_storage_png");
    await page.getByRole("dialog").locator("img").waitFor();
    await page.keyboard.press("Escape");
    await page.evaluate(() => void (location.hash = "#/p/chat/prod/data/global%3Amain/messages"));
    await t.waitFor();

    // Range on the field after the fixed prefix (by_author: author itself), as JSON values.
    await page.getByLabel("Index").selectOption("by_author");
    await page.getByLabel("author from").fill("b");
    await page.getByLabel("author upper bound").selectOption("lte");
    await page.getByLabel("author to").fill('"m"');
    await page.getByRole("button", { name: "Apply" }).click();
    await expect.poll(() => prod.lists.at(-1)).toMatchObject({ index: "by_author", gte: '"b"', lte: '"m"' });
    // Full-text search through the table's searchIndex.
    await page.getByLabel("Full-text search").fill("deploy");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect.poll(() => t.locator("tbody tr").count()).toBe(1);
    expect(prod.lists.at(-1)).toMatchObject({ index: "search_body", search: "deploy" });
    await page.getByRole("button", { name: "Clear" }).click();
    await page.getByLabel("Index").selectOption("by_creation_time");
    await page.getByRole("button", { name: "Apply" }).click();
    await expect.poll(() => t.locator("tbody tr").count()).toBe(3);

    // Bulk delete: select two rows, one confirmation with the count (prod: type the table name).
    await page.getByLabel("Select messages_1").check();
    await page.getByLabel("Select messages_3").check();
    await page.getByRole("button", { name: "Delete 2 selected…" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByText("Delete 2 documents of messages?").waitFor();
    const confirm = dialog.getByRole("button", { name: "Delete 2 documents" });
    expect(await confirm.isDisabled()).toBe(true);
    await dialog.getByRole("textbox").fill("messages");
    await confirm.click();
    await page.getByText("Deleted 2 documents from messages").waitFor();
    expect(prod.posts.at(-1)).toEqual({ path: "data/delete", body: { shard: "global:main", table: "messages", ids: ["messages_3", "messages_1"] } });

    // Auto-refresh: the same page again every 5 s.
    const before = prod.lists.length;
    await page.getByLabel("Auto-refresh every 5 seconds").check();
    await expect.poll(() => prod.lists.length, { timeout: 8_000 }).toBeGreaterThan(before);
    await page.getByLabel("Auto-refresh every 5 seconds").uncheck();
    await shot(page, "data-v2");
    expect(problems).toEqual([]);
    await close();
  });

  it("SQL explorer: completion, run with ⌘↵, results as text, CSV and JSON export, EXPLAIN tree, audited; read role cannot run", async () => {
    const { page, problems, close } = await open("#/p/chat/prod/sql/global%3Amain");
    const editor = page.getByRole("textbox", { name: "SQL", exact: true });
    await editor.waitFor();
    await editor.fill("SELECT * FROM mess");
    const completions = page.getByRole("listbox", { name: "Completions" });
    await completions.getByRole("option", { name: /^messages table/ }).waitFor();
    await editor.press("Tab");
    await expect.poll(() => editor.inputValue()).toBe("SELECT * FROM messages");
    await editor.press("ControlOrMeta+Enter");
    const result = page.getByRole("table", { name: "SQL result" });
    await result.waitFor();
    expect(prod.posts.at(-1)).toEqual({ path: "sql", body: { shard: "global:main", sql: "SELECT * FROM messages", params: [], limit: 500 } });
    await page.getByText("truncated").waitFor();
    // User data is text.
    await expect.poll(() => result.locator("td", { hasText: "<img" }).count()).toBe(1);
    expect(await page.locator("img").count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();

    // Exports, built in the page from the result.
    const save = async (name: string) => {
      const [d] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name }).click()]);
      return { file: d.suggestedFilename(), text: readFileSync((await d.path())!, "utf8") };
    };
    const csv = await save("Export CSV");
    expect(csv.file).toBe("chat-prod-global_main.csv");
    expect(csv.text).toBe(`_id,author,body\r\nmessages_1,ana,"a, ""quoted"" ${XSS.replace(/"/g, '""')}"\r\nmessages_2,'=cmd(),\r\n`);
    const js = await save("Export JSON");
    expect(JSON.parse(js.text)).toEqual([
      { _id: "messages_1", author: "ana", body: `a, "quoted" ${XSS}` },
      { _id: "messages_2", author: "=cmd()", body: null },
    ]);

    // EXPLAIN QUERY PLAN as a tree; a refused statement shows the project's reason.
    await page.getByLabel("EXPLAIN QUERY PLAN").check();
    await page.getByRole("button", { name: /^Run/ }).click();
    await page.getByRole("list", { name: "Query plan" }).getByText("SCAN messages").waitFor();
    expect(prod.posts.at(-1)).toMatchObject({ path: "sql", body: { explain: true } });
    await page.getByLabel("EXPLAIN QUERY PLAN").uncheck();
    await editor.fill("DELETE FROM messages");
    await editor.press("Escape");
    await editor.press("ControlOrMeta+Enter");
    await page.getByText("SqlRefused").waitFor();
    await shot(page, "sql");
    // Every run is in the audit log with its text.
    const rows = reg.db.prepare("SELECT action, target, args, outcome FROM audit_log WHERE action = 'sql.run' ORDER BY id").all() as Array<{ args: string; outcome: string }>;
    expect(rows.map((r) => [JSON.parse(r.args).sql, r.outcome])).toEqual([
      ["SELECT * FROM messages", "ok"],
      ["SELECT * FROM messages", "ok"],
      ["DELETE FROM messages", "error"],
    ]);
    expect(problems).toEqual([]);
    await close();

    // The read role sees why it cannot run SQL.
    const r = await open("#/p/chat/prod/sql/global%3Amain", { token: "read-token-for-tests" });
    await r.page.getByText("Admins only").waitFor();
    expect(await r.page.getByRole("button", { name: /^Run/ }).isDisabled()).toBe(true);
    await r.close();
  });

  it("schema explorer: tables, shapes, indexes and flags from the deployed schema; counts and index state on demand", async () => {
    const before = prod.calls.length;
    const { page, problems, close } = await open("#/p/chat/prod/schema/org%3Abeta");
    const card = page.getByRole("region", { name: "Table messages" });
    await card.waitFor();
    await card.getByText("replicated → org").waitFor();
    await card.getByText("id<messages>").first().waitFor();
    await card.getByRole("table", { name: "Indexes of messages" }).getByText("search_body").waitFor();
    await page.getByText("pool$work").waitFor();
    // Opening the screen woke no shard; "Check" asks the picked one for counts and staged indexes.
    expect(prod.calls.slice(before).filter((c) => c.startsWith("GET status") || c.startsWith("GET data"))).toEqual([]);
    await page.getByRole("button", { name: /^Check/ }).click();
    await card.getByText("2 rows on this shard").waitFor();
    await card.getByRole("table", { name: "Indexes of messages" }).getByText("backfilling").waitFor();
    expect(prod.calls.slice(before).filter((c) => c.startsWith("GET status") || c.startsWith("GET data")).sort()).toEqual(["GET data?org:beta", "GET status?org:beta"]);
    // A table opens in the Data Browser.
    await card.getByRole("link", { name: "messages" }).click();
    await expect.poll(() => page.url()).toContain("/data/org%3Abeta/messages");
    await shot(page, "schema");
    expect(problems).toEqual([]);
    await close();
  });

  it("functions: charts and errors from Analytics Engine, the runner (form, JSON, run as a user), reactivity with the ember dev advice", async () => {
    env.CF_API_TOKEN = "cf";
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
      // The function name in the route is never taken for a shard by another section.
      await page.keyboard.press("r");
      await expect.poll(() => page.url()).toMatch(/\/reactivity$/);
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
      globalThis.fetch = realFetch;
    }
  });

  it("estimated cost: a month projected from the metrics, by function and by shard, labelled as an estimate", async () => {
    env.CF_API_TOKEN = "cf";
    globalThis.fetch = fakeAnalytics();
    try {
      const { page, problems, close } = await open("#/p/chat/prod/health");
      await page.getByText("Needs attention").waitFor();
      await page.keyboard.press("e");
      await expect.poll(() => page.url()).toMatch(/\/cost$/);
      await page.getByRole("note").getByText("Estimate, not a bill").waitFor();
      await page.getByRole("note").getByRole("link", { name: "Durable Objects" }).waitFor();
      const byFn = page.getByRole("table", { name: "Estimated cost by function" });
      await byFn.getByText("messages:send").waitFor();
      // 120 calls in 7 days → ×730/168 a month; prices as small as these show as <$0.01.
      await byFn.getByText("<$0.01").waitFor();
      const byShard = page.getByRole("table", { name: "Estimated cost by shard" });
      // From the metrics (org:acme) and from the catalog's storage (idle shards too).
      await byShard.getByText("org:acme").waitFor();
      await byShard.getByText("org:beta").waitFor();
      await page.getByRole("table", { name: "Cost breakdown" }).getByText("SQLite rows written").waitFor();
      await page.locator(".stat", { hasText: "With included usage" }).getByText("$5.00").waitFor();
      await shot(page, "cost");
      await byFn.locator("tr", { hasText: "messages:send" }).click();
      await expect.poll(() => page.url()).toContain("/functions/messages%3Asend");
      expect(problems).toEqual([]);
      await close();
    } finally {
      delete env.CF_API_TOKEN;
      globalThis.fetch = realFetch;
    }
  });

  it("logs: live through the Worker's tail, filtered, rendered as text; stopping ends the tail session", async () => {
    const { page, problems, close } = await open("#/p/chat/prod/logs");
    await page.getByLabel("Filter by function").fill("messages:send");
    await page.getByRole("button", { name: "Start" }).click();
    const log = page.getByRole("log", { name: "Log events" });
    await log.getByText("messages:send", { exact: true }).waitFor();
    await log.getByText(`messages:send failed for ${XSS}`).waitFor();
    expect(await log.getByText("rooms:list").count()).toBe(0);
    expect(await page.locator(".log-list img").count()).toBe(0);
    expect(await log.textContent()).not.toContain("SECRET");
    await shot(page, "logs");
    await page.getByRole("button", { name: "Stop" }).click();
    await expect.poll(() => tailCalls.some((c) => c.startsWith("DELETE /tails/tail-1"))).toBe(true);
    expect(closedTails).toBeGreaterThan(0);
    expect(problems).toEqual([]);
    await close();
  });

  it("schedules: run a cron now, cancel a pending job, run a failed one again", async () => {
    const { page, problems, close } = await open("#/p/chat/prod/crons");
    await page.getByRole("table", { name: "Crons" }).getByRole("button", { name: "Run now" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Run now" }).click();
    await page.getByText("cleanup scheduled now").waitFor();
    expect(prod.posts.at(-1)).toEqual({ path: "crons/run", body: { name: "cleanup" } });
    const jobs = page.getByRole("table", { name: "Jobs" });
    await jobs.locator("tr", { hasText: "job_pending" }).getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Cancel job" }).click();
    await page.getByText("Cancelled job_pending").waitFor();
    expect(prod.posts.at(-1)).toEqual({ path: "jobs/cancel", body: { shard: "global:main", id: "job_pending" } });
    await jobs.locator("tr", { hasText: "mail:send" }).getByRole("button", { name: "Run again" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Run again" }).click();
    await page.getByText("mail:send scheduled again").waitFor();
    expect(prod.posts.at(-1)).toEqual({ path: "jobs/run", body: { shard: "global:main", fn: "mail:send", args: { to: "ana@x.test" } } });
    expect(problems).toEqual([]);
    await close();
  });

  it("files: images and text previewed safely, HTML and SVG never rendered; upload; delete with the typed id on prod", async () => {
    const { page, problems, close } = await open("#/p/chat/prod/files/global%3Amain");
    const files = page.getByRole("table", { name: "Files" });
    await expect.poll(() => files.locator("tbody tr").count()).toBe(4);
    await files.locator("tr", { hasText: "_storage_png" }).click();
    const img = page.getByRole("dialog").getByRole("img", { name: "Preview of _storage_png" });
    await img.waitFor();
    expect(await img.getAttribute("src")).toMatch(/^blob:/);
    // Referenced by a document: delete is disabled.
    expect(await page.getByRole("dialog").getByRole("button", { name: "Delete…" }).isDisabled()).toBe(true);
    await shot(page, "files-preview");
    await page.keyboard.press("Escape");
    await files.locator("tr", { hasText: "_storage_txt" }).click();
    await page.getByRole("dialog").locator("pre", { hasText: "hello" }).waitFor();
    await page.keyboard.press("Escape");
    for (const id of ["_storage_html", "_storage_svg"]) {
      await files.locator("tr", { hasText: id }).click();
      await page.getByRole("dialog").getByText(/No preview for this type/).waitFor();
      await page.keyboard.press("Escape");
    }
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
    expect(await page.locator("iframe, object, embed").count()).toBe(0);

    await page.locator("#upload").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("uploaded bytes") });
    await page.getByText(/Uploaded notes\.txt/).waitFor();
    expect(prod.posts.at(-1)).toEqual({ path: "files/upload", body: { query: { shard: "global:main", contentType: "text/plain" }, bytes: "uploaded bytes" } });

    await files.locator("tr", { hasText: "_storage_txt" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete…" }).click();
    const del = page.getByRole("dialog").getByRole("button", { name: "Delete file" });
    expect(await del.isDisabled()).toBe(true);
    await page.getByRole("dialog").getByRole("textbox").fill("_storage_txt");
    await del.click();
    await page.getByText("Deleted _storage_txt").waitFor();
    expect(problems).toEqual([]);
    await close();
  });

  it("settings: a secret revealed on purpose, shown once, never stored; key rotation needs <project>/<env> on prod", async () => {
    const { page, problems, close } = await open("#/p/chat/prod/settings");
    const vars = page.getByRole("table", { name: "Environment variables" });
    await vars.getByText("SMTP_PASSWORD").waitFor();
    // Managed names cannot be revealed.
    expect(await vars.locator("tr", { hasText: "EMBER_PROJECT" }).getByRole("button").count()).toBe(0);
    await vars.locator("tr", { hasText: "SMTP_PASSWORD" }).getByRole("button", { name: "Reveal…" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Reveal value" }).click();
    const value = page.getByRole("dialog").getByLabel("Value of SMTP_PASSWORD");
    expect(await value.inputValue()).toBe("smtp-pass-123");
    await page.keyboard.press("Escape");
    await expect.poll(() => page.content()).not.toContain("smtp-pass-123");
    const storage = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
    expect(storage).not.toContain("smtp-pass-123");
    await page.getByRole("button", { name: "Rotate JWT key…" }).click();
    const rotate = page.getByRole("dialog").getByRole("button", { name: "Rotate key" });
    expect(await rotate.isDisabled()).toBe(true);
    await page.getByRole("dialog").getByRole("textbox").fill("chat/prod");
    await rotate.click();
    await page.getByText(/JWT signing key rotated/).waitFor();
    await shot(page, "settings");
    expect(problems).toEqual([]);
    await close();
  });

  it("users: search, sessions without tokens, revoke one, sign out everywhere", async () => {
    const { page, problems, close } = await open("#/p/chat/prod/users");
    const users = page.getByRole("table", { name: "Users" });
    await expect.poll(() => users.locator("tbody tr").count()).toBe(2);
    await page.getByLabel("Search users").fill("bo@");
    await expect.poll(() => users.locator("tbody tr").count()).toBe(1);
    await page.getByLabel("Search users").fill("");
    await expect.poll(() => users.locator("tbody tr").count()).toBe(2);
    // A name with markup is text.
    await users.getByText(XSS).waitFor();
    await users.locator("tr", { hasText: "ana@acme.test" }).click();
    const sessions = page.getByRole("dialog").getByRole("table", { name: "Sessions" });
    await sessions.getByText("203.0.113.9").waitFor();
    await shot(page, "users-sessions");
    await sessions.locator("tr", { hasText: "203.0.113.9" }).getByRole("button", { name: "Revoke" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Revoke session" }).click();
    await page.getByText(/Ended 1 session of ana@acme.test; 3 live connections cut/).waitFor();
    expect(prod.posts.at(-1)).toMatchObject({ path: "auth/revoke", body: { userId: "user_ana", sessionId: "sess_1" } });
    await page.getByRole("dialog").getByRole("button", { name: "Sign out everywhere…" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Sign out everywhere" }).click();
    await page.getByText(/Ended 2 sessions/).waitFor();
    // All sessions: no sessionId; the catalog's shards go along so live sockets are cut.
    const all = prod.posts.at(-1)!.body as { userId: string; sessionId?: string; shards: string[] };
    expect(all.userId).toBe("user_ana");
    expect(all.sessionId).toBeUndefined();
    expect([...all.shards].sort()).toEqual(["global:main", "org:acme", "org:beta"]);
    expect(problems).toEqual([]);
    await close();
  });

  it("remote auth: users and key rotation say where auth is handled, not an error", async () => {
    prod.remoteAuth("https://origin.example");
    clearCapabilities();
    try {
      const { page, problems, close } = await open("#/p/chat/prod/users");
      const notice = page.getByRole("status").filter({ hasText: "Auth is handled elsewhere" });
      await notice.getByText(/auth is handled by https:\/\/origin\.example: users, sessions, revocation and key rotation live there/).waitFor();
      expect(await page.locator(".notice.bad").count()).toBe(0);
      await shot(page, "users-remote-auth");
      await page.goto(`${origin}/#/p/chat/prod/settings`);
      await page.getByText(/its signing keys rotate there/).waitFor();
      expect(await page.getByRole("button", { name: "Rotate JWT key…" }).count()).toBe(0);
      expect(problems).toEqual([]);
      await close();
    } finally {
      prod.remoteAuth(null);
      clearCapabilities();
    }
  });

  it("declarative screens: a component's spec rendered generically — stats, filters from v.*, pages, detail, inline toggle, actions, typed confirmation", async () => {
    const { page, problems, close } = await open("#/p/chat/prod/components/org%3Aacme");
    const list = page.getByRole("table", { name: "Components with screens" });
    await list.getByText("Work pool").click();
    await page.getByRole("heading", { name: "Work pool" }).waitFor();
    expect(page.url()).toContain("/components/org%3Aacme/pool");
    // Stats from the declared query, on the picked shard.
    await page.locator(".stat", { hasText: "Succeeded" }).getByText("12").waitFor();
    expect(prod.dashQueries.find((q) => q.fn === "@pool/lib:stats")).toMatchObject({ shard: "org:acme", args: {} });
    // The table: a page of 2, user data as text, the next page through the cursor.
    const t = page.getByRole("table", { name: "Work" });
    await expect.poll(() => t.locator("tbody tr").count()).toBe(2);
    await t.locator("td", { hasText: "<img" }).first().waitFor();
    expect(await page.locator("img").count()).toBe(0);
    await page.getByRole("button", { name: "Next →" }).click();
    await expect.poll(() => t.locator("tbody tr").count()).toBe(1);
    await t.getByText("ai:summarize").waitFor();
    // A filter generated from the query's v.union of literals.
    await page.getByLabel("status").selectOption("failed");
    await page.getByRole("button", { name: "Filter" }).click();
    await t.getByText("emails:send").waitFor();
    await expect.poll(() => t.locator("tbody tr").count()).toBe(1);
    expect(prod.dashQueries.at(-1)).toMatchObject({ fn: "@pool/lib:listWork", args: { status: "failed", paginationOpts: { numItems: 2, cursor: null } } });
    await shot(page, "screens-component");
    // A row opens its detail: key/values, a timeline and the stack trace.
    await t.getByText("emails:send").click();
    const detail = page.getByRole("dialog");
    await detail.getByText("attempt 2").waitFor();
    await detail.locator("pre.stacktrace", { hasText: "SMTP down" }).waitFor();
    await shot(page, "screens-detail");
    await page.keyboard.press("Escape");
    // `k` on a focused row moves between rows: it is not the Components shortcut.
    await t.locator("tbody tr").first().focus();
    await page.keyboard.press("k");
    await page.keyboard.press("j");
    expect(page.url()).toContain("/components/org%3Aacme/pool");
    await page.getByRole("heading", { name: "Work pool" }).waitFor();
    // Inline toggle (Enter on the switch: it flips, the row's detail stays closed): the declared mutation with the
    // row's id and the new value.
    await t.getByRole("switch", { name: "Paused" }).focus();
    await page.keyboard.press("Enter");
    // `pause` is destructive on prod: the Worker's 428 opens the typed confirmation (never the row's detail).
    const typed = page.getByRole("dialog");
    await typed.getByRole("textbox").waitFor();
    expect(await typed.getByText("attempt 2").count()).toBe(0);
    await typed.getByRole("textbox").fill("pause");
    await typed.getByRole("button", { name: "Turn off" }).click();
    await expect.poll(() => prod.posts.filter((x) => x.path === "dashboards/run").length).toBe(1);
    await expect.poll(() => page.getByRole("dialog").count()).toBe(0);
    // The project still says paused (this fake never changes it): once the reload arrives, the switch shows that.
    await expect.poll(() => t.getByRole("switch", { name: "Paused" }).getAttribute("aria-checked")).toBe("true");
    expect(prod.posts.at(-1)!.body).toMatchObject({ dashboard: "pool", fn: "@pool/lib:pause", args: { id: "work_2", paused: false }, shard: "org:acme", destructive: true });
    // A row action on prod: a plain confirmation (not destructive).
    await t.getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).last().click();
    await expect.poll(() => prod.posts.filter((x) => x.path === "dashboards/run").length).toBe(2);
    expect(prod.posts.at(-1)!.body).toMatchObject({ fn: "@pool/lib:cancel", args: { id: "work_2" } });
    // A destructive action on prod: the function's name must be typed.
    await page.getByRole("button", { name: "Cancel all" }).click();
    const confirm = page.getByRole("dialog");
    const go = confirm.getByRole("button", { name: "Cancel all" });
    expect(await go.isDisabled()).toBe(true);
    await confirm.getByRole("textbox").fill("cancelAll");
    await go.click();
    await page.getByText("Cancel all: done").waitFor();
    // The Worker checked the typed text (it answers 428 without it); the project only gets the call.
    expect(prod.posts.at(-1)!.body).toEqual({ shard: "org:acme", dashboard: "pool", fn: "@pool/lib:cancelAll", args: {}, destructive: true });
    // An action form generated from the action's args.
    await page.getByRole("button", { name: "Enqueue" }).click();
    await page.getByRole("dialog").getByLabel("label").fill("nightly");
    await page.getByRole("dialog").getByRole("button", { name: "Enqueue" }).click();
    await expect.poll(() => (prod.posts.at(-1)!.body as { fn: string }).fn).toBe("@pool/lib:enqueueTest");
    expect(prod.posts.at(-1)!.body).toMatchObject({ args: { label: "nightly" } });
    await page.getByText("Enqueue: done").waitFor();
    // The audit log has every write as dashboard.run.
    await page.keyboard.press("a");
    const audit = page.getByRole("table", { name: "Audit log" });
    await expect.poll(async () => (await audit.locator("tbody tr").allTextContents()).filter((x) => x.includes("dashboard.run")).length).toBe(4);
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
    expect(problems).toEqual([]);
    await close();
  });

  it("declarative screens for the read role: the queries render, every write control is disabled", async () => {
    const { page, problems, close } = await open("#/p/chat/prod/components/org%3Aacme/pool", { token: "read-token-for-tests" });
    const t = page.getByRole("table", { name: "Work" });
    await expect.poll(() => t.locator("tbody tr").count()).toBe(2);
    expect(await page.getByRole("button", { name: "Cancel all" }).isDisabled()).toBe(true);
    expect(await t.getByRole("switch").first().isDisabled()).toBe(true);
    // Paging is a read; another shard starts on its first page (the cursor is the other shard's position).
    await page.getByRole("button", { name: "Next →" }).click();
    await expect.poll(() => prod.dashQueries.filter((q) => q.fn === "@pool/lib:listWork").at(-1)?.args).toMatchObject({ paginationOpts: { cursor: "2" } });
    await page.goto(`${origin}/#/p/chat/prod/components/org%3Abeta/pool`);
    await expect.poll(() => prod.dashQueries.filter((q) => q.fn === "@pool/lib:listWork").at(-1)).toMatchObject({ shard: "org:beta", args: { paginationOpts: { cursor: null } } });
    expect(prod.dashQueries.filter((q) => q.fn === "@pool/lib:listWork" && q.shard === "org:beta").map((q) => (q.args as { paginationOpts: { cursor: unknown } }).paginationOpts.cursor)).toEqual([null]);
    await page.getByText("page 1").waitFor();
    // The app has no screens of its own: the section says how to add them.
    await page.goto(`${origin}/#/p/chat/prod/app`);
    await page.getByText(/This app has no screens yet/).waitFor();
    expect(problems).toEqual([]);
    await close();
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
