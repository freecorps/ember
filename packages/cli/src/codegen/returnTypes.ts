// Static return types for functions without a `returns` validator (PLAN §11): the TypeScript compiler API infers
// each handler's return type from the user's modules, and we print it as a self-contained type (no imports), so
// client code never type-checks server code.

import ts from "typescript";

export interface InferOptions {
  /** Module path → absolute file. */
  modules: Array<{ path: string; file: string }>;
  /** Only these `"mod:fn"` names are inferred. */
  wanted: Set<string>;
}

export interface InferResult {
  types: Map<string, string>;
  /** Type errors in the user's modules (codegen still succeeds; printed as warnings). */
  diagnostics: string[];
}

const COMPILER_OPTIONS: ts.CompilerOptions = {
  strict: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowImportingTsExtensions: true,
  noEmit: true,
  skipLibCheck: true,
  types: [],
  lib: ["lib.es2023.d.ts", "lib.dom.d.ts"],
};

export function inferReturnTypes({ modules, wanted }: InferOptions): InferResult {
  const types = new Map<string, string>();
  if (!wanted.size) return { types, diagnostics: [] };
  const program = ts.createProgram(
    modules.map((m) => m.file),
    COMPILER_OPTIONS,
  );
  const checker = program.getTypeChecker();
  const printer = new TypePrinter(checker, program);
  for (const m of modules) {
    const sf = program.getSourceFile(m.file);
    const modSym = sf && checker.getSymbolAtLocation(sf);
    if (!sf || !modSym) continue;
    for (let exp of checker.getExportsOfModule(modSym)) {
      const name = `${m.path}:${exp.getName()}`;
      if (!wanted.has(name)) continue;
      if (exp.flags & ts.SymbolFlags.Alias) exp = checker.getAliasedSymbol(exp);
      const t = checker.getTypeOfSymbolAtLocation(exp, sf);
      const ret = registeredReturnType(checker, t);
      types.set(name, ret ? printer.print(ret, "", true) : "unknown");
    }
  }
  const diagnostics = ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.file && modules.some((m) => m.file === d.file!.fileName))
    .map((d) => formatDiagnostic(d));
  return { types, diagnostics };
}

export function formatDiagnostic(d: ts.Diagnostic): string {
  const msg = ts.flattenDiagnosticMessageText(d.messageText, "\n");
  if (!d.file || d.start === undefined) return msg;
  const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
  return `${d.file.fileName}:${line + 1}:${character + 1} ${msg}`;
}

/** `RegisteredFunction<Type, Vis, Args, Ret>` → Ret. */
function registeredReturnType(checker: ts.TypeChecker, t: ts.Type): ts.Type | undefined {
  if ((t as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) {
    const args = checker.getTypeArguments(t as ts.TypeReference);
    if (args.length === 4 && t.getProperty("__returns")) return args[3];
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

const MAX_DEPTH = 16;

class TypePrinter {
  private readonly stack = new Set<ts.Type>();
  private readonly checker: ts.TypeChecker;
  private readonly program: ts.Program;
  constructor(checker: ts.TypeChecker, program: ts.Program) {
    this.checker = checker;
    this.program = program;
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
    if (this.stack.size > MAX_DEPTH || this.stack.has(t)) return "unknown";
    this.stack.add(t);
    try {
      return this.printStructured(t, indent, top);
    } finally {
      this.stack.delete(t);
    }
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
      if (t.getCallSignatures().length || t.getConstructSignatures().length) return "unknown";
      const inner = indent + "  ";
      const lines: string[] = [];
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
            lines.push(`${inner}${propName(p.getName())}?: ${this.printUnion(rest, inner, false)};`);
            continue;
          }
        }
        if (pt.getCallSignatures().length && !(pt.flags & ts.TypeFlags.Union)) continue; // methods are not data
        lines.push(`${inner}${propName(p.getName())}${optional ? "?" : ""}: ${this.print(pt, inner)};`);
      }
      return lines.length ? `{\n${lines.join("\n")}\n${indent}}` : "{}";
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
    return [...new Set(parts)].join(" | ");
  }

  /** Parenthesizes unions/intersections inside arrays and intersections. */
  private wrap(t: ts.Type, indent: string): string {
    const s = this.print(t, indent);
    return t.isUnion() || t.isIntersection() ? `(${s})` : s;
  }

  /** Built-in types (Uint8Array, Date, Map...) are printed by name. */
  private isLibType(t: ts.Type): boolean {
    const decls = (t.aliasSymbol ?? t.getSymbol())?.getDeclarations() ?? [];
    return decls.length > 0 && decls.every((d) => this.program.isSourceFileDefaultLibrary(d.getSourceFile()));
  }
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const propName = (k: string) => (IDENT.test(k) ? k : JSON.stringify(k));
