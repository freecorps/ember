// Users and sessions for the Ember Dashboard (docs/design/contracts.md "Dashboard"): read through Better Auth's own
// adapter inside the `Auth` Durable Object, and revoked the way Better Auth revokes (its session rows). What leaves
// the DO is deliberately narrow: no password hashes, no `account` rows, and never a session's `token` (a bearer
// credential) — a session is shown and revoked by its id.

type Where = { field: string; value: unknown; operator?: "contains"; connector?: "AND" | "OR"; mode?: "insensitive" };

/** The slice of Better Auth's adapter these helpers use. */
export interface AdminAdapter {
  findMany(o: { model: string; where?: Where[]; limit?: number; offset?: number; sortBy?: { field: string; direction: "asc" | "desc" } }): Promise<unknown[]>;
  count(o: { model: string; where?: Where[] }): Promise<number>;
  deleteMany(o: { model: string; where: Array<{ field: string; value: unknown }> }): Promise<number>;
}

export interface AdminUser {
  id: string;
  email: string | null;
  name: string | null;
  emailVerified: boolean;
  image: string | null;
  createdAt: number | null;
  updatedAt: number | null;
}

export interface AdminSession {
  id: string;
  userId: string;
  createdAt: number | null;
  updatedAt: number | null;
  expiresAt: number | null;
  ipAddress: string | null;
  userAgent: string | null;
  /** Expired sessions are listed (until Better Auth cleans them up) but no longer valid. */
  active: boolean;
}

const time = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const t = v instanceof Date ? v.getTime() : typeof v === "number" ? v : Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
};
const strOrNull = (v: unknown) => (typeof v === "string" ? v : null);

export function toAdminUser(u: Record<string, unknown>): AdminUser {
  return {
    id: String(u.id),
    email: strOrNull(u.email),
    name: strOrNull(u.name),
    emailVerified: u.emailVerified === true || u.emailVerified === 1,
    image: strOrNull(u.image),
    createdAt: time(u.createdAt),
    updatedAt: time(u.updatedAt),
  };
}

/** A session without its token. */
export function toAdminSession(s: Record<string, unknown>, now = Date.now()): AdminSession {
  const expiresAt = time(s.expiresAt);
  return {
    id: String(s.id),
    userId: String(s.userId),
    createdAt: time(s.createdAt),
    updatedAt: time(s.updatedAt),
    expiresAt,
    ipAddress: strOrNull(s.ipAddress),
    userAgent: strOrNull(s.userAgent)?.slice(0, 300) ?? null,
    active: expiresAt !== null && expiresAt > now,
  };
}

export interface UserQuery {
  /** Part of the email or name (any case). */
  q?: string;
  /** Offset of the page (the previous answer's `next`). */
  cursor?: number;
  limit?: number;
}

export async function listUsers(adapter: AdminAdapter, o: UserQuery = {}): Promise<{ users: AdminUser[]; total: number; next: number | null }> {
  const limit = Math.max(1, Math.min(200, Math.floor(o.limit ?? 50)));
  const offset = Math.max(0, Math.floor(o.cursor ?? 0));
  const q = o.q?.trim().slice(0, 100);
  const where = q
    ? [
        // Both OR: the adapter groups OR conditions as (email ... OR name ...).
        { field: "email", value: q, operator: "contains" as const, mode: "insensitive" as const, connector: "OR" as const },
        { field: "name", value: q, operator: "contains" as const, mode: "insensitive" as const, connector: "OR" as const },
      ]
    : undefined;
  const rows = (await adapter.findMany({ model: "user", ...(where ? { where } : {}), limit, offset, sortBy: { field: "createdAt", direction: "desc" } })) as Array<Record<string, unknown>>;
  const total = await adapter.count({ model: "user", ...(where ? { where } : {}) });
  return { users: rows.map(toAdminUser), total, next: offset + rows.length < total ? offset + rows.length : null };
}

export async function listSessions(adapter: AdminAdapter, userId: string): Promise<AdminSession[]> {
  const rows = (await adapter.findMany({ model: "session", where: [{ field: "userId", value: userId }], limit: 200, sortBy: { field: "createdAt", direction: "desc" } })) as Array<Record<string, unknown>>;
  return rows.map((r) => toAdminSession(r));
}

/**
 * Ends one session (`sessionId`) or every session of `userId`: the rows go, so the session token stops working and
 * no new JWT is issued for it. A JWT already issued lives out its short TTL (5 min) unless the app's shards revoke the
 * identity too (the runtime does it for the shards it is given: `revokeSockets`).
 */
export async function revokeSessions(adapter: AdminAdapter, o: { userId: string; sessionId?: string }): Promise<{ revoked: number }> {
  const where = [{ field: "userId", value: o.userId }, ...(o.sessionId ? [{ field: "id", value: o.sessionId }] : [])];
  return { revoked: await adapter.deleteMany({ model: "session", where }) };
}
