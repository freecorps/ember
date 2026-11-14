// Dashboard data editing (admin-data.ts): writes go through the engine (schema validation, indexes, change log,
// subscribers), reads filter and order by index, internal tables stay read-only, and the `_ember` functions are not
// callable by clients.
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ServerMessage } from "../src/protocol.ts";
import { api, connect, hello, is } from "./helpers.ts";

type Patch = Extract<ServerMessage, { t: "patch" }>;

const admin = (path: string, body?: unknown, token: string | null = "admin-secret") =>
  SELF.fetch(`http://ember/api/_ember/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));

describe("dashboard data endpoints", () => {
  it("schema: the app's tables with their fields and indexes; internal and component tables are left out", async () => {
    const r = await admin("schema");
    expect(r.status).toBe(200);
    const messages = r.body.tables.find((t: { name: string }) => t.name === "messages");
    expect(messages.document).toBeTypeOf("object");
    expect(messages.indexes).toEqual(expect.arrayContaining([{ name: "by_channel", kind: "db", fields: ["channel"] }]));
    expect(r.body.tables.every((t: { name: string }) => !t.name.startsWith("_") && !t.name.includes("$"))).toBe(true);
    expect((await admin("schema", undefined, null)).status).toBe(401);
  });

  it("insert / patch / replace / delete run as mutations: validated, indexed, and seen by subscribers", async () => {
    const shard = "dash:edit";
    const sub = await connect(shard);
    await hello(sub);
    sub.send({ t: "sub", qid: "l", fn: "messages:list", args: { channel: "ops" } });
    await sub.waitFor(is("snap"));

    const ins = await admin("data/insert", { shard, table: "messages", doc: { channel: "ops", body: "from the dashboard", _id: "forged", _creationTime: 1 } });
    expect(ins.status).toBe(200);
    const id = ins.body.value as string;
    expect(id).not.toBe("forged");
    const p = await sub.waitFor<Patch>(is("patch"));
    expect(p.changes.map((c) => c.qid)).toEqual(["l"]);

    // The index sees it: a list through by_channel finds it, newest first.
    const list = await admin(`data/list?shard=${shard}&table=messages&index=by_channel&eq=${encodeURIComponent(JSON.stringify(["ops"]))}&order=desc`);
    expect(list.status).toBe(200);
    expect(list.body.value.page.map((d: { _id: string }) => d._id)).toEqual([id]);
    expect((await admin(`data/list?shard=${shard}&table=messages&index=by_channel&eq=${encodeURIComponent(JSON.stringify(["other"]))}`)).body.value.page).toEqual([]);

    // Schema validation: a wrong type or a missing required field is refused, nothing written.
    const bad = await admin("data/insert", { shard, table: "messages", doc: { channel: 1, body: "x" } });
    expect([bad.status, bad.body.error.code]).toEqual([400, "ValidationError"]);
    const missing = await admin("data/patch", { shard, table: "messages", id, fields: { body: undefined, channel: 5 } });
    expect(missing.status).toBe(400);

    const patched = await admin("data/patch", { shard, table: "messages", id, fields: { body: "edited" } });
    expect(patched.body.value).toMatchObject({ _id: id, channel: "ops", body: "edited" });
    await sub.waitFor<Patch>(is("patch"));
    const replaced = await admin("data/replace", { shard, table: "messages", id, doc: { channel: "moved", body: "replaced" } });
    expect(replaced.body.value).toMatchObject({ _id: id, channel: "moved", body: "replaced" });
    // The index follows the replace.
    expect((await admin(`data/list?shard=${shard}&table=messages&index=by_channel&eq=${encodeURIComponent(JSON.stringify(["moved"]))}`)).body.value.page).toHaveLength(1);

    // An id of another table, or a missing one, is refused before anything changes (all or nothing).
    const other = await admin("data/insert", { shard, table: "runs", doc: { label: "r", at: 1 } });
    const mixed = await admin("data/delete", { shard, table: "messages", ids: [id, other.body.value] });
    expect([mixed.status, mixed.body.error.code]).toEqual([404, "NotFound"]);
    expect((await admin(`data/list?shard=${shard}&table=messages`)).body.value.page).toHaveLength(1);
    const del = await admin("data/delete", { shard, table: "messages", ids: [id] });
    expect(del.body.value).toEqual({ deleted: 1 });
    expect((await admin(`data/list?shard=${shard}&table=messages`)).body.value.page).toEqual([]);
    sub.close();
  });

  it("internal tables, unknown tables and non-db indexes are refused; the functions are not callable by clients", async () => {
    const shard = "dash:guard";
    expect((await admin("data/insert", { shard, table: "_jobs", doc: {} })).body.error.code).toBe("Forbidden");
    expect((await admin("data/insert", { shard, table: "_jobs", doc: {} })).status).toBe(403);
    expect((await admin("data/delete", { shard, table: "nope", ids: [] })).status).toBe(404);
    expect((await admin(`data/list?shard=${shard}&table=messages&index=search_body`)).status).toBe(404);
    expect((await admin(`data/list?shard=${shard}&table=messages&eq=notjson`)).status).toBe(400);
    expect((await admin("data/insert", { shard: "no colon", table: "messages", doc: {} })).status).toBe(400);
    expect((await admin("data/insert", { shard, table: "messages", doc: { channel: "x", body: "y" } }, "wrong")).status).toBe(401);
    // A client calling the internal functions directly is refused.
    const q = await api("query", { fn: "_ember:dataList", args: { table: "messages" }, shard });
    expect(q.status).toBeGreaterThanOrEqual(400);
    const m = await api("mutation", { fn: "_ember:dataInsert", args: { table: "messages", doc: { channel: "x", body: "y" } }, shard });
    expect(m.status).toBeGreaterThanOrEqual(400);
    expect((await admin(`data/list?shard=${shard}&table=messages`)).body.value.page).toEqual([]);
  });

  it("pages with a cursor in either order", async () => {
    const shard = "dash:page";
    for (let i = 0; i < 5; i++) await admin("data/insert", { shard, table: "runs", doc: { label: `r${i}`, at: i } });
    const first = await admin(`data/list?shard=${shard}&table=runs&limit=2&order=desc`);
    expect(first.body.value.page.map((d: { label: string }) => d.label)).toEqual(["r4", "r3"]);
    const second = await admin(`data/list?shard=${shard}&table=runs&limit=2&order=desc&cursor=${encodeURIComponent(first.body.value.continueCursor)}`);
    expect(second.body.value.page.map((d: { label: string }) => d.label)).toEqual(["r2", "r1"]);
  });
});
