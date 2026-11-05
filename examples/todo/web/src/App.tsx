import { useConnectionState, useMutation, useQuery } from "@freecorps/ember-react";
import { useState, type FormEvent } from "react";
import { api } from "../../ember/_generated/api";
import type { Id } from "../../ember/_generated/dataModel";
import { network } from "./ember";
import { isPending } from "./optimistic";

type Filter = "all" | "pending" | "done";

export function App() {
  const lists = useQuery(api.lists.list);
  const createList = useMutation(api.lists.create);
  const [selected, setSelected] = useState<Id<"lists"> | null>(null);
  const listId = selected ?? lists?.[0]?._id ?? null;

  const onNewList = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const input = e.currentTarget.elements.namedItem("name") as HTMLInputElement;
    if (!input.value.trim()) return;
    createList({ name: input.value }).then(setSelected, (err: Error) => alert(err.message));
    input.value = "";
  };

  return (
    <div className="app">
      <aside>
        <h1>Ember todo</h1>
        <ul>
          {lists?.map((l) => (
            <li key={l._id}>
              <button className={l._id === listId ? "active" : ""} onClick={() => setSelected(l._id)}>
                {l.name}
              </button>
            </li>
          ))}
        </ul>
        <form onSubmit={onNewList}>
          <input name="name" placeholder="New list" />
        </form>
        <Connection />
      </aside>
      <main>{listId ? <Todos key={listId} listId={listId} /> : <p className="empty">{lists ? "Create a list to start." : "Loading…"}</p>}</main>
    </div>
  );
}

/** Online state, the number of changes waiting to sync, and a switch to try the offline mode. */
function Connection() {
  const connection = useConnectionState();
  return (
    <div className="connection">
      <label>
        <input type="checkbox" checked={!connection.online} onChange={(e) => network.set(!e.target.checked)} /> Work offline
      </label>
      <small>
        {connection.connected ? "synced" : connection.online ? "connecting…" : "offline"}
        {connection.pendingMutations > 0 && ` · ${connection.pendingMutations} change${connection.pendingMutations > 1 ? "s" : ""} waiting`}
      </small>
    </div>
  );
}

function Todos({ listId }: { listId: Id<"lists"> }) {
  const [filter, setFilter] = useState<Filter>("all");
  const shown = useQuery(api.todos.list, { listId, filter }); // one live query per filter, served by an index
  const all = useQuery(api.todos.list, { listId, filter: "all" }); // (the same subscription when the filter is "all")
  const add = useMutation(api.todos.add);
  const setDone = useMutation(api.todos.setDone);
  const remove = useMutation(api.todos.remove);
  const clearDone = useMutation(api.todos.clearDone);
  const [text, setText] = useState("");

  const doneCount = all?.filter((t) => t.done).length ?? 0;
  const counts: Record<Filter, number> = { all: all?.length ?? 0, pending: (all?.length ?? 0) - doneCount, done: doneCount };
  const report = (err: Error) => console.warn(err.message);

  const onAdd = (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    add({ listId, text }).catch(report);
    setText("");
  };

  return (
    <>
      <header>
        <nav>
          {(["all", "pending", "done"] as const).map((f) => (
            <button key={f} className={f === filter ? "active" : ""} onClick={() => setFilter(f)}>
              {f} ({counts[f]})
            </button>
          ))}
        </nav>
        {doneCount > 0 && <button onClick={() => clearDone({ listId }).catch(report)}>Clear done</button>}
      </header>
      <ul className="todos">
        {shown?.map((t) => (
          <li key={t._id} className={isPending(t._id) ? "pending" : ""}>
            <label className={t.done ? "done" : ""}>
              <input type="checkbox" checked={t.done} disabled={isPending(t._id)} onChange={(e) => setDone({ id: t._id, done: e.target.checked }).catch(report)} /> {t.text}
            </label>
            <button aria-label="Delete" disabled={isPending(t._id)} onClick={() => remove({ id: t._id }).catch(report)}>
              ×
            </button>
          </li>
        ))}
        {shown?.length === 0 && <li className="empty">Nothing here.</li>}
      </ul>
      <form className="composer" onSubmit={onAdd}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="What needs doing?" autoFocus />
        <button disabled={!text.trim()}>Add</button>
      </form>
    </>
  );
}
