/** `defineAuth`'s `ember.passwordRules` / `ember.hiddenUserFields`: validation, static settings, the hidden rule. */
import { describe, expect, it } from "vitest";
import type { BetterAuthPlugin } from "better-auth";
import { authReplicaSpec, authStaticSettings, authTablesManifest, defineAuth, userJournalDDL } from "../../src/index.ts";
import { sameStaticSettings } from "../../src/settings.ts";
import { codegenOptions } from "../../src/codegen.ts";

const secretPlugin = { id: "vault", schema: { user: { fields: { vaultSecret: { type: "string", required: false } } } } } as unknown as BetterAuthPlugin;
const bad = (ember: unknown) => () => defineAuth({ emailAndPassword: { enabled: true }, ember: ember as never });

describe("defineAuth: ember.passwordRules", () => {
  it("accepts rules by email, username, phoneNumber and session, with keyField", () => {
    expect(() =>
      defineAuth({
        ember: {
          passwordRules: {
            "/a": { hash: ["password"] },
            "/b": { verify: { field: "secret", by: "email", keyField: "login" } },
            "/c": { hash: ["newPassword"], verify: { field: "current", by: "session" } },
            "/d": { verify: { field: "pin", by: "username" } },
            "/e": { verify: { field: "pin", by: "phoneNumber" } },
          },
        },
      }),
    ).not.toThrow();
  });

  it("refuses malformed rules with a message naming the entry", () => {
    expect(bad({ passwordRules: [] })).toThrow(/ember\.passwordRules: must be an object of rules by endpoint path/);
    expect(bad({ passwordRules: { "my/sign-in": { hash: ["password"] } } })).toThrow(/rule "my\/sign-in": the key is the endpoint path relative to basePath and starts with "\/"/);
    expect(bad({ passwordRules: { "/x": {} } })).toThrow(/rule "\/x" needs hash and\/or verify/);
    expect(bad({ passwordRules: { "/x": { hash: "password" } } })).toThrow(/rule "\/x": hash must be an array of body field names/);
    expect(bad({ passwordRules: { "/x": { verify: { field: "password", by: "nickname" } } } })).toThrow(/verify\.by must be one of "email", "username", "phoneNumber", "session" \(got "nickname"\)/);
    expect(bad({ passwordRules: { "/x": { verify: { by: "email" } } } })).toThrow(/verify\.field must be the body field holding the password/);
    expect(bad({ passwordRules: { "/x": { verify: { field: "p", by: "email", key: "login" } } } })).toThrow(/verify has an unknown key "key"/);
    expect(bad({ passwordRules: { "/x": { hash: ["p"], check: true } } })).toThrow(/unknown key "check"/);
  });

  it("travels in the static settings (what the CLI embeds) and takes part in the build/runtime comparison", () => {
    const rules = { "/vault/unlock": { verify: { field: "secret", by: "email" as const } } };
    const s = authStaticSettings(defineAuth({ emailAndPassword: { enabled: true }, ember: { passwordRules: rules } }))!;
    expect(s.worker).toEqual({ hasher: "default", passwordRules: rules });
    const without = authStaticSettings(defineAuth({ emailAndPassword: { enabled: true } }))!;
    expect(without.worker).toEqual({ hasher: "default" });
    expect(sameStaticSettings(s, without)).toBe(false);
  });
});

describe("defineAuth: ember.hiddenUserFields", () => {
  it("must be an array of names", () => {
    expect(bad({ hiddenUserFields: "vaultSecret" })).toThrow(/ember\.hiddenUserFields must be an array of user field names/);
    expect(bad({ hiddenUserFields: [""] })).toThrow(/hiddenUserFields/);
  });

  it("hides the field from auth:user and its replica; a name that is not a user field fails at codegen", async () => {
    const { organization } = await import("better-auth/plugins");
    const cfg = defineAuth({ plugins: [organization(), secretPlugin], ember: { hiddenUserFields: ["vaultSecret"], replicate: { organization: true } } });
    const user = authTablesManifest(cfg).find((t) => t.model === "user")!;
    expect(user.fields.find((f) => f.name === "vaultSecret")?.hidden).toBe(true);
    expect(user.fields.find((f) => f.name === "email")?.hidden).toBe(false);
    const replica = authReplicaSpec(cfg)!.tables.find((t) => t.model === "user")!;
    expect(replica.fields.map((f) => f.name)).not.toContain("vaultSecret");
    expect(Object.keys(replica.columns)).not.toContain("vaultSecret");

    const typo = defineAuth({ plugins: [secretPlugin], ember: { hiddenUserFields: ["vault_secret"] } });
    expect(() => authTablesManifest(typo)).toThrow(/hiddenUserFields names "vault_secret", which is not a field of the user model/);
  });

  it("the user journal's delete row leaves hidden fields out", () => {
    const options = codegenOptions(defineAuth({ plugins: [secretPlugin] }));
    const plain = userJournalDDL(options).join("\n");
    expect(plain).toContain("'vaultSecret'");
    const hidden = userJournalDDL(options, new Set(["vaultSecret"])).join("\n");
    expect(hidden).not.toContain("vaultSecret");
    expect(hidden).toContain("'email'");
  });
});
