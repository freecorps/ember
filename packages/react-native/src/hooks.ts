import { useEmberClient } from "@freecorps/ember-react";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { bindEmberAuth, type AuthState, type AuthUser, type EmberAuthClient } from "./auth.ts";

export interface UseEmberAuthTokenResult {
  status: AuthState["status"];
  isLoading: boolean;
  isAuthenticated: boolean;
  /** Null until the session is validated after a restart. */
  user: AuthUser | null;
  signIn: EmberAuthClient["signInEmail"];
  signUp: EmberAuthClient["signUpEmail"];
  signOut: EmberAuthClient["signOut"];
  /** The JWT fetcher (what the EmberClient sends). */
  fetchToken: EmberAuthClient["fetchToken"];
}

/**
 * Auth state of a Better Auth session kept in SecureStore, wired into the `EmberClient` from `<EmberProvider>`:
 * on sign-in/sign-out the client re-authenticates its sockets and live queries re-run. Create the client with
 * `auth: authClient.fetchToken` (or use `createEmberClient({ auth: authClient })`) so the first connection already
 * carries the stored session; `{ bindInitially: true }` installs the fetcher on mount instead.
 */
export function useEmberAuthToken(auth: EmberAuthClient, opts: { bindInitially?: boolean } = {}): UseEmberAuthTokenResult {
  const client = useEmberClient();
  const state = useSyncExternalStore(auth.subscribe, auth.getState, auth.getState);
  const initial = opts.bindInitially ?? false;
  useEffect(() => bindEmberAuth(client, auth, { initial }), [client, auth, initial]);
  const actions = useMemo(
    () => ({
      signIn: auth.signInEmail.bind(auth),
      signUp: auth.signUpEmail.bind(auth),
      signOut: auth.signOut.bind(auth),
      fetchToken: auth.fetchToken,
    }),
    [auth],
  );
  return {
    status: state.status,
    isLoading: state.status === "loading",
    isAuthenticated: state.status === "signedIn",
    user: state.user,
    ...actions,
  };
}
