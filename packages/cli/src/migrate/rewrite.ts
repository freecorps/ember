// API rewrites of `ember migrate convex`, per file: imports, validators, system tables, `ConvexError`, crons and the
// convex-helpers forms Ember has natively (triggers, middlewares). Each rewrite is a set of edits around the code it
// keeps (edits.ts); whatever has no safe mechanical form is reported instead.

import ts from "typescript";
import { EMBER_SERVER, EMBER_VALUES, IDENTITY_FIELDS, RENAME_NOTES, RENAMED, SAME_NAME, VALUES_ONLY, WEEKDAYS } from "./apis.ts";
import { isFnNode, skipOuter, type Analysis, type FnNode, type Severity } from "./analyze.ts";
import { Edits, skipSpace } from "./edits.ts";

export interface ErrorSite {
  code: string;
  /** Original codes that map to it (`NOT_FOUND`, `notFound` → `NotFound`). */
  raw: Set<string>;
  sites: string[];
}

/** State shared by every file of one run. */
export interface MigrationState {
  a: Analysis;
  /** Module of the generated `defineErrors` (path without extension, relative to the root: "errors"). */
  errorsModule: string;
  errors: Map<string, ErrorSite>;
  /** `<module>:<export>` of each extracted trigger, by table. */
  triggers: Array<{ module: string; name: string; table: string }>;
}

interface Spec {
  imported: string;
  local: string;
  type: boolean;
}

export class FileRewriter {
  readonly e: Edits;
  readonly counts = new Map<string, number>();
  /** Imports to add or merge: module → specs. */
  private readonly adds = new Map<string, Spec[]>();
  private readonly errorsLocal: string;
  private readonly prefix: string;
  readonly sf: ts.SourceFile;
  /** Path relative to the root, posix (`lib/auth.ts`). */
  readonly rel: string;
  readonly st: MigrationState;

  constructor(sf: ts.SourceFile, rel: string, st: MigrationState) {
    this.sf = sf;
    this.rel = rel;
    this.st = st;
    this.e = new Edits(sf.text);
    const depth = rel.split("/").length - 1;
    this.prefix = depth === 0 ? "./" : "../".repeat(depth);
    this.errorsLocal = /\berrors\b/.test(sf.text) ? "appErrors" : "errors";
  }

  get a(): Analysis {
    return this.st.a;
  }
  count(what: string, n = 1): void {
    this.counts.set(what, (this.counts.get(what) ?? 0) + n);
  }
  find(n: ts.Node, severity: Severity, code: string, message: string): void {
    this.a.find(n, severity, code, message);
  }
  private addImport(module: string, imported: string, type: boolean, local = imported): void {
    const list = this.adds.get(module) ?? [];
    if (!list.some((s) => s.local === local)) list.push({ imported, local, type });
    else if (!type) for (const s of list) if (s.local === local) s.type = false;
    this.adds.set(module, list);
  }
  private isV(e: ts.Expression): boolean {
    const imp = this.a.importOf(e);
    return !!imp && imp.name === "v" && (imp.module === "convex/values" || imp.module === "convex/server");
  }
  private text(n: ts.Node): string {
    return n.getText(this.sf);
  }

  /** Runs every rewrite and returns the new text (or null when nothing changed). */
  run(): string | null {
    this.a.syncEdits(this.sf, this.e, (w, n) => this.count(w, n));
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n)) this.call(n);
      else if (ts.isNewExpression(n)) this.newExpr(n);
      else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword) this.instanceOf(n);
      else if (ts.isTypeReferenceNode(n)) this.typeRef(n);
      else if (ts.isPropertyAccessExpression(n)) this.identityField(n);
      ts.forEachChild(n, visit);
    };
    visit(this.sf);
    this.triggerRegistrations();
    this.imports();
    if (!this.e.size) return null;
    return this.e.apply();
  }

  // ------------------------------------------------------------------------------------------------- calls

  private call(n: ts.CallExpression): void {
    const sf = this.sf;
    const callee = skipOuter(n.expression);
    // v.* validators
    if (ts.isPropertyAccessExpression(callee) && this.isV(callee.expression)) {
      const name = callee.name.text;
      const [a0, a1] = n.arguments;
      if (name === "id" && a0 && ts.isStringLiteralLike(a0)) {
        if (a0.text === "_storage") {
          // Only the method part: `v` stays (an edit over it would make its import look unused).
          this.e.replace(callee.name.getStart(sf), n.end, "file()");
          this.count('v.id("_storage") → v.file()');
        } else if (a0.text === "_scheduled_functions") {
          this.e.replace(callee.name.getStart(sf), n.end, "string()");
          this.count('v.id("_scheduled_functions") → v.string()');
          this.find(n, "review", "scheduled-id", "job ids are strings in Ember (`ctx.scheduler.runAfter` returns a string): the field became v.string()");
        }
      } else if (name === "record" && a0 && a1) {
        this.e.delete(a0.getStart(sf), a1.getStart(sf));
        this.count("v.record(keys, values) → v.record(values)");
        const k = this.text(a0).replace(/\s+/g, "");
        if (!/^v\.string\(\)$/.test(k)) this.find(n, "review", "record-keys", `v.record keys were ${k}: Ember records have string keys (validated values only); check the keys in code`);
      } else if (name === "bigint") {
        this.e.replace(callee.name.getStart(sf), callee.name.end, "int64");
        this.count("v.bigint() → v.int64()");
      } else if (name === "any") {
        this.count("v.any() (unknown in Ember)");
      }
      return;
    }
    const segs = this.a.chain(n);
    if (segs && segs[0] === "ctx" && segs[1] === "db" && ts.isPropertyAccessExpression(callee)) this.dbCall(n, callee, segs);
    if (segs && segs.join(".") === "ctx.storage.generateUploadUrl" && this.inSyncCode(n)) {
      this.find(n, "review", "upload-url", "ctx.storage.generateUploadUrl() returns an upload ticket `{ url, headers, storageId, ... }` in Ember, not a URL string: the client uploads with the ticket (contracts.md \"Arquivos\")");
    }
    if (segs && segs[0] === "ctx" && segs[1] === "vectorSearch") {
      this.find(n, "review", "vector-search", "ctx.vectorSearch(table, index, query) takes `{ vector | text, limit, filter }` in Ember (PLAN §6) and returns `{ _id, _score }` like Convex: check the filter form");
    }
    const imp = this.a.importOf(callee);
    if (imp && imp.name === "cronJobs" && n.arguments.length === 0) {
      this.e.insert(n.arguments.pos, '{ shard: "global:main" }');
      this.count('cronJobs() → cronJobs({ shard: "global:main" })');
      this.find(n, "info", "cron-shard", 'crons run in a shard in Ember: they were pinned to "global:main" (change it per cron with { shard })');
    }
    if (imp && /^custom(Query|Mutation|Action)$/.test(imp.name)) this.customBuilder(n, imp.name);
    if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) this.cronCall(n, callee);
  }

  private inSyncCode(n: ts.Node): boolean {
    for (let p: ts.Node | undefined = n; p; p = p.parent) if (isFnNode(p) && this.a.candidates.has(p)) return true;
    return false;
  }

  /** `ctx.db.get("table", id)` (table first) and `ctx.db.system.*`. */
  private dbCall(n: ts.CallExpression, callee: ts.PropertyAccessExpression, segs: string[]): void {
    const sf = this.sf;
    const method = segs[2];
    const args = n.arguments;
    const arity: Record<string, number> = { get: 2, delete: 2, patch: 3, replace: 3 };
    if (segs.length === 3 && method && arity[method] === args.length && ts.isStringLiteralLike(args[0]!)) {
      this.e.delete(args[0]!.getStart(sf), args[1]!.getStart(sf));
      this.count(`ctx.db.${method}(table, id) → ctx.db.${method}(id)`);
      return;
    }
    if (method !== "system" || segs.length !== 4) return;
    // callee = <ctx>.db.system.<op>
    const sys = callee.expression;
    const db = ts.isPropertyAccessExpression(sys) ? sys.expression : undefined;
    const ctx = db && ts.isPropertyAccessExpression(db) && db.name.text === "db" ? db.expression : undefined;
    const op = segs[3];
    if (!ctx) {
      this.find(n, "manual", "system-table", `\`${this.text(n).slice(0, 60)}\`: Ember has no ctx.db.system; use ctx.storage.getMetadata(id) or ctx.scheduler.get(id) (needs ctx, not just db)`);
      return;
    }
    const c = this.text(ctx);
    if (op === "get") {
      let table: string | undefined;
      let idArg: ts.Expression | undefined;
      if (args.length === 2 && ts.isStringLiteralLike(args[0]!)) {
        table = args[0]!.text;
        idArg = args[1];
      } else if (args.length === 1) {
        idArg = args[0];
        const t = this.idTableOf(idArg!);
        table = t;
      }
      if (table === "_storage" && idArg) {
        this.e.replace(callee.getStart(sf), callee.end, `${c}.storage.getMetadata`);
        if (args.length === 2) this.e.delete(args[0]!.getStart(sf), args[1]!.getStart(sf));
        this.count("ctx.db.system.get(_storage) → ctx.storage.getMetadata");
        this.find(n, "info", "storage-metadata", "ctx.storage.getMetadata(id) has the `_storage` fields (`_id`, `_creationTime`, `contentType`, `sha256`, `size`), but `sha256` is lowercase hex (base64 in Convex) and `size`/`sha256` are null until the upload is checked");
        return;
      }
      if (table === "_scheduled_functions" && idArg) {
        this.e.replace(callee.getStart(sf), callee.end, `${c}.scheduler.get`);
        if (args.length === 2) this.e.delete(args[0]!.getStart(sf), args[1]!.getStart(sf));
        this.count("ctx.db.system.get(_scheduled_functions) → ctx.scheduler.get");
        this.find(n, "info", "scheduler-get", "ctx.scheduler.get(id) (PLAN §22 L7): `id` instead of `_id`, `args` is the object passed (Convex keeps `[args]`), plus `attempts`");
        return;
      }
      this.find(n, "manual", "system-table", `\`${this.text(n).slice(0, 80)}\`: cannot tell whether the id is a file or a job; use ctx.storage.getMetadata(id) or ctx.scheduler.get(id)`);
      return;
    }
    if (op === "query") {
      const t = args[0] && ts.isStringLiteralLike(args[0]) ? args[0].text : undefined;
      const outer = n.parent && ts.isPropertyAccessExpression(n.parent) && n.parent.name.text === "collect" && n.parent.parent && ts.isCallExpression(n.parent.parent) ? n.parent.parent : undefined;
      if (t === "_scheduled_functions" && outer && outer.arguments.length === 0) {
        // ctx.scheduler.list has no cursor: 1000 (LIST_SCHEDULED_MAX) is as far as one call goes, so this is not an exact
        // port of an unbounded .collect(); the comment and the finding say so.
        this.e.replace(n.getStart(sf), outer.end, `${c}.scheduler.list({ limit: 1000 /* at most 1000 jobs: Convex's .collect() returned all of them */ })`);
        this.count("ctx.db.system.query(_scheduled_functions).collect() → ctx.scheduler.list()");
        this.find(n, "review", "scheduler-list", "`.collect()` over `_scheduled_functions` became `ctx.scheduler.list({ limit: 1000 })`, which returns at most 1000 jobs (the maximum; there is no cursor to page past it), oldest first, where Convex returned all of them: if the shard can hold more, narrow it with `{ state }` or keep the ids you need in a table of your own");
        return;
      }
      this.find(n, "manual", "system-table", `\`${this.text(n.parent ?? n).slice(0, 80)}\`: Ember has no ctx.db.system.query; ${t === "_scheduled_functions" ? "use ctx.scheduler.list({ state?, limit? }) and filter in code" : "files are not listable: keep their ids in a table of your own"}`);
    }
  }

  /** `_storage` / `_scheduled_functions` when the id's type or declaration says so. */
  private idTableOf(e: ts.Expression): string | undefined {
    const texts: string[] = [];
    try {
      texts.push(this.a.checker.typeToString(this.a.checker.getTypeAtLocation(e)));
    } catch {
      /* unresolved */
    }
    const x = skipOuter(e);
    if (ts.isIdentifier(x) || ts.isPropertyAccessExpression(x)) {
      const d = this.a.declOf(ts.isPropertyAccessExpression(x) ? x.name : x);
      if (d) texts.push(d.getText());
      // an argument validated with v.id("_storage") / v.file()
      if (d && ts.isBindingElement(d)) texts.push(this.argValidatorText(d) ?? "");
    }
    const all = texts.join(" ");
    if (/_scheduled_functions/.test(all)) return "_scheduled_functions";
    if (/_storage|\bv\.file\(\)|FileId/.test(all)) return "_storage";
    return undefined;
  }
  /** For `handler: (ctx, { fileId }) =>`, the text of `args: { fileId: v.id("_storage") }`. */
  private argValidatorText(d: ts.BindingElement): string | undefined {
    const name = (d.propertyName ?? d.name).getText();
    for (let p: ts.Node | undefined = d; p; p = p.parent) {
      if (ts.isObjectLiteralExpression(p)) {
        for (const prop of p.properties) {
          if (ts.isPropertyAssignment(prop) && prop.name.getText() === "args" && ts.isObjectLiteralExpression(prop.initializer)) {
            const f = prop.initializer.properties.find((q) => q.name?.getText() === name);
            if (f) return f.getText();
          }
        }
      }
    }
    return undefined;
  }

  // --------------------------------------------------------------------------------------------- errors

  private newExpr(n: ts.NewExpression): void {
    const imp = this.a.importOf(n.expression);
    if (!imp || imp.name !== "ConvexError" || !imp.module.startsWith("convex/")) return;
    const sf = this.sf;
    const arg = n.arguments?.[0];
    const code = arg ? codeOf(arg) : undefined;
    const final = code?.code ?? "AppError";
    const site = this.st.errors.get(final) ?? { code: final, raw: new Set<string>(), sites: [] };
    if (code) site.raw.add(code.raw);
    site.sites.push(`${this.rel}:${this.a.line(n)}`);
    this.st.errors.set(final, site);
    this.addImport(`${this.prefix}${this.st.errorsModule}`, "errors", false, this.errorsLocal);
    if (arg) this.e.replace(n.getStart(sf), arg.getStart(sf), `${this.errorsLocal}.${final}(`);
    else this.e.replace(n.getStart(sf), n.end, `${this.errorsLocal}.${final}()`);
    this.count("ConvexError → errors.X");
    if (!code) this.find(n, "review", "error-without-code", `ConvexError without a code (${arg ? `\`${this.text(arg).replace(/\s+/g, " ").slice(0, 60)}\`` : "no data"}): it became ${this.errorsLocal}.AppError(data) with the same payload; give it a code of its own in ${this.st.errorsModule}.ts`);
  }

  private instanceOf(n: ts.BinaryExpression): void {
    const imp = this.a.importOf(n.right);
    if (!imp || imp.name !== "ConvexError" || !imp.module.startsWith("convex/")) return;
    const sf = this.sf;
    this.e.replace(n.getStart(sf), n.left.getStart(sf), "isAppError(");
    this.e.replace(n.left.end, n.end, ")");
    this.addImport(EMBER_SERVER, "isAppError", false);
    this.count("instanceof ConvexError → isAppError()");
  }

  // ---------------------------------------------------------------------------------------------- types

  private typeRef(n: ts.TypeReferenceNode): void {
    const name = n.typeName.getText(this.sf);
    const arg = n.typeArguments?.[0];
    if (!arg || !ts.isLiteralTypeNode(arg) || !ts.isStringLiteral(arg.literal)) return;
    const table = arg.literal.text;
    if ((name === "Id" || name === "GenericId") && table === "_storage") {
      this.e.replace(n.getStart(this.sf), n.end, "FileId");
      this.addImport(EMBER_SERVER, "FileId", true);
      this.count('Id<"_storage"> → FileId');
    } else if ((name === "Id" || name === "GenericId") && table === "_scheduled_functions") {
      this.e.replace(n.getStart(this.sf), n.end, "string");
      this.count('Id<"_scheduled_functions"> → string');
    } else if (name === "Doc" && table === "_storage") {
      this.e.replace(n.getStart(this.sf), n.end, "FileMetadata");
      this.addImport(EMBER_SERVER, "FileMetadata", true);
      this.count('Doc<"_storage"> → FileMetadata');
    } else if (name === "Doc" && table === "_scheduled_functions") {
      this.find(n, "manual", "system-table", 'Doc<"_scheduled_functions">: use the return type of ctx.scheduler.get (PLAN §22 L7)');
    }
  }

  /** `identity.email` on `ctx.auth.getUserIdentity()`: Ember's Identity keeps profile fields in `claims`. */
  private identityField(n: ts.PropertyAccessExpression): void {
    if (IDENTITY_FIELDS.has(n.name.text) || !ts.isIdentifier(n.expression)) return;
    const init = this.a.constInit(n.expression);
    if (!init) return;
    const segs = this.a.chain(ts.isAwaitExpression(skipOuter(init)) ? (skipOuter(init) as ts.AwaitExpression).expression : init);
    if (!segs || segs.join(".") !== "ctx.auth.getUserIdentity") return;
    const hint = n.name.text === "tokenIdentifier" ? "`${identity.issuer}|${identity.subject}`" : `identity.claims?.${n.name.text}`;
    this.find(n, "review", "identity-field", `\`${this.text(n)}\`: Ember's Identity is { subject, issuer?, claims? }: use ${hint}`);
  }

  // ------------------------------------------------------------------------------------------------ crons

  private cronCall(n: ts.CallExpression, callee: ts.PropertyAccessExpression): void {
    const method = callee.name.text;
    if (!["daily", "weekly", "monthly", "hourly", "interval"].includes(method)) return;
    const init = this.a.constInit(callee.expression as ts.Identifier);
    if (!init || !ts.isCallExpression(skipOuter(init)) || this.a.importOf((skipOuter(init) as ts.CallExpression).expression)?.name !== "cronJobs") return;
    const sched = n.arguments[1] && skipOuter(n.arguments[1]);
    if (!sched || !ts.isObjectLiteralExpression(sched)) return;
    const sf = this.sf;
    for (const p of sched.properties) {
      if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name)) continue;
      const key = p.name.text;
      if (key === "hourUTC" || key === "minuteUTC") {
        this.e.replace(p.name.getStart(sf), p.name.end, key === "hourUTC" ? "hour" : "minute");
        this.count(`crons ${key} → ${key.replace("UTC", "")}`);
      } else if (key === "dayOfWeek" && ts.isStringLiteralLike(p.initializer)) {
        const d = WEEKDAYS[p.initializer.text.toLowerCase()];
        if (d !== undefined) {
          this.e.replace(p.initializer.getStart(sf), p.initializer.end, String(d));
          this.count("crons dayOfWeek name → number");
        }
      } else if (key === "seconds" && method === "interval") {
        const v = ts.isNumericLiteral(p.initializer) ? Number(p.initializer.text) : NaN;
        if (v > 0 && v % 60 === 0) {
          this.e.replace(p.getStart(sf), p.end, `minutes: ${v / 60}`);
          this.count("crons interval seconds → minutes");
        } else this.find(p, "manual", "cron-seconds", "crons.interval in seconds: Ember's smallest interval is one minute ({ minutes } or { hours })");
      }
    }
  }

  // ---------------------------------------------------------------------------------------- convex-helpers

  /** customQuery(base, customCtx(fn)) → base.use(...); customMutation(base, customCtx(triggers.wrapDB)) → base. */
  private customBuilder(n: ts.CallExpression, which: string): void {
    const sf = this.sf;
    const [base, mod] = n.arguments;
    if (!base || !mod) return;
    const m = skipOuter(mod);
    const isAction = which === "customAction";
    if (ts.isCallExpression(m) && this.a.importOf(m.expression)?.name === "customCtx" && m.arguments[0]) {
      const fn = skipOuter(m.arguments[0]);
      if (ts.isPropertyAccessExpression(fn) && fn.name.text === "wrapDB") {
        this.e.delete(n.getStart(sf), base.getStart(sf));
        this.e.delete(base.end, n.end);
        this.count("customMutation(…, triggers.wrapDB) → builder (triggers are native)");
        return;
      }
      this.e.delete(n.getStart(sf), base.getStart(sf));
      this.e.replace(base.end, m.arguments[0].getStart(sf), isAction ? ".use(async (ctx) => ({ ctx: await (" : ".use((ctx) => ({ ctx: (");
      this.e.replace(m.arguments[0].end, n.end, ")(ctx) }))");
      this.count(`${which}(customCtx) → .use()`);
      this.find(n, "review", "custom-ctx", `${which}(…, customCtx(fn)) became \`.use((ctx) => ({ ctx: fn(ctx) }))\` (docs/design/dx.md §3.8): check it`);
      return;
    }
    if (ts.isObjectLiteralExpression(m)) {
      const input = m.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "input");
      if (input && m.properties.every((p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && ["args", "input"].includes(p.name.text))) {
        this.e.delete(n.getStart(sf), base.getStart(sf));
        this.e.replace(base.end, m.getStart(sf), ".use(");
        this.e.replace(input.getStart(sf), input.initializer.getStart(sf), isAction ? "handler: async (ctx, args) => ({ ctx: (await (" : "handler: (ctx, args) => ({ ctx: (");
        this.e.insert(input.initializer.end, isAction ? ")(ctx, args)).ctx })" : ")(ctx, args).ctx })");
        this.count(`${which}({ args, input }) → .use({ args, handler })`);
        this.find(n, "review", "custom-input", `${which}(…, { args, input }) became \`.use({ args, handler })\` (docs/design/dx.md §3.8): only the returned \`ctx\` is kept; the handler gets every argument (also the middleware's), and a returned \`args\` is not applied`);
        return;
      }
    }
    this.find(n, "manual", "custom-builder", `${which}(…): no automatic port; write it as a \`.use()\` middleware (docs/design/dx.md §3.8)`);
  }

  /** `triggers.register("table", fn)` → `export const tableTrigger = fn` (listed in the generated ember/triggers.ts). */
  private triggerRegistrations(): void {
    const sf = this.sf;
    const regs = this.a.triggerRegistrations.filter((r) => r.call.getSourceFile() === sf);
    const used = new Map<string, number>();
    const registries = new Set<ts.Symbol>();
    for (const r of regs) {
      registries.add(r.registry);
      const stmt = r.call.parent;
      const fnExpr = r.call.arguments[1] && skipOuter(r.call.arguments[1]);
      if (!stmt || !ts.isExpressionStatement(stmt) || stmt.parent !== sf || !r.fn || !fnExpr || !isFnNode(fnExpr)) {
        this.find(r.call, "manual", "trigger", `triggers.register("${r.table}", …): not a top-level registration with an inline function; move it to ember/triggers.ts (defineTriggers) by hand`);
        continue;
      }
      const base = `${r.table.replace(/[^A-Za-z0-9_$]/g, "_")}Trigger`;
      const k = (used.get(base) ?? 0) + 1;
      used.set(base, k);
      const name = k === 1 ? base : `${base}${k}`;
      this.e.replace(stmt.getStart(sf), fnExpr.getStart(sf), `export const ${name} = `);
      this.e.replace(fnExpr.end, stmt.end, ";");
      const fn = fnExpr as FnNode;
      const types = ["TriggerCtx", `Change<${JSON.stringify(r.table)}>`];
      fn.parameters.slice(0, 2).forEach((p, i) => {
        const t = types[i]!;
        if (p.type) this.e.replace(p.type.getStart(sf), p.type.end, t);
        else if (sf.text[p.getStart(sf) - 1] === "(" || sf.text.slice(fn.getStart(sf), p.getStart(sf)).includes("(")) this.e.insert(p.name.end, `: ${t}`);
        else {
          this.e.insert(p.getStart(sf), "(");
          this.e.insert(p.name.end, `: ${t})`);
        }
      });
      this.addImport(`${this.prefix}_generated/server`, "TriggerCtx", true);
      if (fn.parameters.length > 1) this.addImport(`${this.prefix}_generated/server`, "Change", true);
      this.st.triggers.push({ module: this.rel.replace(/\.(ts|tsx|js|mjs)$/, ""), name, table: r.table });
      this.count("triggers.register → export (ember/triggers.ts)");
    }
    // The registry itself goes once nothing else uses it.
    for (const s of registries) {
      const d = s.valueDeclaration;
      const stmt = d?.parent?.parent;
      if (!d || !stmt || !ts.isVariableStatement(stmt) || stmt.declarationList.declarations.length !== 1) continue;
      if (this.refsOutside(s, stmt)) {
        this.find(d, "manual", "trigger", "the convex-helpers Triggers object is used beyond register/wrapDB: port those uses to ember/triggers.ts by hand");
        continue;
      }
      this.deleteLine(stmt);
    }
  }

  /** Whether some reference to `s` is outside `except` and not inside code an edit replaced. */
  private refsOutside(s: ts.Symbol, except?: ts.Node): boolean {
    let hit = false;
    const visit = (n: ts.Node) => {
      if (hit) return;
      if (ts.isIdentifier(n) && !ts.isImportSpecifier(n.parent) && n !== (s.declarations?.[0] as ts.NamedDeclaration | undefined)?.name && this.a.symbolOf(n) === s) {
        const inside = except && n.getStart(this.sf) >= except.getStart(this.sf) && n.end <= except.end;
        if (!inside && !this.e.consumed(n.getStart(this.sf), n.end)) hit = true;
      }
      ts.forEachChild(n, visit);
    };
    visit(this.sf);
    return hit;
  }

  private deleteLine(n: ts.Node): void {
    const text = this.sf.text;
    const start = n.getStart(this.sf);
    let end = skipSpace(text, n.end);
    if (text[end] === "\r") end++;
    if (text[end] === "\n") end++;
    // Keep one blank line where the statement sat between two.
    if (text[start - 1] === "\n" && text[start - 2] === "\n" && text[end] === "\n") end++;
    this.e.delete(start, end);
  }

  // ---------------------------------------------------------------------------------------------- imports

  private imports(): void {
    const sf = this.sf;
    const decls = sf.statements.filter(ts.isImportDeclaration);
    /** Declarations to re-render: decl → kept specs. */
    const keep = new Map<ts.ImportDeclaration, Spec[]>();
    const replaced: ts.ImportDeclaration[] = [];
    const generated = (m: string, mod: string) => new RegExp(`^(\\.{1,2}/)+_generated/${mod}(\\.js)?$`).test(m);
    for (const d of decls) {
      const m = (d.moduleSpecifier as ts.StringLiteral).text;
      const clause = d.importClause;
      const named = clause?.namedBindings && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings : undefined;
      const specs: Array<Spec & { node: ts.ImportSpecifier }> = (named?.elements ?? []).map((s) => ({
        imported: (s.propertyName ?? s.name).text,
        local: s.name.text,
        type: s.isTypeOnly || !!clause?.isTypeOnly,
        node: s,
      }));
      const used = (s: { node: ts.ImportSpecifier }) => {
        const sym = this.a.symbolOf(s.node.name);
        return !sym || this.refsOutside(sym);
      };
      if (m === "convex/server" || m === "convex/values") {
        if (clause?.name || (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings))) {
          this.e.replace(d.moduleSpecifier.getStart(sf), d.moduleSpecifier.end, JSON.stringify(EMBER_SERVER));
          this.find(d, "review", "namespace-import", `\`${this.text(d)}\`: now from ${EMBER_SERVER}; check the names it uses`);
          continue;
        }
        const residual: Spec[] = [];
        for (const s of specs) {
          if (s.imported === "ConvexError") {
            if (used(s)) {
              this.addImport(EMBER_SERVER, "AppError", s.type, s.local);
              this.find(s.node, "review", "convex-error-type", "ConvexError is still used (as a type or a value): it now names Ember's AppError (`code`, `data`)");
            }
            continue;
          }
          if (!used(s)) continue;
          if (SAME_NAME.has(s.imported)) this.addImport(EMBER_SERVER, s.imported, s.type, s.local);
          else if (RENAMED[s.imported]) {
            this.addImport(VALUES_ONLY.has(RENAMED[s.imported]!) && RENAMED[s.imported] !== "JSONValue" ? EMBER_VALUES : EMBER_SERVER, RENAMED[s.imported]!, s.type, s.local);
            const note = RENAME_NOTES[s.imported];
            if (note) this.find(s.node, "review", "renamed-type", `${s.imported} → ${RENAMED[s.imported]}: ${note}`);
          } else if (VALUES_ONLY.has(s.imported)) {
            this.addImport(EMBER_VALUES, s.imported, s.type, s.local);
            this.find(s.node, "info", "values-import", `${s.imported} comes from ${EMBER_VALUES} (add it to package.json; @freecorps/ember-server depends on it)`);
          } else if (used(s)) {
            residual.push(s);
            this.find(s.node, "manual", "unsupported-api", `\`${s.imported}\` from ${m} has no Ember equivalent: rewrite its uses`);
          }
        }
        if (residual.length) keep.set(d, residual);
        else replaced.push(d);
        this.count("imports convex/* → @freecorps/ember-server");
        continue;
      }
      if (generated(m, "dataModel") || generated(m, "api")) {
        const move = generated(m, "dataModel") ? "DataModel" : "components";
        if (!specs.some((s) => s.imported === move)) continue;
        const serverMod = m.replace(/_generated\/(dataModel|api)(\.js)?$/, "_generated/server");
        for (const s of specs) if (s.imported === move && used(s)) this.addImport(serverMod, s.imported, s.type, s.local);
        const rest = specs.filter((s) => s.imported !== move);
        if (rest.length) keep.set(d, rest);
        else replaced.push(d);
        this.count(`${move} from _generated/server`);
        continue;
      }
      if (m === "convex-helpers" || m.startsWith("convex-helpers/")) {
        const rest = specs.filter((s) => used(s));
        for (const s of rest) this.find(s.node, "manual", "convex-helpers", `convex-helpers \`${s.imported}\` (${m}): no automatic port. ${helperHint(s.imported)}`);
        if (rest.length === specs.length && specs.length) continue;
        if (rest.length) keep.set(d, rest);
        else replaced.push(d);
        continue;
      }
      if (m === "convex-test") {
        this.e.replace(d.moduleSpecifier.getStart(sf), d.moduleSpecifier.end, '"@freecorps/ember-testing/convex-test"');
        this.find(d, "review", "convex-test", "convex-test → @freecorps/ember-testing/convex-test (PLAN §22 L8)");
        continue;
      }
      if (m === "convex/react" || m === "convex/browser" || m === "convex/nextjs" || m.startsWith("convex/")) {
        this.find(d, "manual", "unsupported-api", `import from ${m} in server code: use the Ember client packages (@freecorps/ember-client, -react) outside ember/`);
        continue;
      }
      if (m.startsWith("@convex-dev/")) this.find(d, "manual", "convex-component", `${m}: Convex component or package, no automatic port. ${componentHint(m)}`);
    }

    // Render: merge additions into an existing declaration of the same module, else into the first replaced one.
    const existing = new Map<string, ts.ImportDeclaration>();
    for (const d of decls) {
      const c = d.importClause;
      const m = (d.moduleSpecifier as ts.StringLiteral).text;
      if (!replaced.includes(d) && c && !c.name && c.namedBindings && ts.isNamedImports(c.namedBindings) && !existing.has(m)) existing.set(m, d);
    }
    const specsOf = (d: ts.ImportDeclaration): Spec[] =>
      keep.get(d) ??
      ((d.importClause!.namedBindings as ts.NamedImports).elements.map((s) => ({ imported: (s.propertyName ?? s.name).text, local: s.name.text, type: s.isTypeOnly || !!d.importClause!.isTypeOnly })) as Spec[]);
    const fresh: string[] = [];
    for (const [m, adds] of this.adds) {
      const d = existing.get(m);
      if (d) {
        const merged = [...specsOf(d)];
        for (const s of adds) if (!merged.some((x) => x.local === s.local)) merged.push(s);
        keep.set(d, merged);
      } else fresh.push(renderImport(m, adds));
    }
    for (const [d, specs] of keep) this.e.replace(d.getStart(sf), d.end, renderImport((d.moduleSpecifier as ts.StringLiteral).text, specs));
    if (fresh.length) {
      const first = replaced.shift();
      if (first) this.e.replace(first.getStart(sf), first.end, fresh.join("\n"));
      else {
        const last = decls[decls.length - 1];
        const at = last ? last.end : directivesEnd(sf);
        this.e.insert(at, `${at === 0 ? "" : "\n"}${fresh.join("\n")}${at === 0 ? "\n" : ""}`);
      }
    }
    for (const d of replaced) this.deleteLine(d);
  }
}

function renderImport(module: string, specs: Spec[]): string {
  const allType = specs.every((s) => s.type);
  const list = specs.map((s) => `${s.type && !allType ? "type " : ""}${s.imported === s.local ? s.local : `${s.imported} as ${s.local}`}`).join(", ");
  return `import ${allType ? "type " : ""}{ ${list} } from ${JSON.stringify(module)};`;
}

function directivesEnd(sf: ts.SourceFile): number {
  let end = 0;
  for (const s of sf.statements) {
    if (ts.isExpressionStatement(s) && ts.isStringLiteral(s.expression)) end = s.end;
    else break;
  }
  return end;
}

const CODE_LIKE = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;

/** The error code of a ConvexError payload: `"NOT_FOUND"` or `{ code: "NOT_FOUND", ... }` → NotFound. */
export function codeOf(arg: ts.Expression): { code: string; raw: string } | undefined {
  const a = skipOuter(arg);
  let raw: string | undefined;
  if (ts.isStringLiteralLike(a)) raw = a.text;
  else if (ts.isObjectLiteralExpression(a)) {
    for (const p of a.properties) {
      if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === "code" && ts.isStringLiteralLike(p.initializer)) raw = p.initializer.text;
    }
  }
  if (raw === undefined || !CODE_LIKE.test(raw)) return undefined;
  return { code: pascal(raw), raw };
}

/** `NOT_FOUND`, `not-found`, `notFound` → `NotFound` (defineErrors codes are PascalCase). */
export function pascal(raw: string): string {
  const parts = raw.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const out = parts
    .map((p) => (p === p.toUpperCase() || p === p.toLowerCase() ? p.charAt(0).toUpperCase() + p.slice(1).toLowerCase() : p.charAt(0).toUpperCase() + p.slice(1)))
    .join("");
  return (/^[0-9]/.test(out) ? `E${out}` : out).slice(0, 64) || "AppError";
}

function helperHint(name: string): string {
  if (name === "Triggers") return "Ember has triggers natively: ember/triggers.ts with defineTriggers (contracts.md \"Triggers\").";
  if (/^custom(Query|Mutation|Action|Ctx)$/.test(name)) return "Use builder.use(...) middlewares (docs/design/dx.md §3.8).";
  if (/^get(All|OneFrom|ManyFrom|ManyVia)/.test(name)) return "Reads are synchronous: `ids.map((id) => ctx.db.get(id))` or `ctx.db.query(t).withIndex(...).collect()`.";
  if (name === "paginator" || name === "stream" || name === "mergedStream") return "Use ctx.db.query(...).paginate(opts).";
  if (/rowLevelSecurity|wrapDatabase/i.test(name)) return "Check access in a .use() middleware or in `authorize` (queries).";
  if (/^z[A-Z]/.test(name) || name === "zid") return "Use v validators (Ember's v has refinements: .min/.max/.email..., docs/design/dx.md §3.10).";
  return "";
}

function componentHint(m: string): string {
  if (m.startsWith("@convex-dev/auth")) return "Ember auth is Better Auth (ember/auth.config.ts): ctx.auth.getUserIdentity()?.subject is the user id.";
  if (m.startsWith("@convex-dev/rate-limiter")) return "Use @freecorps/ember-rate-limit.";
  if (m.startsWith("@convex-dev/workflow")) return "Use @freecorps/ember-workflows.";
  if (m.startsWith("@convex-dev/aggregate")) return "Use defineTable(...).aggregate(name, ...) and ctx.db.aggregate (built in).";
  if (m.startsWith("@convex-dev/migrations")) return "See PLAN §22 L10 (migrations component).";
  if (m.startsWith("@convex-dev/workpool")) return "See PLAN §22 L11 (workpool component).";
  if (m.startsWith("@convex-dev/agent")) return "See PLAN §22 L12 (agent component).";
  return "";
}
