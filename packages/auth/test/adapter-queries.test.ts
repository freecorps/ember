/**
 * What the DO SQLite adapter sends to SQLite (statements per operation), inside a real Durable Object: joins batched
 * with `IN (...)`, single-row ops by primary key without the rowid subquery, `deleteMany` counted with `changes()`,
 * one adapter per transaction executor.
 */
import { env, runInDurableObject } from "cloudflare:test";
import type { BetterAuthOptions } from "better-auth";
import { describe, expect, it } from "vitest";
import { doSqliteAdapter, sqlStorageExecutor, type SqlExecutor } from "../src/adapter.ts";
import { migrate } from "../src/ddl.ts";

/** A fresh Durable Object (empty SQLite) per test. */
const fresh = () => env.SQLBOX.get(env.SQLBOX.idFromName(`adapter-queries-${crypto.randomUUID()}`));

type Log = { sql: string; changes: boolean }[];

/** The production executor, counting what it runs. */
function counting(sql: SqlStorage, storage: DurableObjectStorage, log: Log): SqlExecutor {
  const base = sqlStorageExecutor(sql);
  const exec: SqlExecutor = {
    exec: (query, params, o) => {
      log.push({ sql: query, changes: o?.changes === true });
      return base.exec(query, params, o);
    },
    reportsChanges: true,
    transaction: (fn) => storage.transaction(() => fn(exec)),
  };
  return exec;
}

const options = (joins: boolean) => ({ secret: "x".repeat(32), advanced: { database: { joins } } }) as unknown as BetterAuthOptions;

describe("DO SQLite adapter: statements", () => {
  it("one-to-one joins: one IN lookup for all rows, not one per row", async () => {
    await runInDurableObject(fresh(), async (_i, state) => {
      const sql = state.storage.sql;
      migrate(sql, options(true), { destructive: true, withReferences: false });
      const log: Log = [];
      const a = doSqliteAdapter(counting(sql, state.storage, log))(options(true));
      const now = new Date();
      for (let i = 0; i < 120; i++) {
        await a.create({ model: "user", data: { id: `u${i}`, email: `u${i}@x.test`, name: `U${i}`, emailVerified: false, createdAt: now, updatedAt: now }, forceAllowId: true });
        await a.create({ model: "session", data: { id: `s${i}`, userId: `u${i % 100}`, token: `t${i}`, expiresAt: now, createdAt: now, updatedAt: now }, forceAllowId: true });
      }
      log.length = 0;
      const rows = (await a.findMany({ model: "session", join: { user: true }, limit: 500 })) as Array<{ id: string; userId: string; user: { id: string; email: string } | null }>;
      expect(rows).toHaveLength(120);
      for (const r of rows) expect(r.user?.id).toBe(r.userId);
      // The base query, then 100 distinct user ids in two IN batches (≤ 90 bound parameters each).
      expect(log.map((l) => l.sql.replace(/\(\?(, \?)*\)/, "(…)"))).toEqual([
        expect.stringMatching(/^SELECT \* FROM "session"/),
        `SELECT * FROM "user" WHERE "id" IN (…) ORDER BY rowid`,
        `SELECT * FROM "user" WHERE "id" IN (…) ORDER BY rowid`,
      ]);
      const one = (await a.findOne({ model: "session", where: [{ field: "id", value: "s7" }], join: { user: true } })) as { user: { email: string } };
      expect(one.user.email).toBe("u7@x.test");
    });
  });

  it("update / delete / consume by id use the primary key directly; other filters the first matching row", async () => {
    await runInDurableObject(fresh(), async (_i, state) => {
      const sql = state.storage.sql;
      migrate(sql, options(false), { destructive: true, withReferences: false });
      const log: Log = [];
      const a = doSqliteAdapter(counting(sql, state.storage, log))(options(false));
      const now = new Date();
      for (const id of ["v1", "v2", "v3"]) await a.create({ model: "verification", data: { id, identifier: "same", value: id, expiresAt: now, createdAt: now, updatedAt: now }, forceAllowId: true });
      log.length = 0;
      expect(((await a.update({ model: "verification", where: [{ field: "id", value: "v2" }], update: { value: "two" } })) as { value: string }).value).toBe("two");
      expect(log.at(-1)!.sql).toMatch(/^UPDATE "verification" SET "value" = \?, "updatedAt" = \? WHERE "id" = \? RETURNING \*$/);
      // Not the primary key: still one row only.
      await a.update({ model: "verification", where: [{ field: "identifier", value: "same" }], update: { value: "first" } });
      expect(log.at(-1)!.sql).toContain("rowid = (SELECT rowid");
      expect(sql.exec(`SELECT COUNT(*) AS n FROM "verification" WHERE "value" = 'first'`).one().n).toBe(1);
      await a.delete({ model: "verification", where: [{ field: "id", value: "v3" }] });
      expect(log.at(-1)!.sql).toBe(`DELETE FROM "verification" WHERE "id" = ?`);
      expect(sql.exec(`SELECT id FROM "verification" ORDER BY id`).toArray().map((r) => r.id)).toEqual(["v1", "v2"]);
    });
  });

  it("deleteMany counts with changes() (no RETURNING), without cascaded rows; RETURNING for executors that cannot", async () => {
    await runInDurableObject(fresh(), async (_i, state) => {
      const sql = state.storage.sql;
      migrate(sql, options(false), { destructive: true, withReferences: true });
      const log: Log = [];
      const a = doSqliteAdapter(counting(sql, state.storage, log))(options(false));
      const now = new Date();
      for (const id of ["d1", "d2"]) {
        await a.create({ model: "user", data: { id, email: `${id}@x.test`, name: id, emailVerified: false, createdAt: now, updatedAt: now }, forceAllowId: true });
        await a.create({ model: "session", data: { id: `${id}-s`, userId: id, token: `${id}-t`, expiresAt: now, createdAt: now, updatedAt: now }, forceAllowId: true });
      }
      sql.exec("PRAGMA foreign_keys = ON");
      log.length = 0;
      expect(await a.deleteMany({ model: "user", where: [{ field: "email", value: "d1@x.test", operator: "eq" }] })).toBe(1);
      expect(log).toEqual([{ sql: `DELETE FROM "user" WHERE "email" = ?`, changes: true }]);
      expect(sql.exec(`SELECT COUNT(*) AS n FROM "session"`).one().n).toBe(1);
      // An executor without `reportsChanges` (e.g. over RPC).
      const plain: SqlExecutor = { exec: (q, p) => sqlStorageExecutor(sql).exec(q, p) };
      expect(await doSqliteAdapter(plain)(options(false)).deleteMany({ model: "user", where: [] })).toBe(1);
    });
  });

  it("a transaction reuses one adapter for the same executor", async () => {
    await runInDurableObject(fresh(), async (_i, state) => {
      const sql = state.storage.sql;
      migrate(sql, options(false), { destructive: true, withReferences: false });
      const exec = counting(sql, state.storage, []);
      const a = doSqliteAdapter(exec)(options(false));
      const seen = new Set<unknown>();
      for (let i = 0; i < 3; i++) await a.transaction!(async (tx) => void seen.add(tx));
      expect(seen.size).toBe(1);
    });
  });
});
