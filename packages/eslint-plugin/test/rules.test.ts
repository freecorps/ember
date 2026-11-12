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
  valid: ["query({ handler: (ctx) => 1 })", "action({ handler: async (ctx) => 1 })", "mutation((ctx) => null)"],
  invalid: [
    { code: "query({ args: {}, handler: async (ctx) => 1 })", errors: [{ messageId: "async" }] },
    { code: "internalMutation(async (ctx) => null)", errors: [{ messageId: "async" }] },
    { code: "const authed = mutation.use(async (ctx) => ({ ctx: {} }))", errors: [{ messageId: "async" }] },
  ],
});

tester.run("require-args-validators", rules["require-args-validators"] as never, {
  valid: ["query({ args: { id: v.string() }, handler: (ctx, { id }) => id })", "query({ handler: (ctx) => 1 })", "internalQuery({ handler: (ctx, a) => a })"],
  invalid: [{ code: "mutation({ handler: (ctx, { id }) => id })", errors: [{ messageId: "args" }] }],
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
