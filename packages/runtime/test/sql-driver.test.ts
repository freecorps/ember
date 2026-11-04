import { runInDurableObject } from "cloudflare:test";
import { createEngine } from "@freecorps/ember-server";
import { describe, expect, it } from "vitest";
import { DoSqlDriver } from "../src/sql-driver.ts";
import { functionsV1, schemaV1 } from "./app.ts";
import { shardStub } from "./helpers.ts";

describe("DoSqlDriver", () => {
  it("nests transactions as savepoints, rejects async callbacks, normalizes blobs", async () => {
    const out = await runInDurableObject(shardStub("drv:1"), (_i, state) => {
      const d = new DoSqlDriver(state.storage);
      d.exec("CREATE TABLE t (v TEXT, b BLOB)");
      d.transaction(() => {
        d.exec("INSERT INTO t(v) VALUES ('outer')");
        try {
          d.transaction(() => {
            d.exec("INSERT INTO t(v) VALUES ('inner-bad')");
            throw new Error("boom");
          });
        } catch {}
        d.transaction(() => d.exec("INSERT INTO t(v) VALUES ('inner-ok')"));
      });
      let asyncErr = "";
      try {
        d.transaction((async () => d.exec("INSERT INTO t(v) VALUES ('async')")) as () => unknown);
      } catch (e) {
        asyncErr = (e as Error).message;
      }
      let bigintErr = "";
      try {
        d.exec("SELECT ?", 1n as never);
      } catch (e) {
        bigintErr = (e as Error).message;
      }
      const w = d.exec("INSERT INTO t(v, b) VALUES ('blob', ?)", new Uint8Array([0, 1, 255]));
      const blob = d.exec("SELECT b FROM t WHERE v = 'blob'").rows[0]!.b;
      return { rows: d.exec("SELECT v FROM t ORDER BY rowid").rows.map((r) => r.v), asyncErr, bigintErr, written: w.rowsWritten, blob, depth: d.depth };
    });
    expect(out.rows).toEqual(["outer", "inner-ok", "blob"]);
    expect(out.asyncErr).toMatch(/Promise/);
    expect(out.bigintErr).toMatch(/bigint/);
    expect(out.written).toBe(1);
    expect(out.blob).toEqual(new Uint8Array([0, 1, 255]));
    expect(out.depth).toBe(0);
  });

  it("supports what the engine emits: ?NNN placeholders, RETURNING, subarray blobs, multi-statement DDL", async () => {
    const out = await runInDurableObject(shardStub("drv:2"), (_i, state) => {
      const d = new DoSqlDriver(state.storage);
      // Multi-statement DDL (no params) in one exec.
      d.exec("CREATE TABLE a (k BLOB, n INTEGER) STRICT; CREATE INDEX a_k ON a (k);");
      const ret = d.exec("INSERT INTO a (k, n) VALUES (?, ?) RETURNING rowid AS id", new Uint8Array([1, 2]), 5).rows;
      // A view into a larger buffer must bind only its own bytes.
      const big = new Uint8Array([9, 9, 3, 4, 9]);
      d.exec("INSERT INTO a (k, n) VALUES (?1, ?2)", big.subarray(2, 4), 7);
      const numbered = d.exec("SELECT n FROM a WHERE n > ?1 AND n <= ?2 AND ?1 >= 0 ORDER BY n", 4, 7).rows.map((r) => r.n);
      const range = d.exec("SELECT n FROM a WHERE k >= ? AND k < ? ORDER BY k", new Uint8Array([3]), new Uint8Array([3, 5])).rows.map((r) => r.n);
      const keys = d.exec("SELECT k FROM a ORDER BY n").rows.map((r) => r.k);
      return { ret, numbered, range, keys, isU8: keys.every((k) => k instanceof Uint8Array) };
    });
    expect(out.ret).toEqual([{ id: 1 }]);
    expect(out.numbered).toEqual([5, 7]);
    expect(out.range).toEqual([7]);
    expect(out.keys).toEqual([new Uint8Array([1, 2]), new Uint8Array([3, 4])]);
    expect(out.isU8).toBe(true);
  });

  it("runs the real engine's DDL, FTS5 and introspection on DO SQLite", async () => {
    const out = await runInDurableObject(shardStub("drv:3"), (_i, state) => {
      const driver = new DoSqlDriver(state.storage);
      const engine = createEngine({ schema: schemaV1, functions: functionsV1, driver });
      // The Shard DO already migrated at boot (real engine by default): this is a no-op.
      const first = engine.migrate();
      const again = engine.migrate();
      const tables = driver.exec("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").rows.map((r) => r.name);
      engine.runMutation("messages:send", { channel: "c", body: "hello brave new world", n: 3n });
      return {
        first: first.changed,
        tables,
        again: again.changed,
        plan: engine.planMigration().steps,
        list: engine.runQuery("messages:list", { channel: "c" }).value as Array<{ n: bigint }>,
        search: engine.runQuery("messages:search", { q: "bra" }).value,
      };
    });
    expect(out.first).toBe(false);
    expect(out.tables).toEqual(expect.arrayContaining(["messages", "runs", "messages__search_body", "_ember_meta", "_jobs"]));
    expect(out.again).toBe(false);
    expect(out.plan.filter((s) => s.op !== "noop")).toEqual([]);
    expect(out.list[0]!.n).toBe(3n);
    expect(out.search).toEqual(["hello brave new world"]);
  });
});
