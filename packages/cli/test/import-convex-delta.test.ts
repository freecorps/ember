// Delta mode against a fake Convex deployment (node:http, the documented streaming export contract: list_snapshot,
// document_deltas, json_schemas, `Authorization: Convex <key>`, nanosecond timestamps above 2^53), then
// `ember export` → `ember import ember` into a second local runtime, compared by the verify hash.
import { createServer, type Server } from "node:http";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Miniflare } from "miniflare";
import { decodeJson } from "@freecorps/ember-values";
import { makeConvexId, seededRandom } from "@freecorps/ember-server";
import { buildWorker } from "../src/build.ts";
import { codegen } from "../src/codegen/index.ts";
import { loadProject, type Project } from "../src/config.ts";
import { exportEmber, importEmber } from "../src/export.ts";
import { importConvexDeltas } from "../src/import-convex-delta.ts";
import type { ImportTarget } from "../src/import-convex.ts";
import { startLocal } from "../src/local.ts";
import { ZipReader } from "../src/zip.ts";
import { TMP } from "./helpers.ts";

const root = join(TMP, `import-delta-${process.pid}`);
const SCHEMA = `import { defineSchema, defineShard, defineTable, v } from "@freecorps/ember-server";
export default defineSchema({
  shards: { org: defineShard({ key: v.string() }) },
  tables: {
    projects: defineTable({ org: v.string(), name: v.string() }),
    tasks: defineTable({ projectId: v.id("projects"), title: v.string(), n: v.optional(v.int64()) }).index("by_project", ["projectId"]),
  },
});
`;
const CONFIG = `import { defineImport } from "@freecorps/ember-server";
export default defineImport({ route: (table, doc) => (table === "projects" ? "org:" + doc.org : null), via: { tasks: "projectId" } });
`;
const FUNCTIONS = `import { queryGeneric, v } from "@freecorps/ember-server";
export const all = queryGeneric({ args: {}, handler: (ctx) => ({ projects: ctx.db.query("projects").collect(), tasks: ctx.db.query("tasks").collect() }) });
`;

// ------------------------------------------------------------------ fake Convex deployment

const KEY = "prod:fake|secret";
const rnd = seededRandom(9);
type Entry = { ts: bigint; table: string; id: string; doc: Record<string, unknown> | null };
const log: Entry[] = [];
let clock = 1_731_000_000_000_000_000n; // ns: above 2^53, must survive JSON
const write = (table: string, doc: Record<string, unknown> | null, id = String(doc?._id)) => log.push({ ts: (clock += 1000n), table, id, doc });
const stateAt = (ts: bigint, table: string) => {
  const docs = new Map<string, Record<string, unknown>>();
  for (const e of log) if (e.ts <= ts && e.table === table) (e.doc ? docs.set(e.id, e.doc) : docs.delete(e.id));
  return [...docs.values()];
};
const big = (o: Record<string, unknown>, keys: string[]) => {
  // Integers written raw, like Convex does (JSON.stringify would refuse a bigint).
  let s = JSON.stringify(o, (k, v) => (keys.includes(k) && typeof v === "bigint" ? `__BIG__${v}` : v));
  return s.replace(/"__BIG__(\d+)"/g, "$1");
};
const calls: string[] = [];
let server: Server;
let convexUrl: string;

function startFake(): Promise<void> {
  server = createServer((req, res) => {
    const url = new URL(req.url!, "http://x");
    calls.push(`${url.pathname}?${url.searchParams}`);
    if (req.headers.authorization !== `Convex ${KEY}`) return void res.writeHead(401).end("bad key");
    const q = url.searchParams;
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/api/json_schemas") return void res.end(JSON.stringify({ projects: {}, tasks: {}, legacy: {} }));
    if (url.pathname === "/api/list_snapshot") {
      const snapshot = q.has("snapshot") ? BigInt(q.get("snapshot")!) : clock;
      const all = stateAt(snapshot, q.get("tableName")!);
      const at = Number(q.get("cursor") ?? 0);
      const page = all.slice(at, at + 3).map((d) => ({ ...d, _table: q.get("tableName"), _ts: snapshot }));
      return void res.end(big({ values: page, hasMore: at + 3 < all.length, snapshot, cursor: String(at + 3) }, ["snapshot", "_ts"]));
    }
    if (url.pathname === "/api/document_deltas") {
      const cursor = BigInt(q.get("cursor")!);
      const after = log.filter((e) => e.ts > cursor);
      const page = after.slice(0, 4);
      const values = page.map((e) => (e.doc ? { ...e.doc, _table: e.table, _ts: e.ts } : { _id: e.id, _ts: e.ts, _deleted: true, _table: e.table }));
      return void res.end(big({ values, hasMore: after.length > 4, cursor: page.length ? page[page.length - 1]!.ts : cursor }, ["cursor", "_ts"]));
    }
    res.writeHead(404).end("{}");
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r()));
}

// ------------------------------------------------------------------ setup

const P = 10011;
const T = 10012;
const projects = ["acme", "acme", "globex"].map((org, i) => ({ _id: makeConvexId(P, rnd), _creationTime: 1700000000000 + i + 0.5, org, name: `p${i}` }));
const tasks = Array.from({ length: 7 }, (_, i) => ({ _id: makeConvexId(T, rnd), _creationTime: 1700000001000 + i / 3, projectId: projects[i % 3]!._id, title: `t${i}`, ...(i === 1 ? { n: "18446744073709551" } : {}) }));

let project: Project;
let mf: Miniflare;
let mf2: Miniflare;
let target: ImportTarget;
let target2: ImportTarget;

const targetOf = async (m: Miniflare): Promise<ImportTarget> => ({
  url: (await m.ready).href,
  adminToken: "local-admin",
  fetch: ((input: RequestInfo | URL, init?: RequestInit) => m.dispatchFetch(String(input), init as never)) as unknown as typeof fetch,
});
const read = async (t: ImportTarget, shard: string) => {
  const res = await t.fetch!(new URL("/api/query", t.url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fn: "data:all", args: {}, shard }) });
  const body = (await res.json()) as { ok: boolean; value: unknown; error?: { message: string } };
  if (!body.ok) throw new Error(body.error?.message);
  return decodeJson(JSON.stringify(body.value)) as { projects: Array<Record<string, unknown>>; tasks: Array<Record<string, unknown>> };
};

beforeAll(async () => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, "ember"), { recursive: true });
  writeFileSync(join(root, "ember.json"), JSON.stringify({ project: "delta", compatibilityDate: "2026-10-01", environments: { prod: {} }, resources: { files: true } }));
  writeFileSync(join(root, "ember", "schema.ts"), SCHEMA);
  writeFileSync(join(root, "ember", "import.config.ts"), CONFIG);
  writeFileSync(join(root, "ember", "data.ts"), FUNCTIONS);
  project = loadProject(root);
  for (const p of projects) write("projects", p);
  for (const t of tasks) write("tasks", t);
  await startFake();
  convexUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  await codegen(project);
  const build = await buildWorker(project);
  ({ mf } = await startLocal(project, build, { persist: false, vars: { EMBER_ADMIN_TOKEN: "local-admin" } }));
  ({ mf: mf2 } = await startLocal(project, build, { persist: false, vars: { EMBER_ADMIN_TOKEN: "local-admin" } }));
  target = await targetOf(mf);
  target2 = await targetOf(mf2);
}, 120_000);
afterAll(async () => {
  await mf?.dispose();
  await mf2?.dispose();
  server?.close();
  rmSync(root, { recursive: true, force: true });
});

describe("delta mode", () => {
  it("refuses a wrong deploy key", async () => {
    await expect(importConvexDeltas({ project, target, deployment: convexUrl, deployKey: "nope", fresh: true })).rejects.toThrow(/401/);
  });

  it("snapshot, then deltas: updates, deletes, a route change; the cursor is kept between runs", async () => {
    const r1 = await importConvexDeltas({ project, target, deployment: convexUrl, deployKey: KEY, fresh: true });
    expect(r1.snapshot).toMatchObject({ done: true, documents: 10 });
    expect(r1.foreignIds.convex).toEqual({ [P]: "projects", [T]: "tasks" });
    expect(BigInt(r1.cursor!)).toBeGreaterThan(2n ** 53n);
    expect(calls.some((c) => c.startsWith("/api/list_snapshot") && c.includes(`snapshot=${r1.cursor}`))).toBe(true);
    const acme = await read(target, "org:acme");
    expect(acme.projects.map((p) => p._id).sort()).toEqual([projects[0]!._id, projects[1]!._id].sort());
    expect(acme.tasks).toHaveLength(5);
    expect(acme.tasks.find((t) => t._id === tasks[1]!._id)).toEqual({ ...tasks[1], n: 18446744073709551n });

    // Changes on the deployment: an update, a delete, a new project with a task, a project moved to another org.
    write("tasks", { ...tasks[0]!, title: "renamed" });
    write("tasks", null, tasks[3]!._id);
    const p3 = { _id: makeConvexId(P, rnd), _creationTime: 1700000009000, org: "initech", name: "p3" };
    write("projects", p3);
    write("tasks", { _id: makeConvexId(T, rnd), _creationTime: 1700000009001, projectId: p3._id, title: "new" });
    write("projects", { ...projects[1]!, org: "globex" });
    write("legacy", { _id: makeConvexId(10013, rnd), _creationTime: 1, x: 1 });

    const r2 = await importConvexDeltas({ project, target, deployment: convexUrl, deployKey: KEY });
    expect(r2.snapshot.documents).toBe(0);
    expect(r2.deltas).toMatchObject({ upserts: 4, deletes: 1, moved: 1, ignored: 1, rounds: 1 });
    const acme2 = await read(target, "org:acme");
    expect(acme2.projects.map((p) => p._id)).toEqual([projects[0]!._id]);
    expect(acme2.tasks.find((t) => t._id === tasks[0]!._id)?.title).toBe("renamed");
    expect(acme2.tasks.find((t) => t._id === tasks[3]!._id)).toBeUndefined();
    const globex = await read(target, "org:globex");
    expect(globex.projects.map((p) => p.name).sort()).toEqual(["p1", "p2"]);
    // Children stay where they were: moving a parent does not move them (documented).
    expect(acme2.tasks.filter((t) => t.projectId === projects[1]!._id)).toHaveLength(2);
    expect((await read(target, "org:initech")).tasks.map((t) => t.title)).toEqual(["new"]);

    // Nothing new: a round with no changes; --since replays from an explicit cursor (idempotent).
    const r3 = await importConvexDeltas({ project, target, deployment: convexUrl, deployKey: KEY, watch: true, intervalMs: 10, maxRounds: 2 });
    expect(r3.deltas).toMatchObject({ upserts: 0, rounds: 2 });
    expect(r3.cursor).toBe(r2.cursor);
    // --since keeps the routes of the state file: children of parents that are not in the deltas still find them.
    const r4 = await importConvexDeltas({ project, target, deployment: convexUrl, deployKey: KEY, since: r1.cursor! });
    expect(r4.snapshot.documents).toBe(0);
    expect(r4.deltas).toMatchObject({ upserts: 4, orphans: 0 });
    // A new state file has no routes: a child whose parent is not in the deltas is skipped (and counted).
    const r5 = await importConvexDeltas({ project, target, deployment: convexUrl, deployKey: KEY, fresh: true, since: r1.cursor! });
    expect(r5.deltas).toMatchObject({ upserts: 3, orphans: 1 });
    expect((await read(target, "org:acme")).tasks.find((t) => t._id === tasks[0]!._id)?.title).toBe("renamed");
  }, 60_000);
});

describe("ember export → ember import ember", () => {
  it("copies every shard (ids, _creationTime, the foreign-id map) to another deployment", async () => {
    const out = join(root, "export.zip");
    const shards = ["org:acme", "org:globex", "org:initech"];
    const m = await exportEmber({ project, target, shards, out });
    expect(m.shards.map((s) => [s.name, s.tables])).toEqual([
      ["org:acme", { projects: 1, tasks: 4 }],
      ["org:globex", { projects: 2, tasks: 2 }],
      ["org:initech", { projects: 1, tasks: 1 }],
    ]);
    expect(m.shards[0]!.foreignIds?.convex).toEqual({ [P]: "projects", [T]: "tasks" });
    const z = await ZipReader.open(out);
    expect(z.entries.map((e) => e.name)).toContain("ember-export.json");
    await z.close();

    const r = await importEmber({ project, target: target2, zip: out });
    expect(r.shards.map((s) => s.documents)).toEqual([5, 4, 2]);
    for (const s of shards) expect(await read(target2, s)).toEqual(await read(target, s));
    // Same verify hash on both sides.
    for (const s of shards)
      for (const table of ["projects", "tasks"]) {
        const h = async (t: ImportTarget) => (await (await t.fetch!(new URL(`/api/_ember/import/hash?shard=${s}&table=${table}`, t.url), { headers: { authorization: "Bearer local-admin" } })).json()) as { value: unknown };
        expect((await h(target2)).value).toEqual((await h(target)).value);
      }
    // Again: everything already finished (resumable state), nothing sent twice.
    const again = await importEmber({ project, target: target2, zip: out });
    expect(again.shards.map((s) => s.documents)).toEqual([0, 0, 0]);
  }, 60_000);
});
