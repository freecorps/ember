// `ember migrate convex`: which of the Convex project's libraries run in an Ember action (workerd + nodejs_compat),
// from the spike's verdicts (libraries.ts). Checked before anything is converted: the import specifiers of every file
// of the functions folder, and the dependencies of the package.json next to it. `--strict` fails on a library
// the functions import that cannot run in the Worker.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { LIBRARIES, type Verdict } from "./libraries.ts";

export interface LibraryFinding {
  /** The import (`sharp`, `node:fs`) or the dependency name. */
  module: string;
  /** The libraries.ts entry that matched (`exceljs` for `exceljs/dist/x`); absent for `unknown`. */
  matched?: string;
  verdict: Verdict | "unknown";
  note?: string;
  /** Files of the functions folder that import it (posix, relative to it); empty: a dependency nobody there imports. */
  files: string[];
  /** Its version range in package.json, when it is a dependency. */
  version?: string;
}

export interface LibraryCheck {
  /** The package.json read (absolute), if any. */
  packageJson: string | null;
  /** Sorted: no, partial, unknown, works; then by name. */
  findings: LibraryFinding[];
  /** Libraries the functions import that cannot run in the Worker (what `--strict` fails on). */
  blocking: LibraryFinding[];
}

const CODE = /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/;
const BUILTINS = new Set(builtinModules.filter((m) => !m.startsWith("_")));
// Rewritten by the codemod (or replaced by Ember's own packages): not runtime dependencies of the converted code.
const REWRITTEN = /^(convex|convex-helpers|@convex-dev\/[^/]+)(\/|$)/;

/**
 * The modules a file loads at run time, parsed (TypeScript's parser, so comments and string contents never count and a
 * comment inside a declaration does not hide it): `import x from "m"`, `import "m"`, `export … from "m"`,
 * `import x = require("m")`, `import("m")`, `require("m")` with a string literal. Type-only imports and exports
 * (`import type`, `export type … from`, `import("m").T` in a type) never reach the bundle and are left out.
 */
export function importSpecifiers(text: string, fileName = "x.tsx"): string[] {
  const out = new Set<string>();
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false, /\.(c|m)?jsx?$/.test(fileName) ? ts.ScriptKind.JSX : ts.ScriptKind.TSX);
  const literal = (n: ts.Node | undefined) => (n && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) ? n.text : null);
  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n)) {
      const m = literal(n.moduleSpecifier);
      if (m && !n.importClause?.isTypeOnly) out.add(m);
      return;
    }
    if (ts.isExportDeclaration(n)) {
      const m = literal(n.moduleSpecifier);
      if (m && !n.isTypeOnly) out.add(m);
      return;
    }
    if (ts.isImportEqualsDeclaration(n)) {
      if (!n.isTypeOnly && ts.isExternalModuleReference(n.moduleReference)) {
        const m = literal(n.moduleReference.expression);
        if (m) out.add(m);
      }
      return;
    }
    if (ts.isCallExpression(n) && n.arguments.length >= 1) {
      const isImport = n.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(n.expression) && n.expression.text === "require";
      const m = literal(n.arguments[0]);
      if ((isImport || isRequire) && m) out.add(m);
    }
    // Types (`import("m").T`, `typeof import("m")`) are never loaded.
    if (ts.isTypeNode(n)) return;
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return [...out];
}

/** The package an import names (`@scope/pkg/sub` → `@scope/pkg`), `node:<name>` for builtins, null for relative paths. */
export function packageOf(spec: string): string | null {
  if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("#")) return null;
  if (spec.startsWith("node:")) return spec;
  const parts = spec.split("/");
  const name = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
  return BUILTINS.has(name) || BUILTINS.has(spec) ? `node:${BUILTINS.has(spec) ? spec : name}` : name;
}

/** The verdict of an import: the longest libraries.ts key equal to it or a path prefix of it (`node:` for builtins). */
export function lookup(spec: string): { matched: string; verdict: Verdict; note?: string } | null {
  const pkg = packageOf(spec);
  if (!pkg) return null;
  const full = pkg.startsWith("node:") && !spec.startsWith("node:") ? `node:${spec}` : spec;
  let best: string | null = null;
  for (const key of Object.keys(LIBRARIES.modules)) {
    if ((full === key || full.startsWith(`${key}/`)) && (!best || key.length > best.length)) best = key;
  }
  if (!best) return null;
  const v = LIBRARIES.modules[best]!;
  return { matched: best, verdict: v.verdict, ...(v.note ? { note: v.note } : {}) };
}

function walk(dir: string, root = dir, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    if (name === "node_modules" || name === "_generated" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, root, out);
    else if (CODE.test(name) && !name.endsWith(".d.ts")) out.push(relative(root, p).split(sep).join("/"));
  }
  return out;
}

/** The Convex project's package.json: next to the functions folder (`<root>/convex` → `<root>/package.json`) or in it. */
function findPackageJson(src: string): string | null {
  for (const d of [dirname(src), src]) {
    const p = join(d, "package.json");
    if (existsSync(p)) return p;
  }
  return null;
}

const ORDER: Record<LibraryFinding["verdict"], number> = { no: 0, partial: 1, unknown: 2, works: 3 };

/** Checks the functions folder `src` (`convex/`) and its package.json against libraries.ts. */
export function checkLibraries(src: string): LibraryCheck {
  const root = resolve(src);
  // A bad --src: migrateConvex says so.
  if (!existsSync(root) || !statSync(root).isDirectory()) return { packageJson: null, findings: [], blocking: [] };
  const byModule = new Map<string, LibraryFinding>();
  for (const f of walk(root)) {
    for (const spec of importSpecifiers(readFileSync(join(root, f), "utf8"), f)) {
      if (REWRITTEN.test(spec)) continue;
      const pkg = packageOf(spec);
      if (!pkg) continue;
      const hit = lookup(spec);
      // Subpaths with their own verdict (`exceljs/lib/exceljs.nodejs.js`) are listed apart; others under the package.
      const key = hit && hit.matched !== pkg && !pkg.startsWith("node:") ? hit.matched : pkg;
      const cur = byModule.get(key) ?? { module: key, ...(hit ? { matched: hit.matched, verdict: hit.verdict, ...(hit.note ? { note: hit.note } : {}) } : { verdict: "unknown" as const }), files: [] };
      if (!cur.files.includes(f)) cur.files.push(f);
      byModule.set(key, cur);
    }
  }
  const packageJson = findPackageJson(root);
  if (packageJson) {
    let deps: Record<string, string> = {};
    try {
      const pj = JSON.parse(readFileSync(packageJson, "utf8")) as { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> };
      deps = { ...(pj.optionalDependencies ?? {}), ...(pj.dependencies ?? {}) };
    } catch {
      // unreadable: imports only
    }
    for (const [name, version] of Object.entries(deps)) {
      if (REWRITTEN.test(name)) continue;
      const cur = byModule.get(name);
      if (cur) {
        cur.version = version;
        continue;
      }
      // A dependency the functions do not import: listed only when the spike has a verdict for it.
      const hit = lookup(name);
      if (hit) byModule.set(name, { module: name, matched: hit.matched, verdict: hit.verdict, ...(hit.note ? { note: hit.note } : {}), files: [], version });
    }
  }
  const findings = [...byModule.values()].sort((a, b) => ORDER[a.verdict] - ORDER[b.verdict] || a.module.localeCompare(b.module));
  return { packageJson, findings, blocking: findings.filter((x) => x.verdict === "no" && x.files.length > 0) };
}

/** Terminal lines (what `ember migrate convex` prints before converting); empty when nothing needs a look. */
export function libraryLines(c: LibraryCheck): string[] {
  const shown = c.findings.filter((f) => f.verdict !== "works");
  if (!shown.length) return [];
  const out = [`libraries (Ember actions run in workerd with ${LIBRARIES.runtime.compatibilityFlags.join(", ")}; verdicts from docs/spikes/node-actions):`];
  for (const f of shown) {
    const where = f.files.length ? `imported by ${f.files.slice(0, 3).join(", ")}${f.files.length > 3 ? ` (+${f.files.length - 3})` : ""}` : "a dependency the functions do not import";
    const label = f.verdict === "no" ? "does not run" : f.verdict === "partial" ? "partial" : "unknown";
    out.push(`  ${label.padEnd(12)} ${f.module}${f.version ? `@${f.version}` : ""} (${where})${f.note ? `: ${f.note}` : f.verdict === "unknown" ? ": not in the compatibility list; check it under workerd (ember dev)" : ""}`);
  }
  return out;
}

/** The report's section (markdown). */
export function librarySection(c: LibraryCheck): string[] {
  if (!c.findings.length) return [];
  const esc = (s: string) => s.replace(/\|/g, "\\|");
  const label = { no: "**does not run**", partial: "partial", unknown: "unknown", works: "works" } as const;
  return [
    "## Libraries (workerd + nodejs_compat)",
    "",
    `Verdicts from the node-actions spike (compatibility date ${LIBRARIES.runtime.compatibilityDate}, ${LIBRARIES.runtime.isolateMemoryMB} MB isolate). \`--strict\` fails on a library the functions import that does not run.`,
    "",
    "| Library | Verdict | Imported by | Note |",
    "|---|---|---|---|",
    ...c.findings.map((f) => `| \`${esc(f.module)}\`${f.version ? ` ${esc(f.version)}` : ""} | ${label[f.verdict]} | ${f.files.length ? f.files.map((x) => `\`${esc(x)}\``).join(", ") : "-"} | ${esc(f.note ?? (f.verdict === "unknown" ? "not in the list: check it under `ember dev`" : ""))} |`),
    "",
  ];
}
