// exceljs, default entry. In Ember's bundle (mainFields browser first) this is dist/exceljs.min.js: no streaming API.
import ExcelJS from "exceljs";
import { HEADERS, row } from "./_data.js";
import { bytesOf, serve } from "./_serve.js";

export default serve({
  async write(env, { rows }) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("data");
    ws.addRow(HEADERS);
    for (let i = 0; i < rows; i++) ws.addRow(row(i));
    const buf = await wb.xlsx.writeBuffer();
    return { bytes: buf.byteLength };
  },
  async read(env, { key }) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await bytesOf(env, key));
    let n = 0, sum = 0;
    wb.worksheets[0].eachRow((r) => {
      n++;
      const v = r.getCell(15).value;
      if (typeof v === "number") sum += v;
    });
    return { rows: n, sum: Math.round(sum) };
  },
  hasStream: async () => ({ stream: typeof ExcelJS.stream?.xlsx?.WorkbookReader }),
});
