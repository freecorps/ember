import Papa from "papaparse";
import { Readable } from "node:stream";
import { batchSink, bytesOf, serve, streamOf } from "./_serve.js";

export default serve({
  async parse(env, { key }) {
    const text = new TextDecoder().decode(await bytesOf(env, key));
    const res = Papa.parse(text, { dynamicTyping: true, skipEmptyLines: true });
    return { rows: res.data.length, errors: res.errors.length };
  },
  // Recipe: R2 stream → text → papaparse step by step, paused while each batch goes to the shard.
  async stream(env, { key, batch = 500 }) {
    const sink = batchSink(batch);
    let pending = [];
    const text = Readable.fromWeb((await streamOf(env, key)).pipeThrough(new TextDecoderStream()));
    await new Promise((resolve, reject) => {
      Papa.parse(text, {
        dynamicTyping: true,
        skipEmptyLines: true,
        step(res, parser) {
          pending.push(res.data);
          if (pending.length < batch) return;
          parser.pause();
          const rows = pending;
          pending = [];
          sink.write(rows).then(() => parser.resume(), reject);
        },
        complete: resolve,
        error: reject,
      });
    });
    await sink.write(pending);
    return sink.stats;
  },
});
