# @freecorps/ember-push

Push notifications for Ember apps. Sends go out from your own Worker (actions, or the `push` component). There is
no relay to run: Ember is self-hosted per company.

| Transport | Device tokens | Setup | Notes |
|---|---|---|---|
| `expo` (default) | `ExponentPushToken[...]` (`registerForPush()`) | none (`EXPO_ACCESS_TOKEN` optional) | Expo Push: receipts ~15 min later, no encryption |
| `direct` | native APNs / FCM tokens (`registerForPush({ kind: "device" })`) | APNs `.p8` + FCM service account, as Worker secrets | APNs over HTTP/2 + FCM HTTP v1 straight from the Worker; urgency, collapse ids, VoIP, **end-to-end encryption** |

The transport is chosen **per device**, by how the app registered: Expo tokens go to Expo, native tokens go direct.
Both kinds can coexist, for example during a migration.

## The push component

```ts
// ember/ember.config.ts
import { pushComponent } from "@freecorps/ember-push";
export default defineApp().use(pushComponent, {
  config: {
    apns: { topic: "com.acme.mail" },            // the bundle id (or the APNS_TOPIC secret)
    encryption: "required",                      // mail: subject and sender never in clear at Apple/Google
    fallback: { title: "New mail", body: "Open Mail to read it" },
  },
});

// ember/push.ts
import { PushNotifications } from "@freecorps/ember-push";
import { components, mutation } from "./_generated/server";
const push = new PushNotifications(components.push);

export const register = mutation({
  args: { token: v.string(), platform: v.optional(v.string()), environment: v.optional(v.string()), publicKey: v.optional(v.string()) },
  handler: (ctx, a) => push.register(ctx, { userId: me(ctx), ...a }),   // provider inferred from the token
});

// in the mutation that stores a new message (the push is enqueued atomically with it):
push.send(ctx, [recipient], { title: from, body: subject, urgency: "high", collapseId: threadHash, data: { messageId } });
```

The full config, with every field optional:

```ts
{
  accessTokenEnv: "EXPO_ACCESS_TOKEN", receiptsDelayMs: 15 * 60_000,               // Expo
  apns: { topic, keyEnv: "APNS_KEY", keyIdEnv: "APNS_KEY_ID", teamIdEnv: "APNS_TEAM_ID", topicEnv: "APNS_TOPIC",
          environment: "production" /* devices registered without one */, productionUrl, sandboxUrl },
  fcm: { serviceAccountEnv: "FCM_SERVICE_ACCOUNT", sendUrl, tokenUrl },
  encryption: "auto",                                                               // "off" | "auto" | "required"
  fallback: { title, body, titleLocKey, locKey },
}
```

What a delivery does:
1. Reads the users' devices.
2. Sends each device through its transport.
3. Deletes devices whose token is dead, clears dead VoIP tokens, and records the APNs environment found for devices
   registered without one.
4. Schedules Expo receipt checks (Expo only; APNs and FCM answer synchronously).

`sendNow` returns `{ sent, errors, removedTokens, errorCodes }`. When secrets are missing, those devices are kept;
the result shows `ProviderNotConfigured` and `ember logs` shows a warning naming the missing secrets.

## Without the component

Use `sendPush(tokens, message)` (Expo) or `sendToDevices(devices, message, { apns, fcm, expo, encryption, fallback })`
from an action, with your own `pushDevices` table (`pushDevicesTable()`, `registerPushDevice`, `pushDevicesForUsers`,
`removePushTokens`, `removeVoipTokens`, `setPushDeviceEnvironment`). Lower level: `sendApns`, `sendFcm`,
`apnsPushProvider`, `fcmPushProvider`, `sealPushContent`. See `apps/example-expo/ember/push.ts`.

## Secrets

| Secret | What |
|---|---|
| `APNS_KEY` | The `.p8` file's text (`-----BEGIN PRIVATE KEY-----...`). Escaped `\n` and CRLF are fine |
| `APNS_KEY_ID` | The key's 10-character id |
| `APNS_TEAM_ID` | Your Apple Developer team id |
| `APNS_TOPIC` | The app's bundle id (or `config.apns.topic`, which is not secret) |
| `FCM_SERVICE_ACCOUNT` | The service account's JSON key, the whole file |
| `EXPO_ACCESS_TOKEN` | Optional, for Expo projects with enhanced push security |

They are read from the Worker env at send time and are never stored or logged. Keep the files outside the
repository. Set them with `ember env` (Worker secrets of `ember-<project>-<env>`, live at once and kept by every
`ember deploy`). Secret values come from stdin (or `--from-env VAR`), never the command line; plain vars such as
`APNS_TOPIC` are not secret, live in `ember.json`, and take their value on the command line with `--var`:

```sh
ember env set APNS_KEY --env prod < ~/secure/AuthKey_ABC123DEFG.p8
printf %s ABC123DEFG | ember env set APNS_KEY_ID --env prod
printf %s TEAM123456 | ember env set APNS_TEAM_ID --env prod
ember env set APNS_TOPIC com.acme.mail --var --env prod   # not secret: a plain var in ember.json
ember env set FCM_SERVICE_ACCOUNT --env prod < ~/secure/fcm-service-account.json
ember env list --env prod                                  # names only
```

In `ember dev`, put the same names in `.dev.vars` (gitignored).

**APNs needs HTTP/2.** A deployed Worker's `fetch` reaches APNs, but local workerd (`ember dev`) cannot, so APNs
sends fail locally with a network error. FCM works locally. Unit tests use fake endpoints (below).

## Behaviour

Urgency follows Brigade's relay as its README documents it (Brigade's `low`/`high`/`page`):

| `urgency` | APNs priority | FCM priority | TTL default | iOS interruption level |
|---|---|---|---|---|
| `low` | 5 | NORMAL | 4 h | active |
| `normal` (default; `priority: "normal"` means `low`) | 10 | HIGH | 1 h | active |
| `high` | 10 | HIGH | 15 min | time-sensitive (entitlement added by the ember-expo-push plugin) |

- `ttl` overrides the default (0 = deliver now or never; at most 30 days, 28 for FCM).
- `collapseId` sets `apns-collapse-id` (max 64 bytes) and the FCM `collapse_key` plus notification tag. Expo devices get it as Expo's `collapseId` and Android `tag`.
- `threadId`, `categoryId`, `badge` and `sound` map to their APNs/FCM fields. `contentAvailable` alone sends a
  background push (APNs priority 5). `voip: true` sends to the device's PushKit `voipToken` (topic `<bundle>.voip`).
- Each device token's APNs environment is recorded at registration (development-signed builds get sandbox tokens;
  ad hoc, TestFlight and App Store builds get production). For a device registered without one, the default host is
  tried first, then the other one after `BadDeviceToken`. The one that works is recorded.
- The APNs provider token (ES256 over the `.p8`) is reused for 40 minutes. The FCM access token (RS256
  service-account assertion) is kept until 5 minutes before it expires; concurrent sends share one exchange, and a
  401 refetches it once for every send that saw the same token.
- The token layer is usable on its own, around an app's own payloads: `apnsProviderToken(credentials, now, force)`
  and `fcmAccessToken(options, force, signal)`. `force` is `true` (always new) or the token the provider just refused
  (new only if the cache still holds it, so concurrent sends refresh once and a token another send already replaced
  is reused).
- 429 and 5xx answers and network errors are retried twice with backoff (`Retry-After` is honoured).
- `timeoutMs` is a deadline for each send, retries and the token it needs included; `signal` aborts it. Either way the
  ticket is `RequestFailed`. A caller's deadline only stops that caller waiting for a token exchange other sends share.
- Error tickets from a direct send carry the provider's own `reason` (APNs' `reason`, FCM's `errorCode` or error
  `status`) and `httpStatus`, for rules the codes below fold together (a token of another topic, a token FCM calls
  malformed).

| Answer | Code | Device |
|---|---|---|
| APNs `Unregistered` / `ExpiredToken` (410), `BadDeviceToken`; FCM `UNREGISTERED`; a malformed token | `DeviceNotRegistered` / `InvalidToken` | **deleted** |
| APNs `DeviceTokenNotForTopic`, `TopicDisallowed`; FCM `SENDER_ID_MISMATCH` | `MismatchSenderId` | kept (configuration error) |
| APNs `InvalidProviderToken`, `ExpiredProviderToken`; FCM 401/403, `THIRD_PARTY_AUTH_ERROR` | `InvalidCredentials` | kept |
| FCM `INVALID_ARGUMENT` | `InvalidArgument` | kept (could be our payload) |
| `PayloadTooLarge`, over 4 KB | `MessageTooBig` | kept |
| `TooManyRequests`, `QUOTA_EXCEEDED` | `MessageRateExceeded` | kept |
| no secrets for that provider | `ProviderNotConfigured` | kept |

## End-to-end encryption

With `encryption: "auto"` or `"required"`, a direct device that registered a `publicKey` gets its push sealed with
HPKE (RFC 9180: P-256, HKDF-SHA256, AES-128-GCM, info `"freecorps.ember push v1"`). The envelope `{ v, k, enc, ct }`
holds the title, subtitle, body and data. It is ported from Freecorps Brigade's MIT `packages/push`.
- APNs gets the fallback alert, `mutable-content: 1` and `ember: <envelope>`. The Notification Service Extension
  from `@freecorps/ember-expo-push` decrypts it on iOS 17+.
- FCM gets a data-only message: `{ ember, fallbackTitle, fallbackBody, channelId?, tag?, urgency }`. The app's
  background task decrypts it and shows the notification.
- `required`: devices without a key, and Expo devices, get only the fallback text and no data.
- In clear by design: the fallback text, urgency/priority, TTL, collapse id/tag, thread id, category, badge, sound and
  the key id. Do not put anything sensitive in those (hash a thread id, for example).
- Only pushes with something to show are sealed. Background and VoIP pushes go as they are under `auto` and lose
  their `data` under `required`.

Device side: [`@freecorps/ember-expo-push`](../expo-push/README.md).

## Tests

`bun run test` in this folder:
- **Fake APNs and FCM servers** (`test/fakes.ts`) verify the ES256 provider token and the RS256 OAuth assertion with
  WebCrypto, check headers, paths and payloads, and answer per token (`Unregistered`, `BadDeviceToken`, sandbox-only,
  429, 503, `SENDER_ID_MISMATCH`...).
- Covered: request format, priority/TTL/interruption mapping, token reuse and refresh, error mapping and pruning,
  environment probing, VoIP, retries, payload limits; routing and encryption across Expo/APNs/FCM; the component with
  secrets from the env; the RFC 9180 A.3.1 vector (Brigade's test, ported) and envelope round trips.
- **workerd** (`vitest.workerd.config.ts`): the component in the real runtime (Worker + Shard DO). Miniflare's
  `outboundService` routes every `fetch` to the fakes: `sendNow` from an action, and `push.send` from a mutation
  delivered by the shard's alarm.

## Real-device testing (not done yet; no credentials were used)

What you need:
1. **Apple:** a paid Apple Developer account, and your **Team ID** (developer.apple.com → Membership).
2. **APNs key:** Certificates, IDs & Profiles → Keys → +, enable *Apple Push Notifications service (APNs)*. Download
   `AuthKey_<KEYID>.p8` (only possible once) and note the **Key ID**. One key serves sandbox and production and every
   app of the team.
3. **Bundle id** of the app, for example `com.acme.mail`. Its App ID needs *Push Notifications*, *App Groups*
   (`group.<bundle id>.ember`) and, for `urgency: "high"`, *Time Sensitive Notifications*. The extension's App ID is
   `<bundle id>.EmberNotificationService`, with the same App Group. EAS Build creates and syncs these from the
   entitlements and the `appExtensions` entry the plugin writes. With local Xcode signing, enable them by hand.
4. **Firebase:** a project with an Android app for your package name. Download `google-services.json` (outside the
   repository) and point `android.googleServicesFile` (or `GOOGLE_SERVICES_JSON` in the example) at it.
5. **FCM service account:** in Google Cloud IAM for that project, create a service account with role *Firebase Cloud
   Messaging API Admin* (`roles/firebasecloudmessaging.admin`), make sure the *Firebase Cloud Messaging API* (v1) is
   enabled, and create a JSON key. That key is `FCM_SERVICE_ACCOUNT`.

How to test, with the mail app or `apps/example-expo` with `EMBER_PUSH_DIRECT=1`:
1. Deploy the backend and set the secrets (above).
2. Build the app with the `@freecorps/ember-expo-push` plugin:
   - EAS (`eas build --profile preview`): production APNs tokens.
   - Local (`npx expo run:ios --device`): sandbox tokens.
   - Android: any build with `google-services.json`.
3. Sign in and allow notifications. Check that the device row has the right `provider`, `environment` and a
   `publicKey` (dashboard data browser, or `ember run`).
4. Send from another account. On a **locked** iPhone, the notification should show the real title and body (the NSE
   decrypted it). Console.app, filtered on subsystem `<bundle id>.EmberNotificationService`, shows `push decrypted`.
   On Android, test with the app in the foreground, in the background and swiped away (headless task).
5. Negative checks:
   - Delete the app, then send: `Unregistered` or `BadDeviceToken`, and the device row is gone.
   - Register a development build's token as `production`: `BadDeviceToken`, pruned.
   - An iOS 16 phone, or a push sent before the app created its key: the fallback text.
   - `urgency: "high"`: a Time Sensitive banner.
   - Two sends with the same `collapseId`: one notification.
6. R12 open points to record (PLAN §18):
   - APNs from both send paths: `sendNow` (the Worker) and `push.send` (Shard DO alarm, or the actions queue).
   - No `TooManyProviderTokenUpdates` across many sends.
   - Latency to the phone.

Not provided:
- A Brigade-relay transport: the relay's payload (`brigade` field, Brigade loc keys) is specific to Brigade's app,
  and Ember instances send directly.
- Client-side PushKit (VoIP) registration: expo-notifications has no PushKit, so use a native module. The registry
  and sending already support `voipToken`.

License: MIT. HPKE, base64url and the envelope format are adapted from Freecorps Brigade's `packages/push` (MIT).
The APNs, FCM, NSE and config-plugin code is written for Ember from Apple's, Google's and Expo's documentation.
Brigade's relay and mobile app are AGPL, so they were used only as documented behaviour (README, docs), never as
code.
