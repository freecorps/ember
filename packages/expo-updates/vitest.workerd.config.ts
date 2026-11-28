import { generateKeyPairSync } from "node:crypto";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { workerdSourceResolve } from "../../vitest.shared.mjs";

/** The component in workerd: real runtime (Worker + Shard DO, R2 in Miniflare, caches.default), a fresh signing key. */
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

export default defineConfig({
  ...workerdSourceResolve,
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./test/workerd/wrangler.jsonc" },
      miniflare: {
        bindings: {
          EMBER_ADMIN_TOKEN: "admin-test",
          // PKCS#1, as `npx expo-updates codesigning:generate` writes it.
          EXPO_UPDATES_PRIVATE_KEY: privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
          EXPO_TEST_PUBLIC_KEY: publicKey.export({ type: "spki", format: "pem" }).toString(),
        },
      },
    }),
  ],
  test: { include: ["test/workerd/**/*.test.ts"], testTimeout: 30_000, hookTimeout: 20_000 },
});
