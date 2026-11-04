import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { uploadScript, enableSubdomain, url } from "../lib/cf.mjs";
const [name, offload] = process.argv.slice(2);
const meta = { compatibility_date: "2026-10-01", compatibility_flags: ["nodejs_compat"],
  bindings: [
    { type: "durable_object_namespace", name: "AUTH_SHARD", class_name: "AuthShard" },
    { type: "plain_text", name: "HASH_OFFLOAD", text: offload },
    { type: "plain_text", name: "BASE_URL", text: url(name) },
    { type: "secret_text", name: "AUTH_SECRET", text: randomBytes(32).toString("base64url") } ],
  exports: { AuthShard: { type: "durable-object", storage: "sqlite" } }, observability: { enabled: true } };
const r = await uploadScript(name, { "index.js": readFileSync(new URL("../auth/dist/index.js", import.meta.url), "utf8") }, meta);
console.log(JSON.stringify({ status: r.status, errors: r.json.errors, startup: r.json.result?.startup_time_ms, rec: r.json.result?.exports_reconciliation?.created }));
if (r.json.success) console.log("subdomain", (await enableSubdomain(name)).json.success);
