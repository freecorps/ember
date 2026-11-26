// The component over the real engine (`emberTest({ app })`): assets uploaded once by content, publish, the manifest
// route with rollouts, rollbacks and the kill switch, the asset route, and the dashboard spec. The edge cache is
// workerd's (test/workerd); here `caches` does not exist and every request reads the shard.
import { createHash } from "node:crypto";
import { composeApp, defineApp, defineSchema, unsafeRef } from "@freecorps/ember-server";
import { emberTest, type EmberTest } from "@freecorps/ember-testing";
import { describe, expect, test } from "vitest";
import { expoUpdates, MAX_CHANNELS_PER_BRANCH, parseMultipart, parseSfvDictionary } from "../src/index.ts";
import { testKeys, verify } from "./keys.ts";

const keys = await testKeys();
const schema = defineSchema({ tables: {} });
const app = defineApp().use(expoUpdates, { config: { signing: { keyId: "main" } } });
const hex = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const m = (name: string) => unsafeRef<"mutation">(`@expoUpdates/lib:${name}`);

const harness = () => emberTest({ schema, modules: {}, app, env: { EXPO_UPDATES_PRIVATE_KEY: keys.pkcs1 } });

/** The CLI's upload step: prepareAssets, PUT the ones with a ticket, confirm. Returns how many were uploaded. */
async function upload(t: EmberTest, files: Record<string, string>): Promise<number> {
  const list = Object.entries(files).map(([name, body]) => ({ sha256: hex(body), size: new TextEncoder().encode(body).length, contentType: name === "bundle" ? "application/javascript" : "image/png" }));
  const prepared = (await t.mutation(m("prepareAssets"), { assets: list })) as Array<{ sha256: string; exists: boolean; upload?: { url: string; headers: Record<string, string>; storageId: string; shard: string; token: string } }>;
  let n = 0;
  for (const p of prepared) {
    if (!p.upload) continue;
    const body = Object.values(files).find((b) => hex(b) === p.sha256)!;
    expect((await t.fetch(p.upload.url, { method: "PUT", headers: p.upload.headers, body })).status).toBe(200);
    const c = await t.fetch("/api/storage/confirm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ shard: p.upload.shard, storageId: p.upload.storageId, token: p.upload.token }) });
    expect(c.status).toBe(200);
    n++;
  }
  return n;
}

const asset = (body: string, key: string, contentType: string, fileExtension?: string) => ({ sha256: hex(body), key, contentType, ...(fileExtension ? { fileExtension } : {}) });

async function publish(t: EmberTest, o: { branch?: string; bundle: string; image?: string; rolloutPercent?: number; platforms?: Array<"ios" | "android">; runtimeVersion?: string }) {
  const files: Record<string, string> = { bundle: o.bundle, ...(o.image ? { image: o.image } : {}) };
  const uploaded = await upload(t, files);
  const r = (await t.mutation(m("publish"), {
    branch: o.branch ?? "production",
    message: `bundle ${o.bundle}`,
    ...(o.rolloutPercent !== undefined ? { rolloutPercent: o.rolloutPercent } : {}),
    updates: (o.platforms ?? ["ios"]).map((platform) => ({
      platform,
      runtimeVersion: o.runtimeVersion ?? "1.0.0",
      launchAsset: asset(o.bundle, `bundle-${platform}`, "application/javascript"),
      assets: o.image ? [asset(o.image, "md5-of-image", "image/png", ".png")] : [],
      metadata: {},
      extra: { expoClient: { name: "Test" } },
    })),
  })) as { updates: Array<{ id: string; platform: string }> };
  return { uploaded, ids: r.updates.map((u) => u.id) };
}

type Answer = { status: number; kind: "update" | "noUpdateAvailable" | "rollBackToEmbedded" | "none"; id?: string; manifest?: any; signature?: string; body?: string; headers: Headers };
async function ask(t: EmberTest, h: Record<string, string> = {}): Promise<Answer> {
  const res = await t.fetch("/expoUpdates/manifest", { headers: { "expo-protocol-version": "1", "expo-platform": "ios", "expo-runtime-version": "1.0.0", accept: "multipart/mixed", "eas-client-id": "install-1", ...h } });
  if (res.status !== 200) return { status: res.status, kind: "none", headers: res.headers };
  const parts = parseMultipart(await res.text(), res.headers.get("content-type")!);
  const manifest = parts.find((p) => p.name === "manifest");
  const directive = parts.find((p) => p.name === "directive");
  const sig = (manifest ?? directive)?.headers["expo-signature"];
  const signature = sig ? (parseSfvDictionary(sig)!.get("sig") as string) : undefined;
  if (manifest) {
    const json = JSON.parse(manifest.body);
    return { status: 200, kind: "update", id: json.id, manifest: json, body: manifest.body, headers: res.headers, ...(signature ? { signature } : {}) };
  }
  if (!directive) throw new Error(`200 multipart response without a manifest or directive part (parts: ${parts.map((p) => p.name).join(", ")})`);
  return { status: 200, kind: JSON.parse(directive.body).type, body: directive.body, headers: res.headers, ...(signature ? { signature } : {}) };
}

describe("expo updates component", () => {
  test("publish → signed manifest → assets; dedup by content across updates", async () => {
    const t = harness();
    const first = await publish(t, { bundle: "console.log(1)", image: "PNG-1" });
    expect(first.uploaded).toBe(2);
    const a = await ask(t, { "expo-expect-signature": 'sig, keyid="main", alg="rsa-v1_5-sha256"' });
    expect(a).toMatchObject({ status: 200, kind: "update", id: first.ids[0] });
    expect(await verify(keys.publicKey, a.signature!, a.body!)).toBe(true);
    expect(a.headers.get("expo-protocol-version")).toBe("1");
    expect(a.headers.get("cache-control")).toBe("private, max-age=0");
    expect(a.manifest).toMatchObject({ runtimeVersion: "1.0.0", launchAsset: { key: "bundle-ios", contentType: "application/javascript", hash: createHash("sha256").update("console.log(1)").digest("base64url") }, assets: [{ key: "md5-of-image", fileExtension: ".png" }], extra: { expoClient: { name: "Test" } } });

    // The asset URL serves the bytes, immutable, with the right content type.
    const res = await t.fetch(a.manifest.launchAsset.url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("console.log(1)");
    expect(res.headers.get("content-type")).toBe("application/javascript");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect((await t.fetch("/expoUpdates/assets?key=" + "0".repeat(64))).status).toBe(404);
    expect((await t.fetch("/expoUpdates/assets?key=nope")).status).toBe(400);

    // A new bundle with the same image: only the bundle is uploaded.
    const second = await publish(t, { bundle: "console.log(2)", image: "PNG-1" });
    expect(second.uploaded).toBe(1);
    // The same export again: nothing.
    expect((await publish(t, { bundle: "console.log(2)", image: "PNG-1" })).uploaded).toBe(0);
    const b = await ask(t);
    expect(b.kind).toBe("update");
    expect(b.signature).toBeUndefined();
    // The client already runs it: noUpdateAvailable.
    expect((await ask(t, { "expo-current-update-id": b.id! })).kind).toBe("noUpdateAvailable");
    // Other platform / runtime version / channel: nothing published there.
    expect((await ask(t, { "expo-platform": "android" })).kind).toBe("noUpdateAvailable");
    expect((await ask(t, { "expo-runtime-version": "2.0.0" })).kind).toBe("noUpdateAvailable");
    expect((await ask(t, { "expo-channel-name": "staging" })).kind).toBe("noUpdateAvailable");
    // Protocol 0: no directives; nothing new is a 204, and the current update's manifest is sent (the client compares).
    expect((await ask(t, { "expo-protocol-version": "0", "expo-runtime-version": "9" })).status).toBe(204);
    expect(await ask(t, { "expo-protocol-version": "0", "expo-current-update-id": b.id! })).toMatchObject({ status: 200, kind: "update", id: b.id });
    // The JSON forms: the media type accept selected.
    const json = await t.fetch("/expoUpdates/manifest", { headers: { "expo-protocol-version": "1", "expo-platform": "ios", "expo-runtime-version": "1.0.0", accept: "application/expo+json" } });
    expect(json.headers.get("content-type")).toBe("application/expo+json; charset=utf-8");
    expect(((await json.json()) as { id: string }).id).toBe(b.id);
    // A signature expected without the key configured: 500 with what to set.
    const unsigned = emberTest({ schema, modules: {}, app });
    await publish(unsigned, { bundle: "x" });
    const r = await unsigned.fetch("/expoUpdates/manifest", { headers: { "expo-platform": "ios", "expo-runtime-version": "1.0.0", "expo-protocol-version": "1", "expo-expect-signature": "sig" } });
    expect(r.status).toBe(500);
    expect(await r.text()).toMatch(/EXPO_UPDATES_PRIVATE_KEY/);
    // Bad requests.
    expect((await ask(t, { "expo-platform": "web" })).status).toBe(400);
    expect((await ask(t, { "expo-protocol-version": "7" })).status).toBe(406);
  });

  test("publish refuses an asset that was never uploaded, and a runtime version no client can send", async () => {
    const t = harness();
    await expect(
      t.mutation(m("publish"), { branch: "production", updates: [{ platform: "ios", runtimeVersion: "1", launchAsset: asset("never", "k", "application/javascript"), assets: [] }] }),
    ).rejects.toMatchObject({ code: "AssetNotUploaded" });
    await expect(publish(t, { bundle: "ws", runtimeVersion: "1.0.0 " })).rejects.toThrow(/surrounding whitespace/);
    await expect(publish(t, { bundle: "ws", runtimeVersion: " 1.0.0" })).rejects.toThrow(/surrounding whitespace/);
    await expect(publish(t, { bundle: "ws", runtimeVersion: "1\n2" })).rejects.toThrow(/control characters/);
    await expect(publish(t, { bundle: "ws", runtimeVersion: "1\u00002" })).rejects.toThrow(/control characters/);
    expect((await publish(t, { bundle: "ws", runtimeVersion: "1.0.0" })).ids).toHaveLength(1);
  });

  test("two publishers of the same content: the first one's confirmed upload serves, though a second ticket came after", async () => {
    const t = harness();
    const body = "console.log('shared')";
    const prep = async () =>
      ((await t.mutation(m("prepareAssets"), { assets: [{ sha256: hex(body), size: body.length, contentType: "application/javascript" }] })) as Array<{ upload?: { url: string; headers: Record<string, string>; storageId: string; shard: string; token: string } }>)[0]!.upload!;
    const first = await prep();
    const second = await prep(); // before the first confirms
    expect(second.storageId).not.toBe(first.storageId);
    expect((await t.fetch(first.url, { method: "PUT", headers: first.headers, body })).status).toBe(200);
    const c = await t.fetch("/api/storage/confirm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ shard: first.shard, storageId: first.storageId, token: first.token }) });
    expect(c.status).toBe(200);
    const r = (await t.mutation(m("publish"), { branch: "production", updates: [{ platform: "ios", runtimeVersion: "1.0.0", launchAsset: asset(body, "bundle", "application/javascript"), assets: [] }] })) as { updates: unknown[] };
    expect(r.updates).toHaveLength(1);
    const a = await ask(t);
    expect(a.kind).toBe("update");
    expect(await (await t.fetch(a.manifest.launchAsset.url)).text()).toBe(body);
    // The second publisher's upload, still in flight, can still be confirmed (its file stayed referenced).
    expect((await t.fetch(second.url, { method: "PUT", headers: second.headers, body })).status).toBe(200);
    const c2 = await t.fetch("/api/storage/confirm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ shard: second.shard, storageId: second.storageId, token: second.token }) });
    expect(c2.status).toBe(200);
  });

  test("rolling back a republished release reaches the one before it, not the original copy", async () => {
    const t = harness();
    await publish(t, { bundle: "A" });
    await publish(t, { bundle: "B" });
    await publish(t, { bundle: "C" });
    const hashOf = async () => (await ask(t)).manifest.launchAsset.hash as string;
    const h = (b: string) => createHash("sha256").update(b).digest("base64url");
    await t.mutation(m("rollback"), { branch: "production" });
    expect(await hashOf()).toBe(h("B"));
    // B is bad too: back to A (B' and the original B both out of service).
    await t.mutation(m("rollback"), { branch: "production" });
    expect(await hashOf()).toBe(h("A"));
    // And past A: the embedded update.
    expect(((await t.mutation(m("rollback"), { branch: "production" })) as Array<{ kind: string }>)[0]!.kind).toBe("rollBackToEmbedded");
  });

  test("one media type per content: another type for stored bytes is refused at prepare and at publish", async () => {
    const t = harness();
    await publish(t, { bundle: "x", image: "PNG-Z" });
    await expect(t.mutation(m("prepareAssets"), { assets: [{ sha256: hex("PNG-Z"), size: 5, contentType: "application/octet-stream" }] })).rejects.toThrow(/stored as image\/png/);
    await expect(
      t.mutation(m("publish"), { branch: "production", updates: [{ platform: "ios", runtimeVersion: "1.0.0", launchAsset: asset("x", "b", "application/javascript"), assets: [asset("PNG-Z", "img", "application/octet-stream")] }] }),
    ).rejects.toThrow(/stored as image\/png/);
    // While an upload is only in flight, a second type is refused as well.
    await t.mutation(m("prepareAssets"), { assets: [{ sha256: hex("PNG-Y"), size: 5, contentType: "image/png" }] });
    await expect(t.mutation(m("prepareAssets"), { assets: [{ sha256: hex("PNG-Y"), size: 5, contentType: "image/webp" }] })).rejects.toThrow(/stored as image\/png/);
  });

  test("expired upload tickets stop counting and are let go: prepareAssets keeps working for that content", async () => {
    const t = harness();
    const body = "never-uploaded";
    const prep = () => t.mutation(m("prepareAssets"), { assets: [{ sha256: hex(body), size: body.length, contentType: "application/javascript" }] });
    for (let i = 0; i < 16; i++) await prep();
    await expect(prep()).rejects.toThrow(/already in flight/);
    // Every ticket expires (default URL TTL: 1 h): they no longer count, and the row keeps only the new one.
    await t.advance(2 * 3600_000);
    await prep();
    for (let i = 0; i < 15; i++) await prep();
    await expect(prep()).rejects.toThrow(/already in flight/);
  });

  test("an upload whose PUT finished in time is still confirmed after its ticket expired (grace), though another prepare ran", async () => {
    const t = harness();
    const body = "late-confirm";
    const prep = async () =>
      ((await t.mutation(m("prepareAssets"), { assets: [{ sha256: hex(body), size: body.length, contentType: "application/javascript" }] })) as Array<{ upload?: { url: string; headers: Record<string, string>; storageId: string; shard: string; token: string } }>)[0]!.upload!;
    const first = await prep();
    expect((await t.fetch(first.url, { method: "PUT", headers: first.headers, body })).status).toBe(200);
    await t.advance(2 * 3600_000); // past the ticket's expiry, within the grace
    await prep(); // another publisher writes the row
    const c = await t.fetch("/api/storage/confirm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ shard: first.shard, storageId: first.storageId, token: first.token }) });
    expect(c.status).toBe(200);
    const r = (await t.mutation(m("publish"), { branch: "production", updates: [{ platform: "ios", runtimeVersion: "1.0.0", launchAsset: asset(body, "b", "application/javascript"), assets: [] }] })) as { updates: unknown[] };
    expect(r.updates).toHaveLength(1);
  });

  test("with the newer upload confirmed, the older one still pending is let go once out of its grace", async () => {
    const t = harness();
    const body = "two-tickets";
    const prep = async () =>
      ((await t.mutation(m("prepareAssets"), { assets: [{ sha256: hex(body), size: body.length, contentType: "application/javascript" }] })) as Array<{ exists: boolean; upload?: { url: string; headers: Record<string, string>; storageId: string; shard: string; token: string } }>)[0]!;
    const first = (await prep()).upload!;
    const second = (await prep()).upload!;
    expect((await t.fetch(second.url, { method: "PUT", headers: second.headers, body })).status).toBe(200);
    expect((await t.fetch("/api/storage/confirm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ shard: second.shard, storageId: second.storageId, token: second.token }) })).status).toBe(200);
    // Storage collects a file nothing references (the shards' file GC runs on `advance`).
    const stateOf = (id: string) => t.run((ctx) => ctx.storage.getMetadata(id as never)?.state ?? "gone");
    expect((await prep()).exists).toBe(true); // ready; the first, still in flight, stays referenced
    await t.advance(26 * 3600_000); // past its expiry and its grace
    expect(await stateOf(first.storageId)).toBe("pending");
    expect((await prep()).exists).toBe(true); // the row lets it go
    await t.advance(26 * 3600_000);
    expect(await stateOf(first.storageId)).toBe("gone");
    expect(await stateOf(second.storageId)).toBe("ready");
  });

  test("an upload confirmed after its reference was let go is found again by prepareAssets, with no new upload", async () => {
    const t = harness();
    const body = "very-late";
    const prep = async () =>
      ((await t.mutation(m("prepareAssets"), { assets: [{ sha256: hex(body), size: body.length, contentType: "application/javascript" }] })) as Array<{ exists: boolean; upload?: { url: string; headers: Record<string, string>; storageId: string; shard: string; token: string } }>)[0]!;
    const first = (await prep()).upload!;
    expect((await t.fetch(first.url, { method: "PUT", headers: first.headers, body })).status).toBe(200);
    await t.advance(26 * 3600_000); // past the ticket's expiry and its grace
    await prep(); // the row lets the first go
    expect((await t.fetch("/api/storage/confirm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ shard: first.shard, storageId: first.storageId, token: first.token }) })).status).toBe(200);
    const publishIt = () => t.mutation(m("publish"), { branch: "production", updates: [{ platform: "ios", runtimeVersion: "1.0.0", launchAsset: asset(body, "b", "application/javascript"), assets: [] }] });
    await expect(publishIt()).rejects.toMatchObject({ code: "AssetNotUploaded" });
    // Storage dedups by content: the stored copy is the asset's again, nothing to upload.
    expect((await prep()).exists).toBe(true);
    expect(((await publishIt()) as { updates: unknown[] }).updates).toHaveLength(1);
  });

  test("a rollback finds the previous release past many copies of the current one", async () => {
    const t = harness();
    const h = (b: string) => createHash("sha256").update(b).digest("base64url");
    await publish(t, { bundle: "A" });
    await publish(t, { bundle: "B" });
    // 55 temporary updates, each rolled back: B is republished every time (55 live copies of B above A).
    for (let i = 0; i < 55; i++) {
      await publish(t, { bundle: `tmp-${i}` });
      await t.mutation(m("rollback"), { branch: "production" });
    }
    expect((await ask(t)).manifest.launchAsset.hash).toBe(h("B"));
    await t.mutation(m("rollback"), { branch: "production" });
    expect((await ask(t)).manifest.launchAsset.hash).toBe(h("A"));
    // Every copy of B went out with it: the next rollback goes to the embedded update, not back to B.
    expect(((await t.mutation(m("rollback"), { branch: "production" })) as Array<{ kind: string }>)[0]!.kind).toBe("rollBackToEmbedded");
  }, 60_000);

  test("past the copies a rollback can tell apart, it refuses; to the embedded update it still runs", async () => {
    const t = harness();
    await publish(t, { bundle: "A" });
    await publish(t, { bundle: "B" });
    const b = (await t.query(unsafeRef<"query">("@expoUpdates/lib:updates"), { branch: "production", paginationOpts: { numItems: 1, cursor: null } })) as { page: Array<{ id: string }> };
    const bId = b.page[0]!.id;
    await upload(t, { bundle: "tmp" });
    for (let i = 0; i < 1100; i++) {
      await t.mutation(m("publish"), { branch: "production", updates: [{ id: crypto.randomUUID(), platform: "ios", runtimeVersion: "1.0.0", launchAsset: asset("tmp", "bundle-ios", "application/javascript"), assets: [] }] });
      await t.mutation(m("rollback"), { branch: "production" });
    }
    const liveB = async () => {
      const all = (await t.query(unsafeRef<"query">("@expoUpdates/lib:updates"), { branch: "production", paginationOpts: { numItems: 5000, cursor: null } })) as { page: Array<{ id: string; republishOf: string | null; rolledBack: boolean }> };
      return all.page.filter((u) => !u.rolledBack && (u.id === bId || u.republishOf === bId)).length;
    };
    await expect(t.mutation(m("rollback"), { branch: "production" })).rejects.toThrow(/live copies.*toEmbedded/);
    expect(((await t.mutation(m("rollback"), { branch: "production", toEmbedded: true })) as Array<{ kind: string }>)[0]!.kind).toBe("rollBackToEmbedded");
    expect((await ask(t)).kind).toBe("rollBackToEmbedded");
    // The bounded rollback left copies of B live below the directive (the case the exclusion is for).
    expect(await liveB()).toBeGreaterThan(0);
    // Copies of B the bounded rollback left behind are never served again: another to-embedded changes nothing, and
    // rolling the directive back reaches A, not a leftover B.
    expect(await t.mutation(m("rollback"), { branch: "production", toEmbedded: true })).toEqual([]);
    await t.mutation(m("rollback"), { branch: "production" });
    expect((await ask(t)).manifest.launchAsset.hash).toBe(createHash("sha256").update("A").digest("base64url"));
  }, 180_000);

  test("a publish naming more distinct assets than a mutation can read is refused before anything is written", async () => {
    const t = harness();
    const fake = (n: number, at: number) => Array.from({ length: n }, (_, i) => ({ sha256: createHash("sha256").update(`a-${at}-${i}`).digest("hex"), key: `k${at}-${i}`, contentType: "image/png" }));
    const updates = (["ios", "android"] as const).flatMap((platform) =>
      Array.from({ length: 4 }, (_, j) => ({ platform, runtimeVersion: `${j}.0.0`, launchAsset: fake(1, j * 10 + (platform === "ios" ? 0 : 5))[0]!, assets: fake(1600, j * 10 + (platform === "ios" ? 1 : 6)) })),
    );
    await expect(t.mutation(m("publish"), { branch: "production", updates })).rejects.toThrow(/at most 12000 distinct assets/);
    expect((await t.query(unsafeRef<"query">("@expoUpdates/lib:updates"), { branch: "production", paginationOpts: { numItems: 5, cursor: null } })) as { page: unknown[] }).toMatchObject({ page: [] });
  });

  test("the daily sweep lets go of upload references for a hash nobody touches again; storage then collects the file", async () => {
    const t = harness();
    const body = "abandoned";
    const prepared = (await t.mutation(m("prepareAssets"), { assets: [{ sha256: hex(body), size: body.length, contentType: "application/javascript" }] })) as Array<{ upload?: { storageId: string } }>;
    const id = prepared[0]!.upload!.storageId;
    const stateOf = () => t.run((ctx) => ctx.storage.getMetadata(id as never)?.state ?? "gone");
    const sweep = () => t.mutation(unsafeRef<"mutation">("@expoUpdates/lib:sweepUploads"), {}) as Promise<number>;
    expect(await sweep()).toBe(0); // still in flight
    await t.advance(26 * 3600_000); // past the ticket and its grace
    expect(await stateOf()).toBe("pending"); // still referenced: nothing touched the hash
    expect(await sweep()).toBe(1);
    await t.advance(26 * 3600_000);
    expect(await stateOf()).toBe("gone");
    // A published asset is never swept: its file is ready.
    await publish(t, { bundle: "kept" });
    await t.advance(26 * 3600_000);
    expect(await sweep()).toBe(0);
  });

  test("repeated rollbacks to the embedded update retire the copies left below the directive, until A is reachable", async () => {
    const t = harness();
    await publish(t, { bundle: "A" });
    await publish(t, { bundle: "B" });
    // Thousands of publishes: ids given (the harness's seeded random repeats one now and then over this many).
    await upload(t, { bundle: "tmp" });
    for (let i = 0; i < 2600; i++) {
      await t.mutation(m("publish"), { branch: "production", updates: [{ id: crypto.randomUUID(), platform: "ios", runtimeVersion: "1.0.0", launchAsset: asset("tmp", "bundle-ios", "application/javascript"), assets: [] }] });
      await t.mutation(m("rollback"), { branch: "production" });
    }
    const plan = () => t.query(unsafeRef<"query">("@expoUpdates/http:plan"), { channel: "production", platform: "ios", runtimeVersion: "1.0.0" }) as Promise<{ version: number }>;
    let reached = false;
    let cleanups = 0;
    for (let i = 0; i < 5 && !reached; i++) {
      try {
        await t.mutation(m("rollback"), { branch: "production" });
        reached = true;
      } catch (e) {
        expect(String(e)).toMatch(/toEmbedded/);
        const before = (await plan()).version;
        await t.mutation(m("rollback"), { branch: "production", toEmbedded: true });
        // The first one writes the directive; the next ones only retire rows under it: the channel's version moves
        // either way (the edge cache's plan is never kept over rows that changed).
        expect((await plan()).version).toBe(before + 1);
        cleanups++;
      }
    }
    expect(cleanups).toBeGreaterThanOrEqual(2);
    expect(reached).toBe(true);
    expect((await ask(t)).manifest.launchAsset.hash).toBe(createHash("sha256").update("A").digest("base64url"));
  }, 180_000);

  test("a channel never keeps one branch as both primary and rollout branch", async () => {
    const t = harness();
    for (const b of ["A", "B", "C"]) await publish(t, { branch: b, bundle: `bundle-${b}` });
    const set = (args: Record<string, unknown>) => t.mutation(m("setChannel"), { name: "ch", ...args }) as Promise<{ branch: string; rolloutBranch?: string; rolloutPercent?: number }>;
    expect(await set({ branch: "A", rolloutBranch: "B", rolloutPercent: 30 })).toMatchObject({ branch: "A", rolloutBranch: "B", rolloutPercent: 30 });
    // The rollout branch becomes the primary: the rollout ends.
    const now = await set({ branch: "B" });
    expect([now.branch, now.rolloutBranch, now.rolloutPercent]).toEqual(["B", undefined, undefined]);
    // Later primaries do not bring it back.
    const later = await set({ branch: "C" });
    expect([later.branch, later.rolloutBranch]).toEqual(["C", undefined]);
    expect((await ask(t, { "expo-channel-name": "ch" })).manifest.launchAsset.hash).toBe(createHash("sha256").update("bundle-C").digest("base64url"));
    // With a percentage given for a rollout branch that is now the primary: refused.
    await set({ branch: "A", rolloutBranch: "B", rolloutPercent: 30 });
    await expect(set({ branch: "B", rolloutPercent: 50 })).rejects.toThrow(/must differ/);
  });

  test("branch-wide commands find every live platform and runtime version, however many rows other ones have", async () => {
    const t = harness();
    await publish(t, { bundle: "ios-1", platforms: ["ios"] });
    await publish(t, { bundle: "ios-2", platforms: ["ios"] });
    // Many newer rows of another platform and runtime version on the same branch.
    for (let i = 0; i < 510; i++) await publish(t, { bundle: "android", platforms: ["android"], runtimeVersion: "2.0.0" });
    const rb = (await t.mutation(m("rollback"), { branch: "production", platform: "ios" })) as Array<{ platform: string; runtimeVersion: string }>;
    expect(rb.map((x) => [x.platform, x.runtimeVersion])).toEqual([["ios", "1.0.0"]]);
    expect((await ask(t)).manifest.launchAsset.hash).toBe(createHash("sha256").update("ios-1").digest("base64url"));
    // Without a platform: one per pair.
    const all = (await t.mutation(m("rollback"), { branch: "production" })) as Array<{ platform: string; runtimeVersion: string }>;
    expect(all.map((x) => `${x.platform} ${x.runtimeVersion}`).sort()).toEqual(["android 2.0.0", "ios 1.0.0"]);
  }, 60_000);

  test("assetsUrl with its own query string: key joins it", async () => {
    const cdn = defineApp().use(expoUpdates, { config: { assetsUrl: "https://cdn.test/expoUpdates/assets?region=eu" } });
    const t = emberTest({ schema, modules: {}, app: cdn });
    await publish(t, { bundle: "q", image: "q-img" });
    const a = await ask(t);
    const u = new URL(a.manifest.launchAsset.url);
    expect([u.origin + u.pathname, u.searchParams.get("region"), u.searchParams.get("key")]).toEqual(["https://cdn.test/expoUpdates/assets", "eu", hex("q")]);
    // Served by the route as is (the origin is ignored by the harness).
    expect(await (await t.fetch(a.manifest.assets[0].url)).text()).toBe("q-img");
  });

  test("rollout: a share of installs gets the new update, the rest the previous one; publishing waits for it to end", async () => {
    const t = harness();
    const v1 = await publish(t, { bundle: "v1" });
    const v2 = await publish(t, { bundle: "v2", rolloutPercent: 25 });
    const installs = Array.from({ length: 400 }, (_, i) => `install-${i}`);
    const got = await Promise.all(installs.map((id) => ask(t, { "eas-client-id": id })));
    const share = got.filter((g) => g.id === v2.ids[0]).length / installs.length;
    expect(share).toBeGreaterThan(0.18);
    expect(share).toBeLessThan(0.32);
    expect(got.every((g) => g.id === v2.ids[0] || g.id === v1.ids[0])).toBe(true);
    // Deterministic: the same install gets the same answer.
    expect((await ask(t, { "eas-client-id": "install-7" })).id).toBe(got[7]!.id);
    await expect(publish(t, { bundle: "v3" })).rejects.toMatchObject({ code: "RolloutInProgress" });
    // Raising it keeps everyone who had it.
    await t.mutation(m("setRollout"), { branch: "production", percent: 60 });
    const later = await Promise.all(installs.map((id) => ask(t, { "eas-client-id": id })));
    for (let i = 0; i < installs.length; i++) if (got[i]!.id === v2.ids[0]) expect(later[i]!.id).toBe(v2.ids[0]);
    await t.mutation(m("setRollout"), { branch: "production", percent: 100 });
    expect((await ask(t, { "eas-client-id": "install-x" })).id).toBe(v2.ids[0]);
    await expect(t.mutation(m("setRollout"), { branch: "production", percent: 10 })).rejects.toMatchObject({ code: "NotInRollout" });
    expect((await publish(t, { bundle: "v3" })).ids).toHaveLength(1);
  });

  test("rollback republishes the previous update (newer createdAt); with nothing before it, rollBackToEmbedded", async () => {
    const t = harness();
    const v1 = await publish(t, { bundle: "v1", platforms: ["ios", "android"] });
    const v2 = await publish(t, { bundle: "v2", platforms: ["ios", "android"] });
    const before = await ask(t);
    expect(before.id).toBe(v2.ids[0]);
    const rb = (await t.mutation(m("rollback"), { branch: "production" })) as Array<{ platform: string; rolledBack: string; now: string; kind: string }>;
    expect(rb.map((x) => [x.platform, x.kind]).sort()).toEqual([["android", "update"], ["ios", "update"]]);
    const after = await ask(t);
    // A new update (the client only moves to a newer one) with v1's bundle.
    expect(after.id).not.toBe(v1.ids[0]);
    expect(after.manifest.launchAsset.hash).toBe(createHash("sha256").update("v1").digest("base64url"));
    expect(Date.parse(after.manifest.createdAt)).toBeGreaterThan(Date.parse(before.manifest.createdAt));
    // To embedded: a signed directive; a client already on the embedded update gets noUpdateAvailable.
    await t.mutation(m("rollback"), { branch: "production", platform: "ios", runtimeVersion: "1.0.0", toEmbedded: true });
    const d = await ask(t, { "expo-expect-signature": "sig" });
    expect(d.kind).toBe("rollBackToEmbedded");
    expect(await verify(keys.publicKey, d.signature!, d.body!)).toBe(true);
    expect((await ask(t, { "expo-current-update-id": "e0000000-0000-4000-8000-000000000000", "expo-embedded-update-id": "e0000000-0000-4000-8000-000000000000" })).kind).toBe("noUpdateAvailable");
    // JSON form cannot carry it: 406 when nothing else is accepted, multipart when it is (though ranked lower).
    expect((await ask(t, { accept: "application/json" })).status).toBe(406);
    expect(await ask(t, { accept: "application/json;q=1, multipart/mixed;q=0.5" })).toMatchObject({ status: 200, kind: "rollBackToEmbedded" });
    expect((await ask(t, { accept: "application/json;q=1, multipart/mixed;q=0" })).status).toBe(406);
    // Android untouched by the platform-scoped rollback.
    expect((await ask(t, { "expo-platform": "android" })).kind).toBe("update");
    // The first update rolled back with nothing before it goes to the embedded update too.
    const t2 = harness();
    await publish(t2, { bundle: "only" });
    expect(((await t2.mutation(m("rollback"), { branch: "production" })) as Array<{ kind: string }>)[0]!.kind).toBe("rollBackToEmbedded");
    expect((await ask(t2)).kind).toBe("rollBackToEmbedded");
    // A publish after that, rolled back: the head goes back to the directive, and the result says so.
    await publish(t2, { bundle: "after" });
    expect((await ask(t2)).kind).toBe("update");
    expect(((await t2.mutation(m("rollback"), { branch: "production" })) as Array<{ kind: string }>)[0]!.kind).toBe("rollBackToEmbedded");
    expect((await ask(t2)).kind).toBe("rollBackToEmbedded");
  });

  test("kill switch per channel and per branch; channels with a branch rollout", async () => {
    const t = harness();
    await publish(t, { bundle: "prod" });
    const beta = await publish(t, { bundle: "beta", branch: "beta" });
    await t.mutation(m("setChannelPaused"), { name: "production", paused: true });
    expect((await ask(t)).kind).toBe("noUpdateAvailable");
    await t.mutation(m("setChannelPaused"), { name: "production", paused: false });
    expect((await ask(t)).kind).toBe("update");
    // 30% of production's installs on the beta branch.
    await t.mutation(m("setChannel"), { name: "production", branch: "production", rolloutBranch: "beta", rolloutPercent: 30 });
    const got = await Promise.all(Array.from({ length: 300 }, (_, i) => ask(t, { "eas-client-id": `i${i}` })));
    const onBeta = got.filter((g) => g.id === beta.ids[0]).length / got.length;
    expect(onBeta).toBeGreaterThan(0.22);
    expect(onBeta).toBeLessThan(0.38);
    // Pausing the beta branch stops it for the channels that serve it.
    await t.mutation(m("setBranchPaused"), { name: "beta", paused: true });
    const paused = await Promise.all(Array.from({ length: 300 }, (_, i) => ask(t, { "eas-client-id": `i${i}` })));
    for (let i = 0; i < got.length; i++) expect(paused[i]!.kind).toBe(got[i]!.id === beta.ids[0] ? "noUpdateAvailable" : "update");
    await t.mutation(m("setChannel"), { name: "production", branch: "production", rolloutBranch: null });
    // Cleared (patch with undefined removes the field): every install is back on production.
    const cleared = await Promise.all(Array.from({ length: 300 }, (_, i) => ask(t, { "eas-client-id": `i${i}` })));
    expect(cleared.every((g) => g.kind === "update" && g.id !== beta.ids[0])).toBe(true);
    await expect(t.mutation(m("setChannelPaused"), { name: "nope", paused: true })).rejects.toMatchObject({ code: "UnknownChannel" });
  });

  test("a branch serves at most MAX_CHANNELS_PER_BRANCH channels, and a publish re-versions every one of them", async () => {
    const t = harness();
    for (let i = 0; i < MAX_CHANNELS_PER_BRANCH; i++) await t.mutation(m("setChannel"), { name: `c${i}`, branch: "wide" });
    await expect(t.mutation(m("setChannel"), { name: "one-more", branch: "wide" })).rejects.toThrow(/already serves 1000 channels/);
    await t.mutation(m("setChannel"), { name: "other", branch: "elsewhere" });
    await expect(t.mutation(m("setChannel"), { name: "other", branch: "elsewhere", rolloutBranch: "wide", rolloutPercent: 5 })).rejects.toThrow(/already serves/);
    // Re-pointing a channel that already serves it is not one more.
    await t.mutation(m("setChannel"), { name: "c0", branch: "wide" });
    const r = (await publish(t, { branch: "wide", bundle: "wide" })) as { ids: string[] };
    expect(r.ids).toHaveLength(1);
    const plan = (name: string) => t.query(unsafeRef<"query">("@expoUpdates/http:plan"), { channel: name, platform: "ios", runtimeVersion: "1.0.0" }) as Promise<{ version: number }>;
    // Every channel got the bump, the last one by name too (c999: the old take(1000) per index could miss channels).
    expect((await plan("c999")).version).toBe(1);
    expect((await plan("c0")).version).toBe(2);
    expect((await plan("wide")).version).toBe(0); // never created: no room for the convenience channel
  }, 60_000);

  test("the plan's version changes with every write that can change the answer", async () => {
    const t = harness();
    const plan = async () => (await t.query(unsafeRef<"query">("@expoUpdates/http:plan"), { channel: "production", platform: "ios", runtimeVersion: "1.0.0" })) as { version: number };
    expect(await plan()).toMatchObject({ found: false });
    await publish(t, { bundle: "a" });
    const v = [(await plan()).version];
    await publish(t, { bundle: "b", rolloutPercent: 10 });
    v.push((await plan()).version);
    await t.mutation(m("setRollout"), { branch: "production", percent: 50 });
    v.push((await plan()).version);
    await t.mutation(m("rollback"), { branch: "production" });
    v.push((await plan()).version);
    await t.mutation(m("setBranchPaused"), { name: "production", paused: true });
    v.push((await plan()).version);
    await t.mutation(m("setChannelPaused"), { name: "production", paused: true });
    v.push((await plan()).version);
    expect(new Set(v).size).toBe(v.length);
  });
});

describe("dashboard", () => {
  test("the spec composes with absolute names; its queries read what the screen shows", async () => {
    const composed = composeApp({ schema, functions: {}, app });
    const [spec] = composed.dashboards;
    expect(spec).toMatchObject({ key: "expoUpdates", component: "expoUpdates", icon: "flag", scope: "global" });
    expect(Object.keys(spec!.functions).sort()).toEqual([
      "@expoUpdates/dashboard:branches",
      "@expoUpdates/dashboard:channels",
      "@expoUpdates/dashboard:overview",
      "@expoUpdates/dashboard:update",
      "@expoUpdates/dashboard:updates",
      "@expoUpdates/lib:rollback",
      "@expoUpdates/lib:setBranchPaused",
      "@expoUpdates/lib:setChannel",
      "@expoUpdates/lib:setChannelPaused",
      "@expoUpdates/lib:setRollout",
    ]);
    expect(spec!.functions["@expoUpdates/lib:rollback"]).toMatchObject({ destructive: true });
    const t = harness();
    const { ids } = await publish(t, { bundle: "dash", image: "img" });
    const q = (name: string, args: Record<string, unknown> = {}) => t.query(unsafeRef<"query">(`@expoUpdates/dashboard:${name}`), args) as Promise<any>;
    expect(await q("overview")).toMatchObject({ channels: 1, branches: 1, updates: 1, assets: 2, paused: 0 });
    expect((await q("channels", { paginationOpts: { numItems: 25, cursor: null } })).page).toEqual([expect.objectContaining({ name: "production", branch: "production", paused: false })]);
    expect((await q("updates", { branch: "production", paginationOpts: { numItems: 25, cursor: null } })).page[0]).toMatchObject({ id: ids[0], platform: "ios", assets: 2, rolloutPercent: 100 });
    // Paused channels are counted by an index, not among the first 200 names.
    for (let i = 0; i < 201; i++) await t.mutation(m("setChannel"), { name: `a${String(i).padStart(3, "0")}`, branch: "production" });
    await t.mutation(m("setChannel"), { name: "zz", branch: "production" });
    await t.mutation(m("setChannelPaused"), { name: "zz", paused: true });
    expect(await q("overview")).toMatchObject({ channels: 203, paused: 1 });
    const detail = await q("update", { id: ids[0] });
    expect(detail.manifest).toMatchObject({ id: ids[0], launchAsset: { url: `/expoUpdates/assets?key=${hex("dash")}` } });
    expect(detail.assetList).toHaveLength(2);
  });
});
