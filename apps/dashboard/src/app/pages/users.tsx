// Users and sessions of the project's Auth Durable Object: search, see a user's sessions (never their tokens) and
// revoke one or all. Revoking deletes the sessions (no new token is issued for them) and cuts the user's live sockets
// on the catalog's shards; a JWT already issued expires within minutes.

import { useEffect, useState } from "react";
import { api, ApiError, path } from "../api.ts";
import { ago, fmtNum, fmtTime } from "../format.ts";
import { useApi, useSession } from "../hooks.ts";
import { Badge, ConfirmDialog, Dialog, Loading, Mono, Problem, Table } from "../ui.tsx";

interface User {
  id: string;
  email: string | null;
  name: string | null;
  emailVerified: boolean;
  createdAt: number | null;
}

interface Session {
  id: string;
  userId: string;
  createdAt: number | null;
  expiresAt: number | null;
  ipAddress: string | null;
  userAgent: string | null;
  active: boolean;
}

export function Users({ project, env }: { project: string; env: string }) {
  const [draft, setDraft] = useState("");
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => {
      setQ(draft.trim());
      setCursor(0);
    }, 250);
    return () => clearTimeout(t);
  }, [draft]);
  const users = useApi<{ users: User[]; total: number; next: number | null }>(path("/api/users", { project, env, q, cursor: cursor || null }));
  const [open, setOpen] = useState<User | null>(null);
  return (
    <>
      <div className="toolbar">
        <input type="search" placeholder="Search email or name…" value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="Search users" />
        {users.data && <span className="muted small">{fmtNum(users.data.total)} users</span>}
        <span className="spacer" />
        <button type="button" onClick={users.reload}>
          Refresh
        </button>
      </div>
      {users.error ? (
        <Problem error={users.error} onRetry={users.reload} />
      ) : !users.data ? (
        <Loading lines={6} />
      ) : (
        <>
          <Table
            label="Users"
            empty={q ? "No user matches." : "No users yet."}
            onRow={(i) => setOpen(users.data!.users[i]!)}
            cols={[{ h: "Email" }, { h: "Name" }, { h: "Verified" }, { h: "Created" }, { h: "Id" }]}
            rows={users.data.users.map((u) => [
              u.email ?? "—",
              u.name ?? "—",
              u.emailVerified ? <Badge tone="ok">verified</Badge> : <Badge>no</Badge>,
              <span title={fmtTime(u.createdAt)}>{ago(u.createdAt)}</span>,
              <Mono>{u.id}</Mono>,
            ])}
          />
          <div className="toolbar">
            <span className="spacer" />
            <button type="button" disabled={!cursor} onClick={() => setCursor(0)}>
              First page
            </button>
            <button type="button" disabled={users.data.next === null} onClick={() => setCursor(users.data!.next ?? 0)}>
              Next →
            </button>
          </div>
        </>
      )}
      {open && <SessionsDialog key={open.id} project={project} env={env} user={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function SessionsDialog({ project, env, user, onClose }: { project: string; env: string; user: User; onClose: () => void }) {
  const s = useSession();
  const sessions = useApi<{ sessions: Session[] }>(path("/api/users/sessions", { project, env, user: user.id }));
  const [revoke, setRevoke] = useState<{ sessionId: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const run = async () => {
    if (!revoke) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ value: { revoked: number; sockets: number } }>("/api/users/revoke", { project, env, userId: user.id, ...(revoke.sessionId ? { sessionId: revoke.sessionId } : {}) });
      s.toast({ text: `Ended ${r.value.revoked} session${r.value.revoked === 1 ? "" : "s"} of ${user.email ?? user.id}; ${r.value.sockets} live connection${r.value.sockets === 1 ? "" : "s"} cut` });
      setRevoke(null);
      sessions.reload();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Dialog open={!revoke} onClose={onClose} title={user.email ?? user.id} wide>
        <div className="dialog-body">
          <dl className="kv">
            <dt>Id</dt>
            <dd className="mono">{user.id}</dd>
            <dt>Name</dt>
            <dd>{user.name ?? "—"}</dd>
            <dt>Created</dt>
            <dd>{fmtTime(user.createdAt)}</dd>
          </dl>
          <h3>Sessions</h3>
          {sessions.error ? (
            <Problem error={sessions.error} />
          ) : !sessions.data ? (
            <Loading />
          ) : (
            <Table
              label="Sessions"
              empty="No sessions."
              cols={[{ h: "Started" }, { h: "Expires" }, { h: "IP" }, { h: "Device" }, { h: "" }, { h: "" }]}
              rows={sessions.data.sessions.map((x) => [
                <span title={fmtTime(x.createdAt)}>{ago(x.createdAt)}</span>,
                fmtTime(x.expiresAt),
                <Mono>{x.ipAddress ?? "—"}</Mono>,
                <span className="muted small" title={x.userAgent ?? ""}>
                  {(x.userAgent ?? "—").slice(0, 60)}
                </span>,
                x.active ? <Badge tone="ok">active</Badge> : <Badge>expired</Badge>,
                s.isAdmin ? (
                  <button type="button" className="small" onClick={() => (setError(null), setRevoke({ sessionId: x.id }))}>
                    Revoke
                  </button>
                ) : null,
              ])}
            />
          )}
        </div>
        {s.isAdmin && (
          <footer className="dialog-foot">
            <span className="spacer" />
            <button type="button" className="danger-text" disabled={!sessions.data?.sessions.length} onClick={() => (setError(null), setRevoke({ sessionId: null }))}>
              Sign out everywhere…
            </button>
          </footer>
        )}
      </Dialog>
      <ConfirmDialog
        open={!!revoke}
        title={revoke?.sessionId ? "Revoke this session?" : `Sign ${user.email ?? user.id} out everywhere?`}
        confirmLabel={revoke?.sessionId ? "Revoke session" : "Sign out everywhere"}
        danger
        busy={busy}
        error={error}
        onCancel={() => setRevoke(null)}
        onConfirm={() => void run()}
      >
        <p>
          The session{revoke?.sessionId ? "" : "s"} end now and their live connections are cut on the shards in the catalog. A token issued in the last minutes stays valid until it expires (5 min) elsewhere. Recorded in the audit log.
        </p>
      </ConfirmDialog>
    </>
  );
}
