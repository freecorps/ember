// The todo app on workerd: indexed filtering and reactive views on the server, then the offline story end to end
// (IndexedDB through fake-indexeddb): work offline, reload, reconnect, and the queue replays exactly once.
import { testClient, watch } from "@freecorps/ember-example-testing";
import type { ConnectivityEvent } from "@freecorps/ember-client";
import { indexedDbStorage } from "@freecorps/ember-offline/indexeddb";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { api } from "../ember/_generated/api";
import * as lists from "../ember/lists";
import schema from "../ember/schema";
import * as todos from "../ember/todos";
import { isPending, optimisticUpdates } from "../web/src/optimistic";

let n = 0;
const newShard = () => `global:todo-${Date.now()}-${n++}`;
const texts = (rows: { text: string }[] | undefined) => rows?.map((t) => t.text);

describe("lists and todos", () => {
  it("creates a list once and validates input", async () => {
    const client = testClient({ defaultShard: newShard() });
    const a = await client.mutation(api.lists.create, { name: " Groceries " });
    expect(await client.mutation(api.lists.create, { name: "Groceries" })).toBe(a);
    await expect(client.mutation(api.lists.create, { name: " " })).rejects.toThrow(/needs a name/);
    await expect(client.mutation(api.todos.add, { listId: a, text: "  " })).rejects.toThrow(/some text/);
    await expect(client.mutation(api.todos.add, { listId: "lists_nope" as typeof a, text: "x" })).rejects.toThrow();
    expect((await client.query(api.lists.list, {})).map((l) => l.name)).toEqual(["Groceries"]);
    client.close();
  });

  it("filters with indexes and keeps each view live", async () => {
    const client = testClient({ defaultShard: newShard() });
    const listId = await client.mutation(api.lists.create, { name: "Work" });
    const other = await client.mutation(api.lists.create, { name: "Home" });
    const milk = await client.mutation(api.todos.add, { listId, text: "milk" });
    await client.mutation(api.todos.add, { listId, text: "bread" });
    await client.mutation(api.todos.add, { listId: other, text: "someone else's" });
    await client.mutation(api.todos.setDone, { id: milk, done: true });

    const query = (filter: "all" | "pending" | "done") => client.query(api.todos.list, { listId, filter });
    expect(texts(await query("all"))).toEqual(["milk", "bread"]);
    expect(texts(await query("pending"))).toEqual(["bread"]);
    expect(texts(await query("done"))).toEqual(["milk"]);

    const pending = watch(client, api.todos.list, { listId, filter: "pending" });
    const done = watch(client, api.todos.list, { listId, filter: "done" });
    await expect.poll(() => texts(pending.last()?.value)).toEqual(["bread"]);
    await expect.poll(() => texts(done.last()?.value)).toEqual(["milk"]);

    // Completing a todo moves it from one live view to the other; a todo of another list changes nothing.
    const [bread] = pending.last()!.value!;
    await client.mutation(api.todos.setDone, { id: bread!._id, done: true });
    await expect.poll(() => texts(pending.last()?.value)).toEqual([]);
    await expect.poll(() => texts(done.last()?.value)).toEqual(["milk", "bread"]);
    const seen = done.seen.length;
    await client.mutation(api.todos.add, { listId: other, text: "more of the other list" });
    await client.mutation(api.todos.add, { listId, text: "eggs" });
    await expect.poll(() => texts(pending.last()?.value)).toEqual(["eggs"]);
    expect(done.seen.length).toBe(seen); // the "done" range did not change, so that query did not re-run

    expect(await client.mutation(api.todos.clearDone, { listId })).toBe(2);
    expect(texts(await query("all"))).toEqual(["eggs"]);
    await client.mutation(api.todos.remove, { id: milk }); // already gone: not an error
    pending.stop();
    done.stop();
    client.close();
  });
});

describe("offline", () => {
  it("works offline across reloads, then syncs the queue once", async () => {
    const shard = newShard();
    const idb = new IDBFactory(); // "the browser's IndexedDB": shared by every client below, like reloads of one page
    const errors: string[] = [];
    const device = (online: boolean) => {
      let emit: (e: ConnectivityEvent) => void = () => {};
      const client = testClient({
        defaultShard: shard,
        storage: indexedDbStorage({ name: "todo", schema, queries: { "lists:list": lists.list, "todos:list": todos.list }, indexedDB: idb, IDBKeyRange }),
        optimisticUpdates,
        connectivity: { isOnline: () => online, subscribe: (e) => ((emit = e), () => {}) },
        onError: (e) => errors.push(`${e.code}: ${e.message}`),
      });
      return { client, goOnline: () => emit("online") };
    };

    // 1. Online: open the app, create some data. Results and the rows behind them land in IndexedDB.
    const first = device(true);
    const listId = await first.client.mutation(api.lists.create, { name: "Trip" });
    const passport = await first.client.mutation(api.todos.add, { listId, text: "passport" });
    await first.client.mutation(api.todos.add, { listId, text: "tickets" });
    const all1 = watch(first.client, api.todos.list, { listId, filter: "all" });
    watch(first.client, api.lists.list, {});
    await expect.poll(() => texts(all1.last()?.value)).toEqual(["passport", "tickets"]);
    await first.client.flushStorage();
    first.client.close();

    // 2. Offline cold start: the list and a filter that was never opened are computed on the device.
    const second = device(false);
    const lists2 = watch(second.client, api.lists.list, {});
    const pending2 = watch(second.client, api.todos.list, { listId, filter: "pending" });
    const all2 = watch(second.client, api.todos.list, { listId, filter: "all" });
    await expect.poll(() => lists2.last()?.status).toBe("success");
    await expect.poll(() => pending2.last()?.status).toBe("success");
    expect(lists2.last()).toMatchObject({ source: "local", value: [{ name: "Trip" }] });
    expect(texts(pending2.last()!.value)).toEqual(["passport", "tickets"]);
    await expect.poll(() => all2.last()?.status).toBe("success");

    // 3. Offline edits: visible at once (optimistic), queued in IndexedDB. Neither reaches the server yet.
    second.client.mutation(api.todos.setDone, { id: passport, done: true }).catch(() => undefined);
    second.client.mutation(api.todos.add, { listId, text: "charger" }).catch(() => undefined);
    await expect.poll(() => texts(pending2.last()?.value)).toEqual(["tickets", "charger"]);
    expect(pending2.last()).toMatchObject({ optimistic: true });
    expect(second.client.connectionState().pendingMutations).toBe(2);
    expect(all2.last()!.value!.find((t) => t.text === "charger")!._id).toSatisfy(isPending);
    await second.client.flushStorage();
    second.client.close();

    // 4. Reload, still offline: the queued edits are still shown (the optimistic updates are registered by name).
    const third = device(false);
    const all3 = watch(third.client, api.todos.list, { listId, filter: "all" });
    await expect.poll(() => texts(all3.last()?.value)).toEqual(["passport", "tickets", "charger"]);
    expect(all3.last()!.value![0]).toMatchObject({ text: "passport", done: true });
    expect(third.client.connectionState().pendingMutations).toBe(2);
    const check = testClient({ defaultShard: shard });
    expect(texts(await check.query(api.todos.list, { listId, filter: "all" }))).toEqual(["passport", "tickets"]); // server: untouched

    // 5. Back online: the queue replays (same mutation ids, so once each) and the views converge on the server.
    third.goOnline();
    await expect.poll(() => third.client.connectionState().pendingMutations, { timeout: 10_000 }).toBe(0);
    const server = await check.query(api.todos.list, { listId, filter: "all" });
    expect(texts(server)).toEqual(["passport", "tickets", "charger"]);
    expect(server[0]).toMatchObject({ done: true });
    await expect.poll(() => all3.last()?.optimistic === false && !all3.last()?.source && all3.last()?.value?.length === 3).toBe(true);
    expect(all3.last()!.value).toEqual(server);
    expect(texts(await check.query(api.todos.list, { listId, filter: "pending" }))).toEqual(["tickets", "charger"]);

    third.client.close();
    check.close();
    expect(errors).toEqual([]);
  });
});
