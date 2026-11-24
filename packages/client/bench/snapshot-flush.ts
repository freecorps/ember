// Measurements for PR 3B-1b (not run in CI): bytes written per snapshot-cache flush, 100 queries × 50 rows, one query
// changed. Before = format 1 (one blob holding every value's JSON as a string, re-serialized whole at each flush),
// reproduced in the same process; after = format 2 (one key per changed query + the index), by the writer tab, and
// nothing at all by a reader tab.
//
//   bun --conditions=@freecorps/ember-source packages/client/bench/snapshot-flush.ts
import { keyValueSnapshotCache, type SnapshotCache } from "../src/index.ts";
import { channelHub, fakeLocks } from "../test/snapshot-tabs.ts";

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const kib = (n: number) => `${(n / 1024).toFixed(1)} KiB`;
const row = (i: number, tag: string) => ({ _id: `id${i}`, _creationTime: 1_700_000_000_000 + i, body: `message ${i} ${tag} "quoted" ${"lorem ipsum ".repeat(9)}` });
const N = 100;
const ROWS = 50;
const values = Array.from({ length: N }, (_, q) => Array.from({ length: ROWS }, (_, i) => row(q * 1000 + i, "v0")));
const edit = (r: number) => values[r % N]!.map((d, i) => (i === 0 ? { ...d, body: `edit ${r}` } : d));

// Format 1.
const blob = { v: 1, by: { anon: Object.fromEntries(values.map((v, q) => [`q${q}`, { v: JSON.stringify(v), version: 1, epoch: "E", ik: "t", at: Date.now() }])) } };
const oldTimes: number[] = [];
let oldBytes = 0;
for (let r = 0; r < 20; r++) {
  blob.by.anon[`q${r % N}`]!.v = JSON.stringify(edit(r));
  const t0 = performance.now();
  oldBytes = JSON.stringify(blob).length;
  oldTimes.push(performance.now() - t0);
}

// Format 2: a writer and a reader over one store.
const stats = { bytes: 0, sets: 0 };
const m = new Map<string, string>();
const kv = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => ((stats.bytes += v.length), stats.sets++, void m.set(k, v)), removeItem: (k: string) => void m.delete(k) };
const locks = fakeLocks();
const hub = channelHub();
let writer: SnapshotCache | null = null;
const open = () => {
  const c: SnapshotCache = keyValueSnapshotCache(kv, { maxBytes: 64 * 1024 * 1024, tabs: { locks, channel: hub.open() }, onWriterChange: (w) => void (w && (writer = c)) });
  return c;
};
const a = open();
const b = open();
while (!writer) await new Promise((r) => setTimeout(r, 1));
values.forEach((v, q) => a.set("anon", `q${q}`, { value: v, version: 1, epoch: "E", ik: "t", at: Date.now() }));
a.flush!();
const firstBytes = stats.bytes;
const run = (c: SnapshotCache) => {
  const times: number[] = [];
  const bytes: number[] = [];
  for (let r = 0; r < 20; r++) {
    stats.bytes = 0;
    c.set("anon", `q${r % N}`, { value: edit(r), version: 2 + r, epoch: "E", ik: "t", at: Date.now() });
    const t0 = performance.now();
    c.flush!();
    times.push(performance.now() - t0);
    bytes.push(stats.bytes);
  }
  return { bytes: median(bytes), ms: median(times) };
};
const w = run(a);
const r = run(b);
// The page hides: 100 versions move, nothing else changed.
stats.bytes = 0;
values.forEach((v, q) => a.touch!("anon", `q${q}`, { value: v, version: 1000, epoch: "E", ik: "t", at: Date.now() }));
a.flush!();
const touched = stats.bytes;
console.log(`snapshot flush (${N} queries × ${ROWS} rows, one query changed):`);
console.log(`  format 1 (one blob):             ${kib(oldBytes)} written per flush, ${median(oldTimes).toFixed(2)} ms stringify`);
console.log(`  format 2, writer (key + index):  ${kib(w.bytes)} written per flush, ${w.ms.toFixed(2)} ms (encode + write); first flush ${kib(firstBytes)}`);
console.log(`  format 2, reader tab:            ${kib(r.bytes)} written (kept in memory)`);
console.log(`  page hide, ${N} versions moved:    ${kib(touched)} (the index only)`);
await a.close!();
await b.close!();
