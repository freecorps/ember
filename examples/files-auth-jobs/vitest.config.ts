import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { workerdSourceResolve } from "../../vitest.shared.mjs";

export default defineConfig({
  ...workerdSourceResolve,
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.test.jsonc" },
      miniflare: { bindings: { EMBER_ADMIN_TOKEN: "admin-secret", EMBER_PROJECT: "files-auth-jobs", EMBER_ENV: "test" } },
    }),
  ],
  test: { include: ["test/**/*.test.ts"], testTimeout: 30_000, hookTimeout: 30_000, fileParallelism: false },
});
