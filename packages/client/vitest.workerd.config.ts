import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/** Integration test: EmberClient against the real runtime + engine in workerd. */
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./test/workerd/wrangler.jsonc" } })],
  test: { include: ["test/workerd/**/*.test.ts"], testTimeout: 20_000, hookTimeout: 20_000 },
});
