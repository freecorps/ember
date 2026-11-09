/**
 * The config plugin's pure parts, and the Xcode project change on a real Expo SDK 58 `project.pbxproj` (fixture from
 * `expo prebuild` of apps/example-expo). End to end, `expo prebuild` with the plugin and `xcodebuild -target
 * EmberNotificationService` were run by hand on macOS (see the package README, "Verifying the extension").
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const require = createRequire(import.meta.url);
const plugin = require("../app.plugin.cjs");
const xcode = createRequire(require.resolve("@expo/config-plugins/package.json"))("xcode");

const config = () => ({ name: "Mail", slug: "mail", version: "2.3.0", ios: { bundleIdentifier: "com.acme.mail", buildNumber: "41", appleTeamId: "TEAM123456" } });

describe("ember-expo-push config plugin", () => {
  test("app.plugin.js (exported) is the same plugin, for resolvers that only look for it through Node (eas-cli)", async () => {
    const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8"));
    expect(pkg.exports["./app.plugin.js"]).toBe("./app.plugin.js");
    expect(pkg.files).toContain("app.plugin.js");
    const viaRequire = require("../app.plugin.js");
    expect(viaRequire.default ?? viaRequire).toBe(plugin);
    const entry = "../app.plugin.js";
    expect(((await import(entry)) as { default: unknown }).default).toBe(plugin);
  });

  test("aps-environment: development locally, production on EAS, overridable; invalid values refused", () => {
    expect(plugin.resolveApsEnvironment({}, {})).toBe("development");
    expect(plugin.resolveApsEnvironment({}, { EAS_BUILD: "true" })).toBe("production");
    expect(plugin.resolveApsEnvironment({}, { EAS_BUILD: "true", EMBER_APS_ENVIRONMENT: "development" })).toBe("development");
    expect(plugin.resolveApsEnvironment({ apsEnvironment: "production" }, {})).toBe("production");
    expect(() => plugin.resolveApsEnvironment({ apsEnvironment: "sandbox" }, {})).toThrow(/development/);
  });

  test("settings: App Group and extension bundle id from the app's bundle id; requires one", () => {
    expect(plugin.emberPushSettings(config(), {}, {})).toEqual({
      bundleId: "com.acme.mail",
      appGroup: "group.com.acme.mail.ember",
      extensionBundleId: "com.acme.mail.EmberNotificationService",
      apsEnvironment: "development",
      keychainService: "ember.push",
      keyName: "ember.push.keys.v1",
      deploymentTarget: "16.4",
      timeSensitive: true,
    });
    expect(plugin.emberPushSettings(config(), { appGroup: "group.com.acme.shared", timeSensitive: false }, {})).toMatchObject({ appGroup: "group.com.acme.shared", timeSensitive: false });
    expect(() => plugin.emberPushSettings({ ios: {} }, {}, {})).toThrow(/bundleIdentifier/);
  });

  test("app entitlements and config: merged, recorded for the runtime, extension declared to EAS once", () => {
    const s = plugin.emberPushSettings(config(), {}, { EAS_BUILD: "1" });
    expect(plugin.applyAppEntitlements({ "com.apple.security.application-groups": ["group.other"], "aps-environment": "development" }, s)).toEqual({
      "aps-environment": "production",
      "com.apple.security.application-groups": ["group.other", "group.com.acme.mail.ember"],
      "com.apple.developer.usernotifications.time-sensitive": true,
    });
    const c = plugin.applyAppConfig(plugin.applyAppConfig({ ...config(), extra: { eas: { projectId: "p" } } }, s), s);
    expect(c.extra.emberPush).toEqual({ apsEnvironment: "production", appGroup: "group.com.acme.mail.ember", keychainService: "ember.push", keyName: "ember.push.keys.v1" });
    expect(c.extra.eas.projectId).toBe("p");
    expect(c.extra.eas.build.experimental.ios.appExtensions).toEqual([
      { targetName: "EmberNotificationService", bundleIdentifier: "com.acme.mail.EmberNotificationService", entitlements: { "com.apple.security.application-groups": ["group.com.acme.mail.ember"] } },
    ]);
  });

  test("extension Info.plist and entitlements carry the NSExtension and where the key is", () => {
    const s = plugin.emberPushSettings(config(), {}, {});
    const info = plugin.extensionInfoPlist(s);
    expect(info).toContain("<string>com.apple.usernotifications.service</string>");
    expect(info).toContain("<string>$(PRODUCT_MODULE_NAME).NotificationService</string>");
    expect(info).toMatch(/<key>EmberPushAppGroup<\/key>\s*<string>group\.com\.acme\.mail\.ember<\/string>/);
    expect(plugin.extensionEntitlements(s)).toMatch(/application-groups<\/key>\s*<array>\s*<string>group\.com\.acme\.mail\.ember<\/string>/);
  });

  test("adds an embedded app-extension target to a real Expo project, once", () => {
    const project = xcode.project(resolve(__dirname, "fixtures/expo-sdk58.pbxproj"));
    project.parseSync();
    const s = plugin.emberPushSettings(config(), {}, {});
    plugin.addExtensionTarget(project, s, config());
    plugin.addExtensionTarget(project, s, config()); // idempotent
    const out: string = project.writeSync();
    expect((out.match(/isa = PBXNativeTarget;/g) ?? []).length).toBe(2);
    expect(out).toContain('productType = "com.apple.product-type.app-extension"');
    expect(out).toMatch(/EmberNotificationService\.appex in Copy Files/);
    expect(out).toMatch(/dstSubfolderSpec = 13;/); // PlugIns: embedded in the app
    expect(out).toMatch(/NotificationService\.swift in Sources/);
    expect(out).toMatch(/EmberPushCrypto\.swift in Sources/);
    expect(out).toContain("PRODUCT_BUNDLE_IDENTIFIER = com.acme.mail.EmberNotificationService;");
    expect(out).toContain("CODE_SIGN_ENTITLEMENTS = EmberNotificationService/EmberNotificationService.entitlements;");
    expect(out).toContain("IPHONEOS_DEPLOYMENT_TARGET = 16.4;");
    expect(out).toContain("MARKETING_VERSION = 2.3.0;");
    expect(out).toContain("CURRENT_PROJECT_VERSION = 41;");
    expect(out).toContain("DEVELOPMENT_TEAM = TEAM123456;");
    // The original fixture is untouched on disk and has one target.
    expect((readFileSync(resolve(__dirname, "fixtures/expo-sdk58.pbxproj"), "utf8").match(/isa = PBXNativeTarget;/g) ?? []).length).toBe(1);
  });
});
