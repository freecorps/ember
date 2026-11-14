// A fake Cloudflare account for CLI tests: D1 REST API backed by node:sqlite, a Workers API good enough for
// `deploy` and the dashboard (settings, secrets per Worker), zones, custom domains, routes and Access.
import { DatabaseSync } from "node:sqlite";
import { CfClient } from "../src/deploy/cf.ts";

const ok = (result: unknown) => new Response(JSON.stringify({ success: true, errors: [], result }), { status: 200 });
const fail = (status: number, code: number, message: string) => new Response(JSON.stringify({ success: false, errors: [{ code, message }], result: null }), { status });

/**
 * Fake Cloudflare account: D1 REST API backed by node:sqlite, a Workers API good enough for `deploy`, zones,
 * custom domains and routes. Every call is recorded.
 */
export function fakeAccount() {
  const dbs = new Map<string, { name: string; db: DatabaseSync }>();
  const calls: Array<{ method: string; path: string; json?: any; metadata?: any }> = [];
  const workers = new Set<string>();
  const settings = new Map<string, any>();
  const state = { failSettings: false };
  /** Secret names per Worker (values kept for assertions: a real account never returns them). */
  const secrets = new Map<string, Map<string, string>>();
  const secretsOf = (w: string) => secrets.get(w) ?? secrets.set(w, new Map()).get(w)!;
  /** Zero Trust organization (`/access/organizations`); null = none. */
  const access = { team: null as string | null, apps: [] as Array<{ id: string; aud: string; domain: string; name: string }> };
  const customDomains: Array<{ hostname: string; service: string; zone_id: string }> = [{ hostname: "taken.example.com", service: "someone-else", zone_id: "z1" }];
  const routes = [{ pattern: "*.legacy.example.com/*", script: "old-worker" }];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace("/client/v4", "").replace("/accounts/acc", "");
    const method = init?.method ?? "GET";
    const call: (typeof calls)[number] = { method, path: path + url.search };
    if (init?.body instanceof FormData) call.metadata = JSON.parse(await (init.body.get("metadata") as Blob).text());
    else if (typeof init?.body === "string") call.json = JSON.parse(init.body);
    calls.push(call);
    if (method === "GET" && path === "/d1/database") return ok([...dbs].filter(([, d]) => d.name === url.searchParams.get("name")).map(([uuid, d]) => ({ uuid, name: d.name })));
    if (method === "POST" && path === "/d1/database") {
      const uuid = `db-${dbs.size + 1}`;
      dbs.set(uuid, { name: call.json.name, db: new DatabaseSync(":memory:") });
      return ok({ uuid, name: call.json.name });
    }
    const q = path.match(/^\/d1\/database\/([^/]+)\/query$/);
    if (method === "POST" && q) {
      const d = dbs.get(q[1]!);
      if (!d) return fail(404, 7404, "no such database");
      const { sql, params } = call.json as { sql: string; params: any[] };
      try {
        if (!params.length && sql.includes(";")) {
          d.db.exec(sql);
          return ok([{ results: [], success: true }]);
        }
        const results = d.db.prepare(sql).all(...params);
        return ok([{ results, success: true }]);
      } catch (e) {
        return fail(400, 7500, (e as Error).message);
      }
    }
    const W = path.match(/^\/workers\/scripts\/([^/]+)(\/.*)?$/);
    if (W) {
      const [, name, rest = ""] = W;
      if (method === "GET" && rest === "/deployments") return workers.has(name!) ? ok({ deployments: [{ versions: [{ version_id: "v0", percentage: 100 }] }] }) : fail(404, 10007, "no worker");
      if (method === "GET" && rest === "/secrets") return workers.has(name!) ? ok([...secretsOf(name!).keys()].map((n) => ({ name: n, type: "secret_text" }))) : fail(404, 10007, "no worker");
      if (method === "PUT" && rest === "/secrets") {
        secretsOf(name!).set(call.json.name, call.json.text);
        return ok({ name: call.json.name });
      }
      const del = rest.match(/^\/secrets\/(.+)$/);
      if (method === "DELETE" && del) return secretsOf(name!).delete(del[1]!) ? ok(null) : fail(404, 10056, "no secret");
      if (method === "DELETE" && rest === "") {
        if (!workers.delete(name!)) return fail(404, 10007, "no worker");
        settings.delete(name!);
        secrets.delete(name!);
        return ok(null);
      }
      if (method === "GET" && rest === "/settings" && state.failSettings) return fail(403, 10000, "Authentication error");
      if (method === "GET" && rest === "/settings") {
        if (!workers.has(name!)) return fail(404, 10007, "no worker");
        // Like the API: plain bindings with their text, secrets by name only.
        const plain = (settings.get(name!)?.bindings ?? []).filter((b: any) => b.type !== "secret_text");
        return ok({ bindings: [...plain, ...[...secretsOf(name!).keys()].map((n) => ({ type: "secret_text", name: n }))] });
      }
      if (method === "PUT" && rest === "") {
        workers.add(name!);
        settings.set(name!, call.metadata);
        for (const b of call.metadata?.bindings ?? []) if (b.type === "secret_text") secretsOf(name!).set(b.name, b.text);
        return ok({ id: name });
      }
      if (method === "PUT" && rest === "/schedules") return ok({});
      if (method === "POST" && rest === "/subdomain") return ok({});
      if (method === "POST" && rest === "/versions") return ok({ id: "v1" });
      if (method === "POST" && rest === "/deployments") return ok({});
      if (method === "POST" && rest === "/tails") return ok({ id: "tail-1", url: "wss://tail.example/1", expires_at: "x" });
      if (method === "DELETE" && rest === "/tails/tail-1") return ok(null);
    }
    if (method === "GET" && path === "/workers/scripts") return ok([...workers].map((id) => ({ id })));
    if (method === "GET" && path.startsWith("/workers/durable_objects/namespaces")) return ok([]);
    if (method === "GET" && path === "/workers/subdomain") return ok({ subdomain: "acme" });
    if (method === "GET" && path === "/zones") return ok(url.searchParams.get("name") === "example.com" ? [{ id: "z1", name: "example.com" }] : []);
    if (method === "GET" && path === "/workers/domains") return ok(customDomains.filter((d) => d.zone_id === url.searchParams.get("zone_id")));
    if (method === "PUT" && path === "/workers/domains") {
      customDomains.push(call.json);
      return ok({ id: "cd1", ...call.json });
    }
    if (method === "GET" && path === "/zones/z1/workers/routes") return ok(routes);
    // Nothing else provisioned (destroy looks for these).
    if (method === "GET" && (path === "/queues" || path.startsWith("/vectorize/") || path.startsWith("/ai-search/") || path.startsWith("/autorag/"))) return ok([]);
    if (method === "GET" && path === "/access/organizations") return access.team ? ok({ auth_domain: access.team }) : fail(404, 12130, "no organization");
    if (method === "GET" && path === "/access/apps") return ok(access.apps);
    if (method === "POST" && path === "/access/apps") {
      const app = { id: `app-${access.apps.length + 1}`, aud: `aud-${access.apps.length + 1}`, domain: call.json.domain, name: call.json.name };
      access.apps.push(app);
      return ok(app);
    }
    if (method === "POST" && /^\/access\/apps\/[^/]+\/policies$/.test(path)) return ok({ id: "pol-1" });
    return fail(400, 1, `unexpected ${method} ${path}`);
  }) as typeof fetch;
  const client = new CfClient({ accountId: "acc", token: "t", fetch: fetchImpl, sleep: async () => {} });
  return {
    client, calls, dbs, workers, customDomains, fetchImpl, secrets, secretsOf, access,
    get failSettings() { return state.failSettings; },
    set failSettings(v: boolean) { state.failSettings = v; },
  };
}

