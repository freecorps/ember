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
| `no-async-query-handler` | error | `async` handlers (or middlewares) of `query` / `mutation` / `internal*`: they must be synchronous (PLAN D6). |
| `require-args-validators` | error | A public `query` / `mutation` / `action` that reads its arguments without `args: { … }`. |
| `no-floating-mutation` | warn | A mutation or action call whose Promise nobody handles (`send(args)` from `useMutation`, `client.mutation(…)`). Use `await`, `.catch()`, `.safe()` or `void`. |
