import { cronJobs } from "@ember/server";
import { createEmberWorker, type ActionJobMessage, type EmberConfig } from "../src/index.ts";
import { functionsV1, probes as appProbes, schemaV1 } from "./app.ts";

export { Shard, System } from "../src/index.ts";

/** Same isolate as the tests: lets tests observe side effects outside SQL. */
export const probes = {
  ...appProbes,
  actions: [] as ActionJobMessage[],
};

export const config: EmberConfig = {
  schema: schemaV1,
  functions: functionsV1,
  // createEngine omitted: the real @ember/server engine is the default.
  auth: {
    verify(token) {
      const [kind, subject, ms] = token.split(":");
      if (!subject) return null;
      if (kind === "good") return { subject };
      if (kind === "expired") return { subject, exp: 1 };
      // Expires `ms` milliseconds from now (fractional seconds are fine for tests).
      if (kind === "soon") return { subject, exp: (Date.now() + Number(ms ?? 200)) / 1000 };
      return null;
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
