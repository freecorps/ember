// Protocol v1.1 "rowdiff": per-row patch diffs for array-of-docs results, negotiated in hello; plus ctx.db.sql
// reactivity on DO SQLite.
import { applyRowDiff, applyValueDiff, encodeJson } from "@freecorps/ember-values";
import { describe, expect, it } from "vitest";
import type { ClientMessage, ServerMessage } from "../src/protocol.ts";
import { connect, is, type Client } from "./helpers.ts";

type Patch = Extract<ServerMessage, { t: "patch" }>;
type Snap = Extract<ServerMessage, { t: "snap" }> & { value?: any };

async function helloWith(c: Client, features?: string[]) {
  const m: ClientMessage = { t: "hello", clientId: crypto.randomUUID(), protocol: 1, ...(features ? { features } : {}) };
  c.send(m);
  return c.waitFor<Extract<ServerMessage, { t: "ready" }>>(is("ready"));
}

describe("rowdiff", () => {
  it("negotiated in hello; diff patches rebuild the value; bandwidth on a 500-row list", async () => {
    const shard = "chat:rowdiff";
    const a = await connect(shard);
    const b = await connect(shard);
    expect((await helloWith(a, ["rowdiff", "future-thing"])).features).toEqual(["rowdiff"]);
    expect((await helloWith(b)).features).toBeUndefined();
    a.send({ t: "mut", mid: 1, fn: "messages:seed", args: { channel: "big", n: 500 } });
    await a.waitFor(is("mres", (m) => m.mid === 1));
    a.send({ t: "sub", qid: 1, fn: "messages:list", args: { channel: "big" } });
    b.send({ t: "sub", qid: 1, fn: "messages:list", args: { channel: "big" } });
    let value = (await a.waitFor<Snap>(is("snap"))).value as any[];
    await b.waitFor<Snap>(is("snap"));
    expect(value).toHaveLength(500);

    const sizes: Record<string, { full: number; diff: number }> = {};
    const step = async (name: string, mut: ClientMessage) => {
      a.send(mut);
      const pa = await a.waitFor<Patch>(is("patch"));
      const pb = await b.waitFor<Patch>(is("patch"));
      const ca = pa.changes[0]!;
      const cb = pb.changes[0]!;
      expect(ca.diff).toBeDefined();
      expect(cb.value).toBeDefined();
      value = applyRowDiff(value, ca.diff!);
      expect(value).toEqual(cb.value);
      sizes[name] = { full: encodeJson(pb).length, diff: encodeJson(pa).length };
    };
    await step("update", { t: "mut", mid: 2, fn: "messages:edit", args: { id: value[250]._id, body: "edited" } });
    await step("insert", { t: "mut", mid: 3, fn: "messages:send", args: { channel: "big", body: "new one" } });
    await step("delete", { t: "mut", mid: 4, fn: "messages:remove", args: { id: value[10]._id } });
    console.log("rowdiff patch frame bytes, 500-row list:", JSON.stringify(sizes));
    for (const s of Object.values(sizes)) expect(s.diff * 50).toBeLessThan(s.full);
    a.close();
    b.close();
  });

  it("vdiff: objects holding arrays of docs (paginate, nested) patch with value diffs; a client without it gets the value", async () => {
    const shard = "chat:vdiff";
    const a = await connect(shard);
    const b = await connect(shard);
    const old = await connect(shard);
    expect((await helloWith(a, ["rowdiff", "vdiff"])).features).toEqual(["rowdiff", "vdiff"]);
    await helloWith(b);
    expect((await helloWith(old, ["rowdiff"])).features).toEqual(["rowdiff"]);
    a.send({ t: "mut", mid: 1, fn: "messages:seed", args: { channel: "v", n: 60 } });
    await a.waitFor(is("mres", (m) => m.mid === 1));
    const queries: Array<[number, string, Record<string, unknown>]> = [
      [1, "messages:paged", { channel: "v", paginationOpts: { numItems: 20, cursor: null } }],
      [2, "messages:nested", { channel: "v" }],
    ];
    const held = new Map<number, unknown>();
    for (const c of [a, b, old]) for (const [qid, fn, args] of queries) c.send({ t: "sub", qid, fn, args });
    for (const [qid] of queries) {
      held.set(qid, (await a.waitFor<Snap>(is("snap", (m) => m.qid === qid))).value);
      await b.waitFor<Snap>(is("snap", (m) => m.qid === qid));
      await old.waitFor<Snap>(is("snap", (m) => m.qid === qid));
    }
    let seed = 5;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    let diffBytes = 0;
    let fullBytes = 0;
    for (let i = 0; i < 30; i++) {
      const paged = held.get(1) as { page: Array<{ _id: string }> };
      const r = rnd();
      const mut: ClientMessage =
        r < 0.5 || !paged.page.length
          ? { t: "mut", mid: 100 + i, fn: "messages:send", args: { channel: "v", body: `new ${i}` } }
          : r < 0.75
            ? { t: "mut", mid: 100 + i, fn: "messages:edit", args: { id: paged.page[Math.floor(rnd() * paged.page.length)]!._id, body: `edited ${i}` } }
            : { t: "mut", mid: 100 + i, fn: "messages:remove", args: { id: paged.page[Math.floor(rnd() * paged.page.length)]!._id } };
      a.send(mut);
      const pa = await a.waitFor<Patch>(is("patch"));
      const pb = await b.waitFor<Patch>(is("patch"));
      const po = await old.waitFor<Patch>(is("patch"));
      for (const ca of pa.changes) {
        const cb = pb.changes.find((c) => c.qid === ca.qid)!;
        const co = po.changes.find((c) => c.qid === ca.qid)!;
        expect(cb.value).toBeDefined();
        expect(co.value).toBeDefined(); // a client without "vdiff" never gets one
        expect(ca.value).toBeUndefined();
        const next = applyValueDiff(held.get(Number(ca.qid)), ca.vdiff!);
        expect(encodeJson(next)).toBe(encodeJson(cb.value));
        held.set(Number(ca.qid), next);
        diffBytes += encodeJson(ca).length;
        fullBytes += encodeJson(cb).length;
      }
    }
    console.log(`vdiff patch bytes (paginate + nested, 30 commits): ${fullBytes} -> ${diffBytes}`);
    expect(diffBytes * 10).toBeLessThan(fullBytes);
    a.close();
    b.close();
    old.close();
  });

  it("falls back to the full value for non doc-array results", async () => {
    const a = await connect("chat:rowdiff-scalar");
    await helloWith(a, ["rowdiff"]);
    a.send({ t: "sub", qid: 1, fn: "messages:latest", args: { channel: "s" } });
    await a.waitFor(is("err"));
    a.send({ t: "mut", mid: 1, fn: "messages:send", args: { channel: "s", body: "one" } });
    expect((await a.waitFor<Patch>(is("patch"))).changes).toEqual([{ qid: 1, value: "one" }]);
    a.close();
  });
});

describe("ctx.db.sql on DO SQLite", () => {
  it("GROUP BY with a bound parameter; any write to the table re-runs it", async () => {
    const a = await connect("chat:sql");
    await helloWith(a);
    a.send({ t: "mut", mid: 1, fn: "messages:send", args: { channel: "x", body: "1" } });
    a.send({ t: "mut", mid: 2, fn: "messages:send", args: { channel: "y", body: "2" } });
    a.send({ t: "mut", mid: 3, fn: "messages:send", args: { channel: "y", body: "3" } });
    await a.waitFor(is("mres", (m) => m.mid === 3));
    a.send({ t: "sub", qid: "s", fn: "messages:perChannel", args: { min: 2 } });
    expect((await a.waitFor<Snap>(is("snap"))).value).toEqual([{ channel: "y", n: 2 }]);
    a.send({ t: "mut", mid: 4, fn: "messages:send", args: { channel: "x", body: "4" } });
    expect((await a.waitFor<Patch>(is("patch"))).changes).toEqual([{ qid: "s", value: [{ channel: "x", n: 2 }, { channel: "y", n: 2 }] }]);
    a.close();
  });
});
