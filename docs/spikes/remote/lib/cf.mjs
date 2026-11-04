// Minimal Cloudflare REST client. Token comes from env CF_TOKEN (never logged).
import { execSync } from "node:child_process";
export const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
export const BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}`;
let TOKEN = process.env.CF_TOKEN;
export function token() {
  if (!TOKEN) TOKEN = execSync("npx wrangler auth token", { cwd: "/tmp", stdio: ["ignore", "pipe", "ignore"] }).toString().trim().split("\n").pop();
  return TOKEN;
}
export function assertSpikeName(name) {
  if (!/^ember-spike-[a-z0-9-]+$/.test(name)) throw new Error("refusing non ember-spike name: " + name);
}
export async function api(method, path, body, headers = {}) {
  const init = { method, headers: { Authorization: `Bearer ${token()}`, ...headers } };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) { init.body = JSON.stringify(body); init.headers["content-type"] = "application/json"; }
  const r = await fetch(BASE + path, init);
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 2000) }; }
  return { status: r.status, json };
}
/** PUT /workers/scripts/{name} multipart. modules: {filename: source} ; first is main */
export async function uploadScript(name, modules, metadata) {
  assertSpikeName(name);
  const fd = new FormData();
  const files = Object.keys(modules);
  metadata = { main_module: files[0], ...metadata };
  fd.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  for (const f of files) fd.append(f, new Blob([modules[f]], { type: "application/javascript+module" }), f);
  return api("PUT", `/workers/scripts/${name}`, fd);
}
export async function enableSubdomain(name) {
  assertSpikeName(name);
  return api("POST", `/workers/scripts/${name}/subdomain`, { enabled: true, previews_enabled: false });
}
export async function deleteScript(name) {
  assertSpikeName(name);
  return api("DELETE", `/workers/scripts/${name}?force=true`);
}
export const url = (name) => `https://${name}.<subdomain>.workers.dev`;
