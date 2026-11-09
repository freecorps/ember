/** The auth config a user would write in `ember/auth.config.ts` (test flavour). */
import { apiKey } from "@better-auth/api-key";
import { emailOTP, magicLink, organization, twoFactor } from "better-auth/plugins";
import { defineAuth } from "../src/index.ts";

export type Mail = { kind: "verify" | "reset" | "invite" | "magic-link" | "otp"; email: string; token: string; url?: string };
/** Captured "sender" (same isolate as the tests). */
export const mailbox: Mail[] = [];
export const takeMail = (kind: Mail["kind"], email: string) => {
  const i = mailbox.findLastIndex((m) => m.kind === kind && m.email === email);
  if (i < 0) throw new Error(`no ${kind} mail for ${email}`);
  return mailbox.splice(i, 1)[0]!;
};

/** What the session hook wrote through a binding (the `SQLBOX` Durable Object). */
type Box = { record(entry: string): Promise<void> };

// The function form: options from the environment (a variable), hooks that reach a binding.
const config = defineAuth((env) => ({
  appName: "ember-auth-test",
  databaseHooks: {
    user: {
      create: {
        // `AUTH_TEST_BLOCKED` is a variable: a sign-up from that domain is refused before it is stored.
        async before(user: { email: string }) {
          const blocked = typeof env.AUTH_TEST_BLOCKED === "string" ? env.AUTH_TEST_BLOCKED : "";
          if (blocked && user.email.endsWith(`@${blocked}`)) return false;
          return undefined;
        },
      },
    },
    session: {
      create: {
        async after(session: { userId: string }) {
          const ns = env.SQLBOX as DurableObjectNamespace | undefined;
          if (ns) await (ns.get(ns.idFromName("hooks")) as unknown as Box).record(`session:${session.userId}`);
        },
      },
    },
  },
  emailAndPassword: {
    enabled: true,
    async sendResetPassword({ user, token, url }) {
      mailbox.push({ kind: "reset", email: user.email, token, url });
    },
  },
  emailVerification: {
    async sendVerificationEmail({ user, token, url }) {
      mailbox.push({ kind: "verify", email: user.email, token, url });
    },
  },
  user: { deleteUser: { enabled: true } },
  rateLimit: { enabled: false },
  plugins: [
    organization({
      async sendInvitationEmail(data) {
        mailbox.push({ kind: "invite", email: data.email, token: data.id });
      },
    }),
    twoFactor(),
    magicLink({
      async sendMagicLink({ email, token, url }) {
        mailbox.push({ kind: "magic-link", email, token, url });
      },
    }),
    emailOTP({
      async sendVerificationOTP({ email, otp }) {
        mailbox.push({ kind: "otp", email, token: otp });
      },
    }),
    apiKey({ enableSessionForAPIKeys: true }),
  ],
  ember: { claims: ({ user }) => ({ plan: user.email.endsWith("@vip.test") ? "vip" : "free" }) },
}));

export default config;
