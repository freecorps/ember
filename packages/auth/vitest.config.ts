import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { configDefaults, defineConfig } from "vitest/config";
import { workerdSourceResolve } from "../../vitest.shared.mjs";

export default defineConfig({
  ...workerdSourceResolve,
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.test.jsonc" } })],
  // test/node runs in plain Node (vitest.node.config.ts).
  test: { testTimeout: 60_000, hookTimeout: 60_000, fileParallelism: false, exclude: [...configDefaults.exclude, "test/node/**"] },
});
