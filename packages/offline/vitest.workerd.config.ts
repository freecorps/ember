import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/** End-to-end offline scenario: EmberClient + IndexedDB storage against the real runtime (Shard DO) in workerd. */
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./test/workerd/wrangler.jsonc" } })],
  test: { include: ["test/workerd/**/*.test.ts"], testTimeout: 30_000, hookTimeout: 20_000 },
});
