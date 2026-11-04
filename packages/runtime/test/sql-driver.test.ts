import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { DoSqlDriver } from "../src/sql-driver.ts";
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
});
