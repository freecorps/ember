// ctx.browser (PLAN §13): option mapping onto the binding's quick actions, errors, the binding passthrough.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ActionRunner, actionBrowser, BROWSER_BINDING, type BrowserBindingLike, type ShardApi } from "../src/index.ts";
import { config } from "./worker.ts";
import { shardStub } from "./helpers.ts";

function fakeBrowser(answer: (action: string, o: Record<string, unknown>) => Response) {
  const calls: Array<{ action: string; options: Record<string, unknown> }> = [];
  const binding: BrowserBindingLike = {
    async quickAction(action, options) {
      calls.push({ action, options });
      return answer(action, options);
    },
  };
  return { binding, calls };
}

const PDF = new TextEncoder().encode("%PDF-1.7 fake");

describe("ctx.browser", () => {
  it("pdf: html → quickAction('pdf') with printBackground and page options; bytes, type and browser ms", async () => {
    const f = fakeBrowser(() => new Response(PDF, { headers: { "content-type": "application/pdf", "x-browser-ms-used": "812" } }));
    const b = actionBrowser({ [BROWSER_BINDING]: f.binding });
    const r = await b.pdf({ html: "<h1>Fatura</h1>" }, { format: "a4", margin: { top: "1cm" }, css: "h1{color:red}", viewport: { width: 800, height: 600 }, goto: { waitUntil: "networkidle0" } });
    expect(r).toEqual({ bytes: PDF, contentType: "application/pdf", browserMs: 812 });
    expect(f.calls).toEqual([
      {
        action: "pdf",
        options: {
          html: "<h1>Fatura</h1>",
          viewport: { width: 800, height: 600 },
          gotoOptions: { waitUntil: "networkidle0" },
          addStyleTag: [{ content: "h1{color:red}" }],
          pdfOptions: { printBackground: true, format: "a4", margin: { top: "1cm" } },
        },
      },
    ]);
  });

  it("screenshot and content map their options; url must be absolute; exactly one of url/html", async () => {
    const f = fakeBrowser((a) => (a === "content" ? Response.json({ success: true, result: "<html>ok</html>" }) : new Response(new Uint8Array([137, 80]), { headers: { "content-type": "image/png" } })));
    const b = actionBrowser({ [BROWSER_BINDING]: f.binding });
    const shot = await b.screenshot({ url: "https://example.com" }, { fullPage: true, selector: "#chart", waitForSelector: "#chart", headers: { cookie: "a=1" } });
    expect(shot).toMatchObject({ contentType: "image/png", browserMs: null });
    expect(f.calls[0]).toEqual({
      action: "screenshot",
      options: { url: "https://example.com", waitForSelector: { selector: "#chart" }, setExtraHTTPHeaders: { cookie: "a=1" }, selector: "#chart", screenshotOptions: { type: "png", fullPage: true } },
    });
    expect(await b.content({ url: "https://example.com" })).toBe("<html>ok</html>");
    await expect(b.pdf({ url: "/relative" })).rejects.toThrow(/absolute http\(s\) URL/);
    await expect(b.pdf({ url: "https://x", html: "y" } as any)).rejects.toThrow(/exactly one/);
    expect(b.binding).toBe(f.binding);
  });

  it("errors: service failures carry the status and message; no binding is BrowserNotConfigured", async () => {
    const f = fakeBrowser(() => Response.json({ success: false, errors: [{ message: "Rate limit exceeded" }] }, { status: 429 }));
    await expect(actionBrowser({ [BROWSER_BINDING]: f.binding }).pdf({ html: "x" })).rejects.toMatchObject({ code: "BrowserError", status: 429, message: expect.stringMatching(/429 Rate limit exceeded.*rate limited/) });
    await expect(actionBrowser({}).pdf({ html: "x" })).rejects.toMatchObject({ code: "BrowserNotConfigured", message: expect.stringMatching(/resources.*browser.*ember dev --remote/) });
    await expect(actionBrowser({ [BROWSER_BINDING]: { fetch: () => null } }).pdf({ html: "x" })).rejects.toThrow(/compatibility_date >= 2026-03-24/);
  });

  it("is on every action ctx (bound to the Worker env)", async () => {
    const f = fakeBrowser(() => new Response(PDF, { headers: { "content-type": "application/pdf" } }));
    const ctx = new ActionRunner(config, { ...(env as any), [BROWSER_BINDING]: f.binding }, (s) => shardStub(s) as unknown as ShardApi).ctx("global:main", null);
    expect((await ctx.browser.pdf({ html: "<p>x</p>" })).bytes).toEqual(PDF);
  });
});
