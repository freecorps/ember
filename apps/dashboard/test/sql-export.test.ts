// The SQL Explorer's client-side exports (src/app/export.ts) and its completer (pages/sql.tsx `completionsAt`).
import { describe, expect, it } from "vitest";
import { toCsv, toJson, uniqueColumns } from "../src/app/export.ts";
import { completionsAt } from "../src/app/pages/sql.tsx";
import { indexState } from "../src/app/pages/schema.tsx";
import type { ShardStatus } from "../src/app/pages/types.ts";

describe("exports", () => {
  it("CSV: RFC 4180 quoting, NULL as empty, objects as JSON, formulas defused (text only)", () => {
    expect(toCsv(["a", "b,c"], [["x\"y", null], [-5, "-5"], [{ $bytes: "AA==" }, "=SUM(A1)"], ["multi\nline", "@x"]])).toBe(
      'a,"b,c"\r\n"x""y",\r\n-5,\'-5\r\n"{""$bytes"":""AA==""}",\'=SUM(A1)\r\n"multi\nline",\'@x\r\n',
    );
  });

  it("JSON: one object per row; repeated column names made unique", () => {
    expect(uniqueColumns(["a", "a", "a_2", "b"])).toEqual(["a", "a_2_", "a_2", "b"]);
    // A generated name never collides with another generated one either.
    const many = uniqueColumns(["a", "a", "a_2", "a_2_", "a_2", "a"]);
    expect(new Set(many).size).toBe(many.length);
    expect(Object.keys(JSON.parse(toJson(["a", "a", "a_2", "a_2_"], [[1, 2, 3, 4]]))[0])).toHaveLength(4);
    expect(JSON.parse(toJson(["n", "n"], [[1, 2]]))).toEqual([{ n: 1, n_2: 2 }]);
  });
});

describe("completionsAt", () => {
  const tables = [{ name: "messages", columns: ["_id", "channel", "body"] }, { name: "my table", columns: ["x"] }];
  it("tables, columns and keywords by prefix; a table's columns after `table.`; names quoted when needed", () => {
    const at = (t: string) => completionsAt(t, t.length, tables, ["rl$buckets"]);
    expect(at("SELECT * FROM me").items.map((c) => [c.label, c.kind])).toEqual([["messages", "table"]]);
    expect(at("SELECT * FROM my").items[0]).toMatchObject({ label: "my table", insert: '"my table"' });
    expect(at("SELECT messages.ch").items.map((c) => c.label)).toEqual(["channel"]);
    expect(at("SELECT messages.").items.map((c) => c.label)).toEqual(["_id", "channel", "body"]);
    expect(at("sel").items.map((c) => c.label)).toEqual(["SELECT"]);
    expect(at("SELECT * FROM rl").items.map((c) => c.label)).toEqual(["rl$buckets"]);
    expect(at("SELECT ").items).toEqual([]);
    expect(at("SELECT nope.x").items).toEqual([]);
    expect(at("SELECT * FROM messages").items.map((c) => c.label)).not.toContain("messages");
  });

  it("a quoted owner before the dot, escaped quotes included; names spelled like keywords are inserted quoted", () => {
    const more = [...tables, { name: 'we"ird', columns: ["update", "order_id"] }];
    const at = (t: string) => completionsAt(t, t.length, more);
    expect(at('SELECT "my table".').items.map((c) => c.label)).toEqual(["x"]);
    expect(at('SELECT "messages".ch').items.map((c) => c.label)).toEqual(["channel"]);
    expect(at('SELECT "we""ird".').items.map((c) => [c.label, c.insert])).toEqual([
      ["update", '"update"'],
      ["order_id", "order_id"],
    ]);
    expect(at("SELECT upd").items[0]).toMatchObject({ label: "update", insert: '"update"' });
  });
});

describe("Schema Explorer: index state", () => {
  const status = (o: Partial<ShardStatus> = {}): ShardStatus => ({ shard: "global:main", expectedVersion: "v2", schemaVersion: "v2", ready: true, staged: [], migrationError: null, version: 1, databaseSize: 0, ...o });
  it("ready only on a shard on the deployed schema with no failed migration; staged = backfilling", () => {
    expect(indexState(null, "messages", "by_author")).toBe(null);
    expect(indexState(status(), "messages", "by_author")).toBe("ready");
    expect(indexState(status({ staged: [{ table: "messages", index: "by_author", kind: "db", cursor: 0, until: 9 }] }), "messages", "by_author")).toBe("backfilling");
    // A refused migration: the new index was never staged, and is not ready either.
    const refused = status({ ready: false, schemaVersion: "v1", migrationError: { at: 1, fromVersion: "v1", toVersion: "v2", code: "MigrationRefused", message: "x" } });
    expect(indexState(refused, "messages", "by_author")).toBe("not migrated");
    expect(indexState(refused, "messages", null)).toBe("not migrated");
    expect(indexState(status({ schemaVersion: "v1" }), "messages", "by_author")).toBe("not migrated");
  });
});
