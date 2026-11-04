import { defineConfig } from "vitest/config";
import { sourceResolve } from "../../vitest.shared.mjs";

export default defineConfig({
  ...sourceResolve,
  test: { environment: "node", testTimeout: 15_000, exclude: ["**/node_modules/**", "test/workerd/**"] },
});
