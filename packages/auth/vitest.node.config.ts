import { defineConfig } from "vitest/config";
import { sourceResolve } from "../../vitest.shared.mjs";

/** test/node: plain Node (the origin's side of the session lookup runs outside workerd too). */
export default defineConfig({
  ...sourceResolve,
  test: { environment: "node", include: ["test/node/**/*.test.ts"], testTimeout: 10_000 },
});
