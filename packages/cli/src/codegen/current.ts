// What `ember codegen` generated from: a hash of the sources it read, kept in manifest.json (`sources`), so commands
// that only read the result (`ember types`, `ember openapi`) reuse a current manifest.json and api.d.ts instead of
// evaluating and type-checking the project again.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import ts from "typescript";
import type { Project } from "../config.ts";
import type { EmberManifest } from "./index.ts";

/** Bumped when the generated files change for the same sources (a manifest from before is not reused). */
const FORMAT = "ember-codegen-sources-1";
/** Files of the project root that change what codegen generates (auth mode, dependencies, compiler options). */
const ROOT_FILES = ["ember.json", "package.json", "tsconfig.json"];

/** What `sources` in manifest.json holds. */
export interface SourcesStamp {
  /** sha256 of the sources (see `sourcesHash`). */
  hash: string;
  /** Files outside ember/ (relative to the project root) the functions import, hashed too. */
  files?: string[];
}

const toPosix = (p: string) => p.split(sep).join("/");

/** Every file under ember/ but `_generated`, dot files and node_modules (relative, sorted). */
function functionFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (name.startsWith(".") || name === "node_modules" || name === "_generated") continue;
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(p);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out.sort();
}

/**
 * The files of the program codegen type-checked that live in the project but outside ember/ (`../shared/types.ts`):
 * neither node_modules nor the packages of a monorepo around it.
 */
export function outsideFiles(project: Project, programFiles: string[]): string[] {
  const out = new Set<string>();
  for (const f of programFiles) {
    const rel = relative(project.root, f);
    if (rel.startsWith("..") || isAbsolute(rel)) continue;
    const inFunctions = relative(project.dir, f);
    if (!inFunctions.startsWith("..") && !isAbsolute(inFunctions)) continue;
    if (rel.split(/[\\/]/).includes("node_modules")) continue;
    out.add(toPosix(rel));
  }
  return [...out].sort();
}

/** sha256 of the sources: every file under ember/ (paths and contents), `extra` (root-relative) and the root's config files. */
export function sourcesHash(project: Project, extra: string[] = []): string {
  const h = createHash("sha256").update(FORMAT);
  const add = (label: string, file: string) => {
    h.update(`\u0000${label}\u0000`);
    h.update(existsSync(file) ? readFileSync(file) : "\u0000missing");
  };
  for (const f of functionFiles(project.dir)) add(toPosix(relative(project.root, f)), f);
  for (const f of extra) add(`+${f}`, join(project.root, f));
  for (const f of ROOT_FILES) add(`/${f}`, join(project.root, f));
  return h.digest("hex");
}

/**
 * manifest.json and api.d.ts, when manifest.json says it was generated from the sources as they are now; null when
 * they are missing or out of date (the caller runs codegen instead).
 */
export function currentManifest(project: Project): { manifest: EmberManifest; api: string } | null {
  const manifestFile = join(project.generatedDir, "manifest.json");
  const apiFile = join(project.generatedDir, "api.d.ts");
  if (!existsSync(manifestFile) || !existsSync(apiFile)) return null;
  let manifest: EmberManifest & { sources?: SourcesStamp };
  try {
    manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as EmberManifest & { sources?: SourcesStamp };
  } catch {
    return null;
  }
  const stamp = manifest.sources;
  if (!stamp || typeof stamp.hash !== "string") return null;
  if (sourcesHash(project, Array.isArray(stamp.files) ? stamp.files : []) !== stamp.hash) return null;
  return { manifest, api: readFileSync(apiFile, "utf8") };
}

/**
 * Each function's contract as `ember codegen` printed it in api.d.ts (`Query<Args, Returns, Errors>`, the same text as
 * `CodegenResult.contracts`), read back from the file.
 */
export function contractsFromApiDts(text: string): Map<string, string> {
  const sf = ts.createSourceFile("api.d.ts", text, ts.ScriptTarget.Latest, true);
  const out = new Map<string, string>();
  const name = (n: ts.PropertyName) => (ts.isIdentifier(n) || ts.isStringLiteral(n) ? n.text : n.getText(sf));
  const walk = (members: ts.NodeArray<ts.TypeElement>, path: string[]) => {
    for (const m of members) {
      if (!ts.isPropertySignature(m) || !m.type) continue;
      const key = name(m.name);
      if (ts.isTypeLiteralNode(m.type)) {
        walk(m.type.members, [...path, key]);
        continue;
      }
      if (!path.length) continue;
      const indent = " ".repeat(sf.getLineAndCharacterOfPosition(m.getStart(sf)).character);
      out.set(`${path.join("/")}:${key}`, m.type.getText(sf).split(`\n${indent}`).join("\n"));
    }
  };
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && (d.name.text === "api" || d.name.text === "internal") && d.type && ts.isTypeLiteralNode(d.type)) walk(d.type.members, []);
    }
  }
  return out;
}
