# Ember Chat: Expo example

A small Expo app (SDK 58, TypeScript, no router) built on the `ember init --auth` sample backend. It has:

- email + password sign-in and sign-up through the project's Better Auth (`@freecorps/ember-react-native`'s `EmberAuthClient`).
  The session token is kept in SecureStore and short JWTs are minted from it.
- a live `#general` channel using `useQuery(api.messages.list)` and `useMutation(api.messages.send)`, with an
  optimistic update. Mutations made while offline are queued in AsyncStorage.
- `AppState`/NetInfo connectivity. Sockets close 15 s after the app goes to the background, and they reconnect and
  resume when it comes back.
- push registration. `registerForPush()` gets the Expo push token and `push:register` stores it in the `pushDevices`
  table. Every `messages:send` schedules `push:notifyChannel`, an action that calls `sendPush` from `@freecorps/ember-push`.

```
ember/                 backend (schema, messages, users, push, auth.config): deployed with the ember CLI
src/                   the app
app.config.ts          reads EMBER_URL, EAS_PROJECT_ID, EMBER_IOS_BUNDLE_ID, EMBER_ANDROID_PACKAGE
eas.json               development / preview / production build profiles + production submit (iOS)
metro.config.js        monorepo singletons (react, react-native, expo) + optional peers of @freecorps/ember-react-native
```

## Run it

```sh
bun install                                   # from the repo root (workspace)

# backend: local dev server (wrangler) on :8787, or deploy one
cd apps/example-expo
npx ember dev                                 # or: npx ember deploy --env dev --wait

# app
EMBER_URL=http://<your-LAN-IP>:8787 npx expo start
```

- **Expo Go** runs everything except push. Push tokens have not been available in Expo Go since SDK 53, so
  `registerForPush` returns `unsupported` there. For push, use a development build (`eas build --profile development`)
  on a physical device.
- From a phone, `localhost` means the phone itself. Use your machine's LAN IP or a deployed `workers.dev` URL.
- Type check: `bun run typecheck` (in this folder). The app is not part of the root `tsc -b`, which covers only
  `packages/*`. It has its own `tsconfig.json`, which extends `expo/tsconfig.base` and excludes `ember/`, the backend
  that the ember CLI type-checks and bundles.
- `src/api.ts` has hand-written function references, so the app type-checks without codegen. After `npx ember dev`
  you can import `api` from `ember/_generated/api` instead.

### Push from the backend

`push:notifyChannel` sends one Expo push per registered device, except the sender's own devices. It deletes tokens
that come back as `DeviceNotRegistered`. If the Expo project enforces push security, set the access token as a Worker
secret named `EXPO_ACCESS_TOKEN` (the action reads `ctx.env.EXPO_ACCESS_TOKEN`).

### Direct APNs/FCM with end-to-end encryption (`EMBER_PUSH_DIRECT=1`)

Build with `EMBER_PUSH_DIRECT=1` (shell, or `env` in an eas.json profile). The app then registers the native
APNs/FCM token, its APNs environment and a device public key (`@freecorps/ember-expo-push`). The config plugin
adds the iOS Notification Service Extension that decrypts on the phone. The backend sends straight to APNs/FCM and
seals the content: Apple and Google only see `#general / New message`.

Set the backend secrets first: `APNS_KEY`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_TOPIC` (this app's bundle id) and
`FCM_SERVICE_ACCOUNT`. For Android builds, also set `GOOGLE_SERVICES_JSON=/path/outside/the/repo/google-services.json`.
The step-by-step guide is in [packages/push/README.md](../../packages/push/README.md), "Real-device testing". Without
the flag, nothing changes: Expo push tokens, Expo Push.

## TestFlight (EAS Build + EAS Submit)

Nothing here has been run from this repo. These are the steps (docs.expo.dev/submit/ios, CLOUDFLARE.md §8).

Prerequisites:
- a paid Apple Developer account;
- an Expo account with `EXPO_TOKEN` for CI;
- `npm i -g eas-cli`. No Mac is needed.

1. **Link the project.** Run `eas init` in this folder. It creates the EAS project; put its id in `EAS_PROJECT_ID`
   (or in `extra.eas.projectId`). Set a unique `EMBER_IOS_BUNDLE_ID` (default `dev.ember.example`).
2. **Point production at the deployed backend.** Edit `build.production.env.EMBER_URL` in `eas.json`, or set an
   EAS environment variable, to `https://ember-example-expo-prod.<subdomain>.workers.dev`. Deploy that with
   `npx ember deploy --env prod --wait`.
3. **Create the app in App Store Connect** with that bundle id. Its numeric **Apple ID** (App Information) is the
   `ascAppId`. Your **Team ID** is under developer.apple.com → Membership.
4. **App Store Connect API key** (Users and Access → Integrations → Keys, role *App Manager*). Download the `.p8`
   file once and keep it out of git (`*.p8` is ignored). `eas.json` reads it from the environment:
   ```sh
   export ASC_API_KEY_PATH=/secure/AuthKey_ABC123.p8 ASC_API_KEY_ISSUER_ID=<issuer uuid> ASC_API_KEY_ID=ABC123
   ```
   You can also upload the key to EAS once with `eas credentials`, and EAS Submit then uses it.
5. **Fill `ascAppId` and `appleTeamId`.** `eas.json` only expands `$VARS` in the three ASC key fields, so run:
   ```sh
   ASC_APP_ID=1234567890 APPLE_TEAM_ID=ABCDE12345 bun run eas:submit-ids
   ```
6. **Push credentials.** On the first iOS build, EAS offers to create the APNs key (answer yes). Expo Push uses that
   key.
7. **Build and submit.**
   ```sh
   eas build --platform ios --profile production --auto-submit       # interactive the first time (credentials)
   # CI (non-interactive): EXPO_TOKEN + the ASC_* variables above
   eas build --platform ios --profile production --non-interactive --auto-submit
   ```
   Processing in App Store Connect takes about 10–15 minutes. Then add testers in TestFlight (internal testers need no
   review). An EAS Workflow `testflight` job can replace step 7 in CI.

Profiles:
- `development`: dev client, internal distribution.
- `preview`: an internal ad-hoc build against the dev backend.
- `production`: store build with an auto-incremented build number, submitted to TestFlight.
