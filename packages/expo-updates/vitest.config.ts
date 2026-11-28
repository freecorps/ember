import { configDefaults, defineConfig } from "vitest/config";
import { sourceResolve } from "../../vitest.shared.mjs";

export default defineConfig({
  ...sourceResolve,
  // test/workerd runs in workerd (vitest.workerd.config.ts).
  test: { environment: "node", testTimeout: 10_000, exclude: [...configDefaults.exclude, "test/workerd/**"] },
});
