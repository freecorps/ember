// Packs every publishable package exactly as `release.ts publish` would, installs the tarballs into a throwaway
// project outside the repo and checks what a user gets from npm:
//
//   - tarball contents: dist/ JS + .d.ts for every export, LICENSE/README, no sources or tests; the CLI ships bin/
//     and the prebuilt dashboard;
//   - `ember --help`, `ember init`, `ember codegen` on plain Node (no flags), then `tsc --noEmit` on the sample app;
//   - consumer code importing server/client/react (bundler resolution) and values/server/client (nodenext) type-checks,
//     with a deliberate type error that must fail (so the types are real, not `any`);
//   - Node-safe packages import at runtime; the CLI builds the dashboard from its prebuilt copy;
//   - `ember dev` bundles the published runtime into a Worker, serves it, and a mutation + query round-trip works.
//
//   bun scripts/verify-pack.ts [--no-build] [--keep] [--node /path/to/node] [--skip-dev]
//
// Temp dirs (project, tarballs, npm cache) are removed at the end unless --keep.

import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pack, stage } from "./release.ts";

const args = process.argv.slice(2);
const flag = (f: string) => args.includes(f);
const NODE = flag("--node") ? args[args.indexOf("--node") + 1]! : "node";

const tmp = mkdtempSync(join(tmpdir(), "ember-verify-"));
const app = join(tmp, "app");
const cache = join(tmp, "npm-cache");
// Plain Node: no inherited flags or loaders from the caller.
const env = { ...process.env, NODE_OPTIONS: "", npm_config_cache: cache, npm_config_update_notifier: "false" };
let failures = 0;

function step(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve()
    .then(fn)
    .then(
      () => console.log(`  ok    ${name}`),
      (e) => {
        failures++;
        console.log(`  FAIL  ${name}\n${String((e as Error)?.message ?? e).replace(/^/gm, "        ")}`);
      },
    );
}

function run(cmd: string, argv: string[], cwd = app, expectFail = false): string {
  const r = spawnSync(cmd, argv, { cwd, env, encoding: "utf8" });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (expectFail ? r.status === 0 : r.status !== 0) throw new Error(`${cmd} ${argv.join(" ")} → exit ${r.status}\n${out.slice(-4000)}`);
  return out;
}

const ember = (...a: string[]) => run(NODE, [join(app, "node_modules/@freecorps/ember-cli/bin/ember.js"), ...a]);
const tsc = (project: string, expectFail = false) => run(NODE, [join(app, "node_modules/typescript/bin/tsc"), "--noEmit", "-p", project], app, expectFail);

const CONSUMER = `import { EmberClient } from "@freecorps/ember-client";
import { EmberProvider, useMutation, useQuery } from "@freecorps/ember-react";
import { defineSchema, defineTable, v } from "@freecorps/ember-server";
import { api } from "../ember/_generated/api";

export const schema = defineSchema({ tables: { notes: defineTable({ text: v.string() }) } });

export function useGeneral(): number | undefined {
  const send = useMutation(api.messages.send);
  void send;
  return useQuery(api.messages.count, { channel: "general" });
}
export const provider: typeof EmberProvider = EmberProvider;
export type Client = EmberClient;
`;
const CONSUMER_ERR = `import { useQuery } from "@freecorps/ember-react";
import { api } from "../ember/_generated/api";
export const n: number | undefined = useQuery(api.messages.count, { channel: 1 });
`;
const NODENEXT = `import { v, type Infer } from "@freecorps/ember-values";
import { defineSchema, defineTable } from "@freecorps/ember-server";
import { createNodeSqliteDriver } from "@freecorps/ember-server/testing";
import { EmberClient } from "@freecorps/ember-client";
const row = v.object({ a: v.string(), b: v.optional(v.number()) });
export const x: Infer<typeof row> = { a: "s" };
export const s = defineSchema({ tables: { t: defineTable({ a: v.string() }) } });
export type C = EmberClient;
export const d = createNodeSqliteDriver;
`;

function tsconfig(extra: Record<string, unknown>, include: string[]) {
  return JSON.stringify({
    compilerOptions: { strict: true, noEmit: true, skipLibCheck: false, target: "ES2022", lib: ["ES2023", "DOM"], types: [], ...extra },
    include,
  });
}

async function devRoundTrip() {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(NODE, [join(app, "node_modules/@freecorps/ember-cli/bin/ember.js"), "dev", "--port", String(port), "--no-persist"], {
    cwd: app,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  try {
    const url = await new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`ember dev did not start in 90s\n${log}`)), 90_000);
      const poll = setInterval(() => {
        const m = /ember dev: (\S+)/.exec(log);
        if (m) {
          clearTimeout(t);
          clearInterval(poll);
          resolve(m[1]!.replace(/\/$/, ""));
        }
      }, 100);
      child.on("exit", (code) => reject(new Error(`ember dev exited (${code})\n${log}`)));
    });
    const call = async (kind: string, fn: string, a: unknown) => {
      const res = await fetch(`${url}/api/${kind}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fn, args: a, shard: "global:main" }) });
      const body = (await res.json()) as { ok: boolean; value?: unknown; error?: unknown };
      if (!body.ok) throw new Error(`${kind} ${fn}: ${JSON.stringify(body)}\n${log}`);
      return body.value;
    };
    await call("mutation", "messages:send", { channel: "general", author: "verify", body: "hello" });
    const n = await call("query", "messages:count", { channel: "general" });
    if (n !== 1) throw new Error(`messages:count returned ${JSON.stringify(n)}`);
  } finally {
    child.kill("SIGINT");
    await new Promise((r) => setTimeout(r, 500));
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}

try {
  console.log(`verify-pack: ${tmp} (node: ${run(NODE, ["--version"], tmp).trim()})`);
  const staged = await stage({ build: !flag("--no-build") });
  const packed = pack(staged, join(tmp, "tarballs"));

  console.log("\ntarballs:");
  for (const p of packed) {
    const files = p.info.files.map((f) => f.path);
    console.log(`  ${p.name.padEnd(30)} ${String(p.info.entryCount).padStart(3)} files ${(p.info.size / 1024).toFixed(1).padStart(7)} KiB packed ${(p.info.unpackedSize / 1024).toFixed(1).padStart(7)} KiB unpacked`);
    await step(`${p.name}: contents`, () => {
      const json = JSON.parse(readFileSync(join(p.dir, "package.json"), "utf8"));
      const need = ["package.json", "LICENSE", "README.md"];
      const walk = (e: unknown): string[] => (typeof e === "string" ? [e] : e && typeof e === "object" ? Object.values(e).flatMap(walk) : []);
      for (const t of walk(json.exports)) need.push(t.replace(/^\.\//, ""));
      if (json.bin) need.push(...Object.values(json.bin as Record<string, string>).map((b) => b.replace(/^\.\//, "")));
      if (p.name === "@freecorps/ember-cli") need.push("dist/dashboard/app.js", "dist/dashboard/app.css", "dist/dashboard/worker.js");
      const missing = need.filter((f) => !files.includes(f));
      if (missing.length) throw new Error(`missing: ${missing.join(", ")}`);
      const bad = files.filter((f) => /^(src|test)\//.test(f) || /\.test\.|tsconfig|vitest/.test(f));
      if (bad.length) throw new Error(`unexpected: ${bad.join(", ")}`);
    });
  }

  console.log("\ninstall + checks:");
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, "package.json"), JSON.stringify({ name: "ember-verify-app", private: true, type: "module" }, null, 2));
  const ts = JSON.parse(readFileSync(join(import.meta.dir, "..", "node_modules/typescript/package.json"), "utf8")).version;
  await step("npm install tarballs (+ typescript, react, @types/react)", () => {
    run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error", ...packed.map((p) => p.tarball), `typescript@${ts}`, "react@19", "@types/react@19"]);
  });
  await step("ember --help on plain node", () => {
    const out = ember("--help");
    if (!out.includes("ember <command>")) throw new Error(out);
  });
  await step("ember init", () => void ember("init", "--project", "verify-app"));
  await step("ember codegen", () => {
    ember("codegen");
    if (!existsSync(join(app, "ember/_generated/api.d.ts")) && !existsSync(join(app, "ember/_generated/api.ts"))) throw new Error("no ember/_generated/api");
  });
  await step("tsc --noEmit (sample app, ember/tsconfig.json)", () => void tsc("ember/tsconfig.json"));
  mkdirSync(join(app, "src"), { recursive: true });
  writeFileSync(join(app, "src/consumer.ts"), CONSUMER);
  writeFileSync(join(app, "src/consumer-error.ts"), CONSUMER_ERR);
  writeFileSync(join(app, "src/nodenext.ts"), NODENEXT);
  const bundler = { module: "ESNext", moduleResolution: "Bundler", jsx: "react-jsx", types: ["react"] };
  writeFileSync(join(app, "tsconfig.bundler.json"), tsconfig(bundler, ["src/consumer.ts"]));
  writeFileSync(join(app, "tsconfig.error.json"), tsconfig(bundler, ["src/consumer-error.ts"]));
  writeFileSync(join(app, "tsconfig.nodenext.json"), tsconfig({ module: "NodeNext", moduleResolution: "NodeNext", types: ["node"] }, ["src/nodenext.ts"]));
  await step("types: server + client + react + generated api (bundler, skipLibCheck off)", () => void tsc("tsconfig.bundler.json"));
  await step("types: a wrong arg type is rejected (types are not any)", () => {
    const out = tsc("tsconfig.error.json", true);
    if (!/TS2322|TS2345|TS2769/.test(out)) throw new Error(`unexpected tsc output:\n${out}`);
  });
  await step("types: values + server(/testing) + client (NodeNext)", () => {
    run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error", "@types/node@22"]);
    tsc("tsconfig.nodenext.json");
  });
  await step("runtime imports on node (values, server, server/testing, client, push)", () => {
    run(NODE, [
      "--input-type=module",
      "-e",
      `const m = await Promise.all(["@freecorps/ember-values", "@freecorps/ember-server", "@freecorps/ember-server/testing", "@freecorps/ember-client", "@freecorps/ember-push"].map((p) => import(p)));
       if (typeof m[1].defineSchema !== "function" || typeof m[0].v?.string !== "function" || typeof m[2].createNodeSqliteDriver !== "function" || typeof m[3].EmberClient !== "function") throw new Error("missing exports");`,
    ]);
  });
  await step("dashboard builds from the prebuilt copy in the CLI package", () => {
    run(NODE, ["--input-type=module", "-e", `const m = await import("@freecorps/ember-cli"); const b = await m.buildDashboard(); if (b.bytes < 50000 || b.assets.js < 50000) throw new Error("bad dashboard build " + JSON.stringify(b.assets));`]);
  });
  if (!flag("--skip-dev")) await step("ember dev: bundle the published runtime, mutation + query round-trip", devRoundTrip);
} finally {
  if (flag("--keep")) console.log(`\nkept ${tmp}`);
  else rmSync(tmp, { recursive: true, force: true });
}

console.log(failures ? `\nverify-pack: ${failures} check(s) failed` : "\nverify-pack: all checks passed");
process.exit(failures ? 1 : 0);
