// `ember deploy` refuses an app schema this environment already left for a newer one (registry deploy history),
// unless --allow-schema-rollback; everything else (same schema, new schema, roll-forward, no history, first deploy,
// unreadable history) deploys as before. Registry: the D1 REST API over node:sqlite (fake-account.ts).
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { loadProject, type EmberConfigFile } from "../src/config.ts";
import {
  classifySchema,
  deploy,
  deployExitCode,
  SchemaRollbackError,
  type DeployHistoryRow,
  type DeployOptions,
  type DeployResult,
} from "../src/deploy/index.ts";
import { D1Registry, noopRegistry, type ProjectRegistry } from "../src/registry.ts";
import { fakeAccount } from "./fake-account.ts";
import { TMP } from "./helpers.ts";

const root = join(TMP, `schema-rollback-${process.pid}`);
mkdirSync(root, { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));

const S1 = "1".repeat(64);
const S2 = "2".repeat(64);
const S3 = "3".repeat(64);
const CODE = "export default {}";
const prebuilt = (schemaVersion: string): NonNullable<DeployOptions["prebuilt"]> => ({
  build: { code: CODE, entry: "e", outFile: "index.js", bytes: CODE.length, sha256: "f".repeat(64), auth: null },
  hasCrons: false,
  schemaVersion,
});

let n = 0;
function repo(config: Partial<EmberConfigFile> = {}) {
  const dir = join(root, `p${n++}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "ember.json"), JSON.stringify({ project: "chat", account: "acc", compatibilityDate: "2026-10-01", environments: { prod: {} }, ...config }, null, 2));
  return loadProject(dir);
}

/** A project, a fake account and a deploy helper that keeps the log of each call. */
function setup() {
  const cf = fakeAccount();
  const project = repo();
  let clock = Date.UTC(2026, 10, 1, 9, 0, 0);
  const now = () => (clock += 60_000);
  const lines: string[] = [];
  const registry = () => D1Registry.open(cf.client, "r", { now });
  const go = async (schema: string, extra: Partial<DeployOptions> = {}): Promise<DeployResult> => {
    lines.length = 0;
    return deploy(project, { env: "prod", token: "t", fetch: cf.fetchImpl, prebuilt: prebuilt(schema), registry: await registry(), log: (l) => lines.push(l), sleep: async () => {}, ...extra });
  };
  const uploads = (from: number) => cf.calls.slice(from).filter((c) => c.method !== "GET" && c.path.startsWith("/workers/scripts/"));
  return { cf, project, lines, go, uploads, registry };
}

describe("schema rollback check (ember deploy)", () => {
  it("stops before uploading anything, names the deploys and the cost; --allow-schema-rollback deploys and says so", async () => {
    const { cf, lines, go, uploads, registry } = setup();
    expect((await go(S1, { message: "first" })).schemaHistory).toEqual({ status: "ok", reason: "first-deploy" });
    expect((await go(S2, { message: "add topics" })).schemaHistory).toEqual({ status: "ok", reason: "new" });
    expect((await go(S2)).schemaHistory).toEqual({ status: "ok", reason: "same" });

    const before = cf.calls.length;
    const err = await go(S1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SchemaRollbackError);
    const e = err as SchemaRollbackError;
    expect(e.check).toMatchObject({
      status: "rollback",
      allowed: false,
      rollback: { target: S1, current: S2, introducedBy: { message: "add topics", versionId: "v0" }, lastRanTarget: { message: "first", versionId: null } },
    });
    expect(e.message).toContain(`schema rollback: this deploy takes prod back to schema ${S1.slice(0, 12)}, which it left for schema ${S2.slice(0, 12)}`);
    // The deploy that introduced S2, with its time as the registry recorded it.
    const history = await (await registry()).deployHistory("chat", "prod");
    expect(e.check.rollback.introducedBy.at).toBe(history[1]!.at);
    expect(e.message).toContain(`${S2.slice(0, 12)} (current) was introduced by the deploy of ${new Date(history[1]!.at).toISOString().replace(".000Z", "Z")}, version v0 ("add topics")`);
    expect(e.message).toContain(`${S1.slice(0, 12)} last ran in the deploy of ${new Date(history[0]!.at).toISOString().replace(".000Z", "Z")} ("first")`);
    expect(e.message).toMatch(/no document data is deleted/);
    expect(e.message).toMatch(/MigrationRefused/);
    expect(e.message).toMatch(/IndexNotReady/);
    expect(e.message).toContain("ember deploy --preflight --env prod");
    expect(e.message).toContain("nothing was uploaded. To deploy it anyway: ember deploy --env prod --allow-schema-rollback");
    expect(uploads(before)).toEqual([]);
    // Nothing recorded either: S2 is still the environment's schema.
    expect((await (await registry()).deployHistory("chat", "prod")).map((r) => r.schemaVersion)).toEqual([S1, S2, S2]);

    const allowed = await go(S1, { allowSchemaRollback: true });
    expect(allowed.schemaHistory).toMatchObject({ status: "rollback", allowed: true, rollback: { target: S1, current: S2 } });
    expect(lines.join("\n")).toContain("deploying anyway: --allow-schema-rollback was passed");
    expect(cf.workers.has("ember-chat-prod")).toBe(true);
    expect((await (await registry()).deployHistory("chat", "prod")).map((r) => r.schemaVersion)).toEqual([S1, S2, S2, S1]);

    // Back to S2 after the rollback: S2 came after S1 here, so that is a roll-forward, not another rollback.
    expect((await go(S2)).schemaHistory).toEqual({ status: "ok", reason: "forward" });
    expect((await go(S3)).schemaHistory).toEqual({ status: "ok", reason: "new" });
    await expect(go(S2)).rejects.toThrow(SchemaRollbackError);
  });

  it("no history, a first deploy (also after `ember destroy`), and no registry deploy as before", async () => {
    // A Worker that exists but has no recorded deploy (registry created afterwards): nothing to compare with.
    const a = setup();
    a.cf.workers.add("ember-chat-prod");
    expect((await a.go(S1)).schemaHistory).toEqual({ status: "ok", reason: "no-history" });

    // History says S1 then S2, but the Worker (and with it every shard) was destroyed: a first deploy again.
    const b = setup();
    await b.go(S1);
    await b.go(S2);
    b.cf.workers.delete("ember-chat-prod");
    const r = await b.go(S1);
    expect(r.schemaHistory).toEqual({ status: "ok", reason: "first-deploy" });
    expect(r.plan.strategy).toBe("create");

    // `registry: false` (and any registry without a history): no check, no field.
    const c = setup();
    expect((await c.go(S1, { registry: false })).schemaHistory).toBeUndefined();
    expect((await c.go(S1, { registry: noopRegistry })).schemaHistory).toBeUndefined();
  });

  it("an unreadable history warns and deploys", async () => {
    const { cf, lines, go, registry } = setup();
    await go(S1);
    await go(S2);
    const real = await registry();
    const broken: ProjectRegistry = {
      databaseId: real.databaseId,
      claim: (i) => real.claim(i),
      recordDeploy: (d) => real.recordDeploy(d),
      deployHistory: async () => {
        throw new Error("D1 timed out");
      },
    };
    const before = cf.calls.length;
    const r = await go(S1, { registry: broken });
    expect(r.schemaHistory).toEqual({ status: "unchecked", reason: "the registry's deploy history could not be read (D1 timed out)" });
    expect(lines.join("\n")).toMatch(/warning: schema rollback not checked: .*D1 timed out.*The deploy goes ahead/);
    expect(cf.calls.slice(before).some((c) => c.method === "PUT" && c.path === "/workers/scripts/ember-chat-prod")).toBe(true);
    expect(deployExitCode(r)).toBe(0);
  });

  it("a gradual deployment (two versions live) is said to have migrated only some shards", async () => {
    const { cf, go } = setup();
    await go(S1);
    await go(S2, { gradual: 10 });
    const split = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/workers/scripts/ember-chat-prod/deployments") && (init?.method ?? "GET") === "GET")
        return new Response(JSON.stringify({ success: true, errors: [], result: { deployments: [{ versions: [{ version_id: "v1", percentage: 10 }, { version_id: "v0", percentage: 90 }] }] } }));
      return cf.fetchImpl(input, init);
    }) as typeof fetch;
    const err = (await go(S1, { fetch: split }).catch((e: unknown) => e)) as SchemaRollbackError;
    expect(err.check.rollback.split).toBe(true);
    expect(err.message).toContain("splits traffic between two versions (gradual deploy): only shards that ran the newer one have migrated");
  });

  it("--dry-run reads the history read-only, prints its plan and the finding, and exits 1", async () => {
    const { cf, lines, go, project } = setup();
    await go(S1);
    await go(S2);
    const before = cf.calls.length;
    lines.length = 0;
    const r = await deploy(project, { env: "prod", token: "t", fetch: cf.fetchImpl, prebuilt: prebuilt(S1), registryName: "r", dryRun: true, log: (l) => lines.push(l) });
    expect(r.dryRun).toBe(true);
    expect(r.schemaHistory).toMatchObject({ status: "rollback", allowed: false, rollback: { target: S1, current: S2 } });
    const out = lines.join("\n");
    expect(out).toMatch(/^\[dry run\] deploy ember-chat-prod/);
    expect(out).toContain("a real deploy stops here. To deploy it anyway: ember deploy --env prod --allow-schema-rollback");
    expect(deployExitCode(r)).toBe(1);
    // Read-only: a database lookup, the Worker's deployments and SELECTs; no DDL, nothing created or uploaded.
    const calls = cf.calls.slice(before);
    expect(calls.filter((c) => c.method !== "GET").every((c) => /\/d1\/database\/[^/]+\/query$/.test(c.path) && /^SELECT /.test(c.json.sql))).toBe(true);
    expect(calls.some((c) => c.path.startsWith("/workers/scripts/") && c.method !== "GET")).toBe(false);

    const ok = await deploy(project, { env: "prod", token: "t", fetch: cf.fetchImpl, prebuilt: prebuilt(S1), registryName: "r", dryRun: true, allowSchemaRollback: true, log: () => {} });
    expect(ok.schemaHistory).toMatchObject({ status: "rollback", allowed: true });
    expect(deployExitCode(ok)).toBe(0);

    // The Worker's deployment cannot be read (not a 404): nothing is concluded, since a first deploy would look like a rollback.
    const denied = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/workers/scripts/ember-chat-prod/deployments") && (init?.method ?? "GET") === "GET")
        return new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: "Authentication error" }], result: null }), { status: 403 });
      return cf.fetchImpl(input, init);
    }) as typeof fetch;
    const unknown = await deploy(project, { env: "prod", token: "t", fetch: denied, prebuilt: prebuilt(S1), registryName: "r", dryRun: true, log: () => {} });
    expect(unknown.schemaHistory).toMatchObject({ status: "unchecked", reason: expect.stringContaining("the Worker's current deployment could not be read") });
    expect(deployExitCode(unknown)).toBe(0);

    // A registry database whose tables were never created (the dry run runs no DDL): an empty history, not an unreadable one.
    const bare = await D1Registry.open(fakeAccount().client, "r", { ddl: false });
    expect(await bare.deployHistory("chat", "prod")).toEqual([]);

    // A registry that was never created: no deploy recorded in this account, nothing to report.
    const fresh = fakeAccount();
    const none = await deploy(repo(), { env: "prod", token: "t", fetch: fresh.fetchImpl, prebuilt: prebuilt(S1), registryName: "r", dryRun: true, log: () => {} });
    expect(none.schemaHistory).toBeUndefined();
    expect(fresh.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("--dry-run without a token in the environment says it did not check, and needs no credentials", async () => {
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
    vi.stubEnv("CF_API_TOKEN", "");
    try {
      const lines: string[] = [];
      const r = await deploy(repo(), { env: "prod", prebuilt: prebuilt(S1), dryRun: true, log: (l) => lines.push(l) });
      expect(r.schemaHistory).toMatchObject({ status: "unchecked" });
      expect(lines.join("\n")).toMatch(/schema rollback not checked: a dry run reads the registry's deploy history only with CLOUDFLARE_API_TOKEN/);
      expect(deployExitCode(r)).toBe(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("classifySchema (ordered by first deploy)", () => {
  const rows = (...vs: Array<string | null>): DeployHistoryRow[] => vs.map((v, i) => ({ id: i + 1, at: 1000 * (i + 1), schemaVersion: v, versionId: `v${i}`, message: null }));
  it("cases", () => {
    expect(classifySchema([], S1)).toEqual({ status: "ok", reason: "no-history" });
    expect(classifySchema(rows(null), S1)).toEqual({ status: "ok", reason: "no-history" });
    expect(classifySchema(rows(S1), S1)).toEqual({ status: "ok", reason: "same" });
    expect(classifySchema(rows(S1), S2)).toEqual({ status: "ok", reason: "new" });
    expect(classifySchema(rows(S1, S2), S1)).toMatchObject({ status: "rollback", rollback: { introducedBy: { at: 2000 }, lastRanTarget: { at: 1000 } } });
    // The run of S2 started at the third deploy (after an allowed rollback to S1): that one introduced it.
    expect(classifySchema(rows(S1, S2, S1, S2, S2), S1)).toMatchObject({ status: "rollback", rollback: { introducedBy: { at: 4000 }, lastRanTarget: { at: 3000 } } });
    expect(classifySchema(rows(S1, S2, S1), S2)).toEqual({ status: "ok", reason: "forward" });
    expect(classifySchema(rows(S1, S2, S3, S2), S1)).toMatchObject({ status: "rollback", rollback: { current: S2 } });
    expect(classifySchema(rows(S1, S2, S3, S2), S3)).toEqual({ status: "ok", reason: "forward" });
    // Insertion order (id), not the clock: two deploys in the same millisecond keep their order.
    const tie = [{ id: 2, at: 5, schemaVersion: S2, versionId: null, message: null }, { id: 1, at: 5, schemaVersion: S1, versionId: null, message: null }];
    expect(classifySchema(tie, S1)).toMatchObject({ status: "rollback", rollback: { current: S2 } });
  });
});
