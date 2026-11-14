// The type oracle of `ember codegen` (docs/design/dx.md §3.5): the TypeScript compiler reads the user's modules and
// tells, for each exported function, its return type (printed as a self-contained type, so client code never
// type-checks server code), the application errors it may throw (inferred from the handler), its JSDoc and where it is
// declared (for the declaration map: Go to Definition from `api.x.y` lands on the handler).
//
// The generated files the modules import (`_generated/api.d.ts`, ...) are served from memory: codegen iterates until
// the printed api no longer changes (a function returning `ctx.runQuery(internal.x.y)` needs `x.y`'s type first).
// The program is kept between runs (`ember dev`), so a save re-checks incrementally.

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
  /** Collect semantic diagnostics of the user's modules (only the last iteration needs them). */
  diagnostics?: boolean;
}

export interface InferResult {
  functions: Map<string, FunctionTypeInfo>;
  /** Types exported by the user's modules that the printed types refer to by name (→ `_generated/types.d.ts`). */
  named: NamedType[];
  /** Type errors in the user's modules (codegen still succeeds; printed as warnings). */
  diagnostics: string[];
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

/** Keeps the TypeScript program between runs (incremental re-checks in `ember dev`). */
export class TypeOracle {
  private program: ts.Program | undefined;
  private readonly cache = new Map<string, { text: string; sf: ts.SourceFile }>();

  infer(o: InferOptions): InferResult {
    const host = ts.createCompilerHost(COMPILER_OPTIONS, true);
    const read = host.readFile.bind(host);
    const exists = host.fileExists.bind(host);
    const getSf = host.getSourceFile.bind(host);
    const virtual = new Map([...o.virtualFiles].map(([k, v]) => [resolve(k), v]));
    host.fileExists = (f) => virtual.has(resolve(f)) || exists(f);
    host.readFile = (f) => virtual.get(resolve(f)) ?? read(f);
    host.getSourceFile = (f, lang, onError, create) => {
      const text = virtual.get(resolve(f)) ?? read(f);
      if (text === undefined) return getSf(f, lang, onError, create);
      const key = resolve(f);
      const hit = this.cache.get(key);
      if (hit && hit.text === text) return hit.sf;
      const sf = ts.createSourceFile(f, text, lang, true);
      this.cache.set(key, { text, sf });
      return sf;
    };
    const docsFile = resolve(o.generatedDir, "__ember_docs.ts");
    virtual.set(docsFile, DOCS_PROBE);
    const program = ts.createProgram({ rootNames: [...o.modules.map((m) => m.file), docsFile], options: COMPILER_OPTIONS, host, ...(this.program ? { oldProgram: this.program } : {}) });
    this.program = program;
    return new Inference(program, o).run();
  }
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
  constructor(program: ts.Program, o: InferOptions) {
    this.program = program;
    this.o = o;
    this.checker = program.getTypeChecker();
    this.printer = new TypePrinter(this.checker, program, o, documentTypes(program, this.checker, o.generatedDir));
  }

  run(): InferResult {
    const functions = new Map<string, FunctionTypeInfo>();
    const c = this.checker;
    for (const m of this.o.modules) {
      const sf = this.program.getSourceFile(m.file);
      const modSym = sf && c.getSymbolAtLocation(sf);
      if (!sf || !modSym) continue;
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
        functions.set(name, info);
      }
    }
    const diagnostics = this.o.diagnostics
      ? this.o.modules.flatMap((m) => {
          const sf = this.program.getSourceFile(m.file);
          return sf ? [...this.program.getSyntacticDiagnostics(sf), ...this.program.getSemanticDiagnostics(sf)].map((d) => formatDiagnostic(d)) : [];
        })
      : [];
    return { functions, named: this.printer.namedTypes(), diagnostics };
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
  private readonly named = new Map<ts.Symbol, NamedType>();
  private readonly usedNames = new Set<string>();
  private readonly checker: ts.TypeChecker;
  private readonly program: ts.Program;
  private readonly o: InferOptions;
  private readonly docs: Map<string, ts.Type>;
  constructor(checker: ts.TypeChecker, program: ts.Program, o: InferOptions, docs: Map<string, ts.Type>) {
    this.checker = checker;
    this.program = program;
    this.o = o;
    this.docs = docs;
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
    const doc = this.docs.get(table.value);
    if (!doc) return undefined;
    return this.checker.isTypeAssignableTo(t, doc) && this.checker.isTypeAssignableTo(doc, t) ? table.value : undefined;
  }

  namedTypes(): NamedType[] {
    return [...this.named.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  print(t: ts.Type, indent: string, top = false): string {
    const F = ts.TypeFlags;
    const f = t.flags;
    if (f & F.Any) return "any";
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
    const sym = t.aliasSymbol ?? (t.flags & ts.TypeFlags.Object && (t as ts.ObjectType).objectFlags & ts.ObjectFlags.Interface ? t.getSymbol() : undefined);
    if (!sym || (t.aliasTypeArguments?.length ?? 0) > 0) return undefined;
    const decl = sym.declarations?.[0];
    if (!decl || !(ts.isTypeAliasDeclaration(decl) || ts.isInterfaceDeclaration(decl)) || decl.typeParameters?.length) return undefined;
    const sf = decl.getSourceFile();
    // Already a generated name (a callee's result, through api.d.ts): keep it.
    if (resolve(sf.fileName) === resolve(this.o.generatedDir, "types.d.ts")) {
      const n = sym.getName();
      if (!this.usedNames.has(n)) {
        this.usedNames.add(n);
        const entry: NamedType = { name: n, text: "unknown" };
        this.named.set(sym, entry);
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
    const hit = this.named.get(sym);
    if (hit) return hit.name;
    let name = sym.getName();
    if (this.usedNames.has(name)) name = `${rel.replace(/\.[a-z]+$/, "").replace(/[^A-Za-z0-9]+/g, "_")}_${name}`;
    this.usedNames.add(name);
    const entry: NamedType = { name, text: "unknown" };
    this.named.set(sym, entry);
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
      const brand = t.types.find((m) => m.getProperty("__tableName"));
      if (brand && t.types.some((m) => m.flags & ts.TypeFlags.String)) {
        const table = c.getTypeOfSymbol(brand.getProperty("__tableName")!);
        return `Id<${this.print(table, indent)}>`;
      }
      if (t.types.some((m) => m.getProperty("__file")) && t.types.some((m) => m.flags & ts.TypeFlags.String)) return "FileId";
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
      if (this.isLibType(t)) return c.typeToString(t, undefined, ts.TypeFormatFlags.NoTruncation);
      const doc = this.documentOf(t);
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
      if (props.length === 3 && props.every(([k]) => k === "page" || k === "isDone" || k === "continueCursor")) {
        const page = props.find(([k]) => k === "page")![1];
        const cursor = props.find(([k]) => k === "continueCursor")![1];
        if (page.endsWith("[]") && cursor === "string") return `PaginationResult<${page.slice(0, -2).replace(/^\((.*)\)$/s, "$1")}>`;
      }
      return text;
    }
    return c.typeToString(t, undefined, ts.TypeFormatFlags.NoTruncation);
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
    // `null` last reads better in a hover (`Doc<"rooms"> | null`).
    const uniq = [...new Set(parts)];
    return [...uniq.filter((p) => p !== "null" && p !== "undefined"), ...uniq.filter((p) => p === "null" || p === "undefined")].join(" | ");
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

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const propName = (k: string) => (IDENT.test(k) ? k : JSON.stringify(k));

/** Path of `file` relative to `from`'s directory, for source maps. */
export const relativeTo = (fromFile: string, file: string) => relative(dirname(fromFile), file).split("\\").join("/");
