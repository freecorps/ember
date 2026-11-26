// A project Worker's admin API (@freecorps/ember-runtime `/api/_ember/*`) for the browser test, with user data that
// tries to inject markup.

import { embedPage } from "@freecorps/ember-dashboard-sdk";

export const XSS = `<img src=x onerror="window.__xss=1">`;
export const BOOKMARK = "00000000-00000008-00005119-0123456789abcdef";

/** A 1×1 PNG. */
const PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
const file = (id: string, content_type: string, bytes: Uint8Array | string, refcount = 0) => ({ id, sha256: "ab".repeat(32), size: typeof bytes === "string" ? bytes.length : bytes.byteLength, content_type, refcount, state: "ready", created_at: Date.now() - 3_600_000, bytes });
export const FILES = [
  file("_storage_png", "image/png", PNG, 1),
  file("_storage_txt", "text/plain", `hello ${XSS}`),
  file("_storage_html", "text/html", `<script>window.__xss=2</script>${XSS}`),
  file("_storage_svg", "image/svg+xml", `<svg xmlns="http://www.w3.org/2000/svg" onload="window.__xss=3"/>`),
];

const str = { shape: { kind: "string" }, optional: false };
const status = { shape: { kind: "union", members: [{ kind: "literal", value: "pending" }, { kind: "literal", value: "running" }, { kind: "literal", value: "failed" }] }, optional: true };
/** A component's screens as the runtime lists them (`GET /api/_ember/dashboards`): a work pool. */
export const POOL_SPEC = {
  key: "pool",
  component: "workpool",
  label: "Work pool",
  icon: "queue",
  description: "Items by status; cancel one or all.",
  scope: "shard",
  tabs: [
    {
      id: "items",
      label: "Items",
      blocks: [
        { kind: "stats", id: "stats", query: "@pool/lib:stats", items: [{ label: "Pending", path: "pending", format: "number" }, { label: "Running", path: "running", format: "number" }, { label: "Succeeded", path: "totals.succeeded", format: "number" }] },
        {
          kind: "table",
          id: "work",
          label: "Work",
          query: "@pool/lib:listWork",
          filters: ["status"],
          pageSize: 2,
          rowKey: "_id",
          columns: [
            { label: "Function", path: "fnName", format: "code" },
            { label: "Status", path: "status", format: "badge" },
            { label: "Paused", path: "paused", format: "boolean", toggle: { mutation: "@pool/lib:pause", arg: "paused", fromRow: { id: "_id" } } },
          ],
          detail: { query: "@pool/lib:item", fromRow: { id: "_id" }, sections: [{ kind: "kv", items: [{ label: "Function", path: "fnName" }, { label: "Attempts", path: "attempts", format: "number" }] }, { kind: "timeline", label: "Attempts", path: "history", time: "at", title: "event", status: "outcome" }, { kind: "stacktrace", label: "Last error", path: "lastError" }] },
          rowActions: [{ id: "cancel", label: "Cancel", fn: "@pool/lib:cancel", fromRow: { id: "_id" } }],
        },
        { kind: "actions", id: "bulk", actions: [{ id: "cancelAll", label: "Cancel all", fn: "@pool/lib:cancelAll", destructive: true }, { id: "enqueue", label: "Enqueue", fn: "@pool/lib:enqueueTest" }] },
      ],
    },
  ],
  functions: {
    "@pool/lib:stats": { type: "query", args: { kind: "object", fields: {} } },
    "@pool/lib:listWork": { type: "query", args: { kind: "object", fields: { status, paginationOpts: { shape: { kind: "object", fields: { numItems: { shape: { kind: "number" }, optional: false }, cursor: { shape: { kind: "union", members: [{ kind: "string" }, { kind: "null" }] }, optional: false } } }, optional: false } } } },
    "@pool/lib:item": { type: "query", args: { kind: "object", fields: { id: str } } },
    // Destructive (the spec also names it in a destructive action): on prod the switch asks for the typed name too.
    "@pool/lib:pause": { type: "mutation", args: { kind: "object", fields: { id: str, paused: { shape: { kind: "boolean" }, optional: false } } }, destructive: true },
    "@pool/lib:cancel": { type: "mutation", args: { kind: "object", fields: { id: str } } },
    "@pool/lib:cancelAll": { type: "mutation", args: { kind: "object", fields: {} }, destructive: true },
    "@pool/lib:enqueueTest": { type: "action", args: { kind: "object", fields: { label: str } } },
  },
};

/**
 * A component with an embed block (contracts.md "Embeds"): its page lists items (a query the block allows), adds one
 * (a mutation it allows, confirmed in the dashboard), and tries a query of the spec the block does not list.
 */
export const LAB_SPEC = {
  key: "lab",
  component: "lab",
  label: "Lab",
  icon: "flag",
  scope: "shard",
  tabs: [{ id: "page", label: "Page", blocks: [{ kind: "embed", id: "play", label: "Playground", route: "/dashboard/page", path: "/lab/dashboard/page", height: "auto", functions: { "lib:list": "@lab/lib:list", "lib:add": "@lab/lib:add" } }] }],
  functions: {
    "@lab/lib:list": { type: "query", args: { kind: "object", fields: {} } },
    "@lab/lib:add": { type: "mutation", args: { kind: "object", fields: { label: str } } },
    "@lab/lib:secret": { type: "query", args: { kind: "object", fields: {} } },
  },
};

/** The lab's page: buttons that call through the SDK and show what came back (as text). */
export const LAB_PAGE = embedPage({
  title: "Lab",
  body: `<h1>Lab page</h1><p id="ctx">…</p><p id="theme">…</p><button id="load">Load</button> <button id="add">Add</button> <button id="secret">Secret</button> <button id="twice">Add twice</button> <button id="action">As action</button> <button id="slow">Slow add</button><pre id="out">idle</pre><pre id="out2"></pre>`,
  style: "pre{white-space:pre-wrap}",
  script: `
const dash = EmberDashboard.connect();
const $ = (id) => document.getElementById(id);
const show = (el) => (x) => { $(el).textContent = typeof x === "string" ? x : JSON.stringify(x); };
const fail = (el) => (e) => { $(el).textContent = "error " + e.code; };
$("load").addEventListener("click", () => dash.query("lib:list").then(show("out"), fail("out")));
$("add").addEventListener("click", () => dash.mutate("lib:add", { label: "from embed" }).then((v) => show("out")("added " + JSON.stringify(v)), fail("out")));
$("secret").addEventListener("click", () => dash.query("lib:secret").then(show("out"), fail("out")));
$("action").addEventListener("click", () => dash.action("lib:add", { label: "x" }).then(show("out"), fail("out")));
$("slow").addEventListener("click", () => dash.mutate("lib:add", { label: "slow" }).then((v) => show("out")("slow " + JSON.stringify(v)), fail("out")));
$("twice").addEventListener("click", () => {
  dash.mutate("lib:add", { label: "first" }).then((v) => show("out")("added " + JSON.stringify(v)), fail("out"));
  dash.mutate("lib:add", { label: "second" }).then(show("out2"), fail("out2"));
});
dash.context.then((c) => { $("ctx").textContent = c.dashboard + "/" + c.block + " on " + c.shard + " as " + c.role; });
dash.onTheme((t) => { $("theme").textContent = t.mode + " " + (t.vars["--accent"] || ""); });
dash.ready();
`,
});

const WORK = [
  { _id: "work_1", fnName: XSS, status: "pending", paused: false, attempts: 0, history: [], lastError: null },
  { _id: "work_2", fnName: "emails:send", status: "failed", paused: true, attempts: 2, history: [{ at: Date.now() - 60_000, event: "attempt 1", outcome: "failed" }, { at: Date.now() - 30_000, event: "attempt 2", outcome: "failed" }], lastError: "Error: SMTP down\n    at send (emails.ts:12)" },
  { _id: "work_3", fnName: "ai:summarize", status: "running", paused: false, attempts: 1, history: [], lastError: null },
];

/** R2 objects no `_files` row references (two pages), and the one a row got since the listing (the project keeps it). */
export const ORPHANS = [
  { key: `f/b3JnOmFjbWU/${"aa".repeat(32)}`, shard: "org:acme", size: 2048, uploaded: Date.now() - 3 * 86_400_000 },
  { key: `t/b3JnOmFjbWU/_storage_01OLD`, shard: "org:acme", size: 512, uploaded: Date.now() - 2 * 86_400_000 },
  { key: `f/Z2xvYmFsOm1haW4/${"bb".repeat(32)}`, shard: "global:main", size: 1024, uploaded: Date.now() - 86_400_000 * 5 },
];
export const REFERENCED_ORPHAN = ORPHANS[1]!.key;

export function fakeProject(o: { legacy?: boolean } = {}) {
  const posts: Array<{ path: string; body: unknown }> = [];
  const lists: Array<Record<string, string>> = [];
  /** Dashboard queries the project ran (`dashboards/query`), with their args. */
  const dashQueries: Array<{ fn: string; args: unknown; shard: string | null }> = [];
  const bookmarks = [
    { id: 1, at: Date.now() - 7_200_000, bookmark: BOOKMARK, reason: "deploy:v1" },
    { id: 2, at: Date.now() - 3_600_000, bookmark: BOOKMARK.replace(/f$/, "e"), reason: "hourly" },
  ];
  const json = (b: unknown, status = 200) => Response.json(b, { status });
  /** Remote auth (`remoteAuth`): users, sessions and keys live at this origin; the runtime answers no_local_auth. */
  const state: { authFrom: string | null } = { authFrom: null };
  const noLocalAuth = () =>
    json({ ok: false, error: { code: "no_local_auth", message: `auth is handled by ${state.authFrom}: users, sessions, revocation and key rotation live there (remote auth, no local Auth DO)` } }, 404);
  /** Every admin call the project got (`<METHOD> <path>[?shard=...]`): the dashboard's cost to the project. */
  const calls: string[] = [];
  /** Writes held until released (`@lab/lib:add` with label "slow"): a write in flight. */
  const held: Array<() => void> = [];
  const svc = {
    fetch: async (r: Request | string) => {
      const req = r as Request;
      const url = new URL(req.url);
      const p = url.pathname.replace("/api/_ember/", "");
      calls.push(`${req.method} ${p}${url.searchParams.getAll("shard").length ? `?${url.searchParams.getAll("shard").join(",")}` : ""}`);
      if (state.authFrom && (p === "keys/rotate" || (p.startsWith("auth/") && p !== "auth/revoke-sockets"))) return noLocalAuth();
      if (req.method === "POST" && p === "files/upload") {
        const bytes = await req.text();
        posts.push({ path: p, body: { query: Object.fromEntries(url.searchParams), bytes } });
        return json({ ok: true, value: { id: "_storage_up", size: bytes.length } });
      }
      if (req.method === "GET" && p === "files/content") {
        const id = url.searchParams.get("id");
        const file = FILES.find((f) => f.id === id);
        if (!file) return json({ ok: false, error: { code: "FileNotFound", message: "no" } }, 404);
        return new Response(file.bytes as BodyInit, { headers: { "content-type": "application/octet-stream", "content-disposition": "attachment", "x-ember-content-type": file.content_type } });
      }
      if (req.method === "POST") {
        const body = (await req.json()) as Record<string, unknown>;
        posts.push({ path: p, body });
        if (p === "bookmark") {
          const row = { id: bookmarks.length + 1, at: Date.now(), bookmark: BOOKMARK, reason: `manual:${String(body.label ?? "")}` };
          bookmarks.push(row);
          return json({ ok: true, shard: body.shard, bookmark: row });
        }
        if (p.startsWith("data/")) {
          if (p === "data/insert") return json({ ok: true, value: "messages_3" });
          if (p === "data/delete") return json({ ok: true, value: { deleted: (body.ids as unknown[]).length } });
          const doc = body.doc as Record<string, unknown>;
          if (doc && typeof doc.author !== "string") return json({ ok: false, error: { code: "ValidationError", message: "author: expected string" } }, 400);
          return json({ ok: true, value: { _id: body.id, _creationTime: 2, ...doc } });
        }
        if (p === "env/reveal") return json({ ok: true, name: body.name, value: "smtp-pass-123" });
        if (p === "keys/rotate") return json({ ok: true, kids: ["k1", "k2"] });
        if (p === "auth/revoke") return json({ ok: true, value: { revoked: body.sessionId ? 1 : 2, sockets: 3, shards: (body.shards as unknown[]).length } });
        if (p === "jobs/cancel" || p === "jobs/run" || p === "crons/run") return json({ ok: true, value: "job_new" });
        if (p === "files/delete") return json({ ok: true, value: { deleted: url.searchParams.get("id") } });
        if (p === "run") {
          const as = body.as as { subject: string } | undefined;
          if (body.fn === "messages:send" && typeof (body.args as { channel?: unknown }).channel !== "string") return json({ ok: false, error: { code: "ValidationError", message: "channel: expected string" }, ms: 0.4, type: "mutation", as: null }, 400);
          return json({ ok: true, value: { who: as?.subject ?? null, args: body.args }, ms: 1.5, type: body.fn === "messages:send" ? "mutation" : "query", as: as?.subject ?? null });
        }
        if (p === "dashboards/run" && (body.args as { label?: unknown } | undefined)?.label === "slow") await new Promise<void>((r) => held.push(r));
        if (p === "dashboards/run") return json({ ok: true, value: body.fn === "@pool/lib:cancelAll" ? 3 : body.fn === "@lab/lib:add" ? "it_2" : true, ms: 1, type: "mutation", shard: body.shard });
        if (p === "sql") {
          const text = String(body.sql);
          if (/^\s*delete/i.test(text)) return json({ ok: false, error: { code: "SqlRefused", message: "read-only queries only (SELECT, WITH ... SELECT, VALUES, EXPLAIN QUERY PLAN): DELETE is refused", data: { at: 0 } } }, 400);
          if (body.explain === true) return json({ ok: true, value: { columns: ["id", "parent", "notused", "detail"], rows: [[2, 0, 0, "SCAN messages"]], rowsRead: 0, rowsWritten: 0, truncated: false, ms: 0.2, explain: true, plan: [{ id: 2, detail: "SCAN messages", children: [] }] } });
          return json({ ok: true, value: { columns: ["_id", "author", "body"], rows: [["messages_1", "ana", `a, "quoted" ${XSS}`], ["messages_2", "=cmd()", null]], rowsRead: 2, rowsWritten: 0, truncated: true, ms: 0.4, explain: false } });
        }
        if (p === "replicas/resync") return json({ ok: true, value: { [String(body.source)]: { ok: true, targets: 1 } } });
        if (p === "files/orphans") {
          // Two pages: the first two objects, then the last one.
          const second = body.cursor === "page2";
          return json({ ok: true, value: { scanned: second ? 3 : 5, foreign: second ? 0 : 1, young: second ? 1 : 1, orphans: second ? ORPHANS.slice(2) : ORPHANS.slice(0, 2), deleted: 0, skipped: [], graceMs: body.graceMs ?? 86_400_000, cursor: second ? null : "page2", done: second } });
        }
        if (p === "files/orphans/delete") {
          const keys = body.keys as string[];
          return json({ ok: true, value: { deleted: ORPHANS.filter((x) => keys.includes(x.key) && x.key !== REFERENCED_ORPHAN).map(({ key, shard, size }) => ({ key, shard, size })), refused: keys.includes(REFERENCED_ORPHAN) ? [{ key: REFERENCED_ORPHAN, reason: "referenced" }] : [], skipped: [], graceMs: body.graceMs } });
        }
        if (p === "files/stuck/delete") return json({ ok: true, value: { queued: (body.ids as string[]).filter((id) => id !== "_storage_used"), refused: [], graceMs: body.graceMs } });
        if (p === "restore") return json({ ok: true, shard: body.shard, restoredTo: body.bookmark, undo: "0000000a-0000000b-0000000c-feedfacefeedface", version: 9, epoch: "e2", schemaVersion: "abc" });
      }
      if (p === "capabilities") {
        if (o.legacy) return json({ ok: false, error: { code: "not_found", message: "not found" } }, 404);
        return json({ ok: true, level: 3, features: ["capabilities", "status", "data", "crons", "inspect", "bookmarks", "bookmark", "restore", "schema", "data/list", "data/insert", "data/patch", "data/replace", "data/delete", "functions", "run", "reactivity", "reactivity/profile", "jobs/run", "jobs/cancel", "crons/run", "files/content", "files/upload", "files/delete", "env/reveal", "keys/rotate", "env", "auth/users", "auth/sessions", "auth/revoke", "dashboards", "dashboards/query", "dashboards/run", "sql", "dashboards/embed", "replicas", "replicas/resync", "replicas/lag", "files/orphans", "files/orphans/delete", "files/stuck", "files/stuck/delete"], auth: !state.authFrom, ...(state.authFrom ? { authFrom: state.authFrom } : {}), files: true, system: true });
      }
      if (p === "dashboards") return json({ ok: true, dashboards: o.legacy ? [] : [POOL_SPEC, LAB_SPEC] });
      if (p === "dashboards/embed") {
        // The admin channel: the dashboard's Worker fetches the page with the project's admin token.
        if (req.headers.get("authorization") !== "Bearer proj-admin") return json({ ok: false, error: { code: "unauthorized", message: "admin token required" } }, 401);
        if (url.searchParams.get("dashboard") !== "lab" || url.searchParams.get("route") !== "/dashboard/page") return json({ ok: false, error: { code: "unknown_embed", message: "no such embed" } }, 404);
        return new Response(LAB_PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      if (p === "dashboards/query") {
        const fn = url.searchParams.get("fn")!;
        const args = JSON.parse(url.searchParams.get("args") ?? "{}") as { status?: string; id?: string; paginationOpts?: { numItems: number; cursor: string | null } };
        dashQueries.push({ fn, args, shard: url.searchParams.get("shard") });
        if (fn === "@lab/lib:list") return json({ ok: true, value: [{ _id: "it_1", label: XSS }], ms: 1, type: "query" });
        if (fn === "@pool/lib:stats") return json({ ok: true, value: { pending: 1, running: 1, totals: { succeeded: 12 } }, ms: 1, type: "query" });
        if (fn === "@pool/lib:item") return json({ ok: true, value: WORK.find((w) => w._id === args.id) ?? null, ms: 1, type: "query" });
        if (fn === "@pool/lib:listWork") {
          const all = WORK.filter((w) => !args.status || w.status === args.status);
          const start = Number(args.paginationOpts?.cursor ?? 0);
          const n = args.paginationOpts?.numItems ?? 25;
          const page = all.slice(start, start + n);
          return json({ ok: true, value: { page, isDone: start + n >= all.length, continueCursor: String(start + n) }, ms: 1, type: "query" });
        }
        return json({ ok: false, error: { code: "not_in_dashboard", message: "no" } }, 403);
      }
      if (p === "replicas") {
        const now = Date.now();
        const target = (t: Record<string, unknown>) => ({ last_seq: 0, snapshot: 0, attempts: 0, next_at: 0, dead: 0, last_error: null, delivered_at: now - 30_000, pending: 0, oldest_at: null, ...t });
        return json({
          ok: true,
          tables: [{ name: "auth:member", source: "auth" }, { name: "fxRates", source: "global:main" }],
          sources: {
            auth: {
              enabled: true,
              journal: 0,
              convert: null,
              targets: [target({ target: "org:down", last_seq: 120, attempts: 10, dead: 1, last_error: `org:down is unreachable ${XSS}`, pending: 3, oldest_at: now - 25 * 60_000 }), target({ target: "org:acme", last_seq: 140, pending: 0 })],
              next: null,
              outbox: { seq: 152, depth: 3, parked: 2, oldestAt: now - 25 * 60_000 },
              maxAttempts: 10,
            },
            "global:main": { enabled: true, journal: 0, seq: 77, targets: [target({ target: "org:beta", kind: "org", last_seq: 70, scan_seq: 70, attempts: 2, pending: 7, oldest_at: now - 90_000, last_error: "timeout" })], next: now + 5000, outbox: { seq: 77, depth: 7, parked: 0, oldestAt: now - 90_000 }, maxAttempts: 10 },
          },
        });
      }
      if (p === "files/stuck") {
        const rows = [
          { id: "_storage_abandoned", state: "pending", key: "t/x/_storage_abandoned", size: 4096, contentType: "image/png", refcount: 0, createdAt: Date.now() - 2 * 86_400_000 },
          { id: "_storage_used", state: "failed", key: "t/x/_storage_used", size: null, contentType: null, refcount: 2, createdAt: Date.now() - 3 * 86_400_000 },
        ];
        return json({ ok: true, value: { rows, cursor: null, done: true, totals: { count: 2, bytes: 4096, referenced: 1 }, graceMs: Number(url.searchParams.get("graceMs") ?? 86_400_000) } });
      }
      if (p === "env") return json({ ok: true, vars: [{ name: "EMBER_ADMIN_TOKEN_DASHBOARD", managed: true }, { name: "EMBER_PROJECT", managed: true }, { name: "SMTP_PASSWORD", managed: false }] });
      if (p === "auth/users") {
        const q = url.searchParams.get("q") ?? "";
        const all = [
          { id: "user_ana", email: "ana@acme.test", name: XSS, emailVerified: true, image: null, createdAt: Date.now() - 86_400_000, updatedAt: null },
          { id: "user_bo", email: "bo@acme.test", name: "Bo", emailVerified: false, image: null, createdAt: Date.now() - 3_600_000, updatedAt: null },
        ];
        const users = all.filter((u) => !q || u.email.includes(q));
        return json({ ok: true, users, total: users.length, next: null });
      }
      if (p === "auth/sessions")
        return json({
          ok: true,
          sessions: [
            { id: "sess_1", userId: url.searchParams.get("user"), createdAt: Date.now() - 600_000, updatedAt: null, expiresAt: Date.now() + 86_400_000, ipAddress: "203.0.113.9", userAgent: "Mozilla/5.0", active: true },
            { id: "sess_old", userId: url.searchParams.get("user"), createdAt: Date.now() - 9e9, updatedAt: null, expiresAt: Date.now() - 1000, ipAddress: null, userAgent: null, active: false },
          ],
        });
      if (p === "functions") {
        const obj = (fields: Record<string, unknown>) => ({ kind: "object", fields });
        return json({
          ok: true,
          functions: [
            { name: "auth:whoami", type: "query", visibility: "public", args: obj({}), returns: null, shard: null, sensitive: false, authorize: false, errors: [] },
            {
              name: "messages:send",
              type: "mutation",
              visibility: "public",
              args: obj({
                channel: { shape: { kind: "string" }, optional: false },
                body: { shape: { kind: "string" }, optional: false },
                priority: { shape: { kind: "union", members: [{ kind: "literal", value: "low" }, { kind: "literal", value: "high" }] }, optional: true },
              }),
              returns: null,
              shard: null,
              sensitive: false,
              authorize: false,
              errors: ["MessageTooLong"],
            },
            { name: "messages:secret", type: "query", visibility: "internal", args: obj({}), returns: null, shard: null, sensitive: false, authorize: false, errors: [] },
            { name: "auth:transfer", type: "mutation", visibility: "public", args: obj({ amount: { shape: { kind: "number" }, optional: false } }), returns: null, shard: null, sensitive: true, authorize: false, errors: [] },
          ],
        });
      }
      if (p === "reactivity") {
        return json({
          ok: true,
          report: {
            shard: url.searchParams.get("shard"),
            version: 42,
            subscriptions: 7,
            sockets: 5,
            gates: 1,
            stats: { reruns: 120, debouncedReruns: 0, identityRuns: 30, splits: 1, gateRuns: 12, batches: 40 },
            entries: [
              { key: "k1", fn: "messages:list", args: '{"channel":"general"}', shared: true, subscribers: 4, returned: 50, bytes: 9000, error: null, reads: ["messages.by_channel"], ranges: 1, runs: 60, changed: 58, lastRunAt: Date.now() - 5000 },
              { key: "k2", fn: "messages:mine", args: "{}", shared: false, subscribers: 3, returned: 2, bytes: 300, error: null, reads: ["messages.by_creation_time"], ranges: 1, runs: 60, changed: 3, lastRunAt: Date.now() - 5000 },
            ],
            commits: [{ version: 42, at: Date.now() - 5000, reran: 2, changed: 1, ms: 0.8 }],
          },
        });
      }
      if (p === "reactivity/profile") {
        return json({
          ok: true,
          profile: { fn: "messages:mine", read: 4800, returned: 2, profile: { scanned: 4800, filteredOut: 4798, collectRows: 4800, sql: 0 }, identityRead: true, advice: [{ kind: "filter", message: ".filter() dropped 4798 of the 4800 rows it scanned to return 2: narrow the scan with withIndex (an index on the filtered field)" }, { kind: "identity", message: "reads ctx.auth (in its handler or a middleware), so its result is computed once per signed-in user" }], error: null },
        });
      }
      if (p === "schema") {
        if (o.legacy) return json({ ok: false, error: { code: "not_found", message: "not found" } }, 404);
        return json({
          ok: true,
          version: "abc",
          tables: [
            {
              name: "messages",
              document: {
                kind: "object",
                fields: {
                  author: { shape: { kind: "string" }, optional: false },
                  body: { shape: { kind: "any" }, optional: false },
                  pinned: { shape: { kind: "boolean" }, optional: true },
                  replyTo: { shape: { kind: "id", table: "messages" }, optional: true },
                  attachment: { shape: { kind: "file" }, optional: true },
                },
              },
              indexes: [{ name: "by_author", kind: "db", fields: ["author"] }, { name: "search_body", kind: "search", fields: ["body"], searchField: "body", filterFields: [] }],
              shard: null,
              replicated: { to: ["org"] },
              sql: { table: "messages", columns: ["_rowid", "_id", "_creationTime", "author", "pinned", "replyTo", "attachment", "_json", "_k_by_author"] },
            },
          ],
          componentTables: ["pool$work"],
          internalTables: ["_jobs", "_files"],
        });
      }
      if (p === "data/list") {
        lists.push(Object.fromEntries(url.searchParams));
        const rows: Array<Record<string, unknown>> = [
          { _id: "messages_1", _creationTime: 1, author: "ana", body: XSS },
          { _id: "messages_2", _creationTime: 2, author: XSS, body: { nested: XSS }, replyTo: "messages_1", attachment: "_storage_png" },
          { _id: "messages_3", _creationTime: 3, author: "bo", body: "deploy finished" },
        ];
        const eq = url.searchParams.get("eq");
        const id = url.searchParams.get("id");
        const search = url.searchParams.get("search");
        if (id !== null) return json({ ok: true, value: { page: rows.filter((r) => r._id === id), isDone: true, continueCursor: "" } });
        if (search !== null) return json({ ok: true, value: { page: rows.filter((r) => typeof r.body === "string" && r.body.includes(search)), isDone: true, continueCursor: "" } });
        const page = eq ? rows.filter((r) => r.author === (JSON.parse(eq) as string[])[0]) : rows;
        return json({ ok: true, value: { page: url.searchParams.get("order") === "desc" ? [...page].reverse() : page, isDone: true, continueCursor: "" } });
      }
      if (p === "status") {
        const shards = url.searchParams.getAll("shard");
        return json({
          ok: true,
          expectedVersion: "abc",
          shards: (shards.length ? shards : ["global:main"]).map((s) => ({
            shard: s,
            expectedVersion: "abc",
            schemaVersion: s === "org:beta" ? "old" : "abc",
            ready: s !== "org:beta",
            staged: s === "org:beta" ? [{ table: "messages", index: "by_author", kind: "db", cursor: 10, until: 400 }] : [],
            migrationError: null,
            lastMigrationError: null,
            version: 42,
            databaseSize: 16384,
          })),
        });
      }
      if (p === "inspect") {
        if (o.legacy) return json({ ok: false, error: { code: "not_found", message: "not found" } }, 404);
        return json({ ok: true, shard: { version: 42, subs: 3, queries: 5, shared: 2, stats: { reruns: 17, identityRuns: 1, batches: 9, booted: 1 }, rows: { read: 1200, written: 80 }, jobs: [], bookmarks: bookmarks.length } });
      }
      if (p === "bookmarks") return json({ ok: true, shard: url.searchParams.get("shard"), now: Date.now(), retentionMs: 30 * 86_400_000, bookmarks });
      if (p === "crons") return json({ ok: true, crons: [{ name: "cleanup", schedule: "0 * * * *", fn: "jobs:cleanup", shard: "global:main", state: { last_dispatch: Math.floor(Date.now() / 60_000) - 30, last_error: null } }] });
      if (p === "data") {
        const table = url.searchParams.get("table");
        if (!table) return json({ ok: true, tables: [{ name: "messages", rows: 2, kind: "schema" }, { name: "_jobs", rows: 0, kind: "internal" }] });
        if (table === "_jobs")
          return json({
            ok: true,
            table,
            kind: "internal",
            rows: [
              { id: 1, job_id: "job_pending", fn: "jobs:record", args: '{"label":"later"}', kind: "mutation", state: "pending", run_at: Date.now() + 60_000, attempts: 0, max_attempts: 5, last_error: null },
              { id: 2, job_id: "job_failed", fn: "mail:send", args: '{"to":"ana@x.test"}', kind: "action", state: "failed", run_at: Date.now() - 60_000, attempts: 5, max_attempts: 5, last_error: "SMTP down" },
            ],
            cursor: null,
            done: true,
          });
        if (table === "_files") return json({ ok: true, table, kind: "internal", rows: FILES.map(({ bytes: _b, ...f }) => f), cursor: null, done: true });
        return json({
          ok: true,
          table,
          kind: "schema",
          rows: [
            { _id: "messages_1", _creationTime: 1, author: "ana", body: XSS },
            { _id: "messages_2", _creationTime: 2, author: XSS, body: { nested: XSS } },
          ],
          cursor: null,
          done: true,
        });
      }
      return json({ ok: false, error: { code: "not_found", message: "not found" } }, 404);
    },
  };
  return { svc, posts, lists, dashQueries, calls, remoteAuth: (from: string | null) => void (state.authFrom = from), held, release: () => held.splice(0).forEach((r) => r()) };
}
