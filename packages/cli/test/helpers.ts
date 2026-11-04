import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProject, type Project } from "../src/config.ts";
import { init } from "../src/init.ts";

/** Scratch projects live under packages/cli/.tmp so `@ember/*` resolve through the CLI's node_modules. */
export const TMP = fileURLToPath(new URL("../.tmp/", import.meta.url));

export function sampleProject(name: string): Project {
  const dir = join(TMP, `${name}-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  init({ dir, project: "chat" });
  return loadProject(dir);
}

export function cleanup(project: Project) {
  rmSync(project.root, { recursive: true, force: true });
}
