import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { row } from "./_data.js";
import { bytesOf, serve } from "./_serve.js";

export default serve({
  // N pages of an invoice-like table (40 lines each, Helvetica).
  async generate(env, { pages }) {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    let i = 0;
    for (let p = 0; p < pages; p++) {
      const page = doc.addPage([595, 842]);
      page.drawText(`Report page ${p + 1}`, { x: 40, y: 800, size: 16, font });
      for (let l = 0; l < 40; l++, i++) {
        const r = row(i);
        page.drawText(`${r[0]}  ${r[2]}  ${r[5]}  ${r[14]}`, { x: 40, y: 770 - l * 18, size: 9, font, color: rgb(0.1, 0.1, 0.1) });
      }
    }
    const bytes = await doc.save();
    return { bytes: bytes.byteLength };
  },
  async stamp(env, { key }) {
    const doc = await PDFDocument.load(await bytesOf(env, key));
    const font = await doc.embedFont(StandardFonts.HelveticaBold);
    for (const page of doc.getPages()) page.drawText("PAID", { x: 450, y: 810, size: 20, font, color: rgb(0.8, 0, 0) });
    return { pages: doc.getPageCount(), bytes: (await doc.save()).byteLength };
  },
});
