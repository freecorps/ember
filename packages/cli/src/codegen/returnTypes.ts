// The type oracle of `ember codegen` (docs/design/dx.md §3.5): the TypeScript compiler reads the user's modules and
// tells, for each exported function, its return type (printed as a self-contained type, so client code never
// type-checks server code), the application errors it may throw (inferred from the handler), its JSDoc and where it is
// declared (for the declaration map: Go to Definition from `api.x.y` lands on the handler).
//
// The generated files the modules import (`_generated/api.d.ts`, ...) are served from memory: codegen iterates until
// the printed api no longer changes (a function returning `ctx.runQuery(internal.x.y)` needs `x.y`'s type first).
//
// Incremental (`ember dev`): the oracle keeps a builder program between runs (the previous program is reused) and
// caches each module's results and diagnostics, keyed by the versions of the module and of every file it imports,
// transitively (the builder's reference graph). A pass re-infers only the modules whose file changed and the ones
// importing them (directly or not); the others are replayed from the cache, so a save re-checks the edited module and
// its callers, not the app. The output is the same as a run from scratch's (codegen-incremental.test.ts).

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import ts from "typescript";
import { SOURCE_CONDITIONS } from "../source.ts";

export interface FunctionTypeInfo {
  /** Printed return type ("unknown" when it could not be inferred). */
  returns: string;
  /** Error codes found in the handler (thrown `errors.X(...)`, `ctx.fail.X`, callees' errors). */
  errors: string[];
  /** The export's JSDoc, as lines without the comment markers. */
  doc: string[];
  /** Where the export's name is (0-based line/character). */
  source: { file: string; line: number; character: number } | null;
  /** Why the return type is not useful (`any`, `unknown`), for warnings. */
  problem?: string;
}

export interface NamedType {
  name: string;
  /** Printed definition (right-hand side). */
  text: string;
}

export interface InferOptions {
  /** Module path → absolute file. */
  modules: Array<{ path: string; file: string }>;
  /** Functions to describe (`"mod:fn"`). */
  wanted: Set<string>;
  /** Which of them need their return type inferred (the others have a `returns` validator). */
  inferReturns: Set<string>;
  /** Generated files served from memory (absolute path → content). */
  virtualFiles: Map<string, string>;
  /** `ember/_generated` (its `server.d.ts` gives the document types, printed as `Doc<"t">`). */
  generatedDir: string;
  /** The functions directory (types declared under it can be emitted by name). */
  projectDir: string;
}

export interface InferResult {
  functions: Map<string, FunctionTypeInfo>;
  /** Types exported by the user's modules that the printed types refer to by name (→ `_generated/types.d.ts`). */
  named: NamedType[];
  /** Modules (paths) whose functions this pass inferred; the others came from the cache. */
  inferred: string[];
}

const COMPILER_OPTIONS: ts.CompilerOptions = {
  strict: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowImportingTsExtensions: true,
  customConditions: SOURCE_CONDITIONS,
  noEmit: true,
  skipLibCheck: true,
  types: [],
  lib: ["lib.es2023.d.ts", "lib.dom.d.ts"],
};

/** A module's results, valid while its key and the named types before it are the same. */
interface ModuleCache {
  /** Versions of the module and of every file it imports (transitively), and what was asked about it. */
  key: string;
  /** The named types defined before this module (they decide what its printing names and how). */
  before: string;
  functions: Array<[string, FunctionTypeInfo]>;
  /** Named types its printing defined, in order. */
  named: Array<[string, NamedType]>;
}

type VersionedSourceFile = ts.SourceFile & { version?: string };

/** `TypeOracle.claims`: the printed claims, or why there are none. */
export type ClaimsResult = { text: string } | { problem: string };
/** What the claims were computed from: the files their program read, with their sizes and mtimes. */
type ClaimsCache = { authConfig: string; files: string[]; stamp: string; result: ClaimsResult };

/**
 * The files whose size and mtime stand for `files`: each one, but for a file of an installed package (under
 * node_modules) that package's package.json (Better Auth's types are hundreds of files; a new version rewrites it).
 */
function stampFiles(files: string[]): string[] {
  const out = new Set<string>();
  for (const f of files) {
    const parts = f.split(/[\\/]/);
    const nm = parts.lastIndexOf("node_modules");
    if (nm < 0) {
      out.add(f);
      continue;
    }
    const pkg = parts.slice(0, nm + (parts[nm + 1]?.startsWith("@") ? 3 : 2));
    out.add([...pkg, "package.json"].join("/"));
  }
  return [...out];
}

const stampOf = (files: string[]) =>
  files
    .map((f) => {
      try {
        const st = statSync(f);
        return `${f}:${st.size}:${st.mtimeMs}`;
      } catch {
        return `${f}:-`;
      }
    })
    .join("|");
/** The stamp of a claims answer: auth.config.ts itself (always, even when its program could not read it) and what it read. */
const claimsStamp = (authConfig: string, files: string[]) => stampOf([authConfig, ...files]);

function readClaimsCache(file: string): ClaimsCache | undefined {
  try {
    const c = JSON.parse(readFileSync(file, "utf8")) as Partial<ClaimsCache>;
    const r = c.result as Partial<{ text: unknown; problem: unknown }> | undefined;
    if (typeof c.authConfig !== "string" || !Array.isArray(c.files) || typeof c.stamp !== "string" || !r) return undefined;
    if (typeof r.text !== "string" && typeof r.problem !== "string") return undefined;
    return c as ClaimsCache;
  } catch {
    return undefined;
  }
}

/**
 * Keeps the TypeScript program between runs (`ember dev`): a builder program (the previous program is reused, and its
 * reference graph tells what each module imports) and caches of each module's inferred types and diagnostics, keyed
 * by the versions of the module and of everything it imports, so a run re-checks only what an edit can change.
 */
export class TypeOracle {
  private builder: ts.SemanticDiagnosticsBuilderProgram | undefined;
  private readonly files = new Map<string, { text: string; sf: VersionedSourceFile }>();
  private readonly modules = new Map<string, ModuleCache>();
  private readonly checked = new Map<string, { key: string; diagnostics: string[] }>();
  private nextVersion = 0;
  /** The modules of the last `infer` and the dependency key of each. */
  private last: Array<{ file: string; key: string }> = [];
  private claimsProgram: ts.Program | undefined;
  private claimsCache: ClaimsCache | undefined;

  /**
   * Syntax and type errors of the user's modules in the program of the last `infer` (codegen asks once, after the pass
   * that converged; codegen still succeeds with them, printed as warnings). A module nothing it depends on changed
   * keeps the diagnostics of an earlier run.
   */
  diagnostics(): string[] {
    const program = this.builder?.getProgram();
    if (!program) return [];
    for (const f of this.checked.keys()) if (!this.last.some((m) => m.file === f)) this.checked.delete(f);
    return this.last.flatMap(({ file, key }) => {
      const hit = this.checked.get(file);
      if (hit && hit.key === key) return hit.diagnostics;
      const sf = program.getSourceFile(file);
      const diagnostics = sf ? [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)].map((d) => formatDiagnostic(d)) : [];
      this.checked.set(file, { key, diagnostics });
      return diagnostics;
    });
  }

  /** The files of the last `infer`'s program (absolute). */
  programFiles(): string[] {
    const inferred = this.builder?.getProgram().getSourceFiles().map((sf) => sf.fileName) ?? [];
    // The claims answer is a program of its own: the files auth.config.ts read (type-only imports included) count too,
    // also when the answer came from the cache file.
    return [...inferred, ...(this.claimsCache?.files ?? [])];
  }

  /** A compiler host reading `virtual` files from memory and keeping one SourceFile per (file, text). */
  private host(virtual: Map<string, string>): ts.CompilerHost {
    const host = ts.createCompilerHost(COMPILER_OPTIONS, true);
    const read = host.readFile.bind(host);
    const exists = host.fileExists.bind(host);
    const getSf = host.getSourceFile.bind(host);
    host.fileExists = (f) => virtual.has(resolve(f)) || exists(f);
    host.readFile = (f) => virtual.get(resolve(f)) ?? read(f);
    // With a version (the builder requires one): an unchanged file keeps its version, which the caches' keys are made of.
    host.getSourceFile = (f, lang, onError, create) => {
      const text = virtual.get(resolve(f)) ?? read(f);
      if (text === undefined) return getSf(f, lang, onError, create);
      const key = resolve(f);
      const hit = this.files.get(key);
      if (hit && hit.text === text) return hit.sf;
      const sf: VersionedSourceFile = ts.createSourceFile(f, text, lang, true);
      sf.version = String(++this.nextVersion);
      this.files.set(key, { text, sf });
      return sf;
    };
    return host;
  }

  /**
   * The claims of the identities `ember/auth.config.ts` signs in (`ClaimsOf<typeof config>` of @freecorps/ember-auth),
   * printed as a self-contained type, or why it could not be. Its own program (Better Auth's types stay out of the
   * modules'), checked again only when auth.config.ts or a file it read changed (size or mtime; a package under
   * node_modules by its package.json). `cacheFile` (in `.ember/`) keeps the answer between processes: checking Better
   * Auth's types takes a while. A failure is never kept: what fixes it may be a file the failed program did not read (a
   * module that did not resolve yet).
   */
  claims(o: { authConfig: string; generatedDir: string; projectDir: string; cacheFile?: string }): ClaimsResult {
    const prev = this.claimsCache ?? (o.cacheFile ? readClaimsCache(o.cacheFile) : undefined);
    if (prev && "text" in prev.result && prev.authConfig === o.authConfig && claimsStamp(o.authConfig, prev.files) === prev.stamp) {
      this.claimsCache = prev;
      return prev.result;
    }
    const probe = resolve(o.generatedDir, "__ember_claims.ts");
    const spec = JSON.stringify(relative(o.generatedDir, o.authConfig).split("\\").join("/").replace(/^(?!\.)/, "./"));
    const virtual = new Map([[probe, `import type config from ${spec};\nimport type { ClaimsOf } from "@freecorps/ember-auth";\nexport type __EmberClaims = ClaimsOf<typeof config>;\n`]]);
    const program = ts.createProgram({ rootNames: [probe], options: COMPILER_OPTIONS, host: this.host(virtual), ...(this.claimsProgram ? { oldProgram: this.claimsProgram } : {}) });
    this.claimsProgram = program;
    const c = program.getTypeChecker();
    const sf = program.getSourceFile(probe);
    const errors = sf ? program.getSemanticDiagnostics(sf) : [];
    const mod = sf && c.getSymbolAtLocation(sf);
    const alias = mod && c.getExportsOfModule(mod).find((x) => x.getName() === "__EmberClaims");
    let result: ClaimsResult;
    if (!alias) result = { problem: "no ClaimsOf in @freecorps/ember-auth" };
    else if (errors.length) result = { problem: formatDiagnostic(errors[0]!) };
    else {
      const t = c.getDeclaredTypeOfSymbol(alias);
      const printer = new TypePrinter(c, program, o, () => new Map(), true);
      const text = printer.print(t, "", false);
      // An `any` anywhere (the printer saw one), not the word in the text (`"read:any"` is a fine literal).
      result = t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown) || printer.sawAny ? { problem: `ClaimsOf<typeof config> is \`${text}\`` } : { text };
    }
    if (!("text" in result)) {
      // Nor its program: reused, it would keep a module resolution that failed (the file is there now).
      this.claimsCache = undefined;
      this.claimsProgram = undefined;
      return result;
    }
    const files = stampFiles(
      program
        .getSourceFiles()
        .map((f) => f.fileName)
        .filter((f) => resolve(f) !== probe && !program.isSourceFileDefaultLibrary(program.getSourceFile(f)!)),
    );
    this.claimsCache = { authConfig: o.authConfig, files, stamp: claimsStamp(o.authConfig, files), result };
    if (o.cacheFile) {
      try {
        mkdirSync(dirname(o.cacheFile), { recursive: true });
        writeFileSync(o.cacheFile, JSON.stringify(this.claimsCache));
      } catch {
        // A cache: without it the next process checks again.
      }
    }
    return result;
  }

  infer(o: InferOptions): InferResult {
    const virtual = new Map([...o.virtualFiles].map(([k, v]) => [resolve(k), v]));
    const host = this.host(virtual);
    const docsFile = resolve(o.generatedDir, "__ember_docs.ts");
    virtual.set(docsFile, DOCS_PROBE);
    const rootNames = [...o.modules.map((m) => m.file), docsFile];
    // Only its program and reference graph are used: its own diagnostics bookkeeping (declaration emits to compare
    // signatures) costs more than it saves here, where a module's results depend on its imports' bodies too (errors).
    const builder = ts.createSemanticDiagnosticsBuilderProgram(rootNames, COMPILER_OPTIONS, host, this.builder);
    this.builder = builder;
    const present = new Set(o.modules.map((m) => m.file));
    for (const f of this.modules.keys()) if (!present.has(f)) this.modules.delete(f);
    const inference = new Inference(builder.getProgram(), o, builder, this.modules);
    const result = inference.run();
    this.last = inference.keys;
    return result;
  }
}

/** `sf` (a module) declares into the global scope or into another module. */
function augments(sf: ts.SourceFile): boolean {
  return sf.statements.some((st) => ts.isModuleDeclaration(st) && (!!(st.flags & ts.NodeFlags.GlobalAugmentation) || ts.isStringLiteral(st.name)));
}

// Gives the inference program the documents of the data model, to recognise them in return types.
const DOCS_PROBE = `import type { DataModel } from "./server";
export type __EmberDocs = { [K in keyof DataModel]: DataModel[K]["document"] };
`;

function documentTypes(program: ts.Program, c: ts.TypeChecker, generatedDir: string): Map<string, ts.Type> {
  const out = new Map<string, ts.Type>();
  const sf = program.getSourceFile(resolve(generatedDir, "__ember_docs.ts"));
  const mod = sf && c.getSymbolAtLocation(sf);
  const alias = mod && c.getExportsOfModule(mod).find((s) => s.getName() === "__EmberDocs");
  if (!alias) return out;
  const t = c.getDeclaredTypeOfSymbol(alias);
  for (const p of c.getPropertiesOfType(t)) out.set(p.getName(), c.getTypeOfSymbol(p));
  return out;
}

class Inference {
  private readonly checker: ts.TypeChecker;
  private readonly printer: TypePrinter;
  private readonly program: ts.Program;
  private readonly o: InferOptions;
  private readonly builder: ts.SemanticDiagnosticsBuilderProgram;
  private readonly cache: Map<string, ModuleCache>;
  private readonly versions = new Map<string, string>();
  /** Versions every module's results depend on: the files outside any import graph (global scripts) and the data model. */
  private readonly sharedKey: string;
  /** Each module's dependency key (its diagnostics depend on nothing else). */
  readonly keys: Array<{ file: string; key: string }> = [];
  constructor(program: ts.Program, o: InferOptions, builder: ts.SemanticDiagnosticsBuilderProgram, cache: Map<string, ModuleCache>) {
    this.program = program;
    this.o = o;
    this.builder = builder;
    this.cache = cache;
    this.checker = program.getTypeChecker();
    this.printer = new TypePrinter(this.checker, program, o, () => documentTypes(program, this.checker, o.generatedDir));
    const globals: string[] = [];
    for (const sf of program.getSourceFiles()) {
      const v = (sf as VersionedSourceFile).version ?? "";
      this.versions.set(sf.fileName, v);
      // Global scripts, and modules that augment the global scope or another module (`declare global { ... }`,
      // `declare module "x" { ... }`): a module may use what they declare without importing them.
      if (!program.isSourceFileDefaultLibrary(sf) && (!ts.isExternalModule(sf) || augments(sf))) globals.push(`${sf.fileName}@${v}`);
    }
    const docs = program.getSourceFile(resolve(o.generatedDir, "__ember_docs.ts"));
    this.sharedKey = `${globals.join(",")}|${docs ? this.dependencyKey(docs) : ""}|${o.generatedDir}|${o.projectDir}`;
  }

  /** The versions of `sf` and of everything it imports, transitively (TypeScript's reference graph). */
  private dependencyKey(sf: ts.SourceFile): string {
    return this.builder
      .getAllDependencies(sf)
      .map((f) => this.versions.get(f) ?? `?${f}`)
      .join(",");
  }

  run(): InferResult {
    const functions = new Map<string, FunctionTypeInfo>();
    const inferred: string[] = [];
    for (const m of this.o.modules) {
      const sf = this.program.getSourceFile(m.file);
      if (!sf) {
        this.cache.delete(m.file);
        continue;
      }
      const deps = `${this.sharedKey}|${this.dependencyKey(sf)}`;
      this.keys.push({ file: m.file, key: deps });
      const asked = [...this.o.wanted].filter((n) => n.startsWith(`${m.path}:`));
      const key = `${deps}|${m.path}|${asked.map((n) => `${n}${this.o.inferReturns.has(n) ? "+" : ""}`).join(",")}`;
      const before = this.printer.trail;
      const hit = this.cache.get(m.file);
      if (hit && hit.key === key && hit.before === before) {
        this.printer.adopt(hit.named);
        for (const [name, info] of hit.functions) functions.set(name, info);
        continue;
      }
      inferred.push(m.path);
      this.printer.docs();
      const mark = this.printer.mark();
      const own = this.inferModule(m, sf);
      for (const [name, info] of own) functions.set(name, info);
      this.cache.set(m.file, { key, before, functions: own, named: this.printer.since(mark) });
    }
    return { functions, named: this.printer.namedTypes(), inferred };
  }

  private inferModule(m: { path: string; file: string }, sf: ts.SourceFile): Array<[string, FunctionTypeInfo]> {
    const out: Array<[string, FunctionTypeInfo]> = [];
    const c = this.checker;
    const modSym = c.getSymbolAtLocation(sf);
    if (!modSym) return out;
    for (const exported of c.getExportsOfModule(modSym)) {
      const name = `${m.path}:${exported.getName()}`;
      if (!this.o.wanted.has(name)) continue;
      const sym = exported.flags & ts.SymbolFlags.Alias ? c.getAliasedSymbol(exported) : exported;
      const decl = sym.valueDeclaration ?? sym.declarations?.[0];
      const info: FunctionTypeInfo = { returns: "unknown", errors: [], doc: docOf(c, exported, sym), source: null };
      if (decl) {
        const nameNode = ts.isVariableDeclaration(decl) || ts.isFunctionDeclaration(decl) ? decl.name : undefined;
        const at = nameNode ?? decl;
        const pos = at.getSourceFile().getLineAndCharacterOfPosition(at.getStart());
        info.source = { file: at.getSourceFile().fileName, line: pos.line, character: pos.character };
      }
      if (this.o.inferReturns.has(name)) {
        const t = c.getTypeOfSymbolAtLocation(sym, sf);
        const ret = registeredReturnType(c, t);
        info.returns = ret ? this.printer.print(ret, "", true) : "unknown";
        if (ret && ret.flags & ts.TypeFlags.Any) info.problem = "is `any`";
        else if (/\bany\b/.test(info.returns)) info.problem = "contains `any`";
        else if (info.returns === "unknown") info.problem = "could not be inferred (`unknown`)";
      }
      const handlers = decl ? handlersOf(c, decl) : [];
      if (handlers.length) {
        const walker = new ErrorWalker(c, this.o.projectDir);
        info.errors = [...new Set(handlers.flatMap((h) => [...walker.errorsOf(h)]))].sort();
      }
      out.push([name, info]);
    }
    return out;
  }
}

export function formatDiagnostic(d: ts.Diagnostic): string {
  const msg = ts.flattenDiagnosticMessageText(d.messageText, "\n");
  if (!d.file || d.start === undefined) return msg;
  const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
  return `${d.file.fileName}:${line + 1}:${character + 1} ${msg}`;
}

/** JSDoc of an export (its comment and tags), as plain lines. */
function docOf(c: ts.TypeChecker, exported: ts.Symbol, sym: ts.Symbol): string[] {
  const s = exported.getDocumentationComment(c).length || exported.getJsDocTags(c).length ? exported : sym;
  const text = ts.displayPartsToString(s.getDocumentationComment(c)).trim();
  const lines = text ? text.split("\n") : [];
  for (const tag of s.getJsDocTags(c)) {
    const t = tag.text ? ts.displayPartsToString(tag.text) : "";
    lines.push(`@${tag.name}${t ? ` ${t}` : ""}`);
  }
  return lines;
}

/** `RegisteredFunction<Type, Vis, Args, Ret, Errs>` → Ret. */
function registeredReturnType(checker: ts.TypeChecker, t: ts.Type): ts.Type | undefined {
  if ((t as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) {
    const args = checker.getTypeArguments(t as ts.TypeReference);
    if (args.length >= 4 && t.getProperty("__returns")) return args[3];
  }
  const prop = t.getProperty("__returns");
  if (!prop) return undefined;
  const pt = checker.getTypeOfSymbol(prop);
  if (pt.isUnion()) {
    const rest = pt.types.filter((x) => !(x.flags & ts.TypeFlags.Undefined));
    if (rest.length === 1) return rest[0];
  }
  return pt;
}

const unwrap = (e: ts.Expression): ts.Expression => {
  while (ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
  return e;
};

/**
 * The handler of `export const f = query({ handler })` / `query((ctx) => ...)`, followed by the handlers of the
 * middlewares its builder has (`const authed = mutation.use(...)`, `authed.use(...)`, inline `mutation.use(mw)({...})`).
 */
function handlersOf(c: ts.TypeChecker, decl: ts.Declaration): ts.Node[] {
  if (!ts.isVariableDeclaration(decl) || !decl.initializer) return [];
  const init = unwrap(decl.initializer);
  if (!ts.isCallExpression(init)) return [];
  const out: ts.Node[] = [];
  const own = handlerOf(init);
  if (own) out.push(own);
  // A query's `authorize` (the per-caller check) throws the function's errors too.
  const check = handlerOf(init, "authorize");
  if (check) out.push(check);
  const seen = new Set<ts.Node>();
  // Walk the builder expression back through `.use(...)` calls and the variables holding them.
  let b: ts.Expression | undefined = unwrap(init.expression);
  for (let depth = 0; b && depth < 16; depth++) {
    if (seen.has(b)) break;
    seen.add(b);
    if (ts.isCallExpression(b) && ts.isPropertyAccessExpression(b.expression) && b.expression.name.text === "use") {
      const mw = handlerOf(b);
      if (mw) out.push(mw);
      b = unwrap(b.expression.expression);
      continue;
    }
    if (ts.isIdentifier(b)) {
      let sym = c.getSymbolAtLocation(b);
      if (sym && sym.flags & ts.SymbolFlags.Alias) sym = c.getAliasedSymbol(sym);
      const d = sym?.valueDeclaration;
      b = d && ts.isVariableDeclaration(d) && d.initializer ? unwrap(d.initializer) : undefined;
      continue;
    }
    break;
  }
  return out;
}

/** The handler given to a builder call (or to `.use()`): a function, or `{ handler }` (or another field: `authorize`). */
function handlerOf(init: ts.CallExpression, field = "handler"): ts.Node | undefined {
  const arg = init.arguments[0];
  if (!arg) return undefined;
  if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) return field === "handler" ? arg : undefined;
  if (ts.isObjectLiteralExpression(arg)) {
    for (const p of arg.properties) {
      if (p.name && ts.isIdentifier(p.name) && p.name.text === field) {
        if (ts.isMethodDeclaration(p)) return p;
        if (ts.isPropertyAssignment(p)) return p.initializer;
      }
    }
  }
  return undefined;
}

/**
 * Which application errors a handler may throw, from the types: a call or `new` whose type is an `AppError<"X", D>`
 * (`errors.X(...)`), `ctx.fail.X(...)`, and the `_errors` of the references it calls through `ctx.runQuery`,
 * `ctx.runMutation` and `ctx.runAction`. It follows calls into functions of the project (`lib/` helpers), and skips
 * what a `try` catches without rethrowing. Best effort by design: declare `errors:` to make it a checked contract.
 */
class ErrorWalker {
  private readonly seen = new Set<ts.Node>();
  private readonly c: ts.TypeChecker;
  private readonly projectDir: string;
  constructor(c: ts.TypeChecker, projectDir: string) {
    this.c = c;
    this.projectDir = projectDir;
  }

  errorsOf(fn: ts.Node, depth = 0): Set<string> {
    const out = new Set<string>();
    if (this.seen.has(fn) || depth > 8) return out;
    this.seen.add(fn);
    const visit = (n: ts.Node, caught: boolean) => {
      if (ts.isTryStatement(n)) {
        const rethrows = !!n.catchClause && containsThrow(n.catchClause.block);
        visit(n.tryBlock, caught || (!!n.catchClause && !rethrows));
        if (n.catchClause) visit(n.catchClause.block, caught);
        if (n.finallyBlock) visit(n.finallyBlock, caught);
        return;
      }
      if (!caught && (ts.isCallExpression(n) || ts.isNewExpression(n))) {
        for (const code of this.appErrorCodes(this.c.getTypeAtLocation(n))) out.add(code);
        if (ts.isCallExpression(n)) {
          const callee = n.expression;
          if (ts.isPropertyAccessExpression(callee)) {
            const method = callee.name.text;
            if ((method === "runQuery" || method === "runMutation" || method === "runAction") && n.arguments[0]) {
              for (const code of this.referenceErrors(this.c.getTypeAtLocation(n.arguments[0]))) out.add(code);
            }
            // ctx.fail.X(data): a `fail` member whose X returns never (the callers keep only codes defineErrors knows).
            if (ts.isPropertyAccessExpression(callee.expression) && callee.expression.name.text === "fail" && this.c.getTypeAtLocation(n).flags & ts.TypeFlags.Never) out.add(method);
          }
          for (const decl of this.projectDeclarations(callee)) {
            const body = functionBody(decl);
            if (body) for (const code of this.errorsOf(body, depth + 1)) out.add(code);
          }
        }
      }
      ts.forEachChild(n, (child) => visit(child, caught));
    };
    visit(fn, false);
    return out;
  }

  /** `AppError<"X", D>` (or a union of them) → ["X"]. */
  private appErrorCodes(t: ts.Type): string[] {
    const types = t.isUnion() ? t.types : [t];
    const out: string[] = [];
    for (const m of types) {
      const kind = m.getProperty("kind");
      const code = m.getProperty("code");
      if (!kind || !code) continue;
      const kt = this.c.getTypeOfSymbol(kind);
      const ct = this.c.getTypeOfSymbol(code);
      if (kt.isStringLiteral() && kt.value === "app" && ct.isStringLiteral()) out.push(ct.value);
    }
    return out;
  }

  /** The codes in a reference's `_errors` (`ErrorSpec` union). */
  private referenceErrors(t: ts.Type): string[] {
    const p = t.getProperty("_errors");
    if (!p) return [];
    const et = this.c.getNonNullableType(this.c.getTypeOfSymbol(p));
    const out: string[] = [];
    for (const m of et.isUnion() ? et.types : [et]) {
      const code = m.getProperty("code");
      const ct = code && this.c.getTypeOfSymbol(code);
      if (ct?.isStringLiteral()) out.push(ct.value);
    }
    return out;
  }

  /** Declarations of the called function when it lives in the project (not a library, not generated code). */
  private projectDeclarations(callee: ts.Expression): ts.Declaration[] {
    let sym = this.c.getSymbolAtLocation(ts.isPropertyAccessExpression(callee) ? callee.name : callee);
    if (sym && sym.flags & ts.SymbolFlags.Alias) sym = this.c.getAliasedSymbol(sym);
    return (sym?.declarations ?? []).filter((d) => {
      const f = d.getSourceFile().fileName;
      const rel = relative(this.projectDir, f);
      return !rel.startsWith("..") && !isAbsolute(rel) && !rel.includes("node_modules") && !rel.split(/[\\/]/).includes("_generated");
    });
  }
}

function containsThrow(n: ts.Node): boolean {
  let found = false;
  const visit = (x: ts.Node) => {
    if (found) return;
    if (ts.isThrowStatement(x)) found = true;
    else if (!ts.isFunctionLike(x)) ts.forEachChild(x, visit);
  };
  visit(n);
  return found;
}

function functionBody(d: ts.Declaration): ts.Node | undefined {
  if (ts.isFunctionDeclaration(d) || ts.isMethodDeclaration(d) || ts.isFunctionExpression(d) || ts.isArrowFunction(d)) return d.body;
  if (ts.isVariableDeclaration(d) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) return d.initializer.body;
  return undefined;
}

// ------------------------------------------------------------------------------------------------ printing

const MAX_DEPTH = 16;

class TypePrinter {
  private readonly stack = new Set<ts.Type>();
  /** Named types by declaration (fully qualified name; `gen:<name>` for the ones of _generated/types.d.ts). */
  private readonly named = new Map<string, NamedType>();
  private readonly usedNames = new Set<string>();
  /** The named types defined so far, in order: what the printing of the next module depends on. */
  trail = "";
  private readonly checker: ts.TypeChecker;
  private readonly program: ts.Program;
  private readonly o: Pick<InferOptions, "generatedDir" | "projectDir">;
  private readonly docsOf: () => Map<string, ts.Type>;
  private docsCache: Map<string, ts.Type> | undefined;
  /**
   * Print every type structurally, for a file that imports nothing: no names from the user's modules, and none of the
   * helpers of the generated files (`Id<"t">`, `FileId`, `Doc<"t">`, `PaginationResult<X>`) either.
   */
  private readonly inline: boolean;
  /** An `any` was printed (or is inside a type printed by the compiler). */
  sawAny = false;
  constructor(checker: ts.TypeChecker, program: ts.Program, o: Pick<InferOptions, "generatedDir" | "projectDir">, docs: () => Map<string, ts.Type>, inline = false) {
    this.checker = checker;
    this.program = program;
    this.o = o;
    this.docsOf = docs;
    this.inline = inline;
  }

  /** `t` is exactly the document type of a table (both ways assignable). */
  private documentOf(t: ts.Type): string | undefined {
    const id = t.getProperty("_id");
    if (!id || !t.getProperty("_creationTime")) return undefined;
    const brand = this.checker.getTypeOfSymbol(id);
    const parts = brand.isIntersection() ? brand.types : [brand];
    const tag = parts.find((m) => m.getProperty("__tableName"));
    const table = tag && this.checker.getTypeOfSymbol(tag.getProperty("__tableName")!);
    if (!table?.isStringLiteral()) return undefined;
    const doc = this.docs().get(table.value);
    if (!doc) return undefined;
    return this.checker.isTypeAssignableTo(t, doc) && this.checker.isTypeAssignableTo(doc, t) ? table.value : undefined;
  }

  /** The document type of each table (resolved on first use: a pass that infers nothing does not check the schema). */
  docs(): Map<string, ts.Type> {
    return (this.docsCache ??= this.docsOf());
  }

  namedTypes(): NamedType[] {
    return [...this.named.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  private define(key: string, entry: NamedType) {
    this.named.set(key, entry);
    this.usedNames.add(entry.name);
    this.trail += `${key}\u0000${entry.name}\n`;
  }

  mark(): number {
    return this.named.size;
  }

  /** The named types defined after `mark`. */
  since(mark: number): Array<[string, NamedType]> {
    return [...this.named].slice(mark);
  }

  /** Defines named types a cached module's printing defined (as that printing would). */
  adopt(entries: Array<[string, NamedType]>) {
    for (const [key, entry] of entries) this.define(key, entry);
  }

  print(t: ts.Type, indent: string, top = false): string {
    const F = ts.TypeFlags;
    const f = t.flags;
    if (f & F.Any) {
      this.sawAny = true;
      return "any";
    }
    if (f & F.Unknown) return "unknown";
    if (f & F.Never) return "never";
    // Over the wire, `undefined` (a handler that returns nothing) arrives as null.
    if (f & (F.Void | F.Undefined)) return top ? "null" : "undefined";
    if (f & F.Null) return "null";
    if (f & F.String) return "string";
    if (f & F.Number) return "number";
    if (f & F.Boolean) return "boolean";
    if (f & F.BigInt) return "bigint";
    if (f & F.ESSymbol) return "symbol";
    if (t.isStringLiteral()) return JSON.stringify(t.value);
    if (t.isNumberLiteral()) return String(t.value);
    if (f & F.BigIntLiteral) {
      const v = (t as ts.BigIntLiteralType).value;
      return `${v.negative ? "-" : ""}${v.base10Value}n`;
    }
    if (f & F.BooleanLiteral) return (t as unknown as { intrinsicName: string }).intrinsicName;
    const named = this.namedReference(t);
    if (named) return named;
    if (this.stack.size > MAX_DEPTH || this.stack.has(t)) return "unknown";
    this.stack.add(t);
    try {
      return this.printStructured(t, indent, top);
    } finally {
      this.stack.delete(t);
    }
  }

  /**
   * A type alias or interface exported by one of the user's modules (non-generic) is printed by name and defined once
   * in `_generated/types.d.ts`.
   */
  private namedReference(t: ts.Type): string | undefined {
    if (this.inline) return undefined;
    const sym = t.aliasSymbol ?? (t.flags & ts.TypeFlags.Object && (t as ts.ObjectType).objectFlags & ts.ObjectFlags.Interface ? t.getSymbol() : undefined);
    if (!sym || (t.aliasTypeArguments?.length ?? 0) > 0) return undefined;
    const decl = sym.declarations?.[0];
    if (!decl || !(ts.isTypeAliasDeclaration(decl) || ts.isInterfaceDeclaration(decl)) || decl.typeParameters?.length) return undefined;
    const sf = decl.getSourceFile();
    // Already a generated name (a callee's result, through api.d.ts): keep it.
    if (resolve(sf.fileName) === resolve(this.o.generatedDir, "types.d.ts")) {
      const n = sym.getName();
      if (!this.usedNames.has(n)) {
        const entry: NamedType = { name: n, text: "unknown" };
        this.define(`gen:${n}`, entry);
        this.stack.add(t);
        try {
          entry.text = this.printStructured(t, "", false);
        } finally {
          this.stack.delete(t);
        }
      }
      return n;
    }
    const rel = relative(this.o.projectDir, sf.fileName);
    if (rel.startsWith("..") || isAbsolute(rel) || rel.split(/[\\/]/).includes("_generated") || rel.includes("node_modules")) return undefined;
    if (!ts.getCombinedModifierFlags(decl) || !(ts.getCombinedModifierFlags(decl) & ts.ModifierFlags.Export)) return undefined;
    const key = this.checker.getFullyQualifiedName(sym);
    const hit = this.named.get(key);
    if (hit) return hit.name;
    let name = sym.getName();
    if (this.usedNames.has(name)) name = `${rel.replace(/\.[a-z]+$/, "").replace(/[^A-Za-z0-9]+/g, "_")}_${name}`;
    const entry: NamedType = { name, text: "unknown" };
    this.define(key, entry);
    this.stack.add(t);
    try {
      entry.text = this.printStructured(t, "", false);
    } finally {
      this.stack.delete(t);
    }
    return name;
  }

  private printStructured(t: ts.Type, indent: string, top: boolean): string {
    const c = this.checker;
    if (t.isUnion()) return this.printUnion(t.types, indent, top);
    if (t.isIntersection()) {
      // GenericId<T> = string & { __tableName: T }; FileId = string & { __file: true }.
      const brand = !this.inline && t.types.find((m) => m.getProperty("__tableName"));
      if (brand && t.types.some((m) => m.flags & ts.TypeFlags.String)) {
        const table = c.getTypeOfSymbol(brand.getProperty("__tableName")!);
        return `Id<${this.print(table, indent)}>`;
      }
      if (!this.inline && t.types.some((m) => m.getProperty("__file")) && t.types.some((m) => m.flags & ts.TypeFlags.String)) return "FileId";
      return t.types.map((m) => this.wrap(m, indent)).join(" & ");
    }
    if (c.isTupleType(t)) {
      const elems = c.getTypeArguments(t as ts.TypeReference);
      const flags = ((t as ts.TypeReference).target as ts.TupleType).elementFlags ?? [];
      return `[${elems
        .map((e, i) => {
          const fl = flags[i] ?? ts.ElementFlags.Required;
          const s = this.print(e, indent);
          return fl & ts.ElementFlags.Rest ? `...${this.wrap(e, indent)}[]` : fl & ts.ElementFlags.Optional ? `${s}?` : s;
        })
        .join(", ")}]`;
    }
    if (c.isArrayType(t)) {
      const [elem] = c.getTypeArguments(t as ts.TypeReference);
      return elem ? `${this.wrap(elem, indent)}[]` : "unknown[]";
    }
    if (t.flags & ts.TypeFlags.Object) {
      if (this.isLibType(t)) return this.compilerText(t);
      const doc = !this.inline && this.documentOf(t);
      if (doc) return `Doc<${JSON.stringify(doc)}>`;
      if (t.getCallSignatures().length || t.getConstructSignatures().length) return "unknown";
      const inner = indent + "  ";
      const lines: string[] = [];
      const props: Array<[string, string]> = [];
      for (const info of c.getIndexInfosOfType(t)) {
        lines.push(`${inner}[key: ${this.print(info.keyType, inner)}]: ${this.print(info.type, inner)};`);
      }
      for (const p of c.getPropertiesOfType(t)) {
        const optional = (p.flags & ts.SymbolFlags.Optional) !== 0;
        let pt = c.getTypeOfSymbol(p);
        if (optional && pt.isUnion()) {
          const rest = pt.types.filter((x) => !(x.flags & ts.TypeFlags.Undefined));
          pt = rest.length === 1 ? rest[0]! : pt;
          if (rest.length > 1) {
            const s = this.printUnion(rest, inner, false);
            lines.push(`${inner}${propName(p.getName())}?: ${s};`);
            props.push([p.getName(), s]);
            continue;
          }
        }
        if (pt.getCallSignatures().length && !(pt.flags & ts.TypeFlags.Union)) continue; // methods are not data
        const s = this.print(pt, inner);
        lines.push(`${inner}${propName(p.getName())}${optional ? "?" : ""}: ${s};`);
        props.push([p.getName(), s]);
      }
      const text = lines.length ? `{\n${lines.join("\n")}\n${indent}}` : "{}";
      // A page of `.paginate()` → PaginationResult<item>.
      if (!this.inline && props.length === 3 && props.every(([k]) => k === "page" || k === "isDone" || k === "continueCursor")) {
        const page = props.find(([k]) => k === "page")![1];
        const cursor = props.find(([k]) => k === "continueCursor")![1];
        if (page.endsWith("[]") && cursor === "string") return `PaginationResult<${page.slice(0, -2).replace(/^\((.*)\)$/s, "$1")}>`;
      }
      return text;
    }
    return this.compilerText(t);
  }

  /** The compiler's own text for `t` (a built-in type, something not printed structurally); notes an `any` inside. */
  private compilerText(t: ts.Type): string {
    if (this.hasAny(t, 0)) this.sawAny = true;
    return this.checker.typeToString(t, undefined, ts.TypeFormatFlags.NoTruncation);
  }

  private hasAny(t: ts.Type, depth: number): boolean {
    if (t.flags & ts.TypeFlags.Any) return true;
    if (depth > MAX_DEPTH) return false;
    if (t.isUnionOrIntersection()) return t.types.some((m) => this.hasAny(m, depth + 1));
    const args = [...(t.aliasTypeArguments ?? []), ...(t.flags & ts.TypeFlags.Object && (t as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference ? this.checker.getTypeArguments(t as ts.TypeReference) : [])];
    return args.some((a) => this.hasAny(a, depth + 1));
  }

  private printUnion(types: readonly ts.Type[], indent: string, top: boolean): string {
    const parts: string[] = [];
    const bools = types.filter((m) => m.flags & ts.TypeFlags.BooleanLiteral);
    for (const m of types) {
      if (m.flags & ts.TypeFlags.BooleanLiteral) {
        if (bools.length === 2) {
          if (m === bools[0]) parts.push("boolean");
        } else parts.push(this.print(m, indent));
      } else if (top && m.flags & (ts.TypeFlags.Void | ts.TypeFlags.Undefined)) parts.push("null");
      else parts.push(this.print(m, indent));
    }
    // Sorted: the compiler orders a union by when it created each member's type, which depends on what it checked
    // before (an incremental run checks less than a full one); the printed order must not. `null` last reads better
    // in a hover (`Doc<"rooms"> | null`).
    const uniq = [...new Set(parts)];
    const nullish = (p: string) => p === "null" || p === "undefined";
    return [...uniq.filter((p) => !nullish(p)).sort(byText), ...uniq.filter(nullish).sort(byText)].join(" | ");
  }

  /** Parenthesizes unions/intersections inside arrays and intersections. */
  private wrap(t: ts.Type, indent: string): string {
    const s = this.print(t, indent);
    return (t.isUnion() || t.isIntersection()) && !/^(Id|Doc)<"[^"]*">$|^FileId$/.test(s) ? `(${s})` : s;
  }

  /** Built-in types (Uint8Array, Date, Map...) are printed by name. */
  private isLibType(t: ts.Type): boolean {
    const decls = (t.aliasSymbol ?? t.getSymbol())?.getDeclarations() ?? [];
    return decls.length > 0 && decls.every((d) => this.program.isSourceFileDefaultLibrary(d.getSourceFile()));
  }
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const propName = (k: string) => (IDENT.test(k) ? k : JSON.stringify(k));

/** Path of `file` relative to `from`'s directory, for source maps. */
export const relativeTo = (fromFile: string, file: string) => relative(dirname(fromFile), file).split("\\").join("/");
