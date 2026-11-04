import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { sourceResolve } from "../../vitest.shared.mjs";

export default defineConfig({
  ...sourceResolve,
  resolve: {
    ...sourceResolve.resolve,
    alias: {
      // The runtime's strict protocol decoder (pure TS) validates every frame the client sends in tests.
      "#runtime-protocol": fileURLToPath(new URL("../runtime/src/protocol.ts", import.meta.url)),
    },
  },
  test: { environment: "node", testTimeout: 10_000, exclude: ["**/node_modules/**", "test/workerd/**"] },
});
