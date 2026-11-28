/**
 * The expo-updates component in workerd: the real runtime (Worker + Shard DO), assets in Miniflare's R2, the edge
 * cache in `caches.default`. Publishes go through the admin function runner, as `ember expo publish` does. Every
 * measured request runs with the Shard namespace wrapped so each stub and RPC is counted: a cache HIT must not reach
 * the Durable Object at all.
 */
import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { parseMultipart, parseSfvDictionary } from "../../src/index.ts";
import worker, { expoUpdatesProbes as probes } from "./worker.ts";

type Env = typeof env;
const enc = new TextEncoder();
const hex = async (s: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");

/** The test env with every Shard stub and RPC counted. */
function counting(): { env: Env; rpcs: () => number; stubs: () => number } {
  let rpcs = 0;
  let stubs = 0;
  const ns = env.SHARD;
  const SHARD = {
    idFromName: (x: string) => ns.idFromName(x),
    get: (id: DurableObjectId, o?: DurableObjectNamespaceGetDurableObjectOptions) => {
      stubs++;
      const s = ns.get(id, o) as unknown as Record<string, unknown>;
      return new Proxy(s, {
        get(t, p) {
          const v = Reflect.get(t, p);
          if (typeof v !== "function") return v;
          return (...a: unknown[]) => {
            rpcs++;
            return Reflect.apply(v as (...x: unknown[]) => unknown, t, a);
          };
        },
      });
    },
  };
  return { env: { ...env, SHARD } as unknown as Env, rpcs: () => rpcs, stubs: () => stubs };
}

async function call(url: string, init: RequestInit = {}, e: Env = env): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(url, init), e as never, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

async function admin(fn: string, args: unknown, host: string): Promise<any> {
  const res = await call(`${host}/api/_ember/run`, { method: "POST", headers: { authorization: `Bearer ${env.EMBER_ADMIN_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ fn, args, shard: "global:main" }) });
  const body = (await res.json()) as { ok: boolean; value?: unknown; error?: { code: string; message: string } };
  if (!body.ok) throw Object.assign(new Error(`${fn}: ${body.error?.message}`), { code: body.error?.code });
  return body.value;
}

/** What `ember expo publish` does: prepareAssets, PUT + confirm the new ones, publish. Returns the PUTs made. */
async function publish(host: string, install: string, o: { bundle: string; image?: string; rolloutPercent?: number; branch?: string }) {
  const files = [{ body: o.bundle, contentType: "application/javascript" }, ...(o.image ? [{ body: o.image, contentType: "image/png" }] : [])];
  const assets = await Promise.all(files.map(async (f) => ({ sha256: await hex(f.body), size: enc.encode(f.body).length, contentType: f.contentType })));
  const prepared = (await admin(`@${install}/lib:prepareAssets`, { assets }, host)) as Array<{ sha256: string; upload?: { url: string; headers: Record<string, string>; storageId: string; shard: string; token: string } }>;
  const bodies = new Map(assets.map((a, i) => [a.sha256, files[i]!.body]));
  let puts = 0;
  for (const p of prepared) {
    if (!p.upload) continue;
    const body = bodies.get(p.sha256);
    if (body === undefined) throw new Error(`prepareAssets returned an asset that was not asked for: ${p.sha256}`);
    const put = await call(p.upload.url.startsWith("http") ? p.upload.url : `${host}${p.upload.url}`, { method: "PUT", headers: p.upload.headers, body });
    expect(put.status).toBe(200);
    puts++;
    const c = await call(`${host}/api/storage/confirm`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ shard: p.upload.shard, storageId: p.upload.storageId, token: p.upload.token }) });
    expect(c.status).toBe(200);
  }
  const r = (await admin(
    `@${install}/lib:publish`,
    {
      branch: o.branch ?? "production",
      ...(o.rolloutPercent !== undefined ? { rolloutPercent: o.rolloutPercent } : {}),
      updates: [
        {
          platform: "ios",
          runtimeVersion: "1.0.0",
          launchAsset: { sha256: assets[0]!.sha256, key: "bundle", contentType: "application/javascript" },
          assets: assets.slice(1).map((a) => ({ sha256: a.sha256, key: `md5-${a.sha256.slice(0, 8)}`, contentType: "image/png", fileExtension: ".png" })),
        },
      ],
    },
    host,
  )) as { updates: Array<{ id: string }> };
  return { puts, id: r.updates[0]!.id };
}

type Asked = { status: number; cache: string | null; plan: string | null; kind: string; id?: string; manifest?: any; part?: { headers: Record<string, string>; body: string } };
async function ask(host: string, install: string, h: Record<string, string> = {}, e: Env = env): Promise<Asked> {
  const res = await call(`${host}/${install}/manifest`, { headers: { "expo-protocol-version": "1", "expo-platform": "ios", "expo-runtime-version": "1.0.0", accept: "multipart/mixed", "eas-client-id": "install-1", ...h } }, e);
  const base = { status: res.status, cache: res.headers.get("x-ember-cache"), plan: res.headers.get("x-ember-plan-cache") };
  if (res.status !== 200) return { ...base, kind: "none" };
  const [part] = parseMultipart(new TextDecoder().decode(await res.arrayBuffer()), res.headers.get("content-type")!);
  if (part!.name === "manifest") {
    const manifest = JSON.parse(part!.body);
    return { ...base, kind: "update", id: manifest.id, manifest, part: part! };
  }
  return { ...base, kind: JSON.parse(part!.body).type, part: part! };
}

async function verify(sigHeader: string, body: string): Promise<boolean> {
  const pem = env.EXPO_TEST_PUBLIC_KEY.replace(/-----[^-]+-----|\s/g, "");
  const key = await crypto.subtle.importKey("spki", Uint8Array.from(atob(pem), (c) => c.charCodeAt(0)), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const sig = parseSfvDictionary(sigHeader)!.get("sig") as string;
  return crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, Uint8Array.from(atob(sig), (c) => c.charCodeAt(0)), enc.encode(body));
}

describe("expo-updates in workerd", () => {
  it("publish → signed manifest → assets; the 2nd request is a HIT that reaches no Durable Object", async () => {
    const host = "http://hit.test";
    const first = await publish(host, "expoUpdates", { bundle: "bundle-v1", image: "png-1" });
    expect(first.puts).toBe(2);

    const signed = { "expo-expect-signature": 'sig, keyid="main", alg="rsa-v1_5-sha256"' };
    const miss = await ask(host, "expoUpdates", signed);
    expect(miss).toMatchObject({ status: 200, cache: "MISS", plan: "MISS", kind: "update", id: first.id });
    expect(await verify(miss.part!.headers["expo-signature"]!, miss.part!.body)).toBe(true);

    // N more opens from other installs (no rollout: one response for all): zero stubs, zero RPCs.
    const counted = counting();
    const renders = probes.renders;
    for (let i = 0; i < 50; i++) {
      const hit = await ask(host, "expoUpdates", { ...signed, "eas-client-id": `install-${i}` }, counted.env);
      expect(hit).toMatchObject({ status: 200, cache: "HIT", plan: "HIT", id: first.id });
      expect(hit.part!.body).toBe(miss.part!.body);
    }
    expect(counted.stubs()).toBe(0);
    expect(counted.rpcs()).toBe(0);
    expect(probes.renders).toBe(renders);
    // The client already on it: another response (noUpdateAvailable), rendered once, still no DO.
    expect(await ask(host, "expoUpdates", { "expo-current-update-id": first.id }, counted.env)).toMatchObject({ kind: "noUpdateAvailable", cache: "MISS", plan: "HIT" });
    expect(await ask(host, "expoUpdates", { "expo-current-update-id": first.id, "eas-client-id": "other" }, counted.env)).toMatchObject({ kind: "noUpdateAvailable", cache: "HIT" });
    expect(counted.rpcs()).toBe(0);

    // Assets: MISS reads the shard and R2 once; then HIT with no DO; immutable, right content type.
    const url = miss.manifest.launchAsset.url as string;
    expect(url).toBe(`${host}/expoUpdates/assets?key=${await hex("bundle-v1")}`);
    const a1 = await call(url);
    expect(a1.status).toBe(200);
    expect(a1.headers.get("x-ember-cache")).toBe("MISS");
    expect(await a1.text()).toBe("bundle-v1");
    const assetCount = counting();
    const a2 = await call(url, {}, assetCount.env);
    expect(a2.headers.get("x-ember-cache")).toBe("HIT");
    expect(a2.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(a2.headers.get("content-type")).toBe("application/javascript");
    expect(await a2.text()).toBe("bundle-v1");
    const img = await call(miss.manifest.assets[0].url);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(await img.text()).toBe("png-1");
    expect(assetCount.rpcs()).toBe(0);

    // Publishing the same image again uploads only the new bundle.
    expect((await publish(host, "expoUpdates", { bundle: "bundle-v2", image: "png-1" })).puts).toBe(1);
  });

  it("invalidation: publish, rollback and kill switch change the plan's version; edges see it after the plan TTL", async () => {
    const host = "http://inval.test";
    const v1 = await publish(host, "expoUpdates", { bundle: "inv-1" });
    expect(await ask(host, "expoUpdates")).toMatchObject({ cache: "MISS", id: v1.id });
    expect(await ask(host, "expoUpdates")).toMatchObject({ cache: "HIT", id: v1.id });
    const t0 = Date.now();
    // Only Date is faked: the plan's age is checked against its `x-ember-cached-at` stamp with Date.now() in the
    // Worker (same isolate), while the cache entry itself (max-age by the real clock) is still there.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(t0);
      const v2 = await publish(host, "expoUpdates", { bundle: "inv-2" });
      // Within the plan TTL (30 s) the edge still answers from its copy, without the DO.
      const counted = counting();
      expect(await ask(host, "expoUpdates", {}, counted.env)).toMatchObject({ cache: "HIT", plan: "HIT", id: v1.id });
      expect(counted.rpcs()).toBe(0);
      // Past it: one plan read, a new version, a new response.
      vi.setSystemTime(t0 + 31_000);
      expect(await ask(host, "expoUpdates", {}, counted.env)).toMatchObject({ cache: "MISS", plan: "MISS", id: v2.id });
      // The plan is one internal query: one RPC to the shard (`http:plan` reads channel, branches and heads inside it).
      expect(counted.rpcs()).toBe(1);
      expect(await ask(host, "expoUpdates", {}, counted.env)).toMatchObject({ cache: "HIT", plan: "HIT", id: v2.id });
      expect(counted.rpcs()).toBe(1);

      // Rollback: a republished v1 after the next plan read.
      await admin("@expoUpdates/lib:rollback", { branch: "production" }, host);
      vi.setSystemTime(t0 + 62_000);
      const rolled = await ask(host, "expoUpdates");
      expect(rolled).toMatchObject({ cache: "MISS", plan: "MISS", kind: "update" });
      expect(rolled.id).not.toBe(v1.id);
      expect(rolled.manifest.launchAsset.hash).toBe(btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode("inv-1"))))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));

      // Kill switch.
      await admin("@expoUpdates/lib:setChannelPaused", { name: "production", paused: true }, host);
      vi.setSystemTime(t0 + 93_000);
      expect(await ask(host, "expoUpdates")).toMatchObject({ cache: "MISS", kind: "noUpdateAvailable" });
      expect(await ask(host, "expoUpdates", { "eas-client-id": "x" })).toMatchObject({ cache: "HIT", kind: "noUpdateAvailable" });
      await admin("@expoUpdates/lib:setChannelPaused", { name: "production", paused: false }, host);
      vi.setSystemTime(t0 + 124_000);
      expect(await ask(host, "expoUpdates")).toMatchObject({ kind: "update", id: rolled.id });
    } finally {
      vi.useRealTimers();
    }
  });

  it("a short plan TTL (install config) picks up a publish in real time", async () => {
    const host = "http://fast.test";
    const v1 = await publish(host, "fast", { bundle: "fast-1" });
    expect(await ask(host, "fast")).toMatchObject({ id: v1.id, cache: "MISS" });
    const v2 = await publish(host, "fast", { bundle: "fast-2" });
    expect(await ask(host, "fast")).toMatchObject({ id: v1.id, cache: "HIT" });
    await new Promise((r) => setTimeout(r, 1100));
    expect(await ask(host, "fast")).toMatchObject({ id: v2.id, plan: "MISS", cache: "MISS" });
  });

  it("a rollout: one plan read and one response per side for 200 installs; the key holds the side, not the install", async () => {
    const host = "http://rollout.test";
    const v1 = await publish(host, "expoUpdates", { bundle: "ro-1", branch: "ro" });
    const v2 = await publish(host, "expoUpdates", { bundle: "ro-2", branch: "ro", rolloutPercent: 30 });
    const counted = counting();
    const renders = probes.renders;
    const got: Asked[] = [];
    for (let i = 0; i < 200; i++) got.push(await ask(host, "expoUpdates", { "expo-channel-name": "ro", "eas-client-id": `dev-${i}` }, counted.env));
    expect(counted.rpcs()).toBe(1);
    expect(probes.renders - renders).toBe(2);
    const share = got.filter((g) => g.id === v2.id).length / got.length;
    expect(share).toBeGreaterThan(0.2);
    expect(share).toBeLessThan(0.4);
    expect(got.every((g) => g.id === v1.id || g.id === v2.id)).toBe(true);
    expect(got.filter((g) => g.cache === "MISS")).toHaveLength(2);
  });

  it("a rotated signing key (same key id) never gets a response signed by the old one", async () => {
    const host = "http://rotate.test";
    await publish(host, "expoUpdates", { bundle: "rot-1" });
    const signed = { "expo-expect-signature": 'sig, keyid="main"' };
    const before = await ask(host, "expoUpdates", signed);
    expect(before).toMatchObject({ cache: "MISS", kind: "update" });
    expect(await ask(host, "expoUpdates", signed)).toMatchObject({ cache: "HIT" });
    const pair = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
    const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----\n`;
    const rotated = { ...env, EXPO_UPDATES_PRIVATE_KEY: pem } as Env;
    const after = await ask(host, "expoUpdates", signed, rotated);
    expect(after).toMatchObject({ cache: "MISS", plan: "HIT", kind: "update", id: before.id });
    const sig = parseSfvDictionary(after.part!.headers["expo-signature"]!)!.get("sig") as string;
    expect(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", pair.publicKey, Uint8Array.from(atob(sig), (c) => c.charCodeAt(0)), enc.encode(after.part!.body))).toBe(true);
    expect(await ask(host, "expoUpdates", signed, rotated)).toMatchObject({ cache: "HIT" });
    // Unsigned requests share one response whatever the key.
    expect(await ask(host, "expoUpdates", {}, rotated)).toMatchObject({ cache: "MISS" });
    expect(await ask(host, "expoUpdates", {})).toMatchObject({ cache: "HIT" });
  });

  it("cache: false reads the shard and renders on every request", async () => {
    const host = "http://nocache.test";
    const v1 = await publish(host, "nocache", { bundle: "nc-1" });
    const renders = probes.renders;
    for (let i = 0; i < 2; i++) expect(await ask(host, "nocache")).toMatchObject({ status: 200, cache: "MISS", plan: "MISS", id: v1.id });
    expect(probes.renders - renders).toBe(2);
    // The assets too: from storage every time, never an edge entry.
    const url = (await ask(host, "nocache")).manifest.launchAsset.url as string;
    const fetches = probes.assetFetches;
    for (let i = 0; i < 2; i++) {
      const a = await call(url);
      expect([a.status, a.headers.get("x-ember-cache"), await a.text()]).toEqual([200, "MISS", "nc-1"]);
    }
    expect(probes.assetFetches - fetches).toBe(2);
  });

  it("the JSON form through the Worker: the manifest alone, the signature as a header, 204 and 406", async () => {
    const host = "http://json.test";
    const v1 = await publish(host, "expoUpdates", { bundle: "json-1", branch: "json" });
    const get = (h: Record<string, string>) =>
      call(`${host}/expoUpdates/manifest`, { headers: { "expo-protocol-version": "1", "expo-platform": "ios", "expo-runtime-version": "1.0.0", "expo-channel-name": "json", accept: "application/json", ...h } });
    const res = await get({ "expo-expect-signature": "sig" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    const body = await res.text();
    expect(JSON.parse(body).id).toBe(v1.id);
    expect(await verify(res.headers.get("expo-signature")!, body)).toBe(true);
    // A separate response from multipart (the key holds the media type), and an exact JSON media type is honoured.
    expect((await get({ accept: "application/expo+json" })).headers.get("content-type")).toBe("application/expo+json; charset=utf-8");
    expect((await get({ "expo-current-update-id": v1.id })).status).toBe(204);
    // A rollback cannot be said in JSON: 406 (another branch, so no cached plan is in the way).
    await publish(host, "expoUpdates", { bundle: "json-2", branch: "json2" });
    await admin("@expoUpdates/lib:rollback", { branch: "json2", toEmbedded: true }, host);
    expect((await get({ "expo-channel-name": "json2" })).status).toBe(406);
  });

  it("protocol errors and an unsigned install", async () => {
    const host = "http://err.test";
    expect((await ask(host, "expoUpdates", { "expo-platform": "web" })).status).toBe(400);
    expect((await ask(host, "expoUpdates", { "expo-protocol-version": "3" })).status).toBe(406);
    // No channel published: noUpdateAvailable (protocol 1), 204 (protocol 0).
    expect((await ask(host, "expoUpdates", { "expo-channel-name": "nothing" })).kind).toBe("noUpdateAvailable");
    expect((await ask(host, "expoUpdates", { "expo-channel-name": "nothing", "expo-protocol-version": "0" })).status).toBe(204);
    expect((await call(`${host}/expoUpdates/assets?key=xyz`)).status).toBe(400);
    expect((await call(`${host}/expoUpdates/assets?key=${"0".repeat(64)}`)).status).toBe(404);
  });
});
