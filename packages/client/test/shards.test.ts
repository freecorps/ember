// Routing by the function's shard spec (docs/design/dx.md §3.6): a reference carrying `{kind, fromArg}` (the generated
// api.js attaches it) goes to `<kind>:<args[fromArg]>` with no `shard` option; a named-shard function needs one.
import { describe, expect, it } from "vitest";
import { FUNCTION_SHARD, makeFunctionReference, type FunctionReference, type OnShardLike } from "../src/index.ts";
import { makeClient, messagesServer, until } from "./helpers.ts";

function routed<F extends FunctionReference<any, any, any, any, any, any>>(name: string, spec: { kind: string; fromArg?: string }): F {
  const ref = makeFunctionReference(name) as unknown as Record<symbol, unknown>;
  ref[FUNCTION_SHARD] = spec;
  return ref as unknown as F;
}

type ListRef = FunctionReference<"query", "public", { channel: string }, string[], never> & OnShardLike<{ kind: "room"; fromArg: "channel" }>;
type SendRef = FunctionReference<"mutation", "public", { channel: string; body: string }, string, never> & OnShardLike<{ kind: "room"; fromArg: "channel" }>;
type CountRef = FunctionReference<"query", "public", {}, number, never> & OnShardLike<{ kind: "org" }>;

describe("shard routing", () => {
  it("routes by the argument the function declares, over WS and HTTP", async () => {
    const server = messagesServer();
    const c = makeClient(server, { defaultShard: undefined as never });
    const list = routed<ListRef>("messages:list", { kind: "room", fromArg: "channel" });
    const send = routed<SendRef>("messages:send", { kind: "room", fromArg: "channel" });
    await c.mutation(send, { channel: "r1", body: "hi" });
    expect(server.rows("room:r1", "messages").map((m) => m.body)).toEqual(["hi"]);
    expect(await c.query(list, { channel: "r1" }, { transport: "http" })).toEqual(["hi"]);
    let seen: unknown;
    const off = c.subscribe(list, { channel: "r1" }, undefined, (s) => (seen = s.value));
    await until(() => Array.isArray(seen));
    expect(seen).toEqual(["hi"]);
    off();
    c.close();
  });

  it("a named-shard function needs the shard (or a default of its kind)", async () => {
    const server = messagesServer();
    const count = routed<CountRef>("messages:count", { kind: "org" });
    const noDefault = makeClient(server, { defaultShard: "global:main" });
    await expect(noDefault.query(count, {}, { shard: "org:acme" })).resolves.toBe(0);
    // @ts-expect-error the org shard must be named
    await expect(noDefault.query(count)).rejects.toThrow(/runs in "org" shards: pass \{ shard: "org:<key>" \}/);
    const orgDefault = makeClient(server, { defaultShard: "org:acme" });
    await expect(orgDefault.query(count, {}, { shard: "org:acme" })).resolves.toBe(0);
    noDefault.close();
    orgDefault.close();
  });
});
