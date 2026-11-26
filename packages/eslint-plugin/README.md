# @freecorps/eslint-plugin-ember

ESLint rules that keep Ember code on the typed path. They need no type information.

```js
// eslint.config.js
import ember from "@freecorps/eslint-plugin-ember";

export default [ember.configs.recommended];
```

| Rule | Recommended | What it catches |
|---|---|---|
| `no-string-function-refs` | error | `useQuery("messages:list", …)`, `client.mutation("x:y")`, `ctx.scheduler.runAfter(0, "jobs:run")`: names are not checked and lose args, result and error types. Suggests `api.messages.list` / `internal.jobs.run`. |
| `no-async-query-handler` | error | `async` handlers (or middlewares) of `query` / `mutation` / `internal*`, including builders made with `.use()` (inline, chained or stored in a top-level `const` of the file; a `let` may be reassigned, so it is not followed), `componentBuilders`' `cb.query(...)` and `defineTriggers` triggers: they run in the synchronous transaction (PLAN D6). |
| `require-args-validators` | error | A public `query` / `mutation` / `action` that reads its arguments without `args: { … }`. |
| `no-floating-mutation` | warn | A mutation or action call whose Promise nobody handles (`send(args)` from `useMutation`, `client.mutation(…)`). Use `await`, `.catch()`, `.safe()` or `void`. |
| `no-nondeterministic-in-sync` | error | `Date.now()`, `new Date()` (no arguments), `Date()`, `performance.now()`, `Math.random()`, `crypto.randomUUID()` / `getRandomValues()` in a query, mutation, middleware or trigger. Use `ctx.now` (fixed for the run) and, in mutations, `ctx.random()` (seeded, so the client's optimistic run agrees); a query takes randomness as an argument. |
| `no-db-in-loop` | warn | `ctx.db.get/query/aggregate/insert/patch/replace/delete` once per iteration of a loop or of `xs.map/forEach/...` (N+1), and `await ctx.runQuery/runMutation/runAction` in a loop (sequential round trips). Read one index range instead, batch unbounded writes through the scheduler, or start action calls together with `Promise.all(xs.map(...))` (not reported). `Promise.all(ids.map((id) => ctx.db.get(id)))` is still reported: the database API is synchronous, so it is one read per element all the same. A function declared in the loop is not reported (defined, not run). |
| `no-collect-length` | warn | `ctx.db.query(...)...collect().length`: every document is read to count them. Use a materialized aggregate (`.aggregate(name, { by })` + `ctx.db.aggregate(table, name).get([...]).count`), `.first() !== null`, or `.take(n).length`. |
| `no-throw-raw-error` | warn | `throw new Error(...)` (or `TypeError` / `RangeError`) in a public `query` / `mutation` / `action` (handler, `authorize`, middleware): the client gets an untyped `Error` it cannot match. Declare it with `defineErrors` and `throw errors.X(...)` / `ctx.fail.X(...)`. Internal functions, module helpers, HTTP actions, triggers and errors caught on the spot are not reported. |

All rules read only the syntax: a handler is a function passed to a builder (`query({ handler })`, `query(fn)`,
`authed({ ... })` where `authed = query.use(mw)` in the same file), and helpers in other modules are not followed.
Silence a finding you accept with a reason: `// eslint-disable-next-line ember/no-db-in-loop -- bounded by one list`.
