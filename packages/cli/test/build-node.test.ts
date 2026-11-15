// The Worker bundle resolves npm packages written for Node the way wrangler does (docs/spikes/node-actions):
// bare builtins and require() of them become `node:` imports, package.json "browser" maps apply, and
// process.env.NODE_ENV stays a runtime lookup.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as esbuild from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { afterAll, beforeAll, expect, it } from "vitest";
import { WORKER_BUILD_OPTIONS } from "../src/build.ts";
import { TMP } from "./helpers.ts";

const dir = join(TMP, `build-node-${process.pid}`);
let code = "";

function pkg(name: string, files: Record<string, string>) {
  const root = join(dir, "node_modules", name);
  mkdirSync(root, { recursive: true });
  for (const [f, c] of Object.entries(files)) writeFileSync(join(root, f), c);
}

beforeAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  // CJS written for Node: require() of bare builtins (exceljs' streaming reader, jszip's readable-stream, ...).
  pkg("cjs-node-lib", {
    "package.json": JSON.stringify({ name: "cjs-node-lib", main: "index.js" }),
    "index.js": [
      `const { Readable } = require("stream");`,
      `const { EventEmitter } = require("events");`,
      `const crypto = require("crypto");`,
      `const zlib = require("node:zlib");`,
      `module.exports = { readable: typeof Readable.from, ee: typeof EventEmitter, hash: crypto.createHash("sha256").update("x").digest("hex").slice(0, 8), gz: zlib.gunzipSync(zlib.gzipSync("ok")).toString() };`,
    ].join("\n"),
  });
  // A "browser" map (as @aws-sdk/client-s3 uses for its runtime config): the Worker gets the mapped file.
  pkg("browser-map-lib", {
    "package.json": JSON.stringify({ name: "browser-map-lib", main: "./index.js", browser: { "./config.js": "./config.browser.js" } }),
    "index.js": `module.exports = require("./config.js");`,
    "config.js": `module.exports = "node";`,
    "config.browser.js": `module.exports = "browser";`,
  });
  writeFileSync(
    join(dir, "entry.js"),
    [
      `import fs from "fs";`,
      `import { pipeline } from "stream/promises";`,
      `import lib from "cjs-node-lib";`,
      `import which from "browser-map-lib";`,
      `export default { fetch() { return Response.json({ fs: typeof fs.readFileSync, pipeline: typeof pipeline, lib, which, nodeEnv: process.env.NODE_ENV ?? null }); } };`,
    ].join("\n"),
  );
  const out = await esbuild.build({ ...WORKER_BUILD_OPTIONS, entryPoints: [join(dir, "entry.js")], write: false, absWorkingDir: dir });
  code = out.outputFiles[0]!.text;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

it("bare and required Node builtins become external node: imports", () => {
  for (const m of ["node:fs", "node:stream/promises", "node:stream", "node:events", "node:crypto", "node:zlib"]) expect(code).toContain(`from "${m}"`);
  expect(code).not.toMatch(/__require\("(node:)?(stream|events|crypto|zlib)"\)/);
  expect(code).not.toContain(`"development"`);
});

it("the bundle runs in workerd with nodejs_compat", async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: [{ type: "ESModule", path: join(dir, "index.js"), contents: code }], compatibilityDate: "2026-10-01", compatibilityFlags: ["nodejs_compat"] }));
  try {
    const res = await mf.dispatchFetch("http://x/");
    expect(await res.json()).toEqual({ fs: "function", pipeline: "function", lib: { readable: "function", ee: "function", hash: "2d711642", gz: "ok" }, which: "browser", nodeEnv: null });
  } finally {
    await mf.dispose();
  }
});
