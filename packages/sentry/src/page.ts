// The sentry component's embed page (contracts.md "Dashboard", "Embeds"): the latest event of an issue, read back from R2
// through `lib:latestEvent` (an action: the dashboard asks to confirm it), drawn as frames with source context,
// breadcrumbs, tags and contexts. The route only serves this static document; the data comes through the dashboard's
// bridge, for the functions the embed block lists. Everything is drawn with textContent (no event text becomes HTML).
//
// TODO(replays): a replay timeline (the `replay_recording` segments under `replays/` in R2) is not drawn yet.
import { embedPage } from "@freecorps/ember-dashboard-sdk";

export const EVENT_PAGE_ROUTE = "/dashboard/event";

const SCRIPT = `
const dash = EmberDashboard.connect();
const $ = (id) => document.getElementById(id);
const el = (tag, text, cls) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; };
const say = (t) => { $("status").textContent = t; };
const failed = (e) => say((e && e.code ? e.code + ": " : "") + (e && e.message ? e.message : String(e)));
let picked = 0;
function frames(ev) {
  const out = [];
  for (const x of ((ev.exception && ev.exception.values) || []).slice().reverse()) {
    out.push(el("h3", (x.type || "Error") + (x.value ? ": " + x.value : "")));
    for (const f of (((x.stacktrace && x.stacktrace.frames) || []).slice().reverse())) {
      const box = el("div", undefined, "frame" + (f.in_app === false ? " lib" : ""));
      box.append(el("div", (f.function || "?") + "  " + (f.filename || f.abs_path || "?") + ":" + (f.lineno || "?") + ":" + (f.colno || "?"), "where"));
      if (f.context_line !== undefined) {
        const pre = el("pre");
        const n0 = (f.lineno || 0) - ((f.pre_context || []).length);
        [...(f.pre_context || []), f.context_line, ...(f.post_context || [])].forEach((l, i) => pre.append(el("span", String(n0 + i).padStart(5) + "  " + l + "\\n", n0 + i === f.lineno ? "hit" : "")));
        box.append(pre);
      }
      if (f.data && f.data.minified) box.append(el("div", "minified: " + f.data.minified, "muted"));
      out.push(box);
    }
  }
  return out;
}
function table(title, rows) {
  if (!rows.length) return [];
  const t = el("table");
  for (const [k, v] of rows) { const tr = el("tr"); tr.append(el("th", k), el("td", typeof v === "string" ? v : JSON.stringify(v))); t.append(tr); }
  return [el("h3", title), t];
}
async function show(id) {
  const mine = ++picked;
  say("Loading the latest event…");
  try {
    const ev = await dash.action("lib:latestEvent", { id });
    if (mine !== picked) return;
    const view = $("view");
    if (!ev) { view.replaceChildren(el("p", "The latest event is not in R2 (expired, or no bucket).", "muted")); say(""); return; }
    const e = ev.event || ev;
    const crumbs = ((e.breadcrumbs && (e.breadcrumbs.values || e.breadcrumbs)) || []);
    const tags = Array.isArray(e.tags) ? e.tags : Object.entries(e.tags || {});
    view.replaceChildren(
      el("p", (e.event_id || "") + " · " + (e.release || "no release") + " · " + (e.environment || "") + " · " + (e.platform || ""), "muted"),
      ...frames(e),
      ...table("Breadcrumbs", (Array.isArray(crumbs) ? crumbs : []).slice(-50).map((b) => [new Date((b.timestamp || 0) * 1000).toISOString().slice(11, 23) + " " + (b.category || b.type || ""), b.message || b.data || ""])),
      ...table("Tags", tags.map((t) => Array.isArray(t) ? t : [t.key, t.value])),
      ...table("Contexts", Object.entries(e.contexts || {})),
    );
    say("");
  } catch (e) { if (mine === picked) failed(e); }
  dash.resize();
}
async function load() {
  say("Loading…");
  try {
    const r = await dash.query("dashboard:issues", { status: "unresolved", paginationOpts: { numItems: 20, cursor: null } });
    $("list").replaceChildren(...r.page.map((i) => {
      const b = el("button", "[" + i.level + "] " + i.title + " · " + i.count + " events", "row");
      b.type = "button";
      b.addEventListener("click", () => show(i._id));
      const li = el("li"); li.append(b); return li;
    }));
    say(r.page.length ? "" : "No unresolved issues.");
  } catch (e) { failed(e); }
  dash.resize();
  dash.ready();
}
$("reload").addEventListener("click", load);
load();
`;

const STYLE = `
ul{list-style:none;margin:8px 0;padding:0;display:grid;gap:2px}
.row{width:100%;text-align:left;color:var(--fg,#1d1b18);background:transparent;border:1px solid transparent;padding:4px 8px}
.row:hover,.row:focus-visible{border-color:var(--line,#e1ddd5);background:var(--surface-2,#f5f4f1)}
#view{border-top:1px solid var(--line,#e1ddd5);margin-top:8px;padding-top:8px}
.frame{border:1px solid var(--line,#e1ddd5);border-radius:var(--radius,6px);margin:4px 0;padding:4px 8px}
.frame.lib{opacity:.6}
.where{font-family:ui-monospace,monospace;font-size:12px}
pre{margin:4px 0;overflow:auto;font-size:12px}
.hit{background:var(--surface-2,#f5f4f1);font-weight:600}
table{border-collapse:collapse;font-size:12px}th{text-align:left;padding-right:12px;vertical-align:top}td{white-space:pre-wrap;word-break:break-word}
`;

/** The page's document (built once). */
export const EVENT_PAGE: string = embedPage({
  title: "Latest event",
  style: STYLE,
  body: `<p><button type="button" id="reload">Reload</button> <span id="status" class="muted" role="status"></span></p><ul id="list" aria-label="Unresolved issues"></ul><section id="view"></section>`,
  script: SCRIPT,
});
