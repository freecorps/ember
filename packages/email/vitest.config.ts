import { defineConfig } from "vitest/config";
import { sourceResolve } from "../../vitest.shared.mjs";

export default defineConfig({
  ...sourceResolve,
  // Property-style inbox tests run thousands of mutations: generous when CI runs every suite at once.
  test: { environment: "node", testTimeout: 60_000 },
});
