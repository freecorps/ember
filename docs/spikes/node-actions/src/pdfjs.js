// pdfjs-dist text extraction without a Worker: importing the worker module first registers globalThis.pdfjsWorker,
// which pdfjs then runs in-thread ("fake worker").
import * as worker from "pdfjs-dist/legacy/build/pdf.worker.mjs";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { bytesOf, serve } from "./_serve.js";

globalThis.pdfjsWorker ??= worker;

export default serve({
  async text(env, { key }) {
    const task = pdfjs.getDocument({ data: await bytesOf(env, key), isEvalSupported: false, useSystemFonts: false, disableFontFace: true, useWorkerFetch: false });
    const doc = await task.promise;
    let chars = 0;
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      for (const it of tc.items) chars += it.str?.length ?? 0;
      page.cleanup();
    }
    const pages = doc.numPages;
    await task.destroy();
    return { pages, chars };
  },
});
