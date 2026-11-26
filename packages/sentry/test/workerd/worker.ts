/**
 * The workerd test app: the sentry component installed with one project, the real runtime (Worker + Shard DO, R2,
 * Analytics Engine). The queue producer the ingest route sends to is wrapped to record what it sent: the test hands
 * those bodies to the Worker's `queue()` in batches (createMessageBatch), the way the Queue would deliver them.
 */
import { defineApp, defineSchema } from "@freecorps/ember-server";
import { createEmberWorker } from "@freecorps/ember-runtime";
import { sentry, type QueuedEvent } from "../../src/index.ts";

export { Shard } from "@freecorps/ember-runtime";

export const KEY = "pubkey0123456789";
export const probes = { sent: [] as QueuedEvent[], batches: 0 };

const app = defineApp().use(sentry, { config: { projects: [{ id: "web", keys: [KEY], alerts: false }], rateLimit: false } });
const ember = createEmberWorker({ schema: defineSchema({ tables: {} }), functions: {}, app });

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
