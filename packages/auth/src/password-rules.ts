/**
 * The password-bearing endpoints (`password.ts`), in a module with no imports: `lazy.ts` routes with it without
 * evaluating Better Auth.
 */
export type PasswordRule = {
  /** Body fields holding new passwords (hashed in the Worker). */
  hash?: string[];
  /** Body field holding a password to verify, and how to find the stored hash. */
  verify?: { field: string; by: "email" | "session" };
};

/** Better Auth 1.7 endpoints (relative to basePath) that hash or verify passwords. */
export const PASSWORD_RULES: Record<string, PasswordRule> = {
  "/sign-up/email": { hash: ["password"] },
  "/sign-in/email": { verify: { field: "password", by: "email" } },
  "/change-password": { hash: ["newPassword"], verify: { field: "currentPassword", by: "session" } },
  "/reset-password": { hash: ["newPassword"] },
  "/delete-user": { verify: { field: "password", by: "session" } },
  "/two-factor/enable": { verify: { field: "password", by: "session" } },
  "/two-factor/disable": { verify: { field: "password", by: "session" } },
  "/two-factor/get-totp-uri": { verify: { field: "password", by: "session" } },
  "/two-factor/generate-backup-codes": { verify: { field: "password", by: "session" } },
  "/two-factor/view-backup-codes": { verify: { field: "password", by: "session" } },
  "/email-otp/reset-password": { hash: ["password"] },
  "/phone-number/reset-password": { hash: ["newPassword"] },
  "/admin/create-user": { hash: ["password"] },
  "/admin/set-user-password": { hash: ["newPassword"] },
};

/** Whether the Worker does password work for this request (`preparePasswordPlan` would build a plan). */
export const needsPasswordPlan = (method: string, route: string, rules: Record<string, PasswordRule> = PASSWORD_RULES): boolean =>
  method === "POST" && Object.prototype.hasOwnProperty.call(rules, route);
