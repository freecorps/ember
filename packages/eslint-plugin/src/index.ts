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

const SYNC_BUILDERS = new Set(["query", "mutation", "internalQuery", "internalMutation"]);
type Fn = Extract<Node, { type: "ArrowFunctionExpression" | "FunctionExpression" }>;
const isFn = (n: unknown): n is Fn => is(n, "ArrowFunctionExpression") || is(n, "FunctionExpression");
/** The handler passed to a builder (or to its `.use(...)`, a middleware): a function, or `{ handler }`. */
function handlerOf(arg: unknown): Fn | undefined {
  if (isFn(arg)) return arg;
  if (!is(arg, "ObjectExpression")) return undefined;
  for (const p of arg.properties) {
    if (is(p, "Property") && is(p.key, "Identifier") && p.key.name === "handler" && isFn(p.value)) return p.value;
  }
  return undefined;
}
/** `query`, `mutation`, ... or `mutation.use(...)` (builders made from them and stored in variables are not tracked). */
const builderKind = (callee: unknown): string | null => {
  if (is(callee, "Identifier") && SYNC_BUILDERS.has(callee.name)) return callee.name;
  if (is(callee, "MemberExpression") && !callee.computed && is(callee.property, "Identifier") && callee.property.name === "use" && is(callee.object, "Identifier") && SYNC_BUILDERS.has(callee.object.name)) {
    return `${callee.object.name}.use`;
  }
  return null;
};

const noAsyncQueryHandler: Rule = {
  meta: {
    type: "problem",
    docs: { description: "Queries and mutations (and their middlewares) are synchronous: no async handlers", url: `${DOCS}#no-async-query-handler` },
    messages: { async: "{{kind}} handlers must be synchronous (the database API returns values, not Promises): drop `async`; do I/O in an action." },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        const kind = builderKind(node.callee);
        if (!kind) return;
        const h = handlerOf(node.arguments[0]);
        if (h?.async) context.report({ node: h, messageId: "async", data: { kind } });
      },
    };
  },
};

const PUBLIC_BUILDERS = new Set(["query", "mutation", "action"]);
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
        const hasArgs = is(arg, "ObjectExpression") && arg.properties.some((p) => is(p, "Property") && is(p.key, "Identifier") && p.key.name === "args");
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
  },
};

export default plugin;
