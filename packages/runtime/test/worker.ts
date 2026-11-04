import { createEmberWorker, type ActionJobMessage } from "../src/index.ts";
import { CodedError, createFakeEngine, type FakeFunctions } from "./fake-engine.ts";

export { Shard, System } from "../src/index.ts";

/** Same isolate as the tests: lets tests observe side effects outside SQL. */
export const probes = {
  actions: [] as ActionJobMessage[],
  flaky: new Map<string, number>(),
};

const functions: FakeFunctions = {
  "messages:list": {
    kind: "query",
    handler: (ctx, { channel }: { channel: string }) => ctx.db.list("messages").filter((m) => m.channel === channel),
  },
  "messages:send": {
    kind: "mutation",
    handler: (ctx, { channel, body }: { channel: string; body: string }) => {
      if (body === "fail") throw new CodedError("rejected", "body may not be 'fail'");
      return ctx.db.insert("messages", { channel, body, author: ctx.auth.identity?.subject ?? null });
    },
  },
  whoami: { kind: "query", handler: (ctx) => ctx.auth.identity?.subject ?? null },
  "runs:list": { kind: "query", handler: (ctx) => ctx.db.list("runs") },
  "jobs:record": {
    kind: "mutation",
    handler: (ctx, { label }: { label: string }) => ctx.db.insert("runs", { label, at: ctx.now }),
  },
  "jobs:schedule": {
    kind: "mutation",
    handler: (ctx, { items }: { items: Array<{ fn?: string; delayMs: number; args?: unknown; label?: string }> }) => {
      for (const it of items) ctx.scheduler.runAfter(it.delayMs, it.fn ?? "jobs:record", it.args ?? { label: it.label });
      return items.length;
    },
  },
  "jobs:flaky": {
    kind: "mutation",
    handler: (ctx, { label, failTimes }: { label: string; failTimes: number }) => {
      const n = (probes.flaky.get(label) ?? 0) + 1;
      probes.flaky.set(label, n);
      if (n <= failTimes) throw new Error(`flaky attempt ${n}`);
      return ctx.db.insert("runs", { label, at: ctx.now });
    },
  },
  "actions:ping": { kind: "action", handler: () => null },
  async: {
    kind: "mutation",
    handler: async (ctx) => {
      ctx.db.insert("messages", { channel: "async", body: "x" });
    },
  },
};

export default createEmberWorker({
  schema: { manifest: { version: "test-1" } },
  functions,
  createEngine: createFakeEngine,
  auth: {
    verify(token) {
      const [kind, subject] = token.split(":");
      if (!subject) return null;
      if (kind === "good") return { subject };
      if (kind === "expired") return { subject, exp: 1 };
      return null;
    },
  },
  groupCommit: { windowMs: 5, maxBatch: 100 },
  scheduler: { maxAttempts: 3, backoffBaseMs: 20, backoffMaxMs: 100 },
  changeLogVersions: 5,
  dispatchAction: async (_env, msg) => {
    probes.actions.push(msg);
    if ((msg.args as { fail?: boolean }).fail) throw new Error("queue down");
  },
  crons: [
    { name: "morning", schedule: "0 9 * * *", tz: "America/Sao_Paulo", shard: "org:crons", fn: "jobs:record", args: { label: "morning" } },
    { name: "every-5", schedule: "*/5 * * * *", shard: "org:crons", fn: "jobs:record", args: { label: "every-5" } },
  ],
});
