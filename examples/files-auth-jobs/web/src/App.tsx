import { useEmberClient, useMutation, useQuery } from "@freecorps/ember-react";
import { useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { api } from "../../ember/_generated/api";
import type { FileId } from "../../ember/_generated/dataModel";
import { auth } from "./ember";

export function App() {
  const signedIn = useSyncExternalStore(auth.subscribe, () => auth.signedIn);
  const me = useQuery(api.users.me); // what `ctx.auth.getUserIdentity()` sees on the server
  return (
    <main>
      <header>
        <h1>Ember uploads</h1>
        {me && (
          <span>
            {me.name ?? me.email} · <button onClick={() => auth.signOut()}>Sign out</button>
          </span>
        )}
      </header>
      {signedIn ? <Uploads /> : <SignIn />}
    </main>
  );
}

function SignIn() {
  const [mode, setMode] = useState<"in" | "up">("in");
  const [error, setError] = useState("");

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const email = String(f.get("email")), password = String(f.get("password"));
    setError("");
    try {
      if (mode === "in") await auth.signIn({ email, password });
      else await auth.signUp({ email, password, name: String(f.get("name") || email.split("@")[0]) });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <form className="card" onSubmit={onSubmit}>
      <h2>{mode === "in" ? "Sign in" : "Create an account"}</h2>
      {mode === "up" && <input name="name" placeholder="Name" />}
      <input name="email" type="email" placeholder="Email" required />
      <input name="password" type="password" placeholder="Password (8+ characters)" minLength={8} required />
      {error && <p className="error">{error}</p>}
      <button>{mode === "in" ? "Sign in" : "Sign up"}</button>
      <button type="button" className="link" onClick={() => setMode(mode === "in" ? "up" : "in")}>
        {mode === "in" ? "No account? Sign up" : "Have an account? Sign in"}
      </button>
    </form>
  );
}

function Uploads() {
  const client = useEmberClient();
  const uploads = useQuery(api.files.list); // live: a row flips from "processing" to "ready" when the job finishes
  const save = useMutation(api.files.save);
  const remove = useMutation(api.files.remove);
  const input = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState("");

  const onPick = async (file: File | undefined) => {
    if (!file) return;
    setError("");
    try {
      // 1. ask `generateUploadUrl` for a ticket, 2. PUT the bytes to R2 (presigned URL), 3. record the upload,
      // which schedules the job that processes it.
      const stored = await client.files.upload(file, {
        mutation: api.files.generateUploadUrl,
        onProgress: (p) => setProgress(p.loaded / p.total),
      });
      await save({ storageId: stored.storageId as FileId, name: file.name });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setProgress(null);
      if (input.current) input.current.value = "";
    }
  };

  return (
    <>
      <div className="card">
        <input ref={input} type="file" onChange={(e) => onPick(e.target.files?.[0])} />
        {progress !== null && <progress value={progress} />}
        {error && <p className="error">{error}</p>}
        <small>Up to 5 MiB. Text files get line and word counts, PNGs their size; anything else is stored as is.</small>
      </div>
      <ul className="uploads">
        {uploads?.map((u) => (
          <li key={u._id}>
            <div>
              {u.url ? <a href={client.files.url(u.url)} target="_blank" rel="noreferrer">{u.name}</a> : u.name}
              <span className={`badge ${u.status}`}>{u.status}</span>
              <small>{u.size < 1024 ? `${u.size} B` : `${(u.size / 1024).toFixed(1)} KiB`}</small>
              <button aria-label="Delete" onClick={() => remove({ id: u._id }).catch((e: Error) => setError(e.message))}>×</button>
            </div>
            {u.meta && <small>{describe(u.meta)}</small>}
            {u.error && <small className="error">{u.error}</small>}
          </li>
        ))}
        {uploads?.length === 0 && <li className="empty">No uploads yet.</li>}
      </ul>
    </>
  );
}

type Meta = NonNullable<NonNullable<ReturnType<typeof useQuery<typeof api.files.list>>>[number]["meta"]>;
const describe = (m: Meta) =>
  m.kind === "text" ? `${m.lines} lines, ${m.words} words — “${m.preview}”` : m.kind === "image" ? `${m.width}×${m.height} px` : "binary file";
