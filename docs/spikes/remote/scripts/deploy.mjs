// node scripts/deploy.mjs <name> <file> [--cpu=ms]
import { readFileSync } from "node:fs";
import { uploadScript, enableSubdomain } from "../lib/cf.mjs";
const [name, file, ...rest] = process.argv.slice(2);
const cpu = rest.find((a) => a.startsWith("--cpu="))?.slice(6);
const meta = { compatibility_date: "2026-10-01", compatibility_flags: ["nodejs_compat"],
  bindings: [{ type: "durable_object_namespace", name: "SHARD", class_name: "Shard" }],
  exports: { Shard: { type: "durable-object", storage: "sqlite" } },
  observability: { enabled: true } };
if (cpu) meta.limits = { cpu_ms: Number(cpu) };
const r = await uploadScript(name, { "index.js": readFileSync(file, "utf8") }, meta);
console.log(JSON.stringify({ status: r.status, errors: r.json.errors, rec: r.json.result?.exports_reconciliation?.created, limits: r.json.result?.limits, startup: r.json.result?.startup_time_ms }));
if (r.json.success) console.log("subdomain", (await enableSubdomain(name)).json.success);
