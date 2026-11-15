// Inputs generated in Node, once, into .tmp/fixtures (git-ignored): XLSX (shared strings, as Excel writes them),
// CSV, PDF and ZIP of a given size.
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { once } from "node:events";
import ExcelJS from "exceljs";
import { strToU8, zipSync } from "fflate";
import { FIXTURES, hasFixture } from "./harness.mjs";
import { HEADERS, csvLine, row } from "./src/_data.js";


mkdirSync(FIXTURES, { recursive: true });

export async function ensureXlsx(n) {
  const name = `rows-${n}.xlsx`;
  if (hasFixture(name)) return name;
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: join(FIXTURES, name), useSharedStrings: true, useStyles: false });
  const ws = wb.addWorksheet("data");
  ws.addRow(HEADERS).commit();
  for (let i = 0; i < n; i++) ws.addRow(row(i)).commit();
  ws.commit();
  await wb.commit();
  return name;
}

export async function ensureCsv(n) {
  const name = `rows-${n}.csv`;
  if (hasFixture(name)) return name;
  const out = createWriteStream(join(FIXTURES, name));
  out.write(csvLine(HEADERS) + "\n");
  for (let i = 0; i < n; i++) if (!out.write(csvLine(row(i)) + "\n")) await once(out, "drain");
  out.end();
  await once(out, "finish");
  return name;
}

export async function ensurePdf(pages) {
  const name = `pages-${pages}.pdf`;
  if (hasFixture(name)) return name;
  // Reuse the pdf-lib workload to make the bytes (Node run).
  const { PDFDocument, StandardFonts } = await import("pdf-lib");
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  let i = 0;
  for (let p = 0; p < pages; p++) {
    const page = doc.addPage([595, 842]);
    for (let l = 0; l < 40; l++, i++) { const r = row(i); page.drawText(`${r[0]}  ${r[2]}  ${r[5]}  ${r[14]}`, { x: 40, y: 790 - l * 18, size: 9, font }); }
  }
  writeFileSync(join(FIXTURES, name), await doc.save());

  return name;
}

export async function ensureZip(files) {
  const name = `files-${files}.zip`;
  if (hasFixture(name)) return name;
  const input = {};
  for (let f = 0; f < files; f++) { let s = ""; for (let i = 0; i < 100; i++) s += row(f * 100 + i).join(";") + "\n"; input[`dir/file-${f}.csv`] = strToU8(s); }
  writeFileSync(join(FIXTURES, name), zipSync(input, { level: 6 }));
  return name;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [kind, n] = process.argv.slice(2);
  const t0 = performance.now();
  const name = await { xlsx: ensureXlsx, csv: ensureCsv, pdf: ensurePdf, zip: ensureZip }[kind](Number(n));
  console.log(name, Math.round(performance.now() - t0), "ms");
}
