// `ember import convex` end to end against a local runtime (Miniflare, local R2), from a synthetic Convex snapshot
// ZIP built here: routing with `via`, ids / `_creationTime` / storage ids kept, invalid documents reported, dry run,
// an interrupted run resumed, and `ember import verify` (match, then a mismatch after a write).
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Miniflare } from "miniflare";
import { decodeJson } from "@freecorps/ember-values";
import { makeConvexId, seededRandom } from "@freecorps/ember-server";
import { buildWorker } from "../src/build.ts";
import { codegen } from "../src/codegen/index.ts";
import { loadProject, type Project } from "../src/config.ts";
import { fromConvexJson, importConvex, normalizeSha256, verifyConvex, type ImportTarget } from "../src/import-convex.ts";
import { startLocal } from "../src/local.ts";
import { ZipReader, ZipWriter } from "../src/zip.ts";
import { TMP } from "./helpers.ts";

const root = join(TMP, `import-convex-${process.pid}`);
const SCHEMA = `import { defineSchema, defineShard, defineTable, v } from "@freecorps/ember-server";
export default defineSchema({
  shards: { org: defineShard({ key: v.string() }) },
  tables: {
    orgs: defineTable({ name: v.string() }),
    projects: defineTable({ orgId: v.id("orgs"), name: v.string() }).index("by_org", ["orgId"]),
    tasks: defineTable({ projectId: v.id("projects"), title: v.string(), points: v.number(), big: v.optional(v.int64()), raw: v.optional(v.bytes()), file: v.optional(v.file()) })
      .index("by_project", ["projectId"]),
  },
});
`;
const CONFIG = `import { defineImport } from "@freecorps/ember-server";
export default defineImport({
  route(table, doc) {
    if (table === "orgs") return doc.name === "skip me" ? null : "org:" + doc._id;
    if (table === "projects") return doc.orgId === globalThis.__skippedOrg ? null : "org:" + doc.orgId;
    return null;
  },
  via: { tasks: "projectId" },
  skip: ["auditLog"],
  transform(table, doc) {
    return table === "projects" ? { ...doc, name: doc.name.trim() } : doc;
  },
});
`;
const FUNCTIONS = `import { mutationGeneric, queryGeneric, v } from "@freecorps/ember-server";
export const get = queryGeneric({ args: { id: v.id("tasks") }, handler: (ctx, { id }) => ctx.db.get(id) });
export const byProject = queryGeneric({ args: { projectId: v.id("projects") }, handler: (ctx, { projectId }) => ctx.db.query("tasks").withIndex("by_project", (q) => q.eq("projectId", projectId)).collect() });
export const meta = queryGeneric({ args: { id: v.string() }, handler: (ctx, { id }) => ctx.storage.getMetadata(id) });
export const rename = mutationGeneric({ args: { id: v.id("tasks"), title: v.string() }, handler: (ctx, { id, title }) => ctx.db.patch(id, { title }) });
`;

const rnd = seededRandom(3);
const N = { orgs: 10001, projects: 10002, tasks: 10003, auditLog: 10004, _storage: 28 };
const id = (t: keyof typeof N) => makeConvexId(N[t], rnd);
const orgs = [{ _id: id("orgs"), _creationTime: 1690000000000.25, name: "Acme" }, { _id: id("orgs"), _creationTime: 1690000000001.5, name: "Globex" }, { _id: id("orgs"), _creationTime: 1690000000002.75, name: "skip me" }];
const projects = [
  { _id: id("projects"), _creationTime: 1690000001000.1, orgId: orgs[0]!._id, name: " Rockets " },
  { _id: id("projects"), _creationTime: 1690000001000.2, orgId: orgs[1]!._id, name: "Lasers" },
  { _id: id("projects"), _creationTime: 1690000001000.3, orgId: orgs[2]!._id, name: "Hidden" },
];
const fileBytes = Buffer.from("a picture, honestly");
const storageId = id("_storage");
const unreferenced = id("_storage");
const tasks = Array.from({ length: 23 }, (_, i) => ({
  _id: id("tasks"),
  _creationTime: 1700697415295.742 + i / 7,
  projectId: projects[i % 3]!._id,
  title: `task ${i}`,
  points: i + 0.5,
  ...(i === 4 ? { big: "9007199254740993" } : {}),
  ...(i === 5 ? { raw: Buffer.from([1, 2, 3]).toString("base64") } : {}),
  ...(i === 6 ? { file: storageId } : {}),
}));
// Invalid: a title that is a number (reported, not imported). Its project (Acme) is imported.
const invalidTask = { _id: id("tasks"), _creationTime: 1700697415999, projectId: projects[0]!._id, title: 42, points: 1 };

async function writeSnapshot(path: string) {
  const w = new ZipWriter(path);
  const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  await w.add("_tables/documents.jsonl", jsonl(Object.entries(N).filter(([t]) => t !== "_storage").map(([name, n]) => ({ name, id: n }))));
  await w.add("orgs/documents.jsonl", jsonl(orgs));
  await w.add("orgs/generated_schema.jsonl", `${JSON.stringify("{_creationTime: normalfloat64, _id: string, name: string}")}\n`);
  await w.add("projects/documents.jsonl", jsonl(projects));
  // Streamed in chunks (like a multi-GB entry would be).
  await w.add("tasks/documents.jsonl", (function* () {
    for (const t of [...tasks, invalidTask]) yield `${JSON.stringify(t)}\n`;
  })());
  await w.add("auditLog/documents.jsonl", jsonl([{ _id: id("auditLog"), _creationTime: 1, what: "x" }]));
  await w.add("unknownTable/documents.jsonl", jsonl([{ _id: makeConvexId(10099, rnd), _creationTime: 1, x: 1 }]));
  await w.add("_storage/documents.jsonl", jsonl([
    { _id: storageId, _creationTime: 1690000000000.5, sha256: createHash("sha256").update(fileBytes).digest("base64"), size: fileBytes.length, contentType: "image/png" },
    { _id: unreferenced, _creationTime: 1690000000000.6, sha256: "0".repeat(64), size: 3, contentType: "text/plain" },
  ]));
  await w.add(`_storage/${storageId}`, fileBytes);
  await w.add(`_storage/${unreferenced}`, Buffer.from("abc"));
  await w.close();
}

let project: Project;
let mf: Miniflare;
let target: ImportTarget;
const zip = join(root, "snapshot.zip");
const logs: string[] = [];
const log = (l: string) => logs.push(l);

beforeAll(async () => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, "ember"), { recursive: true });
  writeFileSync(join(root, "ember.json"), JSON.stringify({ project: "imp", compatibilityDate: "2026-10-01", environments: { prod: {} }, resources: { files: true } }));
  writeFileSync(join(root, "ember", "schema.ts"), SCHEMA);
  writeFileSync(join(root, "ember", "import.config.ts"), CONFIG);
  writeFileSync(join(root, "ember", "tasks.ts"), FUNCTIONS);
  project = loadProject(root);
  await writeSnapshot(zip);
  (globalThis as Record<string, unknown>).__skippedOrg = orgs[2]!._id;
  await codegen(project);
  const build = await buildWorker(project);
  ({ mf } = await startLocal(project, build, { persist: false, vars: { EMBER_ADMIN_TOKEN: "local-admin" } }));
  const url = await mf.ready;
  target = { url: url.href, adminToken: "local-admin", fetch: ((input: RequestInfo | URL, init?: RequestInit) => mf.dispatchFetch(String(input), init as never)) as unknown as typeof fetch };
}, 120_000);
afterAll(async () => {
  await mf?.dispose();
  rmSync(root, { recursive: true, force: true });
});

const call = async (kind: "query" | "mutation", fn: string, args: unknown, shard: string) => {
  const res = await mf.dispatchFetch(new URL(`/api/${kind}`, target.url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fn, args, shard }) });
  const body = (await res.json()) as { ok: boolean; value?: unknown; error?: { message: string } };
  if (!body.ok) throw new Error(body.error?.message);
  return decodeJson(JSON.stringify(body.value ?? null));
};

describe("convex values and the zip reader", () => {
  it("converts Convex JSON by the Ember shape", () => {
    expect(fromConvexJson({ kind: "int64" }, "-12")).toBe(-12n);
    expect(fromConvexJson({ kind: "number" }, "NaN")).toBeNaN();
    expect(fromConvexJson({ kind: "bytes" }, "AQID")).toEqual(Uint8Array.of(1, 2, 3));
    expect(fromConvexJson({ kind: "union", members: [{ kind: "null" }, { kind: "int64" }] }, "5")).toBe(5n);
    // A malformed Int64 literal is left as it is (validation reports it), not a SyntaxError out of the pipeline.
    expect(fromConvexJson({ kind: "literal", value: { $int64: "1" } } as never, "1")).toBe(1n);
    expect(fromConvexJson({ kind: "literal", value: { $int64: "1" } } as never, "one")).toBe("one");
    expect(normalizeSha256("A".repeat(64))).toBe("a".repeat(64));
    expect(normalizeSha256(Buffer.alloc(32, 1).toString("base64"))).toBe("01".repeat(32));
    expect(normalizeSha256("nope")).toBeNull();
  });

  it("reads a ZIP written by another tool (stored and deflated entries)", async () => {
    const p = join(root, "py.zip");
    const { execFileSync } = await import("node:child_process");
    try {
      execFileSync("python3", ["-c", `import zipfile\nz=zipfile.ZipFile(${JSON.stringify(p)},'w')\nz.writestr('a/documents.jsonl','{"x":1}\\n{"x":2}\\n',compress_type=zipfile.ZIP_DEFLATED)\nz.writestr('b.bin',b'\\x00\\x01',compress_type=zipfile.ZIP_STORED)\nz.close()`]);
    } catch {
      return; // no python3 here
    }
    const z = await ZipReader.open(p);
    const lines: string[] = [];
    for await (const l of z.lines(z.entry("a/documents.jsonl")!)) lines.push(l);
    expect(lines).toEqual(['{"x":1}', '{"x":2}']);
    expect([...(await z.bytes(z.entry("b.bin")!))]).toEqual([0, 1]);
    await z.close();
  });

  it("closes an entry's stream when the reader stops early", async () => {
    const p = join(root, "early.zip");
    const w = new ZipWriter(p);
    await w.add("a/documents.jsonl", Array.from({ length: 5000 }, (_, i) => `{"x":${i}}`).join("\n"));
    await w.close();
    const z = await ZipReader.open(p);
    const streams: Array<import("node:stream").Readable> = [];
    const stream = z.stream.bind(z);
    z.stream = async (e) => {
      const s = await stream(e);
      streams.push(s);
      return s;
    };
    for await (const l of z.lines(z.entry("a/documents.jsonl")!)) {
      expect(l).toBe('{"x":0}');
      break;
    }
    expect(streams).toHaveLength(1);
    expect(streams[0]!.destroyed).toBe(true);
    const h = await z.digest(z.entry("a/documents.jsonl")!);
    expect(h.size).toBe(Buffer.byteLength(Array.from({ length: 5000 }, (_, i) => `{"x":${i}}`).join("\n")));
    await z.close();
  });
});

describe("ember import convex", () => {
  it("dry run: routes, validates and reports without uploading", async () => {
    const r = await importConvex({ project, zip, dryRun: true, log });
    expect(r.tables.orgs).toMatchObject({ read: 3, imported: 2, skipped: 1 });
    expect(r.tables.projects).toMatchObject({ read: 3, imported: 2, skipped: 1 });
    // 23 tasks: 7 under the skipped org's project (orphans); one invalid.
    expect(r.tables.tasks).toMatchObject({ read: 24, imported: 16, invalid: 1, orphans: 7 });
    expect(r.invalid).toEqual([expect.objectContaining({ table: "tasks", id: invalidTask._id, message: expect.stringMatching(/title/) })]);
    expect(r.shards).toEqual([`org:${orgs[0]!._id}`, `org:${orgs[1]!._id}`].sort());
    expect(r.files).toMatchObject({ entries: 2, imported: 1, skipped: 1 });
    expect(r.warnings.join("\n")).toMatch(/unknownTable of the snapshot is not in ember\/schema.ts/);
    expect(r.warnings.join("\n")).toMatch(/tasks: 1 of the first 24 documents fail the Ember schema at title/);
    expect(r.warnings.join("\n")).not.toMatch(/auditLog/);
    expect(r.foreignIds.convex).toEqual({ "10001": "orgs", "10002": "projects", "10003": "tasks" });
    // Nothing reached the shard: it does not even know the table numbers yet.
    await expect(call("query", "tasks:get", { id: tasks[0]!._id }, `org:${orgs[0]!._id}`)).rejects.toThrow(/id of no table/);
  });

  it("an interrupted run resumes from its checkpoint; ids, _creationTime and files are kept", async () => {
    const first = await importConvex({ project, zip, target, log, batchDocs: 2, checkpointEvery: 4, stopAfterBatches: 3 });
    expect(first.interrupted).toBe(true);
    const saved = JSON.parse(readFileSync(first.stateFile!, "utf8"));
    expect(saved.begun.length).toBeGreaterThan(0);
    expect(saved.finished).toEqual([]);
    const second = await importConvex({ project, zip, target, log, batchDocs: 2, checkpointEvery: 4 });
    expect(second.interrupted).toBeUndefined();
    expect(logs.join("\n")).toMatch(/resuming the import/);
    expect(second.tables.orgs).toMatchObject({ imported: 2 });
    expect(second.tables.tasks).toMatchObject({ imported: 16, invalid: 1, orphans: 7 });
    expect(second.files).toMatchObject({ imported: 1, skipped: 1, uploads: 1 });

    const acme = `org:${orgs[0]!._id}`;
    const t4 = await call("query", "tasks:get", { id: tasks[3]!._id }, acme);
    expect(t4).toEqual({ ...tasks[3] });
    const big = (await call("query", "tasks:get", { id: tasks[4]!._id }, `org:${orgs[1]!._id}`)) as Record<string, unknown>;
    expect(big.big).toBe(9007199254740993n);
    const raw = (await call("query", "tasks:get", { id: tasks[5]!._id }, acme)) as Record<string, unknown>;
    // tasks[5] → projects[2] (skipped org): not imported anywhere.
    expect(raw).toBeNull();
    const listed = (await call("query", "tasks:byProject", { projectId: projects[0]!._id }, acme)) as Array<{ _id: string; _creationTime: number }>;
    expect(listed.map((t) => t._id)).toEqual(tasks.filter((_, i) => i % 3 === 0).map((t) => t._id));
    expect(listed.map((t) => t._creationTime)).toEqual(tasks.filter((_, i) => i % 3 === 0).map((t) => t._creationTime));
    // The file keeps its Convex storage id and is served by the shard of the document that references it.
    expect(await call("query", "tasks:meta", { id: storageId }, acme)).toMatchObject({ storageId, size: fileBytes.length, contentType: "image/png", sha256: createHash("sha256").update(fileBytes).digest("hex") });

    // A third run finds everything done.
    const third = await importConvex({ project, zip, target, log });
    expect(third.tables.tasks).toMatchObject({ imported: 16 });
  }, 60_000);

  it("verify matches, then reports the (table, shard) a later write changed", async () => {
    const ok = await verifyConvex({ project, zip, target, log });
    expect(ok).toMatchObject({ ok: true, mismatches: [] });
    expect(ok.compared).toBe(2 * 4);
    const acme = `org:${orgs[0]!._id}`;
    await call("mutation", "tasks:rename", { id: tasks[0]!._id, title: "changed" }, acme);
    const bad = await verifyConvex({ project, zip, target, log });
    expect(bad.ok).toBe(false);
    expect(bad.mismatches).toEqual([expect.objectContaining({ table: "tasks", shard: acme, expected: expect.objectContaining({ count: 8 }), actual: expect.objectContaining({ count: 8 }) })]);
  }, 60_000);

  it("--only uploads those tables and leaves the others to a later run; verify hashes the files' bytes", async () => {
    const org = { _id: id("orgs"), _creationTime: 1690000000000, name: "Initech" };
    const project2 = { _id: id("projects"), _creationTime: 1690000000001, orgId: org._id, name: "Staplers" };
    const file = id("_storage");
    const bytes = Buffer.from("a stapler");
    const tasks2 = Array.from({ length: 3 }, (_, i) => ({ _id: id("tasks"), _creationTime: 1690000000002 + i, projectId: project2._id, title: `t${i}`, points: i, ...(i === 0 ? { file } : {}) }));
    // A system field: the shard refuses it, so dry run reports it and verify does not expect it.
    const sys = { _id: id("tasks"), _creationTime: 1690000000009, projectId: project2._id, title: "sys", points: 1, _extra: 1 };
    const p = join(root, "only.zip");
    const w = new ZipWriter(p);
    const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
    await w.add("_tables/documents.jsonl", jsonl(Object.entries(N).filter(([t]) => t !== "_storage").map(([name, n]) => ({ name, id: n }))));
    await w.add("orgs/documents.jsonl", jsonl([org]));
    await w.add("projects/documents.jsonl", jsonl([project2]));
    await w.add("tasks/documents.jsonl", jsonl([...tasks2, sys]));
    // The declared sha256 is not the bytes': the import stores the bytes' hash, and verify compares that one.
    await w.add("_storage/documents.jsonl", jsonl([{ _id: file, _creationTime: 1690000000000, sha256: "1".repeat(64), size: 99, contentType: "text/plain" }]));
    await w.add(`_storage/${file}`, bytes);
    await w.close();

    const dry = await importConvex({ project, zip: p, dryRun: true });
    expect(dry.tables.tasks).toMatchObject({ imported: 3, invalid: 1 });
    expect(dry.invalid).toEqual([expect.objectContaining({ id: sys._id, message: expect.stringMatching(/system field _extra/) })]);

    const calls: Array<{ path: string; body: unknown }> = [];
    const spy: ImportTarget = {
      ...target,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/import/begin") || path.endsWith("/import/finish")) calls.push({ path: path.split("/").pop()!, body: JSON.parse(String(init?.body ?? "null")) });
        return target.fetch!(input, init);
      }) as typeof fetch,
    };
    const shard = `org:${org._id}`;
    const first = await importConvex({ project, zip: p, target: spy, only: ["orgs"], log });
    expect(first.tables.orgs).toMatchObject({ imported: 1 });
    expect(first.tables.projects).toMatchObject({ imported: 0 });
    // Only the table that got documents there is pinned classic.
    expect(calls).toEqual([{ path: "begin", body: expect.objectContaining({ shard, tables: ["orgs"] }) }, { path: "finish", body: { shard } }]);
    const saved = JSON.parse(readFileSync(first.stateFile!, "utf8"));
    expect(saved.tables.orgs.done).toBe(true);
    expect(saved.tables.projects?.done).not.toBe(true);
    expect(saved.tables.tasks?.done).not.toBe(true);

    calls.length = 0;
    logs.length = 0;
    const second = await importConvex({ project, zip: p, target: spy, log });
    expect(logs.join("\n")).not.toMatch(/projects: already imported|tasks: already imported/);
    expect(second.tables.projects).toMatchObject({ imported: 1 });
    expect(second.tables.tasks).toMatchObject({ imported: 3, invalid: 1 });
    expect(second.files).toMatchObject({ imported: 1, uploads: 1, shaMismatch: 1 });
    expect(calls.filter((c) => c.path === "begin").map((c) => (c.body as { tables: string[] }).tables)).toEqual([["projects"], ["tasks"]]);
    // The shard finished by the first run got writes again: finished again (aggregates, refcounts).
    expect(calls.filter((c) => c.path === "finish")).toEqual([{ path: "finish", body: { shard } }]);
    expect(await call("query", "tasks:get", { id: tasks2[1]!._id }, shard)).toEqual(tasks2[1]);
    expect(await call("query", "tasks:meta", { id: file }, shard)).toMatchObject({ size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });

    const v = await verifyConvex({ project, zip: p, target, log });
    expect(v).toMatchObject({ ok: true, mismatches: [] });
    expect(v.warnings.join("\n")).toMatch(new RegExp(`_storage ${file}: sha256 in the snapshot .* differs from its bytes`));
  }, 60_000);
});
