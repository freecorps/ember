import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.test.jsonc" },
      miniflare: { bindings: { RUN_LONG: process.env.RUN_LONG ?? "0" } },
    }),
  ],
  test: { testTimeout: 20_000, hookTimeout: 20_000, fileParallelism: false },
});
