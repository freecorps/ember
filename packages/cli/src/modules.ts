// Discovers the files of an `ember/` directory.

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** Files with a special meaning; everything else (`*.ts`) is a function module. */
export const RESERVED = new Set(["schema", "crons", "auth.config", "http"]);
const MODULE_PATH = /^[A-Za-z0-9_\-]+(\/[A-Za-z0-9_\-]+)*$/;

export interface ProjectFiles {
  schema: string | null;
  crons: string | null;
  /** Module path (`dir/mod`) → absolute file. Sorted. */
  modules: Array<{ path: string; file: string }>;
}

export function findFile(dir: string, base: string): string | null {
  for (const ext of [".ts", ".tsx", ".js", ".mjs"]) {
    const p = join(dir, base + ext);
    if (existsSync(p)) return p;
  }
  return null;
}

export function discover(dir: string): ProjectFiles {
  if (!existsSync(dir)) throw new Error(`Functions directory ${dir} does not exist`);
  const modules: ProjectFiles["modules"] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      if (name.startsWith(".") || name.startsWith("_") || name === "node_modules") continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) {
        walk(p);
        continue;
      }
      const m = /^(.*)\.(ts|tsx|js|mjs)$/.exec(name);
      if (!m || name.endsWith(".d.ts") || /\.(test|spec)\.[a-z]+$/.test(name)) continue;
      const path = relative(dir, join(d, m[1]!)).split(sep).join("/");
      if (RESERVED.has(path)) continue;
      if (!MODULE_PATH.test(path)) throw new Error(`Bad module path "${path}": use letters, digits, "_" and "-"`);
      modules.push({ path, file: p });
    }
  };
  walk(dir);
  modules.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { schema: findFile(dir, "schema"), crons: findFile(dir, "crons"), modules };
}

/** A JS identifier for a module path. */
export const ident = (path: string, i: number) => `m${i}_${path.replace(/[^A-Za-z0-9_]/g, "_")}`;
