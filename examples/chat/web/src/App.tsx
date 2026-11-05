import { useConnectionState, useMutation, usePaginatedQuery, useQuery } from "@freecorps/ember-react";
import { useState, type FormEvent } from "react";
import { api } from "../../ember/_generated/api";
import type { Id } from "../../ember/_generated/dataModel";
import { addMessageOptimistically, isOptimistic } from "./optimistic";

export function App() {
  const rooms = useQuery(api.rooms.list); // live: a room created anywhere appears here
  const createRoom = useMutation(api.rooms.create);
  const [selected, setSelected] = useState<Id<"rooms"> | null>(null);
  const [nickname, setNickname] = useState(() => localStorage.getItem("nickname") ?? "");
  const connection = useConnectionState();
  const roomId = selected ?? rooms?.[0]?._id ?? null;

  const onNewRoom = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const input = e.currentTarget.elements.namedItem("name") as HTMLInputElement;
    if (!input.value.trim()) return;
    createRoom({ name: input.value }).then(setSelected, (err: Error) => alert(err.message));
    input.value = "";
  };

  return (
    <div className="app">
      <aside>
        <h1>Ember chat</h1>
        <input
          placeholder="Your nickname"
          value={nickname}
          onChange={(e) => {
            setNickname(e.target.value);
            localStorage.setItem("nickname", e.target.value);
          }}
        />
        <ul>
          {rooms?.map((r) => (
            <li key={r._id}>
              <button className={r._id === roomId ? "active" : ""} onClick={() => setSelected(r._id)}>
                # {r.name}
              </button>
            </li>
          ))}
        </ul>
        <form onSubmit={onNewRoom}>
          <input name="name" placeholder="New room" />
        </form>
        <small>
          {connection.connected ? "live" : connection.online ? "connecting…" : "offline"}
          {connection.pendingMutations > 0 && ` · ${connection.pendingMutations} sending`}
        </small>
      </aside>
      <main>{roomId ? <Room key={roomId} roomId={roomId} author={nickname} /> : <p className="empty">Create a room to start.</p>}</main>
    </div>
  );
}

function Room({ roomId, author }: { roomId: Id<"rooms">; author: string }) {
  const room = useQuery(api.rooms.get, { roomId });
  // Newest first, 20 at a time. `loadMore` adds the next page; every page is its own live query.
  const { results, status, loadMore } = usePaginatedQuery(api.messages.list, { roomId }, { initialNumItems: 20 });
  const send = useMutation(api.messages.send).withOptimisticUpdate(addMessageOptimistically);
  const [text, setText] = useState("");
  const [search, setSearch] = useState("");
  const term = search.trim();
  const found = useQuery(api.messages.search, term ? { roomId, text: term } : "skip");

  const onSend = (e: FormEvent) => {
    e.preventDefault();
    const body = text.trim();
    if (!body) return;
    setText("");
    send({ roomId, author, body }).catch((err: Error) => alert(err.message));
  };

  // Search results (best match first) replace the history while the box is filled in. The history is newest first;
  // the column shows it reversed, so the newest message sits at the bottom.
  const shown = found ?? [...results].reverse();
  return (
    <>
      <header>
        <h2># {room?.name}</h2>
        <input type="search" placeholder="Search this room" value={search} onChange={(e) => setSearch(e.target.value)} />
      </header>
      <div className="messages">
        {shown.map((m) => (
          <p key={m._id} className={isOptimistic(m._id) ? "pending" : ""}>
            <b>{m.author}</b> {m.body}
          </p>
        ))}
        {status === "LoadingFirstPage" && <p className="empty">Loading…</p>}
        {!found && status === "CanLoadMore" && <button onClick={() => loadMore(20)}>Load older messages</button>}
      </div>
      <form className="composer" onSubmit={onSend}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder={`Message #${room?.name ?? ""}`} autoFocus />
        <button disabled={!text.trim()}>Send</button>
      </form>
    </>
  );
}
