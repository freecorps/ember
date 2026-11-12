// The chat app on workerd: the backend (rooms, a paginated history, full-text search) and the client side (live
// queries over a real WebSocket, the optimistic send the UI uses), all through the shipped `EmberClient`.
import { describe, expect, it } from "vitest";
import { api } from "../ember/_generated/api";
import { addMessageOptimistically, isOptimistic } from "../web/src/optimistic";
import { testClient, watch } from "@freecorps/ember-example-testing";
import { EmberError, isError } from "@freecorps/ember-client";
import { errors } from "../ember/_generated/errors";

// Every test gets its own shard, so tests never see each other's rooms.
let n = 0;
const app = () => {
  const defaultShard = `global:chat-${Date.now()}-${n++}`;
  return { client: testClient({ defaultShard }), other: () => testClient({ defaultShard }) };
};

describe("rooms", () => {
  it("creates a room once, normalizing the name", async () => {
    const { client } = app();
    const general = await client.mutation(api.rooms.create, { name: "  General  " });
    expect(await client.mutation(api.rooms.create, { name: "general" })).toBe(general);
    await client.mutation(api.rooms.create, { name: "Off Topic" });
    expect((await client.query(api.rooms.list, {})).map((r) => r.name)).toEqual(["general", "off-topic"]);
    await expect(client.mutation(api.rooms.create, { name: "   " })).rejects.toThrow(/needs a name/);
    client.close();
  });
});

describe("messages", () => {
  it("validates what is sent", async () => {
    const { client } = app();
    const roomId = await client.mutation(api.rooms.create, { name: "general" });
    await expect(client.mutation(api.messages.send, { roomId, author: "ana", body: "   " })).rejects.toThrow(/Empty/);
    await expect(client.mutation(api.messages.send, { roomId, author: "ana", body: "x".repeat(2001) })).rejects.toThrow(/limited/);
    await expect(client.mutation(api.messages.send, { roomId: "rooms_nope" as typeof roomId, author: "ana", body: "hi" })).rejects.toThrow();
    await client.mutation(api.messages.send, { roomId, author: " ", body: "hi" });
    // Application errors reach the client typed, with their payload, and say the mutation did not commit.
    const tooLong = await client.mutation(api.messages.send, { roomId, author: "ana", body: "x".repeat(2001) }).catch((e: unknown) => e);
    expect(tooLong).toBeInstanceOf(EmberError);
    if (!isError(tooLong, api.messages.send, "MessageTooLong")) throw new Error("expected MessageTooLong");
    expect(tooLong.data.max).toBe(2000);
    expect(tooLong).toMatchObject({ kind: "app", code: "MessageTooLong", outcome: "rejected", message: "Messages are limited to 2000 characters" });
    // A well-formed id of a room that only exists in another shard.
    const elsewhere = await testClient({ defaultShard: `global:chat-other-${Date.now()}` }).mutation(api.rooms.create, { name: "elsewhere" });
    const missing = await client.mutation(api.messages.send, { roomId: elsewhere, author: "ana", body: "hi" }).catch((e: unknown) => e);
    expect(errors.RoomNotFound.is(missing) && missing.data.roomId).toBe(elsewhere);
    const empty = await client.mutation(api.messages.send, { roomId, author: "ana", body: " " }).catch((e: unknown) => e);
    expect(isError(empty, errors.EmptyMessage) && empty.data).toBeUndefined();
    // Arguments that fail validation are a system error, not an application one.
    const bad = await client.mutation(api.messages.send, { roomId, author: "ana", body: 1 as unknown as string }).catch((e: unknown) => e);
    expect(bad).toMatchObject({ kind: "system", code: "ValidationError" });
    const { page } = await client.query(api.messages.list, { roomId, paginationOpts: { numItems: 5, cursor: null } });
    expect(page).toMatchObject([{ author: "anonymous", body: "hi" }]);
    client.close();
  });

  it("pages through the history newest first, each message exactly once", async () => {
    const { client } = app();
    const roomId = await client.mutation(api.rooms.create, { name: "history" });
    for (let i = 1; i <= 7; i++) await client.mutation(api.messages.send, { roomId, author: "ana", body: `message ${i}` });
    const bodies: string[] = [];
    let cursor: string | null = null;
    for (let pages = 0; pages < 10; pages++) {
      const res: Awaited<ReturnType<typeof client.query<typeof api.messages.list>>> = await client.query(api.messages.list, { roomId, paginationOpts: { numItems: 3, cursor } });
      bodies.push(...res.page.map((m) => m.body));
      if (res.isDone) break;
      cursor = res.continueCursor;
    }
    expect(bodies).toEqual([7, 6, 5, 4, 3, 2, 1].map((i) => `message ${i}`));
    client.close();
  });

  it("searches the text of one room only, ignoring case and accents", async () => {
    const { client } = app();
    const a = await client.mutation(api.rooms.create, { name: "a" });
    const b = await client.mutation(api.rooms.create, { name: "b" });
    await client.mutation(api.messages.send, { roomId: a, author: "ana", body: "Vamos almoçar às 12h?" });
    await client.mutation(api.messages.send, { roomId: a, author: "bia", body: "Pode ser, reservo a mesa" });
    await client.mutation(api.messages.send, { roomId: b, author: "caio", body: "Quem vai almoçar?" });
    const found = await client.query(api.messages.search, { roomId: a, text: "ALMOCAR" });
    expect(found.map((m) => m.body)).toEqual(["Vamos almoçar às 12h?"]);
    expect(await client.query(api.messages.search, { roomId: a, text: "jantar" })).toEqual([]);
    client.close();
  });
});

describe("live queries and the optimistic send", () => {
  it("shows the message at once, swaps in the server's version, and the other client sees it live", async () => {
    const { client, other } = app();
    const roomId = await client.mutation(api.rooms.create, { name: "live" });
    const head = { roomId, paginationOpts: { numItems: 20, cursor: null } };
    const mine = watch(client, api.messages.list, head);
    const theirs = other();
    const seenByOther = watch(theirs, api.messages.list, head);
    await expect.poll(() => mine.last()?.status).toBe("success");
    await expect.poll(() => seenByOther.last()?.status).toBe("success");

    // The same wiring as `useMutation(api.messages.send).withOptimisticUpdate(...)` in the UI.
    const sent = client.mutation(api.messages.send, { roomId, author: "ana", body: "hello" }, { optimisticUpdate: addMessageOptimistically });
    expect(mine.last()).toMatchObject({ optimistic: true });
    expect(mine.last()!.value!.page.map((m) => [m.body, isOptimistic(m._id)])).toEqual([["hello", true]]);

    const id = await sent;
    await expect.poll(() => mine.last()?.optimistic).toBe(false);
    expect(mine.last()!.value!.page).toMatchObject([{ _id: id, body: "hello", author: "ana" }]);
    await expect.poll(() => seenByOther.last()?.value?.page.length).toBe(1);
    expect(seenByOther.last()!.value!.page[0]).toMatchObject({ _id: id, body: "hello" });

    // A failing send rolls the optimistic message back.
    await expect(client.mutation(api.messages.send, { roomId, author: "ana", body: "   " }, { optimisticUpdate: addMessageOptimistically })).rejects.toThrow(/Empty/);
    expect(mine.last()!.value!.page.map((m) => m.body)).toEqual(["hello"]);
    expect(mine.last()!.optimistic).toBe(false);

    mine.stop();
    seenByOther.stop();
    theirs.close();
    client.close();
  });
});
