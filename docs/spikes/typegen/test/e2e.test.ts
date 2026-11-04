import { describe, expect, test } from "bun:test";
import { Engine, openSqlite } from "cfx";
import { createLocalClient } from "cfx/client";
import { api, internal } from "../sample/_generated/api";
import modules from "../sample/_generated/modules";
import schema from "../sample/schema";

describe("generated api end to end (in-process transport)", () => {
  test("subscribe -> mutate -> update; runtime arg validation; visibility", async () => {
    const { engine } = Engine.push(openSqlite(), schema);
    const client = createLocalClient(engine, modules);
    const me = await client.mutation(api.users.create, { name: "Ada", email: "ada@x.dev" });
    const seen: string[][] = [];
    const stop = await client.subscribe(api.messages.list, { channel: "general" }, (rows) => seen.push(rows.map((r) => r.body)));
    await client.mutation(api.messages.send, { channel: "general", author: me, body: "one" });
    await client.mutation(api.messages.send, { channel: "random", author: me, body: "elsewhere" });
    await client.mutation(api.messages.send, { channel: "general", author: me, body: "two" });
    expect(seen).toEqual([[], ["one"], ["two", "one"]]); // "random" produced no update
    stop();
    await expect(client.query(api.messages.list, { channel: 42 } as any)).rejects.toThrow(/channel: Expected string/);
    await expect(client.mutation(api.messages.send, { channel: "g", author: "nope" as any, body: "b" })).rejects.toThrow(/author: Expected Id<"users">/);
    await expect(client.query(internal.nested.admin.stats as any)).rejects.toThrow(/not a public query/);
    expect(await client.query(api.users.count)).toBe(1);
  });
});
