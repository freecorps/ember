#!/usr/bin/env node
// Published package: runs the compiled dist/ on plain Node (>= 22).
// Monorepo checkout (src/ present, not shipped to npm): runs the TypeScript sources. Node then needs
// --experimental-transform-types (the sources use parameter properties, which strip-only mode rejects) and the
// "@freecorps/ember-source" export condition (workspace packages resolve to their sources, no build needed), so the
// launcher re-executes itself with both when they are missing (e.g. through `npx ember`). Bun only needs the condition.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SOURCE = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const CONDITION = "--conditions=@freecorps/ember-source";
const isBun = typeof globalThis.Bun !== "undefined";
const fromSource = existsSync(SOURCE);

if (fromSource) {
  const flags = isBun ? [CONDITION] : ["--experimental-transform-types", "--no-warnings=ExperimentalWarning", CONDITION];
  const missing = flags.filter((f) => !process.execArgv.includes(f));
  if (missing.some((f) => !f.startsWith("--no-warnings"))) {
    const r = spawnSync(process.execPath, [...process.execArgv, ...missing, fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
      stdio: "inherit",
    });
    process.exit(r.status ?? (r.signal ? 1 : 0));
  }
}

const { main } = fromSource ? await import("../src/main.ts") : await import("../dist/index.js");
main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`ember: ${err?.message ?? err}`);
    if (process.env.EMBER_DEBUG) console.error(err);
    process.exit(1);
  },
);
