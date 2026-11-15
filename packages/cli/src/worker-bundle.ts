// esbuild options of the Worker bundle (`buildWorker` in build.ts). Kept free of other dependencies so the L13 spike
// harness (docs/spikes/node-actions/harness.mjs) imports these exact options under plain Node (type stripping).

import { builtinModules } from "node:module";
import type * as esbuild from "esbuild";
import { SOURCE_CONDITIONS } from "./source.ts";

const NODE_BUILTINS = builtinModules.filter((m) => !m.startsWith("_") && !m.startsWith("node:"));
const NODE_BUILTIN_RE = new RegExp(`^(${NODE_BUILTINS.map((m) => m.replace(/[/]/g, "\\/")).join("|")}|node:.+)$`);

/**
 * npm `readable-stream` (v2/v3/v4: a userland copy of Node streams) and its class entry points, as Node's own
 * `node:stream`. Under platform "browser" its browser build applies, whose `Stream` is a bare EventEmitter, and
 * `instanceof Stream` checks against Node's stream fail (archiver rejects exceljs' streams: "input source must be
 * valid Stream or Buffer instance"). `readable.js` with READABLE_STREAM=disable does the same on Node: the export is
 * `Readable` with the `stream` module's members copied onto it, `.Stream` the module itself.
 */
const READABLE_STREAM_RE = /^readable-stream(?:\/(readable|writable|duplex|transform|passthrough)(?:\.js)?)?$/;
const READABLE_STREAM_CLASS: Record<string, string> = { writable: "Writable", duplex: "Duplex", transform: "Transform", passthrough: "PassThrough" };

/**
 * Node builtins under `nodejs_compat`, as wrangler resolves them: bare (`"fs"`, `"stream/web"`) or prefixed, every
 * one is the external `node:` module; a `require()` of one becomes an ESM shim, since an external `require()` in an
 * ESM bundle throws "Dynamic require of ... is not supported" when it runs. Most npm packages written for Node use
 * bare specifiers, which otherwise fail the build with `Could not resolve "fs"` (docs/spikes/node-actions).
 * Unlike wrangler, `readable-stream` is Node's stream too (READABLE_STREAM_RE).
 */
export const nodeBuiltinsPlugin: esbuild.Plugin = {
  name: "ember-node-builtins",
  setup(b) {
    b.onResolve({ filter: NODE_BUILTIN_RE }, (a) => {
      const path = a.path.startsWith("node:") ? a.path : `node:${a.path}`;
      return a.kind === "require-call" ? { path, namespace: "ember-node-require" } : { path, external: true };
    });
    b.onLoad({ filter: /.*/, namespace: "ember-node-require" }, (a) => ({ contents: `import m from ${JSON.stringify(a.path)};\nmodule.exports = m;`, loader: "js" }));
    b.onResolve({ filter: READABLE_STREAM_RE }, (a) => ({ path: READABLE_STREAM_CLASS[READABLE_STREAM_RE.exec(a.path)![1] ?? ""] ?? "Readable", namespace: "ember-readable-stream" }));
    b.onLoad({ filter: /.*/, namespace: "ember-readable-stream" }, (a) => ({
      contents:
        a.path === "Readable"
          ? `import Stream from "node:stream";\nconst Readable = Stream.Readable;\nObject.assign(Readable, Stream);\nReadable.Stream = Stream;\nmodule.exports = Readable;`
          : `import Stream from "node:stream";\nmodule.exports = Stream.${a.path};`,
      loader: "js",
    }));
  },
};

/**
 * Same resolution as wrangler: platform "browser" (esbuild's default) so package.json `browser` maps apply (with
 * "neutral" they are ignored while the `browser` export condition still is, which pairs e.g. @aws-sdk/client-s3's
 * Node runtime config with @aws-sdk/core's browser stubs), and Node builtins through `nodeBuiltinsPlugin`.
 * `process.env.NODE_ENV` stays a runtime lookup (platform "browser" would otherwise inline "development").
 */
export const WORKER_BUILD_OPTIONS = {
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2023",
  conditions: [...SOURCE_CONDITIONS, "workerd", "worker", "browser", "import", "module"],
  mainFields: ["browser", "module", "main"],
  external: ["cloudflare:*", "node:*"],
  define: { "process.env.NODE_ENV": "process.env.NODE_ENV" },
  plugins: [nodeBuiltinsPlugin],
  logLevel: "silent",
} satisfies esbuild.BuildOptions;
