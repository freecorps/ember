// A plain Worker around a map of workloads: GET /run?w=<name>&p=<json>. `env.FILES` is an R2 bucket (in Node, an fs
// shim with the same get/put surface). Results are JSON; errors come back as {ok:false,error} so the harness can tell
// a library failure from an isolate crash (connection reset).
export function memInfo() {
  try {
    const m = globalThis.process?.memoryUsage?.();
    return m ? { heapUsed: m.heapUsed, rss: m.rss, external: m.external, arrayBuffers: m.arrayBuffers } : null;
  } catch (e) {
    return { error: String(e) };
  }
}

export function serve(workloads) {
  return {
    workloads,
    async fetch(request, env) {
      const url = new URL(request.url);
      if (url.pathname === "/health") return new Response("ok");
      if (url.pathname === "/list") return Response.json(Object.keys(workloads));
      // Harness upload for big fixtures (miniflare's R2 proxy fails around 100 MB): streamed into R2.
      if (url.pathname === "/put" && request.method === "PUT") {
        const key = url.searchParams.get("key");
        if (!(await env.FILES.head(key))) await env.FILES.put(key, request.body);
        return new Response("ok");
      }
      const name = url.searchParams.get("w");
      const params = JSON.parse(url.searchParams.get("p") ?? "{}");
      const fn = workloads[name];
      if (!fn) return Response.json({ ok: false, error: `unknown workload ${name}` }, { status: 404 });
      const t0 = performance.now();
      try {
        const result = await fn(env, params);
        return Response.json({ ok: true, innerMs: performance.now() - t0, result, mem: memInfo() });
      } catch (e) {
        return Response.json({ ok: false, innerMs: performance.now() - t0, error: String(e?.stack ?? e).slice(0, 1500) });
      }
    },
  };
}

/** Reads an R2 object (or the Node shim's) fully. */
export async function bytesOf(env, key) {
  const obj = await env.FILES.get(key);
  if (!obj) throw new Error(`fixture ${key} missing`);
  return new Uint8Array(await obj.arrayBuffer());
}

export async function streamOf(env, key) {
  const obj = await env.FILES.get(key);
  if (!obj) throw new Error(`fixture ${key} missing`);
  return obj.body;
}

/** Stand-in for `ctx.runMutation(internal.import.insertBatch, { rows })`: counts batches and their JSON size. */
export function batchSink(batchSize = 500) {
  let buf = [];
  const stats = { rows: 0, batches: 0, maxBatchBytes: 0 };
  const flush = async () => {
    if (!buf.length) return;
    const bytes = JSON.stringify(buf).length;
    stats.maxBatchBytes = Math.max(stats.maxBatchBytes, bytes);
    stats.batches++;
    stats.rows += buf.length;
    buf = [];
    await Promise.resolve(); // the real call is an RPC; yielding here keeps the shape (and lets GC run between batches)
  };
  return {
    stats,
    /** One whole batch (already sized by the caller). */
    async write(rows) {
      buf.push(...rows);
      await flush();
    },
    async push(r) {
      buf.push(r);
      if (buf.length >= batchSize) await flush();
    },
    flush,
  };
}
