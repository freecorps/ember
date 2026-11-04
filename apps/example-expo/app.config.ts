import type { ConfigContext, ExpoConfig } from "expo/config";

/**
 * EMBER_URL: the Ember deployment (Worker URL) the app talks to. Set it in your shell for `expo start`, in an
 * eas.json build profile `env`, or as an EAS environment variable. Read at runtime via `Constants.expoConfig.extra`.
 */
const EMBER_URL = process.env.EMBER_URL ?? "http://localhost:8787";
const BUNDLE_ID = process.env.EMBER_IOS_BUNDLE_ID ?? "dev.ember.example";
const ANDROID_PACKAGE = process.env.EMBER_ANDROID_PACKAGE ?? "dev.ember.example";

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: "Ember Chat",
  slug: "ember-example-expo",
  scheme: "emberchat",
  version: "1.0.0",
  orientation: "portrait",
  userInterfaceStyle: "automatic",
  ios: {
    bundleIdentifier: BUNDLE_ID,
    supportsTablet: false,
    // No custom encryption beyond HTTPS: skips the export-compliance question in App Store Connect.
    infoPlist: { ITSAppUsesNonExemptEncryption: false },
  },
  android: { package: ANDROID_PACKAGE },
  plugins: ["expo-secure-store", "expo-notifications"],
  extra: {
    emberUrl: EMBER_URL,
    // Filled by `eas init` (or EAS_PROJECT_ID); expo-notifications needs it for Expo push tokens.
    eas: { projectId: process.env.EAS_PROJECT_ID },
  },
});
