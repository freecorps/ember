/**
 * Password hashing cost inside workerd (local). Better Auth's default:
 * scrypt N=16384 r=16 p=1 dkLen=64 (32 MiB working memory per hash).
 */
import { it, expect } from "vitest";
import { scrypt as nodeScrypt } from "node:crypto";
import { scryptAsync } from "@noble/hashes/scrypt.js";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { env } from "cloudflare:test";

const P = { N: 16384, r: 16, p: 1, dkLen: 64, maxmem: 128 * 16384 * 16 * 2 };
const N_RUNS = 5;

// workerd may only advance timers across I/O; force an I/O boundary.
const tick = () => new Promise((r) => setTimeout(r, 0));
async function time<T>(fn: () => Promise<T>) {
  await tick();
  const t = Date.now();
  await fn();
  await tick();
  return Date.now() - t;
}

it("scrypt cost in workerd", async () => {
  // sanity: does the clock advance during pure CPU work?
  const t0 = Date.now();
  let x = 0;
  for (let i = 0; i < 50_000_000; i++) x += i;
  const clockAdvancesDuringCpu = Date.now() - t0 > 0;
  expect(x).toBeGreaterThan(0);

  const out: Record<string, unknown> = { clockAdvancesDuringCpu };
  const nodeMs: number[] = [];
  const nobleMs: number[] = [];
  const baMs: number[] = [];
  for (let i = 0; i < N_RUNS; i++) {
    nodeMs.push(
      await time(
        () =>
          new Promise<void>((res, rej) =>
            nodeScrypt("pw", "salt" + i, P.dkLen, { N: P.N, r: P.r, p: P.p, maxmem: P.maxmem }, (e: Error | null) => (e ? rej(e) : res())),
          ),
      ),
    );
    nobleMs.push(await time(() => scryptAsync("pw", "salt" + i, P)));
    baMs.push(await time(() => hashPassword("pw" + i)));
  }
  const h = await hashPassword("pw");
  expect(await verifyPassword({ hash: h, password: "pw" })).toBe(true);
  const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  Object.assign(out, {
    nodeCryptoScryptMs: nodeMs,
    nobleScryptMs: nobleMs,
    betterAuthHashPasswordMs: baMs,
    medians: { node: med(nodeMs), noble: med(nobleMs), betterAuth: med(baMs) },
  });

  // Parallel sign-up style load: 8 hashes in the DO isolate vs offloaded
  const t1 = Date.now();
  await Promise.all(Array.from({ length: 8 }, (_, i) => hashPassword("p" + i)));
  out.parallel8InProcessMs = Date.now() - t1;
  const t2 = Date.now();
  await Promise.all(Array.from({ length: 8 }, (_, i) => (env as any).HASHER.hash("p" + i)));
  out.parallel8ViaHasherEntrypointMs = Date.now() - t2;
  console.log("[scrypt-bench]", JSON.stringify(out));
});
