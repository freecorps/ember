import { createRequire } from "node:module";
import { builtinModules } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { buildSync } from "esbuild";
import { defineConfig } from "vitest/config";
import { workerdSourceResolve } from "../../vitest.shared.mjs";

/**
 * samlify (the sso plugin's SAML library) is CommonJS, and the test runner's module fallback resolves its bare
 * `require("xml")` (the npm package) to its own sibling `build/src/xml.js`. A wrangler build bundles it with esbuild,
 * which resolves it right; the plugin tests do the same: one ESM bundle, aliased below, with Node's built-ins handed to
 * its `require` from `node:*` imports (nodejs_compat).
 */
function bundleSamlify(): string {
  const outfile = join(dirname(fileURLToPath(import.meta.url)), "node_modules/.cache/ember-test/samlify.mjs");
  const used = ["buffer", "crypto", "events", "fs", "path", "stream", "string_decoder", "url", "util", "zlib"];
  const banner = [
    ...used.map((m) => `import * as __node_${m} from "node:${m}";`),
    `const __node = { ${used.map((m) => `${m}: __node_${m}.default ?? __node_${m}`).join(", ")} };`,
    `const require = (m) => { const k = m.replace(/^node:/, ""); if (k in __node) return __node[k]; throw new Error("samlify bundle: no built-in " + m); };`,
  ].join("\n");
  buildSync({
    entryPoints: [createRequire(import.meta.url).resolve("samlify")],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile,
    external: [...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
    banner: { js: banner },
    logLevel: "error",
  });
  return outfile;
}

// Two workerd Workers: the package's own (test/worker.ts, Auth DOs only) and the plugin flows (test/plugins/worker.ts:
// a whole Ember app, Shard + System + an Auth DO with sso, scim, oauthProvider, passkey, apiKey, stripe and expo).
// test/node runs in plain Node (vitest.node.config.ts): neither project includes it.
export default defineConfig({
  ...workerdSourceResolve,
  test: {
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    projects: [
      {
        extends: true,
        plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.test.jsonc" } })],
        test: { name: "auth", include: ["test/*.test.ts"] },
      },
      {
        extends: true,
        plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.plugins.jsonc" } })],
        resolve: { alias: { samlify: bundleSamlify() } },
        test: { name: "plugins", include: ["test/plugins/*.test.ts"], server: { deps: { inline: ["@better-auth/sso"] } } },
      },
    ],
  },
});
