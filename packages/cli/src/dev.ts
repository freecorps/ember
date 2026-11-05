// `ember dev`: codegen + bundle + Miniflare, one recursive watcher on ember/ with a debounce.

import { mkdirSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildWorker } from "./build.ts";
import { codegen } from "./codegen/index.ts";
import type { Project } from "./config.ts";
import { miniflareOptions, startLocal, type LocalOptions } from "./local.ts";

export interface DevOptions {
  port?: number;
  persist?: boolean;
  log?: (line: string) => void;
}

const devFile = (project: Project) => join(project.stateDir, "dev.json");

export async function dev(project: Project, opts: DevOptions = {}): Promise<{ url: URL; close(): Promise<void> }> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const outDir = join(project.stateDir, "build", "dev");

  const rebuild = async () => {
    const t = Date.now();
    const gen = await codegen(project);
    for (const w of gen.warnings) log(`warning: ${w}`);
    const build = await buildWorker(project, { outDir });
    log(`built in ${Date.now() - t} ms (${gen.manifest.functions.length} functions, ${(build.bytes / 1024).toFixed(0)} KiB)`);
    components = (gen.manifest.schema as { components?: LocalOptions["components"] }).components;
    return build;
  };

  let components: LocalOptions["components"];
  const first = await rebuild();
  const local = await startLocal(project, first, { ...(opts.port !== undefined ? { port: opts.port } : { port: 8787 }), persist: opts.persist ?? true, ...(components ? { components } : {}) });
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
          await local.mf.setOptions(miniflareOptions(project, build, { port: Number(url.port), persist: opts.persist ?? true, ...(components ? { components } : {}) }));
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
