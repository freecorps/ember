// Command palette (⌘K / Ctrl+K): jump to a project's environment, a section, a declarative screen, a shard, a table,
// a function or a user. A modal <dialog> with a combobox over a listbox (arrow keys, Enter, Esc; the mouse works too).
//
// What it reads, only while open: the projects the shell already has; in an environment, its sections, the screen
// specs, the tables (`/api/schema`) and the functions (`/api/fn/list`) — answered by the project's Worker from its
// config, no shard woken —, the shard catalog (D1, debounced) and, from 3 typed characters, users (the Auth DO).
// A source that fails (an older runtime, no auth) just adds nothing.

import { useEffect, useMemo, useRef, useState } from "react";
import { path } from "./api.ts";
import { href, navigate, useApi } from "./hooks.ts";
import type { Project, ShardRow } from "./pages/types.ts";

export interface PaletteItem {
  id: string;
  group: PaletteGroup;
  label: string;
  hint?: string;
  href: string;
}

export const PALETTE_GROUPS = [
  "Environments",
  "Sections",
  "Screens",
  "Shards",
  "Tables",
  "Functions",
  "Users",
] as const;
export type PaletteGroup = (typeof PALETTE_GROUPS)[number];

/** Results per group, and in all. */
const PER_GROUP = 8;
const MAX_RESULTS = 40;
/** Users are searched (in the Auth DO) from this many typed characters on. */
export const USER_SEARCH_MIN = 3;
const DEBOUNCE_MS = 200;

/**
 * Items whose label (or hint) contains every typed word, case-insensitive; ranked by group, then by where the first
 * word matched (a prefix first), then by length. Pure: the browser test and the unit tests share it.
 */
export function rankItems(items: PaletteItem[], query: string): PaletteItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const scored: Array<{ item: PaletteItem; at: number }> = [];
  for (const item of items) {
    const text = `${item.label} ${item.hint ?? ""}`.toLowerCase();
    if (!words.every((w) => text.includes(w))) continue;
    scored.push({
      item,
      at: words.length ? item.label.toLowerCase().indexOf(words[0]!) : 0,
    });
  }
  const order = (g: PaletteGroup) => PALETTE_GROUPS.indexOf(g);
  scored.sort(
    (a, b) =>
      order(a.item.group) - order(b.item.group) ||
      (a.at < 0 ? 1e6 : a.at) - (b.at < 0 ? 1e6 : b.at) ||
      a.item.label.length - b.item.label.length,
  );
  const per = new Map<PaletteGroup, number>();
  const out: PaletteItem[] = [];
  for (const { item } of scored) {
    const n = per.get(item.group) ?? 0;
    if (n >= PER_GROUP) continue;
    per.set(item.group, n + 1);
    out.push(item);
    if (out.length >= MAX_RESULTS) break;
  }
  return out;
}

interface Spec {
  key: string;
  label?: string;
  tabs?: Array<{ id: string; label?: string }>;
}

interface PaletteProps {
  open: boolean;
  onClose: () => void;
  projects: Project[] | null;
  /** The environment the route is in (null: the projects list or the audit log). */
  scope: { project: string; env: string } | null;
  sections: ReadonlyArray<{ id: string; label: string }>;
  /** The route's shard (tables and screens open there). */
  shard: string;
}

export function Palette(props: PaletteProps) {
  const { open, onClose } = props;
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="palette"
      aria-label="Command palette"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        // A click on the backdrop (the dialog element itself, outside its content) closes it.
        if (e.target === ref.current) onClose();
      }}
    >
      {/* Mounted while open only: each opening starts empty, and nothing is fetched while closed. */}
      {open && <PaletteBody {...props} />}
    </dialog>
  );
}

function PaletteBody({
  onClose,
  projects,
  scope,
  sections,
  shard,
}: PaletteProps) {
  const input = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  const [term, setTerm] = useState("");
  const [active, setActive] = useState(0);
  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    const t = setTimeout(() => setTerm(q.trim()), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [q]);

  const inEnv = scope;
  const specs = useApi<{ dashboards: Spec[] }>(
    inEnv ? path("/api/dash/specs", inEnv) : null,
  );
  const schema = useApi<{ tables: Array<{ name: string }> }>(
    inEnv ? path("/api/schema", inEnv) : null,
  );
  const fns = useApi<{ functions: Array<{ name: string; type: string }> }>(
    inEnv ? path("/api/fn/list", inEnv) : null,
  );
  const shards = useApi<{ shards: ShardRow[] }>(
    inEnv ? path("/api/shards", { ...inEnv, q: term }) : null,
  );
  const users = useApi<{
    users: Array<{ id: string; email: string | null; name: string | null }>;
  }>(
    inEnv && term.length >= USER_SEARCH_MIN
      ? path("/api/users", { ...inEnv, q: term, limit: 8 })
      : null,
  );

  const items = useMemo(() => {
    const out: PaletteItem[] = [];
    for (const p of projects ?? [])
      for (const e of p.envs)
        out.push({
          id: `env:${p.name}/${e.env}`,
          group: "Environments",
          label: `${p.name}/${e.env}`,
          hint: e.worker,
          href: href({ project: p.name, env: e.env, section: "health" }),
        });
    if (scope) {
      const s = scope;
      for (const sec of sections)
        out.push({
          id: `sec:${sec.id}`,
          group: "Sections",
          label: sec.label,
          hint: `${s.project}/${s.env}`,
          href: href({ ...s, section: sec.id }),
        });
      for (const d of specs.data?.dashboards ?? []) {
        const app = d.key === "";
        const name = app ? "App" : (d.label ?? d.key);
        const base = (tab?: string) =>
          app
            ? href({ ...s, section: "app", shard, rest: tab ? [tab] : [] })
            : href({
                ...s,
                section: "components",
                shard,
                rest: [d.key, ...(tab ? [tab] : [])],
              });
        out.push({
          id: `screen:${d.key}`,
          group: "Screens",
          label: name,
          hint: app ? "app screens" : `component ${d.key}`,
          href: base(),
        });
        for (const t of d.tabs ?? [])
          out.push({
            id: `screen:${d.key}/${t.id}`,
            group: "Screens",
            label: `${name} › ${t.label ?? t.id}`,
            hint: app ? "app screens" : `component ${d.key}`,
            href: base(t.id),
          });
      }
      for (const r of shards.data?.shards ?? [])
        out.push({
          id: `shard:${r.shard}`,
          group: "Shards",
          label: r.shard,
          href: href({ ...s, section: "shards", shard: r.shard }),
        });
      // A full shard name the catalog has not heard of can still be opened (as the shard picker does).
      if (
        term.includes(":") &&
        !/\s/.test(term) &&
        !(shards.data?.shards ?? []).some((r) => r.shard === term)
      )
        out.push({
          id: `shard:${term}`,
          group: "Shards",
          label: term,
          hint: "open this shard",
          href: href({ ...s, section: "shards", shard: term }),
        });
      for (const t of schema.data?.tables ?? [])
        out.push({
          id: `table:${t.name}`,
          group: "Tables",
          label: t.name,
          hint: `data on ${shard}`,
          href: href({ ...s, section: "data", shard, rest: [t.name] }),
        });
      for (const f of fns.data?.functions ?? [])
        out.push({
          id: `fn:${f.name}`,
          group: "Functions",
          label: f.name,
          hint: f.type,
          href: href({ ...s, section: "functions", shard: f.name }),
        });
      for (const u of users.data?.users ?? [])
        out.push({
          id: `user:${u.id}`,
          group: "Users",
          label: u.email ?? u.name ?? u.id,
          hint: u.name ?? u.id,
          href: href({ ...s, section: "users", shard: u.email ?? u.name ?? u.id }),
        });
    }
    return out;
  }, [
    projects,
    scope,
    sections,
    specs.data,
    shards.data,
    schema.data,
    fns.data,
    users.data,
    shard,
    term,
  ]);

  const results = useMemo(() => rankItems(items, q), [items, q]);
  const pick = Math.min(active, Math.max(0, results.length - 1));
  // The active option stays visible while the arrows move past the list's edge (focus stays in the input).
  useEffect(() => {
    document.getElementById(`palette-${pick}`)?.scrollIntoView({ block: "nearest" });
  }, [pick, results]);
  const go = (item: PaletteItem | undefined) => {
    if (!item) return;
    onClose();
    // The route already shown navigates again too (its page reloads), instead of a hash that does not change.
    navigate(item.href);
  };
  const loading =
    specs.loading ||
    schema.loading ||
    fns.loading ||
    shards.loading ||
    users.loading;
  let last: PaletteGroup | null = null;
  return (
    <div className="palette-body">
      <input
        ref={input}
        role="combobox"
        aria-expanded="true"
        aria-controls="palette-list"
        aria-autocomplete="list"
        aria-activedescendant={results[pick] ? `palette-${pick}` : undefined}
        aria-label="Go to"
        placeholder={
          scope
            ? `Go to a section, screen, shard, table, function or user of ${scope.project}/${scope.env}…`
            : "Go to a project environment…"
        }
        value={q}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => {
          setQ(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive(Math.min(pick + 1, results.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive(Math.max(pick - 1, 0));
          } else if (e.key === "Home") {
            e.preventDefault();
            setActive(0);
          } else if (e.key === "End") {
            e.preventDefault();
            setActive(Math.max(0, results.length - 1));
          } else if (e.key === "Enter") {
            e.preventDefault();
            go(results[pick]);
          }
        }}
      />
      <ul id="palette-list" role="listbox" aria-label="Results">
        {!results.length ? (
          <li className="muted" role="presentation">
            {loading
              ? "Searching…"
              : q
                ? "Nothing matches."
                : "Type to search."}
          </li>
        ) : (
          results.map((r, i) => {
            const head = r.group !== last;
            last = r.group;
            return [
              head ? (
                <li
                  key={`g:${r.group}`}
                  className="palette-group"
                  role="presentation"
                >
                  {r.group}
                </li>
              ) : null,
              <li
                key={r.id}
                id={`palette-${i}`}
                role="option"
                aria-selected={i === pick}
                className={i === pick ? "active" : undefined}
                onMouseMove={() => i !== pick && setActive(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  go(r);
                }}
              >
                <span className="palette-label">{r.label}</span>
                {r.hint && <span className="palette-hint">{r.hint}</span>}
              </li>,
            ];
          })
        )}
      </ul>
      <footer className="palette-foot muted small">
        <span>
          <kbd>↑</kbd> <kbd>↓</kbd> move
        </span>
        <span>
          <kbd>Enter</kbd> open
        </span>
        <span>
          <kbd>Esc</kbd> close
        </span>
      </footer>
    </div>
  );
}

/** ⌘K (macOS) / Ctrl+K anywhere, even while typing: the browser's own Ctrl+K (search bar) is taken over on the page. */
export function usePaletteShortcut(open: () => void): void {
  const ref = useRef(open);
  ref.current = open;
  useEffect(() => {
    const f = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.altKey &&
        !e.shiftKey &&
        e.key.toLowerCase() === "k"
      ) {
        // Another dialog (a confirmation) keeps the keyboard.
        if (document.querySelector("dialog[open]:not(.palette)")) return;
        e.preventDefault();
        ref.current();
      }
    };
    addEventListener("keydown", f);
    return () => removeEventListener("keydown", f);
  }, []);
}
