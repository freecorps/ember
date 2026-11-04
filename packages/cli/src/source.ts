// Where the CLI runs from: its TypeScript sources inside the monorepo, or the published dist/ build.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Package root: `src/..` when running the TypeScript sources, `dist/..` from the published build. */
export const CLI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** True when running the TypeScript sources (inside the monorepo), false from the published `dist/` build. */
export const FROM_SOURCE = import.meta.url.endsWith(".ts");
/**
 * Export condition that maps the @freecorps/ember-* workspace packages to their TS sources (package.json "exports").
 * Only used from source, so `ember dev`/`codegen`/`deploy` in the monorepo use the current sources without a build.
 */
export const SOURCE_CONDITION = "@freecorps/ember-source";
/** Extra resolve conditions for esbuild and the TypeScript compiler API. */
export const SOURCE_CONDITIONS: string[] = FROM_SOURCE ? [SOURCE_CONDITION] : [];
