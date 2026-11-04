/**
 * The auth Durable Object. Owns the Better Auth tables in its SQLite DB and
 * runs the full Better Auth handler next to the data, so every adapter call is
 * an in-process SQLite call (microseconds) instead of a network hop.
 */
import { DurableObject } from "cloudflare:workers";
import { AsyncLocalStorage } from "node:async_hooks";
import { betterAuth } from "better-auth";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { authConfig } from "./auth-config";
import { migrate } from "./ddl";
import { doSqliteAdapter, sqlStorageExecutor } from "./do-sqlite-adapter";
import type { Env } from "./env";

/** Password hasher supplied per request by the caller (an RpcTarget stub). */
export type RemoteHasher = {
  hash(password: string): Promise<string>;
  verify(hash: string, password: string): Promise<boolean>;
};
const requestHasher = new AsyncLocalStorage<RemoteHasher | undefined>();

export class AuthShard extends DurableObject<Env> {
  auth: ReturnType<typeof this.createAuth>;
  invitations: { id: string; email: string; organizationId: string }[] = [];
  outbox: { email: string; token: string; url: string }[] = [];
  migrationMs = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    (globalThis as any).__EMBER_SECRET = (env as any).AUTH_SECRET;
    (globalThis as any).__EMBER_BASE = (env as any).BASE_URL;
    this.auth = this.createAuth();
    ctx.blockConcurrencyWhile(async () => {
      const t = performance.now();
      // In the product this would be the codegen'd, versioned DDL; here we
      // derive it from the live config at boot.
      migrate(ctx.storage.sql, authConfig());
      this.migrationMs = performance.now() - t;
    });
  }

  createAuth() {
    const executor = sqlStorageExecutor(this.ctx.storage.sql, (fn) =>
      this.ctx.storage.transaction(() => fn(executor)),
    );
    // scrypt is ~33ms of CPU. In the DO it serializes every sign-in/up on the
    // DO's single thread. If the caller passed a hasher (RpcTarget living in
    // the edge Worker isolate), run the hash there instead.
    return betterAuth({
      ...authConfig({
        onInvitation: (i) => this.invitations.push(i),
        onVerificationEmail: (m) => this.outbox.push(m),
        password: {
          hash: async (password) => {
            const h = requestHasher.getStore();
            this.hashCalls[h ? "remote" : "local"]++;
            return h ? h.hash(password) : hashPassword(password);
          },
          verify: async ({ hash, password }) => {
            const h = requestHasher.getStore();
            this.hashCalls[h ? "remote" : "local"]++;
            return h ? h.verify(hash, password) : verifyPassword({ hash, password });
          },
        },
      }),
      database: doSqliteAdapter(executor),
    });
  }

  hashCalls = { local: 0, remote: 0 };

  override async fetch(request: Request) {
    return this.auth.handler(request);
  }

  /** RPC entry: same as fetch, but with a caller-side password hasher. */
  async handle(request: Request, hasher?: RemoteHasher) {
    return requestHasher.run(hasher, () => this.auth.handler(request));
  }

  stats() {
    return { hashCalls: this.hashCalls, migrationMs: this.migrationMs };
  }

  // ---- RPC surface used by the Worker (ctx.auth resolution) ----

  /** Full session validation against the DB (revocation-accurate). */
  async getSession(headers: [string, string][]) {
    const s = await this.auth.api.getSession({
      headers: new Headers(headers),
      query: { disableCookieCache: true },
    });
    return s ? { userId: s.user.id, sessionId: s.session.id, activeOrganizationId: (s.session as any).activeOrganizationId ?? null, email: s.user.email } : null;
  }

  /** Public JWKS for in-Worker JWT verification. */
  async getJwks() {
    return (await this.auth.api.getJwks()) as { keys: Record<string, unknown>[] };
  }

  takeVerificationEmails() {
    const out = this.outbox;
    this.outbox = [];
    return out;
  }

  takeInvitations() {
    const out = this.invitations;
    this.invitations = [];
    return out;
  }

  /** test/debug helper */
  sqlQuery(query: string, params: (string | number | null)[] = []) {
    return this.ctx.storage.sql.exec(query, ...params).toArray();
  }
}
