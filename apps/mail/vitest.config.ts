import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { workerdSourceResolve } from "../../vitest.shared.mjs";

export default defineConfig({
  ...workerdSourceResolve,
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.test.jsonc" },
      miniflare: { bindings: { EMBER_ADMIN_TOKEN: "admin-secret", EMBER_PROJECT: "mail", EMBER_ENV: "test", CLOUDFLARE_API_TOKEN: "cf-test", CLOUDFLARE_ACCOUNT_ID: "acc" } },
    }),
  ],
  test: { testTimeout: 20_000, hookTimeout: 20_000, fileParallelism: false },
});
