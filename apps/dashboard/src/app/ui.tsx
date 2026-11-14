// Shared UI pieces. Everything that comes from a project (documents, names, errors) is rendered as text: no
// dangerouslySetInnerHTML anywhere, no user-controlled URLs in href except the project's own https URL.

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ApiError } from "./api.ts";

export interface Col {
  h: string;
  num?: boolean;
  /** Extra class for the column cells. */
  cls?: string;
}

export function Table({
  cols,
  rows,
  empty,
  onRow,
  selected,
  label,
}: {
  cols: Col[];
  rows: ReactNode[][];
  empty?: ReactNode;
  onRow?: (i: number) => void;
  selected?: number | null;
  label?: string;
}) {
  if (!rows.length) return <Empty>{empty ?? "Nothing here yet."}</Empty>;
  return (
    <div className="table-wrap">
      <table aria-label={label}>
        <thead>
          <tr>
            {cols.map((c, i) => (
              <th key={i} className={[c.num ? "num" : "", c.cls ?? ""].join(" ").trim() || undefined} scope="col">
                {c.h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr
              key={i}
              className={[onRow ? "clickable" : "", selected === i ? "selected" : ""].join(" ").trim() || undefined}
              {...(onRow
                ? {
                    tabIndex: 0,
                    onClick: () => onRow(i),
                    onKeyDown: (e: React.KeyboardEvent) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onRow(i);
                      } else if (e.key === "ArrowDown" || e.key === "j") {
                        e.preventDefault();
                        ((e.currentTarget as HTMLElement).nextElementSibling as HTMLElement | null)?.focus();
                      } else if (e.key === "ArrowUp" || e.key === "k") {
                        e.preventDefault();
                        ((e.currentTarget as HTMLElement).previousElementSibling as HTMLElement | null)?.focus();
                      }
                    },
                  }
                : {})}
            >
              {r.map((c, j) => (
                <td key={j} className={[cols[j]?.num ? "num" : "", cols[j]?.cls ?? ""].join(" ").trim() || undefined}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Loading({ lines = 3 }: { lines?: number }) {
  return (
    <div className="loading" role="status" aria-live="polite">
      <span className="sr-only">Loading…</span>
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="skeleton" />
      ))}
    </div>
  );
}

const HINTS: Record<string, ReactNode> = {
  metrics_unavailable: (
    <>
      Analytics is not connected. Create an API token with <b>Account Analytics: Read</b>, then run <code>EMBER_ANALYTICS_TOKEN=… ember dashboard deploy</code>.
    </>
  ),
  no_admin_token: (
    <>
      The dashboard has no admin token for this project. Run <code>EMBER_ADMIN_TOKEN=… ember dashboard deploy</code> with the project's admin token.
    </>
  ),
  admin_disabled: <>The project has no <code>EMBER_ADMIN_TOKEN</code> secret, so its admin endpoints are off. Redeploy it with one.</>,
  forbidden: <>Your role is read-only. Ask an admin to add your email to <code>DASHBOARD_ADMINS</code>.</>,
  bad_csrf: <>Your session changed. Reload the page and try again.</>,
};

export function Problem({ error, onRetry }: { error: ApiError; onRetry?: () => void }) {
  if (error.code === "runtime_outdated") {
    return (
      <div className="notice warn" role="alert">
        <strong>Update the runtime</strong>
        <p>{error.message}</p>
        <p className="muted">
          Run <code>npm i @freecorps/ember-runtime@latest</code> (or update <code>@freecorps/ember-cli</code>) in the project, then <code>ember deploy</code>. The rest of the dashboard keeps working.
        </p>
      </div>
    );
  }
  return (
    <div className="notice bad" role="alert">
      <strong>{error.code}</strong>
      <p>{error.message}</p>
      {HINTS[error.code] && <p className="muted">{HINTS[error.code]}</p>}
      {onRetry && (
        <button type="button" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function Section({ title, actions, children, id }: { title: ReactNode; actions?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section className="section" aria-labelledby={id}>
      <header className="section-head">
        <h2 id={id}>{title}</h2>
        {actions && <div className="actions">{actions}</div>}
      </header>
      {children}
    </section>
  );
}

export function Stat({ label, value, tone, hint }: { label: string; value: ReactNode; tone?: "ok" | "bad" | "warn" | undefined; hint?: ReactNode }) {
  return (
    <div className={`stat${tone ? ` ${tone}` : ""}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  );
}

export function Badge({ tone, children, title }: { tone?: "ok" | "bad" | "warn" | "info" | undefined; children: ReactNode; title?: string | undefined }) {
  return (
    <span className={`badge${tone ? ` ${tone}` : ""}`} {...(title ? { title } : {})}>
      {children}
    </span>
  );
}

/** A horizontal bar for `value / max` (width set through the CSSOM: allowed by the strict CSP). */
export function Meter({ value, max, tone }: { value: number; max: number; tone?: "bad" | "warn" | undefined }) {
  const pct = max > 0 ? Math.max(1, Math.min(100, (value / max) * 100)) : 0;
  return (
    <span className={`meter${tone ? ` ${tone}` : ""}`} aria-hidden="true">
      <span style={{ width: `${pct}%` }} />
    </span>
  );
}

export function Mono({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <code className="mono" {...(title ? { title } : {})}>
      {children}
    </code>
  );
}

/** Pretty JSON of user data, as text. */
export function JsonView({ value }: { value: unknown }) {
  return <pre className="json">{JSON.stringify(value, null, 2)}</pre>;
}

// ------------------------------------------------------------------------------------------- dialogs

/** A modal on the native <dialog> (focus trap, Esc, inert background come from the browser). */
export function Dialog({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className={wide ? "wide" : undefined} onClose={onClose} onCancel={onClose} aria-labelledby="dialog-title">
      {open && (
        <>
          <header className="dialog-head">
            <h2 id="dialog-title">{title}</h2>
            <button type="button" className="icon" onClick={onClose} aria-label="Close">
              ×
            </button>
          </header>
          {children}
        </>
      )}
    </dialog>
  );
}

/**
 * Confirmation for a write. `expected` set → the action is destructive on a protected environment: the button stays
 * disabled until the text is typed exactly (the Worker checks it again).
 */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  danger,
  expected,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  expected?: string | null;
  busy?: boolean;
  error?: ApiError | null;
  onCancel: () => void;
  onConfirm: (typed: string | null) => void;
}) {
  const [typed, setTyped] = useState("");
  useEffect(() => {
    if (open) setTyped("");
  }, [open]);
  const ok = !expected || typed === expected;
  return (
    <Dialog open={open} onClose={onCancel} title={title}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (ok && !busy) onConfirm(expected ? typed : null);
        }}
      >
        <div className="dialog-body">
          {children}
          {expected && (
            <label className="field">
              <span>
                Type <code className="mono">{expected}</code> to confirm
              </span>
              <input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus autoComplete="off" spellCheck={false} aria-label={`Type ${expected} to confirm`} />
            </label>
          )}
          {error && <Problem error={error} />}
        </div>
        <footer className="dialog-foot">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className={danger ? "danger" : "primary"} disabled={!ok || busy} {...(!expected ? { autoFocus: true } : {})}>
            {busy ? "Working…" : confirmLabel}
          </button>
        </footer>
      </form>
    </Dialog>
  );
}

export interface ToastItem {
  id: number;
  kind: "ok" | "bad";
  text: string;
  detail?: string;
}

export function Toasts({ items, dismiss }: { items: ToastItem[]; dismiss: (id: number) => void }) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <div>
            <div>{t.text}</div>
            {t.detail && <code className="mono small">{t.detail}</code>}
          </div>
          <button type="button" className="icon" onClick={() => dismiss(t.id)} aria-label="Dismiss">
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
