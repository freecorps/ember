// `ember migrate convex` (PLAN §22 L9, docs/migrate-from-convex.md): ports a Convex `convex/` folder to an Ember
// `ember/` folder mechanically. Queries, mutations and the helpers they use become synchronous (PLAN D6); imports,
// validators, system tables, ConvexError, crons and convex-helpers triggers/middlewares are rewritten; everything that
// needs a human (helpers mixing database access and I/O, awaits on unknown promises, APIs without an equivalent,
// "use node" files) goes to a markdown report.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { Analysis, type Finding } from "./analyze.ts";
import { checkLibraries, type LibraryCheck } from "./deps.ts";
import { renderReport } from "./report.ts";
import { FileRewriter, type ErrorSite, type MigrationState } from "./rewrite.ts";

export type { Finding, Severity } from "./analyze.ts";
export { checkLibraries, libraryLines, type LibraryCheck, type LibraryFinding } from "./deps.ts";
export { verifyMigration, type VerifyResult } from "./verify.ts";

export interface MigrateOptions {
  /** The Convex functions directory (`convex/`). */
  src: string;
  /** Where the Ember functions go (default `<src>/../ember`). Ignored with `inPlace`. */
  out?: string;
  /** Rewrite the files of `src` itself. */
  inPlace?: boolean;
  /** Analyse and report; write nothing. */
  dryRun?: boolean;
  /** Write into a non-empty `out`. */
  force?: boolean;
  /** The library check already made (`checkLibraries(src)`); default: made here. */
  libraries?: LibraryCheck;
}

export type FileStatus = "converted" | "copied" | "unchanged" | "skipped" | "generated";
export interface FileResult {
  /** Path relative to the source root (posix). */
  file: string;
  status: FileStatus;
  /** Change → how many (`await removed: 12`). */
  changes: Record<string, number>;
  /** Why a file was skipped. */
  note?: string;
}

export interface MigrateResult {
  src: string;
  outDir: string;
  files: FileResult[];
  findings: Finding[];
  errors: ErrorSite[];
  triggers: Array<{ module: string; name: string; table: string }>;
  /** Functions made synchronous / that stay async, by role. */
  sync: { converted: number; handlers: number; helpers: number; blocked: number };
  /** Files written (absolute), empty on a dry run. */
  written: string[];
  /** New text of each converted or generated file, by path relative to the source root. */
  outputs: Record<string, string>;
  /** The markdown report. */
  report: string;
  /** "manual" findings (what `--check` fails on). */
  manual: number;
  /** Which libraries run in an Ember action (deps.ts). */
  libraries: LibraryCheck;
}

const CODE = /\.(ts|tsx|mts|js|mjs|jsx)$/;
const posix = (p: string) => p.split(sep).join("/");

function walk(dir: string, root = dir, out: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    if (name === "node_modules" || name === "_generated" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, root, out);
    else out.push(posix(relative(root, p)));
  }
  return out;
}

function compilerOptions(src: string): ts.CompilerOptions {
  const base: ts.CompilerOptions = {
    allowJs: true,
    checkJs: false,
    noEmit: true,
    strict: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.Preserve,
    allowImportingTsExtensions: true,
  };
  const cfg = join(src, "tsconfig.json");
  if (!existsSync(cfg)) return base;
  const read = ts.readConfigFile(cfg, (p) => readFileSync(p, "utf8"));
  if (read.error) return base;
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, src);
  return { ...base, ...parsed.options, noEmit: true, allowJs: true };
}

/** Runs the codemod (see the module comment). Throws on a bad `src`/`out`. */
export function migrateConvex(options: MigrateOptions): MigrateResult {
  const src = resolve(options.src);
  if (!existsSync(src) || !statSync(src).isDirectory()) throw new Error(`${src} is not a directory (pass --src <convex dir>)`);
  const outDir = options.inPlace ? src : resolve(options.out ?? join(dirname(src), "ember"));
  if (!options.inPlace) {
    if (outDir === src) throw new Error("--out is the source directory: use --in-place to rewrite it");
    if (outDir.startsWith(src + sep)) throw new Error(`--out (${outDir}) is inside the source directory`);
    if (!options.dryRun && !options.force && existsSync(outDir) && readdirSync(outDir).length) throw new Error(`${outDir} is not empty (pass --force to write into it)`);
  }

  // The original sources' libraries, before anything is written (with --in-place the output lands in src, and its
  // generated files import Ember's own packages).
  const libraries = options.libraries ?? checkLibraries(src);
  const all = walk(src);
  const files: FileResult[] = [];
  const skipped = new Map<string, string>();
  for (const f of all) {
    if (/^auth\.config\.(ts|js)$/.test(f)) skipped.set(f, "Convex auth providers: Ember's ember/auth.config.ts is Better Auth (defineAuth), not converted");
    else if (/^convex\.config\.(ts|js)$/.test(f)) skipped.set(f, "Convex components: install Ember components in ember/ember.config.ts (defineApp().use(...))");
  }
  const code = all.filter((f) => CODE.test(f) && !f.endsWith(".d.ts") && !skipped.has(f));
  const abs = new Map(code.map((f) => [join(src, f), f]));
  const program = ts.createProgram([...abs.keys()], compilerOptions(src));
  const rel = (file: string) => abs.get(file) ?? posix(relative(src, file));
  const a = new Analysis(program, new Set(abs.keys()), rel);
  a.run();

  const taken = new Set(all.map((f) => f.replace(CODE, "")));
  const errorsModule = taken.has("errors") ? (taken.has("emberErrors") ? "_emberErrors" : "emberErrors") : "errors";
  const st: MigrationState = { a, errorsModule, errors: new Map(), triggers: [] };
  const outputs = new Map<string, string>();

  for (const [file, f] of abs) {
    const sf = program.getSourceFile(file);
    if (!sf) continue;
    const rw = new FileRewriter(sf, f, st);
    const text = rw.run();
    const useNode = sf.statements.some((s) => ts.isExpressionStatement(s) && ts.isStringLiteral(s.expression) && s.expression.text === "use node");
    if (useNode) {
      const imports = sf.statements.filter(ts.isImportDeclaration).map((d) => (d.moduleSpecifier as ts.StringLiteral).text);
      a.findings.push({
        file: f,
        line: 1,
        severity: "review",
        code: "use-node",
        message: `"use node" (Node runtime in Convex): Ember actions run in workerd with nodejs_compat (PLAN §22 L13); imports: ${imports.length ? imports.map((m) => `\`${m}\``).join(", ") : "none"}`,
      });
    }
    files.push({ file: f, status: text === null ? "unchanged" : "converted", changes: Object.fromEntries(rw.counts) });
    if (text !== null) outputs.set(f, text);
  }
  a.reportBlocked();
  if (options.inPlace && existsSync(join(src, "_generated"))) {
    a.findings.push({ file: "_generated", line: 1, severity: "review", code: "generated-dir", message: "the Convex _generated/ folder is still here: delete it before `ember codegen` (Ember writes its own)" });
  }
  for (const [f, note] of skipped) {
    files.push({ file: f, status: "skipped", changes: {}, note });
    a.findings.push({ file: f, line: 1, severity: "manual", code: f.startsWith("auth") ? "auth-config" : "convex-config", message: note });
  }
  for (const f of all) if (!abs.has(join(src, f)) && !skipped.has(f)) files.push({ file: f, status: "copied", changes: {} });

  // Generated: ember/errors.ts (ConvexError codes) and ember/triggers.ts (convex-helpers triggers).
  const errors = [...st.errors.values()].sort((x, y) => (x.code === "AppError" ? 1 : y.code === "AppError" ? -1 : x.code.localeCompare(y.code)));
  if (errors.length) {
    const f = `${errorsModule}.ts`;
    outputs.set(f, errorsFile(errors));
    files.push({ file: f, status: "generated", changes: { "error codes": errors.length } });
  }
  if (st.triggers.length) {
    const existing = all.find((f) => /^triggers\.(ts|js)$/.test(f));
    if (existing) {
      const base = outputs.get(existing) ?? readFileSync(join(src, existing), "utf8");
      const own = st.triggers.every((t) => t.module === "triggers");
      outputs.set(existing, own ? `${base.trimEnd()}\n\n${triggersDefault(st.triggers, true)}` : `${triggersImports(st.triggers, "triggers")}${base.trimEnd()}\n\n${triggersDefault(st.triggers, false)}`);
      const r = files.find((x) => x.file === existing);
      if (r) {
        if (r.status === "unchanged" || r.status === "copied") r.status = "converted";
        r.changes = { ...r.changes, triggers: st.triggers.length };
      }
      a.findings.push({ file: existing, line: 1, severity: "review", code: "triggers-file", message: "ember/triggers.ts is a reserved file in Ember (its default export is defineTriggers; functions defined there are not registered): the default export was appended; move any query/mutation it defines to another module" });
    } else {
      outputs.set("triggers.ts", `// From the convex-helpers Triggers found by \`ember migrate convex\` (contracts.md "Triggers").\n${triggersImports(st.triggers, null)}\n${triggersDefault(st.triggers, false)}`);
      files.push({ file: "triggers.ts", status: "generated", changes: { triggers: st.triggers.length } });
    }
  }

  const written: string[] = [];
  if (!options.dryRun) {
    const emit = (f: string, text: string | Buffer) => {
      const p = join(outDir, f);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, text);
      written.push(p);
    };
    for (const r of files) {
      if (r.status === "skipped") continue;
      const text = outputs.get(r.file);
      if (options.inPlace) {
        // In place, write every file whose final text (rewrites plus anything appended, like the
        // defineTriggers default) differs from what is on disk; copied/unchanged files stay as they are.
        const p = join(src, r.file);
        if (text !== undefined && (!existsSync(p) || readFileSync(p, "utf8") !== text)) emit(r.file, text);
      } else if (text !== undefined) emit(r.file, text);
      else if (r.status === "copied" || r.status === "unchanged") emit(r.file, readFileSync(join(src, r.file)));
    }
  }

  const blocked = [...a.candidates.values()].filter((c) => !a.sync.has(c.node) && c.blockers.some((b) => !b.why.startsWith("inside ")));
  const converted = [...a.candidates.values()].filter((c) => a.sync.has(c.node) && c.role !== "nested");
  const result: Omit<MigrateResult, "report"> = {
    src,
    outDir,
    files: files.sort((x, y) => x.file.localeCompare(y.file)),
    findings: a.findings.sort((x, y) => x.file.localeCompare(y.file) || x.line - y.line),
    errors,
    triggers: st.triggers,
    sync: { converted: converted.length, handlers: converted.filter((c) => c.role === "handler").length, helpers: converted.filter((c) => c.role !== "handler").length, blocked: blocked.length },
    written,
    outputs: Object.fromEntries([...outputs].sort(([x], [y]) => x.localeCompare(y))),
    manual: a.findings.filter((x) => x.severity === "manual").length,
    libraries,
  };
  return { ...result, report: renderReport(result, options) };
}

function errorsFile(errors: ErrorSite[]): string {
  const lines = errors.map((e) => {
    const from = e.code === "AppError" ? "ConvexError without a code (data: the original payload)" : `from ${[...e.raw].map((r) => JSON.stringify(r)).join(", ")}`;
    const sites = e.sites.length > 4 ? `${e.sites.slice(0, 4).join(", ")} (+${e.sites.length - 4})` : e.sites.join(", ");
    return `  /** ${from}: ${sites} */\n  ${e.code}: { data: v.any() /* refine */, message: messageOf(${JSON.stringify(e.code)}) },`;
  });
  return `// From the ConvexError codes found by \`ember migrate convex\` (one per code). The payload is the one the Convex code
// threw (\`{ code, ... }\` or a string), so clients reading \`error.data\` keep working; refine each \`v.any()\` into the
// payload's validator and give the errors messages of their own (docs/design/dx.md §3.2).
import { defineErrors, v } from "@freecorps/ember-server";

/** The payload's \`message\` (or the payload itself when it is a string), else the code. */
const messageOf =
  (code: string) =>
  (data: unknown): string =>
    typeof data === "string"
      ? data
      : typeof data === "object" && data !== null && typeof (data as { message?: unknown }).message === "string"
        ? (data as { message: string }).message
        : code;

export const errors = defineErrors({
${lines.join("\n")}
});
`;
}

function triggersImports(triggers: MigrationState["triggers"], skipModule: string | null): string {
  const byModule = new Map<string, string[]>();
  for (const t of triggers) if (t.module !== skipModule) byModule.set(t.module, [...(byModule.get(t.module) ?? []), t.name]);
  const imports = [...byModule].map(([m, names]) => `import { ${names.join(", ")} } from "./${m}";`);
  return `import { defineTriggers } from "./_generated/server";\n${imports.join("\n")}${imports.length ? "\n" : ""}`;
}

function triggersDefault(triggers: MigrationState["triggers"], own: boolean): string {
  const byTable = new Map<string, string[]>();
  for (const t of triggers) byTable.set(t.table, [...(byTable.get(t.table) ?? []), t.name]);
  const head = own ? 'import { defineTriggers } from "./_generated/server";\n\n' : "";
  return `${head}export default defineTriggers({\n${[...byTable].map(([t, names]) => `  ${/^[A-Za-z_$][\w$]*$/.test(t) ? t : JSON.stringify(t)}: [${names.join(", ")}],`).join("\n")}\n});\n`;
}
