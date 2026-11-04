import { DurableObject } from "cloudflare:workers";
import { cronJobs } from "@ember/server";
import { authOutbox, createEmberWorker, type ActionJobMessage, type EmberConfig } from "../src/index.ts";
import { functionsV1, probes as appProbes, schemaV1 } from "./app.ts";

export { Shard, System } from "../src/index.ts";

/** Same isolate as the tests: lets tests observe side effects outside SQL. */
export const probes = {
  ...appProbes,
  actions: [] as ActionJobMessage[],
  /** Every `verify(token, { sensitive: true })` call (token). */
  sensitiveVerifies: [] as string[],
  /** Sessions revoked in the fake "Auth DO": their tokens still verify locally (like a 5-min JWT), not sensitively. */
  revoked: new Set<string>(),
};

export const config: EmberConfig = {
  schema: schemaV1,
  functions: functionsV1,
  // createEngine omitted: the real @ember/server engine is the default.
  auth: {
    verify(token, opts) {
      const [kind, subject, ms] = token.split(":");
      if (!subject) return null;
      if (opts?.sensitive) {
        probes.sensitiveVerifies.push(token);
        if (probes.revoked.has(subject)) return null;
      }
      if (kind === "good") return { subject };
      if (kind === "expired") return { subject, exp: 1 };
      // Expires `ms` milliseconds from now (fractional seconds are fine for tests).
      if (kind === "soon") return { subject, exp: (Date.now() + Number(ms ?? 200)) / 1000 };
      return null;
    },
    // Stands in for @ember/auth's /api/auth/* handler.
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
  // crons.ts style: cronJobs() (the runtime also accepts a plain CronDef[]).
  crons: cronJobs({ shard: "org:crons" })
    .daily("morning", { hour: 9 }, "jobs:record", { label: "morning" }, { tz: "America/Sao_Paulo" })
    .interval("every-5", { minutes: 5 }, "jobs:record", { label: "every-5" }),
};

export default createEmberWorker(config);

/** The auth outbox on a plain SQLite DO (stands in for @ember/auth's Auth DO, which calls `onUserChange`). */
export const outbox = authOutbox({
  shard: (u) => `org:${typeof u.org === "string" ? u.org : "sync"}`,
  maxAttempts: 3,
  backoffBaseMs: 20,
  backoffMaxMs: 40,
});
class OutboxBase extends DurableObject {
  async change(event: "create" | "update" | "delete", user: Record<string, unknown>) {
    await outbox.onUserChange(event, user, { storage: this.ctx.storage, env: this.env as unknown as Record<string, unknown> });
  }
}
export const OutboxBox = outbox.wrap(OutboxBase);
export type OutboxBoxInstance = InstanceType<typeof OutboxBase> & { outbox(): Promise<import("../src/index.ts").OutboxRow[]>; alarm(): Promise<void> };
