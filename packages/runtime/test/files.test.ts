// Files (PLAN §7) end to end in workerd with a Miniflare R2 bucket: proxy-mode uploads (single and multipart),
// confirmation by endpoint and by R2 event (queue), presigned/proxy downloads after the app's permission check,
// refcounts and alarm GC, action helpers (store/get/thumbnail with a mock Images binding).
import { createExecutionContext, env, runDurableObjectAlarm, runInDurableObject, SELF, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { fileKey, s3Signer, tmpKey, type UploadTicket } from "@ember/server";
import { fileSignerFromEnv, type R2EventMessage, type Shard } from "../src/index.ts";
import { api, shardStub, sleep } from "./helpers.ts";
import worker, { probes } from "./worker.ts";

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha = async (data: Uint8Array) => hex(await crypto.subtle.digest("SHA-256", data));

async function mutate(shard: string, fn: string, args: unknown) {
  const r = await api("mutation", { fn, args, shard });
  if (!r.body.ok) throw Object.assign(new Error(r.body.error.message), { code: r.body.error.code });
  return r.body.value;
}
async function query(shard: string, fn: string, args: unknown) {
  const r = await api("query", { fn, args, shard });
  if (!r.body.ok) throw Object.assign(new Error(r.body.error.message), { code: r.body.error.code });
  return r.body.value;
}
const post = (path: string, body: unknown) => SELF.fetch(`http://ember${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const abs = (u: string) => (u.startsWith("http") ? u : `http://ember${u}`);

async function uploadSingle(shard: string, data: Uint8Array, opts: { sha?: boolean; contentType?: string } = {}) {
  const ticket = (await mutate(shard, "files:generate", {
    contentType: opts.contentType ?? "text/plain",
    size: data.length,
    ...(opts.sha === false ? {} : { sha256: await sha(data) }),
  })) as UploadTicket;
  const put = await SELF.fetch(abs(ticket.url!), { method: "PUT", headers: ticket.headers ?? {}, body: data });
  return { ticket, put };
}
const confirm = (shard: string, t: UploadTicket) => post("/api/storage/confirm", { shard, storageId: t.storageId, token: t.token });

describe("files: single upload (proxy mode), confirm, download", () => {
  it("uploads to the content-addressed key, confirms, and serves it after the app's check", async () => {
    const shard = "org:files1";
    const data = enc.encode("hello ember files");
    const { ticket, put } = await uploadSingle(shard, data);
    expect(ticket.url).toMatch(/^\/api\/storage\/put\?/);
    expect(put.status).toBe(200);
    expect(put.headers.get("access-control-allow-origin")).toBe("*");

    // Not ready until confirmed.
    expect(await query(shard, "files:meta", { id: ticket.storageId })).toMatchObject({ state: "pending" });
    const c = await confirm(shard, ticket);
    expect(c.status).toBe(200);
    const file = ((await c.json()) as any).file;
    expect(file).toMatchObject({ storageId: ticket.storageId, state: "ready", size: data.length, sha256: await sha(data), contentType: "text/plain" });
    expect(await env.EMBER_FILES.head(fileKey(shard, await sha(data)))).not.toBeNull();
    // Confirm is idempotent.
    expect((await confirm(shard, ticket)).status).toBe(200);

    const id = await mutate(shard, "files:add", { title: "cat", file: ticket.storageId });
    const url = (await query(shard, "files:url", { id })) as string;
    expect(url).toMatch(/^\/api\/storage\/get\?/);
    const got = await SELF.fetch(abs(url));
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("text/plain");
    expect(await got.text()).toBe("hello ember files");
    const ranged = await SELF.fetch(abs(url), { headers: { range: "bytes=0-4" } });
    expect(ranged.status).toBe(206);
    expect(await ranged.text()).toBe("hello");

    // Tampered or expired signatures are refused.
    expect((await SELF.fetch(abs(url.replace(/sig=[0-9a-f]{4}/, "sig=0000")))).status).toBe(403);
    const u = new URL(abs(url));
    u.searchParams.set("k", fileKey(shard, "0".repeat(64)));
    expect((await SELF.fetch(u)).status).toBe(403);

    // The permission check is the app's query.
    const secret = await mutate(shard, "files:add", { title: "secret cat", file: ticket.storageId });
    expect(await query(shard, "files:url", { id: secret })).toBeNull();

    // Same content again: the ticket says it already exists.
    const again = (await mutate(shard, "files:generate", { sha256: await sha(data), size: data.length })) as UploadTicket;
    expect(again).toMatchObject({ storageId: ticket.storageId, exists: true });
  });

  it("rejects wrong tokens, wrong sizes, wrong content, and confirm before upload", async () => {
    const shard = "org:files2";
    const data = enc.encode("0123456789");
    const t = (await mutate(shard, "files:generate", { size: 10, sha256: await sha(data) })) as UploadTicket;
    expect((await confirm(shard, t)).status).toBe(409); // not uploaded yet
    const bad = abs(t.url!).replace(/token=[0-9a-f]+/, "token=" + "0".repeat(48));
    expect((await SELF.fetch(bad, { method: "PUT", body: data })).status).toBe(404);
    expect((await SELF.fetch(abs(t.url!), { method: "PUT", body: enc.encode("short") })).status).toBe(400);
    const wrong = await SELF.fetch(abs(t.url!), { method: "PUT", body: enc.encode("9876543210") }); // R2 checks the sha256
    expect(wrong.status).toBe(400);
    expect(((await wrong.json()) as any).error.code).toBe("upload_rejected");
    expect((await post("/api/storage/confirm", { shard, storageId: t.storageId, token: "nope" })).status).toBe(404);
  });

  it("without sha256: uploads to t/, then confirm hashes, copies to f/<sha> and deletes the temp object", async () => {
    const shard = "org:files3";
    const data = enc.encode("no hash known up front");
    const { ticket, put } = await uploadSingle(shard, data, { sha: false });
    expect(put.status).toBe(200);
    const temp = tmpKey(shard, ticket.storageId);
    expect(await env.EMBER_FILES.head(temp)).not.toBeNull();
    const file = ((await (await confirm(shard, ticket)).json()) as any).file;
    expect(file.sha256).toBe(await sha(data));
    expect(await env.EMBER_FILES.head(temp)).toBeNull();
    const obj = await env.EMBER_FILES.get(fileKey(shard, file.sha256));
    expect(await obj!.text()).toBe("no hash known up front");
    expect(obj!.httpMetadata?.contentType).toBe("text/plain");
  });
});

describe("files: multipart (proxy mode)", () => {
  it("create → part URLs → parts → complete confirms the file", async () => {
    const shard = "org:files4";
    const part = 5 * 1024 * 1024;
    const data = new Uint8Array(part * 2 + 1234);
    for (let i = 0; i < data.length; i += 4096) data[i] = (i / 4096) & 0xff;
    const t = (await mutate(shard, "files:generate", { size: data.length, multipart: true, contentType: "application/octet-stream" })) as UploadTicket;
    expect(t.multipart).toBeTruthy();
    const base = { shard, storageId: t.storageId, token: t.token };
    const created = (await (await post("/api/storage/multipart", { ...base, op: "create" })).json()) as any;
    expect(created.ok).toBe(true);
    const uploadId = created.uploadId as string;
    const urls = (await (await post("/api/storage/multipart", { ...base, op: "parts", uploadId, partNumbers: [1, 2, 3] })).json()) as any;
    const parts: Array<{ partNumber: number; etag: string }> = [];
    for (const { partNumber, url } of urls.parts) {
      const chunk = data.slice((partNumber - 1) * part, partNumber * part);
      const r = await SELF.fetch(abs(url), { method: "PUT", body: chunk });
      expect(r.status).toBe(200);
      parts.push({ partNumber, etag: r.headers.get("etag")! });
    }
    const done = (await (await post("/api/storage/multipart", { ...base, op: "complete", uploadId, parts })).json()) as any;
    if (!done.ok) console.error("multipart complete failed:", JSON.stringify(done));
    expect(done).toMatchObject({ ok: true, file: { state: "ready", size: data.length, sha256: await sha(data) } });
    const stored = await env.EMBER_FILES.get(fileKey(shard, done.file.sha256));
    expect(stored!.size).toBe(data.length);
    expect(await env.EMBER_FILES.head(tmpKey(shard, t.storageId))).toBeNull();
  });
});

describe("files: R2 event notifications (queue)", () => {
  it("an object-create event confirms the pending upload (presigned uploads never touch the Worker)", async () => {
    const shard = "org:files5";
    const data = enc.encode("uploaded straight to R2");
    const t = (await mutate(shard, "files:generate", { contentType: "text/plain" })) as UploadTicket;
    // What a presigned PUT does: the object appears in the bucket without going through the Worker.
    await env.EMBER_FILES.put(tmpKey(shard, t.storageId), data, { httpMetadata: { contentType: "text/plain" } });
    const acked: string[] = [];
    const retried: string[] = [];
    const msg = (body: R2EventMessage, id: string) => ({ id, timestamp: new Date(), attempts: 1, body, ack: () => acked.push(id), retry: () => retried.push(id) });
    const batch = {
      queue: "ember-test-files",
      messages: [
        msg({ account: "a", bucket: "b", action: "PutObject", object: { key: tmpKey(shard, t.storageId), size: data.length, eTag: "x" } }, "1"),
        msg({ account: "a", bucket: "b", action: "DeleteObject", object: { key: tmpKey(shard, t.storageId) } }, "2"),
        msg({ account: "a", bucket: "b", action: "PutObject", object: { key: "foreign/key" } }, "3"),
      ],
      ackAll() {},
      retryAll() {},
    };
    const ctx = createExecutionContext();
    await worker.queue(batch as never, env as never, ctx);
    await waitOnExecutionContext(ctx);
    expect(acked.sort()).toEqual(["1", "2", "3"]);
    expect(retried).toEqual([]);
    expect(await query(shard, "files:meta", { id: t.storageId })).toMatchObject({ state: "ready", sha256: await sha(data), size: data.length });
    // The explicit confirm after the event is a no-op.
    expect((await confirm(shard, t)).status).toBe(200);
  });
});

describe("files: refcount + GC", () => {
  it("deletes unreferenced files after the grace period (alarm), keeps referenced ones", async () => {
    const shard = "org:files6";
    const a = await uploadSingle(shard, enc.encode("keep me"));
    const b = await uploadSingle(shard, enc.encode("drop me"));
    for (const x of [a, b]) expect((await confirm(shard, x.ticket)).status).toBe(200);
    const keepId = await mutate(shard, "files:add", { title: "keep", file: a.ticket.storageId });
    const dropId = await mutate(shard, "files:add", { title: "drop", file: b.ticket.storageId });
    // Explicit delete of a referenced file is refused.
    await expect(mutate(shard, "files:deleteFile", { id: b.ticket.storageId })).rejects.toMatchObject({ code: "FileInUse" });
    await mutate(shard, "files:remove", { id: dropId });
    // A never-referenced pending upload is collected too.
    const orphan = (await mutate(shard, "files:generate", { contentType: "text/plain" })) as UploadTicket;

    const stub = shardStub(shard);
    await runDurableObjectAlarm(stub); // before the grace period: nothing collected
    expect(await query(shard, "files:meta", { id: b.ticket.storageId })).toMatchObject({ state: "ready" });
    await sleep(350);
    const alarm = await runInDurableObject(stub, (_i: Shard, state) => state.storage.getAlarm());
    expect(alarm).not.toBeNull();
    await runDurableObjectAlarm(stub);
    expect(await query(shard, "files:meta", { id: b.ticket.storageId })).toBeNull();
    expect(await query(shard, "files:meta", { id: orphan.storageId })).toBeNull();
    expect(await env.EMBER_FILES.head(fileKey(shard, await sha(enc.encode("drop me"))))).toBeNull();
    expect(await env.EMBER_FILES.head(fileKey(shard, await sha(enc.encode("keep me"))))).not.toBeNull();
    expect(await query(shard, "files:url", { id: keepId })).toBeTruthy();
    const inspect = await stub.inspect();
    expect(inspect.files).toMatchObject({ total: 1, ready: 1, deleting: 0 });
    expect(inspect.stats.filesCollected).toBe(2);
  });

  it("a doc referencing a collected file is refused", async () => {
    const shard = "org:files7";
    const a = await uploadSingle(shard, enc.encode("short lived"));
    await confirm(shard, a.ticket);
    await mutate(shard, "files:deleteFile", { id: a.ticket.storageId });
    await runDurableObjectAlarm(shardStub(shard));
    await expect(mutate(shard, "files:add", { title: "late", file: a.ticket.storageId })).rejects.toMatchObject({ code: "FileNotFound" });
  });
});

describe("files: actions", () => {
  it("ctx.storage.store/get/getUrl and ctx.images.thumbnail (mock Images binding)", async () => {
    const shard = "org:files8";
    const res = await SELF.fetch("http://ember/api/action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fn: "files:storeAndThumb", args: { text: "PNGDATA" }, shard }),
    });
    const out = ((await res.json()) as any).value;
    expect(out.id).toBe(out.again); // deduplicated by content
    expect(out.body).toBe("PNGDATA");
    expect(out.info).toMatchObject({ width: 10, height: 20, format: "image/png" });
    expect(out.thumbMeta).toMatchObject({ state: "ready", contentType: "image/webp", size: enc.encode("thumb:64:image/webp:PNGDATA").length });
    expect(out.url).toMatch(/^\/api\/storage\/get\?/);
    expect(probes.images.at(-1)).toMatchObject({ transform: { width: 64 }, format: "image/webp", inputBytes: 7 });
    expect(await (await SELF.fetch(abs(out.url))).text()).toBe("PNGDATA");
  });
});

describe("files: signer selection", () => {
  it("S3 credentials switch to presigned R2 URLs; EMBER_FILES_MODE=proxy forces the Worker", () => {
    const base = { SHARD: env.SHARD, EMBER_FILES: env.EMBER_FILES };
    expect(fileSignerFromEnv({ ...base } as never)!.mode).toBe("proxy");
    const s3env = { ...base, EMBER_R2_ACCESS_KEY_ID: "AK", EMBER_R2_SECRET_ACCESS_KEY: "SK", EMBER_R2_ACCOUNT_ID: "acct", EMBER_R2_BUCKET: "ember-x-prod" };
    const s = fileSignerFromEnv(s3env as never)!;
    expect(s.mode).toBe("s3");
    const put = s.putUrl("f/x/y", { storageId: "s", token: "t", shard: "a:b", now: 1_700_000_000_000, expiresIn: 60, contentType: "text/plain" });
    expect(new URL(put.url).host).toBe("acct.r2.cloudflarestorage.com");
    expect(put.url).toBe(s3Signer({ accountId: "acct", bucket: "ember-x-prod", credentials: { accessKeyId: "AK", secretAccessKey: "SK" } }).putUrl("f/x/y", { storageId: "s", token: "t", shard: "a:b", now: 1_700_000_000_000, expiresIn: 60, contentType: "text/plain" }).url);
    expect(fileSignerFromEnv({ ...s3env, EMBER_FILES_MODE: "proxy" } as never)!.mode).toBe("proxy");
    expect(fileSignerFromEnv({ SHARD: env.SHARD } as never)).toBeNull();
  });
});
