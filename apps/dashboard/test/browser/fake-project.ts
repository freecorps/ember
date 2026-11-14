// A project Worker's admin API (@freecorps/ember-runtime `/api/_ember/*`) for the browser test, with user data that
// tries to inject markup.

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

export function fakeProject(o: { legacy?: boolean } = {}) {
  const posts: Array<{ path: string; body: unknown }> = [];
  const lists: Array<Record<string, string>> = [];
  const bookmarks = [
    { id: 1, at: Date.now() - 7_200_000, bookmark: BOOKMARK, reason: "deploy:v1" },
    { id: 2, at: Date.now() - 3_600_000, bookmark: BOOKMARK.replace(/f$/, "e"), reason: "hourly" },
  ];
  const json = (b: unknown, status = 200) => Response.json(b, { status });
  const svc = {
    fetch: async (r: Request | string) => {
      const req = r as Request;
      const url = new URL(req.url);
      const p = url.pathname.replace("/api/_ember/", "");
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
        if (p === "jobs/cancel" || p === "jobs/run" || p === "crons/run") return json({ ok: true, value: "job_new" });
        if (p === "files/delete") return json({ ok: true, value: { deleted: url.searchParams.get("id") } });
        if (p === "run") {
          const as = body.as as { subject: string } | undefined;
          if (body.fn === "messages:send" && typeof (body.args as { channel?: unknown }).channel !== "string") return json({ ok: false, error: { code: "ValidationError", message: "channel: expected string" }, ms: 0.4, type: "mutation", as: null }, 400);
          return json({ ok: true, value: { who: as?.subject ?? null, args: body.args }, ms: 1.5, type: body.fn === "messages:send" ? "mutation" : "query", as: as?.subject ?? null });
        }
        if (p === "restore") return json({ ok: true, shard: body.shard, restoredTo: body.bookmark, undo: "0000000a-0000000b-0000000c-feedfacefeedface", version: 9, epoch: "e2", schemaVersion: "abc" });
      }
      if (p === "capabilities") {
        if (o.legacy) return json({ ok: false, error: { code: "not_found", message: "not found" } }, 404);
        return json({ ok: true, level: 3, features: ["capabilities", "status", "data", "crons", "inspect", "bookmarks", "bookmark", "restore", "schema", "data/list", "data/insert", "data/patch", "data/replace", "data/delete", "functions", "run", "reactivity", "reactivity/profile", "jobs/run", "jobs/cancel", "crons/run", "files/content", "files/upload", "files/delete"], auth: true, files: true, system: true });
      }
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
              document: { kind: "object", fields: { author: { shape: { kind: "string" }, optional: false }, body: { shape: { kind: "any" }, optional: false }, pinned: { shape: { kind: "boolean" }, optional: true } } },
              indexes: [{ name: "by_author", kind: "db", fields: ["author"] }, { name: "search_body", kind: "search", fields: ["body"] }],
              shard: null,
            },
          ],
          componentTables: [],
        });
      }
      if (p === "data/list") {
        lists.push(Object.fromEntries(url.searchParams));
        const rows = [
          { _id: "messages_1", _creationTime: 1, author: "ana", body: XSS },
          { _id: "messages_2", _creationTime: 2, author: XSS, body: { nested: XSS } },
        ];
        const eq = url.searchParams.get("eq");
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
  return { svc, posts, lists };
}
