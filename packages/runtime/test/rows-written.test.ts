/**
 * Rows written per operation (Cloudflare bills $1 per million SQLite rows written; `cursor.rowsWritten` counts
 * one per table row and one per index entry an INSERT/UPDATE touches, one per deleted row). The shard's driver
 * sums every cursor (`inspect().rows`), so each number below is the real billed count of that operation on the
 * shard, steady state (after the change log reached its trim window). Prints the table (docs/spikes/rows-written.md)
 * and pins upper bounds.
 */
import { runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ServerMessage } from "../src/protocol.ts";
import { api, connect, hello, is, shardStub, type Client } from "./helpers.ts";

type MRes = Extract<ServerMessage, { t: "mres" }> & { value?: any };

const written = async (shard: string) => (await shardStub(shard).inspect()).rows.written;

/** Rows written by `op`, averaged over `n` runs (each run in its own group-commit batch). */
async function perOp(shard: string, n: number, op: (i: number) => Promise<unknown>): Promise<number> {
  const w0 = await written(shard);
  for (let i = 0; i < n; i++) await op(i);
  return ((await written(shard)) - w0) / n;
}

let midSeq = 0;
async function mut(c: Client, fn: string, args: Record<string, unknown>): Promise<MRes> {
  const mid = `m${++midSeq}`;
  c.send({ t: "mut", mid, fn, args });
  const r = await c.waitFor<MRes>(is("mres", (m) => m.mid === mid));
  if (!r.ok) throw new Error(`${fn}: ${JSON.stringify(r)}`);
  return r;
}

const table: Array<[string, number]> = [];
const row = (name: string, v: number) => {
  table.push([name, Math.round(v * 100) / 100]);
  return v;
};

describe("rows written per operation", () => {
  it("measures mutations, subscriptions and jobs", async ({ annotate }) => {
    const shard = "rows:bench";
    const c = await connect(shard);
    await hello(c, "bench-client");
    // Warm up past the change-log trim window (256 versions): every later commit pays its steady-state cost.
    for (let i = 0; i < 270; i++) await mut(c, "runs:add", { label: `warm${i}` });

    const N = 40;
    const wsRuns = row("insert, 0 user indexes (WS, dedup)", await perOp(shard, N, (i) => mut(c, "runs:add", { label: `r${i}` })));
    // A client that acknowledges settled mutations (feature "ack"): its outcomes never become dedup rows.
    const ca = await connect("rows:ack");
    await hello(ca, "ack-client", undefined, ["ack"]);
    const acked = async (label: string) => {
      const r = await mut(ca, "runs:add", { label });
      ca.send({ t: "ack", mids: [r.mid] });
      return r;
    };
    for (let i = 0; i < 270; i++) await acked(`warm${i}`);
    const wsAcked = row("insert, 0 user indexes (WS, client acks)", await perOp("rows:ack", N, (i) => acked(`a${i}`)));
    ca.close();
    const httpRuns = row("insert, 0 user indexes (HTTP, no dedup)", await perOp(shard, N, (i) => api("mutation", { fn: "runs:add", args: { label: `h${i}` }, shard })));
    row("insert, 1 index + search index (WS)", await perOp(shard, N, (i) => mut(c, "messages:send", { channel: "b", body: `hello ${i}` })));
    const wide = row("insert, 3 user indexes (WS)", await perOp(shard, N, (i) => mut(c, "wide:add", { a: `a${i}`, b: i, c: `c${i}` })));
    // Read-modify-write of one of the three indexed fields: the document and that one index entry.
    const bump = row("patch 1 of 3 indexed fields, after a query (WS)", await perOp(shard, N, (i) => mut(c, "wide:bump", { a: `a${i}` })));
    // Patch / delete on `messages` (one index; the search index is FTS5 over the body).
    const ids: string[] = [];
    for (let i = 0; i < N; i++) ids.push((await mut(c, "messages:send", { channel: "p", body: `x ${i}` })).value);
    row("patch, search-indexed field (WS)", await perOp(shard, N, (i) => mut(c, "messages:edit", { id: ids[i], body: `y ${i}` })));
    row("delete, 1 index + search index (WS)", await perOp(shard, N, (i) => mut(c, "messages:remove", { id: ids[i] })));

    // Subscriptions: start (snap) and stop, on a socket that already said hello; then a reconnect: a new socket
    // resubscribes with `resume` (the common reconnect path). Clients that negotiate "ident" (the current client)
    // and older ones (identity of each snapshot recorded in `_ember_sub_ident`).
    for (const [label, features] of [["", ["rowdiff", "ident"]], [", client without \"ident\"", undefined]] as const) {
      const s = await connect(shard);
      const clientId = `sub-client${label.length}`;
      await hello(s, clientId, undefined, features ? [...features] : undefined);
      const ik = new Map<number, string | undefined>();
      const base = label ? 3000 : 1000;
      row(`subscription start${label}`, await perOp(shard, N, async (i) => {
        const qid = base + i;
        s.send({ t: "sub", qid, fn: "messages:list", args: { channel: `s${i}` } });
        ik.set(qid, (await s.waitFor<Extract<ServerMessage, { t: "snap" }> & { ik?: string }>(is("snap", (m) => m.qid === qid))).ik);
      }));
      if (features) expect(ik.get(base)).toBeTypeOf("string");
      const r = await connect(shard);
      const ready = await hello(r, clientId, undefined, features ? [...features] : undefined);
      row(`subscription resume (reconnect)${label}`, await perOp(shard, N, async (i) => {
        const qid = base + i;
        const resume = { version: ready.version, epoch: ready.epoch, ...(ik.get(qid) ? { ik: ik.get(qid) } : {}) };
        r.send({ t: "sub", qid, fn: "messages:list", args: { channel: `s${i}` }, resume } as any);
        expect(await r.waitFor(is("snap", (m) => m.qid === qid))).toMatchObject({ unchanged: true });
      }));
      r.close();
      const noop = await perOp(shard, N, () => mut(s, "misc:noop", {}));
      row(`subscription stop${label}`, await perOp(shard, N, async (i) => {
        s.send({ t: "unsub", qid: base + i });
        await mut(s, "misc:noop", {}); // barrier: frames on one socket run in order
      }) - noop);
      s.close();
    }

    // Scheduler: scheduling one job a minute out (job row only), then scheduling one that runs now (the alarm
    // fires on its own: schedule + run, the run inserting one `runs` row and deleting the job).
    row("mutation scheduling 1 job, 60 s out (WS)", await perOp(shard, N, (i) => mut(c, "jobs:later", { label: `l${i}` })));
    const pendingBefore = (await shardStub(shard).inspect()).jobs.length;
    const sched = await perOp(shard, N, async (i) => {
      await mut(c, "jobs:schedule", { items: [{ delayMs: 0, label: `j${i}` }] });
      await runDurableObjectAlarm(shardStub(shard));
    });
    expect((await shardStub(shard).inspect()).jobs.length).toBe(pendingBefore);
    row("schedule 1 job + run it (inserts 1 row)", sched);
    c.close();

    const report = `rows written per operation (shard ${shard})\n| operation | rows |\n|---|---|\n${table.map(([k, v]) => `| ${k} | ${v} |`).join("\n")}`;
    console.error(report);
    await annotate(report);
    // Guards at the measured budgets (docs/spikes/rows-written.md), with half a row of slack for averaging: a
    // regression to the classic-storage costs (5 / 4 / 8) fails.
    expect(wsRuns).toBeGreaterThan(0); // the counter works here; 0 would make every guard vacuous
    expect(wsRuns).toBeLessThanOrEqual(3.5);
    expect(wsAcked).toBeLessThanOrEqual(2.5);
    expect(httpRuns).toBeLessThanOrEqual(2.5);
    expect(wide).toBeLessThanOrEqual(6.5);
    // Doc + by_b entry + ring row + dedup row: an UPDATE of every column would also rewrite by_a and by_c (6).
    expect(bump).toBeLessThanOrEqual(4.5);
  }, 240_000);
});
