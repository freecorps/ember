import { describe, expect, it } from "vitest";
import { uploadFile, type UploadTicket } from "../src/index.ts";
import { makeClient, messagesServer, SHARD } from "./helpers.ts";

type Call = { method: string; url: string; headers: Record<string, string>; body: unknown };

/** Records storage traffic; answers like the Worker (multipart part size 10 bytes for the test). */
function storageFetch(opts: { failPart?: number } = {}) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    let body: unknown = init?.body;
    if (typeof body === "string") body = JSON.parse(body);
    else if (body instanceof Uint8Array || body instanceof Blob) body = new Uint8Array(await new Response(body as BodyInit).arrayBuffer());
    calls.push({ method: init?.method ?? "GET", url, headers, body });
    const path = new URL(url).pathname;
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (path === "/api/storage/confirm") return json({ ok: true, file: { storageId: (body as any).storageId, state: "ready", size: 3, sha256: null, contentType: "text/plain" } });
    if (path === "/api/storage/multipart") {
      const b = body as any;
      if (b.op === "create") return json({ ok: true, uploadId: "up1", partSize: 10, parts: 3 });
      if (b.op === "parts") return json({ ok: true, parts: b.partNumbers.map((n: number) => ({ partNumber: n, url: `https://r2.test/part?n=${n}` })) });
      if (b.op === "complete") return json({ ok: true, file: { storageId: b.storageId, state: "ready", size: 25, sha256: "x", contentType: "application/octet-stream" } });
      if (b.op === "abort") return json({ ok: true });
    }
    if (url.startsWith("https://r2.test/part")) {
      const n = Number(new URL(url).searchParams.get("n"));
      if (n === opts.failPart) return new Response("<Error><Code>InternalError</Code><Message>boom</Message></Error>", { status: 500 });
      return new Response(null, { status: 200, headers: { etag: `"etag-${n}"` } });
    }
    if (url.startsWith("https://r2.test/put") || path === "/api/storage/put") return new Response(null, { status: 200, headers: { etag: '"e"' } });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function setup(ticket: (args: any) => Partial<UploadTicket>) {
  const seen: any[] = [];
  const server = messagesServer({
    mutations: {
      "storage:generateUploadUrl": (_db, args) => {
        seen.push(args);
        return { storageId: "_storage_01J9Z3AAAAAAAAAAAAAAAAAAAA", shard: SHARD, token: "tok", expiresAt: 0, ...ticket(args) };
      },
    },
  });
  return { client: makeClient(server), seen };
}

describe("client.files.upload", () => {
  it("single PUT with sha256 computed, signed headers sent, then confirm", async () => {
    const { client, seen } = setup(() => ({ url: "https://r2.test/put?sig=1", method: "PUT", headers: { "content-type": "text/plain", "x-amz-checksum-sha256": "abc=" } }));
    const s = storageFetch();
    const progress: number[] = [];
    const data = new Blob(["abc"], { type: "text/plain" });
    const out = await client.files.upload(data, { fetch: s.fetchImpl, onProgress: (p) => progress.push(p.loaded) });
    expect(seen[0]).toEqual({ contentType: "text/plain", size: 3, sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" });
    expect(s.calls[0]).toMatchObject({ method: "PUT", url: "https://r2.test/put?sig=1", headers: { "content-type": "text/plain", "x-amz-checksum-sha256": "abc=" } });
    expect(s.calls[1]).toMatchObject({ method: "POST", url: "https://ember.test/api/storage/confirm", body: { shard: SHARD, storageId: "_storage_01J9Z3AAAAAAAAAAAAAAAAAAAA", token: "tok" } });
    expect(out.state).toBe("ready");
    expect(progress).toEqual([3]);
    client.close();
  });

  it("relative (proxy-mode) URLs resolve against the deployment URL; uploadFile() is the same helper", async () => {
    const { client } = setup(() => ({ url: "/api/storage/put?shard=x", method: "PUT", headers: {} }));
    const s = storageFetch();
    await uploadFile(client, new Uint8Array([1, 2, 3]), { fetch: s.fetchImpl, sha256: false, mutation: "storage:generateUploadUrl" });
    expect(s.calls[0]!.url).toBe("https://ember.test/api/storage/put?shard=x");
    expect(client.files.url("/api/storage/get?k=1")).toBe("https://ember.test/api/storage/get?k=1");
    client.close();
  });

  it("existing content: nothing is uploaded", async () => {
    const { client } = setup(() => ({ exists: true }));
    const s = storageFetch();
    const out = await client.files.upload(new Uint8Array([1]), { fetch: s.fetchImpl });
    expect(s.calls).toEqual([]);
    expect(out).toMatchObject({ storageId: "_storage_01J9Z3AAAAAAAAAAAAAAAAAAAA", state: "ready" });
    client.close();
  });

  it("multipart above the threshold: create, part URLs, parallel parts, complete with sorted ETags", async () => {
    const { client, seen } = setup(() => ({ multipart: { partSize: 10 } }));
    const s = storageFetch();
    const data = new Uint8Array(25).map((_, i) => i);
    const progress: number[] = [];
    const out = await client.files.upload(data, { fetch: s.fetchImpl, multipartThreshold: 8, onProgress: (p) => progress.push(p.loaded) });
    expect(seen[0]).toMatchObject({ size: 25, multipart: true });
    expect(seen[0].sha256).toBeUndefined(); // multipart: the server hashes while confirming
    const parts = s.calls.filter((c) => c.url.startsWith("https://r2.test/part"));
    expect(parts.map((p) => (p.body as Uint8Array).length).sort()).toEqual([10, 10, 5]);
    const complete = s.calls.find((c) => (c.body as any)?.op === "complete")!;
    expect((complete.body as any).parts).toEqual([1, 2, 3].map((n) => ({ partNumber: n, etag: `"etag-${n}"` })));
    expect(out).toMatchObject({ state: "ready", size: 25 });
    expect(progress.at(-1)).toBe(25);
    client.close();
  });

  it("a failed part aborts the multipart upload and rejects with the S3 error", async () => {
    const { client } = setup(() => ({ multipart: { partSize: 10 } }));
    const s = storageFetch({ failPart: 2 });
    await expect(client.files.upload(new Uint8Array(25), { fetch: s.fetchImpl, multipartThreshold: 8, concurrency: 1 })).rejects.toMatchObject({ code: "InternalError" });
    expect(s.calls.some((c) => (c.body as any)?.op === "abort")).toBe(true);
    client.close();
  });

  it("rejects a mutation that does not return an upload ticket", async () => {
    const server = messagesServer({ mutations: { "storage:generateUploadUrl": () => ({ nope: true }) } });
    const client = makeClient(server);
    await expect(client.files.upload(new Uint8Array(1), { fetch: storageFetch().fetchImpl })).rejects.toMatchObject({ code: "bad_ticket" });
    client.close();
  });
});
