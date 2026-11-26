import { defineConfig } from "vitest/config";
import { sourceResolve } from "../../vitest.shared.mjs";

export default defineConfig({
  ...sourceResolve,
  test: { include: ["test/**/*.test.ts"], testTimeout: 30_000, hookTimeout: 60_000, fileParallelism: false },
});
