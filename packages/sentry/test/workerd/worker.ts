/**
 * The workerd test app: the sentry component installed with one project, the real runtime (Worker + Shard DO, R2,
 * Analytics Engine). The queue producer the ingest route sends to is wrapped to record what it sent: the test hands
 * those bodies to the Worker's `queue()` in batches (createMessageBatch), the way the Queue would deliver them.
 */
import { actionGeneric, defineApp, defineErrors, defineSchema, mutationGeneric, queryGeneric, v, type FunctionErrorReport } from "@freecorps/ember-server";
import { createEmberWorker } from "@freecorps/ember-runtime";
import { sentry, sentryErrorReporter, type QueuedEvent } from "../../src/index.ts";

export { Shard } from "@freecorps/ember-runtime";

export const KEY = "pubkey0123456789";
export const probes = { sent: [] as QueuedEvent[], batches: 0, reports: [] as FunctionErrorReport[] };

const errors = defineErrors({ OutOfStock: { message: "out of stock" } });
/** Functions that fail: a bug (TypeError) in a mutation, a query and an action; an application error; a refusal. */
const functions = {
  boom: {
    mutation: mutationGeneric({ args: {}, handler: () => (null as unknown as { id: string }).id }),
    query: queryGeneric({ args: {}, handler: () => JSON.parse("{") as unknown }),
    action: actionGeneric({ args: {}, handler: async () => (undefined as unknown as () => void)() }),
    appError: mutationGeneric({ args: {}, handler: () => { throw errors.OutOfStock(); } }),
    validated: mutationGeneric({ args: { n: v.number() }, handler: () => null }),
  },
};

const reporter = sentryErrorReporter({ project: "web", release: "api@1" });
const app = defineApp({
  // Ember's own unhandled errors go to the sentry queue (the recording one, wherever they happened: Worker or shard).
  onError: async (r, env) => {
    probes.reports.push(r);
    await reporter(r, { ...env, EMBER_Q_SENTRY_EVENTS: recordingQueue });
  },
}).use(sentry, { config: { projects: [{ id: "web", keys: [KEY], alerts: false }], rateLimit: false } });
const ember = createEmberWorker({ schema: defineSchema({ tables: {} }), functions, app });

const recordingQueue = {
  send: async (body: QueuedEvent) => void probes.sent.push(body),
  sendBatch: async (messages: Iterable<{ body: QueuedEvent }>) => {
    probes.batches++;
    for (const m of messages) probes.sent.push(m.body);
  },
};

type Env = Record<string, unknown>;
export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => ember.fetch(request, { ...env, EMBER_Q_SENTRY_EVENTS: recordingQueue } as never, ctx),
  queue: (batch: MessageBatch, env: Env, ctx: ExecutionContext) => ember.queue(batch as never, env as never, ctx),
};
