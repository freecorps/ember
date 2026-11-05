// Component queues at plan time, without the full deploy mock: ensureComponentQueues only falls back to a lookup on
// an "already exists" answer (any other create error surfaces as is); queueBindings refuses names the Worker upload
// would reject (invalid, or repeating another binding of the Worker, e.g. another install's ratelimit binding).
import { describe, expect, it } from "vitest";
import { composeApp, defineApp, defineComponent, defineSchema, defineTable, v } from "@freecorps/ember-server";
import { CloudflareApiError, type CfClient } from "../src/deploy/cf.ts";
import { componentBindings } from "../src/deploy/plan.ts";
import { componentQueues, ensureComponentQueues, queueBindings, type ComponentQueueSpec } from "../src/deploy/queues.ts";

const spec: ComponentQueueSpec = { queue: "ember-mail-prod-email-events", binding: "EMBER_Q_EMAIL_EVENTS", component: "email" };

function client(createError: CloudflareApiError | Error, existsAfterCreate: boolean): CfClient {
  let created = false;
  return {
    call: async (method: string, path: string) => {
      if (method === "GET" && path.startsWith("/queues?")) return created && existsAfterCreate ? [{ queue_id: "q-1", queue_name: spec.queue }] : [];
      if (method === "POST" && path === "/queues") {
        created = true;
        throw createError;
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
  } as unknown as CfClient;
}

describe("ensureComponentQueues", () => {
  it("a concurrent create (conflict) is looked up", async () => {
    const ids = await ensureComponentQueues(client(new CloudflareApiError("POST /queues", 409, [{ code: 11009, message: "queue name already taken" }]), true), [spec], () => {});
    expect(ids.get(spec.queue)).toBe("q-1");
  });

  it("other create errors surface as is (not a generic 'could not be created or found')", async () => {
    const forbidden = new CloudflareApiError("POST /queues", 403, [{ code: 10000, message: "Authentication error" }]);
    await expect(ensureComponentQueues(client(forbidden, false), [spec], () => {})).rejects.toBe(forbidden);
    const invalid = new CloudflareApiError("POST /queues", 400, [{ code: 11003, message: "invalid queue name" }]);
    await expect(ensureComponentQueues(client(invalid, false), [spec], () => {})).rejects.toBe(invalid);
    const offline = new TypeError("fetch failed");
    await expect(ensureComponentQueues(client(offline, false), [spec], () => {})).rejects.toBe(offline);
  });
});

describe("queueBindings", () => {
  const compose = (queueBinding: string, rateLimitBinding: string) => {
    const a = defineComponent({ name: "a", functions: {}, queues: { jobs: { binding: queueBinding, handler: async () => {} } } });
    const b = defineComponent({ name: "b", functions: {}, bindings: () => [{ type: "ratelimit", name: rateLimitBinding, limit: 10, period: 60 }] });
    return composeApp({ schema: defineSchema({ tables: { t: defineTable({ x: v.number() }) } }), functions: {}, app: defineApp().use(a).use(b) }).schema.manifest.components as any;
  };

  it("a queue binding of one install that repeats another install's binding is refused at plan time", () => {
    const components = compose("LIMITER", "LIMITER"); // composeApp only checks a queue binding against its own install's bindings
    const plain = componentBindings(components, "mail", "prod");
    expect(() => queueBindings(componentQueues(components, "mail", "prod"), plain)).toThrow(/binding LIMITER twice/);
    const ok = compose("JOBS", "LIMITER");
    expect(queueBindings(componentQueues(ok, "mail", "prod"), componentBindings(ok, "mail", "prod"))).toEqual([{ type: "queue", name: "JOBS", queue_name: "ember-mail-prod-a-jobs" }]);
  });

  it("invalid or repeated names in a hand-edited manifest are refused before any Cloudflare call", () => {
    const s = (binding: string, queue = "ember-mail-prod-x-q"): ComponentQueueSpec => ({ queue, binding, component: "x" });
    expect(() => queueBindings([s("bad-name")])).toThrow(/invalid queue binding name bad-name/);
    expect(() => queueBindings([s("A", "ember-mail-prod-x-q1"), s("A", "ember-mail-prod-x-q2")])).toThrow(/binding A twice/);
    expect(() => queueBindings([s("A"), s("B")])).toThrow(/queue ember-mail-prod-x-q twice/);
  });
});
