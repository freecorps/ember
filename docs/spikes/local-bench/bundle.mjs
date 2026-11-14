// Client bundle sizes (esbuild, minified ESM for the browser, the repo's source condition): the whole entry points,
// and what an app pays (an entry that only creates an EmberClient; one with the React hooks and usePaginatedQuery).
//
//   node docs/spikes/local-bench/bundle.mjs [repo root]
import { build } from "esbuild";
import { gzipSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(process.argv[2] ?? join(import.meta.dirname, "../../.."));
const dir = join(root, "packages/cli/.tmp/bundle-app");
mkdirSync(dir, { recursive: true });
const app = (name, src) => {
  const f = join(dir, `${name}.ts`);
  writeFileSync(f, src);
  return f;
};
const cases = [
  ["entry @freecorps/ember-client", join(root, "packages/client/src/index.ts"), []],
  ["entry @freecorps/ember-react", join(root, "packages/react/src/index.ts"), ["react", "@freecorps/ember-client"]],
  ["app: EmberClient only", app("client", `import { EmberClient } from "../../../client/src/index.ts"; export const c = new EmberClient({ url: "https://x" });`), []],
  [
    "app: EmberClient + React hooks (useQuery, useMutation, usePaginatedQuery)",
    app("react", `import { EmberClient } from "../../../client/src/index.ts"; export { EmberProvider, useQuery, useMutation, usePaginatedQuery } from "../../../react/src/index.ts"; export const c = new EmberClient({ url: "https://x" });`),
    ["react"],
  ],
];
for (const [name, entry, external] of cases) {
  const r = await build({ entryPoints: [entry], bundle: true, minify: true, format: "esm", platform: "browser", write: false, conditions: ["@freecorps/ember-source"], external, metafile: true, absWorkingDir: root, logLevel: "silent" });
  const code = r.outputFiles[0].contents;
  const out = r.metafile.outputs[Object.keys(r.metafile.outputs)[0]];
  const top = Object.entries(out.inputs).map(([k, v]) => [k.replace(/.*packages\//, ""), v.bytesInOutput]).sort((a, b) => b[1] - a[1]).slice(0, 7);
  console.log(`${name}: ${(code.length / 1024).toFixed(1)} KB min, ${(gzipSync(code).length / 1024).toFixed(1)} KB gzip; ${top.map(([k, v]) => `${k} ${(v / 1024).toFixed(1)}`).join(", ")}`);
}
