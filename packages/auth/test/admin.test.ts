// Users and sessions for the dashboard (admin.ts): what leaves the Auth DO never includes a session token,
// credentials or account rows; search, pages and revocation go through Better Auth's adapter.
import { describe, expect, it } from "vitest";
import { listSessions, listUsers, revokeSessions, toAdminSession, type AdminAdapter } from "../src/admin.ts";

function fakeAdapter(rows: Record<string, Array<Record<string, unknown>>>) {
  const calls: Array<{ op: string; o: unknown }> = [];
  const match = (r: Record<string, unknown>, where: Array<{ field: string; value: unknown; operator?: string; connector?: string }> = []) => {
    const ors = where.filter((w) => w.connector === "OR");
    const ands = where.filter((w) => w.connector !== "OR");
    const test = (w: (typeof where)[number]) => (w.operator === "contains" ? String(r[w.field] ?? "").toLowerCase().includes(String(w.value).toLowerCase()) : r[w.field] === w.value);
    return ands.every(test) && (!ors.length || ors.some(test));
  };
  const adapter: AdminAdapter = {
    async findMany(o) {
      calls.push({ op: "findMany", o });
      const all = (rows[o.model] ?? []).filter((r) => match(r, o.where));
      return all.slice(o.offset ?? 0, (o.offset ?? 0) + (o.limit ?? all.length));
    },
    async count(o) {
      calls.push({ op: "count", o });
      return (rows[o.model] ?? []).filter((r) => match(r, o.where)).length;
    },
    async deleteMany(o) {
      calls.push({ op: "deleteMany", o });
      const before = rows[o.model]!.length;
      rows[o.model] = rows[o.model]!.filter((r) => !match(r, o.where));
      return before - rows[o.model]!.length;
    },
  };
  return { adapter, calls };
}

const user = (id: string, email: string, name: string) => ({ id, email, name, emailVerified: 1, image: null, createdAt: new Date(1000), updatedAt: new Date(2000), password: "hash!" });
const session = (id: string, userId: string, expiresAt: number) => ({ id, userId, token: `tok-${id}`, expiresAt: new Date(expiresAt), createdAt: new Date(1), updatedAt: null, ipAddress: "1.2.3.4", userAgent: "UA" });

describe("dashboard users and sessions", () => {
  it("users: search email or name in any case, pages, no credential fields", async () => {
    const { adapter } = fakeAdapter({ user: [user("u1", "ana@x.test", "Ana"), user("u2", "bo@x.test", "Bo"), user("u3", "cy@y.test", "ANNA")] });
    const r = await listUsers(adapter, { q: "an", limit: 1 });
    expect(r.total).toBe(2);
    expect(r.users).toHaveLength(1);
    expect(r.next).toBe(1);
    expect((await listUsers(adapter, { q: "an", cursor: 1, limit: 1 })).next).toBeNull();
    expect(JSON.stringify(r)).not.toContain("hash!");
    expect(r.users[0]).toEqual({ id: "u1", email: "ana@x.test", name: "Ana", emailVerified: true, image: null, createdAt: 1000, updatedAt: 2000 });
  });

  it("users: a short page gives the total without a count (one scan); a full or past-the-end page counts", async () => {
    const { adapter, calls } = fakeAdapter({ user: [user("u1", "ana@x.test", "Ana"), user("u2", "bo@x.test", "Bo"), user("u3", "cy@y.test", "ANNA")] });
    const counts = () => calls.filter((c) => c.op === "count").length;
    expect(await listUsers(adapter, { limit: 50 })).toMatchObject({ total: 3, next: null });
    expect(await listUsers(adapter, { q: "an", limit: 50 })).toMatchObject({ total: 2, next: null });
    expect(await listUsers(adapter, { cursor: 2, limit: 2 })).toMatchObject({ total: 3, next: null });
    expect(counts()).toBe(0);
    expect(await listUsers(adapter, { limit: 3 })).toMatchObject({ total: 3, next: null });
    expect(await listUsers(adapter, { limit: 2 })).toMatchObject({ total: 3, next: 2 });
    expect(await listUsers(adapter, { cursor: 10, limit: 2 })).toMatchObject({ users: [], total: 3, next: null });
    expect(counts()).toBe(3);
  });

  it("users: the total is the count for every offset, page size and search (OFFSET/LIMIT over N rows gives min(limit, N − offset))", async () => {
    const names = ["Ana", "Bo", "Cy", "Dan", "Eva", "Fay", "Gal"];
    const { adapter } = fakeAdapter({ user: names.map((n, i) => user(`u${i}`, `${n.toLowerCase()}@x.test`, n)) });
    for (const q of [undefined, "a", "zz"]) {
      const real = names.filter((n) => !q || n.toLowerCase().includes(q) || `${n.toLowerCase()}@x.test`.includes(q)).length;
      for (let limit = 1; limit <= 8; limit++) {
        for (let cursor = 0; cursor <= 9; cursor++) {
          const r = await listUsers(adapter, { ...(q ? { q } : {}), cursor, limit });
          expect({ q, limit, cursor, total: r.total, next: r.next }).toEqual({ q, limit, cursor, total: real, next: cursor + r.users.length < real ? cursor + r.users.length : null });
        }
      }
    }
  });

  it("sessions never carry their token; expired ones are marked", async () => {
    const now = Date.now();
    const { adapter } = fakeAdapter({ session: [session("s1", "u1", now + 60_000), session("s2", "u1", now - 1), session("s3", "u2", now + 1)] });
    const list = await listSessions(adapter, "u1");
    expect(list.map((s) => [s.id, s.active])).toEqual([
      ["s1", true],
      ["s2", false],
    ]);
    expect(JSON.stringify(list)).not.toContain("tok-");
    expect(toAdminSession(session("x", "u", now + 1))).not.toHaveProperty("token");
  });

  it("revoke: one session, or all of a user's, never another user's", async () => {
    const { adapter } = fakeAdapter({ session: [session("s1", "u1", 9e15), session("s2", "u1", 9e15), session("s3", "u2", 9e15)] });
    expect(await revokeSessions(adapter, { userId: "u2", sessionId: "s1" })).toEqual({ revoked: 0 });
    expect(await revokeSessions(adapter, { userId: "u1", sessionId: "s1" })).toEqual({ revoked: 1 });
    expect(await revokeSessions(adapter, { userId: "u1" })).toEqual({ revoked: 1 });
    expect((await listSessions(adapter, "u2")).map((s) => s.id)).toEqual(["s3"]);
  });
});
