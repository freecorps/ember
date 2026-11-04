#!/usr/bin/env node
// Runs the TypeScript sources directly. A build step comes before publishing; until then Node needs
// --experimental-transform-types (the sources use parameter properties, which strip-only mode rejects), so the
// launcher re-executes itself with it when Node was started without it (e.g. through `npx ember`).
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const FLAG = "--experimental-transform-types";
const isBun = typeof globalThis.Bun !== "undefined";

if (!isBun && !process.execArgv.includes(FLAG)) {
  const r = spawnSync(process.execPath, [...process.execArgv, FLAG, "--no-warnings=ExperimentalWarning", fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: "inherit",
  });
  process.exit(r.status ?? (r.signal ? 1 : 0));
}

const { main } = await import("../src/main.ts");
main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`ember: ${err?.message ?? err}`);
    if (process.env.EMBER_DEBUG) console.error(err);
    process.exit(1);
  },
);
