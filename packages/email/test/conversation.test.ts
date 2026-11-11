import { describe, expect, test } from "vitest";
import { conversationEmail, conversationLayout, defaultQuoteHeader, emailLayout, linkify, safeHref, sanitizeEmailHtml as clean, textToHtml } from "../src/index.ts";

const CARD = ["border-top:4px", "background:#f4f5f7", "max-width:600px", "border-radius"];

describe("conversationLayout", () => {
  test("a plain document: color-scheme metas, system font, no card, background or text color", () => {
    const html = conversationLayout("<p>Hi</p>");
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('<meta name="viewport" content="width=device-width,initial-scale=1">');
    expect(html).toContain('<meta name="color-scheme" content="light dark">');
    expect(html).toContain('<meta name="supported-color-schemes" content="light dark">');
    expect(html).toContain("<body><div style=\"font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5\"><p>Hi</p></div></body>");
    for (const c of CARD) expect(html).not.toContain(c);
    expect(html).not.toMatch(/background|[^-]color:|<table/);
  });

  test("emailLayout (transactional) keeps its card", () => {
    const html = emailLayout("<p>x</p>");
    for (const c of CARD) expect(html).toContain(c);
  });
});

describe("plain text to HTML", () => {
  test("textToHtml keeps its output for existing callers; autolink is opt-in", () => {
    expect(textToHtml("a https://x.test\n\nb")).toBe('<p style="margin:0 0 12px 0">a https://x.test</p><p style="margin:0 0 12px 0">b</p>');
    expect(textToHtml("a https://x.test\nb", { autolink: true })).toBe('<p style="margin:0 0 12px 0">a <a href="https://x.test">https://x.test</a><br>b</p>');
  });

  test("linkify: http(s) and mailto, escaped, trailing punctuation left out", () => {
    expect(linkify("See https://a.test/x?y=1&z=2.")).toBe('See <a href="https://a.test/x?y=1&amp;z=2">https://a.test/x?y=1&amp;z=2</a>.');
    expect(linkify("(https://b.test/p_(q)) and (http://c.test)")).toBe('(<a href="https://b.test/p_(q)">https://b.test/p_(q)</a>) and (<a href="http://c.test">http://c.test</a>)');
    expect(linkify("mail mailto:ana@acme.test, or <https://d.test>")).toBe('mail <a href="mailto:ana@acme.test">mailto:ana@acme.test</a>, or &lt;<a href="https://d.test">https://d.test</a>&gt;');
    expect(linkify('x https://e.test/"><script>')).toBe('x <a href="https://e.test/">https://e.test/</a>&quot;&gt;&lt;script&gt;');
    expect(linkify("javascript:alert(1) ftp://f.test http:// <b>")).toBe("javascript:alert(1) ftp://f.test http:// &lt;b&gt;");
  });
});

describe("sanitizeEmailHtml", () => {
  test("keeps the allowlist without attributes", () => {
    const all = "<p>p<br><div>d</div><span>s</span><b>b</b><strong>st</strong><i>i</i><em>e</em><u>u</u><s>x</s><code>c</code><pre>pre</pre></p><ul><li>1</li></ul><ol><li>2</li></ol><blockquote>q</blockquote>";
    expect(clean(all)).toBe(all);
    expect(clean('<p style="color:red" class="x" onclick="steal()" id=a dir=rtl>Hi <b data-x=1 onmouseover=x>there</b></p>')).toBe("<p>Hi <b>there</b></p>");
    expect(clean("<P><B>Up</B></P><BR/>")).toBe("<p><b>Up</b></p><br>");
  });

  test("links: http, https and mailto only; the href is decoded, trimmed and re-escaped", () => {
    expect(clean('<a href="https://a.test/?q=1&amp;b=2" target="_blank" rel="x" style="color:red">y</a>')).toBe('<a href="https://a.test/?q=1&amp;b=2">y</a>');
    expect(clean("<a href=' mailto:ana@acme.test '>m</a><a href=HTTP://b.test>b</a>")).toBe('<a href="mailto:ana@acme.test">m</a><a href="HTTP://b.test">b</a>');
    for (const bad of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", " javascript:alert(1)", "jav&#x09;ascript:alert(1)", "jav\tascript:alert(1)", "&#106;avascript:alert(1)", "&#x6A;avascript:alert(1)", "vbscript:x", "data:text/html,<script>alert(1)</script>", "file:///etc/passwd", "//evil.test", "/relative", "#top", "cid:logo", ""]) {
      expect(clean(`<a href="${bad.replace(/"/g, "&quot;")}">t</a>`)).toBe("t");
    }
    expect(clean("<a>no href</a>")).toBe("no href");
    expect(clean('<a href="https://x.test/"onmouseover="alert(1)">x</a>')).toBe('<a href="https://x.test/">x</a>');
    expect(safeHref("https://x.test/a b")).toBe("https://x.test/a b");
    expect(clean('<a href="https://x.test/&quot;&gt;&lt;script&gt;">x</a>')).toBe('<a href="https://x.test/&quot;&gt;&lt;script&gt;">x</a>');
  });

  test("dangerous elements go with their content; unknown ones keep their text", () => {
    expect(clean("<script>alert(1)</script>ok<style>p{color:red}</style><SCRIPT type=module>x()</SCRIPT >")).toBe("ok");
    expect(clean('<iframe src="https://evil.test">inner</iframe><object data=x><p>o</p></object><embed src=x>after')).toBe("after");
    expect(clean("<svg><script>1</script><p>in svg</p><svg></svg></svg>after<math><mi>x</mi></math>")).toBe("after");
    expect(clean("<template><p>t</p></template><textarea><p>x</p></textarea><title>t</title>done")).toBe("done");
    expect(clean('<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>')).not.toMatch(/<img|onerror=/);
    expect(clean("<h1>Title</h1><table><tr><td>cell</td></tr></table><font color=red>f</font><center>c</center>")).toBe("Titlecellfc");
    expect(clean('<img src="https://track.test/p.gif" onerror="alert(1)"><hr><input value=x><form action=x><button>b</button></form>x')).toBe("x");
    expect(clean("<script>never closed <p>a</p>")).toBe("");
  });

  test("text is escaped, entities kept, comments and doctypes dropped", () => {
    expect(clean("a < b > c & d &amp; &eacute; &#233; <!-- <script>x</script> --> <!doctype html><?php x ?><![CDATA[y]]>")).toBe("a &lt; b &gt; c &amp; d &amp; &eacute; &#233;  ");
    expect(clean("<scr<script>ipt>alert(1)</script>")).not.toMatch(/<script|<scr/i);
    expect(clean("<p>unterminated <b title='x>")).toBe("<p>unterminated </p>");
    expect(clean("<!-- never closed <script>")).toBe("");
    expect(clean("1 </ 2 > <3 </")).toBe("1  &lt;3 &lt;/");
  });

  test("many dropped elements stay linear (no rescan of the whole input per element)", () => {
    const html = "<svg></svg>x".repeat(16_000);
    const t = performance.now();
    expect(clean(html)).toBe("x".repeat(16_000));
    expect(performance.now() - t).toBeLessThan(1_000);
  });

  test("the output is balanced: a fragment cannot swallow what follows it", () => {
    expect(clean("<blockquote><div>unclosed")).toBe("<blockquote><div>unclosed</div></blockquote>");
    expect(clean("</div></blockquote><b>x</p>y")).toBe("<b>xy</b>");
    expect(clean("<b><i>x</b>y</i>")).toBe("<b><i>x</i></b>y");
    expect(clean('<a href="https://x.test">a<a href="data:x">b</a>c</a>')).toBe('<a href="https://x.test">abc</a>');
  });
});

describe("conversationEmail", () => {
  const quote = { header: "Em 5 de nov. de 2026, Marina Costa escreveu:", text: "Oi,\n\nO pedido não chegou." };

  test("text body: autolinked paragraphs, signature after the body, Gmail quote last", () => {
    const r = conversationEmail({ text: "Hi Marina,\n\nTrack it at https://acme.test/t/1.", signature: { text: "Bia\nAcme Support" }, quote });
    expect(r.text).toBe("Hi Marina,\n\nTrack it at https://acme.test/t/1.\n\n-- \nBia\nAcme Support\n\nEm 5 de nov. de 2026, Marina Costa escreveu:\n\n> Oi,\n>\n> O pedido não chegou.");
    expect(r.html).toContain('<a href="https://acme.test/t/1">https://acme.test/t/1</a>.');
    expect(r.html).toContain('<span class="gmail_signature_prefix">-- </span><br><div class="gmail_signature" data-smartmail="gmail_signature">Bia<br>Acme Support</div>');
    expect(r.html).toContain(
      '<div class="gmail_quote"><div class="gmail_attr">Em 5 de nov. de 2026, Marina Costa escreveu:<br></div><blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex"><p style="margin:0 0 12px 0">Oi,</p><p style="margin:0 0 12px 0">O pedido não chegou.</p></blockquote></div>',
    );
    expect(r.html.indexOf("gmail_signature")).toBeLessThan(r.html.indexOf("gmail_quote"));
    for (const c of CARD) expect(r.html).not.toContain(c);
  });

  test("rich body and HTML signature as given (already sanitized); no signature or quote when absent", () => {
    const r = conversationEmail({ text: "Hi", bodyHtml: "<p><b>Hi</b></p>", signature: { text: "Bia", html: "<i>Bia</i>" } });
    expect(r.html).toContain('<p><b>Hi</b></p><span class="gmail_signature_prefix">-- </span><br><div class="gmail_signature" data-smartmail="gmail_signature"><i>Bia</i></div>');
    expect(r.text).toBe("Hi\n\n-- \nBia");
    const plain = conversationEmail({ text: "Just this" });
    expect(plain.text).toBe("Just this");
    expect(plain.html).not.toMatch(/gmail_|-- /);
    expect(conversationEmail({ text: "x", signature: { text: "  " } }).html).not.toContain("gmail_signature");
  });

  test("quote header: escaped in HTML, one line; the default is English", () => {
    const r = conversationEmail({ text: "x", quote: { header: "On <b>today</b>,\r\nEve wrote:", text: "<script>" } });
    expect(r.html).toContain('<div class="gmail_attr">On &lt;b&gt;today&lt;/b&gt;, Eve wrote:<br></div>');
    expect(r.html).toContain("&lt;script&gt;");
    expect(r.text).toContain("\n\nOn <b>today</b>, Eve wrote:\n\n> <script>");
    expect(defaultQuoteHeader(Date.UTC(2026, 10, 5, 14, 30), { email: "marina@user.test", name: "Marina Costa" })).toBe("On Thu, 05 Nov 2026 14:30:00 GMT, Marina Costa <marina@user.test> wrote:");
    expect(defaultQuoteHeader(0, { email: "a@b.test" })).toBe("On Thu, 01 Jan 1970 00:00:00 GMT, a@b.test wrote:");
  });
});
