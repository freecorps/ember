// Optimistic updates for the todo mutations, shared by the UI and the tests (pure: no DOM, no React).
//
// They are registered by mutation name in `new EmberClient({ optimisticUpdates })`, so they also apply to mutations
// that were queued offline and restored after a reload: an edit made on a plane stays visible until it syncs.
import type { OptimisticLocalStore, OptimisticUpdate } from "@freecorps/ember-client";
import { api } from "../../ember/_generated/api";
import type { Doc, Id } from "../../ember/_generated/dataModel";

type Todo = Doc<"todos">;
type Filter = "all" | "pending" | "done";

const matches = (filter: Filter, todo: Todo) => filter === "all" || (filter === "done") === todo.done;

/** Rewrites every loaded `todos.list` of a list (one per filter the UI has opened). */
function edit(store: OptimisticLocalStore, listId: Id<"lists">, change: (todos: Todo[], filter: Filter) => Todo[]) {
  for (const { args, value } of store.getAllQueries(api.todos.list)) {
    if (value && args.listId === listId) store.setQuery(api.todos.list, args, change(value, args.filter));
  }
}

const find = (store: OptimisticLocalStore, id: string) =>
  store.getAllQueries(api.todos.list).flatMap((q) => q.value ?? []).find((t) => t._id === id);

export const optimisticUpdates: Record<string, OptimisticUpdate> = {
  "todos:add": (store, { listId, text }: { listId: Id<"lists">; text: string }) => {
    const todo: Todo = { _id: `optimistic:${crypto.randomUUID()}` as Id<"todos">, _creationTime: Date.now(), listId, text: text.trim(), done: false };
    edit(store, listId, (todos, filter) => (matches(filter, todo) ? [...todos, todo] : todos));
  },

  "todos:setDone": (store, { id, done }: { id: Id<"todos">; done: boolean }) => {
    const todo = find(store, id);
    if (!todo) return;
    const next = { ...todo, done };
    // Moves the todo between the "pending" and "done" views, and updates it in place in "all".
    edit(store, todo.listId, (todos, filter) => {
      const others = todos.filter((t) => t._id !== id);
      return matches(filter, next) ? [...others, next].sort((a, b) => a._creationTime - b._creationTime) : others;
    });
  },

  "todos:remove": (store, { id }: { id: Id<"todos"> }) => {
    const todo = find(store, id);
    if (todo) edit(store, todo.listId, (todos) => todos.filter((t) => t._id !== id));
  },
};

export const isPending = (id: string) => id.startsWith("optimistic:");
