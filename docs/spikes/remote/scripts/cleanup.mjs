import { api, deleteScript } from "../lib/cf.mjs";
const list = async () => {
  const s = (await api("GET", "/workers/scripts")).json.result.map((x) => x.id);
  const ns = (await api("GET", "/workers/durable_objects/namespaces?per_page=1000")).json.result;
  return { scripts: s, spikeScripts: s.filter((n) => n.startsWith("ember-spike-")), spikeNs: ns.filter((n) => (n.script ?? "").startsWith("ember-spike-") || n.name.startsWith("ember-spike-")).map((n) => n.name), totalScripts: s.length };
};
const before = await list();
console.log("BEFORE", JSON.stringify({ spikeScripts: before.spikeScripts, spikeNs: before.spikeNs, totalScripts: before.totalScripts }));
for (const n of before.spikeScripts) { const r = await deleteScript(n); console.log("DELETE", n, r.status, JSON.stringify(r.json.errors)); }
const after = await list();
console.log("AFTER", JSON.stringify({ spikeScripts: after.spikeScripts, spikeNs: after.spikeNs, totalScripts: after.totalScripts, others: after.scripts }));
