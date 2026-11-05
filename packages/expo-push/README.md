# @freecorps/ember-expo-push

The device side of Ember's **end-to-end encrypted pushes**. Notifications are sealed on your Ember Worker
(`@freecorps/ember-push`, direct APNs/FCM transport) to a key that only the phone holds. Apple and Google carry
ciphertext plus a fallback text that says nothing ("New mail"). Subject and sender never pass through them in
clear.

- **iOS:** a Notification Service Extension (added by this package's Expo config plugin) decrypts each push with
  CryptoKit before it is shown.
- **Android:** sealed pushes are FCM data-only messages. A background task decrypts them and posts a local
  notification.
- If something fails (no key yet, iOS 16, a push sealed to an old or foreign key), the fallback text is shown. The
  device never stays silent.

The cipher suite is HPKE (RFC 9180) base mode: DHKEM(P-256, HKDF-SHA256) + HKDF-SHA256 + AES-128-GCM. It was chosen
by Freecorps Brigade's spike S1 and is ported from Brigade's MIT `packages/push`. JS decryption uses
[noble](https://paulmillr.com/noble/), since React Native has no WebCrypto.

## Setup

```sh
npx expo install expo-notifications expo-secure-store expo-constants expo-task-manager expo-crypto
npm install @freecorps/ember-expo-push @freecorps/ember-react-native
```

```ts
// app.config.ts
plugins: [
  "expo-secure-store",
  "expo-notifications",
  ["@freecorps/ember-expo-push", { /* appGroup, apsEnvironment, timeSensitive, deploymentTarget */ }],
],
ios: { bundleIdentifier: "com.acme.mail" },
android: { package: "com.acme.mail", googleServicesFile: process.env.GOOGLE_SERVICES_JSON ?? "./google-services.json" },
```

```ts
// index.ts: at module top level, before registerRootComponent (Android headless JS needs it)
import { defineEmberPushTask } from "@freecorps/ember-expo-push";
defineEmberPushTask();

// after sign-in
import { ensurePushKey, registerEmberPushTask } from "@freecorps/ember-expo-push";
import { registerForPush } from "@freecorps/ember-react-native";

const key = await ensurePushKey();                         // P-256, created once, kept in SecureStore
const r = await registerForPush({ kind: "device", publicKey: key.publicKey, androidChannels: [{ id: "mail", name: "Mail" }] });
if (r.status === "granted") {
  await registerDevice({ token: r.token, platform: r.platform, environment: r.environment, publicKey: r.publicKey });
  if (r.platform === "android") await registerEmberPushTask();
}
```

`registerDevice` is your mutation calling `push.register(ctx, { userId, ...args })` (component) or
`registerPushDevice`. On the server, enable the direct transport and encryption (see
[`@freecorps/ember-push`](../push/README.md)): `pushComponent` with `encryption: "required"` for mail.

## Config plugin options

| Option | Default | What |
|---|---|---|
| `appGroup` | `group.<bundle id>.ember` | App Group shared by the app and the extension; also the keychain access group of the device key |
| `apsEnvironment` | `development` locally, `production` when `EAS_BUILD` is set | The `aps-environment` entitlement; `EMBER_APS_ENVIRONMENT` overrides it too. Recorded in `extra.emberPush.apsEnvironment`, which `pushEnvironment()` in `@freecorps/ember-react-native` reads, so the token registers with the right APNs host |
| `timeSensitive` | `true` | Adds `com.apple.developer.usernotifications.time-sensitive`, needed for `urgency: "high"` |
| `deploymentTarget` | `16.4` | The extension's minimum iOS version. Decryption needs iOS 17 (CryptoKit HPKE); older devices show the fallback |
| `keychainService`, `keyName` | `ember.push`, `ember.push.keys.v1` | Where the key lives (must match `ensurePushKey` options if you change them) |

What it generates on iOS:
- an `EmberNotificationService` app-extension target (bundle id `<bundle id>.EmberNotificationService`), embedded
  in the app, built from `ios/EmberNotificationService/*.swift`;
- the App Group on both targets;
- `aps-environment`, plus the time-sensitive entitlement;
- an `extra.eas.build.experimental.ios.appExtensions` entry, so EAS Build creates and signs the extension's
  provisioning profile.

Android needs nothing from the plugin.

## API

| Export | What |
|---|---|
| `ensurePushKey(opts?)` | `{ publicKey, keyId }`. Creates the key pair on first use and stores it with `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY` (readable while locked, never synced or restored to another device), in the App Group's access group on iOS |
| `rotatePushKey()`, `deletePushKeys()`, `loadPushKeys()` | Rotation keeps one previous key, so pushes sealed before the server learned the new key still open. Call delete at sign-out |
| `defineEmberPushTask(opts?)`, `registerEmberPushTask()` | Android: define the task at top level and register it after sign-in |
| `presentEncryptedPush(payload, opts?)` | What the task does: decrypt, then show the content on its `channelId`, replacing by `tag` (the collapse id), or else the fallback |
| `openPushEnvelope(envelope, keys)`, `hpkeOpen`, `hpkeSeal`, `pushKeyId` | Pure-JS HPKE for any JS client |

## Verifying the extension (done for this package, macOS + Xcode)

- `test/swift.test.ts` compiles `EmberPushCrypto.swift` with CryptoKit on macOS. It opens envelopes the server sealed
  (WebCrypto) with keys stored the way `ensurePushKey` stores them, including a rotated key. Foreign and tampered
  envelopes are refused. The test also type-checks the whole extension against the iOS Simulator SDK. It is skipped
  where there is no Swift toolchain.
- `test/crypto.test.ts` checks the noble decoder against RFC 9180 vector A.3.1 and against the server's WebCrypto,
  in both directions.
- `test/plugin.test.ts` applies the plugin to a real Expo SDK 58 `project.pbxproj`.
- By hand, on apps/example-expo with `EMBER_PUSH_DIRECT=1`: `npx expo prebuild --platform ios --no-install`, then
  `xcodebuild -project ios/EmberChat.xcodeproj -target EmberNotificationService -sdk iphonesimulator
  CODE_SIGNING_ALLOWED=NO build` gives `BUILD SUCCEEDED`. The app embeds the `.appex` in PlugIns, and running
  prebuild again does not add the target twice.

Still to do on a real device: see "Real-device testing" in [`@freecorps/ember-push`](../push/README.md).

License: MIT.
