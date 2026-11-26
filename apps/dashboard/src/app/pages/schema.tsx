// Schema Explorer: the deployed schema (`/api/schema`, from the project Worker's config: no shard woken) — tables,
// document shape, indexes (kind, fields, sparse, search fields), `.replicated()`, shard routing. "Check <shard>"
// asks the shard picked in the top bar, on demand, for its row counts (`/api/data`) and its index state
// (`/api/status`: staged = still backfilling). A table opens in the Data Browser.

import { Fragment, useState } from "react";
import { href, useApi } from "../hooks.ts";
import { path } from "../api.ts";
import { fmtNum, text } from "../format.ts";
import { Badge, Empty, Loading, Mono, Problem } from "../ui.tsx";
import { shapeText } from "./data.tsx";
import type { SchemaBody, SchemaTable, StatusBody } from "./types.ts";

export function SchemaExplorer({ project, env, shard }: { project: string; env: string; shard: string }) {
  const schema = useApi<SchemaBody>(path("/api/schema", { project, env }));
  const [checked, setChecked] = useState(false);
  const counts = useApi<{ tables: Array<{ name: string; rows: number }> }>(checked ? path("/api/data", { project, env, shard }) : null);
  const status = useApi<StatusBody>(checked ? path("/api/status", { project, env, shard }) : null);
  const [q, setQ] = useState("");
  if (schema.error) return <Problem error={schema.error} onRetry={schema.reload} />;
  if (!schema.data) return <Loading lines={6} />;
  const rows = new Map((counts.data?.tables ?? []).map((t) => [t.name, t.rows]));
  const staged = status.data?.shards[0]?.staged ?? null;
  const tables = schema.data.tables.filter((t) => !q || t.name.toLowerCase().includes(q.toLowerCase()) || Object.keys(t.document.fields).some((f) => f.toLowerCase().includes(q.toLowerCase())));
  return (
    <div className="schema">
      <div className="toolbar">
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter tables and fields" aria-label="Filter tables and fields" />
        <span className="muted small">
          Schema <Mono>{schema.data.version}</Mono> · {fmtNum(schema.data.tables.length)} tables
        </span>
        <span className="spacer" />
        <button type="button" onClick={() => (checked ? (counts.reload(), status.reload()) : setChecked(true))} title="Asks this shard (wakes it): row counts and index state">
          {checked ? "Refresh" : "Check"} <Mono>{shard}</Mono>
        </button>
      </div>
      {checked && (counts.error || status.error) && <Problem error={(counts.error ?? status.error)!} />}
      {!tables.length ? (
        <Empty>No table matches.</Empty>
      ) : (
        tables.map((t) => <TableCard key={t.name} project={project} env={env} shard={shard} table={t} rows={checked ? (rows.get(t.name) ?? (counts.data ? 0 : null)) : null} staged={staged} />)
      )}
      {(schema.data.componentTables.length > 0 || (schema.data.internalTables?.length ?? 0) > 0) && (
        <section className="section" aria-labelledby="other-tables">
          <header className="section-head">
            <h2 id="other-tables">Component and internal tables</h2>
          </header>
          <p className="muted small">Read-only in the Data Browser; readable in SQL.</p>
          <p className="schema-names">
            {[...schema.data.componentTables, ...(schema.data.internalTables ?? [])].map((n) => (
              <Fragment key={n}>
                <Mono>{n}</Mono>{" "}
              </Fragment>
            ))}
          </p>
        </section>
      )}
    </div>
  );
}

function TableCard({ project, env, shard, table, rows, staged }: { project: string; env: string; shard: string; table: SchemaTable; rows: number | null; staged: Array<{ table: string; index: string }> | null }) {
  const routing = table.shard === null || table.shard === undefined ? null : typeof table.shard === "string" ? table.shard : text(table.shard, 80);
  const state = (index: string) => (staged === null ? null : staged.some((s) => s.table === table.name && s.index === index) ? "backfilling" : "ready");
  return (
    <section className="card-plain schema-table" aria-label={`Table ${table.name}`}>
      <header className="schema-head">
        <a href={href({ project, env, section: "data", shard, rest: [table.name] })} className="mono schema-name">
          {table.name}
        </a>
        {routing && <Badge title="Shard routing (.shard())">shard: {routing}</Badge>}
        {table.replicated && (
          <Badge tone="info" title="Written in global:main and copied to the shards of these kinds">
            replicated → {table.replicated.to ? table.replicated.to.join(", ") : "every shard"}
          </Badge>
        )}
        <span className="spacer" />
        {rows !== null && <span className="muted small">{fmtNum(rows)} rows on this shard</span>}
      </header>
      <div className="schema-cols">
        <div>
          <h3>Document</h3>
          <dl className="kv">
            <dt>
              <Mono>_id</Mono>
            </dt>
            <dd className="mono">id&lt;{table.name}&gt;</dd>
            <dt>
              <Mono>_creationTime</Mono>
            </dt>
            <dd className="mono">number</dd>
            {Object.entries(table.document.fields).map(([k, f]) => (
              <div key={k} className="kv-row">
                <dt>
                  <Mono>
                    {k}
                    {f.optional ? "?" : ""}
                  </Mono>
                </dt>
                <dd className="mono">{shapeText(f.shape)}</dd>
              </div>
            ))}
          </dl>
        </div>
        <div>
          <h3>Indexes</h3>
          <table aria-label={`Indexes of ${table.name}`}>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Kind</th>
                <th scope="col">Fields</th>
                <th scope="col">State</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="mono">by_creation_time</td>
                <td>db</td>
                <td className="mono">_creationTime</td>
                <td>{staged === null ? <span className="muted">—</span> : <Badge tone="ok">ready</Badge>}</td>
              </tr>
              {table.indexes.map((i) => {
                const st = state(i.name);
                return (
                  <tr key={i.name}>
                    <td className="mono">{i.name}</td>
                    <td>
                      {i.kind} {i.sparse && <Badge>sparse</Badge>}
                    </td>
                    <td className="mono">{i.searchField ? `${i.searchField}${i.filterFields?.length ? ` (filters: ${i.filterFields.join(", ")})` : ""}` : i.fields.join(", ")}</td>
                    <td>{st === null ? <span className="muted">—</span> : <Badge tone={st === "ready" ? "ok" : "warn"}>{st}</Badge>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {table.sql && (
            <p className="muted small schema-sql">
              SQLite: <Mono>{table.sql.table}</Mono> ({table.sql.columns.join(", ")})
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
