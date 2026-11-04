/**
 * Password hashing offload: the Worker passes an RpcTarget (EdgeHasher) to the
 * DO; Better Auth's password.hash/verify call back into the Worker isolate.
 * Functional check + local timing (NOTE: locally the Worker and DO share one
 * workerd process, so this cannot show the production parallelism benefit).
 */
import { env } from "cloudflare:test";
import { it, expect } from "vitest";
import { authShard, EdgeHasher } from "../src/index";

const ORIGIN = "http://localhost:8787";
const signUp = (email: string) =>
  new Request(`${ORIGIN}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ email, password: "correct horse battery staple", name: "x" }),
  });
const signIn = (email: string, password = "correct horse battery staple") =>
  new Request(`${ORIGIN}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

it("sign-up/sign-in with scrypt offloaded to the calling Worker via RpcTarget", async () => {
  const shard = authShard(env as any);
  const before = await shard.stats();
  const email = `off-${crypto.randomUUID()}@example.com`;
  const r = await shard.handle(signUp(email), new EdgeHasher());
  expect(r.status).toBe(200);
  expect((await shard.handle(signIn(email), new EdgeHasher())).status).toBe(200);
  expect((await shard.handle(signIn(email, "wrong-password!"), new EdgeHasher())).status).toBe(401);
  // a hash produced remotely verifies locally (same format)
  expect((await shard.fetch(signIn(email))).status).toBe(200);
  const after = await shard.stats();
  expect(after.hashCalls.remote - before.hashCalls.remote).toBe(3);
  expect(after.hashCalls.local - before.hashCalls.local).toBe(1);

  const N = 8;
  const t1 = Date.now();
  await Promise.all(Array.from({ length: N }, (_, i) => shard.fetch(signUp(`l${i}-${crypto.randomUUID()}@e.com`))));
  const localMs = Date.now() - t1;
  const t2 = Date.now();
  await Promise.all(
    Array.from({ length: N }, (_, i) => shard.handle(signUp(`r${i}-${crypto.randomUUID()}@e.com`), new EdgeHasher())),
  );
  const remoteMs = Date.now() - t2;
  console.log("[hash-offload]", JSON.stringify({ N, concurrentSignUpsHashInDO_ms: localMs, concurrentSignUpsHashViaRpcTarget_ms: remoteMs }));
});
