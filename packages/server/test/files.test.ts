import { describe, expect, test } from "vitest";
import { createNodeSqliteDriver } from "../src/testing.ts";
import {
  collectFiles,
  createEngine,
  defineSchema,
  defineTable,
  fileKey,
  FileStore,
  mutationGeneric as mutation,
  parseFileKey,
  partPlan,
  proxyGetSignature,
  proxySigner,
  queryGeneric as query,
  s3Signer,
  tmpKey,
  v,
  type EmberError,
  type UploadTicket,
} from "../src/index.ts";
import { DEFAULT_URL_TTL_S, URL_TIME_WINDOW_MS } from "../src/files.ts";

const SHA = "a".repeat(64);
const SHA2 = "b".repeat(64);

const schema = defineSchema({
  tables: {
    posts: defineTable({
      title: v.string(),
      cover: v.optional(v.file()),
      gallery: v.optional(v.array(v.file())),
      meta: v.optional(v.object({ avatar: v.union(v.file(), v.null()) })),
    }),
    plain: defineTable({ x: v.number() }),
  },
});

const functions = {
  files: {
    upload: mutation({ args: { opts: v.any() }, handler: (ctx, { opts }) => ctx.storage.generateUploadUrl(opts) }),
    del: mutation({ args: { id: v.string() }, handler: (ctx, { id }) => ctx.storage.delete(id) }),
    url: query({ args: { id: v.string() }, handler: (ctx, { id }) => ctx.storage.getUrl(id) }),
    meta: query({ args: { id: v.string() }, handler: (ctx, { id }) => ctx.storage.getMetadata(id) }),
  },
  posts: {
    insert: mutation({ args: { doc: v.any() }, handler: (ctx, { doc }) => ctx.db.insert("posts", doc) }),
    patch: mutation({ args: { id: v.string(), doc: v.any() }, handler: (ctx, { id, doc }) => ctx.db.patch(id as any, doc) }),
    replace: mutation({ args: { id: v.string(), doc: v.any() }, handler: (ctx, { id, doc }) => ctx.db.replace(id as any, doc) }),
    remove: mutation({ args: { id: v.string() }, handler: (ctx, { id }) => ctx.db.delete(id as any) }),
    insertThenFail: mutation({
      args: { doc: v.any() },
      handler: (ctx, { doc }): void => {
        ctx.db.insert("posts", doc);
        throw new Error("boom");
      },
    }),
  },
};

const S3 = { accountId: "acct", bucket: "ember-app-prod", credentials: { accessKeyId: "AK", secretAccessKey: "SK" } };

function setup(signer: "s3" | "proxy" | null = "s3", now = { t: 1_700_000_000_000 }) {
  const driver = createNodeSqliteDriver();
  const engine = createEngine({
    schema,
    functions,
    driver,
    now: () => now.t,
    storage: {
      shard: () => "org:acme",
      signer: signer === "s3" ? s3Signer(S3) : signer === "proxy" ? proxySigner({ secret: "s3cr3t", baseUrl: "https://app.test" }) : null,
      gcGraceMs: 1000,
    },
  });
  engine.migrate();
  const store = FileStore.ofDriver(driver, { shard: () => "org:acme", gcGraceMs: 1000 });
  const upload = (opts: object = {}) => engine.runMutation("files:upload", { opts }).value as UploadTicket;
  const ready = (id: string, size = 3) => store.markReady(id, { size, etag: "e" }, now.t);
  const refs = (id: string) => store.get(id)?.refcount;
  return { driver, engine, store, upload, ready, refs, now };
}

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as EmberError).code;
  }
  return "no error";
};

describe("keys", () => {
  test("content-addressed and tmp keys round-trip the shard name", () => {
    for (const shard of ["org:acme", "mailbox:mbx_01J/x?y=z", "global:main", "u:çãø"]) {
      expect(parseFileKey(fileKey(shard, SHA))).toEqual({ kind: "f", shard, rest: SHA });
      expect(parseFileKey(tmpKey(shard, "_storage_X"))).toEqual({ kind: "t", shard, rest: "_storage_X" });
      expect(fileKey(shard, SHA)).toMatch(/^f\/[A-Za-z0-9_-]+\/[0-9a-f]{64}$/);
    }
    expect(parseFileKey("other/thing")).toBeNull();
  });

  test("partPlan keeps parts equal, >= 5 MiB and <= 10k", () => {
    expect(partPlan(60 * 1024 ** 2)).toEqual({ partSize: 10 * 1024 ** 2, parts: 6 });
    expect(partPlan(1)).toEqual({ partSize: 10 * 1024 ** 2, parts: 1 });
    const huge = partPlan(500 * 1024 ** 3);
    expect(huge.parts).toBeLessThanOrEqual(10_000);
    expect(partPlan(1, 1024).partSize).toBe(5 * 1024 ** 2);
  });
});

describe("collectFiles", () => {
  test("walks objects, arrays, records, unions", () => {
    const s = v.object({
      a: v.file(),
      b: v.array(v.file()),
      c: v.record(v.object({ f: v.optional(v.file()) })),
      d: v.union(v.string(), v.file()),
      e: v.string(),
    }).shape;
    const id = (n: number) => `_storage_01J9Z3${String(n).padStart(20, "0")}`;
    const out = collectFiles(s, { a: id(1), b: [id(2), id(2)], c: { x: { f: id(3) }, y: {} }, d: "not-a-file", e: id(9) });
    expect(out.sort()).toEqual([id(1), id(2), id(2), id(3)]);
    expect(collectFiles(s, { a: id(1), b: [], c: {}, d: id(4), e: "" }).sort()).toEqual([id(1), id(4)]);
  });
});

describe("ctx.storage.generateUploadUrl", () => {
  test("sha256 known: presigned PUT to the content-addressed key with signed headers", () => {
    const { upload, store } = setup();
    const t = upload({ contentType: "image/png", size: 3, sha256: SHA });
    expect(t.storageId).toMatch(/^_storage_[0-9A-Z]{26}$/);
    expect(t.token).toMatch(/^[0-9a-f]{48}$/);
    expect(t.method).toBe("PUT");
    const u = new URL(t.url!);
    expect(u.host).toBe("acct.r2.cloudflarestorage.com");
    expect(u.pathname).toBe(`/ember-app-prod/${fileKey("org:acme", SHA)}`);
    expect(u.searchParams.get("X-Amz-SignedHeaders")).toBe("content-length;content-type;host;x-amz-checksum-sha256");
    expect(t.headers).toEqual({ "content-type": "image/png", "x-amz-checksum-sha256": btoa(String.fromCharCode(...new Uint8Array(32).fill(0xaa))) });
    const row = store.get(t.storageId)!;
    expect(row).toMatchObject({ state: "pending", sha256: SHA, size: 3, refcount: 0, key: fileKey("org:acme", SHA) });
  });

  test("sha256 unknown or multipart: tmp key; multipart has no URL", () => {
    const { upload, store } = setup();
    const a = upload({ contentType: "text/plain" });
    expect(store.get(a.storageId)!.key).toBe(tmpKey("org:acme", a.storageId));
    expect(a.url).toContain("/t/");
    const m = upload({ size: 60 * 1024 ** 2, multipart: true, sha256: SHA });
    expect(m.url).toBeUndefined();
    expect(m.multipart).toEqual({ partSize: 10 * 1024 ** 2 });
    expect(store.get(m.storageId)).toMatchObject({ multipart: true, key: tmpKey("org:acme", m.storageId) });
  });

  test("dedup: same sha256 already ready returns it with exists", () => {
    const { upload, ready } = setup();
    const a = upload({ sha256: SHA, size: 3 });
    ready(a.storageId);
    const b = upload({ sha256: SHA, size: 3 });
    expect(b).toMatchObject({ storageId: a.storageId, exists: true });
    expect(b.url).toBeUndefined();
  });

  test("proxy mode: PUT path on the Worker, HMAC-signed GET", () => {
    const { upload, ready, engine } = setup("proxy");
    const t = upload({ contentType: "text/plain", sha256: SHA });
    expect(t.url).toBe(`https://app.test/api/storage/put?shard=org%3Aacme&id=${t.storageId}&token=${t.token}`);
    ready(t.storageId);
    const url = new URL(engine.runQuery("files:url", { id: t.storageId }).value as string);
    expect(url.pathname).toBe("/api/storage/get");
    const k = url.searchParams.get("k")!;
    expect(k).toBe(fileKey("org:acme", SHA));
    expect(url.searchParams.get("sig")).toBe(proxyGetSignature("s3cr3t", k, Number(url.searchParams.get("exp")), "text/plain", ""));
  });

  test("validates options and needs a signer", () => {
    const { engine } = setup();
    expect(code(() => engine.runMutation("files:upload", { opts: { sha256: "xyz" } }))).toBe("ValidationError");
    expect(code(() => engine.runMutation("files:upload", { opts: { size: -1 } }))).toBe("ValidationError");
    const none = setup(null);
    expect(code(() => none.engine.runMutation("files:upload", { opts: {} }))).toBe("StorageError");
  });
});

describe("getUrl / getMetadata", () => {
  test("null until ready; presigned GET stable inside the 5-minute window", () => {
    const { upload, ready, engine, now } = setup();
    const t = upload({ contentType: "image/png", sha256: SHA });
    expect(engine.runQuery("files:url", { id: t.storageId }).value).toBeNull();
    expect(engine.runQuery("files:meta", { id: t.storageId }).value).toMatchObject({ state: "pending" });
    ready(t.storageId, 1234);
    const a = engine.runQuery("files:url", { id: t.storageId }).value as string;
    expect(new URL(a).searchParams.get("response-content-type")).toBe("image/png");
    now.t += 60_000;
    expect(engine.runQuery("files:url", { id: t.storageId }).value).toBe(a);
    now.t += 5 * 60_000;
    expect(engine.runQuery("files:url", { id: t.storageId }).value).not.toBe(a);
    expect(engine.runQuery("files:meta", { id: t.storageId }).value).toMatchObject({ storageId: t.storageId, size: 1234, contentType: "image/png", state: "ready", sha256: SHA });
    expect(engine.runQuery("files:url", { id: "_storage_nope" }).value).toBeNull();
  });
});

describe("refcounts follow documents in the same transaction", () => {
  test("insert / patch / replace / delete", () => {
    const { upload, ready, refs, engine } = setup();
    const a = upload({ sha256: SHA }).storageId;
    const b = upload({ sha256: SHA2 }).storageId;
    ready(a);
    ready(b);
    const id = engine.runMutation("posts:insert", { doc: { title: "x", cover: a, gallery: [a, b] } }).value as string;
    expect([refs(a), refs(b)]).toEqual([2, 1]);
    engine.runMutation("posts:patch", { id, doc: { gallery: [b] } });
    expect([refs(a), refs(b)]).toEqual([1, 1]);
    engine.runMutation("posts:replace", { id, doc: { title: "y", meta: { avatar: b } } });
    expect([refs(a), refs(b)]).toEqual([0, 1]);
    engine.runMutation("posts:remove", { id });
    expect([refs(a), refs(b)]).toEqual([0, 0]);
  });

  test("a failing mutation rolls refcounts back; unknown files are refused", () => {
    const { upload, refs, engine } = setup();
    const a = upload({ sha256: SHA }).storageId; // pending files can be referenced
    expect(code(() => engine.runMutation("posts:insertThenFail", { doc: { title: "x", cover: a } }))).toBe(undefined);
    expect(refs(a)).toBe(0);
    expect(code(() => engine.runMutation("posts:insert", { doc: { title: "x", cover: "_storage_01J9Z3AAAAAAAAAAAAAAAAAAAA" } }))).toBe("FileNotFound");
  });

  test("delete refuses referenced files; GC two-phase keeps shared objects", () => {
    const { upload, ready, store, engine, now } = setup();
    const a = upload({ sha256: SHA }).storageId;
    ready(a);
    const id = engine.runMutation("posts:insert", { doc: { title: "x", cover: a } }).value as string;
    expect(code(() => engine.runMutation("files:del", { id: a }))).toBe("FileInUse");
    expect(store.nextGcAt()).toBeNull();
    engine.runMutation("posts:remove", { id });
    expect(store.nextGcAt()).toBe(now.t + 1000);
    expect(store.gcBegin(now.t)).toEqual([]); // grace not over
    now.t += 1001;
    const batch = store.gcBegin(now.t);
    expect(batch).toEqual([{ id: a, key: fileKey("org:acme", SHA), deleteObject: true }]);
    // A row in `deleting` cannot be referenced again, and a new upload of the same content avoids its key.
    expect(code(() => engine.runMutation("posts:insert", { doc: { title: "x", cover: a } }))).toBe("FileNotFound");
    const again = upload({ sha256: SHA });
    expect(store.get(again.storageId)!.key).toBe(tmpKey("org:acme", again.storageId));
    store.gcFinish(batch.map((b) => b.id));
    expect(store.get(a)).toBeNull();
  });

  test("explicit delete makes an unreferenced file due immediately", () => {
    const { upload, store, engine, now } = setup();
    const a = upload({ sha256: SHA }).storageId;
    engine.runMutation("files:del", { id: a });
    expect(store.nextGcAt()).toBe(1000);
    expect(store.gcBegin(now.t).map((x) => x.id)).toEqual([a]);
  });

  test("an unreferenced pending upload is kept while its ticket is usable, then collected", () => {
    const { upload, store, now } = setup();
    const a = upload({}).storageId;
    const hold = DEFAULT_URL_TTL_S * 1000 + URL_TIME_WINDOW_MS; // > gcGraceMs (1000)
    expect(store.nextGcAt()).toBe(now.t + hold);
    now.t += 1001; // past the grace period: still uploading, not collectable
    expect(store.gcBegin(now.t)).toEqual([]);
    now.t += hold;
    expect(store.gcBegin(now.t).map((x) => x.id)).toEqual([a]);
  });

  test("a slow upload's grace period restarts when it is confirmed", () => {
    const { upload, ready, store, now } = setup();
    const a = upload({}).storageId;
    now.t += 5000; // the upload took longer than the grace period (1000)
    ready(a);
    expect(store.gcBegin(now.t)).toEqual([]);
    expect(store.nextGcAt()).toBe(now.t + 1000);
    now.t += 1001;
    expect(store.gcBegin(now.t).map((x) => x.id)).toEqual([a]);
  });

  test("objects shared by two rows are only deleted with the last one", () => {
    const { upload, store, now } = setup();
    const a = upload({}).storageId;
    const b = upload({}).storageId;
    // Both tmp uploads turned out to have the same content.
    store.markReady(a, { size: 1, etag: null, sha256: SHA, key: fileKey("org:acme", SHA) }, now.t);
    store.markReady(b, { size: 1, etag: null, sha256: SHA, key: fileKey("org:acme", SHA) }, now.t);
    store.adjust(new Map([[b, 1]]), now.t);
    now.t += 5000;
    expect(store.gcBegin(now.t)).toEqual([{ id: a, key: fileKey("org:acme", SHA), deleteObject: false }]);
  });

  test("fuzz: refcount equals live references after random writes", () => {
    const { upload, ready, refs, engine } = setup();
    const ids = Array.from({ length: 5 }, (_, i) => {
      const t = upload({ sha256: String(i).repeat(64) });
      ready(t.storageId);
      return t.storageId;
    });
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const pick = () => ids[Math.floor(rnd() * ids.length)]!;
    const randomDoc = () => {
      const doc: Record<string, unknown> = { title: "t" };
      if (rnd() < 0.6) doc.cover = pick();
      if (rnd() < 0.6) doc.gallery = Array.from({ length: Math.floor(rnd() * 4) }, pick);
      if (rnd() < 0.4) doc.meta = { avatar: rnd() < 0.5 ? null : pick() };
      return doc;
    };
    const live = new Map<string, Record<string, unknown>>();
    for (let i = 0; i < 400; i++) {
      const r = rnd();
      const docs = [...live.keys()];
      if (r < 0.35 || !docs.length) {
        const doc = randomDoc();
        live.set(engine.runMutation("posts:insert", { doc }).value as string, doc);
      } else if (r < 0.55) {
        const id = docs[Math.floor(rnd() * docs.length)]!;
        const doc = randomDoc();
        engine.runMutation("posts:replace", { id, doc });
        live.set(id, doc);
      } else if (r < 0.75) {
        const id = docs[Math.floor(rnd() * docs.length)]!;
        const patch = { gallery: rnd() < 0.3 ? undefined : [pick()] };
        engine.runMutation("posts:patch", { id, doc: patch });
        const d = { ...live.get(id)! };
        if (patch.gallery === undefined) delete d.gallery;
        else d.gallery = patch.gallery;
        live.set(id, d);
      } else if (r < 0.9) {
        const id = docs[Math.floor(rnd() * docs.length)]!;
        engine.runMutation("posts:remove", { id });
        live.delete(id);
      } else {
        try {
          engine.runMutation("posts:insertThenFail", { doc: randomDoc() });
        } catch {
          // rolled back
        }
      }
    }
    const expected = new Map(ids.map((id) => [id, 0]));
    for (const d of live.values()) {
      const all = [d.cover, ...((d.gallery as string[]) ?? []), (d.meta as { avatar?: string } | undefined)?.avatar].filter((x): x is string => typeof x === "string");
      for (const f of all) expected.set(f, expected.get(f)! + 1);
    }
    for (const id of ids) expect(refs(id), id).toBe(expected.get(id));
  });
});
