// `ember init --auth` end to end in Miniflare (the real bundle: Better Auth in the Auth DO + the Ember runtime):
// codegen auth types, generated entry, /api/auth/*, JWT → ctx.auth, profile sync outbox, sensitive mutations.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildWorker, CHUNK_RE, hasProfileSync, workerEntrySource, type WorkerBuild } from "../src/build.ts";
import { codegen } from "../src/codegen/index.ts";
import { loadProject, projectFrom, type Project } from "../src/config.ts";
import { init } from "../src/init.ts";
import { startLocal } from "../src/local.ts";
import { discover } from "../src/modules.ts";
import { cleanup, TMP } from "./helpers.ts";

let project: Project;
let mf: Miniflare;
let url: URL;
let build: WorkerBuild;

beforeAll(async () => {
  const dir = join(TMP, `auth-${process.pid}`);
  init({ dir, project: "chat", auth: true, force: true });
  project = loadProject(dir);
  await codegen(project);
  build = await buildWorker(project);
  ({ mf, url } = await startLocal(project, build, { persist: false }));
});
afterAll(async () => {
  await mf?.dispose();
  if (project) cleanup(project);
});

async function call(path: string, init: { method?: string; body?: unknown; token?: string } = {}) {
  const headers: Record<string, string> = { origin: url.origin };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  const res = await mf.dispatchFetch(new URL(path, url), {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, headers: res.headers };
}
const fn = (kind: "query" | "mutation", name: string, args: unknown, token?: string) =>
  call(`/api/${kind}`, { body: { fn: name, args, shard: "global:main" }, ...(token ? { token } : {}) });

describe("codegen and entry with ember/auth.config.ts", () => {
  it("emits read-only auth:* types without hidden fields and marks sensitive functions", () => {
    const dts = readFileSync(join(project.generatedDir, "dataModel.d.ts"), "utf8");
    expect(dts).toContain(`"auth:user": {`);
    expect(dts).toContain(`"auth:organization": {`);
    expect(dts).toMatch(/export type Doc<TableName extends TableNames \| AuthTableNames>/);
    expect(dts).not.toMatch(/^\s+(password|privateKey|token|accessToken|refreshToken|value)\??:/m);
    const manifest = JSON.parse(readFileSync(join(project.generatedDir, "manifest.json"), "utf8"));
    expect(manifest.auth.mode).toBe("local");
    expect(manifest.functions.find((f: any) => f.name === "users:spendCredits").sensitive).toBe(true);
  });

  it("generated entry exports Auth with the outbox and passes auth to createEmberWorker", () => {
    const src = readFileSync(join(project.stateDir, "build", "worker", "entry.mjs"), "utf8");
    // Better Auth and auth.config.ts behind import(): the Shard isolates never evaluate them.
    expect(src).toContain(`import { emberAuthLazy } from "@freecorps/ember-auth/lazy";`);
    expect(src).not.toMatch(/^import authConfig/m);
    expect(src).toMatch(/const auth = emberAuthLazy\(\(\) => import\(".*auth\.config\.ts"\), \{ project: "chat", onUserChange: outbox\.onUserChange, static: \{"basePath":"\/api\/auth","cookieStrategy":"compact","worker":\{"hasher":"default"\}\} \}\);/);
    expect(src).toContain("export const Auth = outbox.wrap(auth.Auth);");
    expect(src).toContain("createEmberWorker({ schema, functions, crons, auth, app, http, triggers })");
  });

  it("the bundle is split: Better Auth, the config and the cookie-cache decoder are chunks outside every isolate's startup", () => {
    const m = build.metafile!;
    const out = (f: string) => m.outputs[f]!;
    // (Every `import()` target is an entry point of its own in a split build: the main module is the one named index.js.)
    const main = Object.keys(m.outputs).find((f) => f.endsWith("/index.js"))!;
    expect(out(main).entryPoint).toMatch(/entry\.mjs$/);
    // What a Worker compiles and evaluates at startup: the main module and the chunks it imports statically.
    const startup = new Set<string>();
    const walk = (f: string) => {
      if (startup.has(f)) return;
      startup.add(f);
      for (const i of out(f).imports) if (i.kind === "import-statement" && !i.external) walk(i.path);
    };
    walk(main);
    const inputsOf = (files: Iterable<string>) => [...files].flatMap((f) => Object.keys(out(f).inputs));
    const heavy = /node_modules\/(?:\.bun\/[^/]+\/node_modules\/)?(better-auth|@better-auth|zod|kysely|better-call|@noble\/hashes|@noble\/ciphers)\//;
    expect(inputsOf(startup).filter((p) => heavy.test(p) || p.endsWith("auth.config.ts"))).toEqual([]);
    // The runtime's cold paths (admin endpoints, `ctx.browser`) load through `import()` too: the entry imports
    // `@freecorps/ember-runtime/worker-entry`, not the package root, which would reach them statically.
    expect(readFileSync(build.entry, "utf8")).toContain('from "@freecorps/ember-runtime/worker-entry"');
    expect(inputsOf(startup).filter((p) => /runtime\/src\/(admin-api|browser)\.ts$/.test(p))).toEqual([]);
    const all = inputsOf(Object.keys(m.outputs).filter((f) => f.endsWith(".js")));
    expect(all.some((p) => p.endsWith("ember/auth.config.ts"))).toBe(true);
    expect(all.some((p) => /better-auth\/dist\/cookies\//.test(p))).toBe(true);
    // Bundle size: the startup graph is a fraction of the whole (Better Auth alone is most of it).
    const bytes = (files: Iterable<string>) => [...files].reduce((n, f) => n + out(f).bytes, 0);
    const total = bytes(Object.keys(m.outputs).filter((f) => f.endsWith(".js")));
    expect(bytes(startup)).toBeLessThan(total * 0.6);
    expect(build.bytes).toBe(total);
    // Every chunk is in the build (and on disk, next to index.js), named as index.js imports it.
    expect(build.modules?.length).toBe(Object.keys(m.outputs).filter((f) => f.endsWith(".js")).length - 1);
    for (const c of build.modules!) {
      expect(c.name).toMatch(CHUNK_RE);
      expect(readFileSync(join(dirname(build.outFile), c.name), "utf8")).toBe(c.code);
    }
    expect(build.code).toMatch(/import\("\.\/chunk-[A-Z0-9]+\.js"\)/);
  });

  it("a minified (deploy) build: production NODE_ENV, no legal comments, a linked map per module; stale chunks are removed", async () => {
    const outDir = join(project.stateDir, "build", "worker-min");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "chunk-STALE234.js"), "stale");
    writeFileSync(join(outDir, "chunk-STALE234.js.map"), "{}");
    const probe = join(project.dir, "nodeEnv.ts");
    writeFileSync(probe, `import { query } from "./_generated/server";\nexport const env = query({ args: {}, handler: async () => (process.env.NODE_ENV === "production" ? "prod" : "dev") });\n/*! legal: kept only when legalComments is not none */\nexport const legal = 1;\n`);
    try {
      await codegen(project);
      const b = await buildWorker(project, { outDir, minify: true });
      expect(existsSync(join(outDir, "chunk-STALE234.js"))).toBe(false);
      expect(existsSync(join(outDir, "chunk-STALE234.js.map"))).toBe(false);
      expect(b.code).toContain('"prod"');
      expect(b.code).not.toContain("legal: kept");
      expect(b.code).toMatch(/\/\/# sourceMappingURL=index\.js\.map\s*$/);
      expect(JSON.parse(b.map!).version).toBe(3);
      expect(b.modules!.length).toBeGreaterThan(0);
      for (const c of b.modules!) {
        expect(c.code).toMatch(new RegExp(`//# sourceMappingURL=${c.name.replace(".", "\\.")}\\.map\\s*$`));
        expect(JSON.parse(c.map!).version).toBe(3);
        // Deploy maps carry no copy of the sources (names + mappings remap stack traces).
        expect(JSON.parse(c.map!).sourcesContent).toBeUndefined();
      }
      expect(JSON.parse(b.map!).sourcesContent).toBeUndefined();
      // `ember dev` keeps the runtime lookup.
      const dev = await buildWorker(project, { outDir: join(project.stateDir, "build", "worker-dev") });
      expect(dev.code).toContain("process.env.NODE_ENV");
      expect(dev.modules!.every((c) => c.map === undefined)).toBe(true);
    } finally {
      rmSync(probe, { force: true });
      await codegen(project);
    }
  });

  it("reuses the project codegen evaluated (same entry, no second evaluation)", async () => {
    const gen = await codegen(project);
    const b = await buildWorker(project, { outDir: join(project.stateDir, "build", "worker-loaded"), loaded: gen.loaded });
    const reused = readFileSync(join(project.stateDir, "build", "worker-loaded", "entry.mjs"), "utf8");
    expect(reused).toBe(readFileSync(join(project.stateDir, "build", "worker", "entry.mjs"), "utf8"));
    expect(b.auth?.kind).toBe("local");
    expect(b.auth).toMatchObject({ profileSync: true });
  });

  it("an app without users:sync gets no onUserChange (no user journal triggers in the Auth DO)", async () => {
    const gen = await codegen(project);
    expect(hasProfileSync(gen.loaded.modules)).toBe(true);
    const { sync: _sync, ...users } = gen.loaded.modules.users!;
    const loaded = { ...gen.loaded, modules: { ...gen.loaded.modules, users } };
    expect(hasProfileSync(loaded.modules)).toBe(false);
    const b = await buildWorker(project, { outDir: join(project.stateDir, "build", "worker-nosync"), loaded });
    expect(b.auth).toMatchObject({ kind: "local", profileSync: false });
    const src = readFileSync(join(project.stateDir, "build", "worker-nosync", "entry.mjs"), "utf8");
    expect(src).not.toContain("onUserChange");
    expect(src).toMatch(/const auth = emberAuthLazy\(\(\) => import\(".*auth\.config\.ts"\), \{ project: "chat", static: /);
    // The outbox still wraps the class (alarm: discards a journal an earlier version left, replication).
    expect(src).toContain("export const Auth = outbox.wrap(auth.Auth);");
    const eager = workerEntrySource(discover(project.dir), { kind: "local", project: "chat", syncShard: "global:main", profileSync: false }, "eager");
    expect(eager).toContain(`const auth = emberAuth(authConfig, { project: "chat" });`);
  });

  it("an @freecorps/ember-auth without the lazy entry gets the eager entry", () => {
    const src = workerEntrySource(discover(project.dir), { kind: "local", project: "chat", syncShard: "global:main" }, "eager");
    expect(src).toContain(`import { emberAuth } from "@freecorps/ember-auth/worker";`);
    expect(src).toContain(`const auth = emberAuth(authConfig, { project: "chat", onUserChange: outbox.onUserChange });`);
    expect(src).toContain("export const Auth = outbox.wrap(auth.Auth);");
  });

  it("SSO (auth.from) uses remoteAuth and no Auth DO; refuses a local auth.config.ts too", () => {
    const p = projectFrom(project.root, { ...project.config, auth: { from: "https://id.example.com" } });
    const files = discover(project.dir);
    expect(() => workerEntrySource(files, null)).not.toThrow();
    const remote = workerEntrySource({ ...files, authConfig: null }, { kind: "remote", from: "https://id.example.com" });
    expect(remote).toContain(`remoteAuth({ from: "https://id.example.com" })`);
    expect(remote).not.toContain("export const Auth");
    return expect(buildWorker(p)).rejects.toThrow(/mutually exclusive/);
  });

  it("refuses user tables with reserved auth names", async () => {
    const schema = join(project.dir, "schema.ts");
    const orig = readFileSync(schema, "utf8");
    try {
      writeFileSync(schema, orig.replace("profiles: defineTable", "session: defineTable"));
      await expect(codegen(project)).rejects.toThrow(/reserved for auth: session/);
    } finally {
      writeFileSync(schema, orig);
    }
  });
});

describe("auth flows in the bundled Worker (Miniflare)", () => {
  const email = `ada-${Date.now()}@example.com`;
  const password = "correct-horse-battery";
  let session = "";
  let jwt = "";

  it("sign-up, sign-in, JWT; ctx.auth sees the identity; the profile is synced through the outbox", async () => {
    const up = await call("/api/auth/sign-up/email", { body: { email, password, name: "Ada" } });
    expect(up.status).toBe(200);
    const signIn = await call("/api/auth/sign-in/email", { body: { email, password } });
    expect(signIn.status).toBe(200);
    session = signIn.headers.get("set-auth-token") ?? signIn.json.token;
    expect(session).toBeTruthy();
    const tok = await call("/api/auth/token", { token: session });
    expect(tok.status).toBe(200);
    jwt = tok.json.token;
    expect(jwt.split(".")).toHaveLength(3);

    let me: any;
    for (let i = 0; i < 100; i++) {
      me = await fn("query", "users:me", {}, jwt);
      if (me.json?.value?.profile) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(me.json.value).toMatchObject({ subject: up.json.user.id, email, profile: { email, name: "Ada", credits: 0 } });
    expect((await fn("query", "users:me", {})).json.value).toBeNull();
    expect((await fn("query", "users:me", {}, "not-a-token")).status).toBe(401);
  });

  it("sensitive mutation works signed in and is refused right after sign-out (JWT still valid)", async () => {
    expect((await fn("mutation", "users:addCredits", { amount: 10 }, jwt)).json.value).toBe(10);
    expect((await fn("mutation", "users:spendCredits", { amount: 3 }, jwt)).json).toMatchObject({ ok: true, value: 7 });
    expect((await call("/api/auth/sign-out", { body: {}, token: session })).status).toBe(200);
    const denied = await fn("mutation", "users:spendCredits", { amount: 1 }, jwt);
    expect(denied).toMatchObject({ status: 401, json: { ok: false, error: { code: "unauthenticated" } } });
    // Non-sensitive calls still accept the (short-lived) JWT.
    expect((await fn("mutation", "users:addCredits", { amount: 1 }, jwt)).json.value).toBe(8);
  });
});
