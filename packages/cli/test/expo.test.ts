// `ember expo publish|rollback|rollout|kill|resume|channel|list` against a fake API: the real expo-updates component
// on the engine (`emberTest({ app })`) behind `POST /api/_ember/run` and the storage endpoints, with every PUT counted
// (dedup by SHA-256), from a fixture shaped like `npx expo export`'s output.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineApp, defineSchema, unsafeRef } from "@freecorps/ember-server";
import { expoUpdates, parseMultipart } from "@freecorps/ember-expo-updates";
import { emberTest } from "@freecorps/ember-testing";
import { afterAll, describe, expect, test } from "vitest";
import type { Project } from "../src/config.ts";
import { contentTypeOf, expoChannel, expoInstall, expoList, expoPause, expoPublish, expoRollback, expoRollout, readExpoExport, runtimeVersionOf, type ExpoOptions } from "../src/expo.ts";
import { TMP } from "./helpers.ts";

mkdirSync(TMP, { recursive: true });
const root = mkdtempSync(join(TMP, "expo-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const md5 = (s: string) => createHash("md5").update(s).digest("hex");

/** A `dist/` as `npx expo export` writes it (+ `expoConfig.json` from `npx expo config --json --type public`). */
function fixture(name: string, o: { ios: string; android: string; image: string }) {
  const dist = join(root, name);
  mkdirSync(join(dist, "_expo/static/js/ios"), { recursive: true });
  mkdirSync(join(dist, "_expo/static/js/android"), { recursive: true });
  mkdirSync(join(dist, "assets"), { recursive: true });
  writeFileSync(join(dist, "_expo/static/js/ios/index-1.hbc"), o.ios);
  writeFileSync(join(dist, "_expo/static/js/android/index-2.hbc"), o.android);
  writeFileSync(join(dist, "assets", md5(o.image)), o.image);
  writeFileSync(
    join(dist, "metadata.json"),
    JSON.stringify({
      version: 0,
      bundler: "metro",
      fileMetadata: {
        ios: { bundle: "_expo/static/js/ios/index-1.hbc", assets: [{ path: `assets/${md5(o.image)}`, ext: "png" }] },
        android: { bundle: "_expo/static/js/android/index-2.hbc", assets: [{ path: `assets/${md5(o.image)}`, ext: "png" }] },
      },
    }),
  );
  writeFileSync(join(dist, "expoConfig.json"), JSON.stringify({ name: "Fixture", slug: "fixture", version: "1.2.0", runtimeVersion: { policy: "appVersion" } }));
  return dist;
}

function fakeApi() {
  const t = emberTest({ schema: defineSchema({ tables: {} }), modules: {}, app: defineApp().use(expoUpdates) });
  const counts = { puts: 0, runs: 0 };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname + url.search;
    if (url.pathname === "/api/_ember/run") {
      if (new Headers(init?.headers).get("authorization") !== "Bearer admin") return new Response(JSON.stringify({ ok: false, error: { code: "forbidden", message: "bad token" } }), { status: 403 });
      counts.runs++;
      const { fn, args } = JSON.parse(String(init!.body)) as { fn: string; args: Record<string, unknown> };
      try {
        const value = fn.endsWith(":list") ? await t.query(unsafeRef<"query">(fn), args) : await t.mutation(unsafeRef<"mutation">(fn), args);
        return new Response(JSON.stringify({ ok: true, value }), { headers: { "content-type": "application/json" } });
      } catch (e) {
        const err = e as { code?: string; message: string };
        return new Response(JSON.stringify({ ok: false, error: { code: err.code ?? "Error", message: err.message } }), { status: 400 });
      }
    }
    if (url.pathname === "/api/storage/put") counts.puts++;
    return t.fetch(path, init);
  }) as typeof fetch;
  const lines: string[] = [];
  const o: ExpoOptions = { url: "http://localhost:8787", adminToken: "admin", component: "expoUpdates", fetch: fetchImpl, log: (l) => lines.push(l) };
  const ask = async (platform: "ios" | "android", h: Record<string, string> = {}) => {
    const res = await t.fetch("/expoUpdates/manifest", { headers: { "expo-protocol-version": "1", "expo-platform": platform, "expo-runtime-version": "1.2.0", "expo-channel-name": "production", "eas-client-id": "dev-1", ...h } });
    const [part] = parseMultipart(await res.text(), res.headers.get("content-type")!);
    return { name: part!.name, body: JSON.parse(part!.body) };
  };
  return { t, o, counts, lines, ask };
}

describe("reading an expo export", () => {
  test("bundles, assets, keys (MD5) and content addresses (SHA-256); runtime version from the config's policy", () => {
    const dist = fixture("read", { ios: "ios-bundle", android: "android-bundle", image: "PNG" });
    const exp = readExpoExport(dist);
    expect(exp.platforms.map((p) => [p.platform, p.runtimeVersion, p.bundle.contentType, p.bundle.md5])).toEqual([
      ["ios", "1.2.0", "application/javascript", md5("ios-bundle")],
      ["android", "1.2.0", "application/javascript", md5("android-bundle")],
    ]);
    expect(exp.platforms[0]!.assets[0]).toMatchObject({ md5: md5("PNG"), sha256: createHash("sha256").update("PNG").digest("hex"), contentType: "image/png", fileExtension: ".png", size: 3 });
    expect(readExpoExport(dist, { platforms: ["android"], runtimeVersion: "7" }).platforms.map((p) => [p.platform, p.runtimeVersion])).toEqual([["android", "7"]]);
    expect(() => readExpoExport(join(root, "missing"))).toThrow(/npx expo export/);
    expect(runtimeVersionOf("ios", { runtimeVersion: "3.0" })).toBe("3.0");
    expect(runtimeVersionOf("android", { version: "2.0", android: { versionCode: 12 }, runtimeVersion: { policy: "nativeVersion" } })).toBe("2.0(12)");
    expect(runtimeVersionOf("ios", { sdkVersion: "55.0.0", runtimeVersion: { policy: "sdkVersion" } })).toBe("exposdk:55.0.0");
    expect(() => runtimeVersionOf("ios", { runtimeVersion: { policy: "fingerprint" } })).toThrow(/--runtime-version/);
    expect(contentTypeOf("TTF")).toBe("font/ttf");
    expect(contentTypeOf("weird")).toBe("application/octet-stream");
  });

  test("the install name comes from the manifest, or --component", () => {
    const dir = join(root, "proj/_generated");
    mkdirSync(dir, { recursive: true });
    const project = { generatedDir: dir } as Project;
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ schema: { components: { updates: { component: "expoUpdates" }, rl: { component: "rateLimit" } } } }));
    expect(expoInstall({ project })).toBe("updates");
    expect(expoInstall({ project, component: "other" })).toBe("other");
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ schema: { components: {} } }));
    expect(() => expoInstall({ project })).toThrow(/not installed/);
  });
});

describe("ember expo", () => {
  test("publish uploads only what the project lacks; the manifest serves the export's keys", async () => {
    const api = fakeApi();
    const dist = fixture("v1", { ios: "ios-v1", android: "android-v1", image: "IMG" });
    const r1 = await expoPublish(api.o, { dir: dist, branch: "production", message: "first" });
    // Two bundles and one image shared by both platforms: three PUTs.
    expect(r1).toMatchObject({ branch: "production", rolloutPercent: 100, assets: 3, uploaded: 3 });
    expect(api.counts.puts).toBe(3);
    expect(r1.updates.map((u) => [u.platform, u.runtimeVersion])).toEqual([["ios", "1.2.0"], ["android", "1.2.0"]]);
    expect(api.lines.join("\n")).toMatch(/assets: 3, uploaded 3 .* already there 0/);

    const m = await api.ask("ios");
    expect(m.name).toBe("manifest");
    expect(m.body).toMatchObject({ id: r1.updates[0]!.id, runtimeVersion: "1.2.0", launchAsset: { key: md5("ios-v1"), contentType: "application/javascript" }, assets: [{ key: md5("IMG"), contentType: "image/png", fileExtension: ".png" }], extra: { expoClient: { name: "Fixture" } } });
    expect(await (await api.t.fetch(m.body.assets[0].url)).text()).toBe("IMG");

    // The same export again: nothing uploaded. A new iOS bundle only: one PUT.
    expect((await expoPublish(api.o, { dir: dist, branch: "production" })).uploaded).toBe(0);
    expect(api.counts.puts).toBe(3);
    const v2 = fixture("v2", { ios: "ios-v2", android: "android-v1", image: "IMG" });
    const r2 = await expoPublish(api.o, { dir: v2, branch: "production", rollout: 40 });
    expect(r2).toMatchObject({ uploaded: 1, rolloutPercent: 40 });
    expect(api.counts.puts).toBe(4);

    // Rollout to 100, then roll back: clients get the previous bundle as a new update.
    expect(await expoRollout(api.o, { branch: "production", platform: "ios", percent: 100 })).toMatchObject([{ platform: "ios", from: 40, to: 100 }]);
    await expoRollout(api.o, { branch: "production", platform: "android", percent: 100 });
    expect((await api.ask("ios")).body.id).toBe(r2.updates[0]!.id);
    const rb = await expoRollback(api.o, { branch: "production", platform: "ios" });
    expect(rb).toMatchObject([{ platform: "ios", rolledBack: r2.updates[0]!.id, kind: "update" }]);
    const after = await api.ask("ios");
    expect(after.body.launchAsset.key).toBe(md5("ios-v1"));
    expect(after.body.id).toBe(rb[0]!.now);
    await expoRollback(api.o, { branch: "production", platform: "ios", toEmbedded: true });
    expect((await api.ask("ios")).body).toMatchObject({ type: "rollBackToEmbedded" });

    // Kill switch and resume, by channel and by branch.
    await expoPause(api.o, { channel: "production", paused: true });
    expect((await api.ask("android")).body).toEqual({ type: "noUpdateAvailable" });
    await expoPause(api.o, { channel: "production", paused: false });
    await expoPause(api.o, { branch: "production", paused: true });
    expect((await api.ask("android")).body).toEqual({ type: "noUpdateAvailable" });
    await expoPause(api.o, { branch: "production", paused: false });
    expect((await api.ask("android")).name).toBe("manifest");
    await expect(expoPause(api.o, { paused: true })).rejects.toThrow(/--channel <name> or --branch <name>/);

    // A second channel on a branch with a rollout share, and the listing.
    await expoPublish(api.o, { dir: v2, branch: "beta", platforms: ["android"] });
    await expoChannel(api.o, { name: "production", branch: "production", rolloutBranch: "beta", rolloutPercent: 10 });
    const list = await expoList(api.o);
    expect(list.channels).toEqual(expect.arrayContaining([expect.objectContaining({ name: "production", branch: "production", rolloutBranch: "beta", rolloutPercent: 10, paused: false }), expect.objectContaining({ name: "beta", branch: "beta" })]));
    expect(list.branches.map((b) => b.name).sort()).toEqual(["beta", "production"]);
    await expoChannel(api.o, { name: "production", branch: "production", rolloutBranch: null });
    expect((await expoList(api.o)).channels.find((c) => c.name === "production")).not.toHaveProperty("rolloutBranch");
  });

  test("errors from the component reach the command", async () => {
    const api = fakeApi();
    const dist = fixture("err", { ios: "e-ios", android: "e-android", image: "E" });
    await expoPublish(api.o, { dir: dist, branch: "production", rollout: 10 });
    await expect(expoPublish(api.o, { dir: fixture("err2", { ios: "e2", android: "e2a", image: "E" }), branch: "production" })).rejects.toThrow(/RolloutInProgress/);
    await expect(expoRollout(api.o, { branch: "nope", percent: 5 })).rejects.toThrow(/NotInRollout/);
    await expect(expoPublish(api.o, { dir: dist, branch: "production", rollout: 101 })).rejects.toThrow(/0\.\.100/);
    await expect(expoList({ ...api.o, adminToken: "wrong" })).rejects.toThrow(/refused the token/);
  });
});
