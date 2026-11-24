/**
 * Which Better Auth fields never leave the `Auth` Durable Object: one rule for the `auth:*` descriptors and replica
 * tables (`authTablesManifest`, `authReplicaSpec`) and for the profile sync (`internal.users.sync`, the user journal).
 *
 * Hidden: what Better Auth marks `returned: false`, the known secrets of core and first-party plugins below (some are
 * not marked), and on `user` the app's own `ember.hiddenUserFields` (a third-party plugin's secret on the user row).
 * Pure: types only.
 */

/** Fields that never leave the Auth DO even if Better Auth does not flag them `returned: false`. */
export const HIDDEN_FIELDS: Record<string, readonly string[]> = {
  account: ["password", "accessToken", "refreshToken", "idToken"],
  verification: ["value"],
  twoFactor: ["secret", "backupCodes"],
  jwks: ["privateKey"],
  apikey: ["key"],
  passkey: ["publicKey"],
  session: ["token"],
  // sso: the OIDC config holds the client secret, the SAML config the SP private key.
  ssoProvider: ["oidcConfig", "samlConfig"],
  // oauthProvider: client secrets (hashed, still a credential) and the tokens it issued.
  oauthClient: ["clientSecret"],
  oauthAccessToken: ["token"],
  oauthRefreshToken: ["token"],
  // deviceAuthorization: the device code is what the device polls with (a session once approved); the user code is
  // what the user types to claim and approve the request.
  deviceCode: ["deviceCode", "userCode"],
};

/** `ember.hiddenUserFields` of a resolved config (value form), or none. */
export function hiddenUserFieldsOf(config: unknown): readonly string[] {
  const list = (config as { ember?: { hiddenUserFields?: unknown } } | null)?.ember?.hiddenUserFields;
  return Array.isArray(list) ? list.filter((f): f is string => typeof f === "string") : [];
}

/**
 * The hidden field keys of `model`, given its Better Auth fields (`getAuthTables(options)[model].fields`). With
 * `strict`, a name of `hiddenUser` that is not a field of the user model throws (codegen); without, it is ignored.
 */
export function hiddenFieldsOf(
  model: string,
  fields: Record<string, { returned?: boolean | undefined }>,
  hiddenUser: readonly string[] = [],
  strict = false,
): Set<string> {
  const out = new Set(HIDDEN_FIELDS[model] ?? []);
  for (const [key, f] of Object.entries(fields)) if (f.returned === false) out.add(key);
  if (model === "user") {
    for (const name of hiddenUser) {
      if (Object.prototype.hasOwnProperty.call(fields, name)) out.add(name);
      else if (strict) {
        throw new Error(
          `auth: ember.hiddenUserFields names ${JSON.stringify(name)}, which is not a field of the user model (fields: ${Object.keys(fields).join(", ")}). ` +
            "Use the field key (as in user.additionalFields or the plugin's schema), not the column name",
        );
      }
    }
  }
  return out;
}

/** The user row without its hidden fields (what the profile sync sends). */
export function withoutHidden<T extends Record<string, unknown>>(row: T, hidden: ReadonlySet<string>): T {
  if (!hidden.size) return row;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) if (!hidden.has(k)) out[k] = v;
  return out as T;
}
