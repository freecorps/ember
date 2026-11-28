// `ember sentry sourcemaps upload --project <id> --release <r> [--dist d] [--url-prefix ~/] <dir>`: the source maps of
// a build to the `@freecorps/ember-sentry` component (contracts.md "Sentry"), through its upload routes:
//
//   POST <httpPrefix>/admin/sourcemaps                 { project, release, dist?, files: [{ name, sha256, size, debugId? }] }
//        → { ok: false, missing: [sha256...] } while some map is not in R2, then { ok: true, added, files }
//   PUT  <httpPrefix>/admin/sourcemaps/blobs/<sha256>  the map, gzipped (stored once per content: dedup by sha256)
//
// A map's name is the URL path of the minified file it maps (`~/assets/app.js` for `https://host/assets/app.js`, what
// the consumer matches a frame's `abs_path` against): the `.js` whose `//# sourceMappingURL=` names the map, else the
// map's path without `.map`. Its debug id comes from the map (`debugId` / `debug_id`) or the `.js`'s `//# debugId=`.
// Authorization: `Bearer` EMBER_SENTRY_UPLOAD_TOKEN (or EMBER_ADMIN_TOKEN), only to https:// (or localhost).

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { gzipSync } from "node:zlib";
import { apiUrl, checkCredentialUrl } from "./secure-url.ts";

export interface SourceMapFile {
  /** `~/assets/app.js`: the URL path of the minified file. */
  name: string;
  sha256: string;
  size: number;
  debugId?: string;
  /** The map on disk (not sent). */
  path: string;
}

export interface UploadOptions {
  /** The runtime's base URL (`ember dev`, or the environment's). */
  url: string;
  token: string;
  project: string;
  release: string;
  dist?: string;
  /** The install's HTTP prefix (default `/sentry`). */
  httpPrefix?: string;
  /** Prefix of the names (default `~/`: `dist/assets/app.js` → `~/assets/app.js`); a full URL prefix works too. */
  urlPrefix?: string;
  dryRun?: boolean;
  fetch?: typeof fetch;
  log?: (line: string) => void;
}

export interface UploadResult {
  files: SourceMapFile[];
  /** Maps sent (those R2 did not hold yet). */
  uploaded: number;
  /** Rows the component registered (new names; a known name with a new map is replaced). */
  added: number;
}

const MAX_FILES = 2000;
const MAX_MAP_BYTES = 64 * 1024 * 1024;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

/** `//# sourceMappingURL=` and `//# debugId=` at the end of a script (the last of each wins). */
export function scriptComments(js: string): { sourceMappingURL: string | null; debugId: string | null } {
  const tail = js.length > 4096 ? js.slice(-4096) : js;
  const url = [...tail.matchAll(/\/\/[#@]\s*sourceMappingURL=(\S+)/g)].pop()?.[1] ?? null;
  const id = [...tail.matchAll(/\/\/[#@]\s*debugId=([0-9a-fA-F-]{32,36})/g)].pop()?.[1] ?? null;
  return { sourceMappingURL: url, debugId: id ? normalizeDebugId(id) : null };
}

/** A debug id as a lowercase dashed UUID (the component stores them so). */
export function normalizeDebugId(id: string): string {
  const hex = id.replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) return id.toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The URL path name under `urlPrefix` (`~/` default) of a file relative to the build directory. */
export function artifactNameFor(rel: string, urlPrefix = "~/"): string {
  const path = rel.split(sep).join(posix.sep).replace(/^\.?\//, "");
  let prefix = urlPrefix;
  const m = /^[a-z][a-z0-9+.-]*:\/\/[^/]*(\/.*)?$/i.exec(prefix);
  if (m) prefix = "~" + (m[1] ?? "/");
  if (!prefix.startsWith("~")) prefix = "~" + (prefix.startsWith("/") ? "" : "/") + prefix;
  if (!prefix.endsWith("/")) prefix += "/";
  return prefix + path;
}

/** The maps of a build directory, named after the scripts they map (see the header). */
export function collectSourceMaps(dir: string, urlPrefix = "~/"): SourceMapFile[] {
  const root = resolve(dir);
  if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`${dir} is not a directory`);
  const files = walk(root);
  const maps = files.filter((f) => f.endsWith(".map"));
  if (maps.length > MAX_FILES) throw new Error(`${maps.length} source maps under ${dir}: at most ${MAX_FILES} per release upload`);
  // The script that names each map (sourceMappingURL relative to the script; data: URLs are inline maps, skipped).
  const scriptOf = new Map<string, { path: string; debugId: string | null }>();
  for (const f of files) {
    if (!/\.(c|m)?js$/.test(f)) continue;
    const c = scriptComments(readFileSync(f, "utf8"));
    if (!c.sourceMappingURL || c.sourceMappingURL.startsWith("data:") || /^[a-z]+:\/\//i.test(c.sourceMappingURL)) continue;
    scriptOf.set(resolve(dirname(f), decodeURIComponent(c.sourceMappingURL.split(/[?#]/)[0]!)), { path: f, debugId: c.debugId });
  }
  const out: SourceMapFile[] = [];
  for (const m of maps.sort()) {
    const bytes = readFileSync(m);
    if (bytes.length > MAX_MAP_BYTES) throw new Error(`${relative(root, m)} is larger than 64 MiB`);
    let json: { mappings?: unknown; sections?: unknown; debugId?: unknown; debug_id?: unknown };
    try {
      json = JSON.parse(bytes.toString("utf8")) as typeof json;
    } catch {
      continue; // not a source map (some `.map` that is not JSON)
    }
    if (typeof json?.mappings !== "string" && !Array.isArray(json?.sections)) continue;
    const script = scriptOf.get(m);
    const target = script ? script.path : m.slice(0, -".map".length);
    const mapId = typeof json.debugId === "string" ? json.debugId : typeof json.debug_id === "string" ? json.debug_id : null;
    const debugId = mapId ? normalizeDebugId(mapId) : (script?.debugId ?? null);
    out.push({ name: artifactNameFor(relative(root, target), urlPrefix), sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length, ...(debugId ? { debugId } : {}), path: m });
  }
  return out;
}

async function call(o: UploadOptions, method: "POST" | "PUT", path: string, body: Uint8Array | string, headers: Record<string, string>): Promise<{ status: number; json: Record<string, unknown> }> {
  const base = checkCredentialUrl(o.url, { what: "the sentry upload token" });
  const res = await (o.fetch ?? fetch)(apiUrl(base, (o.httpPrefix ?? "/sentry").replace(/\/+$/, "") + path), { method, headers: { authorization: `Bearer ${o.token}`, ...headers }, body: body as BodyInit });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // not JSON (a proxy's error page): the status says enough
  }
  if (res.status === 401) throw new Error("The upload token was refused: set EMBER_SENTRY_UPLOAD_TOKEN (or EMBER_ADMIN_TOKEN) to the deployment's value");
  if (res.status === 404 && !json.error) throw new Error(`No sentry component at ${o.httpPrefix ?? "/sentry"} (pass --component, or check the deployment)`);
  if (res.status >= 400) {
    const e = json.error as { code?: string; message?: string } | undefined;
    throw new Error(`${method} ${path} answered ${res.status}${e ? `: ${e.code}: ${e.message}` : ""}`);
  }
  return { status: res.status, json };
}

/** Registers the maps of `dir` for a release: sends the manifest, the maps R2 lacks, then the manifest again. */
export async function uploadSourceMaps(dir: string, o: UploadOptions): Promise<UploadResult> {
  const log = o.log ?? ((l: string) => console.log(l));
  if (!o.release) throw new Error("--release is required");
  const files = collectSourceMaps(dir, o.urlPrefix);
  if (!files.length) throw new Error(`No source maps (*.map) under ${dir}: build with source maps on (vite: build.sourcemap = true)`);
  for (const f of files) log(`  ${f.name}  ${(f.size / 1024).toFixed(1)} KiB${f.debugId ? `  debugId ${f.debugId}` : ""}`);
  if (o.dryRun) {
    log(`Dry run: ${files.length} map(s) for ${o.project}@${o.release}${o.dist ? ` (${o.dist})` : ""}, nothing sent`);
    return { files, uploaded: 0, added: 0 };
  }
  const manifest = JSON.stringify({ project: o.project, release: o.release, ...(o.dist ? { dist: o.dist } : {}), files: files.map(({ path: _p, ...f }) => f) });
  const json = { "content-type": "application/json" };
  let r = await call(o, "POST", "/admin/sourcemaps", manifest, json);
  let uploaded = 0;
  const missing = Array.isArray(r.json.missing) ? (r.json.missing as string[]) : [];
  for (const sha of missing) {
    const f = files.find((x) => x.sha256 === sha);
    if (!f) continue;
    await call(o, "PUT", `/admin/sourcemaps/blobs/${sha}`, gzipSync(readFileSync(f.path)), { "content-type": "application/json", "content-encoding": "gzip" });
    uploaded++;
  }
  if (missing.length) r = await call(o, "POST", "/admin/sourcemaps", manifest, json);
  if (r.json.ok !== true) throw new Error(`The upload did not complete: ${JSON.stringify(r.json)}`);
  const added = typeof r.json.added === "number" ? r.json.added : 0;
  log(`Uploaded ${uploaded} new map(s) of ${files.length} (${files.length - uploaded} already stored) for ${o.project}@${o.release}${o.dist ? ` (${o.dist})` : ""}; ${added} file(s) registered`);
  return { files, uploaded, added };
}

/** The install's HTTP prefix from the manifest (`--component`, else the only install of `sentry`). */
export function sentryPrefix(components: Record<string, { component: string; httpPrefix: string }>, component?: string): string {
  if (component) {
    const c = components[component];
    if (!c) throw new Error(`No component installed as "${component}" (installed: ${Object.keys(components).join(", ") || "none"})`);
    return c.httpPrefix;
  }
  const installs = Object.values(components).filter((c) => c.component === "sentry");
  if (installs.length === 1) return installs[0]!.httpPrefix;
  if (!installs.length) throw new Error("The sentry component is not installed: add `.use(sentry, { config })` (@freecorps/ember-sentry) to ember/ember.config.ts and run `ember codegen`");
  throw new Error("The sentry component is installed more than once: pass --component <name>");
}
