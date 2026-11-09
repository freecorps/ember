// Protocol v1.1 "rowdiff" on the client: negotiation, diff application, optimistic rebase over diffs, and a full
// resync when a diff does not fit the confirmed value.
import { describe, expect, it } from "vitest";
import { anyApi, encodeJson, type EmberError, type FunctionReference, type QuerySnapshot } from "../src/index.ts";
import { makeClient, messagesServer, SHARD, tick, until } from "./helpers.ts";

type Msg = { _id: string; channel: string; body: string };
const api = anyApi as unknown as {
  messages: {
    docs: FunctionReference<"query", { channel: string }, Msg[]>;
    send: FunctionReference<"mutation", { channel: string; body: string }, string>;
    edit: FunctionReference<"mutation", { id: string; body: string }, null>;
  };
};

const server = () =>
  messagesServer({
    queries: { "messages:docs": (db, { channel }) => db.where("messages", "channel", channel) },
    mutations: {
      "messages:edit": (db, { id, body }) => db.patch("messages", id, { body }),
      "messages:seed": (db, { channel, n }) => {
        for (let i = 0; i < n; i++) db.insert("messages", { channel, body: `message number ${i} with some text` });
      },
    },
  });

function collect<T>() {
  const seen: QuerySnapshot<T>[] = [];
  return { seen, cb: (s: QuerySnapshot<T>) => seen.push(s), last: () => seen[seen.length - 1] };
}

describe("rowdiff (client)", () => {
  it("negotiates the feature and rebuilds values from diffs (vs. a client without it)", async () => {
    const s = server();
    s.mutateDirect(SHARD, "messages:seed", { channel: "c", n: 500 });
    const withDiff = makeClient(s);
    const without = makeClient(s, { rowDiff: false });
    const a = collect<Msg[]>();
    const b = collect<Msg[]>();
    withDiff.subscribe(api.messages.docs, { channel: "c" }, {}, a.cb);
    without.subscribe(api.messages.docs, { channel: "c" }, {}, b.cb);
    await until(() => a.last()?.status === "success" && b.last()?.status === "success");
    const [sa, sb] = s.open();
    expect(sa!.sent[0]).toMatchObject({ t: "hello", features: ["rowdiff", "ident", "query", "ack", "batch"] });
    // Without rowdiff the client still offers "ident", "query" and "ack"; this test server does not speak them (an older server).
    expect(sb!.sent[0]).toMatchObject({ t: "hello", features: ["ident", "query", "ack", "batch"] });
    expect(sa!.received.find((f) => f !== "pong" && f.t === "ready")).toMatchObject({ features: ["rowdiff"] });

    const before = a.last()!.value!;
    const target = before[250]!._id;
    s.mutateDirect(SHARD, "messages:edit", { id: target, body: "edited" });
    s.mutateDirect(SHARD, "messages:send", { channel: "c", body: "appended" });
    await until(() => a.last()!.value!.length === 501 && b.last()!.value!.length === 501);
    expect(a.last()!.value).toEqual(b.last()!.value);
    expect(a.last()!.value![250]!.body).toBe("edited");
    // unchanged rows keep their identity
    expect(a.last()!.value![249]).toBe(before[249]);

    const patches = (sock: typeof sa) => sock!.received.filter((f): f is any => f !== "pong" && f.t === "patch");
    const diffBytes = patches(sa).reduce((n, p) => n + encodeJson(p).length, 0);
    const fullBytes = patches(sb).reduce((n, p) => n + encodeJson(p).length, 0);
    expect(patches(sa).every((p: any) => p.changes.every((c: any) => c.diff))).toBe(true);
    expect(diffBytes * 50).toBeLessThan(fullBytes);
    withDiff.close();
    without.close();
  });

  it("optimistic updates rebase over diff patches and drop on confirm", async () => {
    const s = server();
    s.mutateDirect(SHARD, "messages:send", { channel: "o", body: "first" });
    const client = makeClient(s);
    const c = collect<Msg[]>();
    client.subscribe(api.messages.docs, { channel: "o" }, {}, c.cb);
    await until(() => c.last()?.status === "success");
    const sock = s.open()[0]!;
    sock.holdIncoming();
    const p = client.mutation(api.messages.send, { channel: "o", body: "mine" }, {
      optimisticUpdate: (store, args) => {
        const cur = store.getQuery(api.messages.docs, { channel: "o" });
        if (cur) store.setQuery(api.messages.docs, { channel: "o" }, [...cur, { _id: "tmp", channel: "o", body: `${args.body}*` }]);
      },
    });
    expect(c.last()!.value!.map((m) => m.body)).toEqual(["first", "mine*"]);
    s.mutateDirect(SHARD, "messages:send", { channel: "o", body: "theirs" });
    await until(() => c.last()!.value!.some((m) => m.body === "theirs"));
    expect(c.last()!.value!.map((m) => m.body)).toEqual(["first", "theirs", "mine*"]);
    expect(c.last()!.optimistic).toBe(true);
    sock.releaseIncoming();
    await p;
    await tick(5);
    expect(c.last()!.value!.map((m) => m.body)).toEqual(["first", "theirs", "mine"]);
    expect(c.last()!.optimistic).toBe(false);
    const diffs = sock.received.filter((f): f is any => f !== "pong" && f.t === "patch").flatMap((f: any) => f.changes);
    expect(diffs.length).toBeGreaterThan(0);
    expect(diffs.every((ch: any) => ch.diff)).toBe(true);
    client.close();
  });

  it("a diff that does not fit the confirmed value triggers a full resync (no resume)", async () => {
    const s = server();
    s.mutateDirect(SHARD, "messages:send", { channel: "r", body: "one" });
    const errors: EmberError[] = [];
    const client = makeClient(s, { onError: (e) => errors.push(e) });
    const c = collect<Msg[]>();
    client.subscribe(api.messages.docs, { channel: "r" }, {}, c.cb);
    await until(() => c.last()?.status === "success");
    const sock = s.open()[0]!;
    const qid = (sock.sent.find((f) => f !== "ping" && f.t === "sub") as any).qid;
    sock.deliver(encodeJson({ t: "patch", version: 99, changes: [{ qid, diff: { remove: ["nope"], upsert: [] } }], mids: [] }));
    await until(() => errors.some((e) => e.code === "rowdiff_mismatch"));
    await until(() => sock.sent.filter((f) => f !== "ping" && f.t === "sub").length === 2);
    const resub = sock.sent.filter((f): f is any => f !== "ping" && f.t === "sub")[1];
    expect(resub.resume).toBeUndefined();
    expect(sock.sent.some((f) => f !== "ping" && f.t === "unsub")).toBe(true);
    await tick(5);
    expect(c.last()!.value!.map((m) => m.body)).toEqual(["one"]);
    s.mutateDirect(SHARD, "messages:send", { channel: "r", body: "two" });
    await until(() => c.last()!.value!.length === 2);
    client.close();
  });
});
