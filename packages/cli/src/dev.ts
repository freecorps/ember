// `ember dev`: codegen + bundle + Miniflare, one recursive watcher on ember/ with a debounce.

import { mkdirSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildWorker } from "./build.ts";
import { codegen } from "./codegen/index.ts";
import type { Project } from "./config.ts";
import { DEV_VARS_FILE, loadDevVars } from "./env.ts";
import { planRemote, remoteEnv, startRemote, type RemoteSession } from "./remote.ts";
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

export async function dev(project: Project, opts: DevOptions = {}): Promise<{ url: URL; close(): Promise<void> }> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const outDir = join(project.stateDir, "build", "dev");

  let schema: SchemaManifestLike = { tables: {} };
  const rebuild = async () => {
    const t = Date.now();
    const gen = await codegen(project);
    for (const w of gen.warnings) log(`warning: ${w}`);
    const build = await buildWorker(project, { outDir });
    schema = gen.manifest.schema as unknown as SchemaManifestLike;
    log(`built in ${Date.now() - t} ms (${gen.manifest.functions.length} functions, ${(build.bytes / 1024).toFixed(0)} KiB)`);
    components = (gen.manifest.schema as { components?: LocalOptions["components"] }).components;
    return build;
  };

  let components: LocalOptions["components"];
  // Local secrets and vars: `.dev.vars` (gitignored), re-read on every rebuild.
  const devVars = () => {
    const d = loadDevVars(project);
    for (const w of d.warnings) log(`warning: ${w}`);
    return d;
  };
  const first = await rebuild();
  const dv = devVars();
  if (dv.file) log(`${DEV_VARS_FILE}: ${Object.keys(dv.vars).length} value(s) (${Object.keys(dv.vars).join(", ") || "none"})`);
  if (first.auth?.kind === "local" && first.auth.turnstile && !dv.vars.TURNSTILE_SECRET_KEY) {
    log(`warning: auth.turnstile is on but ${DEV_VARS_FILE} has no TURNSTILE_SECRET_KEY: sign-up/sign-in answer 500 (Turnstile's test secret 1x0000000000000000000000000000000AA always passes)`);
  }
  let remote: RemoteSession | null = null;
  if (opts.remote) {
    const env = remoteEnv(project, opts.remote.env);
    log(`ember dev --remote: binding real resources of "${env}" (billed; writes land in them)`);
    remote = await startRemote(project, env, schema, log);
  }
  const remoteKeys = () => JSON.stringify(Object.keys(planRemote(project, remote!.plan.env, schema).bindings).sort());
  const boundKeys = remote ? remoteKeys() : "";
  let local: Awaited<ReturnType<typeof startLocal>>;
  try {
    local = await startLocal(project, first, { ...(opts.port !== undefined ? { port: opts.port } : { port: 8787 }), persist: opts.persist ?? true, vars: dv.vars, ...(remote ? { remote: remote.bindings } : {}), ...(components ? { components } : {}) });
  } catch (e) {
    await remote?.dispose();
    throw e;
  }
  const url = local.url;
  mkdirSync(project.stateDir, { recursive: true });
  writeFileSync(devFile(project), JSON.stringify({ url: url.href, pid: process.pid }) + "\n");
  // Miniflare exits the process on SIGINT itself, so the marker is removed synchronously on exit.
  const removeMarker = () => rmSync(devFile(project), { force: true });
  process.once("exit", removeMarker);
  log(`ember dev: ${url.href}  (state in ${join(project.stateDir, "state")})`);

  // One watcher, debounced; changes in _generated are ours and ignored.
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> = Promise.resolve();
  const watcher = watch(project.dir, { recursive: true }, (_event, file) => {
    const f = String(file ?? "");
    if (f.split(/[\\/]/).some((part) => part === "_generated" || part.startsWith("."))) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      running = running.then(async () => {
        try {
          const build = await rebuild();
          await local.mf.setOptions(miniflareOptions(project, build, { port: Number(url.port), persist: opts.persist ?? true, vars: devVars().vars, ...(remote ? { remote: remote.bindings } : {}), ...(components ? { components } : {}) }));
          if (remote && remoteKeys() !== boundKeys) log("warning: the schema's external indexes changed: restart `ember dev --remote` to bind (and create) them remotely");
          log("reloaded");
        } catch (e) {
          log(`error: ${(e as Error).message}`);
        }
      });
    }, 150);
  });

  return {
    url,
    async close() {
      clearTimeout(timer);
      watcher.close();
      await running;
      await local.mf.dispose();
      await remote?.dispose();
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
