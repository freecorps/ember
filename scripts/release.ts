// Release staging for npm. Packages are published from staged copies in .release/<dir>/, never from packages/*:
//
//   bun scripts/release.ts stage                  build, then write .release/* (publishable package.json, files, LICENSE, README)
//   bun scripts/release.ts pack [dest]            stage + `npm pack` every package into dest (default .release/tarballs)
//   bun scripts/release.ts publish [--dry-run] [--provenance] [--tag next]
//                                                 stage + `npm publish` each package in dependency order; versions
//                                                 already on the registry are skipped (re-runnable after a failure)
//
// Staged package.json = the workspace one with: `workspace:*|^|~` dependency ranges pinned to the version of that
// workspace package (`*` → exact, `^`/`~` kept as prefix), the "@freecorps/ember-source" export condition removed
// (it points to src/, which is not shipped), and scripts/devDependencies dropped. All packages share one version.
// We publish with npm (not `bun publish`) because the workflow needs `npm publish --provenance` (Sigstore via GitHub
// OIDC) and npm trusted publishing; npm itself would publish `workspace:*` verbatim, hence the staging.

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { build, publishablePackages, ROOT } from "./build.ts";

export const RELEASE_DIR = join(ROOT, ".release");
const SOURCE_CONDITION = "@freecorps/ember-source";
const DEP_FIELDS = ["dependencies", "peerDependencies", "optionalDependencies"] as const;

export interface Staged {
  name: string;
  version: string;
  dir: string;
}

function stripSourceCondition(exp: unknown): unknown {
  if (!exp || typeof exp !== "object") return exp;
  return Object.fromEntries(
    Object.entries(exp as Record<string, unknown>)
      .filter(([k]) => k !== SOURCE_CONDITION)
      .map(([k, v]) => [k, stripSourceCondition(v)]),
  );
}

function readme(json: Record<string, any>): string {
  const dir = json.repository?.directory as string;
  return `# ${json.name}

${json.description}

Part of [Ember](https://github.com/freecorps/ember), a Convex-style backend on Cloudflare Workers and Durable
Objects. Source: [\`${dir}\`](https://github.com/freecorps/ember/tree/main/${dir}).

\`\`\`sh
npm install ${json.name}
\`\`\`

License: MIT.
`;
}

/** Writes the publishable copies into .release/ (run `bun run build` first, or pass build: true). */
export async function stage(opts: { build?: boolean } = {}): Promise<Staged[]> {
  if (opts.build) await build();
  const pkgs = publishablePackages();
  const versions = new Map(pkgs.map((p) => [p.name, p.json.version as string]));
  const distinct = new Set(versions.values());
  if (distinct.size !== 1) throw new Error(`packages must share one version, found: ${[...distinct].join(", ")}`);

  rmSync(RELEASE_DIR, { recursive: true, force: true });
  const staged: Staged[] = [];
  for (const p of pkgs) {
    const out = join(RELEASE_DIR, basename(p.dir));
    mkdirSync(out, { recursive: true });
    const json = structuredClone(p.json);
    delete json.scripts;
    delete json.devDependencies;
    json.exports = stripSourceCondition(json.exports);
    for (const field of DEP_FIELDS) {
      for (const [dep, range] of Object.entries((json[field] ?? {}) as Record<string, string>)) {
        if (!range.startsWith("workspace:")) continue;
        const v = versions.get(dep);
        if (!v) throw new Error(`${p.name}: ${field}.${dep} is ${range} but ${dep} is not a publishable package`);
        const spec = range.slice("workspace:".length);
        json[field][dep] = spec === "*" || spec === "" ? v : spec === "^" || spec === "~" ? `${spec}${v}` : spec;
      }
    }
    const text = JSON.stringify(json, null, 2) + "\n";
    if (text.includes("workspace:")) throw new Error(`${p.name}: workspace: protocol left in the staged package.json`);
    if (text.includes(SOURCE_CONDITION)) throw new Error(`${p.name}: source condition left in the staged package.json`);
    for (const f of json.files as string[]) {
      const src = join(p.dir, f);
      if (!existsSync(src)) throw new Error(`${p.name}: "${f}" listed in files is missing (run \`bun run build\`)`);
      cpSync(src, join(out, f), { recursive: true });
    }
    writeFileSync(join(out, "package.json"), text);
    cpSync(join(ROOT, "LICENSE"), join(out, "LICENSE"));
    writeFileSync(join(out, "README.md"), existsSync(join(p.dir, "README.md")) ? readFileSync(join(p.dir, "README.md"), "utf8") : readme(json));
    staged.push({ name: p.name, version: json.version, dir: out });
  }
  return staged;
}

function npm(args: string[], cwd: string, capture = false): string {
  const r = spawnSync("npm", args, { cwd, stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit", encoding: "utf8" });
  if (r.status !== 0) throw new Error(`npm ${args.join(" ")} failed in ${cwd}`);
  return r.stdout ?? "";
}

export interface PackInfo {
  filename: string;
  size: number;
  unpackedSize: number;
  entryCount: number;
  files: Array<{ path: string; size: number }>;
}

/** `npm pack` every staged package into dest; returns the tarball paths and npm's file listing. */
export function pack(staged: Staged[], dest: string): Array<Staged & { tarball: string; info: PackInfo }> {
  mkdirSync(dest, { recursive: true });
  return staged.map((s) => {
    const [info] = JSON.parse(npm(["pack", "--json", "--pack-destination", dest], s.dir, true)) as PackInfo[];
    return { ...s, tarball: join(dest, info!.filename), info: info! };
  });
}

function published(name: string, version: string): boolean {
  const r = spawnSync("npm", ["view", `${name}@${version}`, "version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return r.status === 0 && r.stdout.trim() === version;
}

export function publish(staged: Staged[], opts: { dryRun?: boolean; provenance?: boolean; tag?: string }) {
  for (const s of staged) {
    if (!opts.dryRun && published(s.name, s.version)) {
      console.log(`skip ${s.name}@${s.version} (already published)`);
      continue;
    }
    const args = ["publish", "--access", "public"];
    if (opts.provenance) args.push("--provenance");
    if (opts.tag) args.push("--tag", opts.tag);
    if (opts.dryRun) args.push("--dry-run");
    console.log(`npm ${args.join(" ")}  (${s.name}@${s.version})`);
    npm(args, s.dir);
  }
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  const flag = (f: string) => rest.includes(f);
  const value = (f: string) => {
    const i = rest.indexOf(f);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  if (cmd === "stage") {
    for (const s of await stage({ build: !flag("--no-build") })) console.log(`staged ${s.name}@${s.version} → ${s.dir}`);
  } else if (cmd === "pack") {
    const dest = rest.find((a) => !a.startsWith("--")) ?? join(RELEASE_DIR, "tarballs");
    for (const t of pack(await stage({ build: !flag("--no-build") }), dest)) console.log(t.tarball);
  } else if (cmd === "publish") {
    const staged = await stage({ build: !flag("--no-build") });
    const expected = value("--expect-version");
    if (expected && staged.some((s) => s.version !== expected.replace(/^v/, ""))) {
      throw new Error(`tag ${expected} does not match package version ${staged[0]!.version}`);
    }
    publish(staged, { dryRun: flag("--dry-run"), provenance: flag("--provenance"), tag: value("--tag") });
  } else {
    console.error("usage: bun scripts/release.ts stage|pack [dest]|publish [--dry-run] [--provenance] [--tag T] [--expect-version vX.Y.Z] [--no-build]");
    process.exit(1);
  }
}
