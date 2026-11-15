import JSZip from "jszip";
import { Unzip, UnzipInflate, unzipSync, zipSync, strToU8 } from "fflate";
import { row } from "./_data.js";
import { bytesOf, serve, streamOf } from "./_serve.js";

const fileText = (f) => { let s = ""; for (let i = 0; i < 100; i++) s += row(f * 100 + i).join(";") + "\n"; return s; }; // ~10 KB

export default serve({
  async jszipZip(env, { files }) {
    const z = new JSZip();
    for (let f = 0; f < files; f++) z.file(`dir/file-${f}.csv`, fileText(f));
    const out = await z.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    return { bytes: out.byteLength };
  },
  async jszipUnzip(env, { key }) {
    const z = await JSZip.loadAsync(await bytesOf(env, key));
    let chars = 0, n = 0;
    for (const f of Object.values(z.files)) if (!f.dir) { chars += (await f.async("string")).length; n++; }
    return { files: n, chars };
  },
  async fflateZip(env, { files }) {
    const input = {};
    for (let f = 0; f < files; f++) input[`dir/file-${f}.csv`] = strToU8(fileText(f));
    return { bytes: zipSync(input, { level: 6 }).byteLength };
  },
  async fflateUnzip(env, { key }) {
    const out = unzipSync(await bytesOf(env, key));
    let bytes = 0, n = 0;
    for (const v of Object.values(out)) { bytes += v.length; n++; }
    return { files: n, bytes };
  },
  // Streaming: R2 body → fflate Unzip, entries inflated chunk by chunk, nothing kept.
  async fflateStream(env, { key }) {
    let bytes = 0, n = 0;
    const uz = new Unzip((file) => { n++; file.ondata = (err, chunk) => { if (err) throw err; bytes += chunk.length; }; file.start(); });
    uz.register(UnzipInflate);
    const reader = (await streamOf(env, key)).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) { uz.push(new Uint8Array(0), true); break; }
      uz.push(value);
    }
    return { files: n, bytes };
  },
});
