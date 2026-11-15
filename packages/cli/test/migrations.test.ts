// `ember migrations run|status|cancel` against a local runtime (Miniflare): a sample app with the migrations
// component, batches chained by the shard's real scheduler (alarms), driven through the admin function runner.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Miniflare } from "miniflare";
import { buildWorker } from "../src/build.ts";
import { codegen } from "../src/codegen/index.ts";
import type { Project } from "../src/config.ts";
import { startLocal } from "../src/local.ts";
import { cancelMigration, exitCode, migrationStatus, runMigration, type MigrationsOptions } from "../src/migrations.ts";
import { cleanup, sampleProject } from "./helpers.ts";

const APP_CONFIG = `import { defineApp } from "@freecorps/ember-server";
import { migrations } from "@freecorps/ember-migrations";

export default defineApp().use(migrations);
`;

const BACKFILL = `import { Migrations } from "@freecorps/ember-migrations";
import { components, type DataModel } from "./_generated/server";

export const m = new Migrations<DataModel>(components.migrations);

export const setEdited = m.define({
  table: "messages",
  batchSize: 2,
  migrateOne: (_ctx, doc) => (doc.edited === undefined ? { edited: false } : undefined),
});
`;

let project: Project;
let mf: Miniflare;
let url: URL;
let o: MigrationsOptions;
const lines: string[] = [];

beforeAll(async () => {
  project = sampleProject("migrations");
  writeFileSync(join(project.dir, "ember.config.ts"), APP_CONFIG);
  writeFileSync(join(project.dir, "backfill.ts"), BACKFILL);
  const gen = await codegen(project);
  expect(gen.warnings).toEqual([]);
  const build = await buildWorker(project);
  ({ mf, url } = await startLocal(project, build, { persist: false, vars: { EMBER_ADMIN_TOKEN: "local-admin" } }));
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => mf.dispatchFetch(String(input), init as any)) as unknown as typeof fetch;
  o = { url: url.href, adminToken: "local-admin", project, fetch: fetchImpl, log: (l) => lines.push(l) };
  for (let i = 0; i < 5; i++) {
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

const editedFlags = async () => {
  const res = await mf.dispatchFetch(new URL("/api/query", url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fn: "messages:list", args: { channel: "general" }, shard: "global:main" }) });
  return ((await res.json()) as { value: Array<{ edited?: boolean }> }).value.map((m) => m.edited ?? null);
};

it("--dry-run reports the first batch and writes nothing", async () => {
  const [out] = await runMigration({ ...o, dryRun: true }, "setEdited");
  expect(out).toMatchObject({ shard: "global:main", status: null, dryRun: { processed: 2, changed: 2, isDone: false } });
  expect(out!.dryRun!.samples[0]).toMatchObject({ before: { body: "m0" }, after: { body: "m0", edited: false } });
  expect(await editedFlags()).toEqual([null, null, null, null, null]);
  expect(lines.join("\n")).toMatch(/dry run: 2 of 2 document\(s\) in the first batch would change; nothing was written/);
  // Nothing recorded: status says it never ran, and is not done (exit 1).
  expect(exitCode(await migrationStatus(o, "setEdited"), "status")).toBe(1);
});

it("run --wait migrates the shard in batches through its scheduler; status reports done", async () => {
  const outs = await runMigration({ ...o, wait: true, pollMs: 100, waitTimeoutMs: 30_000 }, "backfill.setEdited");
  expect(outs).toMatchObject([{ shard: "global:main", status: { name: "backfill:setEdited", status: "done", processed: 5, changed: 5, batches: 3, failed: 0 } }]);
  expect(exitCode(outs, "wait")).toBe(0);
  expect(await editedFlags()).toEqual([false, false, false, false, false]);

  const status = await migrationStatus(o, "backfill:setEdited");
  expect(exitCode(status, "status")).toBe(0);
  const listed = await migrationStatus(o);
  expect(listed.map((x) => x.status?.name)).toEqual(["backfill:setEdited"]);

  // Done: running again is a no-op; cancel finds nothing running.
  const again = await runMigration(o, "setEdited");
  expect(again[0]!.status).toMatchObject({ status: "done", batches: 3 });
  expect(await cancelMigration(o, "setEdited")).toEqual([{ shard: "global:main", canceled: false }]);
}, 60_000);

it("--all walks the catalog (filtered by --kind); shards that never ran keep status from passing", async () => {
  const catalog = async () => ["global:main", "chat:a", "chat:b"];
  const outs = await migrationStatus({ ...o, all: true, catalog }, "setEdited");
  expect(outs.map((x) => [x.shard, x.status?.status ?? null])).toEqual([
    ["global:main", "done"],
    ["chat:a", null],
    ["chat:b", null],
  ]);
  expect(exitCode(outs, "status")).toBe(1);
  expect(lines.at(-1)).toBe("3 shard(s): 1 done, 2 never ran");

  const started = await runMigration({ ...o, all: true, kind: "chat", catalog, wait: true, pollMs: 100 }, "setEdited");
  expect(started.map((x) => [x.shard, x.status?.status, x.status?.processed])).toEqual([
    ["chat:a", "done", 0],
    ["chat:b", "done", 0],
  ]);
  expect(exitCode(await migrationStatus({ ...o, all: true, catalog }, "setEdited"), "status")).toBe(0);
}, 60_000);

it("refuses what is not a migration, and a missing token", async () => {
  await expect(runMigration(o, "messages:send")).rejects.toThrow(/not a migration/);
  // A bad --wait-timeout (Number("30m") is NaN) is refused, not an endless wait.
  await expect(runMigration({ ...o, wait: true, waitTimeoutMs: Number("30m") * 1000 }, "setEdited")).rejects.toThrow(/--wait-timeout/);
  await expect(runMigration({ ...o, batchSize: Number("x") }, "setEdited")).rejects.toThrow(/--batch-size/);
  await expect(runMigration(o, "nope")).rejects.toThrow(/No migration named "nope"/);
  await expect(migrationStatus({ ...o, kind: "chat" }, "setEdited")).rejects.toThrow(/--kind needs --all/);
  const [bad] = await migrationStatus({ ...o, adminToken: "wrong" }, "setEdited");
  expect(bad!.error).toMatch(/refused the token/);
});
