import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { workerdSourceResolve } from "../../vitest.shared.mjs";

/** Presence end to end in workerd: real Worker + Shard DO, WebSocket clients in rooms. */
export default defineConfig({
  ...workerdSourceResolve,
  plugins: [cloudflareTest({ wrangler: { configPath: "./test/workerd/wrangler.jsonc" } })],
  test: { include: ["test/workerd/**/*.test.ts"], testTimeout: 20_000, hookTimeout: 20_000 },
});
