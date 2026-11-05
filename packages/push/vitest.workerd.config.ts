import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { workerdSourceResolve } from "../../vitest.shared.mjs";
import { createFakeServices } from "./test/workerd/fake-services.ts";

/** The push component in workerd (real runtime: Worker + Shard DO), sending to fake APNs/FCM through outboundService. */
const fakes = await createFakeServices();

export default defineConfig({
  ...workerdSourceResolve,
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./test/workerd/wrangler.jsonc" },
      miniflare: {
        bindings: fakes.bindings,
        // Every outbound fetch (Worker and Durable Objects) goes to the fakes, in Node.
        outboundService: async (request: any) => (await fakes.handler(request as Request)) as any,
      },
    }),
  ],
  test: { include: ["test/workerd/**/*.test.ts"], testTimeout: 30_000, hookTimeout: 20_000 },
});
