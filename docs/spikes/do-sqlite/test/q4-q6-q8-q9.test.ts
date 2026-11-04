import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { attempt, report, stubFor } from "./helpers";

describe("Q4 transactions + PRAGMAs", () => {
  it("transactionSync: commit, rollback on throw, nesting, BEGIN/SAVEPOINT in exec", async () => {
    await runInDurableObject(stubFor("q4-tx"), (_i, state) => {
      const st = state.storage;
      const sql = st.sql;
      sql.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
      const count = () => sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM t").one().n;

      const ret = st.transactionSync(() => {
        sql.exec("INSERT INTO t(v) VALUES ('committed')");
        return "return-value";
      });
      const afterCommit = count();

      const rollback = attempt(() =>
        st.transactionSync(() => {
          sql.exec("INSERT INTO t(v) VALUES ('should-rollback')");
          throw new Error("boom");
        }),
      );
      const afterRollback = count();

      // nested: inner throws and is caught by outer -> inner work rolled back, outer commits?
      const nested = attempt(() =>
        st.transactionSync(() => {
          sql.exec("INSERT INTO t(v) VALUES ('outer')");
          const inner = attempt(() =>
            st.transactionSync(() => {
              sql.exec("INSERT INTO t(v) VALUES ('inner-rolled-back')");
              throw new Error("inner boom");
            }),
          );
          st.transactionSync(() => sql.exec("INSERT INTO t(v) VALUES ('inner-ok')"));
          return inner;
        }),
      );
      const rowsAfterNested = sql.exec("SELECT v FROM t ORDER BY id").toArray().map((r: any) => r.v);

      // async callback inside transactionSync
      const asyncInSync = attempt(() => st.transactionSync((async () => { sql.exec("INSERT INTO t(v) VALUES ('async')"); }) as any));

      const explicitTx = {
        BEGIN: attempt(() => sql.exec("BEGIN")),
        BEGIN_IMMEDIATE: attempt(() => sql.exec("BEGIN IMMEDIATE")),
        COMMIT: attempt(() => sql.exec("COMMIT")),
        ROLLBACK: attempt(() => sql.exec("ROLLBACK")),
        SAVEPOINT: attempt(() => sql.exec("SAVEPOINT sp1")),
        RELEASE: attempt(() => sql.exec("RELEASE sp1")),
        ATTACH: attempt(() => sql.exec("ATTACH DATABASE ':memory:' AS other")),
        VACUUM: attempt(() => sql.exec("VACUUM")),
        ANALYZE: attempt(() => sql.exec("ANALYZE")),
        REINDEX: attempt(() => sql.exec("REINDEX")),
        create_cf_table: attempt(() => sql.exec("CREATE TABLE _cf_mine (x)")),
        create_sqlite_table: attempt(() => sql.exec("CREATE TABLE sqlite_mine (x)")),
        load_extension: attempt(() => sql.exec("SELECT load_extension('x')")),
        temp_table: attempt(() => sql.exec("CREATE TEMP TABLE tmp (x)")),
      };
      report("q4.transactions", {
        transactionSync_return: ret, afterCommit, rollback, afterRollback, nested, rowsAfterNested, asyncInSync, explicitTx,
      });
      expect(afterRollback).toBe(afterCommit);
    });
  });

  it("async transaction() rollback + KV API coexistence", async () => {
    await runInDurableObject(stubFor("q4-async-tx"), async (_i, state) => {
      const st = state.storage;
      st.sql.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
      const r = await st
        .transaction(async (txn) => {
          st.sql.exec("INSERT INTO t(v) VALUES ('x')");
          await txn.put("k", "v");
          throw new Error("async boom");
        })
        .then(() => "no error", (e) => String(e.message));
      const n = st.sql.exec("SELECT COUNT(*) AS n FROM t").one().n;
      const k = await st.get("k");
      const rb = await st
        .transaction(async (txn) => {
          st.sql.exec("INSERT INTO t(v) VALUES ('y')");
          txn.rollback();
        })
        .then(() => "resolved", (e) => String(e.message));
      const n2 = st.sql.exec("SELECT COUNT(*) AS n FROM t").one().n;
      await st.put("visible", 1);
      const kvSync = attempt(() => (st as any).kv?.get?.("visible"));
      const tables = st.sql.exec("SELECT name, type FROM sqlite_master ORDER BY name").toArray();
      const cfRead = attempt(() => st.sql.exec("SELECT * FROM _cf_KV").toArray());
      report("q4.async_tx", { throwResult: r, rowsAfterThrow: n, kvAfterThrow: k ?? null, rollbackResult: rb, rowsAfterRollback: n2, syncKvApi: kvSync, sqlite_master: tables, read_cf_KV: cfRead });
    });
  });

  it("PRAGMA allow-list", async () => {
    await runInDurableObject(stubFor("q4-pragma"), (_i, state) => {
      const sql = state.storage.sql;
      sql.exec("CREATE TABLE p (id INTEGER PRIMARY KEY, a TEXT, g TEXT GENERATED ALWAYS AS (upper(a)) VIRTUAL)");
      sql.exec("CREATE INDEX p_a ON p(a)");
      const pragmas = [
        "table_info(p)", "table_xinfo(p)", "table_list", "index_list(p)", "index_info(p_a)", "index_xinfo(p_a)",
        "foreign_key_list(p)", "foreign_keys", "foreign_keys = OFF", "foreign_keys = ON", "defer_foreign_keys = ON", "foreign_key_check",
        "page_size", "page_count", "freelist_count", "max_page_count", "journal_mode", "synchronous", "cache_size",
        "user_version", "user_version = 5", "schema_version", "data_version", "application_id",
        "integrity_check", "quick_check", "optimize", "case_sensitive_like = ON", "recursive_triggers = ON",
        "legacy_alter_table = ON", "ignore_check_constraints = ON", "reverse_unordered_selects = ON",
        "compile_options", "function_list", "module_list", "pragma_list", "collation_list", "database_list",
        "wal_checkpoint", "auto_vacuum", "incremental_vacuum", "encoding", "busy_timeout", "temp_store", "mmap_size",
        "writable_schema = ON", "trusted_schema", "secure_delete", "cell_size_check", "automatic_index", "query_only",
        "analysis_limit", "hard_heap_limit", "soft_heap_limit", "threads",
      ];
      const out: Record<string, string> = {};
      for (const p of pragmas) {
        const r = attempt(() => sql.exec(`PRAGMA ${p}`).toArray());
        out[p] = r.ok ? `ok ${JSON.stringify(r.value).slice(0, 160)}` : `ERR ${r.error}`;
      }
      out["SELECT * FROM pragma_table_info('p')"] = JSON.stringify(attempt(() => sql.exec("SELECT name FROM pragma_table_info('p')").toArray()));
      out["SELECT * FROM pragma_table_xinfo('p')"] = JSON.stringify(attempt(() => sql.exec("SELECT name, hidden FROM pragma_table_xinfo('p')").toArray()));
      out["SELECT * FROM pragma_index_list('p')"] = JSON.stringify(attempt(() => sql.exec("SELECT * FROM pragma_index_list('p')").toArray()));
      out["SELECT * FROM pragma_foreign_key_list('p')"] = JSON.stringify(attempt(() => sql.exec("SELECT * FROM pragma_foreign_key_list('p')").toArray()));
      report("q4.pragmas", out);
    });
  });
});

describe("Q6 point-in-time recovery APIs", () => {
  it("bookmark APIs exist locally?", async () => {
    await runInDurableObject(stubFor("q6-pitr"), async (_i, state) => {
      const st: any = state.storage;
      const out: Record<string, unknown> = {
        typeof_getCurrentBookmark: typeof st.getCurrentBookmark,
        typeof_getBookmarkForTime: typeof st.getBookmarkForTime,
        typeof_onNextSessionRestoreBookmark: typeof st.onNextSessionRestoreBookmark,
        storageProtoMethods: Object.getOwnPropertyNames(Object.getPrototypeOf(st)),
      };
      const tryAsync = async (f: () => Promise<unknown>) => {
        try { return { ok: true, value: await f() }; } catch (e: any) { return { ok: false, error: String(e?.message ?? e) }; }
      };
      out.getCurrentBookmark = await tryAsync(() => st.getCurrentBookmark());
      out.getBookmarkForTime = await tryAsync(() => st.getBookmarkForTime(Date.now() - 60_000));
      // NOTE: onNextSessionRestoreBookmark only schedules a restore on next restart; call with current bookmark (no-op-ish)
      if ((out.getCurrentBookmark as any).ok)
        out.onNextSessionRestoreBookmark = await tryAsync(() => st.onNextSessionRestoreBookmark((out.getCurrentBookmark as any).value));
      report("q6.pitr", out);
    });
  });
});

describe("Q8 limits", () => {
  it("bound params, statement length, value/row size, columns", async () => {
    await runInDurableObject(stubFor("q8-limits"), (_i, state) => {
      const sql = state.storage.sql;
      const out: Record<string, unknown> = {};
      for (const n of [99, 100, 101, 999, 1000, 32766, 32767]) {
        const ph = Array.from({ length: n }, () => "?").join(",");
        const r = attempt(() => sql.exec(`SELECT ${ph}`, ...Array.from({ length: n }, (_, i) => i)).raw().toArray()[0].length);
        out[`params_${n}`] = r.ok ? `ok (${r.value} cols)` : `ERR ${r.error}`;
      }
      // literal-list without bound params (common workaround for IN (...))
      const inList = Array.from({ length: 5000 }, (_, i) => i).join(",");
      out.literal_in_list_5000 = (() => { const r = attempt(() => sql.exec(`SELECT 1 WHERE 3 IN (${inList})`).toArray()); return r.ok ? "ok" : `ERR ${r.error}`; })();
      out.json_each_param_workaround = (() => {
        const r = attempt(() => sql.exec("SELECT COUNT(*) AS n FROM json_each(?)", JSON.stringify(Array.from({ length: 10000 }, (_, i) => i))).one().n);
        return r.ok ? `ok n=${r.value}` : `ERR ${r.error}`;
      })();
      for (const kb of [99, 100, 101, 1024]) {
        const pad = " ".repeat(kb * 1024 - 20);
        const r = attempt(() => sql.exec(`SELECT 1 AS v${pad}`).one());
        out[`statement_${kb}KB`] = r.ok ? "ok" : `ERR ${r.error}`;
      }
      sql.exec("CREATE TABLE big (id INTEGER PRIMARY KEY, b BLOB, t TEXT)");
      for (const [label, bytes] of [["1MB", 1_000_000], ["2MB-exact", 2 * 1024 * 1024], ["2MB-1KB", 2 * 1024 * 1024 - 1024], ["2MB+1", 2 * 1024 * 1024 + 1], ["4MB", 4 * 1024 * 1024]] as const) {
        const blob = new Uint8Array(bytes as number);
        const r = attempt(() => sql.exec("INSERT INTO big(b) VALUES (?)", blob));
        out[`blob_${label}`] = r.ok ? "ok" : `ERR ${r.error}`;
        const rt = attempt(() => sql.exec("INSERT INTO big(t) VALUES (?)", "x".repeat(bytes as number)));
        out[`text_${label}`] = rt.ok ? "ok" : `ERR ${rt.error}`;
      }
      out.zeroblob_3MB = (() => { const r = attempt(() => sql.exec("INSERT INTO big(b) VALUES (zeroblob(3000000))")); return r.ok ? "ok" : `ERR ${r.error}`; })();
      out.row_two_1_5MB_cols = (() => { const r = attempt(() => sql.exec("INSERT INTO big(b, t) VALUES (?, ?)", new Uint8Array(1_500_000), "y".repeat(1_500_000))); return r.ok ? "ok" : `ERR ${r.error}`; })();
      out.read_back_largest_ok = attempt(() => sql.exec("SELECT max(length(b)) AS b, max(length(t)) AS t FROM big").one());
      for (const n of [100, 101, 2000]) {
        const cols = Array.from({ length: n }, (_, i) => `c${i} INTEGER`).join(",");
        const r = attempt(() => sql.exec(`CREATE TABLE wide${n} (${cols})`));
        out[`columns_${n}`] = r.ok ? "ok" : `ERR ${r.error}`;
      }
      const like = attempt(() => sql.exec("SELECT 'a' LIKE ? AS v", "%".repeat(60000)).one());
      out.like_pattern_60k = like.ok ? "ok" : `ERR ${like.error}`;
      report("q8.limits", out);
    });
  });
});

describe("Q8b limits (exact boundaries)", () => {
  it("statement length boundary + large value ceiling", async () => {
    await runInDurableObject(stubFor("q8b-limits"), (_i, state) => {
      const sql = state.storage.sql;
      const out: Record<string, unknown> = {};
      for (const total of [10_000, 50_000, 99_999, 100_000, 100_001]) {
        const base = "SELECT 1 AS v";
        const stmt = base + " ".repeat(total - base.length);
        const r = attempt(() => sql.exec(stmt).one());
        out[`statement_bytes_${total}`] = r.ok ? "ok" : `ERR ${r.error}`;
      }
      sql.exec("CREATE TABLE big (id INTEGER PRIMARY KEY, b BLOB)");
      for (const mb of [8, 16, 32, 64, 128]) {
        const r = attempt(() => sql.exec("INSERT INTO big(b) VALUES (?)", new Uint8Array(mb * 1024 * 1024)));
        out[`blob_${mb}MiB`] = r.ok ? "ok" : `ERR ${r.error}`;
        if (!r.ok) break;
      }
      for (const mb of [1, 2, 3]) {
        const r = attempt(() => sql.exec("SELECT length(zeroblob(?)) AS n", mb * 1024 * 1024 * 1024).one());
        out[`zeroblob_${mb}GiB_select`] = r.ok ? "ok" : `ERR ${r.error}`;
      }
      report("q8b.limits", out);
    });
  });
});

describe("Q9 introspection", () => {
  it("sqlite_master / pragma_table_info / index_list joined", async () => {
    await runInDurableObject(stubFor("q9-introspect"), (_i, state) => {
      const sql = state.storage.sql;
      sql.exec(`CREATE TABLE tasks (_id TEXT PRIMARY KEY, doc TEXT, status TEXT GENERATED ALWAYS AS (doc->>'$.status') VIRTUAL) STRICT;
                CREATE INDEX tasks_by_status ON tasks(status, _id) WHERE status IS NOT NULL;
                CREATE VIRTUAL TABLE tasks_fts USING fts5(body);`);
      const out = {
        sqlite_master: attempt(() => sql.exec("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY name").toArray()),
        sqlite_schema: attempt(() => sql.exec("SELECT COUNT(*) AS n FROM sqlite_schema").one()),
        pragma_table_list: attempt(() => sql.exec("SELECT * FROM pragma_table_list").toArray()),
        columns_join: attempt(() =>
          sql.exec(`SELECT m.name AS tbl, c.name AS col, c.type, c."notnull", c.pk, c.hidden
                      FROM sqlite_master m, pragma_table_xinfo(m.name) c
                     WHERE m.type = 'table' AND m.name = 'tasks'`).toArray(),
        ),
        indexes_join: attempt(() =>
          sql.exec(`SELECT il.name AS idx, il."unique", il.partial, ii.seqno, ii.name AS col
                      FROM pragma_index_list('tasks') il, pragma_index_info(il.name) ii ORDER BY il.name, ii.seqno`).toArray(),
        ),
        sqlite_sequence_and_stat: attempt(() => sql.exec("SELECT name FROM sqlite_master WHERE name LIKE 'sqlite_%'").toArray()),
      };
      report("q9.introspection", out);
      expect(out.sqlite_master.ok).toBe(true);
      expect(out.columns_join.ok).toBe(true);
    });
  });
});
