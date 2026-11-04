import { readFileSync, writeFileSync } from "node:fs";
import { uploadScript, enableSubdomain, url, api } from "../lib/cf.mjs";
const src = (tag) => readFileSync(new URL("../workers/r1.js", import.meta.url), "utf8").replace("__TAG__", tag);
const out = {};
const base = { compatibility_date: "2026-10-01", bindings: [
  { type: "durable_object_namespace", name: "SHARD", class_name: "Shard" },
  { type: "version_metadata", name: "VER" } ] };
const trim = (r) => ({ status: r.status, success: r.json.success, errors: r.json.errors, messages: r.json.messages,
  result: r.json.result && Object.fromEntries(Object.entries(r.json.result).filter(([k]) => /export|migration|id|etag|deployment|startup|usage|placement|tag|has_|handlers|compat|entry/i.test(k))) });
const step = async (k, fn) => { try { out[k] = await fn(); } catch (e) { out[k] = { thrown: String(e) }; } console.log(k, JSON.stringify(out[k])); };
const mode = process.argv[2];
if (mode === "exports") {
  const N = "ember-spike-r1-exports";
  await step("a_exports_created", async () => trim(await uploadScript(N, { "index.js": src("exp-v1") }, { ...base,
    exports: { Shard: { type: "durable-object", state: "created", storage: "sqlite" } } })));
  await step("a_exports_created_minimal", async () => out.a_exports_created.success ? "skipped" : trim(await uploadScript(N, { "index.js": src("exp-v1") }, { ...base,
    exports: { Shard: { type: "durable-object", state: "created" } } })));
  await step("a_subdomain", async () => (await enableSubdomain(N)).json.success);
  await new Promise((r) => setTimeout(r, 8000));
  await step("a_fetch", async () => { const r = await fetch(url(N) + "/?id=x"); return { status: r.status, body: (await r.text()).slice(0, 500) }; });
  await step("a_storage_kind", async () => { const r = await api("GET", `/workers/durable_objects/namespaces?per_page=1000`);
    return r.json.result?.filter((n) => n.script === N); });
  await step("a_reupload_same_state", async () => trim(await uploadScript(N, { "index.js": src("exp-v2") }, { ...base,
    exports: { Shard: { type: "durable-object", state: "created", storage: "sqlite" } } })));
  await step("a_reupload_no_exports", async () => trim(await uploadScript(N, { "index.js": src("exp-v3") }, base)));
}
if (mode === "migrations") {
  const N = "ember-spike-r1-migr";
  await step("b_migrations_with_binding", async () => trim(await uploadScript(N, { "index.js": src("mig-v1") }, { ...base,
    migrations: { new_tag: "v1", new_sqlite_classes: ["Shard"] } })));
  await step("b_subdomain", async () => (await enableSubdomain(N)).json.success);
  await new Promise((r) => setTimeout(r, 8000));
  await step("b_fetch", async () => { const r = await fetch(url(N) + "/?id=x"); return { status: r.status, body: (await r.text()).slice(0, 500) }; });
  await step("b_storage_kind", async () => { const r = await api("GET", `/workers/durable_objects/namespaces?per_page=1000`);
    return r.json.result?.filter((n) => n.script === N); });
  await step("b_wrong_old_tag", async () => trim(await uploadScript(N, { "index.js": src("mig-v2") }, { ...base,
    migrations: { old_tag: "WRONG", new_tag: "v2", new_sqlite_classes: [] } })));
  await step("b_codeonly_no_migrations", async () => trim(await uploadScript(N, { "index.js": src("mig-v2") }, base)));
}
writeFileSync(new URL(`../evidence/r1-${mode}.json`, import.meta.url), JSON.stringify(out, null, 2));
