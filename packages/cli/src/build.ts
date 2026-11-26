// esbuild: (1) a Node bundle of the user's schema/functions/crons, imported by codegen to read the manifest, and
// (2) the Worker bundle for workerd: a generated entry that calls createEmberWorker and exports the DO classes.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import { basename, dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { constants as vmConstants, runInThisContext } from "node:vm";
import { cronList } from "@freecorps/ember-server";
import * as esbuild from "esbuild";
import type { AuthStaticSettings } from "@freecorps/ember-auth";
import { authSettings, SESSION_LOOKUP_SECRET_DEFAULT, type Project } from "./config.ts";
import { discover, ident, type ProjectFiles } from "./modules.ts";
import { CLI_ROOT, SOURCE_CONDITIONS } from "./source.ts";
import { WORKER_BUILD_OPTIONS } from "./worker-bundle.ts";

/** Fallback resolution: the CLI's own dependencies (@freecorps/ember-runtime, @freecorps/ember-server) when the project lacks them. */
const NODE_PATHS = [join(CLI_ROOT, "node_modules"), resolve(CLI_ROOT, "..", "..")];

/**
 * Version of the `@freecorps/ember-runtime` the Worker bundle gets: the first `node_modules` copy from the project up
 * (as esbuild resolves it), then from the CLI up (its own dependency). Deployed as the EMBER_RUNTIME_VERSION var.
 * Null when none is found.
 */
export function runtimeVersion(projectDir: string, cliRoot: string = CLI_ROOT): string | null {
  const j = packageJsonOf("@freecorps/ember-runtime", projectDir, cliRoot);
  return typeof j?.version === "string" ? j.version : null;
}

/** package.json of `name` as esbuild resolves it: the first `node_modules` copy from the project up, then from the CLI up. */
function packageJsonOf(name: string, projectDir: string, cliRoot: string = CLI_ROOT): { name?: string; version?: string; exports?: Record<string, unknown> } | null {
  for (const start of [projectDir, cliRoot]) {
    for (let d = resolve(start); ; d = dirname(d)) {
      const pkg = join(d, "node_modules", ...name.split("/"), "package.json");
      if (existsSync(pkg)) {
        try {
          const j = JSON.parse(readFileSync(pkg, "utf8")) as { name?: string; version?: string; exports?: Record<string, unknown> };
          if (j.name === name) return j;
        } catch {
          // unreadable: keep looking
        }
      }
      if (dirname(d) === d) break;
    }
  }
  return null;
}

/**
 * Whether the project's `@freecorps/ember-auth` has the lazy entry (`/lazy`, 0.8+). An older copy next to a newer
 * CLI gets the eager entry it understands. Unknown (not found): assume the CLI's own, which has it.
 */
export function authHasLazy(projectDir: string, cliRoot: string = CLI_ROOT): boolean {
  const j = packageJsonOf("@freecorps/ember-auth", projectDir, cliRoot);
  return !j?.exports || "./lazy" in j.exports;
}

/**
 * Whether the project's `@freecorps/ember-auth` has the light SSO entry (`/remote`: `remoteAuth` without Better Auth).
 * An older copy gets `remoteAuth` from `/worker`. Unknown (not found): assume the CLI's own, which has it.
 */
export function authHasRemote(projectDir: string, cliRoot: string = CLI_ROOT): boolean {
  const j = packageJsonOf("@freecorps/ember-auth", projectDir, cliRoot);
  return !j?.exports || "./remote" in j.exports;
}

/**
 * Whether the project's `@freecorps/ember-runtime` has `/worker-entry` (only what the generated entry imports), which
 * keeps the runtime's lazy modules (admin API, `ctx.browser`, …) out of the chunks loaded at startup. An older copy is
 * imported from its root. Unknown (not found): assume the CLI's own, which has it.
 */
export function runtimeHasWorkerEntry(projectDir: string, cliRoot: string = CLI_ROOT): boolean {
  const j = packageJsonOf("@freecorps/ember-runtime", projectDir, cliRoot);
  return !j?.exports || "./worker-entry" in j.exports;
}

/**
 * Whether the project's `@freecorps/ember-runtime` registers lazy actions (`lazyActions` in `/worker-entry`, and an
 * `ActionRunner` that loads them): read from the entry's own file. An older copy gets every module imported statically.
 * Unknown (not found): assume the CLI's own, which has it.
 */
export function runtimeHasLazyActions(projectDir: string, cliRoot: string = CLI_ROOT): boolean {
  for (const start of [projectDir, cliRoot]) {
    for (let d = resolve(start); ; d = dirname(d)) {
      const dir = join(d, "node_modules", "@freecorps", "ember-runtime");
      if (existsSync(join(dir, "package.json"))) {
        for (const f of ["src/worker-entry.ts", "dist/worker-entry.js"]) {
          try {
            if (/\blazyActions\b/.test(readFileSync(join(dir, f), "utf8"))) return true;
          } catch {
            // not this layout
          }
        }
        return false;
      }
      if (dirname(d) === d) break;
    }
  }
  return true;
}

/** What `lazyActions` gets for one action of a lazy module (plain JSON; see `LazyActionMeta` in the server). */
export type LazyActionMeta = Record<string, unknown>;

/**
 * Modules that export only actions (`action`/`internalAction`, at least one), as the project evaluated in Node shows
 * them: they go in the Worker as `import()` (`lazyActions`), so a split build keeps them and what they import out of
 * the chunks every isolate (each Shard DO) evaluates at startup. Queries and mutations stay static: the engine runs
 * them synchronously. A module is left static when it holds functions in nested objects (the registry would name them
 * differently) or when what the engine reads before loading it (args, returns, shard...) does not survive JSON.
 */
export function lazyActionModules(modules: LoadedProject["modules"]): Map<string, Record<string, LazyActionMeta>> {
  const out = new Map<string, Record<string, LazyActionMeta>>();
  const isFn = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && (x as Record<symbol, unknown>)[Symbol.for("ember.function")] === true;
  const nestsFunctions = (x: unknown, depth = 0): boolean => {
    if (typeof x !== "object" || x === null || depth > 4) return false;
    if (isFn(x)) return true;
    try {
      return Object.values(x).some((y) => nestsFunctions(y, depth + 1));
    } catch {
      return true;
    }
  };
  next: for (const [path, mod] of Object.entries(modules)) {
    const meta: Record<string, LazyActionMeta> = {};
    for (const [name, x] of Object.entries(mod ?? {})) {
      if (isFn(x)) {
        if (x.type !== "action") continue next;
        const m: LazyActionMeta = { type: "action", visibility: x.visibility, args: x.args };
        for (const k of ["returns", "shard", "dispatch", "leaseMs", "sensitive", "declaresErrors"] as const) if (x[k] !== undefined) m[k] = x[k];
        const errors = Array.isArray(x.errors) ? (x.errors as Array<{ code?: unknown }>).map((e) => String(e?.code ?? "")).filter(Boolean) : [];
        if (errors.length) m.errorCodes = errors;
        let same = false;
        try {
          same = isDeepStrictEqual(JSON.parse(JSON.stringify(m)), m);
        } catch {
          same = false;
        }
        if (!same) continue next;
        meta[name] = m;
      } else if (typeof x === "object" && x !== null && !name.includes(":") && nestsFunctions(x)) continue next;
    }
    if (Object.keys(meta).length) out.set(path, meta);
  }
  return out;
}

/** Durable Object classes exported by every Ember Worker (PLAN D4). */
export const DO_CLASSES = [
  { className: "Shard", binding: "SHARD" },
  { className: "System", binding: "SYSTEM" },
] as const;
/** The project's own `Auth` DO (Better Auth next to its SQLite), when `ember/auth.config.ts` exists. */
export const AUTH_DO = { className: "Auth", binding: "AUTH" } as const;

export type DoClass = { className: string; binding: string };
export const doClasses = (auth: boolean): DoClass[] => (auth ? [...DO_CLASSES, AUTH_DO] : [...DO_CLASSES]);

/**
 * How the Worker authenticates: its own `Auth` DO (`ember/auth.config.ts`), another project's JWTs (ember.json
 * `auth.from`, SSO), or no auth hook at all.
 */
export type AuthMode =
  | {
      kind: "local";
      project: string;
      syncShard: string;
      turnstile?: true | import("./config.ts").TurnstileConfig;
      /**
       * Profile sync (PLAN §9): the app has `users:sync`, so the entry wires `onUserChange` (and the Auth DO its user
       * journal triggers). False: no hook, no triggers (+2 rows written per user write for nothing). Default true.
       */
      profileSync?: boolean;
    }
  | { kind: "remote"; from: string; sessionLookup?: import("./config.ts").SessionLookupConfig }
  | null;

export function authModeOf(project: Project, files: Pick<ProjectFiles, "authConfig">, env?: string): AuthMode {
  const s = authSettings(project, env);
  if (s.from) {
    if (files.authConfig) throw new Error(`ember.json auth.from (SSO) and ember/auth.config.ts are mutually exclusive: remove one`);
    if (s.turnstile) throw new Error(`ember.json auth.turnstile protects this project's own sign-up/sign-in: with auth.from (SSO) set it on the identity project`);
    // A project name is resolved to its URL by `ember deploy` (registry, sso.ts); other commands need the URL.
    if (!/^https?:\/\//.test(s.from)) throw new Error(`auth.from "${s.from}" is a project name: \`ember deploy\` resolves it through the account registry; for ${env ?? "this command"} set environments.${env ?? "<env>"}.auth.from to the identity project's URL`);
    return { kind: "remote", from: s.from, ...(s.sessionLookup ? { sessionLookup: s.sessionLookup } : {}) };
  }
  if (s.sessionLookup) {
    throw new Error(`ember.json auth.sessionLookup checks sessions of auth.from's JWTs: set auth.from too (a project with its own auth checks sessions in its Auth DO)`);
  }
  if (s.turnstile && !files.authConfig) throw new Error(`ember.json auth.turnstile needs ember/auth.config.ts (the project's own auth)`);
  if (files.authConfig) return { kind: "local", project: project.config.project, syncShard: s.syncShard ?? "global:main", ...(s.turnstile ? { turnstile: s.turnstile } : {}) };
  return null;
}

const spec = (file: string) => JSON.stringify(file.split("\\").join("/"));

/** The runtime entry the generated Worker imports (`/worker-entry`), or the package root for an older runtime. */
export const RUNTIME_WORKER_ENTRY = "@freecorps/ember-runtime/worker-entry";

/** Worker entry module source. Static imports only: a Worker cannot list files at runtime. */
/**
 * `authStatic`: what the Worker needs from ember/auth.config.ts without loading Better Auth (`authStaticSettings`,
 * computed by `buildWorker`); null for the function form of `defineAuth` (the Worker then loads the config to verify);
 * "eager" for an `@freecorps/ember-auth` that predates `emberAuthLazy`. With SSO (`auth.kind === "remote"`), "eager" is
 * an `@freecorps/ember-auth` that predates `/remote` (`remoteAuth` from `/worker`, Better Auth in the bundle).
 */
/**
 * `replicate`: organization replication (`ember.replicate` in auth.config.ts, PLAN §22 L3), as `authReplicaSpec`
 * computed it at build; null when off.
 */
/** `runtime`: the module the entry imports the runtime from (`runtimeHasWorkerEntry`). */
/** `lazy`: modules of actions only (`lazyActionModules`), imported on first use instead of statically. */
export function workerEntrySource(
  files: ProjectFiles,
  auth: AuthMode = null,
  authStatic: AuthStaticSettings | null | "eager" = null,
  replicate: unknown = null,
  runtime = RUNTIME_WORKER_ENTRY,
  lazy: ReadonlyMap<string, Record<string, LazyActionMeta>> = new Map(),
): string {
  const outboxOpts = (a: Extract<AuthMode, { kind: "local" }>) => `{ shard: ${JSON.stringify(a.syncShard)}${replicate ? `, replicate: ${JSON.stringify(replicate)}` : ""} }`;
  // Only with `users:sync` (the outbox's function): without it every user write would journal rows nobody reads.
  const sync = (a: Extract<AuthMode, { kind: "local" }>) => (a.profileSync === false ? "" : ", onUserChange: outbox.onUserChange");
  if (!files.schema) throw new Error("ember/schema.ts is missing (it must `export default defineSchema(...)`)");
  const lazyMods = files.modules.filter((m) => lazy.has(m.path));
  if (auth?.kind === "local" && !files.authConfig) throw new Error("internal: local auth without ember/auth.config.ts");
  const authLines: string[] =
    auth?.kind === "local" && authStatic === "eager"
      ? [
          // An @freecorps/ember-auth without the lazy entry (authHasLazy): Better Auth in every isolate, as before.
          `import { emberAuth } from "@freecorps/ember-auth/worker";`,
          `import authConfig from ${spec(files.authConfig!)};`,
          `const outbox = authOutbox({ shard: ${JSON.stringify(auth.syncShard)} });`,
          `const auth = emberAuth(authConfig, { project: ${JSON.stringify(auth.project)}${sync(auth)}${auth.turnstile ? `, turnstile: ${JSON.stringify(auth.turnstile)}` : ""} });`,
          "export const Auth = outbox.wrap(auth.Auth);",
        ]
      : auth?.kind === "local"
      ? [
          "// Better Auth and auth.config.ts are evaluated on first use (the Auth DO, /api/auth/*): the Shard isolates never",
          "// load them, and tokens are verified from the static settings below (docs/spikes/remote/latency-protocol.md §3).",
          `import { emberAuthLazy } from "@freecorps/ember-auth/lazy";`,
          auth.profileSync === false
            ? "// No internal.users.sync: no profile sync hook, so the Auth DO installs no user journal triggers."
            : "// Profile sync (PLAN §9): user changes go to an outbox in the Auth DO, delivered to internal.users.sync.",
          ...(replicate ? ["// Organization replication (PLAN §22 L3): Better Auth's org tables, read-only in each org shard (`auth:*`)."] : []),
          `const outbox = authOutbox(${outboxOpts(auth)});`,
          ...(auth.turnstile ? ["// Turnstile (ember.json auth.turnstile): checked in the Worker; secret TURNSTILE_SECRET_KEY."] : []),
          `const auth = emberAuthLazy(() => import(${spec(files.authConfig!)}), { project: ${JSON.stringify(auth.project)}${sync(auth)}${auth.turnstile ? `, turnstile: ${JSON.stringify(auth.turnstile)}` : ""}, static: ${JSON.stringify(authStatic)} });`,
          "export const Auth = outbox.wrap(auth.Auth);",
        ]
      : auth?.kind === "remote"
        ? [
            "// SSO (PLAN §21): JWTs of the identity project, verified against its JWKS; no Auth DO here.",
            ...(authStatic === "eager"
              ? [`import { remoteAuth } from "@freecorps/ember-auth/worker";`]
              : ["// `/remote`: remoteAuth without Better Auth (jose + the session lookup), so the bundle and cold start stay small.", `import { remoteAuth } from "@freecorps/ember-auth/remote";`]),
            ...(auth.sessionLookup
              ? [
                  `// sensitive functions: the session (sid) is checked at ${auth.sessionLookup.url} (ember.json auth.sessionLookup, PLAN §22 L14);`,
                  `// secret ${auth.sessionLookup.secretEnv ?? SESSION_LOOKUP_SECRET_DEFAULT} (\`ember env set\`).`,
                  `const auth = remoteAuth({ from: ${JSON.stringify(auth.from)}, sessionLookup: ${JSON.stringify(auth.sessionLookup)} });`,
                ]
              : [`const auth = remoteAuth({ from: ${JSON.stringify(auth.from)} });`]),
          ]
        : ["const auth = undefined;"];
  const lines = [
    "// Generated by `ember` (worker entry). Do not edit.",
    `import { createEmberWorker${auth?.kind === "local" ? ", authOutbox" : ""}${lazyMods.length ? ", lazyActions" : ""} } from ${JSON.stringify(runtime)};`,
    `export { ${DO_CLASSES.map((c) => c.className).join(", ")} } from ${JSON.stringify(runtime)};`,
    `import schema from ${spec(files.schema)};`,
    ...files.modules.flatMap((m, i) => (lazy.has(m.path) ? [] : [`import * as ${ident(m.path, i)} from ${spec(m.file)};`])),
    ...(lazyMods.length
      ? [
          "// Modules of actions only: imported on first use (a chunk of their own), so the isolates that only run queries",
          "// and mutations (every Shard DO) never evaluate them nor the SDKs they import. What the engine reads before that",
          "// (args, shard, dispatch...) was recorded at build.",
          ...files.modules.flatMap((m, i) => (lazy.has(m.path) ? [`const ${ident(m.path, i)} = lazyActions(() => import(${spec(m.file)}), ${JSON.stringify(lazy.get(m.path))});`] : [])),
        ]
      : []),
    files.crons ? `import crons from ${spec(files.crons)};` : "const crons = undefined;",
    files.appConfig ? `import app from ${spec(files.appConfig)};` : "const app = undefined;",
    files.http ? `import http from ${spec(files.http)};` : "const http = undefined;",
    files.triggers ? `import triggers from ${spec(files.triggers)};` : "const triggers = undefined;",
    "const functions = {",
    ...files.modules.map((m, i) => `  ${JSON.stringify(m.path)}: ${ident(m.path, i)},`),
    "};",
    ...authLines,
    "// crons: cronJobs() or CronDef[]; the runtime resolves function references and kinds.",
    "// app: ember.config.ts (components, PLAN §12), composed with schema/functions by the runtime; http: ember/http.ts;",
    "// triggers: ember/triggers.ts (defineTriggers), run by every shard's engine.",
    `export default createEmberWorker({ schema, functions, crons, auth, app, http, triggers${replicate && auth?.kind === "local" && authStatic !== "eager" ? ", replicas: outbox.replicas" : ""} });`,
    "",
  ];
  return lines.join("\n");
}

function evalEntrySource(files: ProjectFiles): string {
  return [
    files.schema ? `import * as schemaMod from ${spec(files.schema)};` : "const schemaMod = {};",
    files.crons ? `import * as cronsMod from ${spec(files.crons)};` : "const cronsMod = {};",
    files.authConfig ? `import * as authMod from ${spec(files.authConfig)};` : "const authMod = {};",
    files.appConfig ? `import * as appMod from ${spec(files.appConfig)};` : "const appMod = {};",
    files.http ? `import * as httpMod from ${spec(files.http)};` : "const httpMod = {};",
    files.triggers ? `import * as triggersMod from ${spec(files.triggers)};` : "const triggersMod = {};",
    files.importConfig ? `import * as importMod from ${spec(files.importConfig)};` : "const importMod = {};",
    ...files.modules.map((m, i) => `import * as ${ident(m.path, i)} from ${spec(m.file)};`),
    "export const schema = schemaMod.default;",
    "export const crons = cronsMod.default;",
    "export const authConfig = authMod.default;",
    "export const app = appMod.default;",
    "export const http = httpMod.default;",
    "export const triggers = triggersMod.default;",
    "export const importConfig = importMod.default;",
    `export const modules = { ${files.modules.map((m, i) => `${JSON.stringify(m.path)}: ${ident(m.path, i)}`).join(", ")} };`,
    "",
  ].join("\n");
}

export interface LoadedProject {
  files: ProjectFiles;
  schema: unknown;
  crons: unknown[];
  /** Default export of `ember/auth.config.ts` (undefined without one). */
  authConfig: unknown;
  /** Default export of `ember/ember.config.ts` (`defineApp()...`), undefined without one. */
  app: unknown;
  /** Default export of `ember/http.ts` (`httpRouter()`), undefined without one. */
  http: unknown;
  /** Default export of `ember/triggers.ts` (`defineTriggers()`), undefined without one. */
  triggers: unknown;
  /** Default export of `ember/import.config.ts` (`defineImport()`), undefined without one. */
  importConfig: unknown;
  modules: Record<string, Record<string, unknown>>;
}

type EvalExports = { schema: unknown; crons: unknown[]; authConfig: unknown; app: unknown; http: unknown; triggers: unknown; importConfig: unknown; modules: LoadedProject["modules"] };

/** esbuild's refusal of top-level await in a CommonJS bundle. */
const TOP_LEVEL_AWAIT = /Top-level await is currently not supported with the "cjs" output format/;
/** `import.meta.resolve` read in the CommonJS output (`import.meta` is defined as `__ember_import_meta`): a call, or
 * `resolve` taken off the object (`const { resolve } = import.meta`). An alias (`m = import.meta; m.resolve(x)`) is
 * not seen: it resolves as CommonJS does, which agrees except for `exports` entries with only an "import" condition. */
const USES_META_RESOLVE = /__ember_import_meta\s*(?:\.|\[\s*["'`])\s*resolve\b|\bresolve\b[^;]*?=\s*__ember_import_meta\b/;
let warnedEsmEval = false;

/**
 * Bundles the user's code for Node and evaluates it (validates the schema, yields function metadata). Resolves as Node
 * (no package.json `browser` maps), unlike the Worker bundle (WORKER_BUILD_OPTIONS): contracts.md "Bundle do Worker".
 *
 * Evaluated as a CommonJS function in this realm (`vm.runInThisContext`), not `import()`ed: Node never unloads an ES
 * module, so `ember dev` importing a new bundle on every save (each with its own copy of the bundled packages) grew the
 * heap with every rebuild. A function's closures are garbage once the `LoadedProject` is dropped. The bundle and its
 * resolution are the same as before (`import.meta` is an object with the bundle path's `url`/`dirname`/`filename` and a
 * `resolve`, whichever way it is read), and a computed `import()` the bundle keeps goes through Node's ES module loader.
 * Code with top-level await cannot be a CommonJS bundle: it is imported as an ES module as before, once warned.
 *
 * `virtual`: generated files served from memory instead of disk (absolute path → content), for `ember codegen --check`.
 */
export async function loadProjectCode(project: Project, files = discover(project.dir), virtual?: Map<string, string>): Promise<LoadedProject> {
  const outDir = join(project.stateDir, "build");
  mkdirSync(outDir, { recursive: true });
  const options = {
    stdin: { contents: evalEntrySource(files), resolveDir: project.dir, sourcefile: "ember-eval.js", loader: "js" as const },
    bundle: true,
    write: false as const,
    platform: "node" as const,
    target: "node22",
    external: ["cloudflare:*"],
    conditions: SOURCE_CONDITIONS,
    nodePaths: NODE_PATHS,
    logLevel: "silent" as const,
    ...(virtual ? { plugins: [virtualFiles(project.generatedDir, virtual)] } : {}),
  };
  let cjs: string | null = null;
  try {
    const result = await esbuild.build({
      ...options,
      format: "cjs",
      // The object itself, so `const { url } = import.meta` (or passing it along) sees the bundle's path too.
      define: { "import.meta": "__ember_import_meta" },
    });
    cjs = result.outputFiles[0]!.text;
    // `import.meta.resolve` resolves with the ES module conditions (`exports` → "import"), which CommonJS's
    // `require.resolve` cannot reproduce: code that reads it is evaluated as an ES module instead.
    if (USES_META_RESOLVE.test(cjs)) {
      cjs = null;
      if (!warnedEsmEval) {
        warnedEsmEval = true;
        console.warn("ember: the project's code uses import.meta.resolve, so it is evaluated as an ES module, which Node never unloads: `ember dev` memory grows with each rebuild");
      }
    }
  } catch (e) {
    if (!TOP_LEVEL_AWAIT.test(String((e as Error)?.message))) throw e;
    if (!warnedEsmEval) {
      warnedEsmEval = true;
      console.warn("ember: the project's code uses top-level await, so it is evaluated as an ES module, which Node never unloads: `ember dev` memory grows with each rebuild");
    }
  }
  const mod = cjs !== null ? evaluateCjs(cjs, join(outDir, "ember-eval.cjs")) : await importEsm(outDir, (await esbuild.build({ ...options, format: "esm" })).outputFiles[0]!.text);
  return { files, schema: mod.schema, crons: cronList(mod.crons), authConfig: mod.authConfig, app: mod.app, http: mod.http, triggers: mod.triggers, importConfig: mod.importConfig, modules: mod.modules };
}

/** What `import.meta` reads as in the CommonJS evaluation: the bundle file's, as an ES module there would have. */
interface EvalImportMeta {
  url: string;
  filename: string;
  dirname: string;
  resolve(specifier: string): string;
}

/**
 * Runs a CommonJS bundle as a function of this realm; `file` names it in stack traces and anchors `require`,
 * `import.meta` and dynamic `import()` (Node's default ES module loader, as for a module at `file`).
 */
function evaluateCjs(code: string, file: string): EvalExports {
  const req = createRequire(file);
  const url = pathToFileURL(file).href;
  const resolveFrom = (specifier: string): string => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(specifier)) return specifier; // node:, file:, data: …
    if (isBuiltin(specifier)) return `node:${specifier}`; // `fs` resolves to `node:fs`, as in an ES module
    if (specifier.startsWith(".") || specifier.startsWith("/")) return new URL(specifier, url).href;
    try {
      return pathToFileURL(req.resolve(specifier)).href;
    } catch {
      return specifier; // let the loader report it
    }
  };
  const meta: EvalImportMeta = { url, filename: file, dirname: dirname(file), resolve: resolveFrom };
  const fn = runInThisContext(`(function (exports, require, module, __filename, __dirname, __ember_import_meta) {${code}\n})`, {
    filename: file,
    // `import()` in the script goes through the main context's ES module loader (Node >= 21.7; a callback instead
    // would need --experimental-vm-modules). Node prints an ExperimentalWarning the first time a project uses it.
    importModuleDynamically: vmConstants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
  }) as (exports: object, require: NodeJS.Require, module: { exports: object }, filename: string, dirname: string, meta: EvalImportMeta) => void;
  const module = { exports: {} };
  fn(module.exports, req, module, file, dirname(file), meta);
  return module.exports as EvalExports;
}

/** The fallback for top-level await: an ES module file, imported (and kept by Node for the life of the process). */
async function importEsm(outDir: string, code: string): Promise<EvalExports> {
  const out = join(outDir, `eval-${createHash("sha256").update(code).digest("hex").slice(0, 12)}.mjs`);
  writeFileSync(out, code);
  try {
    return (await import(pathToFileURL(out).href)) as EvalExports;
  } finally {
    rmSync(out, { force: true });
  }
}

/** A build through the caller's context: reused while the options are the same, else replaced. */
async function incremental(c: WorkerBuildContext, options: esbuild.BuildOptions & { write: false; metafile: true }) {
  const key = JSON.stringify(options);
  if (!c.ctx || c.key !== key) {
    await c.dispose();
    c.ctx = await esbuild.context(options);
    c.key = key;
    c.stats.contexts++;
  }
  c.stats.rebuilds++;
  return c.ctx.rebuild();
}

/** Resolves `<generatedDir>/<name>(.js)` imports to in-memory content. */
function virtualFiles(generatedDir: string, files: Map<string, string>): esbuild.Plugin {
  return {
    name: "ember-virtual-generated",
    setup(b) {
      b.onResolve({ filter: /_generated[\\/][A-Za-z]+(\.js)?$/ }, (a) => {
        const p = resolve(a.resolveDir, a.path.endsWith(".js") ? a.path : `${a.path}.js`);
        return p.startsWith(generatedDir) && files.has(p) ? { path: p, namespace: "ember-virtual" } : undefined;
      });
      b.onLoad({ filter: /.*/, namespace: "ember-virtual" }, (a) => ({ contents: files.get(a.path)!, loader: "js", resolveDir: generatedDir }));
    },
  };
}

/** A module of the Worker besides the main one: a chunk of the split build, imported as `./<name>`. */
export interface WorkerModule {
  /** Module name, relative to the main module (`chunk-<hash>.js`): the upload's part name and Miniflare's module path. */
  name: string;
  code: string;
  /** Its source map (minified builds), uploaded as `<name>.map`. */
  map?: string;
}

export interface WorkerBuild {
  /** The main module (`index.js`). */
  code: string;
  /** The source map of a minified build (`index.js.map`), uploaded with the code. */
  map?: string;
  /**
   * The other ES modules (code splitting): what is reached only through `import()` (Better Auth and ember/auth.config.ts,
   * the cookie-cache decoder, scrypt, postal-mime…) and the code those chunks share, evaluated when first imported
   * instead of in every isolate's startup (compiled then too only with the `new_module_registry` compatibility flag;
   * the legacy registry compiles every module at startup). Absent or empty: one module.
   */
  modules?: WorkerModule[];
  entry: string;
  outFile: string;
  /** All modules (maps excluded). */
  bytes: number;
  /** Of every module: the main one's code alone for a single module, else each module's name and code in order. */
  sha256: string;
  /** How the bundled Worker authenticates (decides the `Auth` DO class and its secrets at deploy). */
  auth: AuthMode;
  /** esbuild's metafile of the build (sizes per module and input; `ember deploy` prints the main module's). */
  metafile?: esbuild.Metafile;
}

/** Names esbuild gives the chunks of a split Worker build (`chunkNames`), next to `index.js`. */
export const CHUNK_RE = /^chunk-[A-Z0-9]+\.js$/;

/**
 * Writes a split Worker build to `outDir` (exported for tests). Every output is `index.js`, a chunk, or the map of one
 * of them: anything else (a chunk name CHUNK_RE does not know, a plugin's file) fails before anything is written,
 * instead of an upload without a module `index.js` imports. The chunks of an earlier build (content-hash names) go
 * only after this build is on disk: `outDir` then holds exactly this build, and a failed write leaves the earlier
 * build's chunks in place.
 */
export function writeWorkerOutput(outDir: string, files: ReadonlyArray<{ path: string; contents: Uint8Array; text: string }>) {
  const isModule = (n: string) => n === "index.js" || CHUNK_RE.test(n);
  const text = new Map<string, string>();
  for (const f of files) {
    if (dirname(f.path) !== resolve(outDir)) throw new Error(`internal: esbuild wrote ${relative(outDir, f.path)} outside ${outDir}`);
    text.set(basename(f.path), f.text);
  }
  const unexpected = [...text.keys()].filter((n) => !isModule(n) && !(n.endsWith(".map") && isModule(n.slice(0, -4))));
  if (unexpected.length) throw new Error(`internal: unexpected Worker build output ${unexpected.join(", ")}`);
  const code = text.get("index.js");
  if (code === undefined) throw new Error("internal: the Worker build has no index.js");
  for (const f of files) writeFileSync(f.path, f.contents);
  for (const f of readdirSync(outDir)) {
    const js = f.endsWith(".map") ? f.slice(0, -4) : f;
    if (CHUNK_RE.test(js) && !text.has(f)) rmSync(join(outDir, f), { force: true });
  }
  return { text, code };
}

export { nodeBuiltinsPlugin, WORKER_BUILD_OPTIONS } from "./worker-bundle.ts";

/** Whether the app defines `users:sync` (ember/users.ts `export const sync`), the auth outbox's function (PLAN §9). */
export function hasProfileSync(modules: LoadedProject["modules"]): boolean {
  const f = modules["users"]?.["sync"];
  return f !== undefined && f !== null;
}

/**
 * Evaluates ember/auth.config.ts in Node (as codegen does) for the settings the Worker verifies with, and checks what
 * would otherwise only fail when the Worker first loads Better Auth.
 */
async function localAuthStatic(project: Project, files: ProjectFiles, auth: Extract<AuthMode, { kind: "local" }>, loaded?: LoadedProject): Promise<{ settings: AuthStaticSettings | null; replicate: unknown }> {
  const mod = await import("@freecorps/ember-auth");
  const { authStaticSettings, isEmberAuthConfig } = mod;
  const cfg = (loaded ?? (await loadProjectCode(project, files))).authConfig;
  if (!isEmberAuthConfig(cfg)) throw new Error("ember/auth.config.ts must `export default defineAuth({...})` from @freecorps/ember-auth");
  if (auth.turnstile && "plugins" in cfg && ((cfg as { plugins?: Array<{ id?: string }> }).plugins ?? []).some((p) => p.id === "captcha")) {
    throw new Error("auth: auth.turnstile (ember.json) and a captcha() plugin in auth.config.ts are mutually exclusive: keep one");
  }
  // An older @freecorps/ember-auth has no replication.
  const spec = "authReplicaSpec" in mod && typeof mod.authReplicaSpec === "function" ? mod.authReplicaSpec(cfg, { project: auth.project }) : null;
  return { settings: authStaticSettings(cfg), replicate: spec };
}

/**
 * An incremental Worker build for a session (`ember dev`): one `esbuild.context()` kept between `buildWorker` calls,
 * so a rebuild only re-reads what changed. Recreated when the build options change (an ember.json edit); `dispose()`
 * at the end of the session stops it.
 */
export interface WorkerBuildContext {
  /** The esbuild options the context was made for (JSON); another set disposes it and starts a new one. */
  key: string | undefined;
  ctx: esbuild.BuildContext<{ write: false; metafile: true }> | undefined;
  /** Contexts created and builds run with them (for tests and `ember dev`'s log). */
  readonly stats: { contexts: number; rebuilds: number };
  dispose(): Promise<void>;
}

export function createWorkerBuildContext(): WorkerBuildContext {
  const c: WorkerBuildContext = {
    key: undefined,
    ctx: undefined,
    stats: { contexts: 0, rebuilds: 0 },
    async dispose() {
      const ctx = c.ctx;
      c.ctx = undefined;
      c.key = undefined;
      await ctx?.dispose();
    },
  };
  return c;
}

/** Bundles the Worker for workerd into `<outDir>/index.js` and its chunks (`<outDir>/chunk-<hash>.js`). */
/**
 * `loaded`: the project as `codegen` just evaluated it (`CodegenResult.loaded`); with local auth the build reads
 * ember/auth.config.ts from it instead of bundling and evaluating the project again. `context`: an incremental build
 * kept by the caller (`createWorkerBuildContext`, `ember dev`); without it each call is a full build.
 */
export async function buildWorker(project: Project, opts: { outDir?: string; minify?: boolean; keepNames?: boolean; files?: ProjectFiles; env?: string; loaded?: LoadedProject; context?: WorkerBuildContext } = {}): Promise<WorkerBuild> {
  const files = opts.files ?? discover(project.dir);
  let auth = authModeOf(project, files, opts.env);
  const outDir = opts.outDir ?? join(project.stateDir, "build", "worker");
  mkdirSync(outDir, { recursive: true });
  const entry = join(outDir, "entry.mjs");
  const lazy = auth?.kind === "local" && authHasLazy(project.dir);
  // Local auth evaluates the project anyway (lazy entry); the eager one only when codegen already did.
  const loaded = auth?.kind === "local" ? (opts.loaded ?? (lazy ? await loadProjectCode(project, files) : undefined)) : opts.loaded;
  if (auth?.kind === "local" && loaded) auth = { ...auth, profileSync: hasProfileSync(loaded.modules) };
  const local = auth?.kind === "local" && lazy ? await localAuthStatic(project, files, auth, loaded) : null;
  // From `outDir`: esbuild resolves the entry's `@freecorps/ember-auth/remote` import from there, so both see one copy.
  const authStatic = auth?.kind === "remote" ? (authHasRemote(outDir) ? null : "eager") : auth?.kind !== "local" ? null : local ? local.settings : "eager";
  const runtime = runtimeHasWorkerEntry(project.dir) ? RUNTIME_WORKER_ENTRY : "@freecorps/ember-runtime";
  // Modules of actions only, as the evaluated project shows them (codegen's, or the one local auth just loaded): without
  // it (a bare `buildWorker`), every module stays static.
  const lazyMods = loaded && runtime === RUNTIME_WORKER_ENTRY && project.config.build?.lazyActions !== false && runtimeHasLazyActions(project.dir) ? lazyActionModules(loaded.modules) : new Map<string, Record<string, LazyActionMeta>>();
  writeFileSync(entry, workerEntrySource(files, auth, authStatic, local?.replicate ?? null, runtime, lazyMods));
  const outFile = join(outDir, "index.js");
  const minify = opts.minify ?? false;
  const options = {
    ...WORKER_BUILD_OPTIONS,
    entryPoints: { index: entry },
    outdir: outDir,
    // Multi-module output: every `import()` target is a chunk of its own, so a Shard isolate never evaluates Better
    // Auth nor the code behind other lazy imports (Workers evaluate a module when it is first imported). Compiling is
    // deferred too only under the new module registry (`new_module_registry`): the legacy one compiles every uploaded
    // module at startup, chunks included.
    splitting: true,
    chunkNames: "chunk-[hash]",
    write: false,
    metafile: true,
    minify,
    keepNames: opts.keepNames ?? project.config.build?.keepNames === true,
    // Deploy: libraries drop their development-only code (as wrangler's builds do), and no license comments. Better
    // Auth reads NODE_ENV through `globalThis.process.env` at runtime, which this does not change. `ember dev` keeps
    // the runtime lookup.
    ...(minify ? { define: { ...WORKER_BUILD_OPTIONS.define, "process.env.NODE_ENV": '"production"' }, legalComments: "none" as const } : {}),
    // Minified (deploy): each module's map goes up with it (`workerForm`), and each module names its map, so Cloudflare
    // remaps stack traces. Else they stay local.
    sourcemap: minify ? "linked" : "external",
    // Deploy maps carry no copy of the sources: Cloudflare remaps stack traces from names and mappings alone, and the
    // upload (and each isolate's copy of the map) stays a fraction of the size. `ember dev` keeps them for debuggers.
    ...(minify ? { sourcesContent: false } : {}),
    nodePaths: NODE_PATHS,
    absWorkingDir: project.root,
  } satisfies esbuild.BuildOptions;
  const result = opts.context ? await incremental(opts.context, options) : await esbuild.build(options);
  const { text, code } = writeWorkerOutput(outDir, result.outputFiles);
  const map = opts.minify ? text.get("index.js.map") : undefined;
  const modules: WorkerModule[] = [...text.keys()]
    .filter((n) => CHUNK_RE.test(n))
    .sort()
    .map((name) => {
      const m = opts.minify ? text.get(`${name}.map`) : undefined;
      return { name, code: text.get(name)!, ...(m !== undefined ? { map: m } : {}) };
    });
  const hash = createHash("sha256").update(code);
  for (const m of modules) hash.update(`\0${m.name}\0`).update(m.code);
  const bytes = Buffer.byteLength(code) + modules.reduce((n, m) => n + Buffer.byteLength(m.code), 0);
  return {
    code,
    ...(map !== undefined ? { map } : {}),
    ...(modules.length ? { modules } : {}),
    entry,
    outFile,
    bytes,
    sha256: hash.digest("hex"),
    auth,
    metafile: result.metafile,
  };
}
