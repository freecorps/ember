// exceljs streaming reader/writer: only in the Node entry (lib/exceljs.nodejs.js), which requires fs, stream, events,
// unzipper and tmp by bare specifier.
import ExcelJS from "exceljs/lib/exceljs.nodejs.js";
import { Buffer } from "node:buffer";
import { PassThrough, Readable } from "node:stream";
import { HEADERS, row } from "./_data.js";
import { batchSink, bytesOf, serve, streamOf } from "./_serve.js";
import { sheetsLast } from "./xlsx-sheets-last.js";

async function readStream(input, batch) {
  const sink = batchSink(batch);
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(input, { sharedStrings: "cache", worksheets: "emit", styles: "ignore", hyperlinks: "ignore", entries: "ignore" });
  for await (const ws of reader) for await (const r of ws) await sink.push(r.values);
  await sink.flush();
  return sink.stats;
}

export default serve({
  async read(env, { key, batch = 500 }) {
    const sink = batchSink(batch);
    const input = Readable.fromWeb(await streamOf(env, key));
    const reader = new ExcelJS.stream.xlsx.WorkbookReader(input, { sharedStrings: "cache", worksheets: "emit", styles: "ignore", hyperlinks: "ignore", entries: "ignore" });
    for await (const ws of reader) for await (const r of ws) await sink.push(r.values);
    await sink.flush();
    return sink.stats;
  },
  // Diagnosis: same reader, input as one Buffer or as 64 KiB chunks (Node's fs.createReadStream size), not R2's.
  async readChunked(env, { key, chunk = 65536, batch = 500 }) {
    const bytes = await bytesOf(env, key);
    const sink = batchSink(batch);
    const input = Readable.from((function* () { for (let i = 0; i < bytes.length; i += chunk) yield Buffer.from(bytes.buffer, bytes.byteOffset + i, Math.min(chunk, bytes.length - i)); })());
    const reader = new ExcelJS.stream.xlsx.WorkbookReader(input, { sharedStrings: "cache", worksheets: "emit", styles: "ignore", hyperlinks: "ignore", entries: "ignore" });
    for await (const ws of reader) for await (const r of ws) await sink.push(r.values);
    await sink.flush();
    return sink.stats;
  },
  // Recipe: worksheets moved to the end of the zip (3 passes over the R2 body, no recompression), then streamed.
  async readSheetsLast(env, { key, batch = 500 }) {
    return readStream(Readable.fromWeb(await sheetsLast(() => streamOf(env, key))), batch);
  },
  async write(env, { rows }) {
    const out = new PassThrough();
    let bytes = 0;
    out.on("data", (c) => (bytes += c.length));
    const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: out, useSharedStrings: false, useStyles: false });
    const ws = wb.addWorksheet("data");
    ws.addRow(HEADERS).commit();
    for (let i = 0; i < rows; i++) {
      ws.addRow(row(i)).commit();
      if (i % 1000 === 0) await new Promise((r) => setTimeout(r, 0));
    }
    ws.commit();
    await wb.commit();
    return { bytes };
  },
});
