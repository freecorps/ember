// Dashboard schedules and files (admin-api.ts handleOps): jobs run and cancel through the engine's scheduler, a cron
// runs now on its shard, files list / content / upload / delete through the shard's file storage (referenced files
// are refused, bytes always come back as an attachment).
import { runDurableObjectAlarm, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { api, shardStub } from "./helpers.ts";

const admin = (path: string, init: { body?: unknown; raw?: BodyInit; method?: string; headers?: Record<string, string> } = {}) =>
  SELF.fetch(`http://ember/api/_ember/${path}`, {
    method: init.method ?? (init.body !== undefined || init.raw !== undefined ? "POST" : "GET"),
    headers: { authorization: "Bearer admin-secret", ...(init.body !== undefined ? { "content-type": "application/json" } : {}), ...init.headers },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : init.raw !== undefined ? { body: init.raw } : {}),
  });
const json = async (r: Promise<Response>) => {
  const res = await r;
  return { status: res.status, body: (await res.json()) as any };
};

const jobs = async (shard: string) => (await shardStub(shard).inspect()).jobs as Array<{ job_id: string; fn: string; state: string }>;
const runs = async (shard: string) => ((await api("query", { fn: "runs:list", args: {}, shard })).body.value ?? []) as Array<{ label: string }>;

describe("schedules", () => {
  it("cancels a pending job; runs a job now; refuses queries and the dashboard's own functions", async () => {
    const shard = "ops:jobs";
    const later = await api("mutation", { fn: "jobs:later", args: { label: "later" }, shard });
    const id = later.body.value as string;
    expect((await jobs(shard)).map((j) => j.job_id)).toContain(id);
    const cancel = await json(admin("jobs/cancel", { body: { shard, id } }));
    expect(cancel.status).toBe(200);
    expect((await jobs(shard)).map((j) => j.job_id)).not.toContain(id);

    const run = await json(admin("jobs/run", { body: { shard, fn: "jobs:record", args: { label: "now" } } }));
    expect(run.status).toBe(200);
    expect(run.body.value).toBeTypeOf("string");
    await runDurableObjectAlarm(shardStub(shard));
    expect((await runs(shard)).map((r) => r.label)).toContain("now");

    expect((await json(admin("jobs/run", { body: { shard, fn: "messages:list", args: {} } }))).status).toBe(404);
    expect((await json(admin("jobs/run", { body: { shard, fn: "_ember:dataInsert", args: {} } }))).status).toBe(404);
    expect((await json(admin("jobs/run", { body: { shard: "bad", fn: "jobs:record" } }))).status).toBe(400);
  });

  it("runs a cron now, on its own shard, with its own args", async () => {
    const r = await json(admin("crons/run", { body: { name: "every-5" } }));
    expect(r.status).toBe(200);
    await runDurableObjectAlarm(shardStub("org:crons"));
    expect((await runs("org:crons")).map((x) => x.label)).toContain("every-5");
    expect((await json(admin("crons/run", { body: { name: "nope" } }))).status).toBe(404);
  });
});

describe("files", () => {
  it("upload, content as an attachment with the real type in a header, delete; referenced files refused", async () => {
    const shard = "ops:files";
    const up = await json(admin(`files/upload?shard=${shard}&contentType=${encodeURIComponent("text/html")}`, { raw: "<script>alert(1)</script>" }));
    expect(up.status).toBe(200);
    const id = up.body.value.id as string;
    const content = await admin(`files/content?shard=${shard}&id=${encodeURIComponent(id)}`);
    expect(content.headers.get("content-type")).toBe("application/octet-stream");
    expect(content.headers.get("content-disposition")).toBe("attachment");
    expect(content.headers.get("x-content-type-options")).toBe("nosniff");
    expect(content.headers.get("x-ember-content-type")).toBe("text/html");
    expect(await content.text()).toBe("<script>alert(1)</script>");
    // The list is the shard's `_files` table (read-only browser).
    const list = await json(admin(`data?shard=${shard}&table=_files`));
    expect(list.body.rows.map((r: { id: string }) => r.id)).toContain(id);

    // A file a document points at cannot be deleted.
    const photo = await api("mutation", { fn: "files:add", args: { title: "p", file: id }, shard });
    expect(photo.status).toBe(200);
    const refused = await json(admin(`files/delete?shard=${shard}&id=${encodeURIComponent(id)}`, { method: "POST", raw: "" }));
    expect([refused.status, refused.body.error.code]).toEqual([409, "FileInUse"]);
    const free = await json(admin(`files/upload?shard=${shard}`, { raw: "free" }));
    const del = await json(admin(`files/delete?shard=${shard}&id=${encodeURIComponent(free.body.value.id)}`, { method: "POST", raw: "" }));
    expect(del.status).toBe(200);
    expect((await admin(`files/content?shard=${shard}&id=nope`)).status).toBe(404);
    expect((await json(admin(`files/upload?shard=bad`, { raw: "x" }))).status).toBe(400);
  });
});
