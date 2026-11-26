import { defineConfig } from "vitest/config";
import { sourceResolve } from "../../vitest.shared.mjs";

export default defineConfig({
  ...sourceResolve,
  esbuild: { jsx: "automatic" },
  test: {
    include: ["test/*.test.ts", "test/*.test.tsx"],
    environment: "node",
    testTimeout: 10_000,
  },
});
