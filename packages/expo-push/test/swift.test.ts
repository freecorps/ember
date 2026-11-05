/**
 * The iOS Notification Service Extension's crypto, compiled and run on macOS (CryptoKit HPKE is in macOS 14+ too):
 * envelopes sealed by the server (`@freecorps/ember-push`, WebCrypto) open in Swift with keys stored the way
 * `ensurePushKey` stores them. Also type-checks the whole extension against the iOS Simulator SDK, and, in a booted
 * iOS Simulator, reads the key back from a keychain item written exactly the way expo-secure-store writes it. Skipped
 * where there is no Swift toolchain (Linux CI); runs on any Mac with Xcode.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sealPushContent } from "@freecorps/ember-push";
import { afterAll, describe, expect, test } from "vitest";
import { generatePushKeyPair, pushKeyId, toBase64url } from "../src/index.ts";

const NSE = resolve(__dirname, "../ios/EmberNotificationService");
const hasSwift = process.platform === "darwin" && spawnSync("xcrun", ["--find", "swiftc"]).status === 0;
const hasIosSdk = hasSwift && spawnSync("xcrun", ["--sdk", "iphonesimulator", "--show-sdk-path"]).status === 0;
const dir = mkdtempSync(join(tmpdir(), "ember-nse-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const bootedSimulator = (): string | undefined => {
  const r = spawnSync("xcrun", ["simctl", "list", "devices", "booted", "-j"], { encoding: "utf8" });
  if (r.status !== 0) return undefined;
  const devices = Object.entries(JSON.parse(r.stdout).devices as Record<string, Array<{ udid: string; state: string }>>);
  return devices.filter(([runtime]) => runtime.includes("iOS")).flatMap(([, d]) => d).find((d) => d.state === "Booted")?.udid;
};

describe.skipIf(!hasSwift)("NSE crypto in Swift (CryptoKit) opens what the server seals", () => {
  test("content, unicode, data, key rotation, foreign keys and tampering", async () => {
    const current = generatePushKeyPair(random);
    const previous = generatePushKeyPair(random);
    const stranger = generatePushKeyPair(random);
    const stored = JSON.stringify({ v: 1, keys: [current, previous].map((k) => ({ d: toBase64url(k.privateKey), pub: toBase64url(k.publicKey) })) });
    const seal = (k: typeof current, c: Parameters<typeof sealPushContent>[1]) => sealPushContent(toBase64url(k.publicKey), c, { now: 1_700_000_000_000 });
    const full = await seal(current, { title: "Ana Souza", subtitle: "Re: orçamento 2026", body: "Segue em anexo ✓ — São Paulo", data: { messageId: "m-42", n: 3 } });
    const toOld = await seal(previous, { body: "sealed before the rotation" });
    const foreign = await seal(stranger, { body: "not for this phone" });
    const tampered = { ...full, ct: full.ct.slice(0, -2) + (full.ct.endsWith("A") ? "BA" : "AA") };
    const fixture = {
      keys: stored,
      cases: [
        { userInfo: { aps: {}, ember: full } },
        { userInfo: { ember: JSON.stringify(toOld) } },
        { userInfo: { ember: foreign } },
        { userInfo: { ember: tampered } },
        { userInfo: { ember: { ...full, v: 2 } } },
        { userInfo: { aps: { alert: "plain" } } },
      ],
    };
    writeFileSync(join(dir, "fixture.json"), JSON.stringify(fixture));
    const bin = join(dir, "nse-test");
    const build = spawnSync("xcrun", ["swiftc", "-O", "-target", "arm64-apple-macos14.0", join(NSE, "EmberPushCrypto.swift"), resolve(__dirname, "swift/main.swift"), "-o", bin], { encoding: "utf8" });
    expect(build.status, build.stderr).toBe(0);
    const run = spawnSync(bin, [join(dir, "fixture.json")], { encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
    const results = JSON.parse(run.stdout);
    expect(results).toEqual([
      { title: "Ana Souza", subtitle: "Re: orçamento 2026", body: "Segue em anexo ✓ — São Paulo", data: { messageId: "m-42", n: 3 }, iat: 1_700_000_000, keyId: pushKeyId(current.publicKey) },
      { body: "sealed before the rotation", iat: 1_700_000_000, keyId: pushKeyId(current.publicKey) },
      { error: "notOpened" },
      { error: "notOpened" },
      { error: "malformedEnvelope" },
      { error: "noEnvelope" },
    ]);
  }, 120_000);

  // The account attribute must match byte for byte what expo-secure-store writes (UTF-8 Data). Only the iOS keychain
  // (SecDb) can check that: the macOS file keychain drops a Data account and matches any. So this spawns the driver
  // in a booted iOS Simulator (or EMBER_TEST_SIMULATOR=<udid>), ad-hoc signed with the App Group, the only
  // entitlement the extension has too. Writer and reader are separate processes, like the app and the NSE.
  test.skipIf(!hasIosSdk)("reads the device key from the keychain item expo-secure-store writes (iOS Simulator)", (ctx) => {
    const sim = process.env.EMBER_TEST_SIMULATOR ?? bootedSimulator();
    if (!sim) return ctx.skip("no booted iOS Simulator (boot one or set EMBER_TEST_SIMULATOR=<udid>)");
    const group = "group.dev.freecorps.ember.test";
    const entitlements = join(dir, "keychain.entitlements");
    writeFileSync(entitlements, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>com.apple.security.application-groups</key><array><string>${group}</string></array></dict></plist>`);
    const bin = join(dir, "nse-keychain");
    const build = spawnSync("xcrun", ["--sdk", "iphonesimulator", "swiftc", "-target", "arm64-apple-ios17.0-simulator", join(NSE, "EmberPushCrypto.swift"), resolve(__dirname, "swift/keychain/main.swift"), "-o", bin], { encoding: "utf8" });
    expect(build.status, build.stderr).toBe(0);
    const sign = spawnSync("codesign", ["-s", "-", "-f", "--entitlements", entitlements, bin], { encoding: "utf8" });
    expect(sign.status, sign.stderr).toBe(0);
    // A loaded machine's simulators can be slow or wedged: a spawn that does not answer skips, it does not fail.
    const kc = (...a: string[]) => {
      const r = spawnSync("xcrun", ["simctl", "spawn", sim, bin, ...a], { encoding: "utf8", timeout: 90_000 });
      if (r.error || r.signal) ctx.skip(`iOS Simulator ${sim} did not answer: ${r.error?.message ?? r.signal}`);
      expect(r.status, `${a[0]}: ${r.stdout}${r.stderr}`).toBe(0);
      return r.stdout.trim();
    };
    const service = `ember.push.test.${crypto.randomUUID()}`;
    const key = "ember.push.keys.v1";
    const value = JSON.stringify({ v: 1, keys: [{ d: "ZA", pub: "cHVi" }] });
    const none = { current: null, legacy: null, otherAccount: null, prefixAccount: null, otherService: null };
    let written = false;
    try {
      expect(kc("write", service, key, value, group)).toBe("ok");
      written = true;
      expect(JSON.parse(kc("read", service, key, group))).toEqual({ ...none, current: value, legacy: `${value} legacy` });
      expect(JSON.parse(kc("delete", service, key, group))).toEqual(none);
      written = false;
    } finally {
      if (written) spawnSync("xcrun", ["simctl", "spawn", sim, bin, "delete", service, key, group], { timeout: 90_000 });
    }
  }, 400_000);

  test.skipIf(!hasIosSdk)("the extension type-checks for iOS (Simulator SDK)", () => {
    const sdk = spawnSync("xcrun", ["--sdk", "iphonesimulator", "--show-sdk-path"], { encoding: "utf8" }).stdout.trim();
    const r = spawnSync(
      "xcrun",
      ["swiftc", "-typecheck", "-sdk", sdk, "-target", "arm64-apple-ios16.4-simulator", "-application-extension", join(NSE, "EmberPushCrypto.swift"), join(NSE, "NotificationService.swift")],
      { encoding: "utf8" },
    );
    expect(r.status, r.stderr).toBe(0);
  }, 120_000);
});
