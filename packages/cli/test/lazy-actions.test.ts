// Modules that export only actions go in the Worker as `import()` (build.ts `lazyActionModules`, server `lazyActions`):
// a split build keeps them, and the SDKs they import, out of the main module every isolate (each Shard DO) evaluates at
// startup. The actions still run — called by a client, by another action, scheduled from a mutation — with their real
// definition (declared errors, return validator).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildWorker, lazyActionModules, runtimeHasLazyActions, type WorkerBuild } from "../src/build.ts";
import { codegen } from "../src/codegen/index.ts";
import { loadProject, type Project } from "../src/config.ts";
import { startLocal } from "../src/local.ts";
import { cleanup, sampleProject } from "./helpers.ts";

const MARKER = "HEAVY_SDK_MARKER_7f3a";

let project: Project;
let lazy: WorkerBuild;
let eager: WorkerBuild;
let mf: Miniflare;
let url: URL;

beforeAll(async () => {
  project = sampleProject("lazy-actions");
  const dir = project.root;
  mkdirSync(join(dir, "lib"), { recursive: true });
  // A "large SDK": ~200 KB of code the action module imports.
  writeFileSync(join(dir, "lib/heavy.ts"), `export const HEAVY = ${JSON.stringify(MARKER + "x".repeat(200_000))};\nexport function heavyLength(s: string) { return HEAVY.length + s.length; }\n`);
  writeFileSync(
    join(dir, "ember/mailer.ts"),
    `import { v } from "@freecorps/ember-server";
import { api } from "./_generated/api";
import { action, internalAction } from "./_generated/server";
import { errors } from "./errors";
import { heavyLength } from "../lib/heavy";

export const send = action({
  args: { to: v.string(), times: v.number().default(1) },
  returns: v.number(),
  errors: [errors.MessageTooLong],
  handler: async (ctx, { to, times }) => {
    if (to.length > 10) ctx.fail.MessageTooLong({ max: 10 });
    return heavyLength(to) * times;
  },
});

export const bad = action({ args: {}, returns: v.string(), handler: async () => 42 as unknown as string });

export const viaAction = action({ args: { to: v.string() }, handler: async (ctx, { to }): Promise<number> => await ctx.runAction(api.mailer.send, { to }) });

export const record = internalAction({
  args: { to: v.string() },
  handler: async (ctx, { to }) => {
    await ctx.runMutation(api.mailer_log.add, { to, n: heavyLength(to) });
  },
});
`,
  );
  // Gated by a middleware (actions have no `authorize`: their gate is a middleware, which comes with the module).
  writeFileSync(
    join(dir, "ember/guarded.ts"),
    `import { defineErrors, v } from "@freecorps/ember-server";
import { action } from "./_generated/server";

const gate = defineErrors({ Denied: { message: "not for you" } });
const signedIn = action.use({
  errors: [gate.Denied],
  handler: async (ctx) => {
    if (!(await ctx.auth.getUserIdentity())) throw gate.Denied();
  },
});

export const secret = signedIn({ args: { n: v.number() }, handler: async (_ctx, { n }) => n * 2 });
`,
  );
  // A definition that depends on where it is evaluated: public in Node (where the build records it), internal in the
  // Worker. The stand-in says public; the loaded definition must not run for a client.
  writeFileSync(
    join(dir, "ember/flip.ts"),
    `import { action, internalAction } from "./_generated/server";

const inWorker = (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent === "Cloudflare-Workers";
export const flip = (inWorker ? internalAction : action)({ args: {}, handler: async () => "ran" });
`,
  );
  // A module of mutations/queries: static, and it schedules the lazy internal action.
  writeFileSync(
    join(dir, "ember/mailer_log.ts"),
    `import { v } from "@freecorps/ember-server";
import { internal } from "./_generated/api";
import { mutation, query } from "./_generated/server";

export const add = mutation({ args: { to: v.string(), n: v.number() }, handler: (ctx, a) => { ctx.db.insert("messages", { channel: "log", author: a.to, body: String(a.n) }); } });
export const schedule = mutation({ args: { to: v.string() }, handler: (ctx, { to }) => ctx.scheduler.runAfter(0, internal.mailer.record, { to }) });
export const scheduleBad = mutation({ args: {}, handler: (ctx) => ctx.scheduler.runAfter(0, internal.mailer.record, { to: 1 } as never) });
export const logged = query({ args: {}, handler: (ctx) => ctx.db.query("messages").withIndex("by_channel", (q) => q.eq("channel", "log")).collect() });
`,
  );
  const gen = await codegen(project);
  lazy = await buildWorker(project, { loaded: gen.loaded, outDir: join(project.stateDir, "build", "lazy") });
  writeFileSync(join(dir, "ember.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(dir, "ember.json"), "utf8")), build: { lazyActions: false } }, null, 2));
  const eagerProject = loadProject(dir);
  eager = await buildWorker(eagerProject, { loaded: gen.loaded, outDir: join(project.stateDir, "build", "eager") });
  ({ mf, url } = await startLocal(project, lazy, { persist: false }));
}, 120_000);

afterAll(async () => {
  await mf?.dispose();
  if (project) cleanup(project);
});

/** index.js and the chunks it imports statically (transitively): what every isolate evaluates at startup. */
function startup(b: WorkerBuild): { code: string; bytes: number } {
  const outputs = b.metafile!.outputs;
  const byName = new Map(Object.keys(outputs).map((k) => [k.split("/").at(-1)!, k]));
  const code = new Map([["index.js", b.code], ...(b.modules ?? []).map((m) => [m.name, m.code] as [string, string])]);
  const seen = new Set<string>();
  const walk = (name: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    const out = outputs[byName.get(name) ?? ""];
    if (!out) throw new Error(`startup: ${name} is not in the metafile's outputs (${[...byName.keys()].join(", ")})`);
    for (const i of out.imports) if (i.kind === "import-statement" && !i.external) walk(i.path.split("/").at(-1)!);
  };
  walk("index.js");
  const parts = [...seen].map((n) => code.get(n) ?? "");
  return { code: parts.join("\n"), bytes: parts.reduce((n, c) => n + Buffer.byteLength(c), 0) };
}

const post = async (path: string, body: unknown) => {
  const res = await mf.dispatchFetch(new URL(path, url), { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
  return (await res.json()) as { ok: boolean; value?: unknown; error?: { code: string; message: string; data?: unknown } };
};

describe("lazy action modules", () => {
  it("detects modules of actions only", () => {
    expect(readFileSync(lazy.entry, "utf8")).toMatch(/lazyActions\(\(\) => import\(".*mailer\.ts"\)/);
    expect(readFileSync(lazy.entry, "utf8")).toMatch(/lazyActions\(\(\) => import\(".*guarded\.ts"\)/);
    expect(readFileSync(lazy.entry, "utf8")).toMatch(/lazyActions\(\(\) => import\(".*flip\.ts"\)/);
    expect(readFileSync(lazy.entry, "utf8")).toMatch(/import \* as \w+ from ".*mailer_log\.ts"/);
    expect(readFileSync(lazy.entry, "utf8")).toMatch(/import \* as \w+ from ".*messages\.ts"/);
  });

  it("the action module and its dependency are not in what an isolate evaluates at startup; with lazyActions: false they are", () => {
    const lazyStart = startup(lazy);
    const eagerStart = startup(eager);
    expect(lazyStart.code).not.toContain(MARKER);
    expect(lazy.modules?.some((m) => m.code.includes(MARKER))).toBe(true);
    expect(eagerStart.code).toContain(MARKER);
    const kib = (n: number) => `${(n / 1024).toFixed(1)} KiB`;
    console.log(`startup modules: ${kib(eagerStart.bytes)} (static) → ${kib(lazyStart.bytes)} (lazy actions); index.js ${kib(Buffer.byteLength(eager.code))} → ${kib(Buffer.byteLength(lazy.code))}`);
    expect(lazyStart.bytes).toBeLessThan(eagerStart.bytes - 150_000);
  });

  it("a lazy action runs: defaults, validation, declared errors and its return validator", async () => {
    const shard = "global:main";
    expect(await post("/api/action", { fn: "mailer:send", args: { to: "ada" }, shard })).toMatchObject({ ok: true, value: MARKER.length + 200_000 + 3 });
    expect(await post("/api/action", { fn: "mailer:send", args: { to: "ada", times: 2 }, shard })).toMatchObject({ ok: true, value: 2 * (MARKER.length + 200_003) });
    expect(await post("/api/action", { fn: "mailer:send", args: { to: 1 }, shard })).toMatchObject({ ok: false, error: { code: "ValidationError" } });
    expect(await post("/api/action", { fn: "mailer:send", args: { to: "someone@far.away" }, shard })).toMatchObject({ ok: false, error: { code: "MessageTooLong", data: { max: 10 } } });
    expect(await post("/api/action", { fn: "mailer:bad", args: {}, shard })).toMatchObject({ ok: false, error: { code: "ValidationError" } });
    expect(await post("/api/action", { fn: "mailer:viaAction", args: { to: "bo" }, shard })).toMatchObject({ ok: true, value: MARKER.length + 200_002 });
    // Internal: not callable by clients.
    expect(await post("/api/action", { fn: "mailer:record", args: { to: "x" }, shard })).toMatchObject({ ok: false, error: { code: "FunctionNotFound" } });
  });

  it("with build.lazyActions: false every module is static", () => {
    const entry = readFileSync(eager.entry, "utf8");
    expect(entry).not.toMatch(/lazyActions\(/);
    expect(entry).toMatch(/import \* as \w+ from ".*mailer\.ts"/);
  });

  it("a lazy action's middleware gates it as a static one's would", async () => {
    const shard = "global:main";
    expect(await post("/api/action", { fn: "guarded:secret", args: { n: 2 }, shard })).toMatchObject({ ok: false, error: { code: "Denied" } });
    expect(await post("/api/action", { fn: "guarded:secret", args: { n: "x" }, shard })).toMatchObject({ ok: false, error: { code: "ValidationError" } });
  });

  it("a loaded definition that differs from the build's metadata does not run (internal in the Worker, public in the build)", async () => {
    const shard = "global:main";
    for (let i = 0; i < 2; i++) {
      const out = await post("/api/action", { fn: "flip:flip", args: {}, shard });
      expect(out.ok).toBe(false);
      expect(out.value).toBeUndefined();
    }
  });

  it("scheduled from a mutation: args checked against the recorded shape, then run by the shard", async () => {
    const shard = "global:main";
    expect(await post("/api/mutation", { fn: "mailer_log:scheduleBad", args: {}, shard })).toMatchObject({ ok: false, error: { code: "ValidationError" } });
    expect(await post("/api/mutation", { fn: "mailer_log:schedule", args: { to: "cy" }, shard })).toMatchObject({ ok: true });
    let logged: unknown[] = [];
    for (let i = 0; i < 100 && !logged.length; i++) {
      await new Promise((r) => setTimeout(r, 50));
      logged = (await post("/api/query", { fn: "mailer_log:logged", args: {}, shard })).value as unknown[];
    }
    expect(logged).toMatchObject([{ author: "cy", body: String(MARKER.length + 200_002) }]);
  });

  it("lazyActionModules leaves mixed modules and nested functions static", () => {
    const fn = (type: string, extra: Record<string, unknown> = {}) => ({ [Symbol.for("ember.function")]: true, type, visibility: "public", args: { kind: "object", fields: {} }, handler: () => 1, ...extra });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const out = lazyActionModules({
      // Plain values next to the actions: the registry never held them (only functions are registered); another module
      // that imports them imports the file, which esbuild then keeps where that static import puts it.
      only: { a: fn("action"), helper: 3, list: [1, 2] },
      mixed: { a: fn("action"), q: fn("query") },
      nested: { a: fn("action"), group: { b: fn("action") } },
      // Deeper than any fixed cut: the registry (flattenFunctions) finds it, so the module stays static.
      deep: { a: fn("action"), g: { l1: { l2: { l3: { l4: { l5: { q: fn("action") } } } } } } },
      cycle: { a: fn("action"), cyclic },
      // A field the build does not record (here a query-only gate): in doubt, static.
      unknownField: { a: fn("action", { authorize: () => true }) },
      future: { a: fn("action", { someGate: "x" }) },
      http: { a: fn("action"), h: { [Symbol.for("ember.function")]: true, type: "httpAction", handler: () => 1 } },
      none: { x: 1 },
      empty: {},
    });
    expect([...out.keys()]).toEqual(["only"]);
    expect(out.get("only")).toEqual({ a: { type: "action", visibility: "public", args: { kind: "object", fields: {} } } });
  });

  it("runtimeHasLazyActions: a runtime found neither from the project nor from the CLI means static modules", () => {
    const a = mkdtempSync(join(tmpdir(), "ember-lazy-a-"));
    const b = mkdtempSync(join(tmpdir(), "ember-lazy-b-"));
    try {
      expect(runtimeHasLazyActions(a, b)).toBe(false);
      // The CLI's own runtime (this repo) has it.
      expect(runtimeHasLazyActions(project.root)).toBe(true);
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });
});
