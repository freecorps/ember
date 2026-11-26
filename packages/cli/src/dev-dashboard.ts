// `ember dev --dashboard`: the Ember Dashboard on this machine, in front of the `ember dev` runtime (Miniflare).
//
// The same dashboard Worker (`createDashboard`, from apps/dashboard in the monorepo or the CLI's prebuilt copy) runs in
// this Node process behind a loopback HTTP server, in its explicit dev mode (`DASHBOARD_DEV = "1"`, auth.ts): no login,
// the admin role, only for requests addressed to a loopback host, never on Cloudflare. Nothing of the account is used:
//   - the registry is a local D1 of the Miniflare session (`EMBER_REGISTRY`): the dashboard's tables (audit log, CSRF
//     key), the project with one environment `local` pointing at the dev URL, and the shard catalog the local
//     runtime fills itself (each shard reports after its migration, as in production);
//   - the runtime's admin endpoints are opened with a token made for the session (`EMBER_ADMIN_TOKEN_DASHBOARD`,
//     random, in memory only);
//   - no Analytics Engine and no live logs (their screens say how to turn them on in a deployed dashboard).

import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { pathToFileURL } from "node:url";
import { DASHBOARD_HTML, dashboardFromSource, prebuiltDashboard } from "./dashboard.ts";
import { REGISTRY_DDL } from "./registry.ts";
import { FROM_SOURCE } from "./source.ts";

/** Default port of the local dashboard (the one `apps/dashboard`'s Vite proxy expects). */
export const DEV_DASHBOARD_PORT = 8788;
/** The environment name the local runtime runs as (`EMBER_ENV` of `ember dev`). */
export const DEV_ENV = "local";

export interface DevDashboard {
  url: URL;
  /**
   * The registry handle to use from now on: Miniflare's `setOptions()` (every reload) invalidates what `getD1Database`
   * returned before, so `ember dev` hands the new one over after each reload.
   */
  setRegistry(registry: DevRegistry): void;
  /** Registers (again) the project's local environment: the dev URL and the deployed schema of the running build. */
  sync(o: { schemaVersion: string | null }): Promise<void>;
  close(): Promise<void>;
}

/** The D1 surface used here and by the dashboard (Miniflare's `getD1Database` proxy). */
interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  run(): Promise<unknown>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
}
export interface DevRegistry {
  prepare(sql: string): D1Statement;
  batch(statements: D1Statement[]): Promise<unknown[]>;
}
type D1 = DevRegistry;

/** A peer that can only be this machine. */
const loopbackPeer = (a: string | undefined) => !!a && (a === "::1" || a === "127.0.0.1" || a.startsWith("127.") || a === "::ffff:127.0.0.1" || a.startsWith("::ffff:127."));

/** The token the runtime of this session accepts from the local dashboard (one per `ember dev`). */
export function devDashboardToken(): string {
  return randomBytes(32).toString("hex");
}

interface DashboardModule {
  createDashboard(assets: { html: string; js: string; css?: string }, opts?: { fetch?: typeof fetch }): { fetch(request: Request, env: Record<string, unknown>): Promise<Response> };
}

export async function startDevDashboard(o: {
  project: string;
  /** The `ember dev` runtime. */
  runtime: URL;
  registry: D1;
  /** The `EMBER_ADMIN_TOKEN_DASHBOARD` the runtime was started with. */
  adminToken: string;
  port?: number;
  schemaVersion: string | null;
  log?: (line: string) => void;
}): Promise<DevDashboard> {
  const src = (!FROM_SOURCE ? prebuiltDashboard() : null) ?? (await dashboardFromSource());
  const mod = (await import(pathToFileURL(src.worker).href)) as DashboardModule;
  const app = mod.createDashboard({ html: DASHBOARD_HTML, js: src.js, css: src.css });
  const worker = `ember-${o.project}-local`;
  let db = o.registry;
  for (const ddl of REGISTRY_DDL) await db.prepare(ddl).run();

  const sync = async (s: { schemaVersion: string | null }) => {
    const now = Date.now();
    await db.batch([
      db.prepare("INSERT INTO projects (name, fingerprint, repo, created_at, updated_at) VALUES (?, 'local', NULL, ?, ?) ON CONFLICT (name) DO UPDATE SET updated_at = excluded.updated_at").bind(o.project, now, now),
      db
        .prepare(
          "INSERT INTO environments (project, env, worker, url, schema_version, version_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'dev', ?, ?) " +
            "ON CONFLICT (project, env) DO UPDATE SET worker = excluded.worker, url = excluded.url, schema_version = excluded.schema_version, version_id = excluded.version_id, updated_at = excluded.updated_at",
        )
        .bind(o.project, DEV_ENV, worker, o.runtime.origin, s.schemaVersion, now, now),
    ]);
  };
  await sync({ schemaVersion: o.schemaVersion });

  const env: Record<string, unknown> = {
    DASHBOARD_DEV: "1",
    REGISTRY: db,
    // The runtime is reached at its dev URL with this session's token (projects.ts `adminTokenFor`).
    EMBER_ADMIN_TOKEN: o.adminToken,
  };
  const server: Server = createServer(async (rq, rs) => {
    try {
      // Loopback only: the server listens on 127.0.0.1, and a peer from elsewhere (a proxy, a port forward) is refused.
      if (!loopbackPeer(rq.socket.remoteAddress)) {
        rs.writeHead(403, { "content-type": "text/plain" }).end("the local dev dashboard answers this machine only");
        return;
      }
      const req = toRequest(rq, await body(rq), server);
      if (req instanceof Response) {
        rs.writeHead(req.status, { "content-type": "text/plain" }).end(await req.text());
        return;
      }
      const res = await app.fetch(req, env);
      const out: Record<string, string> = {};
      res.headers.forEach((v, k) => void (out[k] = v));
      rs.writeHead(res.status, out);
      if (!res.body) return void rs.end();
      const reader = res.body.getReader();
      rq.socket.once("close", () => void reader.cancel().catch(() => undefined));
      let finished = false;
      try {
        for (;;) {
          const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true as const }));
          if (done) {
            finished = true;
            break;
          }
          rs.write(value);
        }
      } finally {
        // A write that threw (the browser went away): the Worker's stream is released, not left open.
        if (!finished) await reader.cancel().catch(() => undefined);
      }
      rs.end();
    } catch (e) {
      if (!rs.headersSent) rs.writeHead(400, { "content-type": "text/plain" });
      rs.end(String((e as Error).message ?? e));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port ?? DEV_DASHBOARD_PORT, "127.0.0.1", () => resolve());
  });
  const url = new URL(`http://127.0.0.1:${(server.address() as { port: number }).port}/`);
  o.log?.(`ember dev: dashboard on ${url.href}#/p/${o.project}/${DEV_ENV}/health  (local, no login; this machine only)`);
  return {
    url,
    sync,
    setRegistry(registry) {
      db = registry;
      env.REGISTRY = registry;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

async function body(rq: IncomingMessage): Promise<Buffer | null> {
  if (rq.method === "GET" || rq.method === "HEAD") return null;
  const chunks: Buffer[] = [];
  for await (const c of rq) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

/** `host[:port]` naming this machine (the Host a browser sends to the local dashboard). */
const LOOPBACK_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d{1,5})?$/i;

/**
 * The Request the dashboard Worker sees, or the refusal. The Host header is checked on its own (a DNS-rebound page
 * sends its own name: 403), and the target must be a plain path: a scheme-relative `//127.0.0.1/...` or an absolute
 * URL would otherwise replace the Host's authority when resolved. The URL is then the Host's origin plus that path,
 * and the dev mode checks its hostname again (auth.ts).
 */
function toRequest(rq: IncomingMessage, bytes: Buffer | null, server: Server): Request | Response {
  const host = rq.headers.host ?? `127.0.0.1:${(server.address() as { port: number }).port}`;
  if (!LOOPBACK_HOST.test(host)) return new Response("the local dev dashboard answers loopback hosts only (127.0.0.1, localhost)", { status: 403 });
  const target = rq.url ?? "/";
  if (!target.startsWith("/") || target.startsWith("//")) return new Response("bad request target", { status: 400 });
  const url = new URL(`http://${host}${target}`);
  if (url.host.toLowerCase() !== host.toLowerCase()) return new Response("bad request target", { status: 400 });
  const headers = new Headers();
  // Hop-by-hop and framing headers stay with this connection; the Host is the URL's.
  for (const [k, v] of Object.entries(rq.headers)) if (typeof v === "string" && !["host", "connection", "content-length", "transfer-encoding", "keep-alive", "upgrade"].includes(k)) headers.set(k, v);
  return new Request(url, { method: rq.method ?? "GET", headers, ...(bytes ? { body: new Uint8Array(bytes) } : {}) });
}
