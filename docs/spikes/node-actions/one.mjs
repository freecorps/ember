// node one.mjs <entry> <workload> [params-json] [--fixture name] [--cap MB|0] [--ember] [--node]
// Default build is the "fixed" variant; --ember uses Ember's current WORKER_BUILD_OPTIONS unchanged.
import { build, runInNode, runInWorkerd } from "./harness.mjs";
const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i < 0 ? undefined : args.splice(i, 2)[1]; };
const fixture = flag("--fixture"), cap = flag("--cap");
const variantFlag = flag("--variant");
const variant = variantFlag ?? (args.includes("--ember") ? "ember" : args.includes("--neutral") ? "neutral" : "fixed"), node = args.includes("--node");
const [entry, workload, p = "{}"] = args.filter((a) => !a.startsWith("--"));
const b = await build(entry, { variant });
if (!b.ok) { console.log(JSON.stringify({ build: b.error })); process.exit(0); }
const r = await runInWorkerd(b.code, { workload, params: JSON.parse(p), fixture, heapCapMB: cap === undefined ? 128 : Number(cap) });
console.log(JSON.stringify({ bundleKiB: Math.round(b.bytes / 1024), ...r }, null, 1));
if (node) console.log("node", JSON.stringify(await runInNode(entry, workload, JSON.parse(p))));
