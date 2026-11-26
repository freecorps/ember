// The email component's embed page (contracts.md "Dashboard", "Embeds"): the outbox's latest emails and a preview of
// the one picked, drawn in the Ember Dashboard's sandboxed iframe. The route (`GET /email/dashboard/preview` with the
// default prefix) is a public route of the app like any other, so it serves only this static document: no data, no
// auth. The data comes through the dashboard (`@freecorps/ember-dashboard-sdk`), which runs only the queries the
// embed block lists (`dashboard:outbox`, `dashboard:preview`) for a signed-in person.
//
// Serving the SDK under the embed CSP (no network, inline scripts by hash only): `embedPage()` inlines the SDK
// (`EMBED_SDK_SCRIPT`) and this script in the document; the dashboard hashes each inline script of the page it serves.
// The email's HTML is sanitized by the query (`sanitizeEmailHtml`) and drawn in a shadow root, so its styles stay
// in it; the page's CSP blocks its remote images (no tracking pixels) and any script.
import { embedPage } from "@freecorps/ember-dashboard-sdk";

/** Where the page is served, relative to the component's HTTP prefix. */
export const PREVIEW_ROUTE = "/dashboard/preview";

const SCRIPT = `
const dash = EmberDashboard.connect();
const $ = (id) => document.getElementById(id);
const list = $("list"), view = $("view"), status = $("status");
const shadow = $("html").attachShadow({ mode: "open" });
const say = (t) => { status.textContent = t; };
const failed = (e) => say((e && e.code ? e.code + ": " : "") + (e && e.message ? e.message : String(e)));
// Answers may arrive out of order: only the latest pick is drawn (an earlier one's answer, or error, is dropped).
let picked = 0;
async function show(id) {
  const mine = ++picked;
  say("Loading…");
  try {
    const e = await dash.query("dashboard:preview", { id });
    if (mine !== picked) return;
    if (!e) return say("This email is gone.");
    $("subject").textContent = e.subject;
    $("meta").textContent = "From " + e.from + " to " + e.to + " · " + e.status;
    shadow.innerHTML = e.html || "";
    $("text").textContent = e.html ? "" : (e.text || (e.template ? "Rendered from the template " + e.template + " when it is sent." : "(no body)"));
    view.hidden = false;
    say("");
  } catch (e) { if (mine === picked) failed(e); }
  dash.resize();
}
async function load() {
  say("Loading…");
  try {
    const r = await dash.query("dashboard:outbox", { paginationOpts: { numItems: 20, cursor: null } });
    list.replaceChildren(...r.page.map((e) => {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button";
      b.className = "row";
      b.textContent = (e.subject || "(no subject)") + " — " + e.to + " · " + e.status;
      b.addEventListener("click", () => show(e._id));
      li.append(b);
      return li;
    }));
    say(r.page.length ? "" : "No emails in this shard yet.");
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
#subject{margin:0 0 2px;font-size:15px}
#html{display:block;background:#fff;color:#000;border-radius:var(--radius,6px);overflow:auto}
#text{white-space:pre-wrap;margin:0}
`;

/** The page's document (built once). */
export const PREVIEW_PAGE: string = embedPage({
  title: "Email preview",
  style: STYLE,
  body: `<p><button type="button" id="reload">Reload</button> <span id="status" class="muted" role="status"></span></p><ul id="list" aria-label="Recent emails"></ul><section id="view" hidden><h2 id="subject"></h2><p id="meta" class="muted"></p><div id="html"></div><pre id="text"></pre></section>`,
  script: SCRIPT,
});
