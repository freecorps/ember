import { env, runInDurableObject } from "cloudflare:test";
import { admin, jwt, organization, twoFactor, username } from "better-auth/plugins";
import { describe, expect, it } from "vitest";
import {
  assertNoReservedTables,
  authReplicaSpec,
  authReplicaTables,
  authSchemaSQL,
  codegenOptions,
  replicaJournalDDL,
  replicaJournalDropDDL,
  REPLICA_JOURNAL_TABLE,
  REPLICATED_MODELS,
  authTablesManifest,
  AuthMigrationError,
  defineAuth,
  migrate,
  planMigration,
  resolveAuthConfig,
  resolveAuthOptions,
  tableSpecs,
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

  it("user(createdAt) is indexed in the Auth DO (the dashboard's newest-first page), also on a database from before it", async () => {
    await runInDurableObject(box(), (_i, state) => {
      const sql = state.storage.sql;
      const o = opts({ emailAndPassword: { enabled: true } });
      migrate(sql, o);
      const plan = () => sql.exec(`EXPLAIN QUERY PLAN SELECT * FROM "user" ORDER BY "createdAt" DESC LIMIT 50 OFFSET 0`).toArray().map((r) => String(r.detail));
      expect(plan().join(" ")).toMatch(/USING INDEX user_createdAt_idx/);
      expect(plan().join(" ")).not.toMatch(/TEMP B-TREE/);
      // A database created before the index: the next migration adds it, and nothing else.
      sql.exec(`DROP INDEX "user_createdAt_idx"`);
      expect(planMigration(sql, o).statements.filter((x) => !/^CREATE (UNIQUE )?INDEX IF NOT EXISTS/.test(x))).toEqual([]);
      expect(migrate(sql, o)).toContain(`CREATE INDEX IF NOT EXISTS "user_createdAt_idx" ON "user" ("createdAt")`);
      expect(plan().join(" ")).toMatch(/USING INDEX user_createdAt_idx/);
    });
    // Not part of the specs codegen and the org shards' replicas read.
    expect(tableSpecs(opts({ emailAndPassword: { enabled: true } })).find((t) => t.key === "user")!.indexes.map((i) => i.name)).not.toContain("user_createdAt_idx");
  });

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

describe("organization replication (PLAN §22 L3)", () => {
  const withOrgs = (replicate: unknown = { organization: true }) =>
    defineAuth({ emailAndPassword: { enabled: true }, plugins: [organization({ teams: { enabled: true } }), twoFactor()], ember: { replicate: replicate as never } });

  it("authReplicaSpec: the org tables and users, visible fields only, indexed by reference / unique / Better Auth index", () => {
    expect(authReplicaSpec(defineAuth({ emailAndPassword: { enabled: true } }))).toBeNull();
    const spec = authReplicaSpec(withOrgs())!;
    expect(spec.shardKind).toBe("org");
    expect(spec.tables.map((t) => t.name)).toEqual(["auth:organization", "auth:member", "auth:invitation", "auth:team", "auth:teamMember", "auth:user"]);
    // The same models the triggers journal, and the journal they write (the runtime reads both from the spec).
    expect(spec.tables.map((t) => t.model)).toEqual([...REPLICATED_MODELS]);
    expect(spec.journal).toBe(REPLICA_JOURNAL_TABLE);
    const user = spec.tables.find((t) => t.model === "user")!;
    // twoFactor adds `twoFactorEnabled` (visible); secrets live in its own table, which is not replicated.
    expect(user.fields.map((f) => f.name)).toEqual(expect.arrayContaining(["name", "email", "emailVerified", "twoFactorEnabled"]));
    expect(user.indexes).toContainEqual({ name: "by_email", fields: ["email"] });
    const member = spec.tables.find((t) => t.model === "member")!;
    expect(member.indexes).toEqual(expect.arrayContaining([{ name: "by_userId", fields: ["userId"] }, { name: "by_organizationId", fields: ["organizationId"] }]));
    expect(member.columns.createdAt).toEqual({ column: "createdAt", kind: "date" });
    // Hidden fields stay in the Auth DO.
    expect(spec.tables.find((t) => t.model === "team")!.fields.map((f) => f.name)).not.toContain("memberCount");
    expect(authReplicaSpec(withOrgs({ organization: { shard: "tenant" } }))!.shardKind).toBe("tenant");
    expect(authReplicaSpec(withOrgs())!.version).toBe(spec.version);
    expect(authReplicaSpec(withOrgs({ organization: { shard: "tenant" } }))!.version).not.toBe(spec.version);
    // A replicated field added (or removed) changes the fingerprint too: every organization is resynced.
    const withField = defineAuth({
      emailAndPassword: { enabled: true },
      plugins: [organization({ teams: { enabled: true }, schema: { organization: { additionalFields: { plan: { type: "string", required: false } } } } }), twoFactor()],
      ember: { replicate: { organization: true } },
    });
    expect(authReplicaSpec(withField)!.tables[0]!.fields.map((f) => f.name)).toContain("plan");
    expect(authReplicaSpec(withField)!.version).not.toBe(spec.version);
    expect(authReplicaTables(withOrgs())[0]).toEqual({ name: "auth:organization", source: "auth", idType: "string", fields: expect.any(Array), indexes: expect.any(Array) });
    expect(() => authReplicaSpec(defineAuth({ ember: { replicate: { organization: true } } }))).toThrow(/organization\(\) plugin/);
    expect(() => authReplicaSpec(withOrgs({ organization: { shard: "global" } }))).toThrow(/shard kind/);
  });

  it("replicaJournalDDL: writes journal with their organization, team members with their team's, a cascade before it happens", async () => {
    const box = () => env.SQLBOX.get(env.SQLBOX.idFromName(`replication-${crypto.randomUUID()}`));
    await runInDurableObject(box(), (_i, state) => {
      const sql = state.storage.sql;
      const o = codegenOptions(withOrgs());
      migrate(sql, o);
      for (const s of replicaJournalDDL(o)) sql.exec(s);
      const d = "2026-01-01T00:00:00.000Z";
      sql.exec(`INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('u1', 'A', 'a@x', 0, ?, ?)`, d, d);
      sql.exec(`INSERT INTO "organization" (id, name, slug, createdAt) VALUES ('o1', 'Acme', 'acme', ?)`, d);
      sql.exec(`INSERT INTO "member" (id, organizationId, userId, role, createdAt) VALUES ('m1', 'o1', 'u1', 'owner', ?)`, d);
      sql.exec(`INSERT INTO "team" (id, name, memberCount, organizationId, createdAt) VALUES ('t1', 'Core', 1, 'o1', ?)`, d);
      sql.exec(`INSERT INTO "teamMember" (id, teamId, userId) VALUES ('tm1', 't1', 'u1')`);
      sql.exec(`UPDATE "user" SET name = 'B' WHERE id = 'u1'`);
      sql.exec(`DELETE FROM "team" WHERE id = 't1'`);
      const rows = sql.exec(`SELECT model, row_id, event, org, user_id FROM _ember_replica_journal ORDER BY seq`).toArray();
      expect(rows).toEqual([
        // First boot with replication on: a resync of every organization.
        { model: "*", row_id: "*", event: "resync", org: null, user_id: null },
        { model: "organization", row_id: "o1", event: "upsert", org: "o1", user_id: null },
        { model: "member", row_id: "m1", event: "upsert", org: "o1", user_id: "u1" },
        { model: "team", row_id: "t1", event: "upsert", org: "o1", user_id: null },
        { model: "teamMember", row_id: "tm1", event: "upsert", org: "o1", user_id: "u1" },
        { model: "user", row_id: "u1", event: "upsert", org: null, user_id: "u1" },
        // BEFORE DELETE on the team: its members, with the organization (the cascaded rows below cannot find it).
        { model: "teamMember", row_id: "tm1", event: "delete", org: "o1", user_id: "u1" },
        { model: "teamMember", row_id: "tm1", event: "delete", org: null, user_id: "u1" },
        { model: "team", row_id: "t1", event: "delete", org: "o1", user_id: null },
      ]);
      const resyncs = () => sql.exec(`SELECT COUNT(*) AS n FROM _ember_replica_journal WHERE event = 'resync'`).one().n;
      // Another boot with it on: no new resync.
      for (const s of replicaJournalDDL(o)) sql.exec(s);
      expect(resyncs()).toBe(1);
      // Turned off: the triggers go away.
      for (const s of replicaJournalDropDDL()) sql.exec(s);
      expect(sql.exec(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '_ember_replica_journal%'`).toArray()).toEqual([]);
      // On again: writes made while off were never journaled, so the journal asks for a resync again.
      for (const s of replicaJournalDDL(o)) sql.exec(s);
      expect(resyncs()).toBe(2);
    });
  });
});
