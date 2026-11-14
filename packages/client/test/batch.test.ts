// Feature "batch": what one turn sends goes out as one array frame, and array frames from the server are handled in
// order; without the feature (an older server) every message is its own frame.
import { describe, expect, it } from "vitest";
import { makeClient, messagesServer, SHARD, until } from "./helpers.ts";
import { unsafeRef } from "../src/index.ts";

async function connected(batch: boolean) {
  const server = messagesServer({ query: true, batch });
  const client = makeClient(server);
  const seen: string[][] = [];
  client.subscribe(unsafeRef("messages:list"), { channel: "x" }, {}, (s) => { if (s.value) seen.push(s.value as string[]); });
  await until(() => client.connectionState().shards[SHARD] === "open");
  return { server, client, seen, ws: server.open()[0]! };
}

describe("batch frames", () => {
  it("a burst of mutations and queries is one frame; the server's replies of one turn are one frame", async () => {
    const { client, ws, seen } = await connected(true);
    const before = ws.batchesIn;
    const results = await Promise.all([
      ...Array.from({ length: 20 }, (_, i) => client.mutation(unsafeRef("messages:send"), { channel: "x", body: `m${i}` })),
      client.query(unsafeRef("messages:count"), {}),
    ]);
    expect(results).toHaveLength(21);
    expect(ws.batchesIn - before).toBe(1);
    expect(ws.sent.filter((m) => m !== "ping" && m.t === "mut")).toHaveLength(20);
    expect(ws.batchesOut).toBeGreaterThanOrEqual(1);
    await until(() => seen.at(-1)?.length === 20);
    expect(seen.at(-1)).toEqual(Array.from({ length: 20 }, (_, i) => `m${i}`));
    expect(client.connectionState().pendingMutations).toBe(0);
    client.close();
  });

  it("a batch frame runs one recompute for all its messages; listeners and callers see its final state", async () => {
    const { client, ws } = await connected(true);
    const values = new Map<string, unknown>();
    const notified = new Map<string, number>();
    for (let i = 0; i < 20; i++) {
      client.subscribe(unsafeRef("messages:list"), { channel: `c${i}` }, {}, (s) => {
        values.set(`c${i}`, s.value);
        notified.set(`c${i}`, (notified.get(`c${i}`) ?? 0) + 1);
      });
    }
    await until(() => values.size === 20);
    const c = client as unknown as { recompute(only?: unknown): void; frameDepth: number };
    const original = c.recompute.bind(client);
    let effective = 0;
    c.recompute = (only?: unknown) => {
      if (c.frameDepth === 0) effective++;
      original(only);
    };
    notified.clear();
    const before = ws.batchesIn;
    // 20 mutations in one frame: the server answers with one frame of 20 patches and 20 results.
    const done = Promise.all(Array.from({ length: 20 }, (_, i) => client.mutation(unsafeRef("messages:send"), { channel: `c${i}`, body: `b${i}` }).then(() => values.get(`c${i}`))));
    const seenByCaller = await done;
    expect(ws.batchesIn - before).toBe(1);
    // Each caller resumes after its patch is visible.
    expect(seenByCaller).toEqual(Array.from({ length: 20 }, (_, i) => [`b${i}`]));
    expect(effective).toBe(1);
    expect([...notified.values()]).toEqual(Array.from({ length: 20 }, () => 1));
    client.close();
  });

  it("without the feature every message is its own frame", async () => {
    const { client, ws } = await connected(false);
    await Promise.all(Array.from({ length: 5 }, (_, i) => client.mutation(unsafeRef("messages:send"), { channel: "x", body: `m${i}` })));
    expect(ws.batch).toBe(false);
    expect(ws.batchesIn).toBe(0);
    expect(ws.batchesOut).toBe(0);
    expect(ws.sent.filter((m) => m !== "ping" && m.t === "mut")).toHaveLength(5);
    client.close();
  });

  it("messages queued for a socket that closed are dropped, and the mutations go out again on the next socket", async () => {
    const { server, client } = await connected(true);
    const p = client.mutation(unsafeRef("messages:send"), { channel: "x", body: "again" });
    server.open()[0]!.drop();
    expect(await p).toBeDefined();
    await until(() => server.open().length === 1 && server.open()[0]!.sent.some((m) => m !== "ping" && m.t === "mut"));
    expect(client.connectionState().pendingMutations).toBe(0);
    client.close();
  });
});
