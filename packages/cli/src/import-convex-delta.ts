// `ember import convex --from-deployment <url> --deploy-key-env VAR [--since <cursor>] [--watch]` (PLAN §22 L4,
// contracts.md "Importar do Convex", modo delta). Convex's streaming export API (the one its Fivetran and Airbyte
// connectors use, public HTTP API docs): `GET /api/list_snapshot` walks a consistent snapshot (`snapshot`, `cursor`,
// `hasMore`; one table at a time here, parents before `via` children), then `GET /api/document_deltas` walks the change
// log from the snapshot's timestamp (`cursor`, `hasMore`; deletions are `{_id, _ts, _deleted: true}`, every value has
// `_table`). Authorization: `Convex <deploy key>`. Timestamps are nanoseconds (above 2^53): kept as strings.
//
// Every document's shard is kept in a local SQLite file (`.ember/import/convex-stream-<hash>.sqlite`): `via` children
// find their parent's shard, a delete reaches the shard that holds the document, and a document whose route changed
// is deleted from its old shard. The cursor is saved after each page is applied (applying a page again is
// idempotent), so a run resumes where the last one stopped; `--watch` keeps tailing until it is stopped (cutover).

import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { encodeJson } from "@freecorps/ember-values";
import { convexTableNumber, type ForeignIds, type ImportDoc } from "@freecorps/ember-server";
import type { Project } from "./config.ts";
import { AdminClient, loadImport, makePipeline, type ImportTarget, type RouteStore } from "./import-convex.ts";

export interface ConvexDeltaOptions {
  project: Project;
  target: ImportTarget;
  /** The Convex deployment URL (`https://<name>.convex.cloud`). */
  deployment: string;
  deployKey: string;
  /** Start from this delta cursor (skips the snapshot). */
  since?: string;
  /** Keep polling the deltas until stopped. */
  watch?: boolean;
  /** Pause between rounds with `watch` (default 5 s). */
  intervalMs?: number;
  /** Tests: stop after this many delta rounds. */
  maxRounds?: number;
  /** Stops the watch loop (SIGINT in the CLI). */
  signal?: AbortSignal;
  strict?: boolean;
  fresh?: boolean;
  log?: (line: string) => void;
  /** For the Convex calls (tests); the Ember calls use `target.fetch`. */
  convexFetch?: typeof fetch;
}

export interface ConvexDeltaReport {
  snapshot: { done: boolean; documents: number; skipped: number; orphans: number };
  deltas: { upserts: number; deletes: number; moved: number; ignored: number; orphans: number; rounds: number };
  invalid: number;
  cursor: string | null;
  shards: string[];
  foreignIds: ForeignIds;
  stateFile: string;
}

type Page = { values: Record<string, unknown>[]; hasMore: boolean; cursor: string | null; snapshot?: string };

/**
 * JSON with the envelope's big integers kept as strings: the response's own `snapshot` and `cursor`, and `_ts` of
 * each entry of `values`. Nothing inside a document is touched (a user field named `cursor` keeps its number).
 */
export function parseBig(text: string): Record<string, unknown> {
  type Frame = { arr: boolean; key: string | null; wantKey: boolean };
  const stack: Frame[] = [];
  const out: string[] = [];
  let from = 0;
  const big = (): boolean => {
    const [top, values, doc] = stack;
    if (stack.length === 1) return !top!.arr && (top!.key === "snapshot" || top!.key === "cursor");
    return stack.length === 3 && !top!.arr && top!.key === "values" && values!.arr && !doc!.arr && doc!.key === "_ts";
  };
  for (let i = 0; i < text.length; ) {
    const c = text.charCodeAt(i);
    const f = stack[stack.length - 1];
    if (c === 0x22 /* " */) {
      let j = i + 1;
      for (;;) {
        const q = text.indexOf('"', j);
        if (q < 0) throw new SyntaxError("Unterminated string in JSON");
        let k = q - 1;
        while (text.charCodeAt(k) === 0x5c /* \\ */) k--;
        j = q + 1;
        if ((q - 1 - k) % 2 === 0) break;
      }
      if (f && !f.arr && f.wantKey) f.key = JSON.parse(text.slice(i, j)) as string;
      i = j;
    } else if (c === 0x7b /* { */ || c === 0x5b /* [ */) {
      stack.push({ arr: c === 0x5b, key: null, wantKey: c === 0x7b });
      i++;
    } else if (c === 0x7d /* } */ || c === 0x5d /* ] */) {
      stack.pop();
      i++;
    } else if (c === 0x3a /* : */) {
      if (f) f.wantKey = false;
      i++;
    } else if (c === 0x2c /* , */) {
      if (f && !f.arr) f.wantKey = true;
      i++;
    } else if (c === 0x2d /* - */ || (c >= 0x30 && c <= 0x39)) {
      let j = i + 1;
      while (j < text.length && /[0-9.eE+-]/.test(text[j]!)) j++;
      if (big() && /^-?\d+$/.test(text.slice(i, j))) {
        out.push(text.slice(from, i), '"', text.slice(i, j), '"');
        from = j;
      }
      i = j;
    } else i++;
  }
  out.push(text.slice(from));
  return JSON.parse(out.join("")) as Record<string, unknown>;
}

/** Waits `ms`, or less when `signal` aborts; the abort listener is removed either way (one `--watch` round each). */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const t = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

class ConvexStream {
  private readonly base: string;
  private readonly key: string;
  private readonly fetchImpl: typeof fetch;
  constructor(base: string, key: string, fetchImpl: typeof fetch = fetch) {
    this.base = base;
    this.key = key;
    this.fetchImpl = fetchImpl;
  }

  private async get(path: string, params: Record<string, string | undefined>): Promise<Record<string, unknown>> {
    const url = new URL(path, this.base);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
    url.searchParams.set("format", "json");
    let last: Error | null = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
      try {
        const res = await this.fetchImpl(url, { headers: { authorization: `Convex ${this.key}`, accept: "application/json" } });
        const text = await res.text();
        if (res.ok) return parseBig(text);
        last = new Error(`Convex ${url.pathname}: ${res.status} ${text.slice(0, 300)}`);
        if (res.status < 500 && res.status !== 429) throw last;
      } catch (e) {
        if (e === last) throw e;
        last = e as Error;
      }
    }
    throw last!;
  }

  /** Table names (`GET /api/json_schemas`). */
  async tables(): Promise<string[] | null> {
    try {
      return Object.keys(await this.get("/api/json_schemas", { deltaSchema: "true" }));
    } catch {
      return null;
    }
  }

  async listSnapshot(o: { tableName: string; snapshot?: string; cursor?: string }): Promise<Page> {
    const r = await this.get("/api/list_snapshot", { tableName: o.tableName, snapshot: o.snapshot, cursor: o.cursor });
    return { values: (r.values as Record<string, unknown>[]) ?? [], hasMore: r.hasMore === true, cursor: (r.cursor as string | null) ?? null, snapshot: String(r.snapshot) };
  }

  async documentDeltas(cursor: string): Promise<Page> {
    const r = await this.get("/api/document_deltas", { cursor });
    return { values: (r.values as Record<string, unknown>[]) ?? [], hasMore: r.hasMore === true, cursor: r.cursor === undefined || r.cursor === null ? cursor : String(r.cursor) };
  }
}

const strip = (v: Record<string, unknown>): Record<string, unknown> => {
  const { _table: _t, _ts: _s, _deleted: _d, _component: _c, ...doc } = v;
  return doc;
};

/** Upserts and deletes per (shard, table), the last operation per id winning; sent page by page. */
class Uploader {
  private readonly ops = new Map<string, Map<string, string | null>>();
  private readonly begun = new Map<string, number>();
  readonly touched = new Set<string>();
  readonly shards = new Set<string>();
  invalid = 0;
  private version = 0;
  private readonly admin: AdminClient;
  private foreign: ForeignIds;
  private readonly strict: boolean;
  private readonly log: (l: string) => void;

  constructor(admin: AdminClient, foreign: ForeignIds, strict: boolean, log: (l: string) => void) {
    this.admin = admin;
    this.foreign = foreign;
    this.strict = strict;
    this.log = log;
  }

  setForeign(f: ForeignIds) {
    this.foreign = f;
    this.version++;
  }

  private key = (shard: string, table: string) => `${shard}\u0000${table}`;

  upsert(shard: string, table: string, doc: ImportDoc) {
    let m = this.ops.get(this.key(shard, table));
    if (!m) this.ops.set(this.key(shard, table), (m = new Map()));
    m.delete(doc._id);
    m.set(doc._id, encodeJson(doc));
  }

  delete(shard: string, table: string, id: string) {
    let m = this.ops.get(this.key(shard, table));
    if (!m) this.ops.set(this.key(shard, table), (m = new Map()));
    m.delete(id);
    m.set(id, null);
  }

  /** Before a (shard, table)'s first batch, and again when the id map grew: only that table is pinned classic. */
  private async begin(shard: string, table: string) {
    const k = this.key(shard, table);
    if (this.begun.get(k) === this.version) return;
    await this.admin.call("POST", "/api/_ember/import/begin", { shard, foreignIds: this.foreign, tables: [table] });
    this.begun.set(k, this.version);
  }

  async flush(): Promise<void> {
    for (const [key, m] of [...this.ops]) {
      this.ops.delete(key);
      const [shard, table] = key.split("\u0000") as [string, string];
      await this.begin(shard, table);
      this.shards.add(shard);
      this.touched.add(shard);
      let docs: string[] = [];
      let deletes: string[] = [];
      let bytes = 0;
      const send = async () => {
        if (!docs.length && !deletes.length) return;
        const body = `{"shard":${JSON.stringify(shard)},"table":${JSON.stringify(table)},${this.strict ? '"strict":true,' : ""}"docs":[${docs.join(",")}],"deletes":${JSON.stringify(deletes)}}`;
        const r = await this.admin.call<{ written: number; invalid: Array<{ id: string | null; message: string }> }>("POST", "/api/_ember/import/batch", new TextEncoder().encode(body), { "content-type": "application/json" });
        this.invalid += r.invalid.length;
        for (const x of r.invalid.slice(0, 5)) this.log(`invalid ${table} ${x.id ?? "?"} (${shard}): ${x.message}`);
        docs = [];
        deletes = [];
        bytes = 0;
      };
      for (const [id, enc] of m) {
        if (enc === null) deletes.push(id);
        else {
          docs.push(enc);
          bytes += enc.length;
        }
        if (docs.length + deletes.length >= 500 || bytes >= 1_500_000) await send();
      }
      await send();
    }
  }

  async finish(): Promise<void> {
    for (const shard of [...this.touched].sort()) await this.admin.call("POST", "/api/_ember/import/finish", { shard });
    this.touched.clear();
  }
}

export async function importConvexDeltas(o: ConvexDeltaOptions): Promise<ConvexDeltaReport> {
  const log = o.log ?? (() => {});
  const { manifest, config } = await loadImport(o.project);
  const convex = new ConvexStream(o.deployment, o.deployKey, o.convexFetch);
  const dir = join(o.project.stateDir, "import");
  mkdirSync(dir, { recursive: true });
  const stateFile = join(dir, `convex-stream-${createHash("sha256").update(`${o.deployment}\n${o.target.url}`).digest("hex").slice(0, 16)}.sqlite`);
  if (o.fresh) rmSync(stateFile, { force: true });
  const db = new DatabaseSync(stateFile);
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS routes (id TEXT PRIMARY KEY, tbl TEXT NOT NULL, shard TEXT)`);
    const getMeta = (k: string) => (db.prepare(`SELECT value FROM meta WHERE key = ?`).get(k) as { value: string } | undefined)?.value;
    const setMeta = (k: string, v: string) => db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`).run(k, v);
    const getRoute = db.prepare(`SELECT tbl, shard FROM routes WHERE id = ?`);
    const putRoute = db.prepare(`INSERT INTO routes (id, tbl, shard) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET tbl = excluded.tbl, shard = excluded.shard`);
    const delRoute = db.prepare(`DELETE FROM routes WHERE id = ?`);
    const store: RouteStore = {
      get: (id) => (getRoute.get(id) as { shard: string | null } | undefined)?.shard,
      set: (table, id, shard) => void putRoute.run(id, table, shard),
    };

    // Tables: the deployment's (json_schemas), the schema's, minus `skip`.
    const skip = new Set(config.skip ?? []);
    const remote = await convex.tables();
    const tables = Object.keys(manifest.tables).filter((t) => !t.includes("$") && !skip.has(t) && (!remote || remote.includes(t))).sort();
    for (const t of remote ?? []) if (!t.startsWith("_") && !manifest.tables[t] && !skip.has(t)) log(`warning: table ${t} of the deployment is not in ember/schema.ts: not imported`);
    const pipe = makePipeline(manifest, config, tables, store);
    const numbers: Record<string, string> = JSON.parse(getMeta("numbers") ?? "{}");
    const foreign = (): ForeignIds => ({ convex: { ...numbers } });
    const learn = (table: string, id: unknown): boolean => {
      const n = convexTableNumber(id);
      if (n === undefined || numbers[String(n)] === table) return false;
      numbers[String(n)] = table;
      setMeta("numbers", JSON.stringify(numbers));
      return true;
    };
    const up = new Uploader(new AdminClient(o.target), foreign(), !!o.strict, log);
    const report: ConvexDeltaReport = {
      snapshot: { done: false, documents: 0, skipped: 0, orphans: 0 },
      deltas: { upserts: 0, deletes: 0, moved: 0, ignored: 0, orphans: 0, rounds: 0 },
      invalid: 0,
      cursor: null,
      shards: [],
      foreignIds: foreign(),
      stateFile,
    };

    // Table numbers before any document is sent: a reference to a table not seen yet would be "no table".
    let snapshot = getMeta("snapshot");
    if (getMeta("numbers") === undefined) {
      for (const t of tables) {
        const p = await convex.listSnapshot({ tableName: t, ...(snapshot ? { snapshot } : {}) });
        snapshot ??= p.snapshot;
        if (p.values[0]) learn(t, p.values[0]._id);
      }
      setMeta("numbers", JSON.stringify(numbers));
    }
    up.setForeign(foreign());

    if (o.since) {
      // An explicit cursor wins over the saved one (replaying deltas is idempotent).
      setMeta("cursor", o.since);
      setMeta("phase", "deltas");
    }
    if (getMeta("phase") !== "deltas") {
      if (!snapshot) throw new Error("list_snapshot gave no snapshot timestamp");
      setMeta("snapshot", snapshot);
      let i = Number(getMeta("table_index") ?? 0);
      for (; i < pipe.order.length; i++) {
        const table = pipe.order[i]!;
        let cursor = getMeta("table_cursor") ?? undefined;
        for (;;) {
          const page = await convex.listSnapshot({ tableName: table, snapshot, ...(cursor ? { cursor } : {}) });
          db.exec("BEGIN");
          for (const v of page.values) {
            if (learn(table, v._id)) up.setForeign(foreign());
            const r = pipe.route(table, strip(v));
            if (r.shard) {
              up.upsert(r.shard, table, r.doc);
              report.snapshot.documents++;
            } else if (r.why === "orphan") report.snapshot.orphans++;
            else report.snapshot.skipped++;
          }
          db.exec("COMMIT");
          await up.flush();
          if (!page.hasMore || !page.cursor) break;
          cursor = page.cursor;
          setMeta("table_cursor", cursor);
        }
        db.prepare(`DELETE FROM meta WHERE key = 'table_cursor'`).run();
        setMeta("table_index", String(i + 1));
        log(`${table}: snapshot imported`);
      }
      await up.finish();
      setMeta("cursor", snapshot);
      setMeta("phase", "deltas");
    }
    report.snapshot.done = true;

    let cursor = getMeta("cursor")!;
    for (;;) {
      for (;;) {
        const page = await convex.documentDeltas(cursor);
        db.exec("BEGIN");
        for (const v of page.values) {
          const table = String(v._table ?? "");
          if (!tables.includes(table)) {
            report.deltas.ignored++;
            continue;
          }
          const id = String(v._id);
          const prev = getRoute.get(id) as { tbl: string; shard: string | null } | undefined;
          if (v._deleted === true) {
            if (prev?.shard) up.delete(prev.shard, table, id);
            delRoute.run(id);
            report.deltas.deletes++;
            continue;
          }
          if (learn(table, id)) up.setForeign(foreign());
          const r = pipe.route(table, strip(v));
          if (prev?.shard && prev.shard !== r.shard) {
            // The route changed (tenant field edited, parent moved): out of the old shard.
            up.delete(prev.shard, table, id);
            report.deltas.moved++;
          }
          if (r.shard) {
            up.upsert(r.shard, table, r.doc);
            report.deltas.upserts++;
          } else if (r.why === "orphan") report.deltas.orphans++;
        }
        db.exec("COMMIT");
        await up.flush();
        cursor = page.cursor ?? cursor;
        setMeta("cursor", cursor);
        if (!page.hasMore) break;
      }
      await up.finish();
      report.deltas.rounds++;
      log(`deltas: round ${report.deltas.rounds}, cursor ${cursor}`);
      if (!o.watch || o.signal?.aborted || (o.maxRounds !== undefined && report.deltas.rounds >= o.maxRounds)) break;
      await sleep(o.intervalMs ?? 5000, o.signal);
      if (o.signal?.aborted) break;
    }
    report.cursor = cursor;
    report.invalid = up.invalid;
    report.shards = [...up.shards].sort();
    report.foreignIds = foreign();
    return report;
  } finally {
    db.close();
  }
}
