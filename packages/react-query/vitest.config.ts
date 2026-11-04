import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: { jsx: "automatic" },
  test: { environment: "happy-dom", testTimeout: 10_000 },
});
