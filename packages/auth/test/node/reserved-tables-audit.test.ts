/**
 * Guard for `RESERVED_AUTH_TABLES`: every model that Better Auth core and the first-party plugins this package depends
 * on create (with every option that adds a table turned on) must be on the static list, so an app table can never take
 * a name a plugin enabled later would need. Enabled plugins are also checked against the config itself
 * (`assertNoReservedTables(names, config)`); this covers the ones that are off today. A Better Auth bump that adds a
 * model fails here until the list has it.
 */
import { apiKey } from "@better-auth/api-key";
import { expo } from "@better-auth/expo";
import { oauthProvider } from "@better-auth/oauth-provider";
import { passkey } from "@better-auth/passkey";
import { scim } from "@better-auth/scim";
import { sso } from "@better-auth/sso";
import { stripe } from "@better-auth/stripe";
import type { BetterAuthPlugin } from "better-auth";
import * as P from "better-auth/plugins";
import Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { authTablesManifest, RESERVED_AUTH_TABLES } from "../../src/codegen.ts";
import { defineAuth } from "../../src/define.ts";

const noop = async () => {};

const plugins = [
  P.organization({ teams: { enabled: true }, dynamicAccessControl: { enabled: true } }),
  P.twoFactor(),
  P.admin(),
  P.username(),
  P.phoneNumber({ sendOTP: noop }),
  P.anonymous(),
  P.deviceAuthorization(),
  P.siwe({ domain: "example.com", getNonce: async () => "nonce", verifyMessage: async () => true }),
  P.magicLink({ sendMagicLink: noop }),
  P.emailOTP({ sendVerificationOTP: noop }),
  P.multiSession(),
  P.oneTimeToken(),
  P.lastLoginMethod({ storeInDatabase: true }),
  P.genericOAuth({ config: [] }),
  passkey(),
  apiKey(),
  sso(),
  // Its schema type marks the optional managed-connection tables `| undefined` (see test/plugins/auth.config.ts).
  scim({
    connections: [{ id: "directory", credentials: [{ type: "bearer", id: "primary", token: "scim-test-token-0123456789" }] }],
    managedConnections: { credentialHashSecret: "scim-managed-credential-hash-secret-0123456789" },
  }) as unknown as BetterAuthPlugin,
  oauthProvider({ loginPage: "/sign-in", consentPage: "/consent" }),
  stripe({ stripeClient: new Stripe("sk_test_ember_fake"), stripeWebhookSecret: "whsec_fake", subscription: { enabled: true, plans: [] } }),
  expo(),
] as BetterAuthPlugin[];

describe("RESERVED_AUTH_TABLES covers every first-party model", () => {
  it("each model of core + every plugin with its table-adding options is reserved", () => {
    const config = defineAuth({ emailAndPassword: { enabled: true }, rateLimit: { storage: "database" }, plugins });
    const models = authTablesManifest(config).map((t) => t.model);
    // Sanity: the config really produced the plugin tables (a broken option would make this guard pass vacuously).
    expect(models).toEqual(expect.arrayContaining(["rateLimit", "organizationRole", "walletAddress", "deviceCode", "scimUser", "scimManagedConnection", "oauthResource", "subscription"]));
    const reserved = new Set<string>(RESERVED_AUTH_TABLES);
    expect(models.filter((m) => !reserved.has(m))).toEqual([]);
  });
});
