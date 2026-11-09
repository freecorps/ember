import { env, runInDurableObject } from "cloudflare:test";
import { admin, jwt, twoFactor, username } from "better-auth/plugins";
import { describe, expect, it } from "vitest";
import {
  assertNoReservedTables,
  authSchemaSQL,
  authTablesManifest,
  AuthMigrationError,
  defineAuth,
  migrate,
  planMigration,
  resolveAuthConfig,
  resolveAuthOptions,
} from "../src/index.ts";
import config from "./auth.config.ts";

describe("defineAuth / resolveAuthOptions", () => {
  it("the function form is called with the env it is resolved for; codegen calls it with an empty one", () => {
    const seen: unknown[] = [];
    const cfg = defineAuth((e) => {
      seen.push(e);
      return { appName: typeof e.APP === "string" ? e.APP : "none", emailAndPassword: { enabled: true } };
    });
    expect(resolveAuthConfig(cfg, { APP: "acme" })).toMatchObject({ appName: "acme", __emberAuth: true });
    expect(authTablesManifest(cfg, { project: "acme" }).map((t) => t.model)).toEqual(expect.arrayContaining(["user", "session", "account"]));
    expect(seen).toEqual([{ APP: "acme" }, {}]);
    expect(() => resolveAuthConfig(defineAuth(() => ({ secret: "x" }) as never), {})).toThrow(/managed by Ember/);
    // The value form is returned as is.
    const value = defineAuth({ appName: "v" });
    expect(resolveAuthConfig(value, { APP: "acme" })).toBe(value);
  });

  it("rejects options Ember manages", () => {
    expect(() => defineAuth({ secret: "x" } as never)).toThrow(/managed by Ember/);
    expect(() => defineAuth({ database: {} } as never)).toThrow(/managed by Ember/);
    expect(() => resolveAuthOptions(defineAuth({ plugins: [jwt()] }), { project: "p" })).toThrow(/jwt\(\) plugin/);
    expect(() => resolveAuthOptions(defineAuth({}), { project: "Bad Name" })).toThrow(/project name/);
  });

  it("injects jwt + bearer, cookie prefix, cookie cache and database rate limits", () => {
    const o = resolveAuthOptions(resolveAuthConfig(config, {}), { project: "acme" });
    expect(o.plugins!.map((p) => p.id)).toEqual(expect.arrayContaining(["jwt", "bearer", "organization", "two-factor", "api-key"]));
    expect(o.advanced?.cookiePrefix).toBe("acme");
    expect(o.session?.cookieCache).toMatchObject({ enabled: true, strategy: "compact", maxAge: 300 });
    expect(o.rateLimit?.storage).toBe("database");
    expect("ember" in o).toBe(false);
  });
});

describe("codegen", () => {
  it("authTablesManifest returns read-only auth:* descriptors", () => {
    const m = authTablesManifest(config, { project: "acme" });
    const names = m.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(["auth:user", "auth:session", "auth:account", "auth:verification", "auth:jwks", "auth:organization", "auth:member", "auth:invitation", "auth:twoFactor", "auth:apikey", "auth:rateLimit"]),
    );
    expect(m.every((t) => t.readOnly && t.idType === "string")).toBe(true);
    const field = (t: string, f: string) => m.find((x) => x.name === t)!.fields.find((x) => x.name === f)!;
    expect(field("auth:account", "password").hidden).toBe(true);
    expect(field("auth:jwks", "privateKey").hidden).toBe(true);
    expect(field("auth:user", "email")).toMatchObject({ type: "string", unique: true, optional: false, hidden: false });
    expect(field("auth:user", "twoFactorEnabled").optional).toBe(true);
    expect(field("auth:member", "userId").references).toBe("auth:user");
    expect(field("auth:session", "activeOrganizationId").optional).toBe(true);
    expect(authSchemaSQL(config).some((s) => s.startsWith(`CREATE TABLE IF NOT EXISTS "jwks"`))).toBe(true);
  });

  it("rejects reserved user table names", () => {
    expect(() => assertNoReservedTables(["messages", "profiles"], config)).not.toThrow();
    expect(() => assertNoReservedTables(["messages", "user"])).toThrow(/reserved for auth: user/);
    expect(() => assertNoReservedTables(["passkey"])).toThrow(/passkey/); // reserved even if the plugin is off
    expect(() => assertNoReservedTables(["auth:anything"])).toThrow(/auth:anything/);
    const renamed = defineAuth({ emailAndPassword: { enabled: true }, user: { modelName: "people" } });
    expect(() => assertNoReservedTables(["people"], renamed)).toThrow(/people/);
  });
});

describe("Auth DO migrations", () => {
  const box = () => env.SQLBOX.get(env.SQLBOX.idFromName(`migrations-${crypto.randomUUID()}`));
  const opts = (c: Parameters<typeof defineAuth>[0]) => resolveAuthOptions(defineAuth(c), { project: "acme" });

  it("adds tables and columns when plugins are added, idempotently", async () => {
    await runInDurableObject(box(), (_i, state) => {
      const sql = state.storage.sql;
      migrate(sql, opts({ emailAndPassword: { enabled: true } }));
      sql.exec(`INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('u1', 'A', 'a@x', 0, '2026-01-01', '2026-01-01')`);
      const next = opts({ emailAndPassword: { enabled: true }, plugins: [twoFactor(), admin(), username()] });
      const applied = migrate(sql, next);
      expect(applied.some((s) => s.startsWith(`CREATE TABLE IF NOT EXISTS "twoFactor"`))).toBe(true);
      expect(applied).toEqual(expect.arrayContaining([expect.stringMatching(/ALTER TABLE "user" ADD COLUMN "twoFactorEnabled" INTEGER DEFAULT 0/)]));
      expect(applied).toEqual(expect.arrayContaining([expect.stringMatching(/ALTER TABLE "session" ADD COLUMN "impersonatedBy"/)]));
      // UNIQUE on an added column becomes a unique index.
      expect(applied).toEqual(expect.arrayContaining([expect.stringMatching(/CREATE UNIQUE INDEX IF NOT EXISTS "user_username_unique"/)]));
      // Existing data survives; second run adds nothing.
      expect(sql.exec(`SELECT email, twoFactorEnabled FROM "user"`).toArray()).toEqual([{ email: "a@x", twoFactorEnabled: 0 }]);
      expect(planMigration(sql, next).statements.filter((s) => !s.startsWith("CREATE"))).toEqual([]);
      sql.exec(`UPDATE "user" SET username = 'a' WHERE id = 'u1'`);
      sql.exec(`INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('u2', 'B', 'b@x', 0, '2026-01-01', '2026-01-01')`);
      expect(() => sql.exec(`UPDATE "user" SET username = 'a' WHERE id = 'u2'`)).toThrow(/UNIQUE/);
    });
  });

  it("refuses destructive changes and changes nothing", async () => {
    await runInDurableObject(box(), (_i, state) => {
      const sql = state.storage.sql;
      const base = { emailAndPassword: { enabled: true }, user: { additionalFields: { age: { type: "number" as const, required: false } } } };
      migrate(sql, opts(base));
      sql.exec(`INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('u1', 'A', 'a@x', 0, '2026-01-01', '2026-01-01')`);
      // type change
      expect(() => migrate(sql, opts({ ...base, user: { additionalFields: { age: { type: "string" as const, required: false } } } }))).toThrow(AuthMigrationError);
      // new required column without default on a non-empty table
      expect(() => migrate(sql, opts({ ...base, user: { additionalFields: { age: { type: "number" as const, required: false }, plan: { type: "string" as const, required: true } } } }))).toThrow(
        /new required column without a default/,
      );
      // ...but with a literal default it is additive
      const ok = migrate(sql, opts({ ...base, user: { additionalFields: { age: { type: "number" as const, required: false }, plan: { type: "string" as const, required: true, defaultValue: "free" } } } }));
      expect(ok).toEqual(expect.arrayContaining([`ALTER TABLE "user" ADD COLUMN "plan" TEXT DEFAULT 'free'`]));
      expect(sql.exec(`SELECT plan FROM "user"`).toArray()).toEqual([{ plan: "free" }]);
      // removing a NOT NULL column
      expect(() => migrate(sql, opts({ emailAndPassword: { enabled: true }, user: { fields: { email: "mail" } } }))).toThrow(/NOT NULL column removed/);
      expect(sql.exec(`SELECT count(*) AS n FROM "user"`).one()).toEqual({ n: 1 });
    });
  });

  it("the Auth DO migrates on boot and records the schema fingerprint", async () => {
    const stub = env.AUTH.get(env.AUTH.idFromName(`boot-${crypto.randomUUID()}`));
    const s = await (stub as unknown as { stats(): Promise<{ migration: string[] }> }).stats();
    expect(s.migration.some((x) => x.startsWith(`CREATE TABLE IF NOT EXISTS "user"`))).toBe(true);
    await runInDurableObject(stub, (_i, state) => {
      expect(state.storage.sql.exec(`SELECT key FROM "_ember_auth_meta"`).toArray()).toEqual([{ key: "schema" }]);
      // Foreign keys are on in the Auth DO.
      expect(state.storage.sql.exec(`PRAGMA foreign_key_list("session")`).toArray().length).toBe(1);
    });
  });
});
