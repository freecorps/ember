// Ember Dashboard SPA (React, no router or UI dependencies). Hash routes:
//   #/                                       projects of the account
//   #/audit                                  audit log, all projects
//   #/p/<project>/<env>/<section>[/<shard>]  health | functions | shards | data | crons | deployments | audit
// The shard in the route is the one the top bar's picker selected (data, shards and crons use it).

import { StrictMode, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { ApiError, path, session, type Me } from "./api.ts";
import { href, SessionContext, useApi, useRoute, useShortcuts, useTheme, type Route, type SessionInfo, type Theme } from "./hooks.ts";
import { Audit } from "./pages/audit.tsx";
import { DataBrowser } from "./pages/data.tsx";
import { Health } from "./pages/health.tsx";
import { Functions } from "./pages/functions.tsx";
import { Crons, Deployments, Projects } from "./pages/misc.tsx";
import { Reactivity } from "./pages/reactivity.tsx";
import { Shards } from "./pages/shards.tsx";
import type { Project, ShardRow } from "./pages/types.ts";
import { Dialog, Loading, Mono, Problem, Toasts, type ToastItem } from "./ui.tsx";

const SECTIONS = [
  { id: "health", label: "Health", key: "h" },
  { id: "functions", label: "Functions", key: "f" },
  { id: "shards", label: "Shards", key: "s" },
  { id: "data", label: "Data", key: "d" },
  { id: "reactivity", label: "Reactivity", key: "r" },
  { id: "crons", label: "Schedules", key: "c" },
  { id: "deployments", label: "Deployments", key: "p" },
  { id: "audit", label: "Audit log", key: "a" },
] as const;

const SHARD_SECTIONS = new Set(["data", "shards", "crons", "reactivity"]);
const DEFAULT_SHARD = "global:main";

function Logo() {
  return (
    <svg className="logo-mark" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 1.5c.6 2.4 3.9 3.9 3.9 7.4A3.9 3.9 0 0 1 8 12.8a3.9 3.9 0 0 1-3.9-3.9c0-1.6.8-2.6 1.6-3.4.1 1.1.7 1.9 1.5 2.2C6.9 5.7 7.3 3.4 8 1.5Z" />
      <rect x="3" y="13.6" width="10" height="1.2" rx=".6" />
    </svg>
  );
}

// ------------------------------------------------------------------------------------------- shard picker

function ShardPicker({ project, env, current, section }: { project: string; env: string; current: string; section: string }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [debounced, setDebounced] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 150);
    return () => clearTimeout(t);
  }, [q]);
  const list = useApi<{ shards: ShardRow[] }>(open ? path("/api/shards", { project, env, q: debounced }) : null);
  const names = useMemo(() => {
    const typed = q.trim();
    // Filtered here too: the server's answer may be for an older (debounced) term.
    const found = (list.data?.shards ?? []).map((s) => s.shard).filter((n) => n.includes(typed)).slice(0, 12);
    // A typed full name can be opened even when the catalog has not heard of it yet.
    return typed.includes(":") && !found.includes(typed) ? [typed, ...found] : found;
  }, [list.data, q]);
  useShortcuts({ "/": () => input.current?.focus() });
  const go = (shard: string) => {
    setOpen(false);
    setQ("");
    input.current?.blur();
    location.hash = href({ project, env, section: SHARD_SECTIONS.has(section) ? section : "data", shard });
  };
  return (
    <div className="picker" role="combobox" aria-expanded={open} aria-haspopup="listbox" aria-owns="shard-options">
      <span className="picker-label">shard</span>
      <input
        ref={input}
        value={open ? q : current}
        placeholder={current}
        onFocus={() => {
          setOpen(true);
          setActive(0);
        }}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onChange={(e) => {
          setQ(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, names.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            const pick = names[active];
            if (pick) go(pick);
          } else if (e.key === "Escape") {
            setOpen(false);
            input.current?.blur();
          }
        }}
        aria-label="Shard (press / to search)"
        aria-autocomplete="list"
        aria-controls="shard-options"
        spellCheck={false}
        autoComplete="off"
      />
      <kbd className="hint">/</kbd>
      {open && (
        <ul className="options" id="shard-options" role="listbox">
          {list.loading && !names.length ? (
            <li className="muted">Searching…</li>
          ) : !names.length ? (
            <li className="muted">{q ? "No shard matches. Type kind:key to open any shard." : "No shards in the catalog."}</li>
          ) : (
            names.map((n, i) => (
              <li key={n} role="option" aria-selected={i === active} className={i === active ? "active" : undefined} onMouseDown={(e) => (e.preventDefault(), go(n))}>
                <Mono>{n}</Mono>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------- shell

function Sidebar({ projects, route }: { projects: Project[] | null; route: Route }) {
  return (
    <nav className="sidebar" aria-label="Projects and sections">
      <div className="side-group">
        <a className={`side-title${route.page === "projects" ? " active" : ""}`} href="#/">
          Projects
        </a>
        {!projects ? (
          <Loading lines={2} />
        ) : (
          projects.map((p) => (
            <div key={p.name} className="side-project">
              <div className="side-name">{p.name}</div>
              {p.envs.map((e) => {
                const here = route.project === p.name && route.env === e.env;
                return (
                  <a key={e.env} className={`side-env${here ? " active" : ""}`} href={href({ project: p.name, env: e.env, section: here ? route.section : "health" })} aria-current={here ? "page" : undefined}>
                    {e.env}
                  </a>
                );
              })}
            </div>
          ))
        )}
      </div>
      {route.page === "env" && route.project && route.env && (
        <div className="side-group">
          <div className="side-title">
            {route.project}/{route.env}
          </div>
          {SECTIONS.map((s) => (
            <a
              key={s.id}
              className={`side-link${route.section === s.id ? " active" : ""}`}
              href={href({ project: route.project!, env: route.env!, section: s.id, ...(route.shard && SHARD_SECTIONS.has(s.id) ? { shard: route.shard } : {}) })}
              aria-current={route.section === s.id ? "page" : undefined}
            >
              <span>{s.label}</span>
              <kbd>{s.key}</kbd>
            </a>
          ))}
        </div>
      )}
      <div className="side-group">
        <a className={`side-link${route.page === "audit" ? " active" : ""}`} href="#/audit">
          <span>Audit · all projects</span>
        </a>
      </div>
    </nav>
  );
}

const THEMES: Theme[] = ["auto", "light", "dark"];

function Shell({ me, onSignOut }: { me: Me; onSignOut: () => void }) {
  const route = useRoute();
  const projects = useApi<{ projects: Project[] }>("/api/projects");
  const [theme, setTheme] = useTheme();
  const [help, setHelp] = useState(false);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const toast = useCallback<SessionInfo["toast"]>((t) => {
    const id = ++seq.current;
    setToasts((x) => [...x.slice(-3), { id, kind: t.kind ?? "ok", text: t.text, ...(t.detail ? { detail: t.detail } : {}) }]);
    if (t.kind !== "bad") setTimeout(() => setToasts((x) => x.filter((y) => y.id !== id)), 8000);
  }, []);
  const info = useMemo<SessionInfo>(() => ({ me, isAdmin: me.role === "admin", isProtected: (env) => me.protectedEnvs.includes(env), toast }), [me, toast]);
  const inEnv = route.page === "env" && route.project && route.env;
  const shortcuts: Record<string, () => void> = { "?": () => setHelp(true), t: () => setTheme(THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]!) };
  if (inEnv) for (const s of SECTIONS) shortcuts[s.key] = () => (location.hash = href({ project: route.project!, env: route.env!, section: s.id, ...(route.shard && SHARD_SECTIONS.has(s.id) ? { shard: route.shard } : {}) }));
  useShortcuts(shortcuts);

  const known = !projects.data || !inEnv || projects.data.projects.some((p) => p.name === route.project && p.envs.some((e) => e.env === route.env));
  const section = SECTIONS.find((s) => s.id === route.section) ?? SECTIONS[0];
  const shard = route.shard ?? DEFAULT_SHARD;
  let body: ReactNode;
  if (route.page === "audit") body = <Audit />;
  else if (!inEnv) body = <Projects />;
  else if (!known) body = <Problem error={new ApiError(404, "not_found", `${route.project}/${route.env} is not in the registry`)} />;
  else {
    const p = { project: route.project!, env: route.env! };
    body =
      section.id === "functions" ? (
        // The fifth route segment is the function's name here (a shard in the shard sections).
        <Functions {...p} fn={route.shard} />
      ) : section.id === "reactivity" ? (
        <Reactivity key={shard} {...p} shard={shard} />
      ) : section.id === "shards" ? (
        <Shards {...p} {...(route.shard ? { shard: route.shard } : {})} />
      ) : section.id === "data" ? (
        <DataBrowser key={`${p.project}/${p.env}/${shard}`} {...p} shard={shard} />
      ) : section.id === "crons" ? (
        <Crons {...p} shard={shard} />
      ) : section.id === "deployments" ? (
        <Deployments {...p} />
      ) : section.id === "audit" ? (
        <Audit {...p} />
      ) : (
        <Health {...p} />
      );
  }

  return (
    <SessionContext.Provider value={info}>
      <a className="skip" href="#content">
        Skip to content
      </a>
      <header className="topbar">
        <a href="#/" className="brand" aria-label="Ember Dashboard, projects">
          <Logo />
          <span>ember</span>
        </a>
        <div className="crumbs" aria-label="Location">
          {inEnv ? (
            <>
              <span>{route.project}</span>
              <span className="sep">/</span>
              <span className={me.protectedEnvs.includes(route.env!) ? "env protected" : "env"} title={me.protectedEnvs.includes(route.env!) ? "Protected environment: destructive actions ask you to type the target's name" : undefined}>
                {route.env}
              </span>
              <span className="sep">/</span>
              <strong>{section.label}</strong>
            </>
          ) : (
            <strong>{route.page === "audit" ? "Audit log" : "Projects"}</strong>
          )}
        </div>
        {inEnv && SHARD_SECTIONS.has(section.id) && <ShardPicker project={route.project!} env={route.env!} current={shard} section={section.id} />}
        <span className="spacer" />
        <span className="who" title={`Signed in through ${me.via === "access" ? "Cloudflare Access" : "a dashboard token"}`}>
          {me.actor}
          <span className={`role ${me.role}`}>{me.role}</span>
        </span>
        <button type="button" className="icon" onClick={() => setTheme(THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]!)} aria-label={`Theme: ${theme} (t)`} title={`Theme: ${theme} (t)`}>
          {theme === "dark" ? "☾" : theme === "light" ? "☀" : "◐"}
        </button>
        <button type="button" className="icon" onClick={() => setHelp(true)} aria-label="Keyboard shortcuts (?)" title="Keyboard shortcuts (?)">
          ?
        </button>
        {me.via === "token" && (
          <button type="button" className="link" onClick={onSignOut}>
            Sign out
          </button>
        )}
      </header>
      <div className="layout">
        <Sidebar projects={projects.data?.projects ?? null} route={route} />
        <main id="content" tabIndex={-1}>
          {projects.error && route.page !== "projects" ? <Problem error={projects.error} onRetry={projects.reload} /> : body}
        </main>
      </div>
      <Toasts items={toasts} dismiss={(id) => setToasts((x) => x.filter((t) => t.id !== id))} />
      <Dialog open={help} onClose={() => setHelp(false)} title="Keyboard">
        <div className="dialog-body">
          <dl className="kv keys">
            {SECTIONS.map((s) => (
              <div key={s.id}>
                <dt>
                  <kbd>{s.key}</kbd>
                </dt>
                <dd>{s.label}</dd>
              </div>
            ))}
            <div>
              <dt>
                <kbd>/</kbd>
              </dt>
              <dd>Search shards</dd>
            </div>
            <div>
              <dt>
                <kbd>↑</kbd> <kbd>↓</kbd> <kbd>Enter</kbd>
              </dt>
              <dd>Move through rows, open one</dd>
            </div>
            <div>
              <dt>
                <kbd>t</kbd>
              </dt>
              <dd>Theme (auto, light, dark)</dd>
            </div>
            <div>
              <dt>
                <kbd>Esc</kbd>
              </dt>
              <dd>Close a dialog</dd>
            </div>
          </dl>
        </div>
      </Dialog>
    </SessionContext.Provider>
  );
}

function Login({ error, onDone }: { error: ApiError; onDone: () => void }) {
  const [v, setV] = useState("");
  const [tried, setTried] = useState(false);
  return (
    <main className="login">
      <div className="login-card">
        <div className="brand">
          <Logo />
          <span>ember</span>
        </div>
        {error.status === 403 ? (
          <>
            <h1>Dashboard locked</h1>
            <p>{error.message}</p>
            <p className="muted">
              Run <code>ember dashboard deploy --access</code> to put Cloudflare Access in front of it, or set the <code>DASHBOARD_TOKEN</code> secret.
            </p>
          </>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              session.setToken(v);
              setTried(true);
              setV("");
              onDone();
            }}
          >
            <h1>Sign in</h1>
            <p className="muted">Sign in with Cloudflare Access, or paste the dashboard token. It stays in this tab's memory only: a reload asks again.</p>
            <label className="field">
              <span>Dashboard token</span>
              <input type="password" value={v} onChange={(e) => setV(e.target.value)} autoFocus autoComplete="off" />
            </label>
            {tried && error.status === 401 && <p className="bad small">That token was rejected.</p>}
            <button type="submit" className="primary" disabled={!v.trim()}>
              Continue
            </button>
          </form>
        )}
      </div>
    </main>
  );
}

function App() {
  const me = useApi<Me>("/api/me");
  useTheme();
  useEffect(() => {
    session.setCsrf(me.data?.csrf ?? null);
  }, [me.data]);
  if (me.error && (me.error.status === 401 || me.error.status === 403)) return <Login error={me.error} onDone={me.reload} />;
  if (me.error)
    return (
      <main className="login">
        <Problem error={me.error} onRetry={me.reload} />
      </main>
    );
  if (!me.data)
    return (
      <main className="login">
        <Loading />
      </main>
    );
  return (
    <Shell
      me={me.data}
      onSignOut={() => {
        session.setToken(null);
        me.reload();
      }}
    />
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
