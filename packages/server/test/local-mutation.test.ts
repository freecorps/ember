// Mutations run on the client (Brigade RFC 0016 gap G5): the server's handler over an overlay of a replica.
import { describe, expect, it } from "vitest";
import {
  EmberError,
  mutationGeneric,
  overlayReader,
  queryGeneric,
  runLocalMutation,
  runLocalQuery,
  v,
  type Doc,
  type LocalReader,
} from "../src/index.ts";
import { schema } from "./fixtures.ts";

const EMPTY: LocalReader = { scan: () => [], get: () => null };
const mutation = (handler: (ctx: any, args: any) => unknown, args: Record<string, any> = {}) => mutationGeneric({ args, handler: handler as any }) as any;
const query = (handler: (ctx: any, args: any) => unknown, args: Record<string, any> = {}) => queryGeneric({ args, handler: handler as any }) as any;

const byChannel = query((ctx, { channel }) => ctx.db.query("messages").withIndex("by_channel", (r: any) => r.eq("channel", channel)).collect(), { channel: v.string() });
const newest = query((ctx, { channel }) => ctx.db.query("messages").withIndex("by_channel", (r: any) => r.eq("channel", channel)).order("desc").take(2), { channel: v.string() });

describe("runLocalMutation", () => {
  it("inserts, patches and deletes in an overlay; queries over it see the writes in index order", () => {
    const r = overlayReader(EMPTY, schema);
    const author = runLocalMutation(mutation((ctx) => ctx.db.insert("users", { name: "Ada", email: "ada@x.dev", admin: false })), {}, { schema, reader: r }).value as string;
    const send = mutation((ctx, a) => ctx.db.insert("messages", { ...a, author }), { channel: v.string(), body: v.string(), likes: v.number() });
    const ids = ["one", "two", "three"].map((body, i) => runLocalMutation(send, { channel: "a", body, likes: i }, { schema, reader: r, now: 10 + i }).value as string);
    expect((runLocalQuery(byChannel, { channel: "a" }, { schema, reader: r }).value as Doc[]).map((m) => m.body)).toEqual(["one", "two", "three"]);
    expect((runLocalQuery(newest, { channel: "a" }, { schema, reader: r }).value as Doc[]).map((m) => m.body)).toEqual(["three", "two"]);
    const edit = mutation((ctx, { id }) => {
      ctx.db.patch(id, { body: "uno" });
      return ctx.db.get(id).body; // reads see the mutation's own writes
    }, { id: v.id("messages") });
    expect(runLocalMutation(edit, { id: ids[0] }, { schema, reader: r }).value).toBe("uno");
    const out = runLocalMutation(mutation((ctx, { id }) => ctx.db.delete(id), { id: v.id("messages") }), { id: ids[1] }, { schema, reader: r });
    expect(out.changes).toEqual([{ table: "messages", id: ids[1], before: expect.objectContaining({ body: "two" }), after: null }]);
    expect((runLocalQuery(byChannel, { channel: "a" }, { schema, reader: r }).value as Doc[]).map((m) => m.body)).toEqual(["uno", "three"]);
    expect(r.get("messages", ids[0]!)).toMatchObject({ _id: ids[0], body: "uno", channel: "a", author });
  });

  it("validates like the engine: arguments, system fields, the document shape, missing documents", () => {
    const r = overlayReader(EMPTY, schema);
    const write = (fn: any, args: unknown = {}) => () => runLocalMutation(fn, args, { schema, reader: r });
    expect(write(mutation(() => null, { n: v.number() }), { n: "x" })).toThrow(/Invalid arguments/);
    expect(write(mutation((ctx) => ctx.db.insert("users", { _id: "x", name: "a", email: "a@x.dev", admin: false })))).toThrow(/System field _id/);
    expect(write(mutation((ctx) => ctx.db.insert("users", { name: 1, email: "a@x.dev", admin: false })))).toThrow(/invalid/);
    expect(write(mutation((ctx) => ctx.db.patch("users_01J0000000000000000000000", { name: "a" })))).toThrow(EmberError);
    expect(write(mutation((ctx) => ctx.storage.generateUploadUrl()))).toThrow(/not available/);
  });

  it("a handler that throws leaves the caller's overlay as it was", () => {
    const r = overlayReader(EMPTY, schema);
    expect(() =>
      runLocalMutation(
        mutation((ctx) => {
          ctx.db.insert("users", { name: "half", email: "h@x.dev", admin: false });
          throw new Error("rule");
        }),
        {},
        { schema, reader: r },
      ),
    ).toThrow("rule");
    expect(r.changes()).toEqual([]);
  });

  it("records scheduled jobs without running them; ctx.random is seeded", () => {
    const r = overlayReader(EMPTY, schema);
    const fn = mutation((ctx) => {
      ctx.scheduler.runAfter(1000, "jobs:later", { x: 1 });
      return [ctx.random(), ctx.random()];
    });
    const a = runLocalMutation(fn, {}, { schema, reader: r, now: 5_000, seed: 42 });
    const b = runLocalMutation(fn, {}, { schema, reader: r, now: 5_000, seed: 42 });
    expect(a.value).toEqual(b.value);
    expect(a.jobs).toEqual([{ id: expect.stringMatching(/^job_/), fn: "jobs:later", args: { x: 1 }, runAt: 6_000 }]);
  });

  it("an overlay over a base hides the base's rewritten rows and keeps the rest of its range", () => {
    const base = overlayReader(EMPTY, schema);
    const send = mutation((ctx, a) => ctx.db.insert("messages", a), { channel: v.string(), body: v.string(), author: v.string(), likes: v.number() });
    const author = runLocalMutation(mutation((ctx) => ctx.db.insert("users", { name: "Ada", email: "ada@x.dev", admin: false })), {}, { schema, reader: base }).value as string;
    const [x, y] = ["x", "y"].map((body, i) => runLocalMutation(send, { channel: "a", body, author, likes: i }, { schema, reader: base, now: 100 + i }).value as string);
    const top = overlayReader(base, schema);
    runLocalMutation(mutation((ctx, { id }) => ctx.db.patch(id, { channel: "b" }), { id: v.id("messages") }), { id: x }, { schema, reader: top });
    expect((runLocalQuery(byChannel, { channel: "a" }, { schema, reader: top }).value as Doc[]).map((m) => m._id)).toEqual([y]);
    expect((runLocalQuery(byChannel, { channel: "b" }, { schema, reader: top }).value as Doc[]).map((m) => m._id)).toEqual([x]);
    // The base is untouched.
    expect((runLocalQuery(byChannel, { channel: "a" }, { schema, reader: base }).value as Doc[]).map((m) => m._id)).toEqual([x, y]);
  });
});
