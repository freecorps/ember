import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { attempt, report, stubFor } from "./helpers";

describe("Q1 FTS5", () => {
  it("sqlite version + compile options", async () => {
    await runInDurableObject(stubFor("q1-version"), (_i, state) => {
      const sql = state.storage.sql;
      const v = attempt(() => sql.exec("SELECT sqlite_version() AS v").one().v);
      const opts = attempt(() => sql.exec("PRAGMA compile_options").toArray().map((r: any) => r.compile_options));
      const viaFn = attempt(() => sql.exec("SELECT sqlite_compileoption_used('ENABLE_FTS5') AS fts5, sqlite_compileoption_used('ENABLE_MATH_FUNCTIONS') AS math").one());
      report("q1.version", { sqlite_version: v, compile_options: opts, compileoption_used: viaFn });
      expect(v).toBeDefined();
    });
  });

  it("unicode61 remove_diacritics 2: 'acao' matches 'ação'", async () => {
    await runInDurableObject(stubFor("q1-unicode"), (_i, state) => {
      const sql = state.storage.sql;
      sql.exec("CREATE VIRTUAL TABLE docs USING fts5(body, tokenize = 'unicode61 remove_diacritics 2')");
      sql.exec("INSERT INTO docs(body) VALUES (?), (?), (?)", "Uma ação judicial", "Coração valente", "nada aqui");
      const r1 = sql.exec("SELECT body FROM docs WHERE docs MATCH ?", "acao").toArray();
      const r2 = sql.exec("SELECT body FROM docs WHERE docs MATCH ?", "AÇÃO").toArray();
      const r3 = sql.exec("SELECT body FROM docs WHERE docs MATCH ?", "cora*").toArray();
      report("q1.unicode61", { acao: r1, ACAO_upper: r2, prefix_cora: r3 });
      expect(r1.length).toBe(1);
      expect(r2.length).toBe(1);
    });
  });

  it("trigram tokenizer: substring 'nvoic' in 'invoice'", async () => {
    await runInDurableObject(stubFor("q1-trigram"), (_i, state) => {
      const sql = state.storage.sql;
      const create = attempt(() => sql.exec("CREATE VIRTUAL TABLE tri USING fts5(body, tokenize = 'trigram')"));
      const createCI = attempt(() =>
        sql.exec("CREATE VIRTUAL TABLE tri2 USING fts5(body, tokenize = 'trigram case_sensitive 0 remove_diacritics 1')"),
      );
      sql.exec("INSERT INTO tri(body) VALUES (?), (?)", "Overdue INVOICE #42", "receipt");
      const m = sql.exec("SELECT body FROM tri WHERE tri MATCH ?", "nvoic").toArray();
      const like = sql.exec("SELECT body FROM tri WHERE body LIKE ?", "%nvoic%").toArray();
      const short = attempt(() => sql.exec("SELECT body FROM tri WHERE tri MATCH ?", "nv").toArray());
      let diacritics: unknown = createCI;
      if (createCI.ok) {
        sql.exec("INSERT INTO tri2(body) VALUES (?)", "Fatura de ação");
        diacritics = sql.exec("SELECT body FROM tri2 WHERE tri2 MATCH ?", "acao").toArray();
      }
      report("q1.trigram", {
        create: create.ok ? "ok" : create,
        match_nvoic: m,
        like_nvoic_uses_trigram: like,
        two_char_query: short,
        trigram_remove_diacritics: diacritics,
      });
      expect(m.length).toBe(1);
    });
  });

  it("external-content FTS5 + triggers, bm25, snippet, highlight, fts5vocab", async () => {
    await runInDurableObject(stubFor("q1-external"), (_i, state) => {
      const sql = state.storage.sql;
      sql.exec(`
        CREATE TABLE messages (id INTEGER PRIMARY KEY, author TEXT, body TEXT);
        CREATE VIRTUAL TABLE messages_fts USING fts5(
          body, content='messages', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
        );
        CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
          INSERT INTO messages_fts(rowid, body) VALUES (new.id, new.body);
        END;
        CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
          INSERT INTO messages_fts(messages_fts, rowid, body) VALUES ('delete', old.id, old.body);
        END;
        CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
          INSERT INTO messages_fts(messages_fts, rowid, body) VALUES ('delete', old.id, old.body);
          INSERT INTO messages_fts(rowid, body) VALUES (new.id, new.body);
        END;
      `);
      sql.exec(
        "INSERT INTO messages(author, body) VALUES (?, ?), (?, ?), (?, ?)",
        "a", "the quick brown fox jumps over the lazy dog",
        "b", "fox fox fox everywhere a fox",
        "c", "nothing to see here",
      );
      const afterInsert = sql.exec("SELECT rowid, body FROM messages_fts WHERE messages_fts MATCH 'fox'").toArray();
      sql.exec("UPDATE messages SET body = 'no animals now' WHERE author = 'a'");
      const afterUpdate = sql.exec("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'fox'").toArray();
      const afterUpdateNew = sql.exec("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'animals'").toArray();
      sql.exec("DELETE FROM messages WHERE author = 'b'");
      const afterDelete = sql.exec("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'fox'").toArray();

      // ranking + auxiliary functions
      sql.exec("INSERT INTO messages(author, body) VALUES (?, ?), (?, ?)", "d", "fox once in a long sentence about many other things", "e", "fox fox");
      const ranked = sql
        .exec(
          `SELECT m.id, bm25(messages_fts) AS score,
                  snippet(messages_fts, 0, '[', ']', '…', 4) AS snip,
                  highlight(messages_fts, 0, '<b>', '</b>') AS hl
             FROM messages_fts JOIN messages m ON m.id = messages_fts.rowid
            WHERE messages_fts MATCH 'fox' ORDER BY rank`,
        )
        .toArray();
      const integrity = attempt(() => sql.exec("INSERT INTO messages_fts(messages_fts, rank) VALUES ('integrity-check', 1)").toArray());
      const rebuild = attempt(() => sql.exec("INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')").toArray());
      const optimize = attempt(() => sql.exec("INSERT INTO messages_fts(messages_fts) VALUES ('optimize')").toArray());
      const vocab = attempt(() => {
        sql.exec("CREATE VIRTUAL TABLE messages_vocab USING fts5vocab(messages_fts, 'row')");
        return sql.exec("SELECT term, doc, cnt FROM messages_vocab ORDER BY cnt DESC LIMIT 5").toArray();
      });
      report("q1.external", {
        afterInsert, afterUpdate, afterUpdateNew, afterDelete, ranked,
        integrity_check: integrity.ok ? "ok" : integrity, rebuild: rebuild.ok ? "ok" : rebuild,
        optimize: optimize.ok ? "ok" : optimize, fts5vocab: vocab,
      });
      expect(afterInsert.length).toBe(2);
      expect(afterUpdate.length).toBe(1);
      expect(afterDelete.length).toBe(0);
      expect(ranked[0].id).toBeTypeOf("number");
      expect(vocab.ok).toBe(true);
    });
  });

  it("other virtual tables: rtree, json1 table-valued, dbstat, generate_series", async () => {
    await runInDurableObject(stubFor("q1-vt"), (_i, state) => {
      const sql = state.storage.sql;
      const out = {
        rtree: attempt(() => sql.exec("CREATE VIRTUAL TABLE rt USING rtree(id, minx, maxx)").toArray()),
        fts4: attempt(() => sql.exec("CREATE VIRTUAL TABLE f4 USING fts4(body)").toArray()),
        dbstat: attempt(() => sql.exec("SELECT COUNT(*) AS n FROM dbstat").one()),
        generate_series: attempt(() => sql.exec("SELECT COUNT(*) AS n FROM generate_series(1, 10)").one()),
        pragma_module_list: attempt(() => sql.exec("SELECT name FROM pragma_module_list").toArray().map((r: any) => r.name)),
      };
      report("q1.vtables", out);
    });
  });
});
