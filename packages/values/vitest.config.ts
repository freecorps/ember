import { defineConfig } from "vitest/config";
import { sourceResolve } from "../../vitest.shared.mjs";

export default defineConfig({
  ...sourceResolve,
  // CPU-bound property/randomised suites: generous timeout when the whole monorepo runs in parallel.
  test: { environment: "node", testTimeout: 30_000 },
});
