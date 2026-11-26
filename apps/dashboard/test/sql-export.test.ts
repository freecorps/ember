// The SQL Explorer's client-side exports (src/app/export.ts) and its completer (pages/sql.tsx `completionsAt`).
import { describe, expect, it } from "vitest";
import { toCsv, toJson, uniqueColumns } from "../src/app/export.ts";
import { completionsAt } from "../src/app/pages/sql.tsx";

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
});
