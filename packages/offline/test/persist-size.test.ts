// Measures what persisting row diffs saves (contracts.md "Offline": values by reference + row-diff log) against
// rewriting the whole value on every change (`persistDiffs: false`, the previous format). SQLite (node:sqlite,
// files on disk), a 500-message subscription, 100 server changes of one row each (edit / insert / delete).
// Bytes = the size of every value bound to INSERT/UPDATE statements (what SQLite has to write, before pages/WAL).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stableStringify } from "@freecorps/ember-client";
import type { Doc, SqlDriver, SqlValue } from "@freecorps/ember-server";
import { createNodeSqliteDriver } from "@freecorps/ember-server/testing";
import { engineServer, offlineQueries, schema } from "./app.ts";
import { sqliteStorage } from "../src/sqlite.ts";

const SHARD = "org:acme";
const size = (v: SqlValue) => (typeof v === "string" ? v.length : v instanceof Uint8Array ? v.byteLength : 8);

function counting(open: (n: string) => SqlDriver & { close?(): void }) {
  const stats = { bytes: 0, statements: 0 };
  const wrap = (name: string) => {
    const d = open(name);
    return {
      exec(sql: string, ...params: SqlValue[]) {
        if (/^\s*(INSERT|UPDATE)/i.test(sql)) {
          stats.statements++;
          for (const p of params) stats.bytes += size(p);
        }
        return d.exec(sql, ...params);
      },
      transaction: <T>(fn: () => T) => d.transaction(fn),
      close: () => d.close?.(),
    };
  };
  return { stats, wrap };
}

/** 100 changes of one row each over a 500-row result (seeded, identical for both runs). */
function changes(pool: Doc[]) {
  let cur = pool.slice(0, 500);
  let next = 500;
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const out: Doc[][] = [];
  for (let i = 0; i < 100; i++) {
    const r = rnd();
    const at = Math.floor(rnd() * cur.length);
    if (r < 0.7) cur = cur.map((d, j) => (j === at ? { ...d, body: `edited ${i} ${(d as any).body}`.slice(0, 200) } : d));
    else if (r < 0.9) cur = [...cur, pool[next++]!];
    else cur = cur.filter((_, j) => j !== at);
    out.push(cur);
  }
  return out;
}

describe("persisting row diffs (measurement)", () => {
  it("writes far fewer bytes than whole values for one-row changes", async () => {
    const srv = engineServer();
    for (let i = 0; i < 600; i++) srv.m("messages:send", { channel: "a", body: `message ${i}: ${"lorem ipsum dolor sit amet ".repeat(7)}`.slice(0, 200) });
    const pool = srv.q("messages:list", { channel: "a" }) as Doc[];
    const steps = changes(pool);
    const args = { channel: "a" };
    const run = async (persistDiffs: boolean, fn: string, queries: unknown, box: (rows: Doc[]) => unknown = (rows) => rows) => {
      const dir = mkdtempSync(join(tmpdir(), "ember-diffs-"));
      const { stats, wrap } = counting((n) => createNodeSqliteDriver(join(dir, `${n}.db`)));
      const s = sqliteStorage({ schema, queries, persistDiffs, name: "m", open: wrap });
      await s.load();
      await s.applyPatch({ shard: SHARD, fn, args, argsJson: stableStringify(args), value: box(pool.slice(0, 500)), version: 1 });
      stats.bytes = 0;
      stats.statements = 0;
      const t0 = performance.now();
      let v = 2;
      for (const value of steps) await s.applyPatch({ shard: SHARD, fn, args, argsJson: stableStringify(args), value: box(value), version: v++ });
      const ms = performance.now() - t0;
      await s.close();
      const reopened = sqliteStorage({ schema, queries, persistDiffs, name: "m", open: (n) => createNodeSqliteDriver(join(dir, `${n}.db`)) });
      await reopened.load();
      const back = await reopened.runQueryLocally({ shard: SHARD, fn, args, argsJson: stableStringify(args), identity: null });
      expect(back!.value).toEqual(box(steps.at(-1)!));
      await reopened.close();
      rmSync(dir, { recursive: true, force: true });
      return { bytes: stats.bytes, statements: stats.statements, ms };
    };
    // replicated (registered offline): rows + record; cache-only (not offline): the record alone
    const rows = { whole: await run(false, "messages:list", offlineQueries), diffs: await run(true, "messages:list", offlineQueries) };
    const cache = { whole: await run(false, "messages:list", {}), diffs: await run(true, "messages:list", {}) };
    // A paginated value (`{page}`): value diffs (feature "vdiff"); before them it was rewritten whole, as `whole`.
    const box = (rows: Doc[]) => ({ page: rows, isDone: false, continueCursor: "cursor" });
    const paged = { whole: await run(false, "messages:page", {}, box), diffs: await run(true, "messages:page", {}, box) };
    const line = (name: string, r: { whole: { bytes: number; ms: number }; diffs: { bytes: number; ms: number } }) =>
      `${name}: whole ${(r.whole.bytes / 1024).toFixed(0)} KiB in ${r.whole.ms.toFixed(0)} ms → diffs ${(r.diffs.bytes / 1024).toFixed(1)} KiB in ${r.diffs.ms.toFixed(0)} ms (${(r.whole.bytes / r.diffs.bytes).toFixed(0)}x fewer bytes)`;
    console.log(`[offline] 100 one-row changes of a 500-row result on SQLite\n  ${line("replicated", rows)}\n  ${line("cache-only", cache)}\n  ${line("cache-only {page}", paged)}`);
    expect(rows.diffs.bytes * 10).toBeLessThan(rows.whole.bytes);
    expect(cache.diffs.bytes * 10).toBeLessThan(cache.whole.bytes);
    expect(paged.diffs.bytes * 10).toBeLessThan(paged.whole.bytes);
  });
});
