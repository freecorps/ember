// The Worker bundle resolves npm packages written for Node the way wrangler does (docs/spikes/node-actions):
// bare builtins and require() of them become `node:` imports, package.json "browser" maps apply, npm readable-stream
// is Node's stream (exceljs' streaming writer through archiver), and process.env.NODE_ENV stays a runtime lookup.
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
  // A stand-in for npm readable-stream: its browser build would be a userland Stream, not Node's.
  pkg("readable-stream", {
    "package.json": JSON.stringify({ name: "readable-stream", main: "readable.js", browser: { "./readable.js": "./readable-browser.js" } }),
    "readable.js": `module.exports = "userland readable-stream";`,
    "readable-browser.js": `module.exports = "userland readable-stream";`,
    "passthrough.js": `module.exports = "userland readable-stream";`,
  });
  // archiver-style checks: `instanceof Stream` from readable-stream against Node's stream, subpaths included.
  pkg("rs-user", {
    "package.json": JSON.stringify({ name: "rs-user", main: "index.js" }),
    "index.js": [
      `const Stream = require("stream");`,
      `const rs = require("readable-stream");`,
      `const PassThrough = require("readable-stream/passthrough");`,
      `const { Transform } = require("readable-stream");`,
      `const t = new Transform({ transform(c, _e, cb) { cb(null, c); } });`,
      `module.exports = { isReadable: rs === Stream.Readable, stream: rs.Stream === Stream, passThrough: PassThrough === Stream.PassThrough, nodeStream: t instanceof Stream.Stream && new PassThrough() instanceof Stream };`,
    ].join("\n"),
  });
  writeFileSync(
    join(dir, "entry.js"),
    [
      `import fs from "fs";`,
      `import { pipeline } from "stream/promises";`,
      `import lib from "cjs-node-lib";`,
      `import which from "browser-map-lib";`,
      `import rs from "rs-user";`,
      `import { Readable } from "readable-stream";`,
      `export default { fetch() { return Response.json({ fs: typeof fs.readFileSync, pipeline: typeof pipeline, lib, which, rs, esm: typeof Readable.from, nodeEnv: process.env.NODE_ENV ?? null }); } };`,
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

it("readable-stream and its class entry points resolve to node:stream", () => {
  expect(code).not.toContain("userland readable-stream");
  for (const m of ["Readable", "PassThrough"]) expect(code).toContain(`"ember-readable-stream:${m}"`);
});

it("the bundle runs in workerd with nodejs_compat", async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: [{ type: "ESModule", path: join(dir, "index.js"), contents: code }], compatibilityDate: "2026-10-01", compatibilityFlags: ["nodejs_compat"] }));
  try {
    const res = await mf.dispatchFetch("http://x/");
    expect(await res.json()).toEqual({ fs: "function", pipeline: "function", lib: { readable: "function", ee: "function", hash: "2d711642", gz: "ok" }, which: "browser", rs: { isReadable: true, stream: true, passThrough: true, nodeStream: true }, esm: "function", nodeEnv: null });
  } finally {
    await mf.dispose();
  }
});
