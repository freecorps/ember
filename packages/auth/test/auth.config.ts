/** The auth config a user would write in `ember/auth.config.ts` (test flavour). */
import { apiKey } from "@better-auth/api-key";
import { emailOTP, magicLink, organization, twoFactor } from "better-auth/plugins";
import { defineAuth, type EmberAuthConfig } from "../src/index.ts";

export type Mail = { kind: "verify" | "reset" | "invite" | "magic-link" | "otp"; email: string; token: string; url?: string };
/** Captured "sender" (same isolate as the tests). */
export const mailbox: Mail[] = [];
export const takeMail = (kind: Mail["kind"], email: string) => {
  const i = mailbox.findLastIndex((m) => m.kind === kind && m.email === email);
  if (i < 0) throw new Error(`no ${kind} mail for ${email}`);
  return mailbox.splice(i, 1)[0]!;
};

const config: EmberAuthConfig = defineAuth({
  appName: "ember-auth-test",
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
});

export default config;
