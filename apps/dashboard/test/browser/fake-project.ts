// A project Worker's admin API (@freecorps/ember-runtime `/api/_ember/*`) for the browser test, with user data that
// tries to inject markup.

export const XSS = `<img src=x onerror="window.__xss=1">`;
export const BOOKMARK = "00000000-00000008-00005119-0123456789abcdef";

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
        if (p === "restore") return json({ ok: true, shard: body.shard, restoredTo: body.bookmark, undo: "0000000a-0000000b-0000000c-feedfacefeedface", version: 9, epoch: "e2", schemaVersion: "abc" });
      }
      if (p === "capabilities") {
        if (o.legacy) return json({ ok: false, error: { code: "not_found", message: "not found" } }, 404);
        return json({ ok: true, level: 3, features: ["capabilities", "status", "data", "crons", "inspect", "bookmarks", "bookmark", "restore", "schema", "data/list", "data/insert", "data/patch", "data/replace", "data/delete"], auth: true, files: true, system: true });
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
        if (table === "_jobs") return json({ ok: true, table, kind: "internal", rows: [], cursor: null, done: true });
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
