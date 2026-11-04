import { defineConfig } from "vitest/config";
import { sourceResolve } from "../../vitest.shared.mjs";

export default defineConfig({
  ...sourceResolve,
  esbuild: { jsx: "automatic" },
  test: { environment: "happy-dom", testTimeout: 10_000 },
});
