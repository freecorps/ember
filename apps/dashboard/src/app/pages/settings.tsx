// Settings of an environment: variable names (a secret's value only through an explicit, audited reveal that is
// never stored or logged), JWT key rotation (typed confirmation on protected environments), domains, and where
// bookmarks and restores live. Setting or removing a secret stays in the CLI (`ember env set`): the dashboard holds no
// token that can edit the Worker.

import { useState } from "react";
import { api, ApiError, path } from "../api.ts";
import { href, useApi, useSession } from "../hooks.ts";
import { Badge, ConfirmDialog, Dialog, Empty, Loading, Mono, Problem, Section, Table } from "../ui.tsx";
import type { Project } from "./types.ts";

export function Settings({ project, env }: { project: string; env: string }) {
  const s = useSession();
  const vars = useApi<{ vars: Array<{ name: string; managed: boolean }> }>(path("/api/env", { project, env }));
  const projects = useApi<{ projects: Project[] }>("/api/projects");
  const domains = projects.data?.projects.find((p) => p.name === project)?.domains.filter((d) => d.env === env) ?? [];
  const [revealing, setRevealing] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<{ name: string; value: string } | null>(null);
  const [rotating, setRotating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [q, setQ] = useState("");

  const reveal = async () => {
    if (!revealing) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ name: string; value: string }>("/api/env/reveal", { project, env, name: revealing });
      setRevealed({ name: r.name, value: r.value });
      setRevealing(null);
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };
  const rotate = async (typed: string | null) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ kids: string[] }>("/api/keys/rotate", { project, env, ...(typed ? { confirm: typed } : {}) });
      s.toast({ text: "JWT signing key rotated. Tokens already issued keep working until they expire.", detail: `new key ${r.kids.at(-1) ?? ""}` });
      setRotating(false);
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };
  const list = (vars.data?.vars ?? []).filter((v) => !q || v.name.toLowerCase().includes(q.toLowerCase()));

  return (
    <>
      <Section
        title="Environment variables"
        id="vars"
        actions={<input type="search" placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter variables" />}
      >
        <p className="muted small">
          Names of the project Worker's vars and secrets. Set or remove them with <code>ember env set NAME --env {env}</code> / <code>ember env rm</code>. Managed names (<code>EMBER_*</code>) are never revealed.
        </p>
        {vars.error ? (
          <Problem error={vars.error} onRetry={vars.reload} />
        ) : !vars.data ? (
          <Loading />
        ) : (
          <Table
            label="Environment variables"
            empty={q ? "No name matches." : "No variables."}
            cols={[{ h: "Name" }, { h: "" }, { h: "" }]}
            rows={list.map((v) => [
              <Mono>{v.name}</Mono>,
              v.managed ? <Badge>managed by ember</Badge> : "",
              s.isAdmin && !v.managed ? (
                <button type="button" className="small" onClick={() => (setError(null), setRevealing(v.name))}>
                  Reveal…
                </button>
              ) : null,
            ])}
          />
        )}
      </Section>

      <div className="grid2">
        <Section title="Keys" id="keys">
          <div className="card-plain">
            <p>
              <strong>JWT signing key.</strong> Retires the current key and mints a new one. Nobody is signed out: tokens already issued keep verifying until they expire (5 min), and the old key stays published for 30 days.
            </p>
            <p className="muted small">
              The files URL secret and the auth secret (which signs everyone out) rotate with <code>ember keys rotate --files</code> / <code>--auth-secret</code>: they need the account's API token. Run <code>ember keys rotate --jwt</code> later to refresh the JWKS embedded in the Worker (until then each instance fetches it once).
            </p>
            {s.isAdmin ? (
              <button type="button" className="danger-text" onClick={() => (setError(null), setRotating(true))}>
                Rotate JWT key…
              </button>
            ) : (
              <p className="muted small">Needs the admin role.</p>
            )}
          </div>
        </Section>
        <Section title="Domains" id="domains">
          {projects.error ? (
            <Problem error={projects.error} />
          ) : !projects.data ? (
            <Loading />
          ) : domains.length ? (
            <Table label="Domains" cols={[{ h: "Host" }, { h: "Kind" }]} rows={domains.map((d) => [<Mono>{d.host}</Mono>, d.kind])} />
          ) : (
            <Empty>
              No custom domain: the Worker answers on workers.dev. Add one with <code>ember domains add app.example.com --env {env}</code>.
            </Empty>
          )}
        </Section>
      </div>

      <Section title="Bookmarks and restore" id="restore">
        <p className="muted">
          Each shard records a bookmark at every deploy, migration and active hour. Open a shard in <a href={href({ project, env, section: "shards" })}>Shards</a> to record one now or restore it (undoable; restoring on a protected
          environment asks for the shard's name). Restoring every shard to a deploy at once is <code>ember restore --all --to deploy:&lt;version&gt;</code>.
        </p>
      </Section>

      <ConfirmDialog open={!!revealing} title={`Reveal ${revealing ?? ""}?`} confirmLabel="Reveal value" busy={busy} error={error} onCancel={() => setRevealing(null)} onConfirm={() => void reveal()}>
        <p>The value is shown once in this window and recorded in the audit log by name (never the value).</p>
      </ConfirmDialog>
      <Dialog open={!!revealed} onClose={() => setRevealed(null)} title={revealed ? <Mono>{revealed.name}</Mono> : ""}>
        {revealed && (
          <div className="dialog-body">
            <input className="mono revealed" readOnly value={revealed.value} aria-label={`Value of ${revealed.name}`} onFocus={(e) => e.currentTarget.select()} />
            <p className="muted small">Closing this window forgets the value.</p>
          </div>
        )}
      </Dialog>
      <ConfirmDialog open={rotating} title="Rotate the JWT signing key?" confirmLabel="Rotate key" danger expected={s.isProtected(env) ? `${project}/${env}` : null} busy={busy} error={error} onCancel={() => setRotating(false)} onConfirm={(typed) => void rotate(typed)}>
        <p>A new key signs every token from now on. Recorded in the audit log.</p>
      </ConfirmDialog>
    </>
  );
}
