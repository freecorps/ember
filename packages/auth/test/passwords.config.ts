/**
 * A second auth config (value form) for the password-endpoint flows: the `username()` and `phoneNumber()` plugins, and
 * a tiny third-party plugin ("vault") with its own password endpoint and a secret on the user row, declared through
 * `ember.passwordRules` and `ember.hiddenUserFields`. Runs in its own Auth DO (`AUTH_PW`) with `strictHashing`.
 */
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, sessionMiddleware } from "better-auth/api";
import { phoneNumber, username } from "better-auth/plugins";
import { defineAuth, type EmberAuthConfig } from "../src/index.ts";

/** OTPs the phoneNumber() plugin "sent" (same isolate as the tests). */
export const smsbox: { phoneNumber: string; code: string }[] = [];

type Ctx = {
  context: {
    password: { hash(p: string): Promise<string>; verify(d: { hash: string; password: string }): Promise<boolean> };
    internalAdapter: {
      findUserByEmail(email: string): Promise<{ user: { id: string } } | null>;
      findCredentialAccount(userId: string): Promise<{ password?: string | null } | null>;
      updateUser(userId: string, data: Record<string, unknown>): Promise<unknown>;
    };
    session: { user: { id: string } };
  };
};

/** "Unlock the vault": re-checks the account password under another body field (`secret`). */
const vault = (): BetterAuthPlugin => ({
  id: "vault",
  schema: { user: { fields: { vaultSecret: { type: "string", required: false, input: false } } } },
  endpoints: {
    vaultUnlock: createAuthEndpoint("/vault/unlock", { method: "POST" }, async (c) => {
      const ctx = c as unknown as Ctx & { body: { email?: unknown; secret?: unknown } };
      if (typeof ctx.body.email !== "string" || typeof ctx.body.secret !== "string") throw new APIError("BAD_REQUEST", { message: "email and secret" });
      const body = { email: ctx.body.email, secret: ctx.body.secret };
      const found = await ctx.context.internalAdapter.findUserByEmail(body.email.toLowerCase());
      const stored = found ? (await ctx.context.internalAdapter.findCredentialAccount(found.user.id))?.password : null;
      if (!stored) {
        await ctx.context.password.hash(body.secret);
        throw new APIError("UNAUTHORIZED", { message: "locked" });
      }
      if (!(await ctx.context.password.verify({ hash: stored, password: body.secret }))) throw new APIError("UNAUTHORIZED", { message: "locked" });
      return c.json({ unlocked: true });
    }),
    vaultStore: createAuthEndpoint("/vault/store", { method: "POST", use: [sessionMiddleware] }, async (c) => {
      const ctx = c as unknown as Ctx & { body: { value?: unknown } };
      await ctx.context.internalAdapter.updateUser(ctx.context.session.user.id, { vaultSecret: String(ctx.body.value) });
      return c.json({ stored: true });
    }),
  },
});

const config: EmberAuthConfig = defineAuth({
  appName: "ember-auth-passwords",
  emailAndPassword: { enabled: true },
  rateLimit: { enabled: false },
  plugins: [username(), phoneNumber({ sendOTP: (m) => void smsbox.push(m) }), vault()],
  ember: {
    passwordRules: { "/vault/unlock": { verify: { field: "secret", by: "email" } } },
    hiddenUserFields: ["vaultSecret"],
  },
});

export default config;
