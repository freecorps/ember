import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { workerdSourceResolve } from "../../vitest.shared.mjs";

/** Integration test: EmberClient against the real runtime + engine in workerd. */
export default defineConfig({
  ...workerdSourceResolve,
  plugins: [cloudflareTest({ wrangler: { configPath: "./test/workerd/wrangler.jsonc" } })],
  test: {
    include: ["test/workerd/**/*.test.ts"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // A condition waited for (`expect.poll`) gets 10 s, not 1 s: these run real sockets against the real runtime, on CI
    // next to other suites. Only a failing test waits longer.
    expect: { poll: { timeout: 10_000 } },
  },
});
