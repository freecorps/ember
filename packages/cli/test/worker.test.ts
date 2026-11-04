import { afterAll, beforeAll, expect, it } from "vitest";
import type { Miniflare } from "miniflare";
import { buildWorker } from "../src/build.ts";
import { codegen } from "../src/codegen/index.ts";
import type { Project } from "../src/config.ts";
import { startLocal } from "../src/local.ts";
import { run } from "../src/run.ts";
import { cleanup, sampleProject } from "./helpers.ts";

let project: Project;
let mf: Miniflare;
let url: URL;

beforeAll(async () => {
  project = sampleProject("worker");
  await codegen(project);
  const build = await buildWorker(project);
  expect(build.code).toContain("createEmberWorker");
  ({ mf, url } = await startLocal(project, build, { persist: false, vars: { EMBER_ADMIN_TOKEN: "local-admin" } }));
});
afterAll(async () => {
  await mf?.dispose();
  cleanup(project);
});

const post = async (path: string, body: unknown) => {
  const res = await mf.dispatchFetch(new URL(path, url), { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
  return { status: res.status, body: (await res.json()) as any };
};

it("bundle boots in Miniflare: /health, a mutation and a query", async () => {
  const health = await mf.dispatchFetch(new URL("/health", url));
  expect(await health.json()).toEqual({ ok: true });

  const shard = "global:main";
  const sent = await post("/api/mutation", { fn: "messages:send", args: { channel: "general", author: "ada", body: "hi" }, shard });
  expect(sent.status).toBe(200);
  expect(sent.body.ok).toBe(true);
  expect(sent.body.value.id).toMatch(/^messages_/);

  const list = await post("/api/query", { fn: "messages:list", args: { channel: "general" }, shard });
  expect(list.body.ok).toBe(true);
  expect(list.body.value).toMatchObject([{ _id: sent.body.value.id, channel: "general", author: "ada", body: "hi" }]);

  const internal = await post("/api/mutation", { fn: "messages:trim", args: { channel: "general", keep: 0 }, shard });
  expect(internal.body.ok).toBe(false);
});

it("ember run calls actions (kind from the manifest); the admin status endpoint reports the shard", async () => {
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => mf.dispatchFetch(String(input), init as any)) as unknown as typeof fetch;
  const r = await run(project, { fn: "messages.digest", args: '{"channel":"general"}', url: url.href, fetch: fetchImpl });
  expect(r).toEqual({ status: 200, body: { ok: true, value: "#general: 1 messages" } });
  await expect(run(project, { fn: "messages:trim", url: url.href, fetch: fetchImpl })).rejects.toThrow(/internal/);

  const res = await mf.dispatchFetch(new URL("/api/_ember/status?shard=global:main", url), { headers: { authorization: "Bearer local-admin" } });
  const body = (await res.json()) as any;
  expect(res.status).toBe(200);
  expect(body.shards).toMatchObject([{ shard: "global:main", ready: true, migrationError: null }]);
  expect(body.expectedVersion).toBe(body.shards[0].schemaVersion);
});
