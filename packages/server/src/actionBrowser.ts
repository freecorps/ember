// Types of `ctx.browser` in actions (PLAN §13: Browser Rendering, now "Browser Run"). Implemented by
// @freecorps/ember-runtime over the `browser` binding EMBER_BROWSER (ember.json `resources.browser`), with the
// binding's Quick Actions (`binding.quickAction("pdf" | "screenshot" | "content", ...)`), so no browser library is
// bundled. For full control, `ctx.browser.binding` goes to `@cloudflare/puppeteer` (`puppeteer.launch(binding)`).

/** The page to render: an absolute http(s) URL, or an HTML document. */
export type BrowserPage = { url: string; html?: never } | { html: string; url?: never };

export interface BrowserPageOptions {
  /** Viewport (default 1280×720 — Browser Run's default). */
  viewport?: { width: number; height: number; deviceScaleFactor?: number };
  /** Navigation wait (`load`, `domcontentloaded`, `networkidle0`, `networkidle2`) and timeout in ms. */
  goto?: { waitUntil?: "load" | "domcontentloaded" | "networkidle0" | "networkidle2"; timeout?: number };
  /** Wait for a CSS selector before rendering. */
  waitForSelector?: string;
  /** Extra CSS injected into the page (e.g. print styles). */
  css?: string;
  /** Request headers for `url` (e.g. a session cookie of your own app). */
  headers?: Record<string, string>;
}

export interface BrowserPdfOptions extends BrowserPageOptions {
  format?: "letter" | "legal" | "tabloid" | "ledger" | "a0" | "a1" | "a2" | "a3" | "a4" | "a5" | "a6";
  landscape?: boolean;
  /** Print CSS backgrounds (default true). */
  printBackground?: boolean;
  margin?: { top?: string | number; right?: string | number; bottom?: string | number; left?: string | number };
  scale?: number;
  displayHeaderFooter?: boolean;
  headerTemplate?: string;
  footerTemplate?: string;
  pageRanges?: string;
  preferCSSPageSize?: boolean;
}

export interface BrowserScreenshotOptions extends BrowserPageOptions {
  type?: "png" | "jpeg" | "webp";
  /** jpeg / webp quality (0–100). */
  quality?: number;
  fullPage?: boolean;
  /** Screenshot of one element. */
  selector?: string;
  omitBackground?: boolean;
}

export interface BrowserResult {
  bytes: Uint8Array;
  contentType: string;
  /** Browser time this call consumed (`X-Browser-Ms-Used`), when reported. */
  browserMs: number | null;
}

export interface ActionBrowser {
  /** Renders the page to a PDF. */
  pdf(page: BrowserPage, opts?: BrowserPdfOptions): Promise<BrowserResult>;
  /** Screenshot of the page (PNG by default). */
  screenshot(page: BrowserPage, opts?: BrowserScreenshotOptions): Promise<BrowserResult>;
  /** The rendered HTML (after scripts ran). */
  content(page: BrowserPage, opts?: BrowserPageOptions): Promise<string>;
  /** The raw binding (`Fetcher` with `quickAction`): pass it to `@cloudflare/puppeteer` / `@cloudflare/playwright`. */
  readonly binding: unknown;
}
