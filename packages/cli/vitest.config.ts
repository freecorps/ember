import { defineConfig } from "vitest/config";

export default defineConfig({
  // One heavy thing at a time (TS program, esbuild, workerd): run files sequentially.
  test: { environment: "node", testTimeout: 60_000, hookTimeout: 60_000, fileParallelism: false },
});
