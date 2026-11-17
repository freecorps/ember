# @freecorps/ember-react-native

[Ember](https://github.com/freecorps/ember) for React Native and Expo: an `EmberClient` with mobile defaults
(AppState + NetInfo connectivity, a pending-mutation queue in AsyncStorage), Better Auth sign-in with the session in
SecureStore, and push registration. Re-exports `@freecorps/ember-react` (provider and hooks), so an app imports from
one place. Works in Expo Go and EAS builds: no native module is required.

```sh
npx expo install @freecorps/ember-react-native @freecorps/ember-client \
  @react-native-community/netinfo @react-native-async-storage/async-storage expo-secure-store
```

Optional peers, each used only when installed: `@react-native-community/netinfo`,
`@react-native-async-storage/async-storage`, `expo-secure-store`, `expo-notifications`, `expo-device`,
`expo-constants`.

## Example

From [`apps/example-expo`](https://github.com/freecorps/ember/tree/main/apps/example-expo):

```tsx
import { createEmberAuthClient, createEmberClient, EmberProvider, useEmberAuthToken } from "@freecorps/ember-react-native";

export const authClient = createEmberAuthClient({ url: EMBER_URL });  // Better Auth session in SecureStore
export const emberClient = createEmberClient({ url: EMBER_URL, auth: authClient, defaultShard: "global:main" });

function Gate() {
  const auth = useEmberAuthToken(authClient);
  if (auth.isLoading) return <ActivityIndicator />;
  return auth.isAuthenticated ? <ChatScreen auth={auth} /> : <LoginScreen auth={auth} />;
}

export default function App() {
  return <EmberProvider client={emberClient}><Gate /></EmberProvider>;
}
```

Push registration after sign-in (`usePushRegistration.ts` in the example):

```ts
const r = await registerForPush();                         // Expo push token
// or the native APNs/FCM token, for direct sends and end-to-end encryption:
// await registerForPush({ kind: "device", androidChannels: [{ id: "default", name: "Messages" }], publicKey })
if (r.status === "granted") await register({ token: r.token, platform: r.platform, provider: r.provider });
```

## Entry points

- `createEmberClient(options)`: `new EmberClient` with `auth` (an `EmberAuthClient` or a token fetcher), `storage`
  (AsyncStorage by default, `"memory"`, or an offline `StorageAdapter` such as `expoSqliteStorage` from
  `@freecorps/ember-offline/expo-sqlite`) and `connectivity` (`createExpoConnectivity()` by default; sockets close
  `backgroundGraceMs`, 15 s by default, after the app goes to the background and resume on foreground).
- `createEmberAuthClient({ url })` / `EmberAuthClient`: `signUpEmail`, `signInEmail`, `signOut`, `getSession`,
  `fetchToken` (short JWTs minted from the stored session), `subscribe` / `getState`; `bindEmberAuth(client, auth)`.
- `useEmberAuthToken(authClient)`: `isLoading`, `isAuthenticated` and the auth state for React.
- `registerForPush(options?)`: asks for permission, registers Android channels and notification categories, and returns
  `{ status: "granted", token, provider: "expo" | "apns" | "fcm", platform, environment?, publicKey? }`, `denied`
  or `unsupported`. `pushEnvironment()` is the build's APNs environment (recorded by the `@freecorps/ember-expo-push` config plugin).
- Storage helpers: `AsyncStoragePendingStorage`, `secureTokenStore`, `memoryTokenStore`, `keyValueTokenStore`,
  `defaultTokenStore`.

Sending pushes is `@freecorps/ember-push` (server side); decrypting end-to-end encrypted pushes on the device is
`@freecorps/ember-expo-push`.

Contracts: [`docs/design/contracts.md`](https://github.com/freecorps/ember/blob/main/docs/design/contracts.md) (in
Portuguese), "Auth" and "Push direto e E2E".

License: MIT.
