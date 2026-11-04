// Builds every publishable package into packages/*/dist (ESM JS + .d.ts). Run with `bun run build`.
//
// - Libraries: plain `tsc -p tsconfig.build.json` (rewriteRelativeImportExtensions turns the sources' `./x.ts`
//   imports into `./x.js`). The build config drops the "@freecorps/ember-source" condition, so a package's
//   workspace dependencies resolve to their dist/ types: packages build in dependency order.
// - CLI: declarations from tsc; the JS is one esbuild bundle (dist/index.js) so the private apps/dashboard modules it
//   imports are inlined, with every npm dependency left external. The dashboard SPA and Worker are prebuilt into
//   dist/dashboard/ for `ember dashboard deploy` (the published CLI does not depend on apps/dashboard).
//
// In-repo development does not need this: tests, typecheck and `ember dev` run from the TypeScript sources.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as esbuild from "esbuild";

export const ROOT = resolve(import.meta.dir, "..");
const TSC = join(ROOT, "node_modules", ".bin", "tsc");

interface Pkg {
  dir: string;
  name: string;
  json: Record<string, any>;
}

/** Publishable workspace packages (packages/*, not private), dependencies first. */
export function publishablePackages(): Pkg[] {
  const all: Pkg[] = [];
  for (const d of new Bun.Glob("packages/*/package.json").scanSync({ cwd: ROOT })) {
    const json = JSON.parse(readFileSync(join(ROOT, d), "utf8"));
    if (!json.private) all.push({ dir: join(ROOT, d, ".."), name: json.name, json });
  }
  const byName = new Map(all.map((p) => [p.name, p]));
  const out: Pkg[] = [];
  const seen = new Set<string>();
  const visit = (p: Pkg, path: string[]) => {
    if (seen.has(p.name)) return;
    if (path.includes(p.name)) throw new Error(`dependency cycle: ${[...path, p.name].join(" → ")}`);
    for (const dep of Object.keys({ ...p.json.dependencies, ...p.json.peerDependencies })) {
      const d = byName.get(dep);
      if (d) visit(d, [...path, p.name]);
    }
    seen.add(p.name);
    out.push(p);
  };
  for (const p of all.sort((a, b) => a.name.localeCompare(b.name))) visit(p, []);
  return out;
}

function tsc(dir: string, extra: string[] = []) {
  const r = spawnSync(TSC, ["-p", join(dir, "tsconfig.build.json"), ...extra], { stdio: "inherit", cwd: dir });
  if (r.status !== 0) throw new Error(`tsc failed in ${dir}`);
}

async function buildCli(p: Pkg) {
  tsc(p.dir, ["--emitDeclarationOnly"]);
  const external = Object.keys(p.json.dependencies ?? {}).flatMap((d) => [d, `${d}/*`]);
  await esbuild.build({
    entryPoints: [join(p.dir, "src/index.ts")],
    outfile: join(p.dir, "dist/index.js"),
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    external,
    logLevel: "warning",
  });

  // Prebuilt dashboard: SPA (React from apps/dashboard) and the Worker module exporting createDashboard.
  const { dashboardFromSource, dashboardDir } = await import("../packages/cli/src/dashboard.ts");
  const out = join(p.dir, "dist/dashboard");
  mkdirSync(out, { recursive: true });
  const src = await dashboardFromSource();
  writeFileSync(join(out, "app.js"), src.js);
  writeFileSync(join(out, "app.css"), src.css);
  await esbuild.build({
    entryPoints: [join(dashboardDir(), "src/worker.ts")],
    outfile: join(out, "worker.js"),
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2023",
    logLevel: "warning",
  });
}

export async function build(only?: string[]) {
  for (const p of publishablePackages()) {
    if (only?.length && !only.some((o) => p.name === o || p.name.endsWith(`-${o}`))) continue;
    const t = performance.now();
    rmSync(join(p.dir, "dist"), { recursive: true, force: true });
    if (p.name === "@freecorps/ember-cli") await buildCli(p);
    else tsc(p.dir);
    if (!existsSync(join(p.dir, "dist/index.js"))) throw new Error(`${p.name}: dist/index.js missing after build`);
    console.log(`built ${p.name} (${Math.round(performance.now() - t)} ms)`);
  }
}

if (import.meta.main) await build(process.argv.slice(2));
