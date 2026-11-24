/**
 * The password-bearing endpoints (`password.ts`), in a module with no imports: `lazy.ts` routes with it without
 * evaluating Better Auth.
 */

/**
 * How the Worker finds the stored hash to verify against (`Auth.credentialHash`):
 * - `email`: the user with that email (body field `email`), as `findUserByEmail`;
 * - `username`: the user with that username (body field `username`), normalized as the `username()` plugin does
 *   (its `usernameNormalization`, default lowercase);
 * - `phoneNumber`: the user with that phone number (body field `phoneNumber`), as the `phoneNumber()` plugin;
 * - `session`: the signed-in user (the request's cookie or bearer).
 */
export type CredentialKey = "email" | "username" | "phoneNumber" | "session";
export const CREDENTIAL_KEYS: readonly CredentialKey[] = ["email", "username", "phoneNumber", "session"];

export type PasswordRule = {
  /** Body fields holding new passwords (hashed in the Worker). */
  hash?: string[];
  /**
   * Body field holding a password to verify, and how to find the stored hash. `keyField`: the body field holding the
   * email / username / phone number when it is not named after `by` (ignored for `session`).
   */
  verify?: { field: string; by: CredentialKey; keyField?: string };
};

/**
 * Better Auth 1.7 endpoints (relative to basePath) that hash or verify passwords. `test/node/password-rules-audit.test.ts`
 * scans the installed Better Auth for endpoints that call `password.hash` / `password.verify` (or the helpers that do)
 * and fails on one missing here.
 */
export const PASSWORD_RULES: Record<string, PasswordRule> = {
  "/sign-up/email": { hash: ["password"] },
  "/sign-in/email": { verify: { field: "password", by: "email" } },
  "/change-password": { hash: ["newPassword"], verify: { field: "currentPassword", by: "session" } },
  "/reset-password": { hash: ["newPassword"] },
  "/delete-user": { verify: { field: "password", by: "session" } },
  // `scope: "server"` only hides it from the client and the OpenAPI schema: it is routed over HTTP.
  "/verify-password": { verify: { field: "password", by: "session" } },
  "/two-factor/enable": { verify: { field: "password", by: "session" } },
  "/two-factor/disable": { verify: { field: "password", by: "session" } },
  "/two-factor/get-totp-uri": { verify: { field: "password", by: "session" } },
  "/two-factor/generate-backup-codes": { verify: { field: "password", by: "session" } },
  // Server-only since 1.7 (kept for older minors, where it was routed).
  "/two-factor/view-backup-codes": { verify: { field: "password", by: "session" } },
  "/email-otp/reset-password": { hash: ["password"] },
  "/sign-in/username": { verify: { field: "password", by: "username" } },
  "/sign-in/phone-number": { verify: { field: "password", by: "phoneNumber" } },
  "/phone-number/reset-password": { hash: ["newPassword"] },
  "/admin/create-user": { hash: ["password"] },
  "/admin/set-user-password": { hash: ["newPassword"] },
};

/** Whether the Worker does password work for this request (`preparePasswordPlan` would build a plan). */
export const needsPasswordPlan = (method: string, route: string, rules: Record<string, PasswordRule> = PASSWORD_RULES): boolean =>
  method === "POST" && Object.prototype.hasOwnProperty.call(rules, route);

const isName = (x: unknown): x is string => typeof x === "string" && x.length > 0;

/**
 * Checks `ember.passwordRules` (auth.config.ts) or `emberAuth({ passwordRules })`: plain data, embedded in the Worker
 * entry by the CLI. Throws a message naming the bad entry; answers the rules as given.
 */
export function assertPasswordRules(rules: unknown, where: string): Record<string, PasswordRule> {
  const fail = (msg: string): never => {
    throw new Error(`${where}: ${msg}`);
  };
  if (typeof rules !== "object" || rules === null || Array.isArray(rules)) fail(`must be an object of rules by endpoint path, like { "/my-plugin/sign-in": { verify: { field: "password", by: "email" } } }`);
  for (const [path, rule] of Object.entries(rules as Record<string, unknown>)) {
    const at = `rule ${JSON.stringify(path)}`;
    if (!path.startsWith("/")) fail(`${at}: the key is the endpoint path relative to basePath and starts with "/" (like "/sign-in/email")`);
    if (typeof rule !== "object" || rule === null || Array.isArray(rule)) fail(`${at} must be an object { hash?, verify? }`);
    const r = rule as Record<string, unknown>;
    for (const k of Object.keys(r)) if (k !== "hash" && k !== "verify") fail(`${at}: unknown key ${JSON.stringify(k)} (expected hash and/or verify)`);
    if (r.hash === undefined && r.verify === undefined) fail(`${at} needs hash and/or verify`);
    if (r.hash !== undefined && (!Array.isArray(r.hash) || !r.hash.every(isName))) fail(`${at}: hash must be an array of body field names`);
    if (r.verify !== undefined) {
      const v = r.verify as Record<string, unknown> | null;
      if (typeof v !== "object" || v === null || Array.isArray(v)) fail(`${at}: verify must be { field, by, keyField? }`);
      for (const k of Object.keys(v!)) if (k !== "field" && k !== "by" && k !== "keyField") fail(`${at}: verify has an unknown key ${JSON.stringify(k)} (expected field, by, keyField)`);
      if (!isName(v!.field)) fail(`${at}: verify.field must be the body field holding the password`);
      if (!CREDENTIAL_KEYS.includes(v!.by as CredentialKey)) fail(`${at}: verify.by must be one of ${CREDENTIAL_KEYS.map((k) => JSON.stringify(k)).join(", ")} (got ${JSON.stringify(v!.by)})`);
      if (v!.keyField !== undefined && !isName(v!.keyField)) fail(`${at}: verify.keyField must be a body field name`);
    }
  }
  return rules as Record<string, PasswordRule>;
}
