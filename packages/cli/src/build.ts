// esbuild: (1) a Node bundle of the user's schema/functions/crons, imported by codegen to read the manifest, and
// (2) the Worker bundle for workerd: a generated entry that calls createEmberWorker and exports the DO classes.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { cronList } from "@freecorps/ember-server";
import * as esbuild from "esbuild";
import { authSettings, type Project } from "./config.ts";
import { discover, ident, type ProjectFiles } from "./modules.ts";
import { CLI_ROOT, SOURCE_CONDITIONS } from "./source.ts";

/** Fallback resolution: the CLI's own dependencies (@freecorps/ember-runtime, @freecorps/ember-server) when the project lacks them. */
const NODE_PATHS = [join(CLI_ROOT, "node_modules"), resolve(CLI_ROOT, "..", "..")];

/**
 * Version of the `@freecorps/ember-runtime` the Worker bundle gets: the first `node_modules` copy from the project up
 * (as esbuild resolves it), then from the CLI up (its own dependency). Deployed as the EMBER_RUNTIME_VERSION var.
 * Null when none is found.
 */
export function runtimeVersion(projectDir: string): string | null {
  for (const start of [projectDir, CLI_ROOT]) {
    for (let d = resolve(start); ; d = dirname(d)) {
      const pkg = join(d, "node_modules", "@freecorps", "ember-runtime", "package.json");
      if (existsSync(pkg)) {
        try {
          const j = JSON.parse(readFileSync(pkg, "utf8")) as { name?: string; version?: string };
          if (j.name === "@freecorps/ember-runtime" && typeof j.version === "string") return j.version;
        } catch {
          // unreadable: keep looking
        }
      }
      if (dirname(d) === d) break;
    }
  }
  return null;
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
  | { kind: "local"; project: string; syncShard: string; turnstile?: true | import("./config.ts").TurnstileConfig }
  | { kind: "remote"; from: string }
  | null;

export function authModeOf(project: Project, files: Pick<ProjectFiles, "authConfig">, env?: string): AuthMode {
  const s = authSettings(project, env);
  if (s.from) {
    if (files.authConfig) throw new Error(`ember.json auth.from (SSO) and ember/auth.config.ts are mutually exclusive: remove one`);
    if (s.turnstile) throw new Error(`ember.json auth.turnstile protects this project's own sign-up/sign-in: with auth.from (SSO) set it on the identity project`);
    // A project name is resolved to its URL by `ember deploy` (registry, sso.ts); other commands need the URL.
    if (!/^https?:\/\//.test(s.from)) throw new Error(`auth.from "${s.from}" is a project name: \`ember deploy\` resolves it through the account registry; for ${env ?? "this command"} set environments.${env ?? "<env>"}.auth.from to the identity project's URL`);
    return { kind: "remote", from: s.from };
  }
  if (s.turnstile && !files.authConfig) throw new Error(`ember.json auth.turnstile needs ember/auth.config.ts (the project's own auth)`);
  if (files.authConfig) return { kind: "local", project: project.config.project, syncShard: s.syncShard ?? "global:main", ...(s.turnstile ? { turnstile: s.turnstile } : {}) };
  return null;
}

const spec = (file: string) => JSON.stringify(file.split("\\").join("/"));

/** Worker entry module source. Static imports only: a Worker cannot list files at runtime. */
export function workerEntrySource(files: ProjectFiles, auth: AuthMode = null): string {
  if (!files.schema) throw new Error("ember/schema.ts is missing (it must `export default defineSchema(...)`)");
  if (auth?.kind === "local" && !files.authConfig) throw new Error("internal: local auth without ember/auth.config.ts");
  const authLines: string[] =
    auth?.kind === "local"
      ? [
          `import { emberAuth } from "@freecorps/ember-auth/worker";`,
          `import authConfig from ${spec(files.authConfig!)};`,
          "// Profile sync (PLAN §9): user changes go to an outbox in the Auth DO, delivered to internal.users.sync.",
          `const outbox = authOutbox({ shard: ${JSON.stringify(auth.syncShard)} });`,
          ...(auth.turnstile ? ["// Turnstile (ember.json auth.turnstile): checked in the Worker; secret TURNSTILE_SECRET_KEY."] : []),
          `const auth = emberAuth(authConfig, { project: ${JSON.stringify(auth.project)}, onUserChange: outbox.onUserChange${auth.turnstile ? `, turnstile: ${JSON.stringify(auth.turnstile)}` : ""} });`,
          "export const Auth = outbox.wrap(auth.Auth);",
        ]
      : auth?.kind === "remote"
        ? [
            "// SSO (PLAN §21): JWTs of the identity project, verified against its JWKS; no Auth DO here.",
            `import { remoteAuth } from "@freecorps/ember-auth/worker";`,
            `const auth = remoteAuth({ from: ${JSON.stringify(auth.from)} });`,
          ]
        : ["const auth = undefined;"];
  const lines = [
    "// Generated by `ember` (worker entry). Do not edit.",
    `import { createEmberWorker${auth?.kind === "local" ? ", authOutbox" : ""} } from "@freecorps/ember-runtime";`,
    `export { ${DO_CLASSES.map((c) => c.className).join(", ")} } from "@freecorps/ember-runtime";`,
    `import schema from ${spec(files.schema)};`,
    ...files.modules.map((m, i) => `import * as ${ident(m.path, i)} from ${spec(m.file)};`),
    files.crons ? `import crons from ${spec(files.crons)};` : "const crons = undefined;",
    files.appConfig ? `import app from ${spec(files.appConfig)};` : "const app = undefined;",
    files.http ? `import http from ${spec(files.http)};` : "const http = undefined;",
    "const functions = {",
    ...files.modules.map((m, i) => `  ${JSON.stringify(m.path)}: ${ident(m.path, i)},`),
    "};",
    ...authLines,
    "// crons: cronJobs() or CronDef[]; the runtime resolves function references and kinds.",
    "// app: ember.config.ts (components, PLAN §12), composed with schema/functions by the runtime; http: ember/http.ts.",
    "export default createEmberWorker({ schema, functions, crons, auth, app, http });",
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
    ...files.modules.map((m, i) => `import * as ${ident(m.path, i)} from ${spec(m.file)};`),
    "export const schema = schemaMod.default;",
    "export const crons = cronsMod.default;",
    "export const authConfig = authMod.default;",
    "export const app = appMod.default;",
    "export const http = httpMod.default;",
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
  modules: Record<string, Record<string, unknown>>;
}

/** Bundles the user's code for Node and imports it (validates the schema, yields function metadata). */
export async function loadProjectCode(project: Project, files = discover(project.dir)): Promise<LoadedProject> {
  const outDir = join(project.stateDir, "build");
  mkdirSync(outDir, { recursive: true });
  const result = await esbuild.build({
    stdin: { contents: evalEntrySource(files), resolveDir: project.dir, sourcefile: "ember-eval.js", loader: "js" },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    target: "node22",
    external: ["cloudflare:*"],
    conditions: SOURCE_CONDITIONS,
    nodePaths: NODE_PATHS,
    logLevel: "silent",
  });
  const code = result.outputFiles[0]!.text;
  const out = join(outDir, `eval-${createHash("sha256").update(code).digest("hex").slice(0, 12)}.mjs`);
  writeFileSync(out, code);
  try {
    const mod = (await import(pathToFileURL(out).href)) as { schema: unknown; crons: unknown[]; authConfig: unknown; app: unknown; http: unknown; modules: LoadedProject["modules"] };
    return { files, schema: mod.schema, crons: cronList(mod.crons), authConfig: mod.authConfig, app: mod.app, http: mod.http, modules: mod.modules };
  } finally {
    rmSync(out, { force: true });
  }
}

export interface WorkerBuild {
  /** Bundled ESM (`index.js`). */
  code: string;
  entry: string;
  outFile: string;
  bytes: number;
  sha256: string;
  /** How the bundled Worker authenticates (decides the `Auth` DO class and its secrets at deploy). */
  auth: AuthMode;
}

export const WORKER_BUILD_OPTIONS = {
  bundle: true,
  format: "esm",
  platform: "neutral",
  target: "es2023",
  conditions: [...SOURCE_CONDITIONS, "workerd", "worker", "browser", "import", "module"],
  mainFields: ["browser", "module", "main"],
  external: ["cloudflare:*", "node:*"],
  logLevel: "silent",
} satisfies esbuild.BuildOptions;

/** Bundles the Worker for workerd into `<outDir>/index.js`. */
export async function buildWorker(project: Project, opts: { outDir?: string; minify?: boolean; keepNames?: boolean; files?: ProjectFiles; env?: string } = {}): Promise<WorkerBuild> {
  const files = opts.files ?? discover(project.dir);
  const auth = authModeOf(project, files, opts.env);
  const outDir = opts.outDir ?? join(project.stateDir, "build", "worker");
  mkdirSync(outDir, { recursive: true });
  const entry = join(outDir, "entry.mjs");
  writeFileSync(entry, workerEntrySource(files, auth));
  const outFile = join(outDir, "index.js");
  await esbuild.build({
    ...WORKER_BUILD_OPTIONS,
    entryPoints: [entry],
    outfile: outFile,
    minify: opts.minify ?? false,
    keepNames: opts.keepNames ?? project.config.build?.keepNames === true,
    sourcemap: "external",
    nodePaths: NODE_PATHS,
    absWorkingDir: project.root,
  });
  const code = readFileSync(outFile, "utf8");
  return { code, entry, outFile, bytes: Buffer.byteLength(code), sha256: createHash("sha256").update(code).digest("hex"), auth };
}
