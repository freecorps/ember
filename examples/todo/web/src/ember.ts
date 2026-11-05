import { EmberClient, type ConnectivityEvent } from "@freecorps/ember-client";
import { indexedDbStorage } from "@freecorps/ember-offline/indexeddb";
import schema from "../../ember/schema";
import * as lists from "../../ember/lists";
import * as todos from "../../ember/todos";
import { optimisticUpdates } from "./optimistic";

/**
 * Offline support is one option: a `StorageAdapter`. IndexedDB keeps
 *   - the queue of mutations that were not confirmed yet (so they survive a reload and are replayed, once each, when
 *     the connection is back),
 *   - the last result of every query, and the rows behind it,
 * and the queries registered here run on the device against those rows when there is no network (a cold start
 * offline shows the lists and every filter). They are the same `query()` definitions the server runs.
 */
const storage = indexedDbStorage({
  name: "ember-todo",
  schema,
  queries: { "lists:list": lists.list, "todos:list": todos.list },
});

// "Work offline" in the UI: the browser's own online/offline events work too (DevTools → Network → Offline).
let online = navigator.onLine;
let emit: ((e: ConnectivityEvent) => void) | undefined;
export const network = {
  isOnline: () => online,
  set(next: boolean) {
    online = next;
    emit?.(next ? "online" : "offline");
  },
};

export const client = new EmberClient({
  url: window.location.origin,
  defaultShard: "global:main",
  storage,
  optimisticUpdates,
  connectivity: {
    isOnline: () => online,
    subscribe(listener) {
      emit = listener;
      const on = () => network.set(true);
      const off = () => network.set(false);
      window.addEventListener("online", on);
      window.addEventListener("offline", off);
      return () => {
        emit = undefined;
        window.removeEventListener("online", on);
        window.removeEventListener("offline", off);
      };
    },
  },
});
