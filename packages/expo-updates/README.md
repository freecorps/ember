# @freecorps/ember-expo-updates

Self-hosted EAS Update for [Ember](https://github.com/freecorps/ember) apps: the
[Expo Updates protocol v1](https://docs.expo.dev/technical-specs/expo-updates-1/) served by your Worker, with signed
manifests, channels and branches, percentage rollouts, rollbacks and a kill switch. Opening the app reads the
**edge cache**, not your database; bundles and assets come from R2 with `immutable` caching.

```ts
// ember/ember.config.ts
import { defineApp } from "@freecorps/ember-server";
import { expoUpdates } from "@freecorps/ember-expo-updates";
export default defineApp().use(expoUpdates); // GET /expoUpdates/manifest, GET /expoUpdates/assets
```

```jsonc
// ember.json: assets live in Ember's files bucket (R2)
{ "resources": { "files": true } }
```

```sh
npx expo export                                         # dist/metadata.json + bundles + assets
npx expo config --json --type public > dist/expoConfig.json   # the runtime version (and Constants.expoConfig)
ember expo publish --branch production --message "Fix checkout" --env prod
```

`ember expo publish` reads the runtime version from `dist/expoConfig.json` (a string, or the `appVersion`,
`nativeVersion` and `sdkVersion` policies, with Expo's defaults). Without that file, pass it yourself (the update
then carries no `Constants.expoConfig`), and do so for the `fingerprint` policy, which only the native build computes:

```sh
ember expo publish --branch production --runtime-version 1.2.0 --env prod
```

## The Expo app

```jsonc
// app.json
{
  "expo": {
    "runtimeVersion": { "policy": "appVersion" },
    "updates": {
      "url": "https://api.example.com/expoUpdates/manifest",
      "requestHeaders": { "expo-channel-name": "production" },
      // Code signing (recommended): the app only runs manifests signed by your key.
      "codeSigningCertificate": "./certs/certificate.pem",
      "codeSigningMetadata": { "keyid": "main", "alg": "rsa-v1_5-sha256" }
    }
  }
}
```

Signing setup, once:

```sh
npx expo-updates codesigning:generate --key-output-directory keys --certificate-output-directory certs \
  --certificate-validity-duration-years 10 --certificate-common-name "My App"
npx expo-updates codesigning:configure --certificate-input-directory certs --key-input-directory keys
ember env set EXPO_UPDATES_PRIVATE_KEY --env prod < keys/private-key.pem   # never commit keys/
```

The private key is a Worker secret (PKCS#1 `RSA PRIVATE KEY`, as `codesigning:generate` writes it, or PKCS#8);
the signature is RSASSA-PKCS1-v1_5 with SHA-256 through WebCrypto. Requests that send `expo-expect-signature` get
`expo-signature: sig="…", keyid="main"` on the `manifest` (or `directive`) part; if no key is configured they get a
500 naming the secret, so a signing app never runs an unsigned update. Secret name and key id are install options.

## What the routes do

`GET /<install>/manifest` follows the protocol:

- Headers: `expo-protocol-version` (0 or 1; else 406), `expo-platform` (`ios`/`android`; else 400),
  `expo-runtime-version` (required), `expo-channel-name` (default `production`, install option `defaultChannel`),
  `expo-current-update-id`, `expo-embedded-update-id`, `expo-expect-signature`, and the install id (`eas-client-id`,
  sent by expo-updates; `expo-eas-client-id` is read too) for rollouts.
- Answer: `multipart/mixed` with `manifest` + `extensions` (`{ assetRequestHeaders: {} }`) parts, or a `directive`
  part; the manifest alone as JSON when the client does not accept multipart. `expo-protocol-version`,
  `expo-sfv-version: 0`, `cache-control: private, max-age=0`.
- The newest live update of the channel's branch for that platform and runtime version. Assets carry `hash`
  (base64url SHA-256), `key` (Metro's asset hash, what the bundle looks assets up by), `contentType`,
  `fileExtension` and `url`.
- `noUpdateAvailable` (protocol 1) when the client already runs that update, when nothing is published, or when the
  channel is paused, or the branch the install falls on is (the kill switch); `rollBackToEmbedded` after a rollback to the embedded update
  (`noUpdateAvailable` if the client already runs the embedded one). Protocol 0 and the JSON form have no directives:
  204 for "nothing new", 406 for a rollback; protocol 0 gets the manifest even when it is the current one (the client
  compares the ids). `accept` picks the form by q-value, the most specific range deciding (`multipart/mixed;q=0, */*`
  is JSON); the JSON form answers with the media type chosen (`application/json` or `application/expo+json`).

`GET /<install>/assets?key=<sha256 hex>` serves the bytes from R2 with the asset's `Content-Type` and
`Cache-Control: public, max-age=31536000, immutable` (the URL is the content address: it never changes).

## Edge cache

`caches.default` holds two kinds of entries per edge location:

- the **plan** of a channel for (platform, runtime version): everything needed to answer any install (branch,
  head update, the previous one during a rollout, pause flags) and the channel's **version**, a counter bumped by
  every publish, rollback, rollout change, channel change and kill switch. It is reused for `planTtlSeconds`
  (default 30) before the shard is asked again;
- the **rendered (signed) response**, keyed by channel, platform, runtime version, the plan's version, the install's
  **rollout side** (not its id), what the client already runs (only as "this one / the embedded one / another"),
  protocol, format and signing key (a digest of the PEM: a rotated key never serves an old signature). A new version
  never reads an old response.

So an app open is two cache lookups and no Durable Object; each edge location reads the shard once per
`planTtlSeconds` per (channel, platform, runtime version), and signs once per response key, except for concurrent
misses: requests that miss the same key before one of them fills it each read (and sign); misses are not coalesced. Measured in
`test/workerd`: 50 opens after the first → 0 stubs, 0 RPCs; 200 installs in a 30% rollout → 1 shard read, 2 signed
responses. The cost is bounded staleness: a publish, rollback or kill switch reaches every location within
`planTtlSeconds`. Tune it per install:

```ts
defineApp().use(expoUpdates, { config: { cache: { planTtlSeconds: 10 } } }); // or cache: false
```

The Cache API stores entries on zones (a custom domain); on `*.workers.dev` everything works, uncached.

Assets are cached at the edge on first fetch (one shard read and one R2 read per location and asset), streamed: a
bundle is never held in the Worker's memory. An `assetsUrl` (install option, e.g. a CDN in front of the route) may
carry its own query string; `key` is added to it.

## Publishing and operating

`ember expo` drives the component through the admin function runner (`EMBER_ADMIN_TOKEN`), shard `global:main`:

```sh
ember expo publish --branch production [--dir dist] [--message m] [--rollout 25] [--platform ios] [--runtime-version 1.2.0]
ember expo rollout 60 --branch production          # raise (or lower) the share; 100 ends the rollout
ember expo rollback --branch production [--platform ios] [--runtime-version 1.2.0] [--to-embedded]
ember expo kill --channel production               # or --branch b; `resume` undoes it
ember expo channel production --branch production --rollout-branch beta --rollout-percent 10   # --no-rollout clears
ember expo list
```

- **publish** hashes every file of the export (SHA-256), asks which ones the project lacks (`lib:prepareAssets`),
  PUTs only those (Ember's upload tickets: presigned R2, or the Worker in proxy mode) and confirms them, then creates
  one update per platform (`lib:publish`). Unchanged images and fonts are never uploaded twice. The branch is created
  if missing, and a channel of the same name pointing at it (`--no-channel` skips that).
- **Rollouts** are deterministic: an install is in a `p`% rollout when a hash of its install id and the update id
  falls below `p`, so raising `p` only adds installs, and installs on the other side get the previous update.
  Publishing on top of an unfinished rollout is refused (`RolloutInProgress`). A channel can also send a share of
  its installs to a second branch.
- **Pointing a channel elsewhere** (`setChannel`, or clearing its branch rollout) serves the other branch's current
  head as it is: installs only move to a newer `createdAt`, so one already running a newer update from the previous
  branch keeps it. To bring those back, republish the target update on the target branch after the switch
  (`ember expo publish` of the same export there), which gives it a newer `createdAt`. If the target branch has an
  unfinished rollout, that publish is refused (`RolloutInProgress`, which names the platform and runtime version):
  finish it first, `ember expo rollout 100 --branch <target> --platform <p> --runtime-version <v>` (its update goes
  to every install), or take it out with `ember expo rollback --branch <target> --platform <p> --runtime-version <v>`,
  then publish. Without `--platform`/`--runtime-version` both commands act on every pair of the branch. A rollback on the previous
  branch does not help: it changes that branch (and the other channels still on it), not the target's head.
- **Rollback** takes the head out (`rolledBack`) and republishes the previous update as a new one (clients only move
  to a newer `createdAt`), or publishes `rollBackToEmbedded` with `--to-embedded` or when there is no previous update.
- **Kill switch**: a paused channel answers `noUpdateAvailable` to all its installs; a paused branch, to the installs
  it serves (on every channel, also as a rollout branch: installs of such a channel on its other branch keep
  updating). Clients keep what they run. A branch serves at most 1000 channels (`MAX_CHANNELS_PER_BRANCH`).

The same operations are on the component's screen in the Ember Dashboard (channels, branches, updates with their
manifest and assets; rollout, rollback and kill switch, the destructive ones behind a confirmation).

From your own code, the component's functions are `components.expoUpdates.lib.*` (`publish`, `rollback`,
`setRollout`, `setChannel`, `setChannelPaused`, `setBranchPaused`, `list`, `updates`).
