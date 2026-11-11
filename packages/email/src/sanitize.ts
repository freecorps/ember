// A strict HTML sanitizer for message bodies written in an inbox composer (`bodyHtml`, signatures). No DOM: it runs
// in workerd, browsers and React Native. It is an allowlist over a small tokenizer, not a general HTML parser:
//
// - kept elements: p br div span b strong i em u s a ul ol li blockquote code pre, with no attributes except
//   `a[href]` (http:, https:, mailto:; anything else drops the href and the link, keeping its text);
// - dropped with their content: script, style, iframe, object, embed, template, head, svg, math, … (DROP_CONTENT);
// - any other element: the tag is dropped and its text kept;
// - comments, doctypes and processing instructions are dropped;
// - the output is balanced (unclosed elements are closed at the end, stray closing tags dropped), so a fragment can
//   never swallow what the caller puts after it (signature, quote).

const ALLOWED = new Set(["p", "br", "div", "span", "b", "strong", "i", "em", "u", "s", "a", "ul", "ol", "li", "blockquote", "code", "pre"]);
const VOID = new Set(["br", "img", "hr", "input", "meta", "link", "base", "area", "col", "embed", "param", "source", "track", "wbr", "keygen", "frame"]);
/** Elements whose content never reaches the output. */
const DROP_CONTENT = new Set([
  "script", "style", "iframe", "frame", "frameset", "object", "embed", "applet", "template", "head", "title", "svg",
  "math", "noscript", "noembed", "noframes", "textarea", "select", "xmp", "plaintext", "audio", "video", "canvas", "map",
  "form", "button", "datalist", "dialog",
]);
/** Elements parsed as raw text by browsers: their content ends at the first `</name`, never nests. */
const RAW_TEXT = new Set(["script", "style", "iframe", "noscript", "noembed", "noframes", "textarea", "title", "xmp", "plaintext"]);

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", colon: ":", tab: "\t", newline: "\n", sol: "/", lpar: "(", rpar: ")" };

/** Decodes the entities that matter for a URL check (numeric ones and a few named; the rest stay as written). */
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

const escAttr = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
/** Text between tags: `<`/`>` escaped, entities kept as written, a bare `&` escaped. */
const escText = (s: string) => s.replace(/&(?!#x[0-9a-f]+;|#\d+;|[a-z][a-z0-9]*;)/gi, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The href to keep: `http:`, `https:` or `mailto:` after entity decoding, with the tabs and newlines browsers ignore
 * removed and the ends trimmed (what is checked is what is written back); null for anything else.
 */
export function safeHref(raw: string): string | null {
  const v = decodeEntities(raw).replace(/[\t\n\r]/g, "").replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, "");
  return /^(https?:\/\/|mailto:)/i.test(v) ? v : null;
}

/** Parses the attributes of a tag (`src` from just after the name to the closing `>`, exclusive). */
function attributes(src: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]*)))?/g;
  for (const m of src.matchAll(re)) {
    const name = m[1]!.toLowerCase();
    if (!out.has(name)) out.set(name, m[2] ?? m[3] ?? m[4] ?? "");
  }
  return out;
}

/** End of a tag that starts at `i` (`<`): index just past its `>`, honoring quoted attribute values; -1 if none. */
function tagEnd(html: string, i: number): number {
  let q: string | null = null;
  let afterEq = false;
  for (let j = i + 1; j < html.length; j++) {
    const c = html[j]!;
    if (q) {
      if (c === q) q = null;
    } else if (c === ">") return j + 1;
    else if (c === "=") afterEq = true;
    else if (afterEq && (c === '"' || c === "'")) {
      q = c;
      afterEq = false;
    } else if (!/\s/.test(c)) afterEq = false;
  }
  return -1;
}

/**
 * Index just past the `</name …>` that closes a dropped element opened before `from` (nested ones counted), or the end.
 * `lower` is `html` lowercased once by the caller (lowercasing per call would make many dropped elements quadratic).
 */
function skipElement(html: string, lower: string, name: string, from: number): number {
  if (RAW_TEXT.has(name)) {
    const close = new RegExp(`</${name}(?=[\\s/>])`, "g");
    close.lastIndex = from;
    const m = close.exec(lower);
    if (!m) return html.length;
    const end = tagEnd(html, m.index);
    return end < 0 ? html.length : end;
  }
  const re = new RegExp(`<(/?)${name}(?=[\\s/>])`, "g");
  re.lastIndex = from;
  let depth = 1;
  for (let m = re.exec(lower); m; m = re.exec(lower)) {
    const end = tagEnd(html, m.index);
    if (end < 0) return html.length;
    if (m[1]) depth--;
    else if (!/\/\s*>$/.test(html.slice(m.index, end))) depth++;
    if (depth === 0) return end;
    re.lastIndex = end;
  }
  return html.length;
}

/**
 * Sanitizes an HTML fragment to the composer allowlist (see the top of this file). The result is a balanced fragment
 * safe to put inside an email body; text content of unknown elements is kept.
 */
export function sanitizeEmailHtml(html: string): string {
  let out = "";
  const lower = html.toLowerCase();
  const open: Array<{ name: string; emitted: boolean }> = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      out += escText(html.slice(i));
      break;
    }
    if (lt > i) out += escText(html.slice(i, lt));
    i = lt;
    if (html.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)/.exec(html.slice(i, i + 64));
    if (!m) {
      if (html[i + 1] === "!" || html[i + 1] === "?" || (html[i + 1] === "/" && i + 2 < html.length)) {
        // Doctype, CDATA, processing instruction or a bogus `</…`: browsers read it as a comment up to `>`.
        const end = html.indexOf(">", i);
        i = end < 0 ? html.length : end + 1;
      } else {
        out += "&lt;";
        i++;
      }
      continue;
    }
    const end = tagEnd(html, i);
    if (end < 0) {
      // An unterminated tag: browsers drop it with the rest of the input.
      break;
    }
    const closing = m[1] === "/";
    const name = m[2]!.toLowerCase();
    const selfClosing = html[end - 2] === "/";
    const body = html.slice(i + m[0].length, selfClosing ? end - 2 : end - 1);
    i = end;
    if (closing) {
      const at = open.map((o) => o.name).lastIndexOf(name);
      if (at < 0) continue;
      while (open.length > at) {
        const o = open.pop()!;
        if (o.emitted) out += `</${o.name}>`;
      }
      continue;
    }
    if (DROP_CONTENT.has(name)) {
      if (!VOID.has(name) && !selfClosing) i = skipElement(html, lower, name, end);
      continue;
    }
    if (!ALLOWED.has(name)) continue;
    if (name === "br") {
      out += "<br>";
      continue;
    }
    if (name === "a") {
      const href = safeHref(attributes(body).get("href") ?? "");
      open.push({ name, emitted: !!href });
      if (href) out += `<a href="${escAttr(href)}">`;
      continue;
    }
    open.push({ name, emitted: true });
    out += `<${name}>`;
  }
  while (open.length) {
    const o = open.pop()!;
    if (o.emitted) out += `</${o.name}>`;
  }
  return out;
}
