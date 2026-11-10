// Local runtime: the bundled Worker in Miniflare (workerd), SQLite-backed DOs persisted under .ember/.

import { join } from "node:path";
import { convertV4MiniflareOptions, Miniflare, type MiniflareOptions } from "miniflare";
import { doClasses, runtimeVersion, type WorkerBuild } from "./build.ts";
import type { Project } from "./config.ts";
import type { RemoteBindings } from "./remote.ts";

export interface LocalOptions {
  port?: number;
  host?: string;
  /** Persist DO storage under `.ember/state` (default true). false = in-memory. */
  persist?: boolean;
  /** Extra plain-text vars. */
  vars?: Record<string, string>;
  /** `manifest.components` of the composed app: component queues and `send_email` bindings run locally too. */
  components?: Record<string, { queues?: Array<{ queue: string; binding: string }>; bindings?: Array<{ type: string; name: string } & Record<string, unknown>> }>;
  /** `ember dev --remote`: bindings proxied to real Cloudflare resources (remote.ts). */
  remote?: RemoteBindings;
}

/** Local queues and send_email bindings that installed components declared (hooks, PLAN §12). */
function componentLocal(project: string, components: LocalOptions["components"]) {
  const producers: Record<string, string> = {};
  const consumers: string[] = [];
  const sendEmail: Array<{ name: string } & Record<string, unknown>> = [];
  for (const c of Object.values(components ?? {})) {
    for (const q of c.queues ?? []) {
      const name = `ember-${project}-local-${q.queue}`;
      producers[q.binding] = name;
      consumers.push(name);
    }
    // Miniflare simulates send_email: messages are logged and written under its temp dir (no real mail).
    for (const b of c.bindings ?? []) {
      if (b.type === "send_email") sendEmail.push({ ...(Object.fromEntries(Object.entries(b).filter(([k]) => k !== "type"))), name: b.name });
    }
  }
  return {
    ...(consumers.length ? { queueProducers: producers, queueConsumers: consumers } : {}),
    // The shapes come from the component's own `bindings` (validated by componentBindings at deploy).
    ...(sendEmail.length ? { email: { send_email: sendEmail as never } } : {}),
  };
}

/** Miniflare (v4 shape) options for the remote bindings: each carries the proxy session's connection string. */
export function remoteBindingOptions(r: RemoteBindings): Record<string, unknown> {
  const remoteProxyConnectionString = r.connection;
  const map = (m: Record<string, string>, key: string) => Object.fromEntries(Object.entries(m).map(([b, name]) => [b, { [key]: name, remoteProxyConnectionString }]));
  return {
    ...(r.ai ? { ai: { binding: "EMBER_AI", remoteProxyConnectionString } } : {}),
    ...(Object.keys(r.vectorize).length ? { vectorize: map(r.vectorize, "index_name") } : {}),
    ...(Object.keys(r.aiSearch).length ? { aiSearchInstances: map(r.aiSearch, "instance_name") } : {}),
    ...(r.browser ? { browserRendering: { binding: "EMBER_BROWSER", remoteProxyConnectionString } } : {}),
    ...(r.images ? { images: { binding: "EMBER_IMAGES", remoteProxyConnectionString } } : {}),
  };
}

export function miniflareOptions(project: Project, build: WorkerBuild, opts: LocalOptions = {}): MiniflareOptions {
  const c = project.config;
  const localAuth = build.auth?.kind === "local";
  const emberVersion = runtimeVersion(project.dir);
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
          ...(emberVersion ? { EMBER_RUNTIME_VERSION: emberVersion } : {}),
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
        ...componentLocal(c.project, opts.components),
        ...(opts.remote ? remoteBindingOptions(opts.remote) : {}),
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
