// `ember deploy` with component hooks against a mocked Cloudflare API (PLAN §12, contracts.md "Componentes"):
// queues a component owns are created before the upload, bound as producers, consumed by the Worker after it;
// a queue that left the app is detached and deleted after the deploy; `ember destroy` deletes them; send_email
// bindings go to the metadata; `ember dev` gets local queues and a simulated send_email.

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { composeApp, defineApp, defineComponent, defineSchema, defineTable, v } from "@freecorps/ember-server";
import { projectFrom, type EmberConfigFile } from "../src/config.ts";
import { deploy, type DeployOptions } from "../src/deploy/index.ts";
import { destroy } from "../src/destroy.ts";
import { miniflareOptions } from "../src/local.ts";
import { TMP } from "./helpers.ts";

const root = join(TMP, `deploy-queues-${process.pid}`);
mkdirSync(root, { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));

const config: EmberConfigFile = { project: "mail", account: "acc123", compatibilityDate: "2026-10-01", environments: { prod: {} } };
const project = projectFrom(root, config);
const CODE = "export default {}";

const mailer = (queues: string[]) =>
  defineComponent({
    name: "mailer",
    functions: {},
    bindings: () => [{ type: "send_email", name: "EMAIL" }],
    queues: Object.fromEntries(queues.map((q) => [q, { consumer: { maxBatchSize: 50, maxRetries: 5 }, handler: async () => {} }])),
    email: { handler: async () => {} },
  });

const manifestWith = (queues: string[]) =>
  composeApp({ schema: defineSchema({ tables: { t: defineTable({ x: v.number() }) } }), functions: {}, app: defineApp().use(mailer(queues), { name: "email" }) }).schema.manifest;

const prebuilt = (schema: ReturnType<typeof manifestWith>): NonNullable<DeployOptions["prebuilt"]> => ({
  build: { code: CODE, entry: "entry.mjs", outFile: "index.js", bytes: CODE.length, sha256: "f".repeat(64), auth: null },
  hasCrons: false,
  schemaVersion: schema.version,
  schema: schema as never,
});

type Call = { method: string; path: string; json?: any; metadata?: any };

function fakeCloudflare() {
  const state = { workerExists: false, queues: new Map<string, { id: string; consumers: Array<{ script: string; settings?: unknown }> }>() };
  // A queue of another environment with the same prefix: never touched.
  state.queues.set("ember-mail-prod2-email-events", { id: "q-other", consumers: [] });
  let n = 0;
  const calls: Call[] = [];
  const ok = (result: unknown) => new Response(JSON.stringify({ success: true, errors: [], result }), { status: 200 });
  const no = (status: number, code: number, message: string) => new Response(JSON.stringify({ success: false, errors: [{ code, message }], result: null }), { status });
  const W = "/workers/scripts/ember-mail-prod";
  const byId = (id: string) => [...state.queues].find(([, q]) => q.id === id);
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace("/client/v4/accounts/acc123", "");
    const call: Call = { method: init?.method ?? "GET", path: path + url.search };
    if (init?.body instanceof FormData) call.metadata = JSON.parse(await (init.body.get("metadata") as Blob).text());
    else if (typeof init?.body === "string") call.json = JSON.parse(init.body);
    calls.push(call);
    const m = `${call.method} ${path}`;
    if (m === `GET ${W}/deployments`) return state.workerExists ? ok({ deployments: [{ versions: [{ version_id: "v1", percentage: 100 }] }] }) : no(404, 10007, "no worker");
    if (m.startsWith("GET /workers/durable_objects/namespaces")) return ok(state.workerExists ? [{ script: "ember-mail-prod", class: "Shard" }, { script: "ember-mail-prod", class: "System" }] : []);
    if (m === `GET ${W}/secrets`) return ok([]);
    if (m === `PUT ${W}` || m === `POST ${W}/versions`) {
      state.workerExists = true;
      return ok({ id: "v2" });
    }
    if (m === `POST ${W}/deployments` || m === `PUT ${W}/schedules` || m === `POST ${W}/subdomain`) return ok({});
    if (m === `DELETE ${W}`) {
      if ([...state.queues.values()].some((q) => q.consumers.some((c) => c.script === "ember-mail-prod"))) return no(400, 10064, "consumer");
      state.workerExists = false;
      return ok({});
    }
    if (m === "GET /workers/subdomain") return ok({ subdomain: "acme" });
    // destroy also looks for external index resources (none here).
    if (m === "GET /vectorize/v2/indexes" || m === "GET /ai-search/namespaces/default/instances") return ok([]);
    if (m === "GET /queues") return ok([...state.queues].filter(([name]) => name === url.searchParams.get("name")).map(([queue_name, q]) => ({ queue_id: q.id, queue_name })));
    if (m === "POST /queues") {
      const id = `q${++n}`;
      state.queues.set(call.json.queue_name, { id, consumers: [] });
      return ok({ queue_id: id, queue_name: call.json.queue_name });
    }
    const r = /^(GET|POST|DELETE) \/queues\/([^/]+)(\/consumers(\/c-(.+))?)?$/.exec(m);
    if (r) {
      const q = byId(r[2]!);
      if (!q) return no(404, 11000, "queue not found");
      if (!r[3] && r[1] === "DELETE") {
        state.queues.delete(q[0]);
        return ok({});
      }
      if (r[1] === "GET") return ok(q[1].consumers.map((c) => ({ script: c.script, consumer_id: `c-${c.script}` })));
      if (r[1] === "POST") {
        q[1].consumers.push({ script: call.json.script_name, settings: call.json.settings });
        return ok({});
      }
      if (r[1] === "DELETE") {
        q[1].consumers = q[1].consumers.filter((c) => c.script !== r[5]);
        return ok({});
      }
    }
    return no(500, 0, `unexpected ${m}`);
  }) as typeof fetch;
  return { state, calls, fetchImpl };
}

const run = (cf: ReturnType<typeof fakeCloudflare>, queues: string[]) => {
  const log: string[] = [];
  return deploy(project, { env: "prod", prebuilt: prebuilt(manifestWith(queues)), fetch: cf.fetchImpl, token: "t", registry: false, sleep: async () => {}, log: (l) => log.push(l) }).then((r) => ({ r, log }));
};

describe("deploy: component queues and send_email", () => {
  const cf = fakeCloudflare();

  it("first deploy: queues created before the upload, producer + send_email bindings, Worker consumer with settings", async () => {
    await run(cf, ["events", "inbound"]);
    const upload = cf.calls.findIndex((c) => c.metadata);
    expect(cf.calls.findIndex((c) => c.method === "POST" && c.path === "/queues")).toBeLessThan(upload);
    expect(cf.calls[upload]!.metadata.bindings).toEqual(
      expect.arrayContaining([
        { type: "send_email", name: "EMAIL" },
        { type: "queue", name: "EMBER_Q_EMAIL_EVENTS", queue_name: "ember-mail-prod-email-events" },
        { type: "queue", name: "EMBER_Q_EMAIL_INBOUND", queue_name: "ember-mail-prod-email-inbound" },
      ]),
    );
    expect(cf.state.queues.get("ember-mail-prod-email-events")!.consumers).toEqual([{ script: "ember-mail-prod", settings: { batch_size: 50, max_retries: 5 } }]);
    expect(cf.state.queues.get("ember-mail-prod-email-inbound")!.consumers).toHaveLength(1);
  });

  it("redeploy: nothing created twice, the consumer is not added again", async () => {
    const before = cf.calls.length;
    await run(cf, ["events", "inbound"]);
    const mine = cf.calls.slice(before);
    expect(mine.filter((c) => c.method === "POST" && c.path.startsWith("/queues"))).toEqual([]);
  });

  it("a queue that left the app is detached and deleted after the deploy", async () => {
    const { log } = await run(cf, ["events"]);
    expect(cf.state.queues.has("ember-mail-prod-email-inbound")).toBe(false);
    expect(cf.state.queues.has("ember-mail-prod-email-events")).toBe(true);
    expect(log.join("\n")).toContain("deleted queue ember-mail-prod-email-inbound");
  });

  it("ember destroy deletes the component queues (and nothing of another environment)", async () => {
    const r = await destroy(project, { env: "prod", yes: true, fetch: cf.fetchImpl, token: "t", log: () => {} });
    expect(r.deleted).toEqual(expect.arrayContaining(["worker ember-mail-prod", "queue ember-mail-prod-email-events"]));
    expect([...cf.state.queues.keys()]).toEqual(["ember-mail-prod2-email-events"]);
  });

  it("ember dev: local producers/consumers for component queues and a simulated send_email", () => {
    const opts = miniflareOptions(project, prebuilt(manifestWith(["events"])).build, { components: manifestWith(["events"]).components as never }) as any;
    const w = JSON.stringify(opts);
    expect(w).toContain("ember-mail-local-email-events");
    expect(w).toContain("EMBER_Q_EMAIL_EVENTS");
    expect(w).toContain('"EMAIL"');
  });
});
