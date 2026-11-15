// sheetsLast(open): the same XLSX bytes with the worksheet entries moved to the end of the zip, as a stream, without
// recompressing. exceljs' streaming reader parses a worksheet on the fly only after it has seen the shared strings and
// the workbook rels; when a worksheet comes first (usual in files Excel writes), it spools the sheet XML to a /tmp
// file, and appending to a /tmp file is quadratic in workerd (32 MiB: 1.1 s and +2 GB). Reordering avoids the spool.
//
// `open()` returns a fresh ReadableStream of the whole file each call (e.g. `(await ctx.storage.get(id)).body`), since
// ctx.storage has no range reads: pass 1 keeps only the tail (central directory), pass 2 keeps only the small
// non-worksheet entries, pass 3 streams the worksheets through. Memory: the non-worksheet entries, compressed.
// Zip64 (files over 4 GiB) is not handled.

const TAIL = 1 << 20;

async function forEachChunk(stream, fn) {
  const reader = stream.getReader();
  let pos = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return pos;
    await fn(value, pos);
    pos += value.length;
  }
}

function centralDirectory(tail, fileSize) {
  const dv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("not a zip file (no end of central directory)");
  const count = dv.getUint16(eocd + 10, true);
  const cdOffset = dv.getUint32(eocd + 16, true);
  const tailStart = fileSize - tail.length;
  if (cdOffset === 0xffffffff) throw new Error("zip64 is not supported");
  if (cdOffset < tailStart) throw new Error("central directory larger than the tail kept");
  const entries = [];
  for (let i = 0, p = cdOffset - tailStart; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("bad central directory entry");
    const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
    const name = new TextDecoder().decode(tail.subarray(p + 46, p + 46 + nameLen));
    entries.push({ name, start: dv.getUint32(p + 42, true) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  entries.sort((a, b) => a.start - b.start);
  entries.forEach((e, i) => (e.end = i + 1 < entries.length ? entries[i + 1].start : cdOffset));
  // The original central directory + end record go last: stream parsers stop at its signature (its offsets are those
  // of the original order, which they do not read). Without it unzipper may hit FILE_ENDED looking for the next header.
  return { entries, trailer: tail.slice(cdOffset - tailStart) };
}

/** Copies the bytes of [start, end) out of a chunk at absolute position `pos`. */
const overlap = (chunk, pos, start, end) => chunk.subarray(Math.max(0, start - pos), Math.max(0, Math.min(chunk.length, end - pos)));

export async function sheetsLast(open) {
  // Pass 1: keep the last TAIL bytes.
  const recent = [];
  let kept = 0;
  const size = await forEachChunk(await open(), (c) => {
    recent.push(c);
    kept += c.length;
    while (kept - recent[0].length >= TAIL) kept -= recent.shift().length;
  });
  const tail = new Uint8Array(kept);
  recent.reduce((at, c) => (tail.set(c, at), at + c.length), 0);
  const { entries, trailer } = centralDirectory(tail, size);
  const isSheet = (e) => e.name.startsWith("xl/worksheets/") && !e.name.includes("/_rels/");
  const front = entries.filter((e) => !isSheet(e));
  const sheets = entries.filter(isSheet);
  // Pass 2: the non-worksheet entries, raw.
  const parts = front.map((e) => ({ e, chunks: [] }));
  await forEachChunk(await open(), (c, pos) => {
    for (const p of parts) if (p.e.start < pos + c.length && p.e.end > pos) p.chunks.push(overlap(c, pos, p.e.start, p.e.end).slice());
  });
  // Pass 3: those first, then the worksheets as they stream by (they keep their order in the file).
  let reader;
  let pos = 0;
  let queued = parts.flatMap((p) => p.chunks);
  return new ReadableStream({
    async pull(ctrl) {
      if (queued.length) return ctrl.enqueue(queued.shift());
      reader ??= (await open()).getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          ctrl.enqueue(trailer);
          return ctrl.close();
        }
        const at = pos;
        pos += value.length;
        for (const s of sheets) {
          const piece = overlap(value, at, s.start, s.end);
          if (piece.length) ctrl.enqueue(piece);
        }
        if (ctrl.desiredSize <= 0) return;
      }
    },
  });
}
