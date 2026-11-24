// Profile sync off (`emberAuth` without `onUserChange`, what the CLI generates for an app without `users:sync`): the
// Auth DO installs no user journal triggers, and drops the ones an earlier version installed, so a user write costs
// no journal row written and deleted for nothing.
import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { USER_JOURNAL_TABLE, userJournalDropDDL } from "../src/ddl.ts";

const inside = <T,>(stub: DurableObjectStub, f: (s: DurableObjectStorage) => T) => runInDurableObject(stub, (_i, state) => f(state.storage)) as Promise<T>;
const triggers = (s: DurableObjectStorage) =>
  s.sql.exec(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '${USER_JOURNAL_TABLE}%' ORDER BY name`).toArray().map((r) => r.name);
const D = "2026-01-01T00:00:00.000Z";

describe("profile sync off (no onUserChange)", () => {
  it("userJournalDropDDL drops the three journal triggers", () => {
    expect(userJournalDropDDL()).toEqual([
      `DROP TRIGGER IF EXISTS "${USER_JOURNAL_TABLE}_create"`,
      `DROP TRIGGER IF EXISTS "${USER_JOURNAL_TABLE}_update"`,
      `DROP TRIGGER IF EXISTS "${USER_JOURNAL_TABLE}_delete"`,
    ]);
  });

  it("boots without journal triggers, and drops those an earlier boot (sync on) left", async () => {
    const id = env.AUTH_NOSYNC.idFromName(`nosync-${crypto.randomUUID()}`);
    const stub = env.AUTH_NOSYNC.get(id);
    expect(await inside(stub, triggers)).toEqual([]);
    // What a version that always wired the hook left behind.
    await inside(stub, (s) => {
      s.sql.exec(`CREATE TABLE IF NOT EXISTS "${USER_JOURNAL_TABLE}" (seq INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, event TEXT NOT NULL, at INTEGER NOT NULL, data TEXT)`);
      for (const [e, when, row] of [["create", "INSERT", "NEW"], ["update", "UPDATE", "NEW"], ["delete", "DELETE", "OLD"]] as const)
        s.sql.exec(`CREATE TRIGGER "${USER_JOURNAL_TABLE}_${e}" AFTER ${when} ON "user" BEGIN INSERT INTO "${USER_JOURNAL_TABLE}" (user_id, event, at) VALUES (${row}.id, '${e}', 0); END`);
    });
    expect(await inside(stub, triggers)).toHaveLength(3);
    await evictDurableObject(stub);
    const fresh = env.AUTH_NOSYNC.get(id);
    expect(await inside(fresh, triggers)).toEqual([]);
    // A user write journals nothing.
    const journal = await inside(fresh, (s) => {
      s.sql.exec(`INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('u1', 'A', 'a@x', 0, ?, ?)`, D, D);
      s.sql.exec(`UPDATE "user" SET name = 'B' WHERE id = 'u1'`);
      return s.sql.exec(`SELECT COUNT(*) AS n FROM "${USER_JOURNAL_TABLE}"`).one().n;
    });
    expect(journal).toBe(0);
    // Idempotent: another boot finds nothing to drop.
    await evictDurableObject(fresh);
    expect(await inside(env.AUTH_NOSYNC.get(id), triggers)).toEqual([]);
  });
});
