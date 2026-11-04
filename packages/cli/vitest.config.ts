import { defineConfig } from "vitest/config";
import { sourceResolve } from "../../vitest.shared.mjs";

export default defineConfig({
  ...sourceResolve,
  // One heavy thing at a time (TS program, esbuild, workerd): run files sequentially.
  test: { environment: "node", testTimeout: 60_000, hookTimeout: 60_000, fileParallelism: false },
});
