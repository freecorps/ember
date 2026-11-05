import type { ConfigContext, ExpoConfig } from "expo/config";

/**
 * EMBER_URL: the Ember deployment (Worker URL) the app talks to. Set it in your shell for `expo start`, in an
 * eas.json build profile `env`, or as an EAS environment variable. Read at runtime via `Constants.expoConfig.extra`.
 */
const EMBER_URL = process.env.EMBER_URL ?? "http://localhost:8787";
const BUNDLE_ID = process.env.EMBER_IOS_BUNDLE_ID ?? "dev.ember.example";
const ANDROID_PACKAGE = process.env.EMBER_ANDROID_PACKAGE ?? "dev.ember.example";
/**
 * EMBER_PUSH_DIRECT=1: native APNs/FCM tokens + end-to-end encrypted pushes (@freecorps/ember-expo-push: Notification
 * Service Extension on iOS, decrypt task on Android) instead of Expo push tokens. Needs the APNs/FCM secrets on the
 * backend (packages/push/README.md, "Real-device testing"). GOOGLE_SERVICES_JSON: path to google-services.json
 * (kept outside the repository) for Android builds with FCM.
 */
const PUSH_DIRECT = process.env.EMBER_PUSH_DIRECT === "1";
const GOOGLE_SERVICES = process.env.GOOGLE_SERVICES_JSON;

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
  android: { package: ANDROID_PACKAGE, ...(GOOGLE_SERVICES ? { googleServicesFile: GOOGLE_SERVICES } : {}) },
  plugins: ["expo-secure-store", "expo-notifications", ...(PUSH_DIRECT ? ["@freecorps/ember-expo-push"] : [])],
  extra: {
    emberUrl: EMBER_URL,
    pushTransport: PUSH_DIRECT ? "direct" : "expo",
    // Filled by `eas init` (or EAS_PROJECT_ID); expo-notifications needs it for Expo push tokens.
    eas: { projectId: process.env.EAS_PROJECT_ID },
  },
});
