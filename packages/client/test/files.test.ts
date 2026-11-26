import { describe, expect, it, vi } from "vitest";
import { ClientFiles, EmberClient, uploadFile, type UploadTicket } from "../src/index.ts";
import { makeClient, messagesServer, SHARD } from "./helpers.ts";

type Call = { method: string; url: string; headers: Record<string, string>; body: unknown; raw: unknown };

/** Records storage traffic; answers like the Worker (multipart part size 10 bytes for the test). */
/** What a part's attempts get, in order (then 200): a status, a status with `Retry-After`, or a lost request. */
type PartAnswer = number | { status: number; retryAfter: string } | "network";

function storageFetch(opts: { failPart?: number; partUrls?: boolean; partSize?: number; parts?: Record<number, PartAnswer[]> } = {}) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const raw: unknown = init?.body;
    let body: unknown = init?.body;
    if (typeof body === "string") body = JSON.parse(body);
    else if (body instanceof Uint8Array || body instanceof Blob) body = new Uint8Array(await new Response(body as BodyInit).arrayBuffer());
    calls.push({ method: init?.method ?? "GET", url, headers, body, raw });
    const path = new URL(url).pathname;
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (path === "/api/storage/confirm") return json({ ok: true, file: { storageId: (body as any).storageId, state: "ready", size: 3, sha256: null, contentType: "text/plain" } });
    if (path === "/api/storage/multipart") {
      const b = body as any;
      if (b.op === "create")
        return json({
          ok: true,
          uploadId: "up1",
          partSize: opts.partSize ?? 10,
          parts: 3,
          // A runtime that presigns the first batch with the create call.
          ...(opts.partUrls ? { partUrls: (b.partNumbers as number[]).map((n) => ({ partNumber: n, url: `https://r2.test/part?n=${n}` })) } : {}),
        });
      if (b.op === "parts") return json({ ok: true, parts: b.partNumbers.map((n: number) => ({ partNumber: n, url: `https://r2.test/part?n=${n}` })) });
      if (b.op === "complete") return json({ ok: true, file: { storageId: b.storageId, state: "ready", size: 25, sha256: "x", contentType: "application/octet-stream" } });
      if (b.op === "abort") return json({ ok: true });
    }
    if (url.startsWith("https://r2.test/part")) {
      const n = Number(new URL(url).searchParams.get("n"));
      if (n === opts.failPart) return new Response("<Error><Code>InternalError</Code><Message>boom</Message></Error>", { status: 500 });
      const next = opts.parts?.[n]?.shift();
      if (next === "network") throw new TypeError("fetch failed");
      if (next !== undefined) {
        const { status, retryAfter } = typeof next === "number" ? { status: next, retryAfter: undefined } : next;
        return new Response("<Error><Code>SlowDown</Code><Message>try again</Message></Error>", { status, headers: retryAfter ? { "retry-after": retryAfter } : {} });
      }
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

  it("a part that keeps failing aborts the multipart upload after its attempts and rejects with the S3 error", async () => {
    const { client } = setup(() => ({ multipart: { partSize: 10 } }));
    const s = storageFetch({ failPart: 2 });
    await expect(client.files.upload(new Uint8Array(25), { fetch: s.fetchImpl, multipartThreshold: 8, concurrency: 1, retryDelayMs: 1 })).rejects.toMatchObject({ code: "InternalError" });
    expect(s.calls.filter((c) => c.url === "https://r2.test/part?n=2")).toHaveLength(3);
    expect(s.calls.some((c) => (c.body as any)?.op === "abort")).toBe(true);
    client.close();
  });

  it("a part answered 5xx, 429 or lost on the network is sent again (exponential backoff, Retry-After) before the upload gives up", async () => {
    const { client } = setup(() => ({ multipart: { partSize: 10 } }));
    const s = storageFetch({ parts: { 1: [503, "network"], 2: [{ status: 429, retryAfter: "2" }], 3: [500] } });
    // The waits the upload asks for, run at once: timers set by `wait` in files.ts itself (the innermost frame of the
    // package's source), never the client's own (backoff, idle, heartbeat), whatever called into them.
    const waits: number[] = [];
    const real = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      const frames = (new Error().stack ?? "").split("\n").slice(1);
      const caller = frames.find((l) => /\/packages\/client\/src\//.test(l));
      if (caller && /\/src\/files\.ts:/.test(caller) && frames.some((l) => /\bwait \(.*\/src\/files\.ts:/.test(l))) {
        waits.push(ms!);
        return real(fn, 0);
      }
      return real(fn, ms);
    }) as typeof setTimeout);
    try {
      const out = await client.files.upload(new Uint8Array(25), { fetch: s.fetchImpl, multipartThreshold: 8, concurrency: 1 });
      expect(out).toMatchObject({ state: "ready" });
    } finally {
      spy.mockRestore();
    }
    const attempts = (n: number) => s.calls.filter((c) => c.url === `https://r2.test/part?n=${n}`).length;
    expect([attempts(1), attempts(2), attempts(3)]).toEqual([3, 2, 2]);
    expect(s.calls.some((c) => (c.body as any)?.op === "abort")).toBe(false);
    // Part 1: 250–500 ms, then 500–1000 ms; part 2: its Retry-After (2 s); part 3: 250–500 ms.
    expect(waits).toHaveLength(4);
    expect(waits[0]).toBeGreaterThanOrEqual(250);
    expect(waits[0]).toBeLessThanOrEqual(500);
    expect(waits[1]).toBeGreaterThanOrEqual(500);
    expect(waits[1]).toBeLessThanOrEqual(1000);
    expect(waits[2]).toBe(2000);
    expect(waits[3]).toBeLessThanOrEqual(500);
    client.close();
  });

  it("a 4xx part is not sent again; the signal cancels a part waiting to be sent again", async () => {
    const { client } = setup(() => ({ multipart: { partSize: 10 } }));
    const s = storageFetch({ parts: { 1: [403] } });
    await expect(client.files.upload(new Uint8Array(25), { fetch: s.fetchImpl, multipartThreshold: 8, concurrency: 1 })).rejects.toMatchObject({ code: "SlowDown" });
    expect(s.calls.filter((c) => c.url === "https://r2.test/part?n=1")).toHaveLength(1);

    const t = storageFetch({ parts: { 1: [{ status: 503, retryAfter: "20" }] } });
    const ctl = new AbortController();
    const up = client.files.upload(new Uint8Array(25), { fetch: t.fetchImpl, multipartThreshold: 8, concurrency: 1, signal: ctl.signal });
    await vi.waitFor(() => expect(t.calls.filter((c) => c.url === "https://r2.test/part?n=1")).toHaveLength(1));
    const at = Date.now();
    ctl.abort();
    await expect(up).rejects.toMatchObject({ name: "AbortError" });
    expect(Date.now() - at).toBeLessThan(1000);
    expect(t.calls.filter((c) => c.url === "https://r2.test/part?n=1")).toHaveLength(1);
    client.close();
  });

  it("a part waiting to be sent again is not sent once another part failed for good (no progress after the rejection)", async () => {
    const { client } = setup(() => ({ multipart: { partSize: 10 } }));
    const s = storageFetch({ parts: { 1: [503], 2: [403] } });
    const progress: number[] = [];
    const up = client.files.upload(new Uint8Array(25), { fetch: s.fetchImpl, multipartThreshold: 8, concurrency: 2, retryDelayMs: 40, onProgress: (p) => progress.push(p.loaded) });
    await expect(up).rejects.toMatchObject({ code: "SlowDown" });
    expect(s.calls.some((c) => (c.body as any)?.op === "abort")).toBe(true);
    const seen = progress.length;
    // Part 1's wait (20–40 ms) ends after the rejection: nothing more goes out.
    await new Promise((r) => setTimeout(r, 80));
    expect(s.calls.filter((c) => c.url === "https://r2.test/part?n=1")).toHaveLength(1);
    expect(s.calls.filter((c) => c.url === "https://r2.test/part?n=3")).toHaveLength(0);
    expect(progress.length).toBe(seen);
    client.close();
  });

  it("rejects a mutation that does not return an upload ticket", async () => {
    const server = messagesServer({ mutations: { "storage:generateUploadUrl": () => ({ nope: true }) } });
    const client = makeClient(server);
    await expect(client.files.upload(new Uint8Array(1), { fetch: storageFetch().fetchImpl })).rejects.toMatchObject({ code: "bad_ticket" });
    client.close();
  });

  it("parts of an ArrayBuffer are views over it (no copy); a create that answers part URLs saves the parts call", async () => {
    for (const partUrls of [false, true]) {
      const { client } = setup(() => ({ multipart: { partSize: 10 } }));
      const s = storageFetch({ partUrls });
      const buffer = new Uint8Array(25).map((_, i) => i).buffer;
      await client.files.upload(buffer, { fetch: s.fetchImpl, multipartThreshold: 8 });
      const parts = s.calls.filter((c) => c.url.startsWith("https://r2.test/part"));
      expect(parts).toHaveLength(3);
      for (const p of parts) expect((p.raw as Uint8Array).buffer).toBe(buffer);
      expect(parts.map((p) => [...(p.body as Uint8Array)][0]).sort((a, b) => a! - b!)).toEqual([0, 10, 20]);
      const create = s.calls.find((c) => (c.body as any)?.op === "create")!;
      expect((create.body as any).partNumbers).toEqual([1, 2, 3]);
      expect(s.calls.filter((c) => (c.body as any)?.op === "parts")).toHaveLength(partUrls ? 0 : 1);
      client.close();
    }
  });

  it("a create that answers another part size: its URLs are used, only the missing part numbers are asked for", async () => {
    // The ticket says 10-byte parts (3 guessed for 25 bytes); the create call answers 5 (5 parts), or the other way.
    for (const [ticketSize, createdSize, parts, asked] of [[10, 5, 5, [4, 5]], [5, 10, 3, null]] as const) {
      const { client } = setup(() => ({ multipart: { partSize: ticketSize } }));
      const s = storageFetch({ partUrls: true, partSize: createdSize });
      await client.files.upload(new Uint8Array(25), { fetch: s.fetchImpl, multipartThreshold: 8 });
      expect(s.calls.filter((c) => c.url.startsWith("https://r2.test/part"))).toHaveLength(parts);
      const partsCalls = s.calls.filter((c) => (c.body as any)?.op === "parts");
      expect(partsCalls.map((c) => (c.body as any).partNumbers)).toEqual(asked ? [asked] : []);
      const complete = s.calls.find((c) => (c.body as any)?.op === "complete")!;
      expect((complete.body as any).parts.map((p: any) => p.partNumber)).toEqual(Array.from({ length: parts }, (_, i) => i + 1));
      client.close();
    }
  });

  it("client.files is a getter of EmberClient (no prototype patching on import), so the package is side-effect free", async () => {
    const { readFileSync } = await import("node:fs");
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { sideEffects: unknown };
    expect(pkg.sideEffects).toBe(false);
    expect(typeof Object.getOwnPropertyDescriptor(EmberClient.prototype, "files")?.get).toBe("function");
    const { client } = setup(() => ({}));
    // Not in the static graph of EmberClient: a stand-in that loads the helper on the first upload.
    expect(client.files).not.toBeInstanceOf(ClientFiles);
    expect(client.files).toBe(client.files);
    expect(client.files.url("/api/storage/x")).toBe("https://ember.test/api/storage/x");
    client.close();
  });

  it("option files: files() (the /files subpath) makes client.files the helper itself", async () => {
    const { files } = await import("../src/files.ts");
    const server = messagesServer();
    const client = makeClient(server, { files: files() });
    expect(client.files).toBeInstanceOf(ClientFiles);
    expect(client.files).toBe(client.files);
    client.close();
  });

  it("the client's static graph does not import the upload helper nor the multi-tab hub (only types, or import())", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/client.ts", import.meta.url), "utf8");
    for (const m of ["files", "multitab"]) {
      expect(src).not.toMatch(new RegExp(`^import (?!type )[^;]*from "\\./${m}\\.ts"`, "m"));
      expect(src).toContain(`import("./${m}.ts")`);
    }
  });
});
