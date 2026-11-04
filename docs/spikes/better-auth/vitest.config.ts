import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
  define: { __WITH_FK__: JSON.stringify(process.env.WITH_FK ?? "0") },
  test: { testTimeout: 60_000, hookTimeout: 60_000 },
});
