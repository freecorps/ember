// ember-spike-main: one Worker + SQLite DO used for R3-R6, R8, X1, X2.
import { DurableObject } from "cloudflare:workers";

const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
const err = (e) => ({ ok: false, error: String(e?.message ?? e) });

let traceCache = null;
async function trace() {
  if (traceCache) return traceCache;
  const t = await (await fetch("https://www.cloudflare.com/cdn-cgi/trace")).text();
  const m = Object.fromEntries(t.trim().split("\n").map((l) => l.split("=")));
  traceCache = { colo: m.colo, loc: m.loc, ip_country: m.loc };
  return traceCache;
}

export class Shard extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.boot = Date.now();
    const sql = ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS docs(id INTEGER PRIMARY KEY, k TEXT, v TEXT, at INTEGER);
      CREATE INDEX IF NOT EXISTS docs_k ON docs(k);
      CREATE TABLE IF NOT EXISTS counters(k TEXT PRIMARY KEY, n INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS alarm_log(kind TEXT, scheduled INTEGER, fired INTEGER, extra TEXT);
      CREATE TABLE IF NOT EXISTS rb_test(v TEXT);
      CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS pitr(v TEXT, at INTEGER);`);
    this.seq = 0;
  }
  meta(k, v) {
    const sql = this.ctx.storage.sql;
    if (v === undefined) return sql.exec("SELECT v FROM meta WHERE k=?", k).toArray()[0]?.v ?? null;
    sql.exec("INSERT INTO meta VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", k, String(v));
  }
  mutate(k) {
    const sql = this.ctx.storage.sql;
    sql.exec("INSERT INTO docs(k,v,at) VALUES(?,?,?)", k, "x".repeat(64), Date.now());
    sql.exec("INSERT INTO counters VALUES(?,1) ON CONFLICT(k) DO UPDATE SET n=n+1", k.slice(0, 4));
  }
  broadcast(msg, except) {
    const s = typeof msg === "string" ? msg : JSON.stringify(msg);
    let n = 0, fail = 0;
    for (const ws of this.ctx.getWebSockets("sub")) {
      if (ws === except) continue;
      try { ws.send(s); n++; } catch { fail++; }
    }
    return { n, fail };
  }

  async fetch(req) {
    const u = new URL(req.url);
    const op = u.pathname.split("/").pop();
    const q = (k, d) => u.searchParams.get(k) ?? d;
    const sql = this.ctx.storage.sql;
    try {
      switch (op) {
        case "info": {
          const t = await trace();
          return J({ doColo: t.colo, doLoc: t.loc, workerColo: req.headers.get("x-worker-colo"), id: this.ctx.id.toString(), bootAgeMs: Date.now() - this.boot });
        }
        case "q": {
          const rows = sql.exec("SELECT id,k FROM docs ORDER BY id DESC LIMIT 10").toArray();
          return J({ rows: rows.length });
        }
        case "m": {
          const t0 = Date.now();
          this.mutate("m" + this.seq++);
          if (q("sync") === "1") { await this.ctx.storage.sync(); }
          return J({ ok: true, syncMs: Date.now() - t0 });
        }
        case "ws": {
          if (req.headers.get("Upgrade") !== "websocket") return J({ error: "expected websocket" }, 426);
          const pair = new WebSocketPair();
          this.ctx.acceptWebSocket(pair[1], ["sub"]);
          return new Response(null, { status: 101, webSocket: pair[0] });
        }
        case "wscount": return J({ n: this.ctx.getWebSockets().length, sub: this.ctx.getWebSockets("sub").length });
        case "bcast": {
          const size = Number(q("size", "32"));
          const t0 = Date.now();
          const r = this.broadcast({ t: "b", seq: Number(q("seq", "0")), pad: "x".repeat(Math.max(0, size - 30)) });
          // Date.now only advances on I/O in prod; force an I/O to read wall time
          await this.ctx.storage.sync();
          return J({ ...r, sendLoopPlusSyncMs: Date.now() - t0 });
        }
        case "wsclose": {
          let n = 0;
          for (const ws of this.ctx.getWebSockets()) { try { ws.close(1000, "bye"); n++; } catch {} }
          return J({ closed: n });
        }
        // ----- alarms (R3)
        case "alarm-far": {
          const at = Date.now() + 5 * 365 * 864e5;
          await this.ctx.storage.setAlarm(at);
          this.meta("mode", "far");
          return J({ set: at, get: await this.ctx.storage.getAlarm() });
        }
        case "alarm-get": return J({ get: await this.ctx.storage.getAlarm(), bootAgeMs: Date.now() - this.boot, mode: this.meta("mode") });
        case "alarm-delete": await this.ctx.storage.deleteAlarm(); return J({ ok: true });
        case "alarm60": {
          const at = Date.now() + Number(q("ms", "60000"));
          this.meta("mode", "precision"); this.meta("scheduled", at);
          await this.ctx.storage.setAlarm(at);
          return J({ scheduled: at });
        }
        case "alarm-throw": {
          sql.exec("DELETE FROM rb_test");
          this.meta("mode", "throw");
          const at = Date.now() + 1000;
          await this.ctx.storage.setAlarm(at);
          return J({ scheduled: at });
        }
        case "alarm-log": return J({ rows: sql.exec("SELECT * FROM alarm_log").toArray(), rb: sql.exec("SELECT * FROM rb_test").toArray(), kvMarker: await this.ctx.storage.get("marker") ?? null });
        case "abort": { this.ctx.abort("evict for test"); return J({ unreachable: true }); }
        // ----- limits (R5)
        case "limits": return J(await this.limits());
        case "clock": {
          const a = Date.now(), pa = performance.now();
          let x = 0; for (let i = 0; i < 2e7; i++) x += i % 7;
          const b = Date.now(), pb = performance.now();
          await this.ctx.storage.sync();
          const c = Date.now();
          return J({ dateAdvancedDuringSyncLoop: b - a, perfAdvanced: pb - pa, afterIo: c - a, x });
        }
        // ----- PITR (R6)
        case "pitr-write": {
          const v = q("v", "x");
          sql.exec("INSERT INTO pitr VALUES(?,?)", v, Date.now());
          return J({ ok: true, rows: sql.exec("SELECT v FROM pitr").toArray().map((r) => r.v), bookmark: await this.ctx.storage.getCurrentBookmark() });
        }
        case "pitr-read": return J({ rows: sql.exec("SELECT v FROM pitr").toArray().map((r) => r.v), bookmark: await this.ctx.storage.getCurrentBookmark() });
        case "pitr-bm-time": {
          const ms = Number(q("ago", "60000"));
          return J({ bookmark: await this.ctx.storage.getBookmarkForTime(Date.now() - ms) });
        }
        case "pitr-restore": {
          const bm = q("bm");
          const undo = await this.ctx.storage.onNextSessionRestoreBookmark(bm);
          // respond first, then abort shortly after
          setTimeout(() => this.ctx.abort("pitr restore"), 50);
          return J({ undo });
        }
        // ----- X1/X2
        case "selfbench": {
          const n = Number(q("n", "10000"));
          const batch = q("txn") === "1";
          const t0 = Date.now();
          if (batch) this.ctx.storage.transactionSync(() => { for (let i = 0; i < n; i++) this.mutate("s" + (this.seq++)); });
          else for (let i = 0; i < n; i++) this.mutate("s" + (this.seq++));
          await this.ctx.storage.sync();
          return J({ n, totalMsInclCommit: Date.now() - t0 });
        }
        case "bigrow": {
          const n = Number(q("bytes"));
          sql.exec("CREATE TABLE IF NOT EXISTS bigk(id INTEGER PRIMARY KEY, a)");
          sql.exec("INSERT INTO bigk(a) VALUES(?)", new Uint8Array(n));
          return J({ ok: true, rows: sql.exec("SELECT id, length(a) l FROM bigk").toArray(), size: sql.databaseSize });
        }
        case "bigrow-read": return J({ rows: sql.exec("SELECT id, length(a) l FROM bigk").toArray(), size: sql.databaseSize, bootAgeMs: Date.now() - this.boot });
        case "stats": return J({ docs: sql.exec("SELECT count(*) c FROM docs").one().c, size: sql.databaseSize });
        case "reset": sql.exec("DELETE FROM docs; DELETE FROM counters;"); return J({ ok: true });
        default: return J({ error: "unknown op " + op }, 404);
      }
    } catch (e) {
      return J(err(e), 500);
    }
  }

  async webSocketMessage(ws, data) {
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (m.op === "mut") { // R8: mutation -> ack to sender, patch to all other subscribers
      this.mutate("w" + this.seq++);
      ws.send(JSON.stringify({ t: "ack", c: m.c }));
      if (m.fanout !== false) this.broadcast({ t: "patch", c: m.c }, ws);
    } else if (m.op === "mut1") { // X1: one mutation per message
      this.mutate("x" + this.seq++);
      ws.send(JSON.stringify({ t: "ack", c: m.c }));
    } else if (m.op === "mutb") { // X1: n mutations in one transactionSync
      this.ctx.storage.transactionSync(() => { for (let i = 0; i < m.n; i++) this.mutate("b" + this.seq++); });
      ws.send(JSON.stringify({ t: "ack", c: m.c, n: m.n }));
    } else if (m.op === "ping") {
      ws.send(JSON.stringify({ t: "pong", c: m.c }));
    }
  }
  async webSocketClose(ws, code) { try { ws.close(code, "closing"); } catch {} }
  async webSocketError() {}

  async alarm(info) {
    const sql = this.ctx.storage.sql;
    const mode = this.meta("mode");
    if (mode === "precision") {
      const sched = Number(this.meta("scheduled"));
      sql.exec("INSERT INTO alarm_log VALUES('precision',?,?,?)", sched, Date.now(), JSON.stringify(info ?? {}));
    } else if (mode === "throw") {
      if (!info?.isRetry) {
        sql.exec("INSERT INTO rb_test VALUES('attempt0-sql')");
        await this.ctx.storage.put("marker", "attempt0-kv");
        throw new Error("intentional alarm failure");
      }
      const rows = sql.exec("SELECT v FROM rb_test").toArray().map((r) => r.v);
      const kv = await this.ctx.storage.get("marker");
      sql.exec("INSERT INTO alarm_log VALUES('throw-retry',0,?,?)", Date.now(), JSON.stringify({ info, rowsSeenOnRetry: rows, kvSeenOnRetry: kv ?? null }));
    } else {
      sql.exec("INSERT INTO alarm_log VALUES(?,0,?,?)", String(mode), Date.now(), JSON.stringify(info ?? {}));
    }
  }

  async limits() {
    const sql = this.ctx.storage.sql;
    const out = {};
    const tryq = (name, f) => { try { const r = f(); out[name] = { ok: true, r }; } catch (e) { out[name] = { ok: false, e: String(e.message ?? e) }; } };
    sql.exec("CREATE TABLE IF NOT EXISTS big(id INTEGER PRIMARY KEY, a, b)");
    for (const n of [1_000_000, 1_999_000, 2_000_000, 2_097_152, 2_097_153, 4_194_304, 8_388_608]) {
      tryq("blob_" + n, () => { sql.exec("INSERT INTO big(a) VALUES(?)", new Uint8Array(n)); return "inserted"; });
      tryq("text_" + n, () => { sql.exec("INSERT INTO big(a) VALUES(?)", "a".repeat(n)); return "inserted"; });
    }
    tryq("row_two_1_5MB_cols", () => { sql.exec("INSERT INTO big(a,b) VALUES(?,?)", "a".repeat(1_500_000), "b".repeat(1_500_000)); return "inserted"; });
    tryq("row_grow_via_concat_to_3MB", () => { sql.exec("INSERT INTO big(id,a) VALUES(999,?)", "a".repeat(1_500_000)); sql.exec("UPDATE big SET a = a || a WHERE id=999"); return "updated"; });
    sql.exec("DROP TABLE big");
    tryq("bind_100", () => { sql.exec("SELECT " + Array(100).fill("?").join(","), ...Array(100).fill(1)); return "ok"; });
    tryq("bind_101", () => { sql.exec("SELECT " + Array(101).fill("?").join(","), ...Array(101).fill(1)); return "ok"; });
    tryq("stmt_100000", () => { sql.exec("SELECT '" + "a".repeat(100000 - 9) + "'"); return "ok"; });
    tryq("stmt_100001", () => { sql.exec("SELECT '" + "a".repeat(100001 - 9) + "'"); return "ok"; });
    const blocked = ["page_count", "freelist_count", "max_page_count", "journal_mode", "synchronous", "cache_size", "user_version", "schema_version", "application_id", "integrity_check", "compile_options", "function_list", "module_list", "pragma_list", "collation_list", "database_list", "wal_checkpoint", "auto_vacuum", "incremental_vacuum", "encoding", "busy_timeout", "temp_store", "mmap_size", "writable_schema", "trusted_schema", "secure_delete", "cell_size_check", "automatic_index", "query_only", "analysis_limit", "hard_heap_limit", "soft_heap_limit", "threads"];
    const allowed = ["table_list", "foreign_keys", "defer_foreign_keys", "foreign_key_check", "page_size", "data_version", "quick_check", "optimize", "case_sensitive_like", "recursive_triggers", "legacy_alter_table", "ignore_check_constraints", "reverse_unordered_selects"];
    out.pragmas = {};
    for (const p of [...blocked, ...allowed]) {
      try { const r = sql.exec(`PRAGMA ${p}`).toArray(); out.pragmas[p] = "ok " + JSON.stringify(r).slice(0, 80); } catch (e) { out.pragmas[p] = "ERR " + String(e.message ?? e).slice(0, 80); }
    }
    out.funcs = {};
    for (const f of ["sqlite_version()", "log10(100)", "log(100)", "sqlite_compileoption_used('ENABLE_FTS5')", "unixepoch()", "json('{\"a\":1}')", "jsonb('{}') IS NOT NULL", "randomblob(4) IS NOT NULL", "concat_ws(',',1,2)", "unhex('41')", "sqlite_source_id()", "load_extension('x')"]) {
      try { out.funcs[f] = "ok " + JSON.stringify(sql.exec(`SELECT ${f} AS v`).one().v); } catch (e) { out.funcs[f] = "ERR " + String(e.message ?? e).slice(0, 80); }
    }
    out.stmts = {};
    for (const s of ["ATTACH 'x.db' AS x", "VACUUM", "ANALYZE", "REINDEX", "CREATE TEMP TABLE tt(a)", "BEGIN", "SAVEPOINT a", "CREATE VIRTUAL TABLE f4 USING fts4(x)", "CREATE VIRTUAL TABLE rt USING rtree(id,a,b)", "SELECT * FROM dbstat", "SELECT * FROM generate_series(1,3)", "SELECT * FROM _cf_KV"]) {
      try { sql.exec(s).toArray(); out.stmts[s] = "ok"; } catch (e) { out.stmts[s] = "ERR " + String(e.message ?? e).slice(0, 120); }
    }
    try { sql.exec("DROP TABLE IF EXISTS rt"); } catch {}
    // FTS5
    try {
      sql.exec(`DROP TABLE IF EXISTS f; DROP TABLE IF EXISTS g;
        CREATE VIRTUAL TABLE f USING fts5(body, tokenize='unicode61 remove_diacritics 2');
        CREATE VIRTUAL TABLE g USING fts5(body, tokenize='trigram');`);
      for (const b of ["Uma ação judicial", "Coração valente", "Overdue INVOICE #42", "the quick brown fox jumps over the fox"]) { sql.exec("INSERT INTO f(body) VALUES(?)", b); sql.exec("INSERT INTO g(body) VALUES(?)", b); }
      out.fts5 = {
        unicode61_acao: sql.exec("SELECT body FROM f WHERE f MATCH 'acao'").toArray().map((r) => r.body),
        unicode61_prefix_cora: sql.exec("SELECT body FROM f WHERE f MATCH 'cora*'").toArray().map((r) => r.body),
        trigram_nvoic: sql.exec("SELECT body FROM g WHERE g MATCH 'nvoic'").toArray().map((r) => r.body),
        bm25_snippet_highlight: sql.exec("SELECT bm25(f) s, snippet(f,0,'[',']','…',4) sn, highlight(f,0,'<b>','</b>') h FROM f WHERE f MATCH 'fox' ORDER BY rank").toArray(),
      };
      sql.exec("DROP TABLE f; DROP TABLE g;");
    } catch (e) { out.fts5 = { error: String(e.message ?? e) }; }
    return out;
  }
}

export default {
  async fetch(req, env) {
    const u = new URL(req.url);
    const parts = u.pathname.split("/").filter(Boolean); // /d/<name>/<op>
    if (parts[0] === "ping") return J({ workerColo: req.cf?.colo, country: req.cf?.country, city: req.cf?.city });
    if (parts[0] !== "d" || parts.length < 3) return J({ error: "use /d/<name>/<op>" }, 404);
    const hint = u.searchParams.get("hint");
    const ns = env.SHARD;
    const stub = ns.get(ns.idFromName(parts[1]), hint ? { locationHint: hint } : undefined);
    if (parts[2] === "wrtt") { // Worker->DO round trip, measured inside the Worker
      const n = Number(u.searchParams.get("n") ?? "10");
      const op = u.searchParams.get("op") ?? "q";
      const ts = [];
      for (let i = 0; i < n; i++) {
        const t0 = Date.now();
        await (await stub.fetch(`https://do/${op}`)).text();
        ts.push(Date.now() - t0);
      }
      const info = await (await stub.fetch("https://do/info")).json();
      return J({ workerColo: req.cf?.colo, doTrace: info.doColo, ts });
    }
    const h = new Headers(req.headers);
    h.set("x-worker-colo", req.cf?.colo ?? "?");
    const res = await stub.fetch(new Request(req.url, { method: req.method, headers: h, body: req.body }));
    if (res.webSocket) return res;
    const out = new Response(res.body, res);
    out.headers.set("x-worker-colo", req.cf?.colo ?? "?");
    return out;
  },
};
