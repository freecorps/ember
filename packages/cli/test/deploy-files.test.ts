// `ember deploy` with `resources.files` against a mocked Cloudflare API: bucket, CORS, lifecycle, queue, consumer,
// event notifications (idempotent on re-deploy), bindings and secrets (never printed).
import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { projectFrom, type EmberConfigFile } from "../src/config.ts";
import { deploy, EVENT_ACTIONS, LIFECYCLE_RULES, type DeployOptions } from "../src/deploy/index.ts";
import { miniflareOptions } from "../src/local.ts";
import { TMP } from "./helpers.ts";

const root = join(TMP, `deploy-files-${process.pid}`);
mkdirSync(root, { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));
afterEach(() => {
  delete process.env.EMBER_R2_ACCESS_KEY_ID;
  delete process.env.EMBER_R2_SECRET_ACCESS_KEY;
});

const config: EmberConfigFile = { project: "pics", account: "acc123", compatibilityDate: "2026-10-01", environments: { prod: {} }, resources: { files: true, images: true } };
const project = projectFrom(root, config);
const CODE = "export default {}";
const prebuilt: NonNullable<DeployOptions["prebuilt"]> = {
  build: { code: CODE, entry: "entry.mjs", outFile: "index.js", bytes: CODE.length, sha256: "f".repeat(64), auth: null },
  hasCrons: false,
  schemaVersion: "a".repeat(64),
};

type Call = { method: string; path: string; json?: any; metadata?: any };

function fakeCloudflare(state: {
  workerExists: boolean;
  bucket: boolean;
  queue: boolean;
  consumer: boolean;
  notification: boolean;
  secrets?: string[];
  canCreateTokens?: boolean;
}) {
  const calls: Call[] = [];
  const ok = (result: unknown) => new Response(JSON.stringify({ success: true, errors: [], result }), { status: 200 });
  const no = (status: number, code: number, message: string) => new Response(JSON.stringify({ success: false, errors: [{ code, message }], result: null }), { status });
  const W = "/workers/scripts/ember-pics-prod";
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace("/client/v4/accounts/acc123", "") + url.search;
    const call: Call = { method: init?.method ?? "GET", path };
    if (init?.body instanceof FormData) call.metadata = JSON.parse(await (init.body.get("metadata") as Blob).text());
    else if (typeof init?.body === "string") call.json = JSON.parse(init.body);
    calls.push(call);
    const m = `${call.method} ${path}`;
    if (m === `GET ${W}/deployments`) return state.workerExists ? ok({ deployments: [{ versions: [{ version_id: "v1", percentage: 100 }] }] }) : no(404, 10007, "no worker");
    if (m.startsWith("GET /workers/durable_objects/namespaces")) return ok(state.workerExists ? [{ script: "ember-pics-prod", class: "Shard" }, { script: "ember-pics-prod", class: "System" }] : []);
    if (m === `GET ${W}/secrets`) return ok((state.secrets ?? []).map((name) => ({ name, type: "secret_text" })));
    if (m === `PUT ${W}` || m === `POST ${W}/versions`) {
      state.workerExists = true;
      return ok({ id: "v2" });
    }
    if (m === `POST ${W}/deployments` || m === `PUT ${W}/schedules` || m === `POST ${W}/subdomain`) return ok({});
    if (m === "GET /workers/subdomain") return ok({ subdomain: "acme" });
    if (m === "GET /r2/buckets/ember-pics-prod") return state.bucket ? ok({ name: "ember-pics-prod" }) : no(404, 10006, "The specified bucket does not exist.");
    if (m === "POST /r2/buckets") {
      state.bucket = true;
      return ok({ name: call.json.name });
    }
    if (m === "PUT /r2/buckets/ember-pics-prod/cors" || m === "PUT /r2/buckets/ember-pics-prod/lifecycle") return ok({});
    if (m.startsWith("GET /queues?name=")) return ok(state.queue ? [{ queue_id: "q1", queue_name: "ember-pics-prod-files" }] : []);
    if (m === "POST /queues") {
      state.queue = true;
      return ok({ queue_id: "q1", queue_name: call.json.queue_name });
    }
    if (m === "GET /queues/q1/consumers") return ok(state.consumer ? [{ script: "ember-pics-prod", type: "worker" }] : []);
    if (m === "POST /queues/q1/consumers") {
      state.consumer = true;
      return ok({});
    }
    if (m === "GET /event_notifications/r2/ember-pics-prod/configuration")
      return ok({
        bucketName: "ember-pics-prod",
        queues: state.notification ? [{ queueId: "q1", queueName: "ember-pics-prod-files", rules: ["f/", "t/"].map((prefix) => ({ prefix, actions: [...EVENT_ACTIONS] })) }] : [],
      });
    if (m === "PUT /event_notifications/r2/ember-pics-prod/configuration/queues/q1") {
      state.notification = true;
      return ok({});
    }
    if (m === "GET /tokens/permission_groups") return state.canCreateTokens ? ok([{ id: "pg-r2w", name: "Workers R2 Storage Bucket Item Write" }]) : no(403, 9109, "Unauthorized to access requested resource");
    if (m === "POST /tokens") return ok({ id: "tok-id", value: "tok-value" });
    return no(400, 1, `unexpected ${m}`);
  }) as typeof fetch;
  return { calls, fetchImpl, state };
}

const run = (fetchImpl: typeof fetch, extra: Partial<DeployOptions> = {}) => {
  const lines: string[] = [];
  return deploy(project, { env: "prod", token: "t", fetch: fetchImpl, prebuilt, log: (l) => lines.push(l), ...extra }).then((r) => ({ r, lines }));
};

describe("ember deploy: files resources (mocked)", () => {
  it("first deploy provisions bucket, CORS, lifecycle, queue, consumer and notifications; binds them", async () => {
    const cf = fakeCloudflare({ workerExists: false, bucket: false, queue: false, consumer: false, notification: false });
    const { r, lines } = await run(cf.fetchImpl);
    const seq = cf.calls.map((c) => `${c.method} ${c.path.split("?")[0]}`);
    const i = (s: string) => seq.indexOf(s);
    expect(i("POST /r2/buckets")).toBeGreaterThan(-1);
    expect(i("POST /r2/buckets")).toBeLessThan(i("PUT /workers/scripts/ember-pics-prod")); // bucket before the binding upload
    expect(i("POST /queues")).toBeLessThan(i("PUT /workers/scripts/ember-pics-prod"));
    expect(i("POST /queues/q1/consumers")).toBeGreaterThan(i("PUT /workers/scripts/ember-pics-prod")); // consumer needs the Worker
    expect(i("PUT /event_notifications/r2/ember-pics-prod/configuration/queues/q1")).toBeGreaterThan(-1);
    const notif = cf.calls.find((c) => c.path.startsWith("/event_notifications/r2/ember-pics-prod/configuration/queues/"))!;
    expect(notif.json.rules.map((x: { prefix: string }) => x.prefix)).toEqual(["f/", "t/"]);
    expect(notif.json.rules[0].actions).toEqual(["PutObject", "CopyObject", "CompleteMultipartUpload"]);
    expect(cf.calls.find((c) => c.path === "/r2/buckets/ember-pics-prod/lifecycle")!.json).toEqual(LIFECYCLE_RULES);
    const cors = cf.calls.find((c) => c.path === "/r2/buckets/ember-pics-prod/cors")!.json;
    expect(cors.rules[0].exposeHeaders).toContain("ETag");
    const put = cf.calls.find((c) => c.method === "PUT" && c.path === "/workers/scripts/ember-pics-prod")!;
    const b = put.metadata.bindings;
    expect(b).toEqual(
      expect.arrayContaining([
        { type: "r2_bucket", name: "EMBER_FILES", bucket_name: "ember-pics-prod" },
        { type: "plain_text", name: "EMBER_R2_BUCKET", text: "ember-pics-prod" },
        { type: "plain_text", name: "EMBER_R2_ACCOUNT_ID", text: "acc123" },
        { type: "plain_text", name: "EMBER_PUBLIC_URL", text: "https://ember-pics-prod.acme.workers.dev" },
        { type: "images", name: "EMBER_IMAGES" },
      ]),
    );
    const storageSecret = b.find((x: { name: string }) => x.name === "EMBER_STORAGE_SECRET");
    expect(storageSecret.type).toBe("secret_text");
    expect(storageSecret.text).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The wrangler OAuth token cannot create API tokens: proxy mode, said clearly.
    expect(b.some((x: { name: string }) => x.name === "EMBER_R2_ACCESS_KEY_ID")).toBe(false);
    expect(r.files).toEqual({ bucket: "ember-pics-prod", queue: "ember-pics-prod-files", mode: "proxy", credentials: "none" });
    expect(lines.join("\n")).toMatch(/proxy mode/);
    expect(lines.join("\n")).not.toContain(storageSecret.text);
  });

  it("re-deploy is idempotent: nothing re-created, secrets kept", async () => {
    const cf = fakeCloudflare({
      workerExists: true,
      bucket: true,
      queue: true,
      consumer: true,
      notification: true,
      secrets: ["EMBER_STORAGE_SECRET", "EMBER_R2_ACCESS_KEY_ID", "EMBER_R2_SECRET_ACCESS_KEY"],
    });
    const { r } = await run(cf.fetchImpl);
    const seq = cf.calls.map((c) => `${c.method} ${c.path.split("?")[0]}`);
    for (const s of ["POST /r2/buckets", "POST /queues", "POST /queues/q1/consumers", "PUT /event_notifications/r2/ember-pics-prod/configuration/queues/q1", "POST /tokens"])
      expect(seq).not.toContain(s);
    const up = cf.calls.find((c) => c.method === "POST" && c.path === "/workers/scripts/ember-pics-prod/versions")!;
    expect(up.metadata.bindings.some((x: { name: string }) => x.name === "EMBER_STORAGE_SECRET")).toBe(false); // kept via keep_bindings
    expect(up.metadata.keep_bindings).toContain("secret_text");
    expect(r.files).toMatchObject({ mode: "s3", credentials: "kept" });
  });

  it("S3 credentials from the environment are uploaded as secrets", async () => {
    process.env.EMBER_R2_ACCESS_KEY_ID = "AKID-from-env";
    process.env.EMBER_R2_SECRET_ACCESS_KEY = "secret-from-env";
    const cf = fakeCloudflare({ workerExists: false, bucket: true, queue: true, consumer: false, notification: false });
    const { r, lines } = await run(cf.fetchImpl);
    const put = cf.calls.find((c) => c.method === "PUT" && c.path === "/workers/scripts/ember-pics-prod")!;
    expect(put.metadata.bindings).toEqual(
      expect.arrayContaining([
        { type: "secret_text", name: "EMBER_R2_ACCESS_KEY_ID", text: "AKID-from-env" },
        { type: "secret_text", name: "EMBER_R2_SECRET_ACCESS_KEY", text: "secret-from-env" },
      ]),
    );
    expect(r.files).toMatchObject({ mode: "s3", credentials: "provided" });
    expect(lines.join("\n")).not.toContain("secret-from-env");
  });

  it("creates a bucket-scoped API token when the Cloudflare token may (secret = sha256(value))", async () => {
    const cf = fakeCloudflare({ workerExists: false, bucket: true, queue: true, consumer: true, notification: true, canCreateTokens: true });
    const { r } = await run(cf.fetchImpl);
    const tok = cf.calls.find((c) => c.method === "POST" && c.path === "/tokens")!;
    expect(tok.json.policies[0].resources).toEqual({ "com.cloudflare.edge.r2.bucket.acc123_default_ember-pics-prod": "*" });
    const put = cf.calls.find((c) => c.method === "PUT" && c.path === "/workers/scripts/ember-pics-prod")!;
    expect(put.metadata.bindings).toEqual(
      expect.arrayContaining([
        { type: "secret_text", name: "EMBER_R2_ACCESS_KEY_ID", text: "tok-id" },
        // sha256("tok-value")
        { type: "secret_text", name: "EMBER_R2_SECRET_ACCESS_KEY", text: createHash("sha256").update("tok-value").digest("hex") },
      ]),
    );
    expect(r.files).toMatchObject({ mode: "s3", credentials: "created" });
  });

  it("dry run lists the files steps without API calls", async () => {
    const lines: string[] = [];
    const r = await deploy(project, { env: "prod", dryRun: true, prebuilt, log: (l) => lines.push(l) });
    expect(r.plan.steps.map((s) => s.kind)).toEqual(["files-resources", "upload-script", "schedules", "subdomain", "files-wire", "registry"]);
    expect(lines.join("\n")).toContain("ensure R2 bucket ember-pics-prod (CORS, lifecycle) and queue ember-pics-prod-files");
  });

  it("ember dev binds a local R2 bucket", () => {
    const opts = miniflareOptions(project, prebuilt.build, { port: 8787, persist: false }) as any;
    const w = opts.workers?.[0] ?? opts;
    expect(JSON.stringify(w)).toContain("EMBER_FILES");
    expect(JSON.stringify(w)).toContain("http://127.0.0.1:8787");
  });
});
