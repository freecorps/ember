import Constants from "expo-constants";
import { createEmberAuthClient, createEmberClient } from "@freecorps/ember-react-native";
import { SHARD } from "./api";

/** From app.config.ts (`EMBER_URL` at build/start time). */
export const EMBER_URL: string = (Constants.expoConfig?.extra as { emberUrl?: string } | undefined)?.emberUrl ?? "http://localhost:8787";

/** Better Auth session in SecureStore (Keychain/Keystore); short JWTs minted from it for Ember. */
export const authClient = createEmberAuthClient({ url: EMBER_URL });

/** AppState/NetInfo-aware client: sockets close 15 s after backgrounding and resume on foreground. */
export const emberClient = createEmberClient({
  url: EMBER_URL,
  auth: authClient,
  defaultShard: SHARD,
  onError: (e) => console.warn("[ember]", e.code, e.message),
});
