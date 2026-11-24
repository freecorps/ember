/**
 * The plugin config's tables: what codegen sees (`getAuthTables` through `authTablesManifest`) is what the Auth DO
 * migrated to, and the fields that hold secrets are marked hidden (never in `Doc<"auth:*">` reads, replicas or the
 * profile outbox).
 */
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { authTablesManifest } from "../../src/codegen.ts";
import { resolveAuthConfig } from "../../src/define.ts";
import { isAuthPath, staticSettingsOfResolved } from "../../src/settings.ts";
import config from "./auth.config.ts";
import { auth } from "./worker.ts";

const manifest = authTablesManifest(config, { project: "plug" });
const byModel = new Map(manifest.map((t) => [t.model, t]));

describe("plugin schema: codegen = the Auth DO migration", () => {
  it("every plugin table exists in the Auth DO with the manifest's columns", async () => {
    await auth.stub().stats(); // boots (migrates) the DO
    const tables = await runInDurableObject(env.AUTH.get(env.AUTH.idFromName("auth")), (_o, state) => {
      const out: Record<string, string[]> = {};
      for (const r of state.storage.sql.exec(`SELECT name FROM sqlite_master WHERE type = 'table'`).toArray()) {
        const name = String(r.name);
        out[name] = state.storage.sql.exec(`SELECT name FROM pragma_table_info(?)`, name).toArray().map((c) => String(c.name));
      }
      return out;
    });
    for (const t of manifest) {
      expect(tables[t.table], t.table).toBeDefined();
      for (const f of t.fields) expect(tables[t.table], `${t.table}.${f.column}`).toContain(f.column);
    }
    expect([...byModel.keys()]).toEqual(
      expect.arrayContaining(["passkey", "apikey", "ssoProvider", "oauthClient", "oauthAccessToken", "oauthRefreshToken", "oauthConsent", "subscription", "scimUser", "scimGroup", "deviceCode", "walletAddress"]),
    );
  });

  it("plugin fields holding secrets are hidden", () => {
    const hidden = (model: string) => byModel.get(model)!.fields.filter((f) => f.hidden).map((f) => f.name);
    expect(hidden("apikey")).toContain("key");
    expect(hidden("passkey")).toContain("publicKey");
    expect(hidden("ssoProvider")).toEqual(expect.arrayContaining(["oidcConfig", "samlConfig"]));
    expect(hidden("oauthClient")).toContain("clientSecret");
    expect(hidden("oauthAccessToken")).toContain("token");
    expect(hidden("oauthRefreshToken")).toContain("token");
    expect(hidden("scimUser")).toEqual(expect.arrayContaining(["serializedEmails", "serializedAttributes"]));
    // deviceAuthorization: the codes are credentials (the device code becomes a session once approved).
    expect(hidden("deviceCode").sort()).toEqual(["deviceCode", "userCode"]);
    expect(hidden("walletAddress")).toEqual([]);
    // The user table gains only plain fields (stripe's customer id; admin's role and ban; anonymous's flag;
    // lastLoginMethod): nothing the profile outbox must strip.
    expect(byModel.get("user")!.fields.filter((f) => f.hidden)).toEqual([]);
    expect(byModel.get("user")!.fields.map((f) => f.name)).toEqual(
      expect.arrayContaining(["stripeCustomerId", "role", "banned", "banReason", "banExpires", "isAnonymous", "lastLoginMethod"]),
    );
    expect(byModel.get("session")!.fields.map((f) => f.name)).toContain("impersonatedBy");
  });

  it("routing: the oauth-provider plugin adds the issuer metadata paths at the origin's root, nothing else", () => {
    const s = staticSettingsOfResolved(resolveAuthConfig(config, {}));
    expect(s).toMatchObject({ basePath: "/api/auth", issuerMetadata: true });
    for (const p of ["/api/auth", "/api/auth/get-session", "/.well-known/openid-configuration", "/.well-known/oauth-authorization-server"]) expect(isAuthPath(p, s), p).toBe(true);
    for (const p of ["/.well-known/other", "/api/authx", "/api/query", "/.well-known/openid-configuration/x"]) expect(isAuthPath(p, s), p).toBe(false);
    expect(isAuthPath("/.well-known/openid-configuration", { basePath: "/api/auth", cookieStrategy: "compact" })).toBe(false);
  });
});
