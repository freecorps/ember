// S3 (latency/protocol spike, 2026-11-14): what the deployed Worker bundle weighs, where the bytes come from (esbuild
// metafile, grouped by package), and how long workerd takes to load it (spawn → first /health answer, a proxy for the
// isolate startup a cold Shard pays, against a trivial Worker as baseline).
//
//   bun --conditions=@freecorps/ember-source run docs/spikes/local-bench/worker-bundle.ts
//
// Env: STARTS (workerd starts per bundle, 7), OUT (append the summary to this file).
import { appendFileSync, mkdirSync, rmSync, writeFileSync, readFileSync, cpSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { gzipSync } from "node:zlib";
import * as esbuild from "esbuild";
import { loadProject } from "../../../packages/cli/src/config.ts";
import { init } from "../../../packages/cli/src/init.ts";
import { buildWorker, WORKER_BUILD_OPTIONS } from "../../../packages/cli/src/build.ts";
import { codegen } from "../../../packages/cli/src/codegen/index.ts";

const REPO = resolve(import.meta.dir, "../../..");
const TMP = join(REPO, "packages/cli/.tmp/worker-bundle");
const STARTS = Number(process.env.STARTS ?? 7);
const WORKERD = join(REPO, "node_modules/.bun/@cloudflare+workerd-darwin-arm64@1.20261103.1/node_modules/@cloudflare/workerd-darwin-arm64/bin/workerd");
const say = (s: string) => {
  console.log(s);
  if (process.env.OUT) appendFileSync(process.env.OUT, s + "\n");
};
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

function fresh(name: string, auth: boolean): string {
  const dir = join(TMP, name);
  mkdirSync(dir, { recursive: true });
  init({ dir, project: name, auth });
  return dir;
}
function example(name: string): string {
  // In place (workspace dependencies resolve from there); codegen writes the git-ignored ember/_generated.
  return join(REPO, "examples", name);
}

const groupOf = (path: string): string => {
  const m = path.match(/node_modules\/(?:\.bun\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)/);
  if (m) return m[1]!;
  const p = path.match(/(?:^|\/)([a-z-]+)\/src\/(.*)/);
  if (p) return p[1] === "runtime" || p[1] === "server" ? `ember-${p[1]}/${p[2]!.split("/")[0]}` : `ember-${p[1]}`;
  return "app";
};

async function startupMs(file: string, compatFlags: string[], classes: string[]): Promise<number[]> {
  const port = 18900 + Math.floor(Math.random() * 500);
  const cfg = join(TMP, `cfg-${port}.capnp`);
  // capnp `embed` paths are relative to the config file.
  const name = `b-${port}-${file.split("/").pop()!}`;
  writeFileSync(join(TMP, name), readFileSync(file));
  const flags = compatFlags.map((f) => JSON.stringify(f)).join(", ");
  writeFileSync(
    cfg,
    `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = ( services = [ (name = "w", worker = .w) ], sockets = [ (name = "http", address = "127.0.0.1:${port}", http = (), service = "w") ] );
const w :Workerd.Worker = ( modules = [ (name = "${name}", esModule = embed "${name}") ], compatibilityDate = "2026-10-01", compatibilityFlags = [${flags}],
  ${classes.length ? `durableObjectNamespaces = [ ${classes.map((c) => `(className = "${c}", uniqueKey = "${c}", enableSql = true)`).join(", ")} ], durableObjectStorage = (inMemory = void), bindings = [ ${classes.map((c) => `(name = "${c.toUpperCase()}", durableObjectNamespace = "${c}")`).join(", ")} ],` : ""} );
`,
  );
  const out: number[] = [];
  for (let i = 0; i < STARTS; i++) {
    const t0 = performance.now();
    const proc = spawn(WORKERD, ["serve", cfg, "--experimental"], { cwd: TMP, stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    proc.stderr!.on("data", (d) => (err += d));
    let ok = false;
    for (let k = 0; k < 2000 && !ok; k++) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/health`);
        await r.text();
        ok = true;
      } catch {
        await sleep(2);
      }
    }
    out.push(performance.now() - t0);
    if (proc.exitCode === null) {
      const exited = new Promise((r) => proc.once("exit", r));
      proc.kill("SIGKILL");
      await exited;
    }
    if (!ok) throw new Error(`workerd did not answer for ${file}: ${err.slice(0, 500)}`);
  }
  return out;
}

const cases: Array<[string, () => string]> = [
  ["init, no auth", () => fresh("noauth", false)],
  ["init, local auth (Better Auth)", () => fresh("auth", true)],
  ["examples/chat", () => example("chat")],
  ["examples/email-lite", () => example("email-lite")],
  ["examples/files-auth-jobs", () => example("files-auth-jobs")],
];

say(`# worker-bundle ${new Date().toISOString()} STARTS=${STARTS}`);
const trivial = join(TMP, "trivial.js");
writeFileSync(trivial, `export default { fetch() { return new Response("ok"); } };`);
const base = await startupMs(trivial, [], []);
say(`baseline trivial Worker: spawn→first answer p50 ${median(base).toFixed(1)} ms (runs ${base.map((x) => x.toFixed(0)).join(" ")})`);

for (const [label, make] of cases) {
  const dir = make();
  const project = loadProject(dir);
  await codegen(project);
  const outDir = join(TMP, "build-" + project.config.project);
  const build = await buildWorker(project, { outDir, minify: true });
  const meta = await esbuild.build({ ...WORKER_BUILD_OPTIONS, entryPoints: [build.entry], write: false, minify: true, metafile: true, nodePaths: [join(REPO, "packages/cli/node_modules"), REPO], absWorkingDir: project.root });
  const output = Object.values(meta.metafile!.outputs)[0]!;
  const groups = new Map<string, number>();
  for (const [k, v] of Object.entries(output.inputs)) groups.set(groupOf(k), (groups.get(groupOf(k)) ?? 0) + v.bytesInOutput);
  const top = [...groups].sort((a, b) => b[1] - a[1]).slice(0, 14);
  const gz = gzipSync(build.code).length;
  const flags = project.config.compatibilityFlags ?? ["nodejs_compat"];
  const s = await startupMs(build.outFile, build.auth?.kind === "local" && !flags.includes("nodejs_compat") ? [...flags, "nodejs_compat"] : flags, build.auth?.kind === "local" ? ["Shard", "System", "Auth"] : ["Shard", "System"]);
  say(
    `\n## ${label} (auth: ${build.auth?.kind ?? "none"})\n` +
      `bundle ${(build.bytes / 1024).toFixed(0)} KiB min, ${(gz / 1024).toFixed(0)} KiB gzip; workerd spawn→first answer p50 ${median(s).toFixed(1)} ms (−baseline ${(median(s) - median(base)).toFixed(1)} ms; runs ${s.map((x) => x.toFixed(0)).join(" ")})\n` +
      top.map(([g, b]) => `  ${(b / 1024).toFixed(1).padStart(7)} KiB  ${g}`).join("\n"),
  );
  writeFileSync(join(TMP, `${project.config.project}.meta.json`), JSON.stringify(meta.metafile));
}
