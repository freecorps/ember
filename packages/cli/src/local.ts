// Local runtime: the bundled Worker in Miniflare (workerd), SQLite-backed DOs persisted under .ember/.

import { join } from "node:path";
import { convertV4MiniflareOptions, Miniflare, type MiniflareOptions } from "miniflare";
import { doClasses, type WorkerBuild } from "./build.ts";
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
  const localAuth = build.auth?.kind === "local";
  const host = opts.host ?? "127.0.0.1";
  // Local only: a fixed per-project secret (dev sessions survive restarts) and, with a known port, a pinned issuer.
  const authVars: Record<string, string> = localAuth
    ? {
        EMBER_AUTH_SECRET: `ember-dev-only-secret-${c.project}-do-not-use-in-production`,
        ...(opts.port ? { EMBER_AUTH_URL: `http://${host}:${opts.port}` } : {}),
      }
    : {};
  // Miniflare 5 takes a new config shape; the v4 (flat) options are converted by miniflare itself.
  return convertV4MiniflareOptions({
    workers: [
      {
        name: `ember-${c.project}-local`,
        modules: [{ type: "ESModule", path: build.outFile, contents: build.code }],
        compatibilityDate: c.compatibilityDate,
        compatibilityFlags: localAuth && c.compatibilityFlags && !c.compatibilityFlags.includes("nodejs_compat") ? [...c.compatibilityFlags, "nodejs_compat"] : (c.compatibilityFlags ?? ["nodejs_compat"]),
        durableObjects: Object.fromEntries(doClasses(localAuth).map((d) => [d.binding, { className: d.className, useSQLite: true }])),
        bindings: { EMBER_ENV: "local", EMBER_PROJECT: c.project, ...(c.locationHint ? { EMBER_LOCATION_HINT: c.locationHint } : {}),
          // `ember dev` with EMBER_ADMIN_TOKEN set enables GET /api/_ember/status locally.
          ...(process.env.EMBER_ADMIN_TOKEN ? { EMBER_ADMIN_TOKEN: process.env.EMBER_ADMIN_TOKEN } : {}),
          ...authVars,
          // External indexes (Vectorize / AI Search) have no local emulation: the explicit local fallback stores
          // them in each shard's SQLite (brute-force vectors, BM25 text, hash embeddings without Workers AI).
          EMBER_AI_INDEXES: "local",
          // Files (resources.files): local R2 in proxy mode; download URLs absolute when the port is known.
          ...(c.resources?.files && opts.port ? { EMBER_PUBLIC_URL: `http://${host}:${opts.port}` } : {}),
          ...opts.vars },
        ...(c.resources?.files ? { r2Buckets: ["EMBER_FILES"] } : {}),
      },
    ],
    ...(opts.persist === false ? {} : { resourcePersistencePath: join(project.stateDir, "state") }),
    host,
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
