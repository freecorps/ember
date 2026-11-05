// In-region load for Convex (docs/spikes/remote/convex-vs-ember.md, "dentro da região"): an action keeps `parallel`
// ctx.runMutation calls in flight for `ms` (≤ 20 s), so the numbers exclude the Brazil link and the laptop. This is the
// Convex counterpart of Ember's in-region load generator (bench.md B1/B2), not of the laptop harness.
import { v } from "convex/values";
import { action } from "./_generated/server";
import { api } from "./_generated/api";

export const burst = action({
  args: { kind: v.union(v.literal("put"), v.literal("incr")), parallel: v.number(), ms: v.number(), name: v.string() },
  handler: async (ctx, { kind, parallel, ms, name }) => {
    const end = Date.now() + Math.min(ms, 20_000);
    const lat: number[] = [];
    let ok = 0, errors = 0;
    let firstError: string | null = null;
    const t0 = Date.now();
    await Promise.all(
      Array.from({ length: Math.min(parallel, 256) }, async (_, i) => {
        let seq = 0;
        while (Date.now() < end) {
          const s = Date.now();
          try {
            if (kind === "put") await ctx.runMutation(api.bench.put, { n: i * 1e6 + seq++, sentAt: s, body: "x".repeat(64) });
            else await ctx.runMutation(api.bench.incr, { name });
            ok++;
            lat.push(Date.now() - s);
          } catch (e) {
            errors++;
            firstError ??= String((e as Error).message).slice(0, 200);
          }
        }
      }),
    );
    lat.sort((a, b) => a - b);
    const p = (q: number) => lat[Math.min(lat.length - 1, Math.floor(q * lat.length))] ?? null;
    return { ok, errors, firstError, wallMs: Date.now() - t0, p50: p(0.5), p95: p(0.95), p99: p(0.99), max: lat.at(-1) ?? null };
  },
});
