// ensureComponentQueues against a fake client: only an "already exists" answer falls back to a lookup; any other
// create error (bad name, auth, outage) surfaces with its own message.
import { describe, expect, it } from "vitest";
import { CloudflareApiError, type CfClient } from "../src/deploy/cf.ts";
import { ensureComponentQueues, type ComponentQueueSpec } from "../src/deploy/queues.ts";

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
