// OPFS storage (and IndexedDB coordinated across tabs) in a real browser (headless Chromium through playwright-core; reuses an installed Playwright
// browser, skipped when there is none). Several real tabs of one origin share one storage name:
//   tab A (online, engine in the page) leads: its Worker owns the OPFS files; tab B (offline) follows;
//   B's local results come from A's Worker and re-render when A's server values change rows (cross-tab, reactive);
//   B's offline mutation is queued in the shared storage; A's tab closes → B's Worker takes the files over;
//   B closes → a fresh tab C, offline, finds the replica (FTS5 search included) and B's queued mutation in OPFS.
import { createServer, type Server } from "node:http";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const executable = (() => {
  try {
    return chromium.executablePath();
  } catch {
    return "";
  }
})();
const hasBrowser = !!executable && existsSync(executable);

describe.skipIf(!hasBrowser)("offline storage in Chromium", () => {
  let dir = "";
  let server: Server;
  let browser: Browser;
  let origin = "";

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "ember-opfs-e2e-"));
    await build({
      entryPoints: { page: join(here, "page.ts"), worker: join(here, "worker.ts") },
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      outdir: dir,
      conditions: ["@freecorps/ember-source", "browser", "import"],
      logLevel: "error",
    });
    // SQLite-Wasm fetches its .wasm next to the module that loads it (`new URL("sqlite3.wasm", import.meta.url)`).
    const wasm = createRequire(import.meta.url).resolve("@sqlite.org/sqlite-wasm/sqlite3.wasm");
    copyFileSync(wasm, join(dir, "sqlite3.wasm"));
    writeFileSync(join(dir, "index.html"), `<!doctype html><meta charset="utf-8"><script type="module" src="./page.js"></script>`);
    const types: Record<string, string> = { ".js": "text/javascript", ".html": "text/html", ".wasm": "application/wasm" };
    server = createServer((rq, rs) => {
      const file = join(dir, new URL(rq.url ?? "/", "http://x").pathname.replace(/^\/$/, "/index.html"));
      if (!file.startsWith(dir) || !existsSync(file)) return void rs.writeHead(404).end();
      rs.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browser = await chromium.launch({ headless: true });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    server?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  let kind: "opfs" | "indexeddb" = "opfs";
  const open = async (ctx: Awaited<ReturnType<Browser["newContext"]>>, name: string, online: boolean, seed: Array<{ channel: string; body: string }> = []) => {
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    await page.goto(`${origin}/`);
    await page.waitForFunction(() => !!(globalThis as any).t);
    await page.evaluate((o) => (globalThis as any).t.start(o), { name, online, seed, kind });
    return { page, errors };
  };
  const snap = (p: Page, key: string) => p.evaluate((k) => (globalThis as any).t.snap(k), key);
  const bodiesOf = (s: any) => (s?.value ?? []).map((d: any) => d.body);
  const waitSnap = (p: Page, key: string, pred: string) =>
    p.waitForFunction(([k, f]) => {
      const s = (globalThis as any).t.snap(k);
      return !!s && new Function("s", `return ${f}`)(s);
    }, [key, pred] as const, { timeout: 10_000 });

  it.each(["opfs", "indexeddb"] as const)("%s: one leader owns the storage; other tabs read, watch and queue through it; it hands over; data persists", async (k) => {
    kind = k;
    const ctx = await browser.newContext();
    const name = `chat-${Date.now()}`;
    const a = await open(ctx, name, true, [
      { channel: "a", body: "Olá, ação!" },
      { channel: "a", body: "segunda" },
    ]);
    await a.page.evaluate(() => (globalThis as any).t.sub("list", "messages:list", { channel: "a" }));
    await waitSnap(a.page, "list", "s.status === 'success' && s.source === null");
    await a.page.waitForFunction(() => (globalThis as any).t.roles.includes("leader"));
    await a.page.evaluate(() => (globalThis as any).t.flush());

    const b = await open(ctx, name, false);
    await b.page.waitForFunction(() => (globalThis as any).t.roles.includes("follower"));
    await b.page.evaluate(() => {
      const t = (globalThis as any).t;
      t.sub("latest", "messages:latest", { channel: "a", n: 5 });
      t.sub("search", "messages:search", { q: "acao" });
    });
    await waitSnap(b.page, "latest", "s.status === 'success' && s.value.length === 2");
    expect(await snap(b.page, "latest")).toMatchObject({ source: "local" });
    await waitSnap(b.page, "search", "s.status === 'success'");
    expect(await snap(b.page, "search")).toMatchObject({ value: ["Olá, ação!"], source: "local" }); // FTS5 in the Worker

    // A writes on the server; its patch lands in the shared replica; B's local result re-renders
    await a.page.evaluate(() => (globalThis as any).t.mutate("messages:send", { channel: "a", body: "terceira" }));
    await waitSnap(b.page, "latest", "s.value.length === 3");
    expect(bodiesOf(await snap(b.page, "latest"))).toEqual(["terceira", "segunda", "Olá, ação!"]);

    // B mutates offline: queued in the shared storage (through A's Worker)
    await b.page.evaluate(() => (globalThis as any).t.mutate("messages:send", { channel: "a", body: "escrita em B" }));
    await b.page.evaluate(() => (globalThis as any).t.flush());
    expect(await b.page.evaluate(() => (globalThis as any).t.pending())).toBe(1);

    // A's tab closes: its Worker dies with it; B's Worker gets the lock and the OPFS files
    await a.page.close();
    await b.page.waitForFunction(() => (globalThis as any).t.roles.includes("leader"), undefined, { timeout: 10_000 });
    await b.page.evaluate(() => (globalThis as any).t.sub("list2", "messages:list", { channel: "a" }));
    await waitSnap(b.page, "list2", "s.status === 'success' && s.value.length === 3");
    expect(await snap(b.page, "list2")).toMatchObject({ source: "local" });

    // everything closes; a fresh offline tab finds the replica and the queue on disk
    await b.page.close();
    const c = await open(ctx, name, false);
    await c.page.waitForFunction(() => (globalThis as any).t.roles.includes("leader"), undefined, { timeout: 10_000 });
    await c.page.evaluate(() => {
      const t = (globalThis as any).t;
      t.sub("list", "messages:list", { channel: "a" });
      t.sub("search", "messages:search", { q: "terceira" });
    });
    await waitSnap(c.page, "list", "s.status === 'success' && s.value.length === 3");
    await waitSnap(c.page, "search", "s.status === 'success'");
    expect(await snap(c.page, "search")).toMatchObject({ value: ["terceira"], source: "local" });
    expect(await c.page.evaluate(() => (globalThis as any).t.pending())).toBe(1);
    if (k === "opfs") {
      const files: string[] = await c.page.evaluate(() => (globalThis as any).t.opfs());
      expect(files).toContain(`.ember-${name}`);
      console.log(`[browser] ${await c.page.evaluate(() => navigator.userAgent)}\n  opfs: ${files.filter((f) => f.includes(name)).join(", ")}`);
    }
    expect([...a.errors, ...b.errors, ...c.errors]).toEqual([]);
    await ctx.close();
  }, 60_000);
});
