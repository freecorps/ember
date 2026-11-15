import * as XLSX from "sheetjs";
import { HEADERS, row } from "./_data.js";
import { bytesOf, serve } from "./_serve.js";

function readWith(opts) {
  return async (env, { key }) => {
    const wb = XLSX.read(await bytesOf(env, key), { type: "array", ...opts });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const range = XLSX.utils.decode_range(ws["!ref"]);
    let sum = 0;
    if (ws["!data"]) for (const r of ws["!data"]) { const c = r?.[14]; if (typeof c?.v === "number") sum += c.v; }
    else for (let R = 1; R <= range.e.r; R++) { const c = ws[XLSX.utils.encode_cell({ r: R, c: 14 })]; if (typeof c?.v === "number") sum += c.v; }
    return { rows: range.e.r + 1, sum: Math.round(sum), dense: !!ws["!data"] };
  };
}

export default serve({
  read: readWith({}),
  readDense: readWith({ dense: true }),
  async write(env, { rows }) {
    const aoa = [HEADERS];
    for (let i = 0; i < rows; i++) aoa.push(row(i));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa, { dense: true }), "data");
    const out = XLSX.write(wb, { type: "array", bookType: "xlsx", compression: true });
    return { bytes: out.byteLength };
  },
  async csv(env, { key }) {
    const wb = XLSX.read(await bytesOf(env, key), { type: "array", dense: true });
    return { chars: XLSX.utils.sheet_to_csv(wb.Sheets[wb.SheetNames[0]]).length };
  },
});
