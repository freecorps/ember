import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { workerdSourceResolve } from "../../vitest.shared.mjs";

/** The audit component in workerd: real runtime (Worker, Shard and System DOs, alarms), the cron and R2 in miniflare. */
export default defineConfig({
  ...workerdSourceResolve,
  plugins: [cloudflareTest({ wrangler: { configPath: "./test/workerd/wrangler.jsonc" } })],
  test: { include: ["test/workerd/**/*.test.ts"], testTimeout: 30_000, hookTimeout: 20_000 },
});
