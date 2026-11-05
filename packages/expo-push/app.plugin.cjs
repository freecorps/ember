// @ts-check
/**
 * Expo config plugin for Ember's end-to-end encrypted pushes (`plugins: ["@freecorps/ember-expo-push"]` or
 * `["@freecorps/ember-expo-push", { appGroup, apsEnvironment, timeSensitive, deploymentTarget }]`).
 *
 * iOS (written for Ember from Apple's and Expo's documentation; same arrangement Freecorps Brigade verified on a real
 * iPhone in its spike S1):
 * - an `EmberNotificationService` Notification Service Extension target (bundle id `<app>.EmberNotificationService`)
 *   built from this package's `ios/EmberNotificationService/*.swift`, embedded in the app, iOS 16.4+ (decrypts on
 *   iOS 17+, shows the fallback text below);
 * - the App Group `group.<bundle id>.ember` on both targets: the device key is stored in its keychain access group so
 *   the extension can read it (`ensurePushKey`);
 * - `aps-environment`: `development` for local builds, `production` when `EAS_BUILD` is set (EAS builds are ad hoc or
 *   App Store signed); `EMBER_APS_ENVIRONMENT` or the `apsEnvironment` option override it. Recorded in
 *   `extra.emberPush.apsEnvironment` so the app registers its tokens with the right environment (`pushEnvironment()`
 *   in @freecorps/ember-react-native);
 * - `com.apple.developer.usernotifications.time-sensitive` (urgency `high`) unless `timeSensitive: false`;
 * - the extension declared to EAS Build (`extra.eas.build.experimental.ios.appExtensions`) so EAS signs it.
 *
 * Android needs nothing from this plugin: sealed pushes are data-only FCM messages the app decrypts in a background
 * task (`defineEmberPushTask`). Set `android.googleServicesFile` for FCM as usual.
 */
const fs = require("fs");
const path = require("path");

/** @returns {any} */
function configPlugins() {
  try {
    return require("expo/config-plugins");
  } catch {
    return require("@expo/config-plugins");
  }
}

const TARGET = "EmberNotificationService";
const SWIFT_FILES = ["NotificationService.swift", "EmberPushCrypto.swift"];
const DEFAULTS = { keychainService: "ember.push", keyName: "ember.push.keys.v1", deploymentTarget: "16.4", timeSensitive: true };

/**
 * @typedef {{ appGroup?: string; apsEnvironment?: "development" | "production"; timeSensitive?: boolean;
 *   deploymentTarget?: string; keychainService?: string; keyName?: string; extensionBundleIdentifier?: string }} EmberPushPluginProps
 */

/** @param {EmberPushPluginProps} props @param {Record<string, string | undefined>} env */
function resolveApsEnvironment(props = {}, env = process.env) {
  const v = props.apsEnvironment ?? env.EMBER_APS_ENVIRONMENT ?? (env.EAS_BUILD ? "production" : "development");
  if (v !== "development" && v !== "production") throw new Error(`@freecorps/ember-expo-push: apsEnvironment must be "development" or "production", got ${JSON.stringify(v)}`);
  return v;
}

/** @param {any} config @param {EmberPushPluginProps} props @param {Record<string, string | undefined>} env */
function emberPushSettings(config, props = {}, env = process.env) {
  const bundleId = config.ios?.bundleIdentifier;
  if (!bundleId) throw new Error("@freecorps/ember-expo-push: set ios.bundleIdentifier in the app config");
  return {
    bundleId,
    appGroup: props.appGroup ?? `group.${bundleId}.ember`,
    extensionBundleId: props.extensionBundleIdentifier ?? `${bundleId}.${TARGET}`,
    apsEnvironment: resolveApsEnvironment(props, env),
    keychainService: props.keychainService ?? DEFAULTS.keychainService,
    keyName: props.keyName ?? DEFAULTS.keyName,
    deploymentTarget: props.deploymentTarget ?? DEFAULTS.deploymentTarget,
    timeSensitive: props.timeSensitive ?? DEFAULTS.timeSensitive,
  };
}

/** @param {unknown} v @param {string} indent @returns {string} */
function plistValue(v, indent) {
  const esc = (/** @type {string} */ s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  if (Array.isArray(v)) return `<array>\n${v.map((x) => `${indent}\t${plistValue(x, indent + "\t")}`).join("\n")}\n${indent}</array>`;
  if (typeof v === "boolean") return v ? "<true/>" : "<false/>";
  if (v && typeof v === "object") {
    const lines = Object.entries(v).map(([k, x]) => `${indent}\t<key>${esc(k)}</key>\n${indent}\t${plistValue(x, indent + "\t")}`);
    return `<dict>\n${lines.join("\n")}\n${indent}</dict>`;
  }
  return `<string>${esc(String(v))}</string>`;
}

/** @param {Record<string, unknown>} dict */
function plist(dict) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n${plistValue(dict, "")}\n</plist>\n`;
}

/** The extension's Info.plist: NSExtension + where the device key is (read by NotificationService.swift). */
function extensionInfoPlist(/** @type {ReturnType<typeof emberPushSettings>} */ s) {
  return plist({
    CFBundleDevelopmentRegion: "$(DEVELOPMENT_LANGUAGE)",
    CFBundleDisplayName: TARGET,
    CFBundleExecutable: "$(EXECUTABLE_NAME)",
    CFBundleIdentifier: "$(PRODUCT_BUNDLE_IDENTIFIER)",
    CFBundleInfoDictionaryVersion: "6.0",
    CFBundleName: "$(PRODUCT_NAME)",
    CFBundlePackageType: "$(PRODUCT_BUNDLE_PACKAGE_TYPE)",
    CFBundleShortVersionString: "$(MARKETING_VERSION)",
    CFBundleVersion: "$(CURRENT_PROJECT_VERSION)",
    NSExtension: { NSExtensionPointIdentifier: "com.apple.usernotifications.service", NSExtensionPrincipalClass: "$(PRODUCT_MODULE_NAME).NotificationService" },
    EmberPushAppGroup: s.appGroup,
    EmberPushKeychainService: s.keychainService,
    EmberPushKeyName: s.keyName,
  });
}

function extensionEntitlements(/** @type {ReturnType<typeof emberPushSettings>} */ s) {
  return plist({ "com.apple.security.application-groups": [s.appGroup] });
}

/** Adds the app's entitlements (pure: for tests). */
function applyAppEntitlements(/** @type {Record<string, any>} */ ent, /** @type {ReturnType<typeof emberPushSettings>} */ s) {
  ent["aps-environment"] = s.apsEnvironment;
  const groups = new Set([...(ent["com.apple.security.application-groups"] ?? []), s.appGroup]);
  ent["com.apple.security.application-groups"] = [...groups];
  if (s.timeSensitive) ent["com.apple.developer.usernotifications.time-sensitive"] = true;
  return ent;
}

/** Records the settings for the app (expo-constants) and declares the extension to EAS (pure: for tests). */
function applyAppConfig(/** @type {any} */ config, /** @type {ReturnType<typeof emberPushSettings>} */ s) {
  config.extra = config.extra ?? {};
  config.extra.emberPush = { apsEnvironment: s.apsEnvironment, appGroup: s.appGroup, keychainService: s.keychainService, keyName: s.keyName };
  const eas = (config.extra.eas = config.extra.eas ?? {});
  const build = (eas.build = eas.build ?? {});
  const exp = (build.experimental = build.experimental ?? {});
  const ios = (exp.ios = exp.ios ?? {});
  const list = (ios.appExtensions = (ios.appExtensions ?? []).filter((/** @type {any} */ e) => e.targetName !== TARGET));
  list.push({ targetName: TARGET, bundleIdentifier: s.extensionBundleId, entitlements: { "com.apple.security.application-groups": [s.appGroup] } });
  return config;
}

/**
 * Adds the extension target to the Xcode project (idempotent): group with the sources, Info.plist and entitlements;
 * an `app_extension` target embedded in the app (the xcode library adds the copy phase and the dependency); Sources,
 * Resources and Frameworks phases; build settings.
 */
function addExtensionTarget(/** @type {any} */ project, /** @type {ReturnType<typeof emberPushSettings>} */ s, /** @type {any} */ config) {
  // `addTarget` stores the name quoted until the project is written and parsed again: match both forms.
  const targets = project.pbxNativeTargetSection();
  if (Object.values(targets).some((/** @type {any} */ t) => typeof t === "object" && (t.name === TARGET || t.name === `"${TARGET}"`))) return project;
  const objects = project.hash.project.objects;
  objects.PBXTargetDependency = objects.PBXTargetDependency ?? {};
  objects.PBXContainerItemProxy = objects.PBXContainerItemProxy ?? {};

  const files = [...SWIFT_FILES, "Info.plist", `${TARGET}.entitlements`];
  const group = project.addPbxGroup(files, TARGET, TARGET);
  const mainGroup = project.getFirstProject().firstProject.mainGroup;
  project.addToPbxGroup(group.uuid, mainGroup);

  const target = project.addTarget(TARGET, "app_extension", TARGET, s.extensionBundleId);
  project.addBuildPhase(SWIFT_FILES, "PBXSourcesBuildPhase", "Sources", target.uuid);
  project.addBuildPhase([], "PBXResourcesBuildPhase", "Resources", target.uuid);
  project.addBuildPhase([], "PBXFrameworksBuildPhase", "Frameworks", target.uuid);

  const configs = project.pbxXCBuildConfigurationSection();
  const listId = target.pbxNativeTarget.buildConfigurationList;
  const list = project.pbxXCConfigurationList()[listId];
  const ids = new Set((list?.buildConfigurations ?? []).map((/** @type {any} */ c) => c.value));
  for (const id of ids) {
    const bs = configs[id]?.buildSettings;
    if (!bs) continue;
    Object.assign(bs, {
      INFOPLIST_FILE: `${TARGET}/Info.plist`,
      CODE_SIGN_ENTITLEMENTS: `${TARGET}/${TARGET}.entitlements`,
      CODE_SIGN_STYLE: "Automatic",
      IPHONEOS_DEPLOYMENT_TARGET: s.deploymentTarget,
      SWIFT_VERSION: "5.0",
      TARGETED_DEVICE_FAMILY: '"1,2"',
      MARKETING_VERSION: config.version ?? "1.0.0",
      CURRENT_PROJECT_VERSION: config.ios?.buildNumber ?? "1",
      PRODUCT_BUNDLE_IDENTIFIER: s.extensionBundleId,
      GENERATE_INFOPLIST_FILE: "NO",
      APPLICATION_EXTENSION_API_ONLY: "YES",
      SKIP_INSTALL: "YES",
    });
    if (config.ios?.appleTeamId) bs.DEVELOPMENT_TEAM = config.ios.appleTeamId;
  }
  return project;
}

/** @param {any} config @param {EmberPushPluginProps} [props] */
function withEmberPush(config, props = {}) {
  const { withEntitlementsPlist, withDangerousMod, withXcodeProject } = configPlugins();
  const s = emberPushSettings(config, props);
  applyAppConfig(config, s);
  config = withEntitlementsPlist(config, (/** @type {any} */ c) => {
    applyAppEntitlements(c.modResults, s);
    return c;
  });
  config = withDangerousMod(config, [
    "ios",
    async (/** @type {any} */ c) => {
      const dir = path.join(c.modRequest.platformProjectRoot, TARGET);
      fs.mkdirSync(dir, { recursive: true });
      for (const f of SWIFT_FILES) fs.copyFileSync(path.join(__dirname, "ios", TARGET, f), path.join(dir, f));
      fs.writeFileSync(path.join(dir, "Info.plist"), extensionInfoPlist(s));
      fs.writeFileSync(path.join(dir, `${TARGET}.entitlements`), extensionEntitlements(s));
      return c;
    },
  ]);
  config = withXcodeProject(config, (/** @type {any} */ c) => {
    addExtensionTarget(c.modResults, s, c);
    return c;
  });
  return config;
}

const pkg = require("./package.json");
let plugin = withEmberPush;
try {
  plugin = configPlugins().createRunOncePlugin(withEmberPush, pkg.name, pkg.version);
} catch {
  // Without expo installed (tests of the pure helpers), export the plain function.
}
module.exports = plugin;
module.exports.withEmberPush = withEmberPush;
module.exports.emberPushSettings = emberPushSettings;
module.exports.resolveApsEnvironment = resolveApsEnvironment;
module.exports.applyAppEntitlements = applyAppEntitlements;
module.exports.applyAppConfig = applyAppConfig;
module.exports.addExtensionTarget = addExtensionTarget;
module.exports.extensionInfoPlist = extensionInfoPlist;
module.exports.extensionEntitlements = extensionEntitlements;
module.exports.EMBER_NSE_TARGET = TARGET;
