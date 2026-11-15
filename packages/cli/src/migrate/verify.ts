// `ember migrate convex --verify`: `ember codegen` + `tsc --noEmit` on the converted folder, listing what is left.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import ts from "typescript";
import { codegen } from "../codegen/index.ts";
import { projectFrom, type EmberConfigFile } from "../config.ts";

export interface VerifyResult {
  /** `ember codegen` failed (module evaluation, schema...): its message. */
  codegenError?: string;
  codegenWarnings: string[];
  /** `file:line: message` of the files of the functions directory (relative to it). */
  diagnostics: string[];
}

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

/**
 * Runs codegen on `dir` (an Ember functions folder) and type-checks it. `compilerOptions` override the folder's
 * tsconfig.json (or the defaults: strict, bundler resolution).
 */
export async function verifyMigration(dir: string, opts: { root?: string; compilerOptions?: ts.CompilerOptions } = {}): Promise<VerifyResult> {
  const root = opts.root ?? dirname(dir);
  const config = { project: "migrated", compatibilityDate: "2026-01-01", functionsDir: relative(root, dir).split(sep).join("/"), environments: {} } as unknown as EmberConfigFile;
  const project = projectFrom(root, config);
  const out: VerifyResult = { codegenWarnings: [], diagnostics: [] };
  try {
    const r = await codegen(project);
    out.codegenWarnings = [...r.warnings, ...r.errors];
  } catch (e) {
    out.codegenError = (e as Error).message;
  }
  let options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    allowImportingTsExtensions: true,
    jsx: ts.JsxEmit.Preserve,
    lib: ["lib.es2023.d.ts", "lib.dom.d.ts"],
  };
  const cfg = join(dir, "tsconfig.json");
  if (existsSync(cfg)) {
    const read = ts.readConfigFile(cfg, (p) => readFileSync(p, "utf8"));
    if (!read.error) options = { ...options, ...ts.parseJsonConfigFileContent(read.config, ts.sys, dir).options };
  }
  options = { ...options, ...opts.compilerOptions, noEmit: true };
  const program = ts.createProgram(sources(dir), options);
  for (const d of ts.getPreEmitDiagnostics(program)) {
    const msg = ts.flattenDiagnosticMessageText(d.messageText, "\n").split("\n")[0];
    if (d.file && relative(dir, d.file.fileName).startsWith("..")) continue; // only the converted code
    if (d.file && d.start !== undefined) {
      const { line } = d.file.getLineAndCharacterOfPosition(d.start);
      out.diagnostics.push(`${relative(dir, d.file.fileName).split(sep).join("/")}:${line + 1}: ${msg}`);
    } else out.diagnostics.push(String(msg));
  }
  return out;
}
