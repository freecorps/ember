/**
 * Regression guard by counters (no wall clock): what one operation costs the shard in SQL statements and rows, how
 * many query runs a commit triggers (shared and per identity), how many frames and bytes reach each subscriber, in
 * standard scenarios. Locks in the gains of PR #72 (cheaper commits), #77 (shared results, `authorize`) and #78
 * (value diffs, nested `ctx.runQuery` reuse); `rows-written.test.ts` pins the rows written per operation, and the
 * client's workerd test pins pagination (0 subscriptions and 0 snapshots per new item on top). Prints the table.
 */
import { describe, expect, it } from "vitest";
import type { ServerMessage } from "../src/protocol.ts";
import { connect, hello, is, shardStub, type Client } from "./helpers.ts";

type MRes = Extract<ServerMessage, { t: "mres" }> & { value?: any };
const FEATURES = ["rowdiff", "vdiff", "ident", "query", "ack", "batch"];
const inspect = (shard: string) => shardStub(shard).inspect();

let midSeq = 0;
async function mut(c: Client, fn: string, args: Record<string, unknown>): Promise<MRes> {
  const mid = `m${++midSeq}`;
  c.send({ t: "mut", mid, fn, args });
  const r = await c.waitFor<MRes>(is("mres", (m) => m.mid === mid), 5000);
  if (!r.ok) throw new Error(`${fn}: ${JSON.stringify(r)}`);
  return r;
}

/** A socket that counts the frames and characters it receives after `reset()`. */
async function sock(shard: string, token?: string) {
  const c = await connect(shard);
  await hello(c, crypto.randomUUID(), token, FEATURES);
  const stats = { frames: 0, chars: 0, patches: 0 };
  c.ws.addEventListener("message", (e) => {
    const text = String(e.data);
    if (text === "pong") return;
    stats.frames++;
    stats.chars += text.length;
    if (text.includes('"t":"patch"')) stats.patches++;
  });
  return { c, stats, reset: () => Object.assign(stats, { frames: 0, chars: 0, patches: 0 }) };
}

const table: Array<[string, number]> = [];
const row = (name: string, v: number) => {
  table.push([name, Math.round(v * 100) / 100]);
  return v;
};

/** Barrier: every frame the shard sent this socket before now has arrived (frames are ordered per socket). */
async function settle(c: Client) {
  const qid = `b${++midSeq}`;
  c.send({ t: "q", qid, fn: "shared:failing", args: { room: "__none__" } });
  await c.waitFor((m) => m.t === "qres" && m.qid === qid, 5000);
}

describe("performance counters (regression guard)", () => {
  it("SQL per mutation, re-runs per commit, frames and bytes per subscriber", async ({ annotate }) => {
    // ------------------------------------------------------------- SQL per mutation (steady state, client with ack)
    {
      const shard = "perf:sql";
      const w = await sock(shard);
      for (let i = 0; i < 270; i++) {
        const r = await mut(w.c, "runs:add", { label: `warm${i}` });
        w.c.send({ t: "ack", mids: [r.mid] });
      }
      const N = 40;
      const before = (await inspect(shard)).sql;
      for (let i = 0; i < N; i++) {
        const r = await mut(w.c, "runs:add", { label: `r${i}` });
        w.c.send({ t: "ack", mids: [r.mid] });
      }
      const after = (await inspect(shard)).sql;
      const per = (k: "select" | "insert" | "update" | "delete" | "other", i: 0 | 1 | 2) => (after[k][i]! - before[k][i]!) / N;
      const statements = (["select", "insert", "update", "delete", "other"] as const).reduce((a, k) => a + per(k, 0), 0);
      row("mutation (insert, 0 indexes, WS + ack): SQL statements", statements);
      row("mutation: rows read", (["select", "insert", "update", "delete", "other"] as const).reduce((a, k) => a + per(k, 1), 0));
      row("mutation: rows written", (["select", "insert", "update", "delete", "other"] as const).reduce((a, k) => a + per(k, 2), 0));
      row("mutation: transactions", (after.transactions - before.transactions) / N);
      expect(statements).toBeGreaterThan(0);
      // Measured: 2.15 statements (the commit's row + its ring slot; a dedup lookup now and then), 3.6 rows read,
      // 2 rows written, 3 transactions (batch, its savepoint, the commit's ring row).
      expect(statements).toBeLessThanOrEqual(2.5);
      expect((["select", "insert", "update", "delete", "other"] as const).reduce((a, k) => a + per(k, 1), 0)).toBeLessThanOrEqual(4);
      expect(per("insert", 2) + per("update", 2) + per("delete", 2) + per("other", 2) + per("select", 2)).toBeLessThanOrEqual(2);
      expect((after.transactions - before.transactions) / N).toBeLessThanOrEqual(3);
      w.c.close();
    }

    // ------------------------------------------------------------- re-runs per commit, shared and per identity
    const USERS = 10;
    const reruns = async (fn: string, label: string) => {
      const shard = `perf:${fn.replace(":", "-")}`;
      const writer = await sock(shard);
      await mut(writer.c, "shared:put", { room: "r", body: "seed" });
      for (let i = 0; i < USERS; i++) await mut(writer.c, "shared:join", { room: "r", user: `u${i}` });
      const users = await Promise.all(Array.from({ length: USERS }, (_, i) => sock(shard, `good:u${i}`)));
      for (const u of users) {
        u.c.send({ t: "sub", qid: 1, fn, args: { room: "r" } });
        await u.c.waitFor(is("snap"), 5000);
      }
      for (const u of users) u.reset();
      writer.reset();
      const i0 = await inspect(shard);
      const C = 5;
      for (let k = 0; k < C; k++) await mut(writer.c, "shared:put", { room: "r", body: `n${k}` });
      for (const u of users) await settle(u.c);
      const i1 = await inspect(shard);
      const perCommit = (i1.stats.reruns - i0.stats.reruns) / C;
      row(`${label}: query runs per commit (${USERS} users)`, perCommit);
      const frames = users.reduce((a, u) => a + u.stats.frames - 1, 0) / (C * USERS); // minus the barrier's qres
      return { perCommit, gates: (i1.stats.gateRuns - i0.stats.gateRuns) / C, reused: (i1.stats.nestedReused - i0.stats.nestedReused) / C, frames, users, writer };
    };
    const shared = await reruns("shared:list", "list without ctx.auth (shared)");
    expect(shared.perCommit).toBe(1);
    // One frame per subscriber per commit (feature "batch": the patch alone), whatever the number of subscribers.
    row("frames per subscriber per commit", shared.frames);
    expect(shared.frames).toBe(1);
    const gated = await reruns("shared:gated", "list with authorize (shared handler)");
    expect(gated.perCommit).toBe(1);
    expect(gated.gates).toBe(0); // a note does not change membership: no check re-runs
    const inline = await reruns("shared:inline", "check inside the handler (per user)");
    expect(inline.perCommit).toBe(USERS);
    const nested = await reruns("shared:feed", "per-user view over ctx.runQuery(list)");
    expect(nested.perCommit).toBe(USERS);
    row("  of which nested calls reused from the memo", nested.reused);
    expect(nested.reused).toBe(USERS - 1);
    for (const s of [shared, gated, inline, nested]) for (const x of [...s.users, s.writer]) x.c.close();

    // ------------------------------------------------------------- bytes per patch, one new row on a 50-row list
    {
      const shard = "perf:bytes";
      const w = await sock(shard);
      w.c.send({ t: "mut", mid: "seed", fn: "messages:seed", args: { channel: "b", n: 50 } });
      await w.c.waitFor(is("mres", (m) => m.mid === "seed"));
      const subs: Array<[string, string, Record<string, unknown>, string[] | undefined]> = [
        ["array, rowdiff", "messages:list", { channel: "b" }, FEATURES],
        ["array, no diff (old client)", "messages:list", { channel: "b" }, undefined],
        ["paginate() page, vdiff", "messages:paged", { channel: "b", paginationOpts: { numItems: 50, cursor: null } }, FEATURES],
        ["paginate() page, rowdiff only (older client)", "messages:paged", { channel: "b", paginationOpts: { numItems: 50, cursor: null } }, ["rowdiff", "ident"]],
      ];
      const socks: Array<{ name: string; c: Client; chars: () => number }> = [];
      for (const [name, fn, args, features] of subs) {
        const c = await connect(shard);
        await hello(c, crypto.randomUUID(), undefined, features);
        let chars = 0;
        c.ws.addEventListener("message", (e) => {
          const t = String(e.data);
          if (t.includes('"t":"patch"')) chars += t.length;
        });
        c.send({ t: "sub", qid: 1, fn, args });
        await c.waitFor(is("snap"));
        socks.push({ name, c, chars: () => chars });
      }
      const C = 5;
      for (let k = 0; k < C; k++) await mut(w.c, "messages:send", { channel: "b", body: `new ${k} with some text` });
      for (const s of socks) await s.c.waitFor(is("patch", (m) => m.version >= 0), 5000).catch(() => undefined);
      const bytes = new Map<string, number>();
      for (const s of socks) {
        await settle(s.c);
        bytes.set(s.name, row(`bytes per patch: ${s.name}`, s.chars() / C));
      }
      // Measured: 209 and 367 characters per patch frame (7 209 and 6 919 whole).
      expect(bytes.get("array, rowdiff")!).toBeLessThan(300);
      expect(bytes.get("paginate() page, vdiff")!).toBeLessThan(450);
      expect(bytes.get("array, no diff (old client)")!).toBeGreaterThan(10 * bytes.get("array, rowdiff")!);
      expect(bytes.get("paginate() page, rowdiff only (older client)")!).toBeGreaterThan(10 * bytes.get("paginate() page, vdiff")!);
      for (const s of socks) s.c.close();
      w.c.close();
    }

    const text = table.map(([k, v]) => `| ${k} | ${v} |`).join("\n");
    console.log(`performance counters:\n| counter | value |\n|---|---|\n${text}`);
    await annotate(`performance counters\n${text}`);
  }, 120_000);
});
