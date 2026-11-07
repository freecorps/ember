import { DurableObject } from "cloudflare:workers";
import { cronJobs } from "@freecorps/ember-server";
import { authOutbox, createEmberWorker, type ActionJobMessage, type EmberConfig } from "../src/index.ts";
import { getEmberConfig } from "../src/config.ts";
import { functionsV1, probes as appProbes, schemaV1 } from "./app.ts";
import { app, componentFunctions, hooksFunctions, http, officialFunctions } from "./components-app.ts";

export { Shard, System } from "../src/index.ts";

/** Same isolate as the tests: lets tests observe side effects outside SQL. */
export const probes = {
  ...appProbes,
  actions: [] as ActionJobMessage[],
  /** Every `verify(token, { sensitive: true })` call (token). */
  sensitiveVerifies: [] as string[],
  /** Sessions revoked in the fake "Auth DO": their tokens still verify locally (like a 5-min JWT), not sensitively. */
  revoked: new Set<string>(),
  /** Alarm runs of the outbox test DO, by name (a held-back row must not make the alarm spin). */
  outboxAlarms: new Map<string, number>(),
  /** Calls to the mock Images binding. */
  images: [] as Array<{ transform: Record<string, unknown>; format: string; inputBytes: number }>,
};

const input: EmberConfig = {
  schema: schemaV1,
  functions: { ...functionsV1, components: componentFunctions, official: officialFunctions, hooks: hooksFunctions },
  // Components (PLAN §12): composed with the schema by createEmberWorker.
  app,
  http,
  // createEngine omitted: the real @freecorps/ember-server engine is the default.
  auth: {
    verify(token, opts) {
      const [kind, subject, ms] = token.split(":");
      if (!subject) return null;
      if (opts?.sensitive) {
        probes.sensitiveVerifies.push(token);
        if (probes.revoked.has(subject)) return null;
      }
      if (kind === "good") return { subject };
      // `sess:<subject>:<sid>:<iat seconds>`: a session's token, as an app's JWT would carry them.
      if (kind === "sess") return { subject, claims: { sid: ms, iat: Number(token.split(":")[3] ?? 0) } };
      if (kind === "expired") return { subject, exp: 1 };
      // Expires `ms` milliseconds from now (fractional seconds are fine for tests).
      if (kind === "soon") return { subject, exp: (Date.now() + Number(ms ?? 200)) / 1000 };
      return null;
    },
    // Stands in for @freecorps/ember-auth's /api/auth/* handler.
    fetch(request) {
      const url = new URL(request.url);
      return url.pathname.startsWith("/api/auth/") ? Response.json({ auth: url.pathname.slice("/api/auth/".length) }) : null;
    },
  },
  groupCommit: { windowMs: 5, maxBatch: 100 },
  scheduler: { maxAttempts: 3, backoffBaseMs: 20, backoffMaxMs: 100 },
  changeLogVersions: 5,
  reactivity: { searchDebounceMs: 150 },
  backfillChunk: 2,
  dispatchAction: async (_env, msg) => {
    probes.actions.push(msg);
    if ((msg.args as { fail?: boolean }).fail) throw new Error("queue down");
  },
  files: {
    gcGraceMs: 300,
    // Stands in for the Images binding: "transforms" by prefixing the bytes with the requested width/format.
    images: {
      input(stream: ReadableStream<Uint8Array>) {
        let t: Record<string, unknown> = {};
        const chain = {
          transform(x: Record<string, unknown>) {
            t = { ...t, ...x };
            return chain;
          },
          async output(o: { format: string }) {
            const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
            const out = new TextEncoder().encode(`thumb:${t.width}:${o.format}:${new TextDecoder().decode(bytes)}`);
            probes.images.push({ transform: t, format: o.format, inputBytes: bytes.length });
            return { response: () => new Response(out), contentType: () => o.format, image: () => new Response(out).body! };
          },
        };
        return chain;
      },
      async info(stream: ReadableStream<Uint8Array>) {
        const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
        return { width: 10, height: 20, format: "image/png", fileSize: bytes.length };
      },
    },
  },
  // crons.ts style: cronJobs() (the runtime also accepts a plain CronDef[]).
  crons: cronJobs({ shard: "org:crons" })
    .daily("morning", { hour: 9 }, "jobs:record", { label: "morning" }, { tz: "America/Sao_Paulo" })
    .interval("every-5", { minutes: 5 }, "jobs:record", { label: "every-5" }),
};

const worker = createEmberWorker(input);
/** The composed config (app + components) the Worker runs with: tests restore it with setEmberConfig(config). */
export const config: EmberConfig = getEmberConfig();
export default worker;

/** The auth outbox on a plain SQLite DO (stands in for @freecorps/ember-auth's Auth DO, which calls `onUserChange`). */
export const outbox = authOutbox({
  shard: (u) => `org:${typeof u.org === "string" ? u.org : "sync"}`,
  maxAttempts: 3,
  backoffBaseMs: 20,
  backoffMaxMs: 40,
  journalGraceMs: 300,
});
class OutboxBase extends DurableObject {
  async change(event: "create" | "update" | "delete", user: Record<string, unknown>) {
    await outbox.onUserChange(event, user, { storage: this.ctx.storage, env: this.env as unknown as Record<string, unknown> });
  }
  /**
   * A user table with the same journal triggers @freecorps/ember-auth installs (userJournalDDL). `hook: false`
   * simulates an Auth DO that died between the committed write and Better Auth's after-hook.
   */
  async writeUser(event: "create" | "update" | "delete", user: { id: string; email?: string; org?: string }, hook = true) {
    const sql = this.ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS "user" (id TEXT PRIMARY KEY, email TEXT, org TEXT)`);
    const now = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";
    sql.exec(`CREATE TABLE IF NOT EXISTS _ember_user_journal (seq INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, event TEXT NOT NULL, at INTEGER NOT NULL, data TEXT)`);
    sql.exec(`CREATE TRIGGER IF NOT EXISTS j_c AFTER INSERT ON "user" BEGIN INSERT INTO _ember_user_journal (user_id, event, at) VALUES (NEW.id, 'create', ${now}); END`);
    sql.exec(`CREATE TRIGGER IF NOT EXISTS j_u AFTER UPDATE ON "user" BEGIN INSERT INTO _ember_user_journal (user_id, event, at) VALUES (NEW.id, 'update', ${now}); END`);
    sql.exec(`CREATE TRIGGER IF NOT EXISTS j_d AFTER DELETE ON "user" BEGIN INSERT INTO _ember_user_journal (user_id, event, at, data) VALUES (OLD.id, 'delete', ${now}, json_object('id', OLD.id, 'email', OLD.email, 'org', OLD.org)); END`);
    if (event === "create") sql.exec(`INSERT INTO "user" (id, email, org) VALUES (?, ?, ?)`, user.id, user.email ?? null, user.org ?? null);
    else if (event === "update") sql.exec(`UPDATE "user" SET email = ? WHERE id = ?`, user.email ?? null, user.id);
    else sql.exec(`DELETE FROM "user" WHERE id = ?`, user.id);
    if (hook) await this.change(event, user);
  }
  async userForSync(id: string) {
    return (this.ctx.storage.sql.exec(`SELECT id, email, org FROM "user" WHERE id = ?`, id).toArray()[0] as Record<string, unknown> | undefined) ?? null;
  }
  async journal() {
    return this.ctx.storage.sql.exec(`SELECT user_id, event FROM _ember_user_journal ORDER BY seq`).toArray();
  }
}
const WrappedOutbox = outbox.wrap(OutboxBase) as unknown as new (ctx: DurableObjectState, env: unknown) => OutboxBase & { alarm(): Promise<void> };
export class OutboxBox extends WrappedOutbox {
  override async alarm() {
    const name = this.ctx.id.name ?? this.ctx.id.toString();
    probes.outboxAlarms.set(name, (probes.outboxAlarms.get(name) ?? 0) + 1);
    await super.alarm();
  }
}
export type OutboxBoxInstance = InstanceType<typeof OutboxBase> & { outbox(): Promise<import("../src/index.ts").OutboxRow[]>; alarm(): Promise<void> };
