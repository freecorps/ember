import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { workerdSourceResolve } from "../../vitest.shared.mjs";
import { createReceivers } from "./test/workerd/receivers.ts";

/** The webhooks component in workerd (real runtime: Worker + Shard DO, scheduler, action jobs), POSTing to fake receivers. */
const receivers = createReceivers();

export default defineConfig({
  ...workerdSourceResolve,
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./test/workerd/wrangler.jsonc" },
      // Every outbound fetch (Worker and Durable Objects) goes to the receivers, in Node.
      miniflare: { outboundService: async (request: any) => (await receivers.handler(request as Request)) as any },
    }),
  ],
  test: { include: ["test/workerd/**/*.test.ts"], testTimeout: 30_000, hookTimeout: 20_000 },
});
