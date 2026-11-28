// Files (PLAN §7) end to end in workerd with a Miniflare R2 bucket: proxy-mode uploads (single and multipart),
// confirmation by endpoint and by R2 event (queue), presigned/proxy downloads after the app's permission check,
// refcounts and alarm GC, action helpers (store/get/thumbnail with a mock Images binding).
import { createExecutionContext, env, evictDurableObject, runDurableObjectAlarm, runInDurableObject, SELF, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_PART_SIZE, fileKey, s3Signer, tmpKey, type UploadTicket } from "@freecorps/ember-server";
import { setEmberConfig } from "../src/config.ts";
import { actionStorage, confirmUpload, type FileRpc, deleteOrphans, handleStorageRequest } from "../src/files.ts";
import { fileSignerFromEnv, type R2EventMessage, type Shard } from "../src/index.ts";
import { schemaRefused } from "./app.ts";
import { api, shardStub, sleep } from "./helpers.ts";
import worker, { config, probes } from "./worker.ts";

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

describe("files: multipart create with the first part URLs", () => {
  const part = DEFAULT_PART_SIZE;
  async function ticket(shard: string, size: number) {
    const t = (await mutate(shard, "files:generate", { size, multipart: true, contentType: "application/octet-stream" })) as UploadTicket;
    return { t, base: { shard, storageId: t.storageId, token: t.token } };
  }
  const multipart = async (body: unknown) => {
    const r = await post("/api/storage/multipart", body);
    return { status: r.status, body: (await r.json()) as any };
  };

  it("answers partUrls for the part numbers asked (signed like `parts`), and they upload the file", async () => {
    const shard = "org:mpurls1";
    const data = new Uint8Array(part * 2 + 99);
    for (let i = 0; i < data.length; i += 4096) data[i] = (i / 4096) & 0xff;
    const { base } = await ticket(shard, data.length);
    // The client guessed 5 parts; the plan has 3: only those are signed.
    const created = await multipart({ ...base, op: "create", partNumbers: [1, 2, 3, 4, 5] });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ ok: true, partSize: part, parts: 3 });
    const { uploadId, partUrls } = created.body as { uploadId: string; partUrls: Array<{ partNumber: number; url: string }> };
    expect(partUrls.map((p) => p.partNumber)).toEqual([1, 2, 3]);
    const viaParts = await multipart({ ...base, op: "parts", uploadId, partNumbers: [1, 2, 3] });
    expect(partUrls).toEqual(viaParts.body.parts);
    const parts: Array<{ partNumber: number; etag: string }> = [];
    for (const { partNumber, url } of partUrls) {
      const r = await SELF.fetch(abs(url), { method: "PUT", body: data.slice((partNumber - 1) * part, partNumber * part) });
      expect(r.status).toBe(200);
      parts.push({ partNumber, etag: r.headers.get("etag")! });
    }
    const done = await multipart({ ...base, op: "complete", uploadId, parts });
    expect(done.body).toMatchObject({ ok: true, file: { state: "ready", size: data.length, sha256: await sha(data) } });
  });

  it("without the request (old clients), or with an empty list, the answer is the old one", async () => {
    const shard = "org:mpurls2";
    for (const extra of [{}, { partNumbers: [] }, { partNumbers: null }]) {
      const { base } = await ticket(shard, part + 1);
      const created = await multipart({ ...base, op: "create", ...extra });
      expect(created.status).toBe(200);
      expect(Object.keys(created.body).sort()).toEqual(["ok", "partSize", "parts", "uploadId"]);
    }
  });

  it("enforces the limits of `parts` before creating the upload, and refuses a wrong token or a finished upload", async () => {
    const shard = "org:mpurls3";
    const { base } = await ticket(shard, part + 1);
    const tooMany = Array.from({ length: 1001 }, (_, i) => i + 1);
    for (const partNumbers of [tooMany, [0], [10_001], [1.5], ["1"], "1", { 1: 1 }]) {
      const r = await multipart({ ...base, op: "create", partNumbers });
      expect(r.status).toBe(400);
      expect(r.body).toMatchObject({ ok: false, error: { code: "bad_request" } });
      expect(r.body.partUrls).toBeUndefined();
    }
    // Only numbers past the plan: nothing to sign, the old answer (no `partUrls`).
    const past = await multipart({ ...base, op: "create", partNumbers: [5, 6] });
    expect(past.status).toBe(200);
    expect(past.body.partUrls).toBeUndefined();
    // 1000 is the most `parts` signs: accepted (and cut to the plan).
    const max = await multipart({ ...base, op: "create", partNumbers: tooMany.slice(0, 1000) });
    expect(max.body.partUrls.map((p: { partNumber: number }) => p.partNumber)).toEqual([1, 2]);
    const wrong = await multipart({ ...base, token: "nope", op: "create", partNumbers: [1] });
    expect(wrong.status).toBe(404);
    expect(wrong.body.partUrls).toBeUndefined();
    const other = await ticket(shard, part + 1);
    const cross = await multipart({ ...base, storageId: other.t.storageId, op: "create", partNumbers: [1] });
    expect(cross.status).toBe(404);
    const single = (await mutate(shard, "files:generate", { size: 3, contentType: "text/plain" })) as UploadTicket;
    const notMultipart = await multipart({ shard, storageId: single.storageId, token: single.token, op: "create", partNumbers: [1] });
    expect(notMultipart.status).toBe(400);
    await multipart({ ...base, op: "abort", uploadId: max.body.uploadId });
    // An aborted upload has no target any more: refused, as unknown (its ticket already gone, 404) or as no longer
    // pending (409), depending on how far the abort's cleanup got.
    const failed = await multipart({ ...base, op: "create", partNumbers: [1] });
    expect([404, 409]).toContain(failed.status);
    expect(failed.body.ok).toBe(false);
    expect(failed.body.partUrls).toBeUndefined();
  });

  it("S3 mode: partUrls are presigned R2 URLs, the same `parts` signs, with the same expiry", async () => {
    const shard = "org:mpurls4";
    const { base } = await ticket(shard, part * 2);
    const creds = { EMBER_R2_ACCESS_KEY_ID: "AK", EMBER_R2_SECRET_ACCESS_KEY: "SK", EMBER_R2_ACCOUNT_ID: "acct", EMBER_R2_BUCKET: "ember-x-prod" };
    const deps = {
      env: { SHARD: env.SHARD, EMBER_FILES: env.EMBER_FILES, ...creds } as never,
      rpc: (s: string) => shardStub(s) as unknown as FileRpc,
      checkShard: (s: unknown) => (typeof s === "string" ? s : null),
    };
    const s3Calls: string[] = [];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      s3Calls.push(`${init?.method} ${String(input)}`);
      return new Response("<InitiateMultipartUploadResult><UploadId>U-1</UploadId></InitiateMultipartUploadResult>");
    });
    try {
      const call = async (body: unknown) => {
        const url = new URL("http://ember/api/storage/multipart");
        const r = (await handleStorageRequest(new Request(url, { method: "POST", body: JSON.stringify(body) }), url, deps))!;
        return (await r.json()) as any;
      };
      const created = await call({ ...base, op: "create", partNumbers: [1, 2] });
      expect(created).toMatchObject({ ok: true, uploadId: "U-1", parts: 2 });
      expect(s3Calls).toHaveLength(1);
      expect(s3Calls[0]).toMatch(/^POST https:\/\/acct\.r2\.cloudflarestorage\.com\/ember-x-prod\/.+\?uploads$/);
      const signer = s3Signer({ accountId: "acct", bucket: "ember-x-prod", credentials: { accessKeyId: "AK", secretAccessKey: "SK" } });
      for (const { partNumber, url } of created.partUrls as Array<{ partNumber: number; url: string }>) {
        const u = new URL(url);
        expect(u.host).toBe("acct.r2.cloudflarestorage.com");
        expect(u.searchParams.get("partNumber")).toBe(String(partNumber));
        expect(u.searchParams.get("uploadId")).toBe("U-1");
        expect(u.searchParams.get("X-Amz-Expires")).toBe("3600");
        // Re-sign at the URL's own time: the signature is the one `parts` (the same signer) gives.
        const d = u.searchParams.get("X-Amz-Date")!;
        const now = Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), +d.slice(9, 11), +d.slice(11, 13), +d.slice(13, 15));
        expect(url).toBe(signer.partUrl(tmpKey(shard, base.storageId), { uploadId: "U-1", partNumber, ...base, now, expiresIn: 3600 }));
      }
    } finally {
      fetchSpy.mockRestore();
    }
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
    // Taken before the remove: never later than the moment the shard marks the file unreferenced.
    const unreferencedBy = Date.now();
    await mutate(shard, "files:remove", { id: dropId });
    // A never-referenced pending upload is kept while its ticket is still usable (URL TTL > grace period).
    const orphan = (await mutate(shard, "files:generate", { contentType: "text/plain" })) as UploadTicket;

    const stub = shardStub(shard);
    await runDurableObjectAlarm(stub);
    // Before the grace period (gcGraceMs 300) nothing is collected. On a slow runner the grace may already be over by
    // the time this alarm ran: the file is then rightly gone, so only check while the grace is known not to be over.
    // Read first, then the clock: under 300 ms after the read means it was still inside the grace when read.
    const early = await query(shard, "files:meta", { id: b.ticket.storageId });
    if (Date.now() - unreferencedBy < 300) expect(early).toMatchObject({ state: "ready" });
    await sleep(350);
    const alarm = await runInDurableObject(stub, (_i: Shard, state) => state.storage.getAlarm());
    expect(alarm).not.toBeNull();
    await runDurableObjectAlarm(stub);
    expect(await query(shard, "files:meta", { id: b.ticket.storageId })).toBeNull();
    expect(await query(shard, "files:meta", { id: orphan.storageId })).toMatchObject({ state: "pending" });
    expect(await env.EMBER_FILES.head(fileKey(shard, await sha(enc.encode("drop me"))))).toBeNull();
    expect(await env.EMBER_FILES.head(fileKey(shard, await sha(enc.encode("keep me"))))).not.toBeNull();
    expect(await query(shard, "files:url", { id: keepId })).toBeTruthy();
    const inspect = await stub.inspect();
    expect(inspect.files).toMatchObject({ total: 2, ready: 1, deleting: 0 });
    expect(inspect.stats.filesCollected).toBe(1);
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

describe("files: objects no row references (orphan sweep)", () => {
  const adminPost = async (path: string, body: unknown) => {
    const res = await SELF.fetch(`http://ember/api/_ember/${path}`, { method: "POST", headers: { authorization: "Bearer admin-secret", "content-type": "application/json" }, ...(typeof body === "string" ? { body } : { body: JSON.stringify(body) }) });
    return { status: res.status, body: (await res.json()) as any };
  };
  /** Every page of `POST /api/_ember/files/orphans`, `limit` objects at a time. */
  const sweep = async (o: { graceMs?: number; delete?: boolean; limit?: number }) => {
    const pages: any[] = [];
    let cursor: string | null = null;
    do {
      const r = await adminPost("files/orphans", { ...o, ...(cursor ? { cursor } : {}) });
      expect(r.status).toBe(200);
      pages.push(r.body.value);
      cursor = r.body.value.cursor;
      expect(r.body.value.scanned).toBeLessThanOrEqual(o.limit ?? 500);
    } while (cursor);
    return { pages, orphans: pages.flatMap((p) => p.orphans.map((x: { key: string }) => x.key)) as string[], deleted: pages.reduce((n, p) => n + p.deleted, 0) as number };
  };
  const rpc = (shard: string) => shardStub(shard) as unknown as FileRpc;

  it("lists (dry run) and deletes only unreferenced Ember objects older than the grace period, page by page", async () => {
    const shard = "org:orphans";
    const bucket = env.EMBER_FILES;
    // Referenced: a ready file (row), and a pending upload's t/ object (row).
    const kept = await adminPost(`files/upload?shard=${shard}`, "kept bytes");
    expect(kept.status).toBe(200);
    // Referenced by a document: unreferenced, the shard's own GC (gcGraceMs 300 here) could take it on a slow runner.
    await mutate(shard, "files:add", { title: "kept", file: kept.body.value.id });
    const keptKey = fileKey(shard, await sha(enc.encode("kept bytes")));
    const pending = (await mutate(shard, "files:generate", { contentType: "text/plain" })) as UploadTicket;
    await SELF.fetch(abs(pending.url!), { method: "PUT", headers: pending.headers ?? {}, body: "pending" });
    const pendingKey = tmpKey(shard, pending.storageId);
    expect(await bucket.head(pendingKey)).not.toBeNull();
    // Orphans: an f/ and a t/ object of this shard with no row.
    const orphanF = fileKey(shard, await sha(enc.encode("orphan bytes")));
    const orphanT = tmpKey(shard, "_storage_01ARZ3NDEKTSV4RRFFQ69G5FAV");
    await bucket.put(orphanF, "orphan bytes");
    await bucket.put(orphanT, "orphan temp");
    // Never touched: foreign keys, and keys under the Ember prefixes that Ember does not write.
    const foreign = ["other/thing", `f/${btoa(shard).replace(/=+$/, "")}/not-a-sha`, "t/!!/x"];
    for (const k of foreign) await bucket.put(k, "x");
    const mine = (keys: string[]) => keys.filter((k) => [keptKey, pendingKey, orphanF, orphanT, ...foreign].includes(k)).sort();

    // The default grace (24 h): everything here is too young.
    const young = await sweep({ limit: 2 });
    expect(mine(young.orphans)).toEqual([]);
    expect(young.pages.reduce((n, p) => n + p.young, 0)).toBeGreaterThanOrEqual(4);
    // Dry run, no grace, two objects per page: the two orphans, nothing deleted.
    const dry = await sweep({ graceMs: 0, limit: 2 });
    expect(dry.pages.length).toBeGreaterThan(2);
    expect(mine(dry.orphans)).toEqual([orphanF, orphanT].sort());
    expect(dry.pages.reduce((n, p) => n + p.foreign, 0)).toBeGreaterThanOrEqual(foreign.length);
    expect(await bucket.head(orphanF)).not.toBeNull();
    // Delete: the orphans go, the rest stays, no tombstone is left behind.
    const del = await sweep({ graceMs: 0, delete: true, limit: 2 });
    expect(mine(del.orphans)).toEqual([orphanF, orphanT].sort());
    for (const k of [orphanF, orphanT]) expect(await bucket.head(k)).toBeNull();
    for (const k of [keptKey, pendingKey, ...foreign]) expect(await bucket.head(k)).not.toBeNull();
    expect((await shardStub(shard).inspect()).files).toMatchObject({ deleting: 0 });
    expect(mine((await sweep({ graceMs: 0 })).orphans)).toEqual([]);

    // Bad requests.
    expect((await adminPost("files/orphans", { limit: 5000 })).status).toBe(400);
    expect((await adminPost("files/orphans", { graceMs: -1 })).status).toBe(400);
    expect((await adminPost("files/orphans", { delete: "yes" })).status).toBe(400);
  });

  it("deletes the orphans an admin picked, checking each key again: referenced, young, gone and foreign keys stay", async () => {
    const shard = "org:orphan-pick";
    const bucket = env.EMBER_FILES;
    const kept = await adminPost(`files/upload?shard=${shard}`, "picked but referenced");
    await mutate(shard, "files:add", { title: "kept", file: kept.body.value.id });
    const keptKey = fileKey(shard, await sha(enc.encode("picked but referenced")));
    const orphan = fileKey(shard, await sha(enc.encode("a real orphan")));
    await bucket.put(orphan, "a real orphan");
    const gone = fileKey(shard, await sha(enc.encode("never stored")));
    const keys = [keptKey, orphan, gone, "other/thing"];
    // The default grace (24 h): everything is too young, nothing is deleted.
    const young = await adminPost("files/orphans/delete", { keys });
    expect(young.status).toBe(200);
    expect(young.body.value.deleted).toEqual([]);
    expect(Object.fromEntries(young.body.value.refused.map((r: { key: string; reason: string }) => [r.key, r.reason]))).toEqual({ [keptKey]: "young", [orphan]: "young", [gone]: "gone", "other/thing": "foreign" });
    // No grace: the orphan goes; the key a `_files` row has is never deleted (whatever the listing said).
    const r = await adminPost("files/orphans/delete", { keys, graceMs: 0 });
    expect(r.body.value.deleted).toEqual([{ key: orphan, shard, size: "a real orphan".length }]);
    expect(r.body.value.refused).toContainEqual({ key: keptKey, reason: "referenced" });
    expect(await bucket.head(orphan)).toBeNull();
    expect(await bucket.head(keptKey)).not.toBeNull();
    expect((await shardStub(shard).inspect()).files).toMatchObject({ deleting: 0 });
    // Bad requests.
    expect((await adminPost("files/orphans/delete", { keys: [] })).status).toBe(400);
    expect((await adminPost("files/orphans/delete", { keys: Array.from({ length: 101 }, (_, i) => `k${i}`) })).status).toBe(400);
    expect((await adminPost("files/orphans/delete", { keys: [1] })).status).toBe(400);
    expect((await adminPost("files/orphans/delete", { keys, graceMs: -1 })).status).toBe(400);
  });

  it("lists `_files` rows stuck short of ready and queues only the unreferenced ones for the GC", async () => {
    const shard = "org:stuck";
    const adminGet = async (path: string) => {
      const res = await SELF.fetch(`http://ember/api/_ember/${path}`, { headers: { authorization: "Bearer admin-secret" } });
      return { status: res.status, body: (await res.json()) as any };
    };
    // An abandoned upload (pending, never PUT) and one a document references that then failed.
    const abandoned = (await mutate(shard, "files:generate", { contentType: "text/plain", size: 7 })) as UploadTicket;
    const used = (await mutate(shard, "files:generate", { contentType: "text/plain" })) as UploadTicket;
    await mutate(shard, "files:add", { title: "uses a pending file", file: used.storageId });
    await rpc(shard).fileFail(shard, used.storageId);
    const fresh = (await mutate(shard, "files:generate", { contentType: "text/plain" })) as UploadTicket;
    // Created two hours ago (past the pending hold: the ticket's TTL), the GC clock (`zero_since`) left alone.
    await runInDurableObject(shardStub(shard), (_i, state) => {
      state.storage.sql.exec(`UPDATE _files SET created_at = created_at - 7200000 WHERE id IN (?, ?)`, abandoned.storageId, used.storageId);
    });
    const page = await adminGet(`files/stuck?shard=${shard}&graceMs=0`);
    expect(page.status).toBe(200);
    const byId = Object.fromEntries(page.body.value.rows.map((r: { id: string }) => [r.id, r]));
    expect(byId[abandoned.storageId]).toMatchObject({ state: "pending", refcount: 0, size: 7 });
    expect(byId[used.storageId]).toMatchObject({ state: "failed", refcount: 1 });
    // A pending upload younger than its ticket's hold is not stuck, whatever the grace.
    expect(byId[fresh.storageId]).toBeUndefined();
    expect(page.body.value.totals).toEqual({ count: 2, bytes: 7, referenced: 1 });
    expect(page.body.value.rows[0]).not.toHaveProperty("token");
    // The default grace (24 h): none of them.
    expect((await adminGet(`files/stuck?shard=${shard}`)).body.value.rows).toEqual([]);
    // Pages by id.
    const first = await adminGet(`files/stuck?shard=${shard}&graceMs=0&limit=1`);
    expect(first.body.value).toMatchObject({ done: false });
    const second = await adminGet(`files/stuck?shard=${shard}&graceMs=0&limit=1&cursor=${first.body.value.cursor}`);
    expect(second.body.value).toMatchObject({ done: true });
    expect(second.body.value.totals).toBeUndefined();

    const del = await adminPost("files/stuck/delete", { shard, ids: [abandoned.storageId, used.storageId, fresh.storageId, "_storage_nope"], graceMs: 0 });
    expect(del.status).toBe(200);
    expect(del.body.value.queued).toEqual([abandoned.storageId]);
    expect(Object.fromEntries(del.body.value.refused.map((r: { id: string; reason: string }) => [r.id, r.reason]))).toEqual({ [used.storageId]: "referenced", [fresh.storageId]: "young", _storage_nope: "not_found" });
    await runDurableObjectAlarm(shardStub(shard));
    expect(await rpc(shard).fileMeta(shard, abandoned.storageId)).toBeNull();
    expect(await rpc(shard).fileMeta(shard, used.storageId)).toMatchObject({ state: "failed", refcount: 1 });
    // Bad requests.
    expect((await adminGet("files/stuck?shard=bad")).status).toBe(400);
    expect((await adminGet(`files/stuck?shard=${shard}&limit=0`)).status).toBe(400);
    expect((await adminPost("files/stuck/delete", { shard, ids: [] })).status).toBe(400);
    expect((await adminPost("files/stuck", {})).status).toBe(405);
  });

  it("a claimed orphan (tombstone) refuses registering its key until the object is gone; a key with a row is never claimed", async () => {
    const shard = "org:orphan-claim";
    const bytes = enc.encode("claimed");
    const key = fileKey(shard, await sha(bytes));
    await env.EMBER_FILES.put(key, bytes);
    const info = { sha256: await sha(bytes), size: bytes.length, contentType: null, etag: null };
    // Another shard's key is not this shard's to judge.
    expect(await rpc(shard).fileOrphans(shard, [key, fileKey("org:else", await sha(bytes))], false)).toEqual({ ok: true, value: [{ key, id: null }] });
    const claim = await rpc(shard).fileOrphans(shard, [key], true);
    expect(claim.ok && claim.value[0]!.id).toBeTruthy();
    expect(await rpc(shard).fileRegister(shard, info)).toMatchObject({ ok: false, code: "StorageError" });
    // A second sweep does not claim it twice.
    expect(await rpc(shard).fileOrphans(shard, [key], true)).toEqual({ ok: true, value: [] });
    await env.EMBER_FILES.delete(key);
    expect(await rpc(shard).fileOrphansDone(shard, [claim.ok ? claim.value[0]!.id! : ""])).toEqual({ ok: true, value: null });
    const reg = await rpc(shard).fileRegister(shard, info);
    expect(reg.ok).toBe(true);
    expect(await rpc(shard).fileOrphans(shard, [key], true)).toEqual({ ok: true, value: [] });
  });

  it("a tombstone left behind (the sweep died after claiming) is finished by the shard's GC turn", async () => {
    const shard = "org:orphan-stale";
    const key = fileKey(shard, await sha(enc.encode("stale")));
    await env.EMBER_FILES.put(key, "stale");
    const claim = await rpc(shard).fileOrphans(shard, [key], true);
    expect(claim.ok).toBe(true);
    // Once the claim ran out (ORPHAN_CLAIM_MS) and a minute more (GC_RETRY_MS), the stale `deleting` row is retried: the
    // object and the row go.
    await runInDurableObject(shardStub(shard), (_i, state) => state.storage.sql.exec(`UPDATE _files SET updated_at = updated_at - 420000 WHERE key = ?`, key));
    await runDurableObjectAlarm(shardStub(shard));
    expect(await env.EMBER_FILES.head(key)).toBeNull();
    expect((await shardStub(shard).inspect()).files).toMatchObject({ total: 0 });
  });

  it("a store the shard refuses removes the object it wrote (a refused migration)", async () => {
    const shard = "mig:orphan-store";
    const stub = shardStub(shard);
    await mutate(shard, "messages:send", { channel: "o", body: "row" });
    const bytes = enc.encode(`refused store ${crypto.randomUUID()}`);
    const key = fileKey(shard, await sha(bytes));
    try {
      setEmberConfig({ ...config, schema: schemaRefused });
      await evictDurableObject(stub);
      const up = await adminPost(`files/upload?shard=${shard}`, new TextDecoder().decode(bytes));
      // (The status of this refusal through the admin endpoint is another matter: what counts here is the object.)
      expect(up.status).not.toBe(200);
      expect(up.body.error.code).toBe("MigrationRefused");
      expect(await env.EMBER_FILES.head(key)).toBeNull();
    } finally {
      setEmberConfig(config);
      await evictDurableObject(stub);
    }
  });

  it("an object deleted between the upload's HEAD and its row (GC or sweep) is written again once the row exists", async () => {
    const shard = "org:orphan-race";
    const real = env.EMBER_FILES;
    // The first HEAD of `racy` sees the object, which is then deleted: what a sweep (or GC turn) finishing in that gap does.
    const racing = (racy: string) => {
      let armed = true;
      return new Proxy(real, {
        get(t, p) {
          if (p === "head")
            return async (key: string) => {
              const h = await t.head(key);
              if (armed && key === racy && h) {
                armed = false;
                await t.delete(key);
              }
              return h;
            };
          const v = Reflect.get(t, p);
          return typeof v === "function" ? v.bind(t) : v;
        },
      }) as R2Bucket;
    };
    // ctx.storage.store: the content is already there (an orphan), so the upload would skip the PUT.
    const bytes = enc.encode("stored while swept");
    const key = fileKey(shard, await sha(bytes));
    await real.put(key, bytes);
    const storage = actionStorage({ ...env, EMBER_FILES: racing(key) } as never, shard, () => rpc(shard));
    const id = await storage.store(bytes);
    expect((await rpc(shard).fileMeta(shard, id))?.state).toBe("ready");
    expect(await (await real.get(key))?.text()).toBe("stored while swept");
    // An upload without sha256 (t/): confirm finds f/<sha> already there and would skip the copy.
    const data = enc.encode("confirmed while swept");
    const final = fileKey(shard, await sha(data));
    await real.put(final, data);
    const { ticket } = await uploadSingle(shard, data, { sha: false });
    const r = await confirmUpload(racing(final), rpc(shard), shard, ticket.storageId, ticket.token);
    expect(r.ok).toBe(true);
    expect(await (await real.get(final))?.text()).toBe("confirmed while swept");
    expect(await real.head(tmpKey(shard, ticket.storageId))).toBeNull();
  });

  it("a claim that came back late deletes nothing: the tombstone is left for the shard's GC", async () => {
    const shard = "org:orphan-late";
    const key = fileKey(shard, await sha(enc.encode("claimed too slowly")));
    await env.EMBER_FILES.put(key, "claimed too slowly");
    // The shard answered, but four minutes passed between asking and the answer (the claim lasts five).
    let t = 1_000_000;
    const real = rpc(shard);
    const slow = {
      fileOrphans: async (s: string, keys: string[], claim: boolean) => {
        const r = await real.fileOrphans(s, keys, claim);
        t += 4 * 60_000;
        return r;
      },
      fileOrphansDone: (s: string, ids: string[]) => real.fileOrphansDone(s, ids),
    };
    await expect(deleteOrphans(env.EMBER_FILES, slow, shard, [key], () => t)).rejects.toMatchObject({ code: "OrphanClaimLate" });
    expect(await env.EMBER_FILES.head(key)).not.toBeNull();
    // The claim was still the sweep's by the shard's clock: it is released, so the content is not held and a later
    // sweep takes the object.
    expect((await shardStub(shard).inspect()).files).toMatchObject({ deleting: 0 });
    expect(await deleteOrphans(env.EMBER_FILES, rpc(shard), shard, [key])).toEqual([key]);
    expect(await env.EMBER_FILES.head(key)).toBeNull();
  });

  it("a release that arrives after the claim ran out leaves the tombstone to the GC", async () => {
    const shard = "org:orphan-late-release";
    const key = fileKey(shard, await sha(enc.encode("released too late")));
    await env.EMBER_FILES.put(key, "released too late");
    const claim = await rpc(shard).fileOrphans(shard, [key], true);
    const ids = claim.ok ? claim.value.flatMap((o) => (o.id ? [o.id] : [])) : [];
    expect(ids).toHaveLength(1);
    // The claim ran out (a GC turn may hold the row now, mid-delete): the release drops nothing.
    await runInDurableObject(shardStub(shard), (_i, state) => state.storage.sql.exec(`UPDATE _files SET updated_at = updated_at - 420000 WHERE key = ?`, key));
    expect((await rpc(shard).fileOrphansDone(shard, ids)).ok).toBe(true);
    expect((await shardStub(shard).inspect()).files).toMatchObject({ deleting: 1 });
    await runDurableObjectAlarm(shardStub(shard));
    expect(await env.EMBER_FILES.head(key)).toBeNull();
    expect((await shardStub(shard).inspect()).files).toMatchObject({ total: 0 });
  });

  it("a release that throws after the delete still reports what was deleted", async () => {
    const shard = "org:orphan-done-throws";
    const key = fileKey(shard, await sha(enc.encode("deleted, release threw")));
    await env.EMBER_FILES.put(key, "deleted, release threw");
    const real = rpc(shard);
    const flaky = {
      fileOrphans: (s: string, keys: string[], claim: boolean) => real.fileOrphans(s, keys, claim),
      fileOrphansDone: async (): Promise<never> => {
        throw new Error("shard unreachable");
      },
    };
    expect(await deleteOrphans(env.EMBER_FILES, flaky, shard, [key])).toEqual([key]);
    expect(await env.EMBER_FILES.head(key)).toBeNull();
  });

  it("import/files names the objects that are gone instead of leaving ready rows without bytes", async () => {
    const shard = "org:orphan-import";
    const here = enc.encode("imported, still there");
    const gone = enc.encode("imported, swept before its row");
    const [shaHere, shaGone] = [await sha(here), await sha(gone)];
    expect((await adminPost("import/begin", { shard, tables: [] })).status).toBe(200);
    // What `import/blob` leaves: the object in the bucket. The second one was already there (an old orphan), so the
    // blob call wrote nothing, and a sweep deleted it before the rows arrived.
    await env.EMBER_FILES.put(fileKey(shard, shaHere), here);
    const rows = [
      { id: "kg2imported0000000000000000000001", sha256: shaHere, size: here.byteLength, contentType: null, createdAt: 1 },
      { id: "kg2imported0000000000000000000002", sha256: shaGone, size: gone.byteLength, contentType: null, createdAt: 1 },
    ];
    const first = await adminPost("import/files", { shard, rows });
    expect(first).toMatchObject({ status: 409, body: { ok: false, error: { code: "ImportBlobMissing", data: { sha256: [shaGone] } } } });
    // Nothing was written for a batch with a missing object.
    expect((await shardStub(shard).inspect()).files).toMatchObject({ total: 0 });
    // The blob goes up again and the same call passes; from then on the rows keep the objects from a sweep.
    await env.EMBER_FILES.put(fileKey(shard, shaGone), gone);
    expect(await adminPost("import/files", { shard, rows })).toMatchObject({ status: 200, body: { ok: true, value: { written: 2 } } });
    expect((await sweep({ graceMs: 0, delete: true })).orphans).not.toContain(fileKey(shard, shaGone));
    expect(await env.EMBER_FILES.head(fileKey(shard, shaGone))).not.toBeNull();
  });

  it("import/files writes no row for an object a sweep has claimed and not yet deleted", async () => {
    const shard = "org:orphan-import-claimed";
    const bytes = enc.encode("claimed by the sweep, imported meanwhile");
    const digest = await sha(bytes);
    const key = fileKey(shard, digest);
    expect((await adminPost("import/begin", { shard, tables: [] })).status).toBe(200);
    await env.EMBER_FILES.put(key, bytes);
    // The sweep is between its claim and its delete: the object is still there, so a HEAD alone would pass.
    const claim = await rpc(shard).fileOrphans(shard, [key], true);
    expect(claim.ok && claim.value).toMatchObject([{ key, id: expect.any(String) }]);
    const rows = [{ id: "kg2imported0000000000000000000003", sha256: digest, size: bytes.byteLength, contentType: null, createdAt: 1 }];
    expect(await adminPost("import/files", { shard, rows })).toMatchObject({ status: 503, body: { ok: false, error: { code: "StorageError" } } });
    expect((await shardStub(shard).inspect()).files).toMatchObject({ ready: 0, deleting: 1 });
    // The sweep finishes (object deleted, tombstone released): the rows go in, and the missing object is named.
    await env.EMBER_FILES.delete(key);
    await rpc(shard).fileOrphansDone(shard, claim.ok ? claim.value.flatMap((o) => (o.id ? [o.id] : [])) : []);
    expect(await adminPost("import/files", { shard, rows })).toMatchObject({ status: 409, body: { error: { code: "ImportBlobMissing", data: { sha256: [digest] } } } });
    await env.EMBER_FILES.put(key, bytes);
    expect((await adminPost("import/files", { shard, rows })).status).toBe(200);
  });

  it("a confirmation whose repair failed after the row was ready is finished by the next confirmation", async () => {
    const shard = "org:orphan-retry";
    const real = env.EMBER_FILES;
    const data = enc.encode("repaired on retry");
    const final = fileKey(shard, await sha(data));
    await real.put(final, data);
    const { ticket } = await uploadSingle(shard, data, { sha: false });
    const tmp = tmpKey(shard, ticket.storageId);
    // As in the race above (the final object goes after its first HEAD), and the PUT that would write it again fails.
    let armed = true;
    const failing = new Proxy(real, {
      get(t, p) {
        if (p === "head")
          return async (key: string) => {
            const h = await t.head(key);
            if (armed && key === final && h) {
              armed = false;
              await t.delete(key);
            }
            return h;
          };
        if (p === "put")
          return async (key: string, ...rest: unknown[]) => {
            if (key === final) throw new Error("R2 is having a moment");
            return (t.put as (...a: unknown[]) => unknown)(key, ...rest);
          };
        const v = Reflect.get(t, p);
        return typeof v === "function" ? v.bind(t) : v;
      },
    }) as R2Bucket;
    await expect(confirmUpload(failing, rpc(shard), shard, ticket.storageId, ticket.token)).rejects.toThrow(/having a moment/);
    // The row is ready, its object is not there, and the upload is still in t/.
    expect((await rpc(shard).fileMeta(shard, ticket.storageId))?.state).toBe("ready");
    expect(await real.head(final)).toBeNull();
    expect(await real.head(tmp)).not.toBeNull();
    // The retry does not stop at "already ready": it writes the object from the upload, then drops the upload.
    expect((await confirmUpload(real, rpc(shard), shard, ticket.storageId, ticket.token)).ok).toBe(true);
    expect(await (await real.get(final))?.text()).toBe("repaired on retry");
    expect(await real.head(tmp)).toBeNull();
  });
});
