// `ember dev` end to end in Miniflare: one incremental esbuild context for the session's Worker bundles, and the
// watchers on ember/, .dev.vars (new values, no rebuild) and ember.json (config loaded again, rebuilt).
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildWorker, createWorkerBuildContext } from "../src/build.ts";
import { codegen } from "../src/codegen/index.ts";
import { loadProject, type Project } from "../src/config.ts";
import { dev, type DevSession } from "../src/dev.ts";
import { init } from "../src/init.ts";
import { TMP } from "./helpers.ts";

const dir = join(TMP, `dev-${process.pid}`);
let project: Project;
let session: DevSession;
const lines: string[] = [];

/** Waits until a log line matches (the watchers debounce 150 ms, then rebuild). */
async function logged(re: RegExp, from: number, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (lines.slice(from).some((l) => re.test(l))) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`no log line ${re} (got: ${lines.slice(from).join(" | ")})`);
}

const env = async (name: string) => {
  const res = await fetch(new URL("/api/action", session.url), {
    method: "POST",
    headers: { "content-type": "application/json", origin: session.url.origin },
    body: JSON.stringify({ fn: "hello:env", args: { name }, shard: "global:main" }),
  });
  return ((await res.json()) as { value?: unknown }).value;
};

beforeAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  init({ dir, project: "devloop" });
  writeFileSync(join(dir, "ember/hello.ts"), `import { v } from "@freecorps/ember-server";\nimport { action } from "./_generated/server";\nexport const env = action({ args: { name: v.string() }, handler: async (ctx, a) => String(ctx.env[a.name] ?? "") });\n`);
  writeFileSync(join(dir, ".dev.vars"), "GREETING=one\n");
  project = loadProject(dir);
  session = await dev(project, { port: 0, persist: false, log: (l) => lines.push(l) });
});
afterAll(async () => {
  await session?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("ember dev", () => {
  it("serves the app with .dev.vars", async () => {
    expect(await env("GREETING")).toBe("one");
    expect(session.stats).toEqual({ builds: 1, contexts: 1 });
  });

  it(".dev.vars changes reach the Worker without a rebuild", async () => {
    const from = lines.length;
    writeFileSync(join(dir, ".dev.vars"), "GREETING=two\n");
    await logged(/\.dev\.vars: reloaded/, from);
    await session.idle();
    expect(await env("GREETING")).toBe("two");
    expect(session.stats.builds).toBe(1);
  });

  it("an ember/ change rebuilds through the same esbuild context", async () => {
    const from = lines.length;
    writeFileSync(join(dir, "ember/hello.ts"), readFileSync(join(dir, "ember/hello.ts"), "utf8").replace('String(ctx.env[a.name] ?? "")', '`v2:${String(ctx.env[a.name] ?? "")}`'));
    await logged(/^reloaded$/, from);
    await session.idle();
    expect(await env("GREETING")).toBe("v2:two");
    expect(session.stats).toEqual({ builds: 2, contexts: 1 });
  });

  it("ember.json changes reload the config and rebuild", async () => {
    const from = lines.length;
    const cfg = JSON.parse(readFileSync(join(dir, "ember.json"), "utf8"));
    writeFileSync(join(dir, "ember.json"), JSON.stringify({ ...cfg, locationHint: "weur" }, null, 2));
    await logged(/ember\.json: reloaded/, from);
    await session.idle();
    expect(await env("EMBER_LOCATION_HINT")).toBe("v2:weur");
    expect(session.stats.builds).toBe(3);
    // A broken ember.json is reported and the previous config is kept.
    const before = lines.length;
    writeFileSync(join(dir, "ember.json"), "{ not json");
    await logged(/error: .*ember\.json/, before);
    expect(await env("EMBER_LOCATION_HINT")).toBe("v2:weur");
    writeFileSync(join(dir, "ember.json"), JSON.stringify({ ...cfg, locationHint: "weur" }, null, 2));
    await logged(/ember\.json: reloaded/, before);
  });
});

describe("buildWorker with a context", () => {
  it("rebuilds incrementally with one context, picks up changes, and starts a new one when the options change", async () => {
    const p = loadProject(dir);
    await codegen(p);
    const ctx = createWorkerBuildContext();
    try {
      const outDir = join(p.stateDir, "build", "ctx-test");
      const oneOff = await buildWorker(p, { outDir });
      const a = await buildWorker(p, { outDir, context: ctx });
      // Same output as a one-off build.
      expect(a.code).toBe(oneOff.code);
      const b = await buildWorker(p, { outDir, context: ctx });
      expect(b.sha256).toBe(a.sha256);
      expect(ctx.stats).toEqual({ contexts: 1, rebuilds: 2 });
      writeFileSync(join(p.dir, "hello.ts"), readFileSync(join(p.dir, "hello.ts"), "utf8").replace("v2:", "v3:"));
      const c = await buildWorker(p, { outDir, context: ctx });
      expect(c.sha256).not.toBe(a.sha256);
      expect(c.code).toContain("v3:");
      // Other options (a minified build): another context, the old one disposed.
      await buildWorker(p, { outDir, context: ctx, minify: true });
      expect(ctx.stats).toEqual({ contexts: 2, rebuilds: 4 });
    } finally {
      await ctx.dispose();
    }
    expect(ctx.ctx).toBeUndefined();
  });
});
