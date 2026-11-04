/**
 * The user's auth config, as our engine would see it (e.g. `auth.config.ts`).
 *
 * It is a pure function of "runtime hooks" so the CLI can evaluate it at
 * codegen time WITHOUT a database (to compute the merged table schema with
 * `getAuthTables(options)`), and the auth DO can evaluate it at runtime with a
 * database adapter attached.
 */
import type { BetterAuthOptions } from "better-auth";
import { organization, jwt, bearer, twoFactor } from "better-auth/plugins";

export const JWT_ISSUER = "http://localhost:8787";
export const JWT_AUDIENCE = "spike";

export type AuthRuntimeHooks = {
  /** Called by organization plugin when an invitation is created. */
  onInvitation?: (data: { id: string; email: string; organizationId: string }) => void;
  /** Called when Better Auth wants to send a verification email. */
  onVerificationEmail?: (data: { email: string; token: string; url: string }) => void;
  /** Override password hashing (e.g. offload to a stateless Worker). */
  password?: {
    hash: (password: string) => Promise<string>;
    verify: (data: { hash: string; password: string }) => Promise<boolean>;
  };
};

export const authConfig = (hooks: AuthRuntimeHooks = {}) =>
  ({
    appName: "spike",
    baseURL: "http://localhost:8787",
    basePath: "/api/auth",
    secret: "spike-secret-spike-secret-spike-secret-0123456789",
    emailAndPassword: {
      enabled: true,
      ...(hooks.password ? { password: hooks.password } : {}),
    },
    emailVerification: {
      async sendVerificationEmail({ user, token, url }) {
        hooks.onVerificationEmail?.({ email: user.email, token, url });
      },
    },
    session: {
      // Signed cookie carrying session+user; lets the Worker validate the
      // session without touching the auth DO for `maxAge` seconds.
      cookieCache: { enabled: true, maxAge: 5 * 60, strategy: "compact" },
    },
    plugins: [
      organization({
        async sendInvitationEmail(data) {
          hooks.onInvitation?.({
            id: data.id,
            email: data.email,
            organizationId: data.organization.id,
          });
        },
      }),
      jwt({
        jwt: { expirationTime: "15m", issuer: JWT_ISSUER, audience: JWT_AUDIENCE },
      }),
      bearer(),
      twoFactor(),
    ],
  }) satisfies BetterAuthOptions;
