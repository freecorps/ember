import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { workerdSourceResolve } from "../../vitest.shared.mjs";

export default defineConfig({
  ...workerdSourceResolve,
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.test.jsonc" },
      miniflare: {
        bindings: { RUN_LONG: process.env.RUN_LONG ?? "0", GROUP_COMMIT: process.env.GROUP_COMMIT ?? "timer", EMBER_ADMIN_TOKEN: "admin-secret", EMBER_PROJECT: "test", EMBER_ENV: "test", EMBER_VERSION: { id: "test-version-1" } },
        d1Databases: ["EMBER_REGISTRY"],
      },
    }),
  ],
  test: { testTimeout: 20_000, hookTimeout: 20_000, fileParallelism: false },
});
