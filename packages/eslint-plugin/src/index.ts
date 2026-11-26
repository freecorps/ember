// `@freecorps/eslint-plugin-ember` (docs/design/dx.md §3.12): rules that keep Ember code on the typed path. They need no
// type information (fast, any parser config): what they check is visible in the syntax.
//
//   // eslint.config.js
//   import ember from "@freecorps/eslint-plugin-ember";
//   export default [ember.configs.recommended];

import type { Rule as ESLintRule } from "eslint";

/** An ESTree node (ESLint's, discriminated by `type`). */
type Node = ESLintRule.Node;
type Rule = ESLintRule.RuleModule;
type Fix = ESLintRule.RuleFixer;
type Context = ESLintRule.RuleContext;
/** Narrows to one node type (ESLint hands listeners the matching node; this keeps the code honest). */
const is = <T extends Node["type"]>(n: unknown, type: T): n is Extract<Node, { type: T }> => typeof n === "object" && n !== null && (n as { type?: unknown }).type === type;

const DOCS = "https://github.com/freecorps/ember/blob/main/packages/eslint-plugin/README.md";
const REF = /^[A-Za-z0-9_@$/-]+:[A-Za-z_$][\w$]*$/;

/** Calls that take a function reference first (hooks, React Query helpers, the client, ctx.run*). */
const REF_FIRST = new Set([
  "useQuery",
  "useQuerySnapshot",
  "useQueryState",
  "useSuspenseQuery",
  "usePaginatedQuery",
  "useMutation",
  "useMutationState",
  "useAction",
  "emberQuery",
  "emberQueryOneShot",
  "emberMutation",
  "emberMutationFn",
  "optimistic",
  "runQuery",
  "runMutation",
  "runAction",
  "watchQuery",
  "subscribe",
  "localQueryResult",
]);
/** Client methods (`client.query(ref, ...)`): only as member calls, `query` alone is the server builder. */
const REF_FIRST_MEMBER = new Set(["query", "mutation", "action"]);
/** `ctx.scheduler.runAfter(ms, ref)` / `runAt(ts, ref)`. */
const REF_SECOND = new Set(["runAfter", "runAt"]);
/** `db` or `<x>.db`: the database handle, whose `query(table)` takes a table name. */
const isDb = (n: unknown): boolean =>
  (is(n, "Identifier") && n.name === "db") || (is(n, "MemberExpression") && is(n.property, "Identifier") && n.property.name === "db");

const calleeName = (callee: unknown): { name: string; member: boolean } | null => {
  if (is(callee, "Identifier")) return { name: callee.name, member: false };
  if (is(callee, "MemberExpression") && !callee.computed && is(callee.property, "Identifier")) return { name: callee.property.name, member: true };
  return null;
};
const stringValue = (n: unknown): string | null => {
  if (is(n, "Literal") && typeof n.value === "string") return n.value;
  if (is(n, "TemplateLiteral") && n.expressions.length === 0) return n.quasis[0]?.value.cooked ?? null;
  return null;
};
/** A property's static key: `{ a: ... }` / `{ "a": ... }` (not computed `[a]`). */
const keyName = (p: unknown): string | null => {
  if (!is(p, "Property") || p.computed) return null;
  return is(p.key, "Identifier") ? p.key.name : stringValue(p.key);
};
/** `"chat/messages:send"` → `api.chat.messages.send` (null for component names, which have no api path). */
const apiPath = (name: string): string | null => {
  if (name.includes("@") || name.includes("$")) return null;
  const [mod, fn] = name.split(":") as [string, string];
  const parts = [...mod.split("/"), fn];
  return parts.every((p) => /^[A-Za-z_$][\w$]*$/.test(p)) ? `api.${parts.join(".")}` : null;
};

const noStringFunctionRefs: Rule = {
  meta: {
    type: "problem",
    docs: { description: "Call Ember functions through the generated `api` (typed args, result and errors), not by name", url: `${DOCS}#no-string-function-refs` },
    messages: {
      string: 'Use a reference (api.module.fn) instead of the name "{{name}}": the name is not checked and its args, result and errors are untyped.',
      suggest: "Replace with {{path}}",
    },
    schema: [],
    hasSuggestions: true,
  },
  create(context) {
    return {
      CallExpression(node) {
        const c = calleeName(node.callee);
        if (!c) return;
        // `ctx.db.query("auth:member")`: a (replica) table name, not a function.
        if (c.member && isDb((node.callee as { object?: unknown }).object)) return;
        const at = REF_FIRST.has(c.name) || (c.member && REF_FIRST_MEMBER.has(c.name)) ? 0 : REF_SECOND.has(c.name) && c.member ? 1 : -1;
        if (at < 0) return;
        const arg = node.arguments[at];
        const name = stringValue(arg);
        if (!arg || name === null || !REF.test(name)) return;
        const path = apiPath(name);
        // Server-side calls (ctx.run*, the scheduler) usually target internal functions: offer both.
        const serverSide = at === 1 || c.name.startsWith("run");
        const paths = path ? (serverSide ? [path.replace(/^api\./, "internal."), path] : [path]) : [];
        context.report({
          node: arg,
          messageId: "string",
          data: { name },
          ...(paths.length ? { suggest: paths.map((p) => ({ messageId: "suggest", data: { path: p }, fix: (f: Fix) => f.replaceText(arg, p) })) } : {}),
        });
      },
    };
  },
};

type Fn = Extract<Node, { type: "ArrowFunctionExpression" | "FunctionExpression" }>;
const isFn = (n: unknown): n is Fn => is(n, "ArrowFunctionExpression") || is(n, "FunctionExpression");
/** The handler passed to a builder (or to its `.use(...)`, a middleware): a function, or `{ handler }` (or `field`). */
function handlerOf(arg: unknown, field = "handler"): Fn | undefined {
  if (isFn(arg)) return field === "handler" ? arg : undefined;
  if (!is(arg, "ObjectExpression")) return undefined;
  for (const p of arg.properties) {
    if (is(p, "Property") && keyName(p) === field && isFn(p.value)) return p.value;
  }
  return undefined;
}

// ------------------------------------------------------------------ builders and the functions they run

type Kind = "query" | "mutation" | "action" | "http";
/** A function builder: what it builds, who may call it, and its name as written (for messages). */
type Builder = { kind: Kind; visibility: "public" | "internal"; name: string };
const BUILDERS: Record<string, Omit<Builder, "name">> = {};
for (const [k, kind] of [["query", "query"], ["mutation", "mutation"], ["action", "action"]] as const) {
  const cap = k[0]!.toUpperCase() + k.slice(1);
  BUILDERS[k] = BUILDERS[`${k}Generic`] = { kind, visibility: "public" };
  BUILDERS[`internal${cap}`] = BUILDERS[`internal${cap}Generic`] = { kind, visibility: "internal" };
}
BUILDERS.httpAction = BUILDERS.httpActionGeneric = { kind: "http", visibility: "public" };
/** Builders stored in variables of the file: `const authed = mutation.use(mw)` (name → builder). */
type Aliases = Map<string, Builder>;

const isUse = (n: unknown): n is Extract<Node, { type: "MemberExpression" }> => is(n, "MemberExpression") && !n.computed && is(n.property, "Identifier") && n.property.name === "use";

/**
 * The builder an expression is: `query`, `internalMutationGeneric`, `cb.query` (componentBuilders), a variable
 * holding one, or any of them with `.use(mw)` applied (a builder too).
 */
function builderOf(n: unknown, aliases: Aliases): Builder | null {
  if (is(n, "Identifier")) return aliases.get(n.name) ?? (BUILDERS[n.name] ? { ...BUILDERS[n.name]!, name: n.name } : null);
  if (is(n, "MemberExpression") && !n.computed && is(n.property, "Identifier") && BUILDERS[n.property.name]) return { ...BUILDERS[n.property.name]!, name: n.property.name };
  if (is(n, "CallExpression") && isUse(n.callee)) return builderOf(n.callee.object, aliases);
  return null;
}

/**
 * Top-level `const x = <builder>` (also exported), chains included. Only `const`: a `let` may be reassigned
 * (`let b = query; b = action`), so what it holds at a call is not known from its declaration.
 */
function collectAliases(program: unknown): Aliases {
  const aliases: Aliases = new Map();
  if (!is(program, "Program")) return aliases;
  const decls: Array<[string, unknown]> = [];
  for (const st of program.body) {
    const d = is(st, "VariableDeclaration") ? st : is(st, "ExportNamedDeclaration") && is(st.declaration, "VariableDeclaration") ? st.declaration : null;
    if (d?.kind === "const") for (const v of d.declarations) if (is(v.id, "Identifier") && v.init && (isUse((v.init as { callee?: unknown }).callee) || is(v.init, "Identifier") || is(v.init, "MemberExpression"))) decls.push([v.id.name, v.init]);
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const [name, init] of decls) {
      if (aliases.has(name)) continue;
      const b = builderOf(init, aliases);
      if (b) {
        aliases.set(name, { ...b, name });
        changed = true;
      }
    }
  }
  return aliases;
}

/** What a function is to Ember: a builder's handler / `authorize`, a middleware, or a trigger. */
type Role = { builder: Builder; role: "handler" | "authorize" | "middleware" | "trigger" };

const parentOf = (n: unknown): unknown => (n as { parent?: unknown }).parent;
const TRIGGERS_BUILDER: Builder = { kind: "mutation", visibility: "internal", name: "defineTriggers" };

function roleOf(fn: Fn, aliases: Aliases): Role | null {
  let arg: unknown = fn;
  let field: "handler" | "authorize" = "handler";
  const parent = parentOf(fn);
  const key = keyName(parent);
  if (is(parent, "Property") && parent.value === fn && key !== null) {
    const obj = parentOf(parent);
    // defineTriggers({ table: fn }) / defineTriggers({ "table": [fn, fn] })
    const call = parentOf(obj);
    if (is(call, "CallExpression") && call.arguments[0] === obj && is(call.callee, "Identifier") && call.callee.name === "defineTriggers") return { builder: TRIGGERS_BUILDER, role: "trigger" };
    if (key !== "handler" && key !== "authorize") return null;
    field = key;
    arg = obj;
  } else if (is(parent, "ArrayExpression")) {
    const prop = parentOf(parent);
    const call = parentOf(parentOf(prop));
    if (is(prop, "Property") && is(call, "CallExpression") && is(call.callee, "Identifier") && call.callee.name === "defineTriggers") return { builder: TRIGGERS_BUILDER, role: "trigger" };
    return null;
  }
  const call = parentOf(arg);
  if (!is(call, "CallExpression") || call.arguments[0] !== arg) return null;
  if (isUse(call.callee)) {
    const b = builderOf(call.callee.object, aliases);
    return b && field === "handler" ? { builder: { ...b, name: `${b.name}.use` }, role: "middleware" } : null;
  }
  const b = builderOf(call.callee, aliases);
  return b ? { builder: b, role: field } : null;
}

/** The innermost function around `node` that Ember runs as a handler, middleware or trigger (callbacks in it included). */
function enclosingRole(context: Context, node: Node, aliases: Aliases): Role | null {
  const chain = context.sourceCode.getAncestors(node);
  for (let i = chain.length - 1; i >= 0; i--) {
    const a = chain[i];
    if (isFn(a)) {
      const r = roleOf(a, aliases);
      if (r) return r;
    }
  }
  return null;
}

/** Per-file builder aliases, computed once. */
function aliasesOf(context: Context): () => Aliases {
  let cached: Aliases | undefined;
  return () => (cached ??= collectAliases(context.sourceCode.ast));
}

const noAsyncQueryHandler: Rule = {
  meta: {
    type: "problem",
    docs: { description: "Queries, mutations, their middlewares and triggers are synchronous: no async handlers", url: `${DOCS}#no-async-query-handler` },
    messages: { async: "{{kind}} handlers must be synchronous (the database API returns values, not Promises): drop `async`; do I/O in an action." },
    schema: [],
  },
  create(context) {
    const aliases = aliasesOf(context);
    const check = (fn: Fn) => {
      if (!fn.async) return;
      const r = roleOf(fn, aliases());
      // A query's `authorize` runs in the same synchronous transaction; action middlewares may be async.
      if (r && (r.builder.kind === "query" || r.builder.kind === "mutation")) context.report({ node: fn, messageId: "async", data: { kind: r.builder.name } });
    };
    return { ArrowFunctionExpression: check, FunctionExpression: check };
  },
};

// ------------------------------------------------------------------ no-nondeterministic-in-sync

/** `a.b` as written (identifiers only), or null. `globalThis.crypto.x` reads as `crypto.x`. */
const dotted = (n: unknown): string | null => {
  if (is(n, "Identifier")) return n.name;
  if (is(n, "MemberExpression") && !n.computed && is(n.property, "Identifier")) {
    const o = dotted(n.object);
    if (o === null) return null;
    return o === "globalThis" || o === "window" || o === "self" ? n.property.name : `${o}.${n.property.name}`;
  }
  return null;
};
const CLOCK = new Set(["Date.now", "performance.now"]);
const RANDOM = new Set(["Math.random", "crypto.randomUUID", "crypto.getRandomValues"]);

const noNondeterministicInSync: Rule = {
  meta: {
    type: "problem",
    docs: { description: "No clock or randomness of the runtime in queries, mutations and triggers: use `ctx.now` / `ctx.random()`", url: `${DOCS}#no-nondeterministic-in-sync` },
    messages: {
      clock: "`{{call}}` in a {{kind}}: use `ctx.now` (the function's time, fixed for the whole run, so re-runs and client replays see the same value).",
      randomMutation: "`{{call}}` in a {{kind}}: use `ctx.random()` (seeded per mutation, so the client's optimistic run and the server agree; ids come from `ctx.db.insert`).",
      randomQuery: "`{{call}}` in a {{kind}}: a query must give the same result for the same data (its result is cached, shared and re-run on every change). Take the value as an argument, or draw it in a mutation with `ctx.random()`.",
    },
    schema: [],
  },
  create(context) {
    const aliases = aliasesOf(context);
    /** `what`: the clock or randomness; `call`: as the message shows it. */
    const check = (node: Node, what: "clock" | "random", call: string) => {
      const r = enclosingRole(context, node, aliases());
      if (!r || (r.builder.kind !== "query" && r.builder.kind !== "mutation")) return;
      const kind = r.role === "trigger" ? "trigger" : r.role === "middleware" ? `${r.builder.kind} middleware` : r.builder.name;
      const messageId = what === "clock" ? "clock" : r.builder.kind === "query" ? "randomQuery" : "randomMutation";
      context.report({ node, messageId, data: { call, kind } });
    };
    return {
      CallExpression(node) {
        const name = dotted(node.callee);
        if (!name) return;
        if (CLOCK.has(name)) check(node, "clock", `${name}()`);
        else if (RANDOM.has(name)) check(node, "random", `${name}()`);
        else if (name === "Date") check(node, "clock", "Date()"); // a string of the current time
      },
      NewExpression(node) {
        if (dotted(node.callee) === "Date" && node.arguments.length === 0) check(node, "clock", "new Date()");
      },
    };
  },
};

// ------------------------------------------------------------------ no-collect-length

const memberName = (n: unknown): string | null => (is(n, "MemberExpression") && !n.computed && is(n.property, "Identifier") ? n.property.name : null);
/** `x.query(...)...` / `x.withIndex(...)`: a database query chain (not any `.collect()`). */
function isDbChain(n: unknown): boolean {
  for (let cur = n; ; ) {
    if (is(cur, "CallExpression")) {
      const m = memberName(cur.callee);
      if (m === "query" || m === "withIndex" || m === "withSearchIndex") return true;
      cur = cur.callee;
    } else if (is(cur, "MemberExpression")) cur = cur.object;
    else return false;
  }
}

const noCollectLength: Rule = {
  meta: {
    type: "suggestion",
    docs: { description: "Do not load every document to count them (`.collect().length`)", url: `${DOCS}#no-collect-length` },
    messages: {
      length:
        "`.collect().length` reads every matching document to count them (all of them count against `documentsRead` and join the read set). Keep a count with a materialized aggregate (`defineTable(...).aggregate(name, { by })`, then `ctx.db.aggregate(table, name).get([...]).count`), check existence with `.first() !== null`, or bound it with `.take(n).length`.",
    },
    schema: [],
  },
  create(context) {
    return {
      MemberExpression(node) {
        if (node.computed || !is(node.property, "Identifier") || node.property.name !== "length") return;
        const call = node.object;
        if (!is(call, "CallExpression") || call.arguments.length !== 0 || memberName(call.callee) !== "collect") return;
        if (isDbChain((call.callee as { object?: unknown }).object)) context.report({ node, messageId: "length" });
      },
    };
  },
};

// ------------------------------------------------------------------ no-db-in-loop

const DB_READS = new Set(["get", "query", "aggregate"]);
const DB_WRITES = new Set(["insert", "patch", "replace", "delete", "increment"]);
const RUN = new Set(["runQuery", "runMutation", "runAction"]);
/** Array methods whose callback runs once per element. */
const ITERATORS = new Set(["forEach", "map", "flatMap", "filter", "reduce", "reduceRight", "some", "every", "find", "findIndex", "findLast", "findLastIndex"]);
const PARALLEL = new Set(["Promise.all", "Promise.allSettled", "Promise.any", "Promise.race"]);
const LOOPS = new Set(["ForStatement", "ForInStatement", "ForOfStatement", "WhileStatement", "DoWhileStatement"]);

/**
 * Whether `node` runs once per iteration of a loop of its own function: a loop body (or its per-iteration test),
 * or a callback of `xs.map/forEach/...` / `Array.from(xs, fn)`. Other nested functions (declarations too) end the
 * search: defined, not necessarily run. `"parallel"`: the callback of `Promise.all(xs.map(...))`, which starts the
 * calls together; still once per element, so only the round trips of actions are not repeated one after another.
 */
function inLoop(context: Context, node: Node): false | "sequential" | "parallel" {
  const chain = context.sourceCode.getAncestors(node);
  let child: unknown = node;
  for (let i = chain.length - 1; i >= 0; i--) {
    const a = chain[i] as Node;
    if (LOOPS.has(a.type)) {
      const l = a as unknown as { body: unknown; test?: unknown; update?: unknown };
      if (child === l.body || (a.type !== "ForInStatement" && a.type !== "ForOfStatement" && (child === l.test || child === l.update))) return "sequential";
    }
    if (is(a, "FunctionDeclaration")) return false;
    if (isFn(a)) {
      const call = parentOf(a);
      if (!is(call, "CallExpression") || !call.arguments.includes(a as never)) return false;
      const m = memberName(call.callee);
      const iterates = (m !== null && ITERATORS.has(m) && call.arguments[0] === a) || (dotted(call.callee) === "Array.from" && call.arguments[1] === a);
      if (!iterates) return false;
      const outer = parentOf(call);
      if (is(outer, "CallExpression") && outer.arguments[0] === call && PARALLEL.has(dotted(outer.callee) ?? "")) return "parallel";
      return "sequential";
    }
    child = a;
  }
  return false;
}

const noDbInLoop: Rule = {
  meta: {
    type: "suggestion",
    docs: { description: "No database call (or awaited ctx.run*) per loop iteration: read ranges, batch, or run together", url: `${DOCS}#no-db-in-loop` },
    messages: {
      read: "`{{call}}` runs once per iteration (N+1): each lookup counts against this transaction's read limits and joins the read set. Read the rows with one index range (`withIndex`) or an aggregate, or keep the list bounded. (The database API is synchronous: there is nothing to `Promise.all` here.)",
      write: "`{{call}}` writes once per iteration, all in this mutation's transaction: fine for a short, bounded list; an unbounded one runs into `rowsWritten`. Split the work into batches that reschedule themselves (`ctx.scheduler.runAfter`).",
      roundTrip: "`await {{call}}` in a loop is one round trip per iteration, one after another: do the work in one query or mutation (many rows, one transaction), or start the calls together with `Promise.all`.",
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        const m = memberName(node.callee);
        if (!m) return;
        const object = (node.callee as { object?: unknown }).object;
        let messageId: "read" | "write" | "roundTrip";
        if (isDb(object) && (DB_READS.has(m) || DB_WRITES.has(m))) messageId = DB_READS.has(m) ? "read" : "write";
        else if (RUN.has(m) && is(parentOf(node), "AwaitExpression")) messageId = "roundTrip";
        else return;
        const loop = inLoop(context, node);
        // `Promise.all(ids.map((id) => ctx.db.get(id)))`: the database API is synchronous, so the reads still run
        // one per element (N+1); only an action's `await ctx.run*` calls really run together there.
        if (!loop || (loop === "parallel" && messageId === "roundTrip")) return;
        const call = `${context.sourceCode.getText(object as Node)}.${m}()`;
        context.report({ node, messageId, data: { call } });
      },
    };
  },
};

// ------------------------------------------------------------------ no-throw-raw-error

const RAW_ERRORS = new Set(["Error", "TypeError", "RangeError"]);
const noThrowRawError: Rule = {
  meta: {
    type: "suggestion",
    docs: { description: "Public functions throw application errors (`defineErrors`), not plain `Error`s", url: `${DOCS}#no-throw-raw-error` },
    messages: {
      raw: "`throw new {{name}}(...)` in a public {{kind}} is not part of its contract: the client gets an untyped system error (code `Error`) that `isError(e, fn, code)` cannot match. Declare it with `defineErrors` and `throw errors.X(...)` (or `ctx.fail.X(...)`): a typed code, data and message. Plain errors are fine in internal functions and helpers.",
    },
    schema: [],
  },
  create(context) {
    const aliases = aliasesOf(context);
    return {
      ThrowStatement(node) {
        const e = node.argument;
        if (!(is(e, "NewExpression") || is(e, "CallExpression")) || !is(e.callee, "Identifier") || !RAW_ERRORS.has(e.callee.name)) return;
        // Caught right there (`try { ... throw new Error() } catch`): not the function's error.
        const chain = context.sourceCode.getAncestors(node);
        let child: unknown = node;
        for (let i = chain.length - 1; i >= 0; i--) {
          const a = chain[i];
          if (isFn(a) || is(a, "FunctionDeclaration")) break;
          if (is(a, "TryStatement") && a.handler && child === a.block) return;
          child = a;
        }
        const r = enclosingRole(context, node, aliases());
        if (!r || r.builder.visibility !== "public" || r.builder.kind === "http" || r.role === "trigger") return;
        context.report({ node, messageId: "raw", data: { name: e.callee.name, kind: r.builder.kind } });
      },
    };
  },
};

const PUBLIC_BUILDERS = new Set(["query", "mutation", "action", "queryGeneric", "mutationGeneric", "actionGeneric"]);
const requireArgsValidators: Rule = {
  meta: {
    type: "problem",
    docs: { description: "Public functions that read arguments declare their validators (`args`)", url: `${DOCS}#require-args-validators` },
    messages: { args: "This public {{kind}} reads its arguments without validating them: declare `args: { ... }` (clients can send anything)." },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        if (!is(node.callee, "Identifier") || !PUBLIC_BUILDERS.has(node.callee.name)) return;
        const arg = node.arguments[0];
        const h = handlerOf(arg);
        if (!arg || !h || h.params.length < 2) return;
        const hasArgs = is(arg, "ObjectExpression") && arg.properties.some((p) => keyName(p) === "args");
        if (!hasArgs) context.report({ node: arg, messageId: "args", data: { kind: node.callee.name } });
      },
    };
  },
};

/** Hooks returning a function that returns a Promise. */
const PROMISE_HOOKS = new Set(["useMutation", "useAction"]);
const noFloatingMutation: Rule = {
  meta: {
    type: "problem",
    docs: { description: "Handle the Promise of a mutation or action (await, .catch, or void on purpose)", url: `${DOCS}#no-floating-mutation` },
    messages: { floating: "This {{what}} returns a Promise nobody handles: a failure (validation, an application error, the network) is lost. `await` it, `.catch()` it, use `.safe()`, or `void` it on purpose." },
    schema: [],
  },
  create(context) {
    const fromHooks = new Set<string>();
    return {
      VariableDeclarator(node) {
        const init = node.init;
        if (!is(node.id, "Identifier") || !is(init, "CallExpression")) return;
        // const send = useMutation(api.x.y) / useMutation(api.x.y).withOptimisticUpdate(...)
        let callee = init.callee;
        if (is(callee, "MemberExpression") && is(callee.property, "Identifier") && callee.property.name === "withOptimisticUpdate" && is(callee.object, "CallExpression")) callee = callee.object.callee;
        if (is(callee, "Identifier") && PROMISE_HOOKS.has(callee.name)) fromHooks.add(node.id.name);
      },
      ExpressionStatement(node) {
        const e = node.expression;
        if (!is(e, "CallExpression")) return;
        const c = e.callee;
        if (is(c, "Identifier") && fromHooks.has(c.name)) context.report({ node: e, messageId: "floating", data: { what: `call of ${c.name}` } });
        else if (is(c, "MemberExpression") && !c.computed && is(c.property, "Identifier") && (c.property.name === "mutation" || c.property.name === "action") && e.arguments.length > 0 && !is(e.arguments[0], "ObjectExpression")) {
          context.report({ node: e, messageId: "floating", data: { what: `${c.property.name}()` } });
        }
      },
    };
  },
};

export const rules = {
  "no-string-function-refs": noStringFunctionRefs,
  "no-async-query-handler": noAsyncQueryHandler,
  "require-args-validators": requireArgsValidators,
  "no-floating-mutation": noFloatingMutation,
  "no-nondeterministic-in-sync": noNondeterministicInSync,
  "no-db-in-loop": noDbInLoop,
  "no-collect-length": noCollectLength,
  "no-throw-raw-error": noThrowRawError,
};

const plugin = {
  meta: { name: "@freecorps/eslint-plugin-ember" },
  rules,
  configs: {} as Record<string, unknown>,
};
plugin.configs.recommended = {
  name: "ember/recommended",
  plugins: { ember: plugin },
  rules: {
    "ember/no-string-function-refs": "error",
    "ember/no-async-query-handler": "error",
    "ember/require-args-validators": "error",
    "ember/no-floating-mutation": "warn",
    "ember/no-nondeterministic-in-sync": "error",
    "ember/no-db-in-loop": "warn",
    "ember/no-collect-length": "warn",
    "ember/no-throw-raw-error": "warn",
  },
};

export default plugin;
