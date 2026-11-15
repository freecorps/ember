// The sync analysis of `ember migrate convex` (PLAN §22 L9): which functions of a Convex codebase become synchronous
// in Ember (PLAN D6), as a greatest fixed point over the TypeScript program.
//
// Candidates are the handlers of queries and mutations (also built through convex-helpers' customQuery/customMutation),
// every function with a parameter typed QueryCtx / MutationCtx / DatabaseReader / DatabaseWriter (or a type built
// from them), the functions nested in those, convex-helpers trigger callbacks and middlewares, and the async functions
// that await one of them (transitively). Every candidate starts as "sync"; one is dropped when it awaits (or returns)
// something that stays a Promise: real I/O (`fetch`, `ctx.runAction`, `new Promise`), a function that stays async, or a
// value whose type is a Promise not covered by the rules or is unknown. Dropping repeats until nothing changes, so
// recursion and helper chains of any depth settle, and a function nested in a dropped one is dropped with it (a
// function that stays async is left exactly as it was, for a human to split).
//
// Symbols, not names: `ctx` is whatever the parameter is called, `const { db } = ctx` and `const db = ctx.db` are
// followed, and calls resolve to their declarations across modules through the checker. Types of `convex/*` need not
// resolve (the package may not be installed): ctx types are recognised by name when their declaration is outside the
// project, and the type checker is consulted only for awaits no rule covers.

import ts from "typescript";
import { BUILDERS, CTX_TYPES, CUSTOM_BUILDERS, isSyncCtxCall, QUERY_TERMINALS, type BuilderKind } from "./apis.ts";
import { Edits, skipSpace } from "./edits.ts";

export type FnNode = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration;
export type Severity = "manual" | "review" | "info";
export interface Finding {
  /** Path relative to the source root. */
  file: string;
  line: number;
  severity: Severity;
  /** Short kebab-case category (`mixed-io`, `async-handler`...). */
  code: string;
  message: string;
}
export type Role = "handler" | "helper" | "nested" | "transitive" | "middleware" | "trigger";

export interface Candidate {
  node: FnNode;
  kind: "query" | "mutation";
  role: Role;
  name: string;
  parent?: Candidate;
  /** Why it stays async (empty while it converts). */
  blockers: Array<{ node: ts.Node; why: string; io: boolean }>;
}

type Klass = { k: "value" | "sync" | "promise" | "unknown"; why?: string; io?: boolean };

export const isFnNode = (n: ts.Node): n is FnNode =>
  ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n);

export function skipOuter(e: ts.Expression): ts.Expression {
  for (;;) {
    if (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isTypeAssertionExpression(e)) e = e.expression;
    else return e;
  }
}

const isAsync = (fn: FnNode) => !!ts.getModifiers(fn)?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
const PROMISE_TYPES = new Set(["Promise", "PromiseLike"]);
const promiseReturn = (fn: FnNode) => !!fn.type && ts.isTypeReferenceNode(fn.type) && PROMISE_TYPES.has(fn.type.typeName.getText()) && fn.type.typeArguments?.length === 1;

/** Visits the nodes of a function's own body: nested functions are not entered. */
export function forEachDirect(fn: FnNode, cb: (n: ts.Node) => void): void {
  const body = fn.body;
  if (!body) return;
  const visit = (n: ts.Node) => {
    cb(n);
    if (isFnNode(n) || ts.isClassLike(n)) return;
    ts.forEachChild(n, visit);
  };
  if (ts.isBlock(body)) ts.forEachChild(body, visit);
  else visit(body);
}

export class Analysis {
  readonly checker: ts.TypeChecker;
  readonly candidates = new Map<FnNode, Candidate>();
  /** Handlers of actions and httpActions (never touched). */
  readonly actionHandlers = new Set<FnNode>();
  /** Symbols bound to a ctx path (`ctx`, `ctx.db`, `ctx.auth`...). */
  readonly roots = new Map<ts.Symbol, string[]>();
  /** Candidates that end synchronous. */
  readonly sync = new Set<FnNode>();
  /** convex-helpers trigger registrations: `<triggers>.register("table", fn)`. */
  readonly triggerRegistrations: Array<{ call: ts.CallExpression; table: string; fn: FnNode | null; registry: ts.Symbol }> = [];
  readonly findings: Finding[] = [];
  readonly program: ts.Program;
  /** Files of the app (absolute paths), not `_generated` nor node_modules. */
  readonly files: ReadonlySet<string>;
  readonly rel: (file: string) => string;

  constructor(program: ts.Program, files: ReadonlySet<string>, rel: (file: string) => string) {
    this.program = program;
    this.files = files;
    this.rel = rel;
    this.checker = program.getTypeChecker();
  }

  // ---------------------------------------------------------------------------------------------- symbols

  symbolOf(n: ts.Node): ts.Symbol | undefined {
    if (ts.isShorthandPropertyAssignment(n)) return this.checker.getShorthandAssignmentValueSymbol(n);
    return this.checker.getSymbolAtLocation(n);
  }
  /** The declaration a name refers to, through imports (undefined when it does not resolve). */
  declOf(n: ts.Node): ts.Declaration | undefined {
    let s = this.symbolOf(n);
    if (s && s.flags & ts.SymbolFlags.Alias) {
      try {
        s = this.checker.getAliasedSymbol(s);
      } catch {
        return undefined;
      }
    }
    return s?.valueDeclaration ?? s?.declarations?.[0];
  }
  inProject(n: ts.Node): boolean {
    return this.files.has(n.getSourceFile().fileName);
  }
  /** `{ module, name }` of an imported binding (`import { a as b } from "m"`: b → { m, a }), or of `ns.name`. */
  importOf(e: ts.Expression): { module: string; name: string } | undefined {
    e = skipOuter(e);
    if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression)) {
      const ns = this.symbolOf(e.expression)?.declarations?.[0];
      if (ns && ts.isNamespaceImport(ns)) return { module: (ns.parent.parent.moduleSpecifier as ts.StringLiteral).text, name: e.name.text };
      return undefined;
    }
    if (!ts.isIdentifier(e)) return undefined;
    const d = this.symbolOf(e)?.declarations?.[0];
    if (d && ts.isImportSpecifier(d)) return { module: (d.parent.parent.parent.moduleSpecifier as ts.StringLiteral).text, name: (d.propertyName ?? d.name).text };
    return undefined;
  }
  /** The function a callee or handler expression names (in the project). */
  functionOf(e: ts.Expression): FnNode | undefined {
    e = skipOuter(e);
    if (isFnNode(e)) return e;
    if (!ts.isIdentifier(e) && !ts.isPropertyAccessExpression(e)) return undefined;
    const d = this.declOf(ts.isPropertyAccessExpression(e) ? e.name : e);
    if (!d || !this.inProject(d)) return undefined;
    if (ts.isFunctionDeclaration(d) || ts.isMethodDeclaration(d)) return d;
    if ((ts.isVariableDeclaration(d) || ts.isPropertyAssignment(d)) && d.initializer) {
      const i = skipOuter(d.initializer);
      if (isFnNode(i)) return i;
    }
    return undefined;
  }
  /** The initializer of the `const` a name refers to (in the project). */
  constInit(id: ts.Identifier): ts.Expression | undefined {
    const d = this.declOf(id);
    if (d && ts.isVariableDeclaration(d) && d.initializer && this.inProject(d) && ts.isVariableDeclarationList(d.parent) && d.parent.flags & ts.NodeFlags.Const && ts.isIdentifier(d.name)) return d.initializer;
    return undefined;
  }

  // --------------------------------------------------------------------------------------------- builders

  /** query / mutation / action when `e` is a function builder (the `_generated/server` ones, generic, or custom). */
  builderKind(e: ts.Expression, depth = 0): BuilderKind | undefined {
    if (depth > 8) return undefined;
    e = skipOuter(e);
    const imp = this.importOf(e);
    if (imp && (/(^|\/)_generated\/server(\.js)?$/.test(imp.module) || imp.module === "convex/server")) return BUILDERS[imp.name];
    if (ts.isCallExpression(e)) {
      const callee = this.importOf(e.expression)?.name ?? (ts.isIdentifier(e.expression) ? e.expression.text : undefined);
      if (callee && CUSTOM_BUILDERS.has(callee) && e.arguments[0]) return this.builderKind(e.arguments[0], depth + 1);
      return undefined;
    }
    if (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e)) {
      const d = this.declOf(ts.isPropertyAccessExpression(e) ? e.name : e);
      if (d && ts.isVariableDeclaration(d) && d.initializer && this.inProject(d)) return this.builderKind(d.initializer, depth + 1);
    }
    return undefined;
  }

  /** The handler of `query({ handler })` / `query(fn)`. */
  handlerOf(call: ts.CallExpression): FnNode | undefined {
    const a = call.arguments[0];
    if (!a) return undefined;
    const arg = skipOuter(a);
    if (!ts.isObjectLiteralExpression(arg)) return this.functionOf(arg);
    for (const p of arg.properties) {
      if (!p.name || !ts.isIdentifier(p.name) || p.name.text !== "handler") continue;
      if (ts.isMethodDeclaration(p)) return p;
      if (ts.isPropertyAssignment(p)) return this.functionOf(p.initializer);
      if (ts.isShorthandPropertyAssignment(p)) {
        const d = this.symbolOf(p)?.valueDeclaration;
        if (d && (ts.isFunctionDeclaration(d) || (ts.isVariableDeclaration(d) && d.initializer && isFnNode(skipOuter(d.initializer))))) {
          return ts.isFunctionDeclaration(d) ? d : (skipOuter((d as ts.VariableDeclaration).initializer!) as FnNode);
        }
      }
    }
    return undefined;
  }

  // -------------------------------------------------------------------------------------------- ctx types

  /** What a parameter type annotation gives: the kinds it covers and the ctx path it stands for. */
  ctxType(t: ts.TypeNode | undefined, depth = 0): { kinds: Set<BuilderKind>; path: string[] } | undefined {
    if (!t || depth > 10) return undefined;
    if (ts.isParenthesizedTypeNode(t)) return this.ctxType(t.type, depth + 1);
    if (ts.isIntersectionTypeNode(t) || ts.isUnionTypeNode(t)) {
      let out: { kinds: Set<BuilderKind>; path: string[] } | undefined;
      for (const m of t.types) {
        const r = this.ctxType(m, depth + 1);
        if (!r) continue;
        if (!out) out = { kinds: new Set(r.kinds), path: r.path };
        else {
          for (const k of r.kinds) out.kinds.add(k);
          if (r.path.length < out.path.length) out.path = r.path;
        }
      }
      return out;
    }
    if (ts.isTypeLiteralNode(t)) {
      for (const m of t.members) {
        if (ts.isPropertySignature(m) && m.name && ts.isIdentifier(m.name) && m.name.text === "db") {
          const r = this.ctxType(m.type, depth + 1);
          if (r && r.path.join(".") === "ctx.db") return { kinds: r.kinds, path: ["ctx"] };
        }
      }
      return undefined;
    }
    let name: ts.EntityName | ts.Expression | undefined;
    let args: readonly ts.TypeNode[] | undefined;
    if (ts.isTypeReferenceNode(t)) {
      name = t.typeName;
      args = t.typeArguments;
    } else if (ts.isExpressionWithTypeArguments(t)) {
      name = t.expression;
      args = t.typeArguments;
    } else return undefined;
    const last = ts.isQualifiedName(name) ? name.right : ts.isPropertyAccessExpression(name) ? name.name : (name as ts.Identifier);
    if (!ts.isIdentifier(last)) return undefined;
    if (["Pick", "Omit", "Readonly", "Partial", "Required", "NonNullable"].includes(last.text) && args?.[0]) return this.ctxType(args[0], depth + 1);
    const d = this.declOf(last);
    if (d && this.inProject(d)) {
      if (ts.isTypeAliasDeclaration(d)) return this.ctxType(d.type, depth + 1);
      if (ts.isInterfaceDeclaration(d)) {
        let out: { kinds: Set<BuilderKind>; path: string[] } | undefined;
        for (const h of d.heritageClauses ?? []) for (const x of h.types) out ??= this.ctxType(x, depth + 1);
        return out;
      }
      return undefined;
    }
    const base = CTX_TYPES[last.text];
    return base ? { kinds: new Set([base.kind]), path: base.path } : undefined;
  }

  /** Binds a parameter (identifier or `{ db, auth }` pattern) to a ctx path. */
  bind(name: ts.BindingName, path: string[]): void {
    if (ts.isIdentifier(name)) {
      const s = this.symbolOf(name);
      if (s) this.roots.set(s, path);
      return;
    }
    if (ts.isObjectBindingPattern(name)) {
      for (const el of name.elements) {
        if (el.dotDotDotToken) continue;
        const prop = el.propertyName ?? el.name;
        if (!ts.isIdentifier(prop) && !ts.isStringLiteral(prop)) continue;
        this.bind(el.name, [...path, prop.text]);
      }
    }
  }

  /** The ctx path an expression stands for (`ctx.db` → ["ctx", "db"]), or undefined. */
  ctxPath(e: ts.Expression): string[] | undefined {
    e = skipOuter(e);
    if (ts.isIdentifier(e)) {
      const s = this.symbolOf(e);
      return s ? this.roots.get(s) : undefined;
    }
    if (ts.isPropertyAccessExpression(e)) {
      const p = this.ctxPath(e.expression);
      return p ? [...p, e.name.text] : undefined;
    }
    return undefined;
  }
  /** Segments of a call chain on a ctx path: `ctx.db.query("t").withIndex(...).collect()` → ctx, db, query, withIndex, collect. */
  chain(e: ts.Expression): string[] | undefined {
    e = skipOuter(e);
    if (ts.isCallExpression(e)) return this.chain(e.expression);
    if (ts.isPropertyAccessExpression(e)) {
      const s = this.chain(e.expression);
      return s ? [...s, e.name.text] : undefined;
    }
    return this.ctxPath(e);
  }
  isSyncCtxCall(e: ts.Expression): boolean {
    e = skipOuter(e);
    if (!ts.isCallExpression(e)) return false;
    const segs = this.chain(e);
    return !!segs && !segs.some((s) => s === "then" || s === "catch" || s === "finally") && isSyncCtxCall(segs);
  }
  /** `ctx.db.query(...)...` without a terminal (`.collect()`...): a query, iterable in Convex. */
  isOpenQuery(e: ts.Expression): boolean {
    const segs = this.chain(e);
    return !!segs && segs[0] === "ctx" && segs[1] === "db" && segs[2] === "query" && !QUERY_TERMINALS.has(segs[segs.length - 1]!);
  }

  // ----------------------------------------------------------------------------------------- candidates

  add(node: FnNode, kind: "query" | "mutation", role: Role, name: string, parent?: Candidate): Candidate {
    const prev = this.candidates.get(node);
    if (prev) return prev;
    const c: Candidate = { node, kind, role, name, blockers: [], ...(parent ? { parent } : {}) };
    this.candidates.set(node, c);
    return c;
  }

  nameOf(fn: ts.Node): string {
    let n: ts.Node | undefined = fn;
    for (let i = 0; n && i < 6; i++, n = n.parent) {
      if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name) return n.name.getText();
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) return n.name.text;
      if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && n.name.text !== "handler") return n.name.text;
    }
    return "<anonymous>";
  }
  line(n: ts.Node): number {
    const sf = n.getSourceFile();
    return sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  }
  where(n: ts.Node): string {
    return `${this.rel(n.getSourceFile().fileName)}:${this.line(n)}`;
  }
  find(n: ts.Node, severity: Severity, code: string, message: string): void {
    this.findings.push({ file: this.rel(n.getSourceFile().fileName), line: this.line(n), severity, code, message });
  }

  /** Finds every candidate, binds ctx roots and settles the fixed point. */
  run(): void {
    const sources = this.program.getSourceFiles().filter((sf) => this.files.has(sf.fileName));
    // 1. Builders: handlers of queries/mutations (candidates) and of actions (left alone); middlewares; triggers.
    for (const sf of sources) {
      const visit = (n: ts.Node) => {
        if (ts.isCallExpression(n)) this.visitCall(n);
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    // 2. Helpers: a parameter typed with a ctx type.
    for (const sf of sources) {
      const visit = (n: ts.Node) => {
        if (isFnNode(n) && !this.actionHandlers.has(n)) this.visitParams(n);
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    // 3. Nested functions, local ctx aliases; then 4. functions awaiting candidates, to a fixed point.
    for (const c of [...this.candidates.values()]) this.addNested(c);
    for (let grew = true; grew; ) {
      grew = false;
      for (const sf of sources) {
        const visit = (n: ts.Node) => {
          if (isFnNode(n) && !this.candidates.has(n) && !this.insideAction(n) && this.usesCandidate(n)) {
            const callee = this.usesCandidate(n)!;
            this.addNested(this.add(n, callee.kind, "transitive", this.nameOf(n)));
            grew = true;
          }
          ts.forEachChild(n, visit);
        };
        visit(sf);
      }
    }
    for (const c of this.candidates.values()) if (!c.parent) this.bindLocals(c.node);
    this.settle();
  }

  private insideAction(n: ts.Node): boolean {
    for (let p: ts.Node | undefined = n; p; p = p.parent) if (isFnNode(p) && this.actionHandlers.has(p)) return true;
    return false;
  }

  private visitCall(n: ts.CallExpression): void {
    const kind = this.builderKind(n.expression);
    if (kind) {
      const h = this.handlerOf(n);
      if (!h) return;
      if (kind === "action") {
        this.actionHandlers.add(h);
        return;
      }
      this.add(h, kind, "handler", this.nameOf(n));
      const p = h.parameters[0];
      if (p) this.bind(p.name, ["ctx"]);
      return;
    }
    const callee = this.importOf(n.expression);
    // convex-helpers middlewares: customQuery(base, customCtx(fn)) / customQuery(base, { args, input })
    if (callee && CUSTOM_BUILDERS.has(callee.name) && n.arguments[0]) {
      const base = this.builderKind(n.arguments[0]);
      const mw = n.arguments[1] && this.middlewareOf(n.arguments[1]);
      if (mw && (base === "query" || base === "mutation")) {
        this.add(mw, base, "middleware", this.nameOf(n));
        const p = mw.parameters[0];
        if (p) this.bind(p.name, ["ctx"]);
      }
      return;
    }
    // convex-helpers triggers: <triggers>.register("table", fn)
    if (ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "register" && ts.isIdentifier(n.expression.expression)) {
      const init = this.constInit(n.expression.expression);
      const reg = this.symbolOf(n.expression.expression);
      if (!init || !reg || !ts.isNewExpression(init) || this.importOf(init.expression)?.name !== "Triggers") return;
      const [t, f] = n.arguments;
      const fn = f ? this.functionOf(f) : undefined;
      if (t && ts.isStringLiteralLike(t)) this.triggerRegistrations.push({ call: n, table: t.text, fn: fn && isFnNode(skipOuter(f!)) ? fn : null, registry: reg });
      if (fn) {
        this.add(fn, "mutation", "trigger", `trigger ${t && ts.isStringLiteralLike(t) ? t.text : "?"}`);
        const p = fn.parameters[0];
        if (p) this.bind(p.name, ["ctx"]);
      }
    }
  }

  /** The `fn` of `customCtx(fn)` or the `input` of `{ args, input }`. */
  middlewareOf(e: ts.Expression): FnNode | undefined {
    e = skipOuter(e);
    if (ts.isCallExpression(e) && this.importOf(e.expression)?.name === "customCtx" && e.arguments[0]) return this.functionOf(e.arguments[0]);
    if (ts.isObjectLiteralExpression(e)) {
      for (const p of e.properties) {
        if (p.name && ts.isIdentifier(p.name) && p.name.text === "input") {
          if (ts.isMethodDeclaration(p)) return p;
          if (ts.isPropertyAssignment(p)) return this.functionOf(p.initializer);
        }
      }
    }
    return undefined;
  }

  private visitParams(fn: FnNode): void {
    for (const p of fn.parameters) {
      const t = this.ctxType(p.type);
      if (!t) continue;
      const hasAction = t.kinds.has("action");
      if (hasAction && t.kinds.size > 1) {
        this.find(p, "manual", "mixed-ctx", `${this.nameOf(fn)} takes both a query/mutation ctx and an ActionCtx: in Ember the first is synchronous and the second is not; split it (one sync helper for queries/mutations, the action calls it through ctx.runQuery/runMutation)`);
        continue;
      }
      if (hasAction) continue;
      this.bind(p.name, t.path);
      this.add(fn, t.kinds.has("mutation") ? "mutation" : "query", "helper", this.nameOf(fn));
    }
  }

  private addNested(c: Candidate): void {
    const visit = (n: ts.Node) => {
      if (n !== c.node && isFnNode(n)) {
        this.addNested(this.add(n, c.kind, "nested", `${c.name} (nested function)`, c));
        return;
      }
      ts.forEachChild(n, visit);
    };
    if (c.node.body) ts.forEachChild(c.node.body, visit);
  }

  /** `const db = ctx.db`, `const { db, auth } = ctx` inside candidates. */
  private bindLocals(fn: FnNode): void {
    const visit = (n: ts.Node) => {
      if (ts.isVariableDeclaration(n) && n.initializer) {
        const p = this.ctxPath(n.initializer);
        if (p) this.bind(n.name, p);
      }
      ts.forEachChild(n, visit);
    };
    if (fn.body) visit(fn.body);
  }

  /** A candidate this function awaits or returns a call of (makes it a transitive candidate). */
  private usesCandidate(fn: FnNode): Candidate | undefined {
    let hit: Candidate | undefined;
    forEachDirect(fn, (n) => {
      if (hit) return;
      const e = ts.isAwaitExpression(n) ? n.expression : ts.isReturnStatement(n) ? n.expression : n === fn.body && !ts.isBlock(n) ? (n as ts.Expression) : undefined;
      if (!e) return;
      const x = skipOuter(e);
      if (ts.isCallExpression(x)) {
        const f = this.functionOf(x.expression);
        if (f && f !== fn) hit = this.candidates.get(f);
      }
    });
    return hit;
  }

  // ------------------------------------------------------------------------------------- classification

  /** What an expression is once the candidates in `this.sync` are synchronous. */
  classify(e: ts.Expression, depth = 0): Klass {
    if (depth > 12) return { k: "unknown", why: "too deep" };
    e = skipOuter(e);
    if (ts.isAwaitExpression(e)) {
      const r = this.classify(e.expression, depth + 1);
      return r.k === "value" || r.k === "sync" ? { k: "value" } : r;
    }
    if (ts.isCallExpression(e)) {
      const callee = skipOuter(e.expression);
      if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === "Promise") {
        if (callee.name.text === "all") return e.arguments[0] && this.arrayOfSync(e.arguments[0], depth + 1) ? { k: "sync" } : { k: "promise", why: "Promise.all over values that stay async" };
        return { k: "promise", why: `Promise.${callee.name.text}` };
      }
      if (this.isSyncCtxCall(e)) return { k: "sync" };
      const segs = this.chain(e);
      if (segs && segs[0] === "ctx" && segs[1] === "runAction") return { k: "promise", why: "ctx.runAction (I/O)", io: true };
      if (ts.isIdentifier(callee) && callee.text === "fetch" && !this.inProjectDecl(callee)) return { k: "promise", why: "fetch (I/O)", io: true };
      const f = this.functionOf(callee);
      if (f) {
        const c = this.candidates.get(f);
        if (c) return this.sync.has(f) ? { k: "sync" } : { k: "promise", why: `${c.name} stays async (${this.where(f)})`, io: c.blockers.some((b) => b.io) };
        if (isAsync(f) || promiseReturn(f)) return { k: "promise", why: `${this.nameOf(f)} is async (${this.where(f)})` };
        return this.byType(e);
      }
      return this.byType(e);
    }
    if (ts.isNewExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === "Promise") return { k: "promise", why: "new Promise", io: true };
    if (ts.isIdentifier(e)) {
      const init = this.constInit(e);
      if (init) return this.classify(init, depth + 1);
    }
    return this.byType(e);
  }
  private inProjectDecl(id: ts.Identifier): boolean {
    const d = this.declOf(id);
    return !!d && this.inProject(d);
  }
  private byType(e: ts.Expression): Klass {
    const what = e.getText().replace(/\s+/g, " ").slice(0, 60);
    if (ts.isIdentifier(skipOuter(e)) && ["setTimeout", "setInterval"].includes(e.getText())) return { k: "promise", why: "timer (I/O)", io: true };
    let t: ts.Type;
    try {
      t = this.checker.getTypeAtLocation(e);
    } catch {
      return { k: "unknown", why: `\`${what}\`: unknown type` };
    }
    if (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return { k: "unknown", why: `\`${what}\` has no known type (unresolved import?)` };
    const parts = t.isUnion() ? t.types : [t];
    if (parts.some((p) => this.checker.getPropertyOfType(this.checker.getApparentType(p), "then"))) return { k: "promise", why: `\`${what}\` is a Promise (${this.checker.typeToString(t).slice(0, 60)})`, io: true };
    return { k: "value" };
  }

  /** `Promise.all(X)` over values that are synchronous: `[a, b]`, `xs.map(fn)` with `fn` sync, or a const of those. */
  arrayOfSync(e: ts.Expression, depth = 0): boolean {
    if (depth > 12) return false;
    e = skipOuter(e);
    if (ts.isArrayLiteralExpression(e)) {
      return e.elements.every((el) => (ts.isSpreadElement(el) ? this.arrayOfSync(el.expression, depth + 1) : ["value", "sync"].includes(this.classify(el, depth + 1).k)));
    }
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === "map" && e.arguments[0]) {
      const f = this.functionOf(e.arguments[0]);
      if (!f) return false;
      const c = this.candidates.get(f);
      return c ? this.sync.has(f) : !isAsync(f) && !promiseReturn(f);
    }
    if (ts.isIdentifier(e)) {
      const init = this.constInit(e);
      return !!init && this.arrayOfSync(init, depth + 1);
    }
    return false;
  }

  /** Why `c` cannot be synchronous (given the current `sync` set). */
  blockersOf(c: Candidate): Candidate["blockers"] {
    const out: Candidate["blockers"] = [];
    if (c.parent && !this.sync.has(c.parent.node)) return [{ node: c.node, why: `inside ${c.parent.name}, which stays async`, io: false }];
    const check = (n: ts.Node, e: ts.Expression, returned: boolean) => {
      const r = this.classify(e);
      if (r.k === "promise" || (!returned && r.k === "unknown")) out.push({ node: n, why: `${returned ? "returns" : "awaits"} ${r.why ?? "a Promise"}`, io: !!r.io || r.k === "unknown" });
    };
    forEachDirect(c.node, (n) => {
      if (ts.isAwaitExpression(n)) check(n, n.expression, false);
      else if (ts.isForOfStatement(n) && n.awaitModifier) {
        if (!this.isOpenQuery(n.expression)) check(n, n.expression, false);
      } else if (ts.isReturnStatement(n) && n.expression) check(n, n.expression, true);
    });
    if (c.node.body && !ts.isBlock(c.node.body)) check(c.node.body, c.node.body, true);
    return out;
  }

  /** Greatest fixed point: start with every candidate sync, drop the blocked ones until nothing changes. */
  private settle(): void {
    for (const n of this.candidates.keys()) this.sync.add(n);
    for (let changed = true; changed; ) {
      changed = false;
      for (const c of this.candidates.values()) {
        if (!this.sync.has(c.node)) continue;
        const b = this.blockersOf(c);
        if (b.length) {
          c.blockers = b;
          this.sync.delete(c.node);
          changed = true;
        }
      }
    }
  }

  // ------------------------------------------------------------------------------------------- edits

  /** The edits that make the sync candidates of `sf` synchronous; returns counts by change. */
  syncEdits(sf: ts.SourceFile, e: Edits, count: (what: string, n?: number) => void): void {
    const text = sf.text;
    for (const c of this.candidates.values()) {
      const fn = c.node;
      if (fn.getSourceFile() !== sf || !this.sync.has(fn)) continue;
      const asyncMod = ts.getModifiers(fn)?.find((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
      if (asyncMod) {
        e.delete(asyncMod.getStart(sf), skipSpace(text, asyncMod.end));
        count("async removed");
      }
      if (fn.type && ts.isTypeReferenceNode(fn.type) && PROMISE_TYPES.has(fn.type.typeName.getText(sf)) && fn.type.typeArguments?.length === 1) {
        const arg = fn.type.typeArguments[0]!;
        e.delete(fn.type.getStart(sf), arg.getStart(sf));
        e.delete(arg.end, fn.type.end);
        count("Promise<T> → T");
      }
      forEachDirect(fn, (n) => {
        if (ts.isAwaitExpression(n)) {
          e.delete(n.getStart(sf), n.expression.getStart(sf));
          count("await removed");
        } else if (ts.isForOfStatement(n) && n.awaitModifier) {
          e.delete(n.awaitModifier.getStart(sf), skipSpace(text, n.awaitModifier.end));
          if (this.isOpenQuery(n.expression)) {
            e.insert(n.expression.end, ".collect()");
            this.find(n, "info", "for-await", "`for await` over a query became `for (... of query.collect())`: the loop reads every matching document up front (a `break` no longer saves reads); use `.take(n)` or `.paginate()` for large tables");
          }
          count("for await → for");
        } else if (ts.isCallExpression(n)) {
          const callee = skipOuter(n.expression);
          if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === "Promise" && callee.name.text === "all" && n.arguments[0] && this.arrayOfSync(n.arguments[0])) {
            e.delete(n.getStart(sf), n.arguments[0].getStart(sf));
            e.delete(n.arguments[0].end, n.end);
            count("Promise.all removed");
          }
          if (ts.isIdentifier(callee) && callee.text === "fetch" && !this.inProjectDecl(callee)) {
            this.find(n, "manual", "io-in-mutation", `${c.name}: fetch() inside a ${c.kind} (Ember runs queries and mutations without I/O, PLAN D6): move it to an action`);
          }
        } else if (ts.isPropertyAccessExpression(n) && ["then", "catch", "finally"].includes(n.name.text) && ts.isCallExpression(skipOuter(n.expression))) {
          const r = this.classify(n.expression);
          if (r.k === "sync") this.find(n, "manual", "then-on-value", `${c.name}: \`.${n.name.text}()\` on a call that is synchronous in Ember (it returns the value, not a Promise): rewrite as plain code`);
        }
      });
    }
  }

  /** Report lines for the candidates that stay async. */
  reportBlocked(): void {
    for (const c of this.candidates.values()) {
      if (this.sync.has(c.node)) continue;
      const own = c.blockers.filter((b) => !b.why.startsWith("inside "));
      if (!own.length) continue; // reported through its parent
      const reasons = own.map((b) => `${b.why} (line ${this.line(b.node)})`).join("; ");
      const io = own.some((b) => b.io);
      const usesDb = this.usesDb(c.node);
      if (c.role === "handler") {
        this.find(c.node, "manual", "async-handler", `${c.kind} ${c.name} stays async: ${reasons}. Ember runs queries and mutations synchronously (PLAN D6): ${io ? "move the I/O to an action (ctx.scheduler.runAfter(0, ...) from the mutation, or an action that calls ctx.runMutation)" : "make what it awaits synchronous"}`);
      } else if (c.role === "nested") {
        this.find(c.node, "review", "async-callback", `${c.name} stays async: ${reasons}`);
      } else if (io && usesDb) {
        this.find(c.node, "manual", "mixed-io", `${c.name} mixes database access and I/O (${reasons}): split it into a synchronous helper (database) and an action (I/O)`);
      } else {
        this.find(c.node, "manual", "async-helper", `${c.name} stays async: ${reasons}`);
      }
    }
  }

  private usesDb(fn: FnNode): boolean {
    let hit = false;
    forEachDirect(fn, (n) => {
      if (!hit && ts.isCallExpression(n) && this.isSyncCtxCall(n)) hit = true;
    });
    return hit;
  }
}
