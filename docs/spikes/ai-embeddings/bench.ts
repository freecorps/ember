// Embedding model comparison on pt-BR (PLAN §6 test 11 / §18 R10). Runs against Workers AI through the REST API
// (`POST /accounts/:id/ai/run/:model`), with the token from the CLI's lookup (CLOUDFLARE_API_TOKEN or the wrangler
// OAuth token). Nothing secret is printed: the account id and token stay in memory.
//
//   bun run docs/spikes/ai-embeddings/bench.ts > docs/spikes/ai-embeddings/evidence/run.json
//
// Metrics per model variant: Recall@1, Recall@3, MRR@10 over 30 queries with one relevant document each (30 docs),
// cosine similarity; dimensions; client-side latency of one batch call (includes Brazil -> Cloudflare RTT). A BM25
// baseline (the same tokenizer as `.searchIndex()`, no stemming) shows how much the set needs semantics.

import { resolveToken } from "../../../packages/cli/src/deploy/cf.ts";
import { tokenize } from "../../../packages/server/src/search.ts";
import { docs, queries } from "./dataset.ts";

const token = resolveToken();
const auth = { authorization: `Bearer ${token}` };
const accounts = (await (await fetch("https://api.cloudflare.com/client/v4/accounts", { headers: auth })).json()) as { result: Array<{ id: string }> };
const account = process.env.CLOUDFLARE_ACCOUNT_ID ?? accounts.result[0]!.id;

async function run(model: string, input: Record<string, unknown>): Promise<{ vectors: number[][]; ms: number }> {
  for (let attempt = 0; ; attempt++) {
    const t = performance.now();
    const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${model}`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    const ms = performance.now() - t;
    const body = (await res.json()) as { success: boolean; result?: { data?: number[][]; response?: number[][] }; errors?: unknown };
    if (body.success) return { vectors: (body.result?.data ?? body.result?.response)!, ms };
    if (attempt >= 3) throw new Error(`${model}: ${JSON.stringify(body.errors)}`);
    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
  }
}

type Variant = {
  name: string;
  model: string;
  embedDocs(texts: string[]): Promise<{ vectors: number[][]; ms: number }>;
  embedQueries(texts: string[]): Promise<{ vectors: number[][]; ms: number }>;
};

const chunks = <T,>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));
async function batched(texts: string[], max: number, f: (part: string[]) => Promise<{ vectors: number[][]; ms: number }>) {
  const out: number[][] = [];
  let ms = 0;
  for (const part of chunks(texts, max)) {
    const r = await f(part);
    out.push(...r.vectors);
    ms = Math.max(ms, r.ms);
  }
  return { vectors: out, ms };
}

const variants: Variant[] = [
  {
    name: "bge-m3",
    model: "@cf/baai/bge-m3",
    embedDocs: (t) => batched(t, 100, (p) => run("@cf/baai/bge-m3", { text: p })),
    embedQueries: (t) => batched(t, 100, (p) => run("@cf/baai/bge-m3", { text: p })),
  },
  {
    name: "qwen3-embedding-0.6b (queries+instruction / documents)",
    model: "@cf/qwen/qwen3-embedding-0.6b",
    embedDocs: (t) => batched(t, 32, (p) => run("@cf/qwen/qwen3-embedding-0.6b", { documents: p })),
    embedQueries: (t) => batched(t, 32, (p) => run("@cf/qwen/qwen3-embedding-0.6b", { queries: p })),
  },
  {
    name: "qwen3-embedding-0.6b (raw text, no instruction)",
    model: "@cf/qwen/qwen3-embedding-0.6b",
    embedDocs: (t) => batched(t, 32, (p) => run("@cf/qwen/qwen3-embedding-0.6b", { text: p })),
    embedQueries: (t) => batched(t, 32, (p) => run("@cf/qwen/qwen3-embedding-0.6b", { text: p })),
  },
  {
    name: "embeddinggemma-300m (search prompts)",
    model: "@cf/google/embeddinggemma-300m",
    embedDocs: (t) => batched(t, 100, (p) => run("@cf/google/embeddinggemma-300m", { text: p.map((x) => `title: none | text: ${x}`) })),
    embedQueries: (t) => batched(t, 100, (p) => run("@cf/google/embeddinggemma-300m", { text: p.map((x) => `task: search result | query: ${x}`) })),
  },
  {
    name: "embeddinggemma-300m (raw text)",
    model: "@cf/google/embeddinggemma-300m",
    embedDocs: (t) => batched(t, 100, (p) => run("@cf/google/embeddinggemma-300m", { text: p })),
    embedQueries: (t) => batched(t, 100, (p) => run("@cf/google/embeddinggemma-300m", { text: p })),
  },
];

const cosine = (a: number[], b: number[]) => {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    d += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return d / (Math.sqrt(na) * Math.sqrt(nb));
};

function score(ranked: string[][]) {
  let r1 = 0, r3 = 0, mrr = 0;
  const misses: Array<{ q: string; rank: number | null; top: string }> = [];
  ranked.forEach((ids, i) => {
    const rel = queries[i]!.rel;
    const rank = ids.indexOf(rel);
    if (rank === 0) r1++;
    if (rank >= 0 && rank < 3) r3++;
    if (rank >= 0 && rank < 10) mrr += 1 / (rank + 1);
    if (rank !== 0) misses.push({ q: queries[i]!.q, rank: rank < 0 ? null : rank + 1, top: ids[0]! });
  });
  const n = ranked.length;
  return { recallAt1: r1 / n, recallAt3: r3 / n, mrrAt10: Math.round((mrr / n) * 1000) / 1000, misses };
}

function bm25Baseline() {
  const ids = Object.keys(docs);
  const toks = ids.map((id) => tokenize(docs[id]!));
  const avg = toks.reduce((s, t) => s + t.length, 0) / toks.length;
  const df = new Map<string, number>();
  for (const t of toks) for (const w of new Set(t)) df.set(w, (df.get(w) ?? 0) + 1);
  const ranked = queries.map(({ q }) => {
    const qt = tokenize(q);
    const s = toks.map((t, i) => {
      let sc = 0;
      for (const w of qt) {
        const f = t.filter((x) => x === w).length;
        if (!f) continue;
        const idf = Math.log(1 + (ids.length - df.get(w)! + 0.5) / (df.get(w)! + 0.5));
        sc += (idf * f * 2.2) / (f + 1.2 * (0.25 + (0.75 * t.length) / avg));
      }
      return [ids[i]!, sc] as const;
    });
    return s.sort((a, b) => b[1] - a[1]).map((x) => x[0]);
  });
  return score(ranked);
}

const docIds = Object.keys(docs);
const results: unknown[] = [{ name: "bm25 baseline (searchIndex tokenizer)", ...bm25Baseline() }];
for (const v of variants) {
  try {
    const d = await v.embedDocs(docIds.map((id) => docs[id]!));
    const qv = await v.embedQueries(queries.map((x) => x.q));
    const ranked = qv.vectors.map((q) => docIds.map((id, i) => [id, cosine(q, d.vectors[i]!)] as const).sort((a, b) => b[1] - a[1]).map((x) => x[0]));
    // Single-text latency (what an `embed` index pays per document / per query), median of 5.
    const singles: number[] = [];
    for (let i = 0; i < 5; i++) singles.push((await v.embedQueries([queries[i]!.q])).ms);
    singles.sort((a, b) => a - b);
    results.push({
      name: v.name,
      model: v.model,
      dimensions: d.vectors[0]!.length,
      batchMs: { docs30: Math.round(d.ms), queries30: Math.round(qv.ms) },
      singleQueryMsMedian: Math.round(singles[2]!),
      ...score(ranked),
    });
  } catch (e) {
    results.push({ name: v.name, model: v.model, error: (e as Error).message });
  }
}
console.log(JSON.stringify({ at: new Date().toISOString(), queries: queries.length, docs: docIds.length, results }, null, 2));
