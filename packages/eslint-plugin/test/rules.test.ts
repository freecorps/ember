import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import { afterAll, describe, it } from "vitest";
import plugin, { rules } from "../src/index.ts";

// RuleTester's hooks for vitest (static properties the typings leave out).
Object.assign(RuleTester, { afterAll, describe, it, itOnly: it.only });

const tester = new RuleTester({ languageOptions: { parser: tsParser, ecmaVersion: 2023, sourceType: "module" } });

tester.run("no-string-function-refs", rules["no-string-function-refs"] as never, {
  valid: [
    "useQuery(api.messages.list, { channel })",
    "client.query(api.messages.list, {})",
    'ctx.db.query("messages")',
    // Replica tables are named `<source>:<table>`, which looks like a function name.
    'ctx.db.query("auth:member").withIndex("by_userId", (q) => q.eq("userId", id)).first()',
    'db.query("auth:user").collect()',
    'query({ handler: () => 1 })',
    'ctx.scheduler.runAfter(0, internal.jobs.run, {})',
    'useQuery(unsafeRef("messages:list"), {})',
    'console.log("a:b")',
  ],
  invalid: [
    {
      code: 'useQuery("messages:list", { channel })',
      errors: [{ messageId: "string", suggestions: [{ messageId: "suggest", output: "useQuery(api.messages.list, { channel })" }] }],
    },
    {
      code: 'await client.mutation("chat/messages:send", args)',
      errors: [{ messageId: "string", suggestions: [{ messageId: "suggest", output: "await client.mutation(api.chat.messages.send, args)" }] }],
    },
    {
      code: 'ctx.scheduler.runAfter(1000, "jobs:run", {})',
      errors: [
        {
          messageId: "string",
          suggestions: [
            { messageId: "suggest", output: "ctx.scheduler.runAfter(1000, internal.jobs.run, {})" },
            { messageId: "suggest", output: "ctx.scheduler.runAfter(1000, api.jobs.run, {})" },
          ],
        },
      ],
    },
    { code: 'ctx.runMutation("@rateLimit/lib:limit", {})', errors: [{ messageId: "string", suggestions: [] }] },
  ],
});

tester.run("no-async-query-handler", rules["no-async-query-handler"] as never, {
  valid: [
    "query({ handler: (ctx) => 1 })",
    "query({ authorize: (ctx) => {}, handler: (ctx) => 1 })",
    "action({ handler: async (ctx) => 1 })",
    "mutation((ctx) => null)",
    // Action middlewares and actions built from a `.use()` chain may be async.
    "const authedAction = action.use(async (ctx) => ({ ctx: {} })); export const a = authedAction({ handler: async (ctx) => 1 });",
    "export default defineTriggers({ messages: (ctx, change) => {}, log: [(ctx) => {}, function (ctx) {}] })",
    // Not builders: the client, express-like `.use`, a promise callback.
    "client.query(api.x.y, { handler: async () => 1 })",
    "app.use(async (req, res) => {})",
    "query({ handler: (ctx) => { const later = async () => 1; return 1; } })",
    // A `let` may be reassigned: what it holds at the call is not known from its declaration.
    "let build = query; build = action; export const a = build({ handler: async () => 1 });",
    "let authed = query.use(mw); authed = action.use(mw); export const a = authed({ handler: async () => 1 });",
  ],
  invalid: [
    { code: "query({ args: {}, handler: async (ctx) => 1 })", errors: [{ messageId: "async", data: { kind: "query" } }] },
    { code: "internalMutation(async (ctx) => null)", errors: [{ messageId: "async" }] },
    { code: "queryGeneric({ handler: async (ctx) => 1 })", errors: [{ messageId: "async" }] },
    { code: "query({ authorize: async (ctx) => {}, handler: (ctx) => 1 })", errors: [{ messageId: "async" }] },
    { code: "const authed = mutation.use(async (ctx) => ({ ctx: {} }))", errors: [{ messageId: "async", data: { kind: "mutation.use" } }] },
    // Triggers run inside the mutation's transaction.
    { code: "export default defineTriggers({ messages: async (ctx, change) => {} })", errors: [{ messageId: "async", data: { kind: "defineTriggers" } }] },
    { code: "export default defineTriggers({ messages: [(ctx) => {}, async function (ctx) {}] })", errors: [{ messageId: "async" }] },
    // Quoted keys are the same keys.
    { code: 'export default defineTriggers({ "messages": async () => {} })', errors: [{ messageId: "async", data: { kind: "defineTriggers" } }] },
    { code: 'query({ "handler": async (ctx) => 1 })', errors: [{ messageId: "async", data: { kind: "query" } }] },
    // Handlers of builders made with `.use()`: inline, chained, or stored in a variable (also exported, also chained).
    { code: "export const x = query.use(mw)({ handler: async (ctx) => 1 })", errors: [{ messageId: "async" }] },
    { code: "export const x = mutation.use(a).use(b)(async (ctx) => 1)", errors: [{ messageId: "async" }] },
    { code: "export const authed = mutation.use(mw); export const add = authed({ args: {}, handler: async (ctx) => 1 });", errors: [{ messageId: "async", data: { kind: "authed" } }] },
    { code: "const authed = query.use(mw); const admin = authed.use(mw2); export const x = admin({ handler: async (ctx) => 1 });", errors: [{ messageId: "async", data: { kind: "admin" } }] },
    { code: "const authed = query.use(mw); const admin = authed.use(async (ctx) => ({}));", errors: [{ messageId: "async", data: { kind: "authed.use" } }] },
    // componentBuilders: `cb.query(...)` / destructured.
    { code: "const cb = componentBuilders(); export const get = cb.query({ handler: async (ctx) => 1 });", errors: [{ messageId: "async" }] },
    // A `const` alias is still tracked.
    { code: "const build = query; export const a = build({ handler: async () => 1 });", errors: [{ messageId: "async", data: { kind: "build" } }] },
  ],
});

tester.run("no-nondeterministic-in-sync", rules["no-nondeterministic-in-sync"] as never, {
  valid: [
    "mutation({ handler: (ctx) => ctx.db.insert('t', { at: ctx.now, n: ctx.random() }) })",
    "action({ handler: async (ctx) => ({ at: Date.now(), id: crypto.randomUUID(), n: Math.random() }) })",
    "internalAction({ handler: async () => new Date() })",
    "query({ handler: (ctx) => new Date(ctx.now).toISOString() })",
    // Helpers outside any handler are not checked (syntax only).
    "function stamp() { return Date.now(); }",
    "const t = Date.now();",
  ],
  invalid: [
    { code: "query({ handler: (ctx) => Date.now() })", errors: [{ messageId: "clock", data: { call: "Date.now()", kind: "query" } }] },
    { code: "mutation({ handler: (ctx) => ctx.db.insert('t', { at: new Date().getTime() }) })", errors: [{ messageId: "clock", data: { call: "new Date()", kind: "mutation" } }] },
    { code: "internalMutation({ handler: (ctx) => Math.random() })", errors: [{ messageId: "randomMutation", data: { call: "Math.random()", kind: "internalMutation" } }] },
    { code: "query({ handler: (ctx) => crypto.randomUUID() })", errors: [{ messageId: "randomQuery" }] },
    { code: "mutation({ handler: (ctx) => globalThis.crypto.randomUUID() })", errors: [{ messageId: "randomMutation", data: { call: "crypto.randomUUID()", kind: "mutation" } }] },
    { code: "internalQuery({ handler: (ctx) => performance.now() })", errors: [{ messageId: "clock" }] },
    { code: "query({ handler: (ctx) => Date() })", errors: [{ messageId: "clock", data: { call: "Date()", kind: "query" } }] },
    // In callbacks of the handler, in authorize, middlewares and triggers.
    { code: "query({ handler: (ctx) => ctx.db.query('t').collect().map((r) => ({ ...r, age: Date.now() - r._creationTime })) })", errors: [{ messageId: "clock" }] },
    { code: "query({ authorize: (ctx) => { if (Date.now() > 0) return; }, handler: (ctx) => 1 })", errors: [{ messageId: "clock" }] },
    { code: "const authed = mutation.use((ctx) => ({ ctx: { at: Date.now() } }))", errors: [{ messageId: "clock", data: { call: "Date.now()", kind: "mutation middleware" } }] },
    { code: "export default defineTriggers({ log: (ctx, c) => { ctx.db.insert('audit', { n: Math.random() }); } })", errors: [{ messageId: "randomMutation", data: { call: "Math.random()", kind: "trigger" } }] },
  ],
});

tester.run("no-collect-length", rules["no-collect-length"] as never, {
  valid: [
    "ctx.db.aggregate('messages', 'by_room').get([roomId]).count",
    "ctx.db.query('messages').take(10).length",
    "ctx.db.query('messages').first() !== null",
    "const all = ctx.db.query('messages').collect(); return all.length + all.map(f).length;",
    "stream.collect().length",
  ],
  invalid: [
    { code: "ctx.db.query('messages').collect().length", errors: [{ messageId: "length" }] },
    { code: "ctx.db.query('m').withIndex('by_room', (q) => q.eq('room', r)).collect().length", errors: [{ messageId: "length" }] },
    { code: "db.query('m').filter((q) => q.eq(q.field('a'), 1)).order('desc').collect().length", errors: [{ messageId: "length" }] },
  ],
});

tester.run("no-db-in-loop", rules["no-db-in-loop"] as never, {
  valid: [
    "const rows = ctx.db.query('m').withIndex('by_room', (q) => q.eq('room', r)).collect();",
    "for (const r of ctx.db.query('m').collect()) total += r.n;",
    // Run together: the parallel pattern of actions.
    "await Promise.all(ids.map((id) => ctx.runQuery(api.x.get, { id })))",
    "for (const id of ids) promises.push(ctx.runQuery(api.x.get, { id }));",
    // A function defined in a loop is not run by it.
    "for (const id of ids) handlers.set(id, () => ctx.db.get(id));",
    "for (const id of ids) { function load() { return ctx.db.get(id); } handlers.push(load); }",
    // An action's calls started together.
    "await Promise.all(ids.map(async (id) => await ctx.runQuery(api.x.get, { id })))",
    "rows.map((r) => r.n)",
    "xs.sort((a, b) => a - b)",
  ],
  invalid: [
    { code: "for (const id of ids) out.push(ctx.db.get(id));", errors: [{ messageId: "read", data: { call: "ctx.db.get()" } }] },
    { code: "ids.map((id) => ctx.db.get(id))", errors: [{ messageId: "read" }] },
    // Promise.all does not batch database calls: they are synchronous, one per element all the same (N+1).
    { code: "await Promise.all(ids.map((id) => ctx.db.get(id)))", errors: [{ messageId: "read", data: { call: "ctx.db.get()" } }] },
    { code: "await Promise.all(rows.map(async (r) => ctx.db.patch(r._id, { seen: true })))", errors: [{ messageId: "write" }] },
    // A function declared in the loop and called there.
    { code: "for (const id of ids) { const load = () => 1; out.push(ctx.db.get(id)); }", errors: [{ messageId: "read" }] },
    { code: "rows.forEach((r) => { ctx.db.patch(r._id, { seen: true }); })", errors: [{ messageId: "write", data: { call: "ctx.db.patch()" } }] },
    { code: "for (const t of done) ctx.db.delete(t._id);", errors: [{ messageId: "write" }] },
    { code: "let i = 0; while (i < n) { db.insert('t', { i }); i++; }", errors: [{ messageId: "write", data: { call: "db.insert()" } }] },
    { code: "teams.map((t) => ctx.db.query('members').withIndex('by_team', (q) => q.eq('team', t.id)).first())", errors: [{ messageId: "read", data: { call: "ctx.db.query()" } }] },
    { code: "Array.from({ length: n }, (_, i) => ctx.db.insert('t', { i }))", errors: [{ messageId: "write" }] },
    { code: "for (const id of ids) results.push(await ctx.runQuery(api.x.get, { id }));", errors: [{ messageId: "roundTrip", data: { call: "ctx.runQuery()" } }] },
    { code: "for (let i = 0; i < 3; i++) { await ctx.runMutation(internal.x.step, { i }); }", errors: [{ messageId: "roundTrip" }] },
  ],
});

tester.run("no-throw-raw-error", rules["no-throw-raw-error"] as never, {
  valid: [
    "mutation({ args: {}, handler: (ctx) => { throw errors.NotFound(); } })",
    "mutation({ args: {}, handler: (ctx) => ctx.fail.NotFound() })",
    // Internal functions, helpers, http actions and triggers may throw plain errors.
    "internalMutation({ handler: (ctx) => { throw new Error('bug'); } })",
    "internalAction({ handler: async (ctx) => { throw new Error('retry'); } })",
    "function requireUser(ctx) { if (!ctx.auth.getUserIdentity()) throw new Error('Sign in first'); }",
    "httpAction(async (ctx, req) => { throw new Error('bad'); })",
    "export default defineTriggers({ t: () => { throw new Error('invariant'); } })",
    // Caught on the spot.
    "action({ handler: async (ctx) => { try { if (!x) throw new Error('missing'); } catch (e) { return null; } } })",
    "query({ handler: (ctx) => { throw new EmberError('X', 'y'); } })",
  ],
  invalid: [
    { code: "mutation({ args: {}, handler: (ctx) => { throw new Error('A list needs a name'); } })", errors: [{ messageId: "raw", data: { name: "Error", kind: "mutation" } }] },
    { code: "query({ handler: (ctx) => { if (!ok) throw Error('nope'); return 1; } })", errors: [{ messageId: "raw", data: { name: "Error", kind: "query" } }] },
    { code: "action({ handler: async (ctx) => { throw new TypeError('bad'); } })", errors: [{ messageId: "raw", data: { name: "TypeError", kind: "action" } }] },
    { code: "query({ authorize: (ctx) => { throw new Error('Forbidden'); }, handler: (ctx) => 1 })", errors: [{ messageId: "raw" }] },
    { code: "const authed = mutation.use((ctx) => { if (!ctx.auth.getUserIdentity()) throw new Error('Sign in'); })", errors: [{ messageId: "raw" }] },
    { code: "const authed = mutation.use(mw); export const x = authed({ handler: (ctx) => { throw new Error('x'); } });", errors: [{ messageId: "raw" }] },
    // A try without catch does not handle it.
    { code: "mutation({ handler: (ctx) => { try { throw new Error('x'); } finally { cleanup(); } } })", errors: [{ messageId: "raw" }] },
    // A helper declared inside a try throws when called, not inside that try.
    { code: "mutation({ handler: (ctx) => { try { function f() { throw new Error('x'); } } catch {} return f(); } })", errors: [{ messageId: "raw" }] },
  ],
});

tester.run("require-args-validators", rules["require-args-validators"] as never, {
  valid: ["query({ args: { id: v.string() }, handler: (ctx, { id }) => id })", "query({ handler: (ctx) => 1 })", "internalQuery({ handler: (ctx, a) => a })", "query({ \"args\": { id: v.string() }, \"handler\": (ctx, { id }) => id })"],
  invalid: [
    { code: 'mutation({ "handler": (ctx, { id }) => id })', errors: [{ messageId: "args" }] },
    { code: "mutation({ handler: (ctx, { id }) => id })", errors: [{ messageId: "args" }] },
    { code: "mutationGeneric({ handler: (ctx, { id }) => id })", errors: [{ messageId: "args" }] },
  ],
});

tester.run("no-floating-mutation", rules["no-floating-mutation"] as never, {
  valid: [
    "const send = useMutation(api.x.y); await send({});",
    "const send = useMutation(api.x.y); void send({});",
    "const send = useMutation(api.x.y); send({}).catch(report);",
    "await client.mutation(api.x.y, {});",
  ],
  invalid: [
    { code: "const send = useMutation(api.x.y); send({ a: 1 });", errors: [{ messageId: "floating" }] },
    { code: "const send = useMutation(api.x.y).withOptimisticUpdate(u); send({});", errors: [{ messageId: "floating" }] },
    { code: "client.mutation(api.x.y, {});", errors: [{ messageId: "floating" }] },
  ],
});

describe("recommended config", () => {
  it("enables every rule", () => {
    const cfg = plugin.configs.recommended as { rules: Record<string, string> };
    if (Object.keys(cfg.rules).length !== Object.keys(rules).length) throw new Error("recommended does not list every rule");
  });
});
