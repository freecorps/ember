// Templates (PLAN §16): a small Mustache-like engine plus a responsive email layout.
//
// Why not React Email: templates here are *data* (stored in the shard, edited through the HTTP API and the
// dashboard, rendered inside a mutation-free action or even a query), and React Email needs React + react-dom/server
// in the Worker bundle (~150 KiB+) and JSX at build time. Apps that prefer React Email render it themselves (in an
// action) and pass `html`. This engine is ~150 lines, has no dependencies, escapes by default and runs anywhere.
//
//   {{name}}            HTML-escaped value (dotted paths: {{user.name}})
//   {{{html}}}          raw value
//   {{#if x}}…{{else}}…{{/if}}     truthy check (empty arrays are false)
//   {{#unless x}}…{{/unless}}
//   {{#each items}}…{{this}} / {{name}} / {{@index}}…{{/each}}
//
// Missing values render as "". Templates are parsed once (cached by source).

type Node =
  | { t: "text"; v: string }
  | { t: "var"; path: string; raw: boolean }
  | { t: "if"; path: string; neg: boolean; then: Node[]; else: Node[] }
  | { t: "each"; path: string; body: Node[] };

const TAG = /\{\{(\{?)\s*([#/]?)\s*([^}]*?)\s*\}?\}\}/g;

export class TemplateError extends Error {
  override name = "TemplateError";
}

function parse(src: string): Node[] {
  const root: Node[] = [];
  const stack: Array<{ node: Extract<Node, { t: "if" } | { t: "each" }>; inElse: boolean; open: string }> = [];
  const target = () => {
    const top = stack[stack.length - 1];
    if (!top) return root;
    return top.node.t === "if" ? (top.inElse ? top.node.else : top.node.then) : top.node.body;
  };
  let last = 0;
  for (const m of src.matchAll(TAG)) {
    if (m.index! > last) target().push({ t: "text", v: src.slice(last, m.index) });
    last = m.index! + m[0].length;
    const [, brace, sigil, body] = m as unknown as [string, string, string, string];
    if (sigil === "#") {
      const [kw, path = ""] = body.split(/\s+/, 2);
      if (kw === "if" || kw === "unless") {
        const node: Node = { t: "if", path, neg: kw === "unless", then: [], else: [] };
        target().push(node);
        stack.push({ node, inElse: false, open: kw });
      } else if (kw === "each") {
        const node: Node = { t: "each", path, body: [] };
        target().push(node);
        stack.push({ node, inElse: false, open: kw });
      } else throw new TemplateError(`Unknown block {{#${kw}}}`);
    } else if (sigil === "/") {
      const top = stack.pop();
      if (!top || top.open !== body.trim()) throw new TemplateError(`Unexpected {{/${body}}}`);
    } else if (body === "else") {
      const top = stack[stack.length - 1];
      if (!top || top.node.t !== "if") throw new TemplateError("{{else}} outside {{#if}}");
      top.inElse = true;
    } else {
      target().push({ t: "var", path: body, raw: brace === "{" });
    }
  }
  if (stack.length) throw new TemplateError(`Unclosed {{#${stack[stack.length - 1]!.open}}}`);
  if (last < src.length) target().push({ t: "text", v: src.slice(last) });
  return root;
}

const cache = new Map<string, Node[]>();
function compiled(src: string): Node[] {
  let n = cache.get(src);
  if (!n) {
    n = parse(src);
    if (cache.size > 200) cache.clear();
    cache.set(src, n);
  }
  return n;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function lookup(scopes: unknown[], path: string): unknown {
  if (path === "this" || path === ".") return scopes[scopes.length - 1];
  const parts = path.split(".");
  for (let i = scopes.length - 1; i >= 0; i--) {
    let cur: unknown = scopes[i];
    if (cur === null || typeof cur !== "object" || !(parts[0]! in (cur as object))) continue;
    for (const p of parts) cur = cur !== null && typeof cur === "object" ? (cur as Record<string, unknown>)[p] : undefined;
    return cur;
  }
  return undefined;
}

const truthy = (v: unknown) => (Array.isArray(v) ? v.length > 0 : !!v);
const str = (v: unknown) => (v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));

function run(nodes: Node[], scopes: unknown[], escape: boolean): string {
  let out = "";
  for (const n of nodes) {
    if (n.t === "text") out += n.v;
    else if (n.t === "var") {
      const v = str(lookup(scopes, n.path));
      out += n.raw || !escape ? v : escapeHtml(v);
    } else if (n.t === "if") out += run(truthy(lookup(scopes, n.path)) !== n.neg ? n.then : n.else, scopes, escape);
    else {
      const list = lookup(scopes, n.path);
      if (!Array.isArray(list)) continue;
      list.forEach((item, i) => {
        out += run(n.body, [...scopes, { "@index": i }, item], escape);
      });
    }
  }
  return out;
}

/** Renders `src` with `data`. `escape: false` for plain-text parts and subjects. */
export function renderTemplate(src: string, data: Record<string, unknown> = {}, opts: { escape?: boolean } = {}): string {
  return run(compiled(src), [data], opts.escape ?? true);
}

/** Throws a `TemplateError` if `src` does not parse (used when a template is saved). */
export function checkTemplate(src: string): void {
  parse(src);
}

// ------------------------------------------------------------------------------------------------ layout

export interface LayoutOptions {
  /** Brand name in the header (omitted = no header). */
  brand?: string;
  /** Accent color (buttons, header bar). */
  color?: string;
  /** Small footer line (address, unsubscribe note). */
  footer?: string;
  /** Hidden preview text shown by inbox lists. */
  preheader?: string;
}

/**
 * Wraps body HTML in a responsive, table-based layout that renders well in Gmail, Outlook, Apple Mail and dark
 * mode clients (inline styles; no external CSS).
 */
export function emailLayout(bodyHtml: string, o: LayoutOptions = {}): string {
  const color = /^#[0-9a-f]{3,8}$/i.test(o.color ?? "") ? o.color! : "#e8590c";
  const pre = o.preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(o.preheader)}</div>` : "";
  const header = o.brand
    ? `<tr><td style="padding:24px 32px 0 32px;font:600 18px/1.3 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${color}">${escapeHtml(o.brand)}</td></tr>`
    : "";
  const footer = o.footer
    ? `<tr><td style="padding:16px 32px 28px 32px;font:12px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#868e96;border-top:1px solid #f1f3f5">${escapeHtml(o.footer)}</td></tr>`
    : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title></title></head>` +
    `<body style="margin:0;padding:0;background:#f4f5f7">${pre}` +
    `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f5f7"><tr><td align="center" style="padding:24px 12px">` +
    `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#ffffff;border-radius:10px;border-top:4px solid ${color}">` +
    header +
    `<tr><td style="padding:20px 32px 24px 32px;font:15px/1.6 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#212529">${bodyHtml}</td></tr>` +
    footer +
    `</table></td></tr></table></body></html>`;
}

/** A bulletproof button (`<a>` styled as a button) for templates: `{{{button}}}`. */
export function emailButton(href: string, label: string, color = "#e8590c"): string {
  return `<table role="presentation" cellspacing="0" cellpadding="0"><tr><td style="border-radius:6px;background:${escapeHtml(color)}"><a href="${escapeHtml(href)}" style="display:inline-block;padding:10px 18px;font:600 15px/1 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#ffffff;text-decoration:none">${escapeHtml(label)}</a></td></tr></table>`;
}

/** Plain text from HTML (the text part when a sender gives only HTML). */
export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head|title)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, label: string) => {
      const l = label.replace(/<[^>]+>/g, "").trim();
      return l && l !== href ? `${l} (${href})` : href;
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|h[1-6]|li|table|blockquote)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Plain text → minimal HTML paragraphs (escaped; URLs left as text). */
export function textToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 12px 0">${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

export interface StoredTemplate {
  subject: string;
  html: string;
  text?: string;
  /** Wrap the html in `emailLayout` with these options. */
  layout?: LayoutOptions;
}

/** Renders a stored template: subject and text unescaped, html escaped (+ layout), text derived from html if absent. */
export function renderStored(t: StoredTemplate, data: Record<string, unknown>): { subject: string; html: string; text: string } {
  const body = renderTemplate(t.html, data);
  const html = t.layout ? emailLayout(body, { ...t.layout, ...(t.layout.preheader ? { preheader: renderTemplate(t.layout.preheader, data, { escape: false }) } : {}) }) : body;
  return {
    subject: renderTemplate(t.subject, data, { escape: false }).replace(/[\r\n]+/g, " ").trim(),
    html,
    text: t.text ? renderTemplate(t.text, data, { escape: false }) : htmlToText(body),
  };
}
