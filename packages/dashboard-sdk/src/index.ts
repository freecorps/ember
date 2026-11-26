// @freecorps/ember-dashboard-sdk: the page side of an `embed` block in the Ember Dashboard (docs/design/contracts.md
// "Dashboard", "Embeds"). A component or app serves a page from one of its GET routes; the dashboard shows it in an
// iframe sandboxed with `allow-scripts` only, under a CSP with no network at all, so the page reaches its data only
// through the dashboard:
//
//   const dash = connect();
//   const threads = await dash.query("dashboard:threads", { paginationOpts: { numItems: 10, cursor: null } });
//   await dash.mutate("lib:send", { threadId, prompt });   // the person confirms it in the dashboard first
//
// The page cannot load this module from anywhere (no network), so a route inlines it: `EMBED_SDK_SCRIPT` (defines
// `window.EmberDashboard.connect`), or `embedPage()`, which builds the whole document.

import { emberDashboardSdk, type ConnectOptions, type DashboardBridge, type DashboardErrorLike, type DashboardSdk } from "./sdk.ts";

export * from "./protocol.ts";
export type { ConnectOptions, DashboardBridge, DashboardErrorLike, SdkWindow } from "./sdk.ts";
export { emberDashboardSdk };

const sdk: DashboardSdk = emberDashboardSdk();

/** Connects to the dashboard around this page (call it once). */
export function connect(options?: ConnectOptions): DashboardBridge {
  return sdk.connect(options);
}

/** A request the dashboard refused or that failed: `code` (`not_allowed`, `busy`, `cancelled`, ... or the function's). */
export const DashboardError = sdk.DashboardError;

/**
 * The SDK as a classic inline script: defines `window.EmberDashboard = { connect, DashboardError }`. Put it in a
 * `<script>` of the page before the page's own script (the dashboard allows inline scripts by their hash).
 */
export const EMBED_SDK_SCRIPT = `window.EmberDashboard=(${emberDashboardSdk.toString()})();`;

export interface EmbedPageOptions {
  /** The document's `<title>` (escaped). */
  title: string;
  /** CSS for a `<style>` (inline styles are allowed). Use the theme's variables: `var(--fg)`, `var(--surface)`. */
  style?: string;
  /** The `<body>`'s markup, as is: escape anything that comes from data. */
  body?: string;
  /** The page's script (runs after the SDK: `const dash = EmberDashboard.connect()`). */
  script: string;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * A complete HTML document for an embed route: the SDK and the page's script inline, a base style using the
 * dashboard's theme variables. Throws when `script` or `style` would end their element early (`</script`, `</style`).
 */
export function embedPage(o: EmbedPageOptions): string {
  if (/<\/script/i.test(o.script)) throw new Error("embedPage: script must not contain </script (split the string: '<\\/script')");
  if (o.style && /<\/style/i.test(o.style)) throw new Error("embedPage: style must not contain </style");
  const base =
    ":root{color-scheme:light dark}body{margin:0;padding:12px;font:13px/1.45 var(--sans,system-ui,sans-serif);color:var(--fg,#1d1b18);background:var(--surface,#fff)}" +
    "button{font:inherit;color:var(--accent-fg,#fff);background:var(--accent,#c2410c);border:0;border-radius:var(--radius,6px);padding:4px 10px;cursor:pointer}" +
    "input,textarea,select{font:inherit;color:inherit;background:var(--bg,#f5f4f1);border:1px solid var(--line,#e1ddd5);border-radius:var(--radius,6px);padding:4px 8px}" +
    ".muted{color:var(--muted,#6e675e)}code,pre{font-family:var(--mono,ui-monospace,monospace)}";
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(o.title)}</title>` +
    `<style>${base}${o.style ?? ""}</style></head><body>${o.body ?? ""}<script>${EMBED_SDK_SCRIPT}</script><script>${o.script}</script></body></html>`
  );
}
