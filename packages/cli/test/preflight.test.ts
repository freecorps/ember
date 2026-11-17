// `ember deploy --preflight` against a local runtime (Miniflare): the live shards plan the schema about to be deployed
// against their data and write nothing; an old runtime (no endpoint) is "too old", never a pass.
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Miniflare } from "miniflare";
import { buildWorker } from "../src/build.ts";
import { codegen } from "../src/codegen/index.ts";
import type { Project } from "../src/config.ts";
import { startLocal } from "../src/local.ts";
import { preflightDeploy, type PreflightOptions } from "../src/deploy/preflight.ts";
import { cleanup, sampleProject } from "./helpers.ts";

let project: Project;
let mf: Miniflare;
let deployed: { version: string; tables: Record<string, any> };
let o: PreflightOptions;
const lines: string[] = [];

const status = async () => {
  const res = await mf.dispatchFetch(new URL("/api/_ember/status?shard=global:main", o.url).href, { headers: { authorization: "Bearer local-admin" } });
  return ((await res.json()) as { shards: unknown[] }).shards;
};
const messages = async () => {
  const res = await mf.dispatchFetch(new URL("/api/query", o.url).href, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fn: "messages:list", args: { channel: "general" }, shard: "global:main" }) });
  return ((await res.json()) as { value: unknown[] }).value;
};
/** The deployed manifest with one more field on `messages` (and a new version, as codegen would give it). */
const withField = (field: string, optional: boolean, index?: string) => {
  const m = JSON.parse(JSON.stringify(deployed));
  m.version = `${deployed.version}-${field}`;
  m.tables.messages.document.fields[field] = { ...m.tables.messages.document.fields.body, optional };
  if (index) m.tables.messages.indexes.push({ kind: "db", name: index, fields: [field] });
  return m;
};

beforeAll(async () => {
  project = sampleProject("preflight");
  const gen = await codegen(project);
  deployed = gen.manifest.schema as unknown as typeof deployed;
  const build = await buildWorker(project);
  let url: URL;
  ({ mf, url } = await startLocal(project, build, { persist: false, vars: { EMBER_ADMIN_TOKEN: "local-admin" } }));
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => mf.dispatchFetch(String(input), init as any)) as unknown as typeof fetch;
  o = { url: url.href, adminToken: "local-admin", schema: deployed, fetch: fetchImpl, log: (l) => lines.push(l) };
  for (let i = 0; i < 3; i++) {
    const res = await mf.dispatchFetch(new URL("/api/mutation", url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fn: "messages:send", args: { channel: "general", author: "ada", body: `m${i}` }, shard: "global:main" }),
    });
    expect(res.status).toBe(200);
  }
}, 120_000);
afterAll(async () => {
  await mf?.dispose();
  cleanup(project);
});

it("the deployed schema passes; a new required field is refused (documents lack it); nothing is written", async () => {
  const before = { status: await status(), messages: await messages() };
  lines.length = 0;
  const same = await preflightDeploy(o);
  expect(same.exitCode).toBe(0);
  expect(same.outcomes).toMatchObject([{ shard: "global:main", state: "ok", answer: { result: { status: "ok", changed: false } } }]);
  expect(lines.some((l) => l.includes("global:main: schema unchanged"))).toBe(true);
  expect(lines).toContain("  no registry catalog for this target: checking global:main only (pass --env, or --shard kind:key)");

  lines.length = 0;
  const refused = await preflightDeploy({ ...o, schema: withField("mandatory", false) });
  expect(refused.exitCode).toBe(1);
  expect(refused.outcomes[0]).toMatchObject({ state: "refused" });
  expect(lines.join("\n")).toMatch(/global:main: would REFUSE schema/);
  expect(lines.join("\n")).toMatch(/messages\.mandatory: field mandatory becomes required but 3 document\(s\) do not have it|messages\.mandatory: new required field mandatory/);
  expect(lines.at(-1)).toBe("Preflight failed: 1 shard(s) would refuse, 0 could not be checked (of 1)");

  lines.length = 0;
  const ok = await preflightDeploy({ ...o, schema: withField("topic", true, "by_topic") });
  expect(ok.exitCode).toBe(0);
  expect(ok.outcomes[0]).toMatchObject({ state: "ok", answer: { result: { changed: true, staged: [{ table: "messages", index: "by_topic", kind: "db" }] } } });
  expect(lines.join("\n")).toMatch(/createIndex messages\.by_topic \(db, staged backfill\)/);

  expect({ status: await status(), messages: await messages() }).toEqual(before);
}, 60_000);

it("--shard: only shards the catalog knows are asked (asking would create one); global:main always", async () => {
  lines.length = 0;
  const r = await preflightDeploy({ ...o, shards: ["chat:a", "chat:ghost"], catalog: async () => ["global:main", "chat:a"] });
  expect(r.outcomes.map((x) => [x.shard, x.state])).toEqual([
    ["chat:ghost", "error"],
    ["global:main", "ok"],
    ["chat:a", "ok"],
  ]);
  expect(r.exitCode).toBe(1);
  expect(lines.join("\n")).toMatch(/chat:ghost: cannot check: not in the registry catalog/);
});

it("a runtime without the endpoint is too old to preflight, never a pass; a wrong token throws", async () => {
  const answer = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  lines.length = 0;
  const level1 = await preflightDeploy({ ...o, fetch: answer(404, { ok: false, error: { code: "not_found", message: "not found" } }) });
  expect(level1).toEqual({ tooOld: { level: 1 }, outcomes: [], exitCode: 1 });
  expect(lines.join("\n")).toMatch(/too old to preflight \(admin API level 1/);
  const level10 = await preflightDeploy({ ...o, fetch: answer(200, { ok: true, level: 10, features: ["capabilities", "status"] }) });
  expect(level10).toMatchObject({ tooOld: { level: 10 }, exitCode: 1 });
  await expect(preflightDeploy({ ...o, adminToken: "wrong" })).rejects.toThrow(/rejected the admin token/);
});

it("a schema rollback (registry history) fails the preflight after the shards answered; --allow-schema-rollback passes; unreadable history only warns", async () => {
  const newer = withField("topic", true, "by_topic");
  const row = (id: number, schemaVersion: string, message: string) => ({ id, at: Date.UTC(2026, 10, id), schemaVersion, versionId: `v${id}`, message });
  const history = async () => [row(1, deployed.version, "first"), row(2, newer.version, "topics")];
  lines.length = 0;
  const r = await preflightDeploy({ ...o, env: "prod", history });
  expect(r.schemaHistory).toMatchObject({ status: "rollback", allowed: false, rollback: { target: deployed.version, current: newer.version, introducedBy: { versionId: "v2" } } });
  // The shards were still asked (their answer is the concrete cost), and the summary says why it failed.
  expect(r.outcomes).toMatchObject([{ shard: "global:main", state: "ok" }]);
  expect(r.exitCode).toBe(1);
  const out = lines.join("\n");
  expect(out).toContain(`schema rollback: this deploy takes prod back to schema ${deployed.version.slice(0, 12)}`);
  expect(out).toContain("a real deploy stops here. To deploy it anyway: ember deploy --env prod --allow-schema-rollback");
  expect(lines.at(-1)).toBe(`Preflight failed: schema rollback without --allow-schema-rollback; 1 shard(s) would accept schema ${deployed.version.slice(0, 12)}`);

  lines.length = 0;
  const allowed = await preflightDeploy({ ...o, env: "prod", history, allowSchemaRollback: true });
  expect(allowed).toMatchObject({ exitCode: 0, schemaHistory: { status: "rollback", allowed: true } });
  expect(lines.join("\n")).toContain("a real deploy would go ahead: --allow-schema-rollback was passed");

  lines.length = 0;
  const unread = await preflightDeploy({ ...o, env: "prod", history: async () => Promise.reject(new Error("registry unreachable")) });
  expect(unread).toMatchObject({ exitCode: 0, schemaHistory: { status: "unchecked" } });
  expect(lines.join("\n")).toMatch(/warning: schema rollback not checked: .*registry unreachable/);

  // Too old to preflight: the history finding is still reported (it needs no runtime).
  const old = (async () => new Response(JSON.stringify({ ok: false }), { status: 404 })) as unknown as typeof fetch;
  lines.length = 0;
  expect(await preflightDeploy({ ...o, env: "prod", history, fetch: old })).toMatchObject({ tooOld: { level: 1 }, schemaHistory: { status: "rollback" }, exitCode: 1 });
  // The last line still says why it failed, as it does when the shards answer.
  expect(lines.at(-1)).toBe("Preflight failed: schema rollback without --allow-schema-rollback; no shard could be asked");
});
