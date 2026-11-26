// Embed blocks (contracts.md "Dashboard", "Embeds"): a component's or app's own page in an
// `<iframe sandbox="allow-scripts">` (an opaque origin: no cookies, storage or DOM of the dashboard), served by the
// Worker's `/embed` under a CSP without network. This is the host side of the bridge (@freecorps/ember-dashboard-sdk,
// protocol.ts there):
//
//   - only messages whose `event.source` is this iframe's `contentWindow` are read (its origin is "null", so it cannot
//     be checked by name), and none once the iframe has navigated away from the page it loaded;
//   - the page may call only the functions its block lists (`block.functions`, local name → manifest name), each by
//     its own kind: `query` through `/api/dash/query`; `mutate` / `action` through `/api/dash/run` (CSRF, audited as
//     `dashboard.embed.run`, the Worker checks the block too) and only after the person confirms it here, seeing the
//     component, the function and the args;
//   - one confirmation at a time (another write meanwhile is refused `busy`), at most MAX_QUERIES queries in flight;
//   - the dashboard's theme (its CSS custom properties) is sent on the handshake and whenever it changes.
// Replies go to the iframe's window with targetOrigin "*": an opaque origin has no name to target, and the window is
// the one this block created (a navigated iframe gets nothing more).

import { useEffect, useMemo, useRef, useState } from "react";
import type { DashboardTheme, EmbedContext, EmbedOp, HostMessage } from "@freecorps/ember-dashboard-sdk";
import { api, ApiError, path } from "./api.ts";
import { useApi, useSession } from "./hooks.ts";
import { ConfirmDialog, JsonView, Loading, Mono, Problem } from "./ui.tsx";

/** The block as the runtime lists it. */
export interface EmbedSpec {
  kind: "embed";
  id: string;
  label?: string;
  description?: string;
  route: string;
  height: number | "auto";
  functions: Record<string, string>;
}

export interface EmbedHost {
  project: string;
  env: string;
  shard: string;
  spec: { key: string; label: string; component: string | null; functions: Record<string, { type: "query" | "mutation" | "action"; destructive?: true }> };
  changed: () => void;
}

const PROTOCOL = "dashboard-embed";
const V = 1;
const MAX_QUERIES = 4;
const ARGS_MAX = 8192;
const HEIGHT = { min: 40, max: 4000, initial: 320 };
/** Theme variables sent to the page (what style.css defines). */
const THEME_VARS = ["--bg", "--surface", "--surface-2", "--line", "--line-strong", "--fg", "--muted", "--accent", "--accent-fg", "--ok", "--bad", "--warn", "--info", "--focus", "--mono", "--sans", "--radius"];
const OPS: Record<EmbedOp, "query" | "mutation" | "action"> = { query: "query", mutate: "mutation", action: "action" };

export function currentTheme(): DashboardTheme {
  const cs = getComputedStyle(document.documentElement);
  const vars: Record<string, string> = {};
  for (const k of THEME_VARS) {
    const v = cs.getPropertyValue(k).trim();
    if (v) vars[k] = v;
  }
  return { mode: cs.colorScheme.includes("dark") ? "dark" : "light", vars };
}

/** A host message without its envelope (distributed over the union). */
type Outgoing = HostMessage extends infer M ? (M extends unknown ? Omit<M, "ember" | "v"> : never) : never;

interface PendingWrite {
  id: string;
  op: "mutate" | "action";
  name: string;
  fn: string;
  args: Record<string, unknown>;
  destructive: boolean;
}

export function EmbedBlock({ c, b }: { c: EmbedHost; b: EmbedSpec }) {
  const ticket = useApi<{ url: string; expires: number }>(path("/api/dash/embed", { project: c.project, env: c.env, dashboard: c.spec.key, route: b.route }));
  if (ticket.error) return <Problem error={ticket.error} onRetry={ticket.reload} />;
  if (!ticket.data) return <Loading lines={3} />;
  // A new ticket is a new iframe (and a new bridge).
  return <EmbedFrame key={ticket.data.url} c={c} b={b} url={ticket.data.url} reload={ticket.reload} />;
}

function EmbedFrame({ c, b, url, reload }: { c: EmbedHost; b: EmbedSpec; url: string; reload: () => void }) {
  const s = useSession();
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(b.height === "auto" ? HEIGHT.initial : b.height);
  const [status, setStatus] = useState<"loading" | "connected" | "ready" | "navigated" | "silent">("loading");
  const [write, setWrite] = useState<PendingWrite | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [expected, setExpected] = useState<string | null>(null);
  // Mutable bridge state the message handler reads (it is attached once per iframe).
  const st = useRef({ loads: 0, alive: true, welcomed: false, queries: 0, write: null as PendingWrite | null });
  const label = c.spec.component ? (c.spec.component === c.spec.key ? c.spec.component : `${c.spec.component} as ${c.spec.key}`) : "app";
  const prot = s.isProtected(c.env);
  const context: EmbedContext = useMemo(
    () => ({ project: c.project, env: c.env, shard: c.shard, dashboard: c.spec.key, block: b.id, functions: Object.keys(b.functions), role: s.isAdmin ? "admin" : "read" }),
    [c.project, c.env, c.shard, c.spec.key, b.id, b.functions, s.isAdmin],
  );

  const send = (msg: Outgoing) => {
    const w = frame.current?.contentWindow;
    if (!w || !st.current.alive) return;
    w.postMessage({ ember: PROTOCOL, v: V, ...msg }, "*");
  };
  const fail = (id: string, code: string, message: string, data?: unknown) => send({ type: "response", id, ok: false, error: { code, message, ...(data !== undefined ? { data } : {}) } });
  const sendRef = useRef({ send, fail });
  sendRef.current = { send, fail };
  // What the handler (attached once per iframe) reads that may change between renders: the picked shard, the role.
  const props = useRef({ c, b, context, isAdmin: s.isAdmin, prot });
  props.current = { c, b, context, isAdmin: s.isAdmin, prot };

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const w = frame.current?.contentWindow;
      // Only this iframe's window: never another frame, a popup or the dashboard itself.
      if (!w || e.source !== w || !st.current.alive) return;
      const d = e.data as Record<string, unknown> | null;
      if (!d || typeof d !== "object" || d.ember !== PROTOCOL || d.v !== V) return;
      const { send, fail } = sendRef.current;
      const { c, b, context, isAdmin, prot } = props.current;
      if (d.type === "hello") {
        send({ type: "welcome", theme: currentTheme(), context });
        st.current.welcomed = true;
        setStatus((x) => (x === "loading" || x === "silent" ? "connected" : x));
        return;
      }
      if (!st.current.welcomed) return;
      if (d.type === "ready") return setStatus("ready");
      if (d.type === "resize") {
        if (b.height === "auto" && typeof d.height === "number" && Number.isFinite(d.height)) setHeight(Math.min(HEIGHT.max, Math.max(HEIGHT.min, Math.ceil(d.height))));
        return;
      }
      if (d.type !== "request") return;
      const id = typeof d.id === "string" && d.id.length <= 64 ? d.id : null;
      if (!id) return;
      const op = d.op as EmbedOp;
      const name = typeof d.name === "string" ? d.name : "";
      if (!Object.hasOwn(OPS, op)) return fail(id, "bad_request", "op: query, mutate or action");
      const fn = Object.hasOwn(b.functions, name) ? b.functions[name]! : null;
      const declared = fn && Object.hasOwn(c.spec.functions, fn) ? c.spec.functions[fn]! : null;
      if (!fn || !declared) return fail(id, "not_allowed", `${JSON.stringify(name)} is not a function this block lets its page call`);
      if (declared.type !== OPS[op]) return fail(id, "not_allowed", `${name} is a ${declared.type}: call it with ${declared.type === "query" ? "query" : declared.type === "mutation" ? "mutate" : "action"}()`);
      const args = d.args;
      if (!args || typeof args !== "object" || Array.isArray(args)) return fail(id, "bad_request", "args must be an object");
      let text: string;
      try {
        text = JSON.stringify(args);
      } catch {
        return fail(id, "bad_request", "args must be plain JSON");
      }
      if (text.length > ARGS_MAX) return fail(id, "bad_request", `args up to ${ARGS_MAX} characters`);
      if (op === "query") {
        if (st.current.queries >= MAX_QUERIES) return fail(id, "busy", `at most ${MAX_QUERIES} queries at a time`);
        st.current.queries++;
        api
          .get<{ value: unknown }>(path("/api/dash/query", { project: c.project, env: c.env, shard: c.shard, dashboard: c.spec.key, fn, args: text }))
          .then(
            (r) => sendRef.current.send({ type: "response", id, ok: true, value: r.value }),
            (x: unknown) => {
              const e = x instanceof ApiError ? x : new ApiError(0, "error", String(x));
              sendRef.current.fail(id, e.code, e.message, e.data);
            },
          )
          .finally(() => void st.current.queries--);
        return;
      }
      if (!isAdmin) return fail(id, "forbidden", "the read role cannot run mutations or actions");
      // One confirmation at a time: a page cannot stack dialogs.
      if (st.current.write) return fail(id, "busy", "another write is waiting for the person's confirmation");
      const pending: PendingWrite = { id, op: op as "mutate" | "action", name, fn, args: args as Record<string, unknown>, destructive: declared.destructive === true };
      st.current.write = pending;
      setError(null);
      setExpected(pending.destructive && prot ? fn.slice(fn.lastIndexOf(":") + 1) : null);
      setWrite(pending);
    };
    window.addEventListener("message", onMessage);
    // The theme follows the dashboard's (the toggle sets data-theme; "auto" follows the system).
    const pushTheme = () => st.current.welcomed && sendRef.current.send({ type: "theme", theme: currentTheme() });
    const mo = new MutationObserver(pushTheme);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const mq = matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", pushTheme);
    const silent = setTimeout(() => setStatus((x) => (x === "loading" ? "silent" : x)), 10_000);
    return () => {
      window.removeEventListener("message", onMessage);
      mo.disconnect();
      mq.removeEventListener("change", pushTheme);
      clearTimeout(silent);
      st.current.alive = false;
    };
    // One handler per iframe (EmbedFrame is keyed by its URL); what it reads that may change is in refs.
  }, []);

  const settle = (reply: () => void) => {
    reply();
    st.current.write = null;
    setWrite(null);
    setExpected(null);
    setError(null);
  };
  const confirm = async (typed: string | null) => {
    const w = st.current.write;
    if (!w) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ value?: unknown }>("/api/dash/run", { project: c.project, env: c.env, shard: c.shard, dashboard: c.spec.key, fn: w.fn, args: w.args, embed: b.id, ...(typed ? { confirm: typed } : {}) });
      settle(() => send({ type: "response", id: w.id, ok: true, value: r.value ?? null }));
      c.changed();
    } catch (x) {
      const e = x instanceof ApiError ? x : new ApiError(0, "error", String(x));
      // The Worker decides what is destructive: when it asks, ask for the text it names (the dialog stays open).
      if (e.code === "confirmation_required" && typeof e.data?.expected === "string") setExpected(e.data.expected);
      else settle(() => fail(w.id, e.code, e.message, e.data));
    } finally {
      setBusy(false);
    }
  };
  const cancel = () => {
    const w = st.current.write;
    if (w) settle(() => fail(w.id, "cancelled", "the person declined"));
  };

  return (
    <div className="embed">
      <iframe
        ref={frame}
        src={url}
        title={b.label ?? `${c.spec.label}: ${b.id}`}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        allow=""
        className="embed-frame"
        style={{ height }}
        onLoad={() => {
          // The first load is the page; any other is the iframe navigating away: the bridge stops answering.
          if (++st.current.loads > 1) {
            st.current.alive = false;
            setStatus("navigated");
            if (st.current.write) {
              st.current.write = null;
              setWrite(null);
            }
          }
        }}
      />
      {status === "navigated" && (
        <p className="bad small">
          The page navigated away, so the dashboard stopped answering it.{" "}
          <button type="button" className="link" onClick={reload}>
            Reload it
          </button>
        </p>
      )}
      {status === "silent" && (
        <p className="muted small">
          The page has not connected to the dashboard (does it run <Mono>EmberDashboard.connect()</Mono> from @freecorps/ember-dashboard-sdk?).
        </p>
      )}
      <ConfirmDialog
        open={write !== null}
        title={`${write?.op === "action" ? "Run action" : "Run mutation"} from the ${c.spec.label} page${prot ? ` on ${c.env}` : ""}?`}
        confirmLabel="Run"
        danger={write?.destructive === true}
        expected={expected}
        busy={busy}
        error={error}
        onCancel={cancel}
        onConfirm={(typed) => void confirm(typed)}
      >
        {write && (
          <>
            <p>
              The embedded page asks to run <Mono>{write.fn}</Mono> ({write.op === "action" ? "action" : "mutation"}) of <Mono>{label}</Mono> on <Mono>{c.shard}</Mono>, with:
            </p>
            <JsonView value={write.args} />
            <p className="muted small">Only what you confirm runs. Recorded in the audit log as dashboard.embed.run.</p>
          </>
        )}
      </ConfirmDialog>
    </div>
  );
}
