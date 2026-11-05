/**
 * The iOS Notification Service Extension's crypto, compiled and run on macOS (CryptoKit HPKE is in macOS 14+ too):
 * envelopes sealed by the server (`@freecorps/ember-push`, WebCrypto) open in Swift with keys stored the way
 * `ensurePushKey` stores them. Also type-checks the whole extension against the iOS Simulator SDK. Skipped where
 * there is no Swift toolchain (Linux CI); runs on any Mac with Xcode.
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
