// `ember dev`: codegen + bundle + Miniflare, one recursive watcher on ember/ with a debounce, and one on the project
// root for ember.json (config reloaded, full rebuild) and .dev.vars (vars reloaded, no rebuild). The Worker bundle is
// incremental: one esbuild context for the session, disposed on close.

import { mkdirSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildWorker, createWorkerBuildContext, type WorkerBuild } from "./build.ts";
import { codegen } from "./codegen/index.ts";
import { TypeOracle } from "./codegen/returnTypes.ts";
import { CONFIG_FILE, loadProject, SESSION_LOOKUP_SECRET_DEFAULT, type Project } from "./config.ts";
import { DEV_VARS_FILE, loadDevVars } from "./env.ts";
import { planRemote, remoteEnv, remoteFingerprint, startRemote, type RemoteSession } from "./remote.ts";
import type { SchemaManifestLike } from "./deploy/ai.ts";
import { miniflareOptions, startLocal, type LocalOptions } from "./local.ts";

export interface DevOptions {
  port?: number;
  persist?: boolean;
  log?: (line: string) => void;
  /**
   * Opt-in remote bindings (remote.ts): Workers AI, the env's Vectorize indexes, Browser
   * Rendering and Images are the real ones; shards, auth and files stay local. `env` default: "dev".
   */
  remote?: { env?: string };
}

const devFile = (project: Project) => join(project.stateDir, "dev.json");

export interface DevSession {
  url: URL;
  close(): Promise<void>;
  /** Settles once the reloads already triggered (by the watchers or `reload`) are done (tests). */
  idle(): Promise<void>;
  /** What a change of `kind` would do, without waiting for the watcher (tests; the watchers call it). */
  reload(kind: "code" | "config" | "vars"): Promise<void>;
  /** Builds of the session and the esbuild contexts they used (one, until ember.json changes the build options). */
  readonly stats: { builds: number; contexts: number };
}

export async function dev(project: Project, opts: DevOptions = {}): Promise<DevSession> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const outDir = join(project.stateDir, "build", "dev");
  // One incremental esbuild context for the session's Worker bundles (disposed in close()).
  const buildContext = createWorkerBuildContext();

  let schema: SchemaManifestLike = { tables: {} };
  let declaredEnv: Array<{ name: string; optional: boolean }> = [];
  // One TypeScript program for the whole session: each save re-checks incrementally.
  const oracle = new TypeOracle();
  /** A build of `p` and what the session takes from it once it is running (`adopt`). */
  type Built = { build: WorkerBuild; schema: SchemaManifestLike; env: typeof declaredEnv; components: LocalOptions["components"] };
  const rebuild = async (p: Project): Promise<Built> => {
    const t = Date.now();
    const gen = await codegen(p, { oracle });
    for (const w of gen.warnings) log(`warning: ${w}`);
    const build = await buildWorker(p, { outDir, loaded: gen.loaded, context: buildContext });
    log(`built in ${Date.now() - t} ms (${gen.manifest.functions.length} functions, ${(build.bytes / 1024).toFixed(0)} KiB)`);
    return {
      build,
      schema: gen.manifest.schema as unknown as SchemaManifestLike,
      env: gen.manifest.env ?? [],
      components: (gen.manifest.schema as { components?: LocalOptions["components"] }).components,
    };
  };
  const adopt = (b: Built) => {
    schema = b.schema;
    declaredEnv = b.env;
    components = b.components;
  };

  let components: LocalOptions["components"];
  // Local secrets and vars: `.dev.vars` (gitignored), re-read on every rebuild.
  const devVars = (p: Project = project) => {
    const d = loadDevVars(p);
    for (const w of d.warnings) log(`warning: ${w}`);
    return d;
  };
  let first: WorkerBuild;
  try {
    const b = await rebuild(project);
    adopt(b);
    first = b.build;
  } catch (e) {
    await buildContext.dispose();
    throw e;
  }
  const dv = devVars();
  if (dv.file) log(`${DEV_VARS_FILE}: ${Object.keys(dv.vars).length} value(s) (${Object.keys(dv.vars).join(", ") || "none"})`);
  const missingEnv = declaredEnv.filter((e) => !e.optional && dv.vars[e.name] === undefined).map((e) => e.name);
  if (missingEnv.length) log(`warning: ${DEV_VARS_FILE} lacks ${missingEnv.join(", ")} (declared in defineApp({ env })): actions reading them throw EnvMissing`);
  if (first.auth?.kind === "local" && first.auth.turnstile && !dv.vars.TURNSTILE_SECRET_KEY) {
    log(`warning: auth.turnstile is on but ${DEV_VARS_FILE} has no TURNSTILE_SECRET_KEY: sign-up/sign-in answer 500 (Turnstile's test secret 1x0000000000000000000000000000000AA always passes)`);
  }
  if (first.auth?.kind === "remote") {
    const lookup = first.auth.sessionLookup;
    log(`auth: remote (${first.auth.from}): users, sessions, revocation and key rotation live there, not in this project`);
    if (!lookup) log(`auth: sensitive functions are refused for its JWTs (no auth.sessionLookup to check their session)`);
    else if (!dv.vars[lookup.secretEnv ?? SESSION_LOOKUP_SECRET_DEFAULT]) log(`warning: auth.sessionLookup is on but ${DEV_VARS_FILE} has no ${lookup.secretEnv ?? SESSION_LOOKUP_SECRET_DEFAULT}: sensitive calls are refused`);
  }
  let remote: RemoteSession | null = null;
  if (opts.remote) {
    const env = remoteEnv(project, opts.remote.env);
    log(`ember dev --remote: binding real resources of "${env}" (billed; writes land in them)`);
    remote = await startRemote(project, env, schema, log);
  }
  // Binding names and the indexes behind them: a renamed index (same binding) needs a new session too.
  const remoteKeys = () => remoteFingerprint(planRemote(project, remote!.plan.env, schema));
  const boundKeys = remote ? remoteFingerprint(remote.plan) : "";
  let local: Awaited<ReturnType<typeof startLocal>>;
  try {
    local = await startLocal(project, first, { ...(opts.port !== undefined ? { port: opts.port } : { port: 8787 }), persist: opts.persist ?? true, vars: { EMBER_DEV_PERF: "1", ...dv.vars }, ...(remote ? { remote: remote.bindings } : {}), ...(components ? { components } : {}) });
  } catch (e) {
    await remote?.dispose();
    await buildContext.dispose();
    throw e;
  }
  const url = local.url;
  mkdirSync(project.stateDir, { recursive: true });
  writeFileSync(devFile(project), JSON.stringify({ url: url.href, pid: process.pid }) + "\n");
  // Miniflare exits the process on SIGINT itself, so the marker is removed synchronously on exit.
  const removeMarker = () => rmSync(devFile(project), { force: true });
  process.once("exit", removeMarker);
  log(`ember dev: ${url.href}  (state in ${join(project.stateDir, "state")})`);

  // `current` is the running build and `project` the config it was built from: `.dev.vars` reloads apply both.
  let current = first;
  const apply = async (p: Project, build: WorkerBuild, vars: Record<string, string>, comps: LocalOptions["components"]) => {
    await local.mf.setOptions(miniflareOptions(p, build, { port: Number(url.port), persist: opts.persist ?? true, vars: { EMBER_DEV_PERF: "1", ...vars }, ...(remote ? { remote: remote.bindings } : {}), ...(comps ? { components: comps } : {}) }));
    current = build;
  };
  /** An ember.json read but not built yet (its rebuild failed): code changes build it until one succeeds. */
  let pending: Project | null = null;
  /**
   * `code`: an ember/ file changed: codegen + bundle + reload. `config`: ember.json changed: the project is loaded again
   * (a broken file keeps the previous one) and rebuilt, since it shapes the bundle (auth, resources, build options);
   * the session takes the new config only once that build runs, so a failed one leaves the running pair as it was.
   * `vars`: .dev.vars changed: the Worker gets the new values, nothing is rebuilt.
   */
  const reloadNow = async (kind: "code" | "config" | "vars") => {
    try {
      if (kind === "vars") {
        const dv = devVars();
        await apply(project, current, dv.vars, components);
        log(`${DEV_VARS_FILE}: reloaded (${Object.keys(dv.vars).length} value(s))`);
        return;
      }
      if (kind === "config") {
        const next = loadProject(project.root);
        if (next.config.project !== project.config.project) log(`warning: ${CONFIG_FILE}: the project name changed (${project.config.project} → ${next.config.project}); restart \`ember dev\` to use the new local state`);
        if (JSON.stringify(next.config.resources ?? null) !== JSON.stringify(project.config.resources ?? null) && remote) log(`warning: ${CONFIG_FILE}: resources changed; restart \`ember dev --remote\` to bind them remotely`);
        pending = next;
        watchSources(next.dir); // the functions directory it names (`functionsDir`), even before it builds
      }
      const target = pending ?? project;
      const b = await rebuild(target);
      await apply(target, b.build, devVars(target).vars, b.components);
      adopt(b);
      project = target;
      pending = null;
      if (remote && remoteKeys() !== boundKeys) log("warning: the schema's external indexes changed (added, removed or now a different index): restart `ember dev --remote` to bind (and create) them remotely");
      log(kind === "config" ? `${CONFIG_FILE}: reloaded` : "reloaded");
    } catch (e) {
      log(`error: ${(e as Error).message}`);
    }
  };
  let running: Promise<void> = Promise.resolve();
  const reload = (kind: "code" | "config" | "vars") => (running = running.then(() => reloadNow(kind)));

  // Debounced per kind (a save often fires several events); a code change wins over a vars one in the same burst.
  const timers = new Map<"code" | "config" | "vars", NodeJS.Timeout>();
  const schedule = (kind: "code" | "config" | "vars") => {
    clearTimeout(timers.get(kind));
    timers.set(kind, setTimeout(() => {
      timers.delete(kind);
      void reload(kind);
    }, 150));
  };
  // ember/ (the config's `functionsDir`), recursive; changes in _generated are ours and ignored. Replaced when a
  // reloaded ember.json names another directory.
  let watcher: ReturnType<typeof watch> | null = null;
  let watched = "";
  function watchSources(dir: string) {
    if (dir === watched) return;
    const w = watch(dir, { recursive: true }, (_event, file) => {
      const f = String(file ?? "");
      if (f.split(/[\\/]/).some((part) => part === "_generated" || part.startsWith("."))) return;
      schedule("code");
    });
    watcher?.close();
    watcher = w;
    watched = dir;
  }
  watchSources(project.dir);
  // The project root, not recursive: only ember.json and .dev.vars (editors save through a rename: match by name).
  const rootWatcher = watch(project.root, (_event, file) => {
    const f = String(file ?? "");
    if (f === CONFIG_FILE) schedule("config");
    else if (f === DEV_VARS_FILE) schedule("vars");
  });

  return {
    url,
    stats: {
      get builds() {
        return buildContext.stats.rebuilds;
      },
      get contexts() {
        return buildContext.stats.contexts;
      },
    },
    reload,
    idle: async () => {
      await running;
    },
    async close() {
      for (const t of timers.values()) clearTimeout(t);
      watcher?.close();
      rootWatcher.close();
      await running;
      await local.mf.dispose();
      await remote?.dispose();
      await buildContext.dispose();
      process.off("exit", removeMarker);
      removeMarker();
    },
  };
}

export function devUrl(project: Project): string | null {
  try {
    return (JSON.parse(readFileSync(devFile(project), "utf8")) as { url: string }).url;
  } catch {
    return null;
  }
}
