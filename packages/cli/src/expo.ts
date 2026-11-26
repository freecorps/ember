// `ember expo publish|rollback|rollout|kill|resume|channel|list`: self-hosted EAS Update over the
// `@freecorps/ember-expo-updates` component (contracts.md "Expo Updates").
//
// Everything goes through the admin function runner (`POST /api/_ember/run`, EMBER_ADMIN_TOKEN) to the component's
// public functions in `global:main` (`@<install>/lib:prepareAssets|publish|rollback|setRollout|setChannel|...`): no
// endpoint of its own. `publish` reads `npx expo export`'s output (`dist/metadata.json` + the files it names), hashes
// every file (SHA-256: the content address; MD5: the asset key the bundle refers to), asks which ones the shard lacks,
// PUTs only those to their upload tickets (Ember's files, R2) and confirms them, then creates the update group.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import type { EmberManifest } from "./codegen/index.ts";
import type { Project } from "./config.ts";
import { adminRun, pool } from "./migrations.ts";
import { apiUrl, checkCredentialUrl } from "./secure-url.ts";

export type ExpoPlatform = "ios" | "android";
const PLATFORMS: readonly ExpoPlatform[] = ["ios", "android"];

export interface ExpoOptions {
  url: string;
  adminToken: string;
  /** For the install name (the manifest); not needed with `component`. */
  project?: Project;
  /** Install name of the component (default: the only `expoUpdates` install in the manifest). */
  component?: string;
  fetch?: typeof fetch;
  json?: boolean;
  log?: (line: string) => void;
  /** Concurrent uploads (default 4). */
  concurrency?: number;
}

const SHARD = "global:main";

/** The component's install name: `--component`, else the only install of `expoUpdates` in the manifest. */
export function expoInstall(o: Pick<ExpoOptions, "project" | "component">): string {
  if (o.component) return o.component;
  const p = o.project ? join(o.project.generatedDir, "manifest.json") : null;
  if (!p || !existsSync(p)) throw new Error("No ember/_generated/manifest.json (run `ember codegen`), or pass --component <install name>");
  const manifest = JSON.parse(readFileSync(p, "utf8")) as EmberManifest;
  const comps = (manifest.schema.components ?? {}) as Record<string, { component: string }>;
  const installs = Object.entries(comps).filter(([, c]) => c.component === "expoUpdates").map(([k]) => k);
  if (installs.length === 1) return installs[0]!;
  if (!installs.length) throw new Error("The expo-updates component is not installed: add `.use(expoUpdates)` (@freecorps/ember-expo-updates) to ember/ember.config.ts and run `ember codegen`");
  throw new Error(`The expo-updates component is installed more than once (${installs.join(", ")}): pass --component <name>`);
}

const CONTENT_TYPES: Record<string, string> = {
  js: "application/javascript",
  hbc: "application/javascript",
  bundle: "application/javascript",
  json: "application/json",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  heic: "image/heic",
  avif: "image/avif",
  ttf: "font/ttf",
  otf: "font/otf",
  woff: "font/woff",
  woff2: "font/woff2",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  pdf: "application/pdf",
  txt: "text/plain",
  html: "text/html",
  css: "text/css",
  xml: "application/xml",
  wasm: "application/wasm",
  lottie: "application/json",
};
export const contentTypeOf = (ext: string): string => CONTENT_TYPES[ext.replace(/^\./, "").toLowerCase()] ?? "application/octet-stream";

export interface ExportFile {
  path: string;
  bytes: Uint8Array;
  sha256: string;
  /** Metro's asset hash: the key the bundle's asset registry looks assets up by. */
  md5: string;
  size: number;
  contentType: string;
  fileExtension?: string;
}
export interface ExportPlatform {
  platform: ExpoPlatform;
  runtimeVersion: string;
  bundle: ExportFile;
  assets: ExportFile[];
}
export interface ExpoExport {
  platforms: ExportPlatform[];
  /** `dist/expoConfig.json` (`npx expo config --json --type public`): served as `extra.expoClient`. */
  expoConfig: Record<string, unknown> | null;
}

type Metadata = { version?: number; bundler?: string; fileMetadata?: Record<string, { bundle?: string; assets?: Array<{ path?: string; ext?: string }> }> };

/** The runtime version a platform's build carries, from `--runtime-version` or the Expo config (string or policy). */
export function runtimeVersionOf(platform: ExpoPlatform, config: Record<string, unknown> | null, explicit?: string): string {
  if (explicit) return explicit;
  if (!config) throw new Error("no runtime version: pass --runtime-version, or export the config next to metadata.json (`npx expo config --json --type public > dist/expoConfig.json`)");
  const plat = (config[platform] ?? {}) as Record<string, unknown>;
  const rv = plat.runtimeVersion ?? config.runtimeVersion;
  if (typeof rv === "string" && rv) return rv;
  const policy = rv && typeof rv === "object" ? (rv as { policy?: unknown }).policy : undefined;
  // Expo's own defaults (@expo/config-plugins): no version is "1.0.0", no ios.buildNumber / android.versionCode is 1.
  const version = (typeof plat.version === "string" && plat.version ? plat.version : undefined) ?? (typeof config.version === "string" && config.version ? config.version : "1.0.0");
  if (policy === "appVersion") return version;
  if (policy === "nativeVersion") {
    const build = platform === "ios" ? plat.buildNumber : plat.versionCode;
    return `${version}(${build === undefined || build === null || build === "" ? "1" : String(build)})`;
  }
  if (policy === "sdkVersion") {
    if (typeof config.sdkVersion !== "string") throw new Error(`runtimeVersion policy "sdkVersion" but the config has no sdkVersion`);
    return `exposdk:${config.sdkVersion}`;
  }
  throw new Error(`runtimeVersion ${policy ? `policy ${JSON.stringify(policy)}` : "is not set"} for ${platform}: pass --runtime-version (fingerprint policies are computed by the native build, not here)`);
}

function readFile(dir: string, rel: string, ext?: string): ExportFile {
  const path = resolve(dir, rel);
  if (!path.startsWith(resolve(dir) + sep)) throw new Error(`metadata.json names a file outside the export: ${rel}`);
  if (!existsSync(path)) throw new Error(`metadata.json names ${rel}, which is not in ${dir}`);
  const bytes = new Uint8Array(readFileSync(path));
  const e = (ext ?? extname(rel).slice(1)).replace(/^\./, "");
  return {
    path: rel,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    md5: createHash("md5").update(bytes).digest("hex"),
    size: bytes.byteLength,
    contentType: contentTypeOf(e),
    ...(e ? { fileExtension: `.${e}` } : {}),
  };
}

/** Reads `npx expo export`'s output directory (default `dist`). */
export function readExpoExport(dir: string, opts: { platforms?: readonly ExpoPlatform[]; runtimeVersion?: string; expoConfig?: string } = {}): ExpoExport {
  const metaPath = join(dir, "metadata.json");
  if (!existsSync(metaPath)) throw new Error(`no ${metaPath}: run \`npx expo export\` first (or pass --dir)`);
  const meta = JSON.parse(readFileSync(metaPath, "utf8")) as Metadata;
  if (!meta.fileMetadata || typeof meta.fileMetadata !== "object") throw new Error(`${metaPath}: no fileMetadata (not an \`expo export\` output?)`);
  const configPath = opts.expoConfig ?? join(dir, "expoConfig.json");
  const expoConfig = existsSync(configPath) ? (JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>) : null;
  if (opts.expoConfig && !expoConfig) throw new Error(`no ${opts.expoConfig}`);
  const wanted = opts.platforms ?? PLATFORMS;
  const platforms: ExportPlatform[] = [];
  for (const platform of wanted) {
    const m = meta.fileMetadata[platform];
    if (!m) {
      if (opts.platforms) throw new Error(`${metaPath} has no ${platform} export`);
      continue;
    }
    if (!m.bundle) throw new Error(`${metaPath}: ${platform} has no bundle`);
    const bundle = readFile(dir, m.bundle);
    bundle.contentType = "application/javascript";
    const assets = (m.assets ?? []).map((a) => {
      if (!a.path) throw new Error(`${metaPath}: a ${platform} asset has no path`);
      return readFile(dir, a.path, a.ext);
    });
    platforms.push({ platform, runtimeVersion: runtimeVersionOf(platform, expoConfig, opts.runtimeVersion), bundle, assets });
  }
  if (!platforms.length) throw new Error(`${metaPath} has no ios or android export`);
  return { platforms, expoConfig };
}

type Ticket = { storageId: string; shard: string; token: string; url: string; method: string; headers: Record<string, string> };

async function send(o: ExpoOptions, url: string, init: RequestInit): Promise<Response> {
  // Relative URLs (proxy mode) are the runtime's own; presigned S3 URLs go to R2 directly.
  const target = /^https?:\/\//.test(url) ? url : apiUrl(checkCredentialUrl(o.url), url).href;
  return (o.fetch ?? fetch)(target, init);
}

export interface PublishOptions {
  dir: string;
  branch: string;
  message?: string;
  rollout?: number;
  platforms?: readonly ExpoPlatform[];
  runtimeVersion?: string;
  expoConfig?: string;
  /** Create a channel named like the branch when none exists (default true). */
  createChannel?: boolean;
}
export interface PublishResult {
  group: string;
  branch: string;
  rolloutPercent: number;
  updates: Array<{ id: string; platform: ExpoPlatform; runtimeVersion: string }>;
  assets: number;
  uploaded: number;
  bytesUploaded: number;
}

/** `ember expo publish`: uploads what the shard lacks (by SHA-256), then creates the update group on the branch. */
export async function expoPublish(o: ExpoOptions, p: PublishOptions): Promise<PublishResult> {
  const log = o.log ?? ((l: string) => console.log(l));
  const install = expoInstall(o);
  if (p.rollout !== undefined && (!Number.isInteger(p.rollout) || p.rollout < 0 || p.rollout > 100)) throw new Error("--rollout must be an integer in 0..100");
  const exp = readExpoExport(p.dir, { ...(p.platforms ? { platforms: p.platforms } : {}), ...(p.runtimeVersion ? { runtimeVersion: p.runtimeVersion } : {}), ...(p.expoConfig ? { expoConfig: p.expoConfig } : {}) });
  if (!exp.expoConfig) {
    const note = "note: no expoConfig.json next to metadata.json: the update carries no extra.expoClient (Constants.expoConfig). `npx expo config --json --type public > dist/expoConfig.json`";
    // With --json, stdout is the result: the note goes to stderr, where a CI log still shows it.
    if (o.json) process.stderr.write(`${note}\n`);
    else log(note);
  }
  const files = new Map<string, ExportFile>();
  for (const pl of exp.platforms) for (const f of [pl.bundle, ...pl.assets]) files.set(f.sha256, f);
  const all = [...files.values()];
  const prepared: Array<{ sha256: string; exists: boolean; upload?: Ticket }> = [];
  for (let i = 0; i < all.length; i += 500) {
    const chunk = all.slice(i, i + 500);
    prepared.push(...(await adminRun<typeof prepared>(o, `@${install}/lib:prepareAssets`, { assets: chunk.map((f) => ({ sha256: f.sha256, size: f.size, contentType: f.contentType })) }, SHARD)));
  }
  const todo = prepared.filter((x) => x.upload);
  let bytes = 0;
  await pool(todo, o.concurrency ?? 4, async (x) => {
    const f = files.get(x.sha256)!;
    const t = x.upload!;
    const put = await send(o, t.url, { method: t.method || "PUT", headers: t.headers, body: f.bytes as BodyInit });
    if (!put.ok) throw new Error(`upload of ${f.path} failed: HTTP ${put.status} ${(await put.text()).slice(0, 200)}`);
    const c = await send(o, "/api/storage/confirm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ shard: t.shard, storageId: t.storageId, token: t.token }) });
    if (!c.ok) throw new Error(`confirming ${f.path} failed: HTTP ${c.status} ${(await c.text()).slice(0, 200)}`);
    bytes += f.size;
  });
  const asset = (f: ExportFile, launch: boolean) => ({ sha256: f.sha256, key: f.md5, contentType: f.contentType, ...(!launch && f.fileExtension ? { fileExtension: f.fileExtension } : {}) });
  const r = await adminRun<Omit<PublishResult, "assets" | "uploaded" | "bytesUploaded">>(
    o,
    `@${install}/lib:publish`,
    {
      branch: p.branch,
      ...(p.message !== undefined ? { message: p.message } : {}),
      ...(p.rollout !== undefined ? { rolloutPercent: p.rollout } : {}),
      ...(p.createChannel === false ? { createChannel: false } : {}),
      updates: exp.platforms.map((pl) => ({
        platform: pl.platform,
        runtimeVersion: pl.runtimeVersion,
        launchAsset: asset(pl.bundle, true),
        assets: pl.assets.map((a) => asset(a, false)),
        metadata: {},
        ...(exp.expoConfig ? { extra: { expoClient: exp.expoConfig } } : {}),
      })),
    },
    SHARD,
  );
  const out: PublishResult = { ...r, assets: all.length, uploaded: todo.length, bytesUploaded: bytes };
  if (o.json) log(JSON.stringify(out, null, 2));
  else {
    log(`published to ${r.branch}${r.rolloutPercent < 100 ? ` (rollout ${r.rolloutPercent}%)` : ""}: group ${r.group}`);
    for (const u of r.updates) log(`  ${u.platform.padEnd(8)} ${u.runtimeVersion.padEnd(12)} ${u.id}`);
    log(`  assets: ${all.length}, uploaded ${todo.length} (${bytes} bytes), already there ${all.length - todo.length}`);
  }
  return out;
}

export interface BranchTarget {
  branch: string;
  platform?: ExpoPlatform;
  runtimeVersion?: string;
}
const target = (t: BranchTarget) => ({ branch: t.branch, ...(t.platform ? { platform: t.platform } : {}), ...(t.runtimeVersion !== undefined ? { runtimeVersion: t.runtimeVersion } : {}) });

/** `ember expo rollback`: the branch's head goes out; clients get the previous update (or the embedded one). */
export async function expoRollback(o: ExpoOptions, t: BranchTarget & { toEmbedded?: boolean; message?: string }) {
  const log = o.log ?? ((l: string) => console.log(l));
  const r = await adminRun<Array<{ platform: string; runtimeVersion: string; rolledBack: string; now: string; kind: string }>>(
    o,
    `@${expoInstall(o)}/lib:rollback`,
    { ...target(t), ...(t.toEmbedded ? { toEmbedded: true } : {}), ...(t.message ? { message: t.message } : {}) },
    SHARD,
  );
  if (o.json) log(JSON.stringify(r, null, 2));
  else if (!r.length) log(`nothing to roll back on ${t.branch}`);
  else for (const x of r) log(`  ${x.platform.padEnd(8)} ${x.runtimeVersion.padEnd(12)} ${x.rolledBack} rolled back → ${x.kind === "rollBackToEmbedded" ? "embedded update" : x.now}`);
  return r;
}

/** `ember expo rollout <pct>`: the percentage of the branch's heads in a partial rollout (100 ends it). */
export async function expoRollout(o: ExpoOptions, t: BranchTarget & { percent: number }) {
  const log = o.log ?? ((l: string) => console.log(l));
  if (!Number.isInteger(t.percent) || t.percent < 0 || t.percent > 100) throw new Error("the rollout percentage must be an integer in 0..100");
  const r = await adminRun<Array<{ platform: string; runtimeVersion: string; update: string; from: number; to: number }>>(o, `@${expoInstall(o)}/lib:setRollout`, { ...target(t), percent: t.percent }, SHARD);
  if (o.json) log(JSON.stringify(r, null, 2));
  else for (const x of r) log(`  ${x.platform.padEnd(8)} ${x.runtimeVersion.padEnd(12)} ${x.update}: ${x.from}% → ${x.to}%`);
  return r;
}

/** `ember expo kill|resume (--channel c | --branch b)`: the kill switch. */
export async function expoPause(o: ExpoOptions, t: { channel?: string; branch?: string; paused: boolean }) {
  const log = o.log ?? ((l: string) => console.log(l));
  if (!!t.channel === !!t.branch) throw new Error("pass --channel <name> or --branch <name>");
  const fn = t.channel ? "setChannelPaused" : "setBranchPaused";
  const r = await adminRun<{ name: string; paused: boolean }>(o, `@${expoInstall(o)}/lib:${fn}`, { name: (t.channel ?? t.branch)!, paused: t.paused }, SHARD);
  if (o.json) log(JSON.stringify(r));
  else log(`${t.channel ? "channel" : "branch"} ${r.name}: ${r.paused ? "paused (clients get noUpdateAvailable)" : "serving updates"}`);
  return r;
}

/** `ember expo channel <name> --branch b [--rollout-branch x --rollout-percent n | --no-rollout]`. */
export async function expoChannel(o: ExpoOptions, t: { name: string; branch: string; rolloutBranch?: string | null; rolloutPercent?: number }) {
  const log = o.log ?? ((l: string) => console.log(l));
  const r = await adminRun<{ name: string; branch: string; rolloutBranch?: string; rolloutPercent?: number; version: number }>(
    o,
    `@${expoInstall(o)}/lib:setChannel`,
    { name: t.name, branch: t.branch, ...(t.rolloutBranch !== undefined ? { rolloutBranch: t.rolloutBranch } : {}), ...(t.rolloutPercent !== undefined ? { rolloutPercent: t.rolloutPercent } : {}) },
    SHARD,
  );
  if (o.json) log(JSON.stringify(r, null, 2));
  else log(`channel ${r.name} → ${r.branch}${r.rolloutBranch ? ` (${r.rolloutPercent}% on ${r.rolloutBranch})` : ""}`);
  return r;
}

/** `ember expo list`: channels and branches. */
export async function expoList(o: ExpoOptions) {
  const log = o.log ?? ((l: string) => console.log(l));
  const r = await adminRun<{ channels: Array<{ name: string; branch: string; rolloutBranch?: string; rolloutPercent?: number; paused: boolean; version: number }>; branches: Array<{ name: string; paused: boolean }> }>(o, `@${expoInstall(o)}/lib:list`, {}, SHARD);
  if (o.json) log(JSON.stringify(r, null, 2));
  else {
    log("channels:");
    for (const c of r.channels) log(`  ${c.name.padEnd(20)} → ${c.branch}${c.rolloutBranch ? ` (${c.rolloutPercent}% on ${c.rolloutBranch})` : ""}${c.paused ? "  PAUSED" : ""}`);
    log("branches:");
    for (const b of r.branches) log(`  ${b.name}${b.paused ? "  PAUSED" : ""}`);
  }
  return r;
}
