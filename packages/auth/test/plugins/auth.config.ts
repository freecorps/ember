/**
 * An `ember/auth.config.ts` with the plugins whose flows these tests run end to end: organization, passkey, apiKey,
 * sso (OIDC + SAML), scim, oauthProvider (the project as an OAuth 2.1 / OIDC provider), stripe and expo, plus magic
 * links (the expo deep-link case). External parties are fakes in this isolate (`fakes.ts`).
 */
import { apiKey } from "@better-auth/api-key";
import { expo } from "@better-auth/expo";
import { oauthProvider } from "@better-auth/oauth-provider";
import { passkey } from "@better-auth/passkey";
import { scim } from "@better-auth/scim";
import { sso } from "@better-auth/sso";
import { stripe } from "@better-auth/stripe";
import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { magicLink, organization } from "better-auth/plugins";
import Stripe from "stripe";
import { defineAuth } from "../../src/index.ts";
import { IDP, stripeApi } from "./fakes.ts";

export const ORIGIN = "http://localhost:8787";
export const APP_SCHEME = "myapp://";
export const SCIM_ORG_SLUG = "scim-org";
export const PRICE_PRO = "price_pro_monthly";

/** Captured magic links (same isolate as the tests). */
export const magicLinks: { email: string; url: string; token: string }[] = [];

/**
 * Hooks the app wires to Ember (set by the test Worker): ending a session tells the shard's sockets at once
 * (`revokeSockets` by `sid`), and a SCIM-deprovisioned user loses every socket (by subject).
 */
export const ember = {
  revoke: null as null | ((match: { claim: "sid"; value: string } | { subject: string }) => Promise<unknown>),
  /** Users the SCIM identity hook deactivated in the current request (revoked after it commits). */
  deprovisioned: [] as string[],
};

export const stripeClient = new Stripe("sk_test_ember_fake", { httpClient: Stripe.createFetchHttpClient(stripeApi.fetch), maxNetworkRetries: 0 });

type Db = {
  findOne(q: { model: string; where: { field: string; value: unknown }[] }): Promise<Record<string, unknown> | null>;
  create(q: { model: string; data: Record<string, unknown> }): Promise<unknown>;
  update(q: { model: string; where: { field: string; value: unknown }[]; update: Record<string, unknown> }): Promise<unknown>;
  delete(q: { model: string; where: { field: string; value: unknown }[] }): Promise<void>;
  deleteMany(q: { model: string; where: { field: string; value: unknown }[] }): Promise<number>;
};

export default defineAuth((env) => ({
  appName: "ember-plugins-test",
  emailAndPassword: { enabled: true },
  rateLimit: { enabled: false },
  // The fake IdP serves OIDC over https (sso checks its endpoints against the trusted origins); the app scheme is the
  // Expo client's.
  trustedOrigins: [ORIGIN, IDP, APP_SCHEME],
  databaseHooks: {
    session: {
      delete: {
        async after(session: { id: string }) {
          await ember.revoke?.({ claim: "sid", value: session.id });
        },
      },
    },
  },
  hooks: {
    after: createAuthMiddleware(async (ctx) => {
      if (!ctx.path?.startsWith("/scim/v2/Users") || ember.deprovisioned.length === 0) return;
      for (const subject of ember.deprovisioned.splice(0)) await ember.revoke?.({ subject });
    }),
  },
  plugins: [
    organization(),
    passkey({ rpID: "localhost", rpName: "Ember plugins test", origin: ORIGIN }),
    apiKey({ enableSessionForAPIKeys: true }),
    sso({ trustEmailVerified: true, organizationProvisioning: { disabled: false, defaultRole: "member" } }),
    // Its schema type marks the optional managed-connection tables `| undefined`, which this repo's
    // `exactOptionalPropertyTypes` rejects against `BetterAuthPlugin`: the value is fine.
    scim({
      connections: [
        {
          id: "directory",
          credentials: [{ type: "bearer", id: "primary", token: String(env.SCIM_TOKEN ?? "scim-test-token-0123456789") }],
        },
      ],
      identity: {
        // Deactivated or deleted in the directory: the sessions end inside the SCIM transaction; the sockets are told
        // once it has committed (the `hooks.after` above).
        async reconcileUser({ userId, active }, { database }) {
          if (active) return;
          await (database as unknown as Db).deleteMany({ model: "session", where: [{ field: "userId", value: userId }] });
          ember.deprovisioned.push(userId);
        },
      },
      projection: {
        roles: {
          map: ({ source }) => (source.displayName === "Admins" ? ["admin"] : source.displayName === "Engineers" ? ["member"] : undefined),
          exists: ({ role }) => role === "admin" || role === "member",
        },
        // Directory groups → membership of one organization (what "SCIM provisions the org" means for this app).
        async reconcileUser({ userId, active, grants }, { database }) {
          const db = database as unknown as Db;
          const org = await db.findOne({ model: "organization", where: [{ field: "slug", value: SCIM_ORG_SLUG }] });
          if (!org) return;
          const where = [{ field: "organizationId", value: org.id }, { field: "userId", value: userId }];
          const member = await db.findOne({ model: "member", where });
          const roles = new Set(grants.map((g) => g.role));
          const role = roles.has("admin") ? "admin" : roles.has("member") ? "member" : null;
          if (!active || !role) {
            if (member) await db.delete({ model: "member", where: [{ field: "id", value: member.id }] });
          } else if (!member) {
            await db.create({ model: "member", data: { organizationId: org.id, userId, role, createdAt: new Date() } });
          } else if (member.role !== role) {
            await db.update({ model: "member", where: [{ field: "id", value: member.id }], update: { role } });
          }
        },
      },
    }) as unknown as BetterAuthPlugin,
    oauthProvider({ loginPage: "/sign-in", consentPage: "/consent", allowDynamicClientRegistration: false }),
    stripe({
      stripeClient,
      stripeWebhookSecret: String(env.STRIPE_WEBHOOK_SECRET ?? "whsec_test_ember_plugins"),
      createCustomerOnSignUp: true,
      subscription: { enabled: true, plans: [{ name: "pro", priceId: PRICE_PRO }] },
    }),
    expo(),
    magicLink({
      async sendMagicLink({ email, url, token }) {
        magicLinks.push({ email, url, token });
      },
    }),
  ],
}));
