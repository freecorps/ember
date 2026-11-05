// `ctx.browser` in actions (PLAN §13): Browser Rendering ("Browser Run") through the `browser` binding EMBER_BROWSER,
// provisioned by `ember deploy` when ember.json has `resources.browser`. It uses the binding's Quick Actions
// (`quickAction("pdf" | "screenshot" | "content", options)`, compatibility_date ≥ 2026-03-24), so the Worker bundles
// no browser library; `ctx.browser.binding` is the raw binding for @cloudflare/puppeteer / @cloudflare/playwright.
//
// Limits are the account's Browser Run limits (Workers Paid: 30 quick actions/s, 200 concurrent browsers, 60 s per
// browser; Free: 1 quick action / 10 s, 10 min/day). Quick Actions have no local emulation: `ember dev --remote`
// binds the real service.

import type { ActionBrowser, BrowserPage, BrowserPageOptions, BrowserPdfOptions, BrowserResult, BrowserScreenshotOptions } from "@freecorps/ember-server";

export const BROWSER_BINDING = "EMBER_BROWSER";

/** The binding surface `ctx.browser` needs (Cloudflare's `BrowserRun` satisfies it). */
export interface BrowserBindingLike {
  quickAction(action: string, options: Record<string, unknown>): Promise<Response>;
  fetch?(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export class BrowserNotConfigured extends Error {
  readonly code = "BrowserNotConfigured";
}

export class BrowserError extends Error {
  readonly code = "BrowserError";
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function pageOptions(page: BrowserPage, o: BrowserPageOptions = {}): Record<string, unknown> {
  const hasUrl = typeof (page as { url?: unknown })?.url === "string";
  const hasHtml = typeof (page as { html?: unknown })?.html === "string";
  if (hasUrl === hasHtml) throw Object.assign(new Error("ctx.browser: pass exactly one of { url } or { html }"), { code: "ValidationError" });
  if (hasUrl && !/^https?:\/\//i.test((page as { url: string }).url)) throw Object.assign(new Error("ctx.browser: url must be an absolute http(s) URL"), { code: "ValidationError" });
  return {
    ...(hasUrl ? { url: (page as { url: string }).url } : { html: (page as { html: string }).html }),
    ...(o.viewport ? { viewport: o.viewport } : {}),
    ...(o.goto ? { gotoOptions: o.goto } : {}),
    ...(o.waitForSelector ? { waitForSelector: { selector: o.waitForSelector } } : {}),
    ...(o.css ? { addStyleTag: [{ content: o.css }] } : {}),
    ...(o.headers ? { setExtraHTTPHeaders: o.headers } : {}),
  };
}

async function failure(res: Response, action: string): Promise<BrowserError> {
  let msg = `${res.status}`;
  try {
    const body = (await res.json()) as { errors?: Array<{ message?: string; detail?: string }> };
    const e = body.errors?.[0];
    if (e) msg = `${res.status} ${e.message ?? ""}${e.detail ? ` (${e.detail})` : ""}`;
  } catch {
    // not JSON
  }
  return new BrowserError(`ctx.browser.${action}: Browser Rendering answered ${msg}${res.status === 429 ? " — rate limited (Browser Run limits per account)" : ""}`, res.status);
}

const msUsed = (res: Response) => {
  const v = Number(res.headers.get("x-browser-ms-used"));
  return Number.isFinite(v) && res.headers.has("x-browser-ms-used") ? v : null;
};

export function actionBrowser(env: Record<string, unknown>): ActionBrowser {
  const binding = (): BrowserBindingLike => {
    const b = env[BROWSER_BINDING] as BrowserBindingLike | undefined;
    if (!b) {
      throw new BrowserNotConfigured(
        `ctx.browser: no ${BROWSER_BINDING} binding (set "resources": { "browser": true } in ember.json and deploy; Browser Rendering has no local emulation: use \`ember dev --remote\`)`,
      );
    }
    if (typeof b.quickAction !== "function") {
      throw new BrowserNotConfigured(`ctx.browser: ${BROWSER_BINDING} has no quickAction() (needs compatibility_date >= 2026-03-24 in ember.json)`);
    }
    return b;
  };
  const bytes = async (action: "pdf" | "screenshot", options: Record<string, unknown>, fallbackType: string): Promise<BrowserResult> => {
    const res = await binding().quickAction(action, options);
    if (!res.ok) throw await failure(res, action);
    return { bytes: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get("content-type") ?? fallbackType, browserMs: msUsed(res) };
  };
  return {
    get binding() {
      return env[BROWSER_BINDING];
    },
    async pdf(page, o: BrowserPdfOptions = {}) {
      const { viewport: _v, goto: _g, waitForSelector: _w, css: _c, headers: _h, ...pdf } = o;
      return bytes("pdf", { ...pageOptions(page, o), pdfOptions: { printBackground: true, ...pdf } }, "application/pdf");
    },
    async screenshot(page, o: BrowserScreenshotOptions = {}) {
      const { selector, type, quality, fullPage, omitBackground } = o;
      return bytes(
        "screenshot",
        {
          ...pageOptions(page, o),
          ...(selector ? { selector } : {}),
          screenshotOptions: { type: type ?? "png", ...(quality !== undefined ? { quality } : {}), ...(fullPage ? { fullPage } : {}), ...(omitBackground ? { omitBackground } : {}) },
        },
        `image/${type ?? "png"}`,
      );
    },
    async content(page, o) {
      const res = await binding().quickAction("content", pageOptions(page, o));
      if (!res.ok) throw await failure(res, "content");
      const body = (await res.json()) as { success?: boolean; result?: unknown };
      if (typeof body.result !== "string") throw new BrowserError("ctx.browser.content: unexpected response", res.status);
      return body.result;
    },
  };
}
