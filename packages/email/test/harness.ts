// Shared test harness: the email component on the real engine (node:sqlite) with a fake transport and a job queue.
import {
  anyComponents,
  checkAccess,
  composeApp,
  createEngine,
  createFunctionHandle,
  defineApp,
  FileStore,
  proxySigner,
  defineSchema,
  defineTable,
  internalMutationGeneric,
  mutationGeneric,
  queryGeneric,
  resolveReference,
  splitFunctionName,
  v,
  type Job,
} from "@freecorps/ember-server";
import { createNodeSqliteDriver } from "@freecorps/ember-server/testing";
import { afterEach } from "vitest";
import { Email, email, setEmailTransport, TransportError, type OutboundMessage } from "../src/index.ts";

export const mail = new Email(anyComponents.email);
export const schema = defineSchema({ tables: { users: defineTable({ email: v.string() }), seen: defineTable({ kind: v.string(), data: v.any() }) } });

export const inboundArgs = { threadId: v.string(), messageId: v.string(), mailbox: v.string(), number: v.number(), newThread: v.boolean(), status: v.string(), from: v.any(), subject: v.string(), snippet: v.string(), autoSubmitted: v.boolean() };
export const fns = {
  app: {
    signup: mutationGeneric({
      args: { email: v.string(), fail: v.optional(v.boolean()), key: v.optional(v.string()), sendAt: v.optional(v.number()) },
      handler: (ctx: any, a: any) => {
        ctx.db.insert("users", { email: a.email });
        const r = mail.send(ctx, {
          from: "Acme <hello@acme.test>",
          to: a.email,
          subject: "Welcome",
          html: "<p>Hi</p>",
          ...(a.key ? { idempotencyKey: a.key } : {}),
          ...(a.sendAt ? { sendAt: a.sendAt } : {}),
          headers: { "X-Campaign": "welcome" },
        });
        if (a.fail) throw new Error("rollback");
        return r;
      },
    }),
    users: queryGeneric({ args: {}, handler: (ctx: any) => ctx.db.query("users").collect().length }),
    upload: mutationGeneric({ args: { contentType: v.string(), size: v.number() }, handler: (ctx: any, a: any) => ctx.storage.generateUploadUrl(a) }),
    seen: queryGeneric({ args: { kind: v.string() }, handler: (ctx: any, a: any) => ctx.db.query("seen").collect().filter((r: any) => r.kind === a.kind).map((r: any) => r.data) }),
    onInbound: internalMutationGeneric({ args: { event: v.optional(v.any()) }, handler: () => null }),
  },
  // The component calls these through function handles (config.hooks), in the same transaction.
  hooks: {
    inbound: internalMutationGeneric({
      args: inboundArgs,
      handler: (ctx: any, a: any) => ctx.db.insert("seen", { kind: "inbound", data: a }),
    }),
    boom: internalMutationGeneric({
      args: inboundArgs,
      handler: (ctx: any) => {
        ctx.db.insert("seen", { kind: "boom", data: 1 });
        probe.boom++;
        throw new Error("app bug");
      },
    }),
    event: internalMutationGeneric({
      args: { emailId: v.string(), project: v.string(), type: v.string(), status: v.string(), recipient: v.union(v.string(), v.null()), tags: v.any() },
      handler: (ctx: any, a: any) => ctx.db.insert("seen", { kind: "event", data: a }),
    }),
  },
};

export function harness(config: Record<string, unknown> = {}) {
  let now = 1_800_000_000_000;
  const app = defineApp().use(email, {
    config: {
      rateLimit: { rate: 3, period: 60_000 },
      hooks: { onInbound: createFunctionHandle("hooks:inbound"), onEvent: createFunctionHandle("hooks:event") },
      ...config,
    } as any,
  });
  const composed = composeApp({ schema, functions: fns, app });
  const driver = createNodeSqliteDriver();
  const storage = { shard: () => "global:main", signer: proxySigner({ secret: "s3cr3t", baseUrl: "https://mail.test" }) };
  const engine = createEngine({ schema: composed.schema, functions: composed.functions, driver, now: () => now, storage });
  const files = FileStore.ofDriver(driver, { shard: () => "global:main" });
  /** A file stored in this shard (uploaded and confirmed). */
  const storeFile = (contentType: string, size: number) => {
    const t = engine.runMutation("app:upload", { contentType, size }).value as { storageId: string };
    files.markReady(t.storageId, { size, etag: "e" }, now);
    return t.storageId;
  };
  engine.migrate();
  const all = new Map(Object.entries(composed.functions));
  let jobs: Job[] = [];
  const mutate = (name: string, args: unknown) => {
    const r = engine.runMutation(name, args);
    jobs.push(...r.scheduled);
    if (r.cancelled?.length) jobs = jobs.filter((j) => !r.cancelled.includes(j.id));
    return r.value as any;
  };
  const query = (name: string, args: unknown = {}) => engine.runQuery(name, args).value as any;
  const ctxFor = (name: string): any => {
    const path = splitFunctionName(name).path;
    const res = (ref: unknown) => {
      const r = resolveReference(path, ref as any);
      checkAccess(all as any, r);
      return r.name;
    };
    return {
      runQuery: async (ref: unknown, a?: unknown) => query(res(ref), a ?? {}),
      runMutation: async (ref: unknown, a?: unknown) => mutate(res(ref), a ?? {}),
      scheduler: { runAfter: async (ms: number, ref: unknown, a?: unknown) => jobs.push({ id: `j${jobs.length}`, fn: res(ref), args: a ?? {}, runAt: now + ms, kind: "action" }) },
      storage: { get: async () => null, store: async () => "x" },
      env: {},
      now,
      ...(path.length ? { component: { name: path.join("/"), config: composed.configs.get(path.join("/")) } } : {}),
    };
  };
  const runAction = async (name: string, args: unknown) => (all.get(name) as any).handler(ctxFor(name), args);
  const tick = async () => {
    for (;;) {
      const due = jobs.filter((j) => j.runAt <= now).sort((a, b) => a.runAt - b.runAt)[0];
      if (!due) return;
      jobs = jobs.filter((j) => j !== due);
      if (due.kind === "mutation") mutate(due.fn, due.args);
      else await runAction(due.fn, due.args);
    }
  };
  const get = (id: string) => query("@email/lib:get", { id });
  return { engine, driver, mutate, query, tick, get, jobs: () => jobs, advance: (ms: number) => (now += ms), now: () => now, runAction, storeFile };
}

/** A transport that records messages; `script` decides each call's outcome. */
export function fakeTransport(script: (m: OutboundMessage, n: number) => string | Error = () => "") {
  const sent: OutboundMessage[] = [];
  setEmailTransport(() => ({
    async send(m) {
      const r = script(m, sent.length);
      sent.push(m);
      if (r instanceof Error) throw r;
      return { messageId: r || `mid-${sent.length}` };
    },
  }));
  return sent;
}
afterEach(() => setEmailTransport(null));
export const probe = { boom: 0 };

export const event = (type: string, messageId: string, extra: Record<string, unknown> = {}, eventId = `${type}-${messageId}`) => ({
  eventId,
  type,
  messageId,
  recipient: "ana@user.test",
  sender: "hello@acme.test",
  terminal: type !== "deferred",
  at: 1,
  raw: {},
  ...extra,
});

export const inbound = (o: Partial<Record<string, any>> = {}) => ({
  mailbox: "support",
  envelopeFrom: "ana@user.test",
  messageId: `m-${Math.random()}@user.test`,
  references: [],
  from: { email: "ana@user.test", name: "Ana" },
  to: [{ email: "support@acme.test" }],
  cc: [],
  subject: "Order 42 is late",
  text: "Where is my order?",
  truncated: false,
  attachments: [],
  droppedAttachments: 0,
  auth: { spf: "pass", dkim: "pass", dmarc: "pass" },
  autoSubmitted: false,
  ...o,
});

export function inboxHarness(config: Record<string, unknown> = {}) {
  const h = harness(config);
  const sent = fakeTransport();
  h.mutate("@email/lib:upsertMailbox", {
    name: "support",
    address: "Support@Acme.test",
    displayName: "Acme Support",
    autoReply: { subject: "Re: {{subject}} [#{{number}}]", text: "Hi {{name}}, we got your message (#{{number}})." },
  });
  h.mutate("@email/lib:upsertMailbox", { name: "privacy", address: "privacy@acme.test" });
  return { ...h, sent, ingest: (o: Partial<Record<string, any>> = {}) => h.mutate("@email/lib:ingest", { message: inbound(o) }) };
}
