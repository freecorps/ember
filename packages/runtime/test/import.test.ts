// `ember import` admin endpoints (admin-api.ts, contracts.md "Importar do Convex") in workerd: batches with foreign
// ids, the validation report, search after the import, files with their original storage ids (bytes in
// the local R2), the verify hash, and what live subscribers see.
import { env, runDurableObjectAlarm, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DocSetHash, fileKey, makeConvexId, seededRandom, storageDigestDoc } from "@freecorps/ember-server";
import { decodeJson, encodeJson } from "@freecorps/ember-values";
import { api, connect, hello, shardStub } from "./helpers.ts";

const rnd = seededRandom(11);
const MESSAGES = 10001;
const PHOTOS = 10002;
const STORAGE = 28;
const foreignIds = { convex: { [MESSAGES]: "messages", [PHOTOS]: "photos" } };

const admin = (path: string, init: RequestInit = {}) =>
  SELF.fetch(`http://ember/api/_ember/import/${path}`, { ...init, headers: { authorization: "Bearer admin-secret", ...(init.body && typeof init.body === "string" ? { "content-type": "application/json" } : {}), ...(init.headers as Record<string, string> | undefined) } });
const post = async (path: string, body: unknown) => {
  const r = await admin(path, { method: "POST", body: encodeJson(body) });
  return { status: r.status, body: (await r.json()) as any };
};
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

describe("import endpoints", () => {
  it("batches keep ids and _creationTime, report invalid documents, and search follows", async () => {
    const shard = "global:import-a";
    expect((await post("batch", { shard, table: "messages", docs: [] })).status).toBe(200);
    const notBegun = await post("batch", { shard, table: "messages", docs: [{ _id: makeConvexId(MESSAGES, rnd), _creationTime: 1, channel: "c", body: "b" }] });
    expect(notBegun.status).toBe(400);
    expect(notBegun.body.error.code).toBe("ImportNotBegun");

    const begun = await post("begin", { shard, foreignIds, tables: ["messages", "photos"] });
    expect(begun.body).toEqual({ ok: true, value: { converted: ["messages", "photos"] } });

    const docs = Array.from({ length: 250 }, (_, i) => ({
      _id: makeConvexId(MESSAGES, rnd),
      _creationTime: 1700697415295.742 + i * 0.001,
      channel: i % 2 ? "odd" : "even",
      body: i === 42 ? "the needle" : `message ${i}`,
      n: BigInt(i) * 10n ** 15n,
      blob: Uint8Array.of(i % 256),
    }));
    const bad = { _id: makeConvexId(MESSAGES, rnd), _creationTime: 5, channel: 7, body: "x" };
    const r = await post("batch", { shard, table: "messages", docs: [...docs, bad] });
    expect(r.status).toBe(200);
    expect(r.body.value.written).toBe(250);
    expect(r.body.value.invalid).toEqual([{ index: 250, id: bad._id, message: expect.stringMatching(/channel/) }]);
    const strict = await post("batch", { shard, table: "messages", docs: [bad], strict: true });
    expect(strict.status).toBe(400);

    const list = await api("query", { fn: "messages:list", args: { channel: "even" }, shard });
    expect(list.body.value).toHaveLength(125);
    expect(decodeJson(JSON.stringify(list.body.value[0]))).toEqual(docs[0]);
    const found = await api("query", { fn: "messages:search", args: { q: "needle" }, shard });
    expect(found.body.value).toEqual(["the needle"]);

    // New documents get Ember ids in the same table.
    const sent = await api("mutation", { fn: "messages:send", args: { channel: "even", body: "native" }, shard });
    expect(sent.body.ok).toBe(true);
    expect((await api("query", { fn: "messages:list", args: { channel: "even" }, shard })).body.value).toHaveLength(126);

    // Deletes (delta mode) and the verify hash, page by page.
    const del = await post("batch", { shard, table: "messages", deletes: [docs[0]!._id] });
    expect(del.body.value.deleted).toBe(1);
    const want = new DocSetHash();
    for (const d of docs.slice(1)) want.add(d);
    const got = new DocSetHash();
    let after = 0;
    for (;;) {
      const page = (await (await admin(`hash?shard=${shard}&table=messages&after=${after}&limit=100`)).json()) as any;
      got.merge(page.value);
      if (page.value.next === null) break;
      after = page.value.next;
    }
    // The native message is in the shard too.
    expect(got.count).toBe(250);
    want.add((await api("query", { fn: "messages:list", args: { channel: "even" }, shard })).body.value.find((m: any) => m.body === "native"));
    expect(got.sum).toBe(want.sum);
    const fin = await post("finish", { shard });
    expect(fin.body.value).toEqual({ staged: [], refcounts: null });
  });

  it("live subscribers are reset: new epoch and sockets closed (1012)", async () => {
    const shard = "global:import-b";
    await api("mutation", { fn: "messages:send", args: { channel: "c", body: "before" }, shard });
    const before = await shardStub(shard).inspect();
    const c = await connect(shard);
    await hello(c);
    const closed = new Promise<number>((res) => c.ws.addEventListener("close", (e) => res(e.code)));
    await post("begin", { shard, foreignIds, tables: ["messages"] });
    expect(await closed).toBe(1012);
    expect((await shardStub(shard).inspect()).epoch).not.toBe(before.epoch);
  });

  it("files: bytes at the content-addressed key, rows with the original storage id, refcounts recounted", async () => {
    const shard = "global:import-c";
    const data = new TextEncoder().encode("imported bytes");
    const sha = hex(await crypto.subtle.digest("SHA-256", data));
    const wrong = await admin(`blob?shard=${shard}&sha256=${"0".repeat(64)}`, { method: "PUT", body: data, headers: { "content-length": String(data.length) } });
    expect(wrong.status).toBe(400);
    const put = await admin(`blob?shard=${shard}&sha256=${sha}&contentType=text/plain`, { method: "PUT", body: data, headers: { "content-length": String(data.length) } });
    expect(((await put.json()) as any).value).toMatchObject({ key: fileKey(shard, sha), exists: false });
    const again = await admin(`blob?shard=${shard}&sha256=${sha}`, { method: "PUT", body: data, headers: { "content-length": String(data.length) } });
    expect(((await again.json()) as any).value.exists).toBe(true);
    expect(await (await env.EMBER_FILES.get(fileKey(shard, sha)))!.text()).toBe("imported bytes");

    const storageId = makeConvexId(STORAGE, rnd);
    const unreferenced = makeConvexId(STORAGE, rnd);
    await post("begin", { shard, foreignIds, tables: ["photos"] });
    const rows = [
      { id: storageId, sha256: sha, size: data.length, contentType: "text/plain", createdAt: 1700697415295.742 },
      { id: unreferenced, sha256: sha, size: data.length, contentType: null, createdAt: 1 },
    ];
    expect((await post("files", { shard, rows })).body.value).toEqual({ written: 2 });
    const photo = { _id: makeConvexId(PHOTOS, rnd), _creationTime: 1700000000000.5, title: "p", file: storageId, thumbs: [storageId] };
    expect((await post("batch", { shard, table: "photos", docs: [photo] })).body.value.written).toBe(1);
    const fin = await post("finish", { shard });
    expect(fin.body.value.refcounts).toBe(1);
    const meta = await api("query", { fn: "files:meta", args: { id: storageId }, shard });
    expect(meta.body.value).toMatchObject({ storageId, sha256: sha, size: data.length, contentType: "text/plain", state: "ready" });
    // The app's own download path serves the imported bytes.
    const url = await api("query", { fn: "files:url", args: { id: photo._id }, shard });
    const dl = await SELF.fetch(url.body.value.startsWith("http") ? url.body.value : `http://ember${url.body.value}`);
    expect(await dl.text()).toBe("imported bytes");
    // The GC keeps the unreferenced import (zero_since NULL) and the referenced one.
    await runDurableObjectAlarm(shardStub(shard));
    expect((await api("query", { fn: "files:meta", args: { id: unreferenced }, shard })).body.value).toMatchObject({ state: "ready" });
    // `_storage` hash.
    const h = new DocSetHash();
    for (const r of rows) h.add(storageDigestDoc(r));
    const page = (await (await admin(`hash?shard=${shard}&table=_storage`)).json()) as any;
    expect(page.value).toEqual({ count: 2, sum: h.sum, next: null });
  });

  it("a table number that already names another table is a conflict (409)", async () => {
    const shard = "global:import-d";
    await post("begin", { shard, foreignIds, tables: ["messages"] });
    const conflict = await post("begin", { shard, foreignIds: { convex: { [MESSAGES]: "photos" } }, tables: [] });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe("ImportConflict");
  });
});
