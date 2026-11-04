import { readFileSync, writeFileSync } from "node:fs";
import { api, url, assertSpikeName } from "../lib/cf.mjs";
const N = "ember-spike-r1-exports"; assertSpikeName(N);
const src = (tag) => readFileSync(new URL("../workers/r1.js", import.meta.url), "utf8").replace("__TAG__", tag).replace("export class Shard", "export class Shard2");
const out = {};
const log = (k, v) => { out[k] = v; console.log(k, JSON.stringify(v).slice(0, 1500)); };
const bindings = [{ type: "durable_object_namespace", name: "SHARD", class_name: "Shard2" }, { type: "version_metadata", name: "VER" }];
// current deployment
const dep0 = await api("GET", `/workers/scripts/${N}/deployments`);
log("deployments_before", dep0.json.result?.deployments?.slice(0, 1));
const oldVersion = dep0.json.result.deployments[0].versions[0].version_id;
// A) scripts versions API (multipart), code only, no exports
async function uploadVersion(tag, extraMeta = {}) {
  const fd = new FormData();
  fd.append("metadata", new Blob([JSON.stringify({ main_module: "index.js", compatibility_date: "2026-10-01", bindings, annotations: { "workers/message": "code-only " + tag }, ...extraMeta })], { type: "application/json" }));
  fd.append("index.js", new Blob([src(tag) + (tag === "v-lifecycle" ? "\nexport class New3 extends DurableObject {}\n" : "")], { type: "application/javascript+module" }), "index.js");
  return api("POST", `/workers/scripts/${N}/versions`, fd);
}
let r = await uploadVersion("v-noexp");
log("version_upload_no_exports", { status: r.status, errors: r.json.errors, id: r.json.result?.id, number: r.json.result?.number, startup: r.json.result?.startup_time_ms });
let newVersion;
const EXP = { Extra: { type: "durable-object", state: "deleted" }, Shard: { type: "durable-object", state: "renamed", renamed_to: "Shard2" }, Shard2: { type: "durable-object", storage: "sqlite" } };
r = await uploadVersion("v-codeonly", { exports: EXP }); newVersion = r.json.result?.id;
log("version_upload_with_unchanged_exports", { status: r.status, errors: r.json.errors, id: r.json.result?.id });
r = await uploadVersion("v-lifecycle", { exports: { Shard: { type: "durable-object", state: "renamed", renamed_to: "Shard2" }, Shard2: { type: "durable-object", storage: "sqlite" }, Extra: { type: "durable-object", state: "deleted" }, New3: { type: "durable-object", state: "created", storage: "sqlite" } } });
log("version_upload_lifecycle_change", { status: r.status, errors: r.json.errors, id: r.json.result?.id }); const lifeVersion = r.json.result?.id;
r = await uploadVersion("v-migr", { migrations: { new_tag: "x", new_sqlite_classes: ["Foo"] } });
log("version_upload_with_migrations", { status: r.status, errors: r.json.errors, id: r.json.result?.id });
if (!newVersion) { writeFileSync(new URL("../evidence/r2.json", import.meta.url), JSON.stringify(out, null, 2)); process.exit(1); }
// B) gradual deployment 10/90 (10% new)
r = await api("POST", `/workers/scripts/${N}/deployments`, { strategy: "percentage", versions: [{ version_id: newVersion, percentage: 10 }, { version_id: oldVersion, percentage: 90 }], annotations: { "workers/message": "ember spike 10/90" } });
log("deployment_10_90", { status: r.status, errors: r.json.errors, result: r.json.result && { id: r.json.result.id, versions: r.json.result.versions } });
await new Promise((res) => setTimeout(res, 15000));
// C) 30 DO ids x 100 requests each
const ids = Array.from({ length: 30 }, (_, i) => "sticky-" + i);
const per = {};
const workerVersions = {};
for (const id of ids) {
  per[id] = {};
  const one = async () => {
    const res = await fetch(url(N) + "/?id=" + id); const j = await res.json();
    per[id][j.doTag + ":" + j.doVersion.slice(0, 8)] = (per[id][j.doTag + ":" + j.doVersion.slice(0, 8)] ?? 0) + 1;
    workerVersions[j.workerTag] = (workerVersions[j.workerTag] ?? 0) + 1;
  };
  for (let i = 0; i < 5; i++) await Promise.all(Array.from({ length: 20 }, one));
}
const sticky = Object.values(per).every((m) => Object.keys(m).length === 1);
const doOnNew = Object.values(per).filter((m) => Object.keys(m)[0].startsWith("v-codeonly")).length;
log("stickiness", { ids: ids.length, reqsPerId: 100, everyIdOnSingleVersion: sticky, idsOnNewVersion: doOnNew, workerFrontVersionSplit: workerVersions, perId: per });
// D) promote to 100% new
r = await api("POST", `/workers/scripts/${N}/deployments`, { strategy: "percentage", versions: [{ version_id: newVersion, percentage: 100 }] });
log("deployment_100", { status: r.status, errors: r.json.errors });
await new Promise((res) => setTimeout(res, 15000));
const after = {};
for (const id of ids.slice(0, 10)) { const j = await (await fetch(url(N) + "/?id=" + id)).json(); after[id] = j.doTag + " n=" + j.n; }
log("after_100pct", after);
// E) deploy lifecycle-change version (adds class New3) via deployments API at 100%
if (lifeVersion) {
  r = await api("POST", `/workers/scripts/${N}/deployments`, { strategy: "percentage", versions: [{ version_id: lifeVersion, percentage: 100 }] });
  log("deploy_lifecycle_version_100", { status: r.status, errors: r.json.errors?.map(e=>({code:e.code,message:e.message.slice(0,500)})) });
  const ns = await api("GET", `/workers/durable_objects/namespaces?per_page=1000`);
  log("namespaces_after", ns.json.result?.filter((n) => n.script === N));
}
writeFileSync(new URL("../evidence/r2.json", import.meta.url), JSON.stringify(out, null, 2));
