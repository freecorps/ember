// Local runtime: the bundled Worker in Miniflare (workerd), SQLite-backed DOs persisted under .ember/.

import { join } from "node:path";
import { convertV4MiniflareOptions, Miniflare, type MiniflareOptions } from "miniflare";
import { DO_CLASSES, type WorkerBuild } from "./build.ts";
import type { Project } from "./config.ts";

export interface LocalOptions {
  port?: number;
  host?: string;
  /** Persist DO storage under `.ember/state` (default true). false = in-memory. */
  persist?: boolean;
  /** Extra plain-text vars. */
  vars?: Record<string, string>;
}

export function miniflareOptions(project: Project, build: WorkerBuild, opts: LocalOptions = {}): MiniflareOptions {
  const c = project.config;
  // Miniflare 5 takes a new config shape; the v4 (flat) options are converted by miniflare itself.
  return convertV4MiniflareOptions({
    workers: [
      {
        name: `ember-${c.project}-local`,
        modules: [{ type: "ESModule", path: build.outFile, contents: build.code }],
        compatibilityDate: c.compatibilityDate,
        compatibilityFlags: c.compatibilityFlags ?? ["nodejs_compat"],
        durableObjects: Object.fromEntries(DO_CLASSES.map((d) => [d.binding, { className: d.className, useSQLite: true }])),
        bindings: { EMBER_ENV: "local", EMBER_PROJECT: c.project, ...(c.locationHint ? { EMBER_LOCATION_HINT: c.locationHint } : {}),
          // `ember dev` with EMBER_ADMIN_TOKEN set enables GET /api/_ember/status locally.
          ...(process.env.EMBER_ADMIN_TOKEN ? { EMBER_ADMIN_TOKEN: process.env.EMBER_ADMIN_TOKEN } : {}),
          ...opts.vars },
      },
    ],
    ...(opts.persist === false ? {} : { resourcePersistencePath: join(project.stateDir, "state") }),
    host: opts.host ?? "127.0.0.1",
    port: opts.port ?? 0,
    // The System DO is driven by the minute Cron Trigger in production; locally hit /cdn-cgi/handler/scheduled.
    unsafeTriggerHandlers: true,
    logRequests: false,
  });
}

export async function startLocal(project: Project, build: WorkerBuild, opts: LocalOptions = {}): Promise<{ mf: Miniflare; url: URL }> {
  const mf = new Miniflare(miniflareOptions(project, build, opts));
  const url = await mf.ready;
  return { mf, url };
}
