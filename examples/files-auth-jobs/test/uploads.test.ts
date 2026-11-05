// The whole pipeline on workerd: Better Auth sign-up (Auth Durable Object) → a JWT → `ctx.auth` in functions →
// an upload through the files endpoints (R2 binding, proxy mode as in `ember dev`) → a scheduled job that reads the
// file and writes its metadata → the live query that shows the result. Plus the cron that rescues a stuck upload.
import { env, evictDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { EmberError, type EmberClient } from "@freecorps/ember-client";
import { selfFetch, testClient, watch } from "@freecorps/ember-example-testing";
import { describe, expect, it } from "vitest";
import { api } from "../ember/_generated/api";
import { STUCK_AFTER_MS } from "../ember/files";
import { createAuth } from "../web/src/auth";
import { clock } from "./worker";

const URL_BASE = "http://localhost:8787"; // EMBER_AUTH_URL: the issuer the JWTs are pinned to
const SHARD = "global:main";
const shard = () => env.SHARD.get(env.SHARD.idFromName(SHARD));

let n = 0;
/** A signed-in user: the same auth code the web app runs (web/src/auth.ts) and an `EmberClient` that sends its JWTs. */
async function signUp(name: string) {
  const memory = new Map<string, string>();
  const storage = { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => void memory.set(k, v), removeItem: (k: string) => void memory.delete(k) };
  const auth = createAuth({ baseUrl: URL_BASE, storage, fetch: selfFetch, origin: URL_BASE });
  const email = `${name}-${Date.now()}-${n++}@example.test`.toLowerCase(); // Better Auth normalizes emails
  await auth.signUp({ email, password: "correct horse battery staple", name });
  const client = testClient({ auth: () => auth.fetchToken(), defaultShard: SHARD });
  return { auth, client, user: { email } };
}

const upload = (client: EmberClient, data: string | Uint8Array<ArrayBuffer>, name: string, type: string) =>
  client.files.upload(new Blob([data], { type }), { mutation: api.files.generateUploadUrl, fetch: selfFetch }).then((f) => client.mutation(api.files.save, { storageId: f.storageId as never, name }));

/** The job runs from the shard's alarm; nudge it so the test does not wait for the timer. */
async function until<T>(get: () => Promise<T>, ok: (v: T) => boolean) {
  for (let i = 0; i < 100; i++) {
    const v = await get();
    if (ok(v)) return v;
    await runDurableObjectAlarm(shard());
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timed out");
}

describe("sign-in and ctx.auth", () => {
  it("signed out, functions see no identity and refuse to upload", async () => {
    const client = testClient({ defaultShard: SHARD });
    expect(await client.query(api.users.me, {})).toBeNull();
    expect(await client.query(api.files.list, {})).toEqual([]);
    await expect(client.mutation(api.files.generateUploadUrl, { contentType: "text/plain", size: 1 })).rejects.toThrow(/Sign in first/);
    client.close();
  });

  it("after sign-up the JWT identifies the user; signing out ends it", async () => {
    const { auth, client, user } = await signUp("Ana");
    expect(await client.query(api.users.me, {})).toMatchObject({ name: "Ana", email: user.email });
    await auth.signOut();
    client.setAuth(() => auth.fetchToken()); // what web/src/ember.ts does on sign-out: re-authenticate the socket
    await expect.poll(() => client.query(api.users.me, {})).toBeNull();
    client.close();
  });
});

describe("upload → scheduled job → reactive result", () => {
  it("processes text and images, fails corrupt files, and keeps each user's uploads private", async () => {
    const ana = await signUp("Ana");
    const bob = await signUp("Bob");
    const list = watch(ana.client, api.files.list, {});
    await expect.poll(() => list.last()?.status).toBe("success");

    const notes = await upload(ana.client, "first line\nsecond line has more words\n", "notes.txt", "text/plain");
    // The document exists at once, still "processing"; the job finishes it and the live query pushes the change.
    expect(list.seen.some((s) => s.value?.[0]?.status === "processing")).toBe(true);
    const done = await until(() => ana.client.query(api.files.list, {}), (rows) => rows[0]?.status === "ready");
    expect(done[0]).toMatchObject({
      _id: notes,
      name: "notes.txt",
      status: "ready",
      meta: { kind: "text", lines: 2, words: 7, preview: "first line\nsecond line has more words" },
    });
    expect(done[0]!.meta!.sha256).toMatch(/^[0-9a-f]{64}$/);
    await expect.poll(() => list.last()?.value?.[0]?.status).toBe("ready");

    // The download URL works (a signed URL on the Worker here; a presigned R2 URL on a deployment with R2 credentials).
    const body = await selfFetch(ana.client.files.url(done[0]!.url!));
    expect(await body.text()).toBe("first line\nsecond line has more words\n");

    const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
    await upload(ana.client, png, "dot.png", "image/png");
    await upload(ana.client, "not a png at all, definitely more than 24 bytes", "broken.png", "image/png");
    const all = await until(() => ana.client.query(api.files.list, {}), (rows) => rows.length === 3 && rows.every((r) => r.status !== "processing"));
    const byName = Object.fromEntries(all.map((r) => [r.name, r]));
    expect(byName["dot.png"]).toMatchObject({ status: "ready", meta: { kind: "image", width: 1, height: 1 } });
    expect(byName["broken.png"]).toMatchObject({ status: "failed", error: "Not a valid PNG file" });
    expect(byName["broken.png"]!.meta).toBeUndefined();

    // Privacy: Bob sees nothing of Ana's, and cannot delete her upload.
    expect(await bob.client.query(api.files.list, {})).toEqual([]);
    await expect(bob.client.mutation(api.files.remove, { id: notes })).rejects.toThrow(/No such upload/);
    await ana.client.mutation(api.files.remove, { id: notes });
    await expect.poll(() => list.last()?.value?.length).toBe(2);

    list.stop();
    ana.client.close();
    bob.client.close();
  });

  it("refuses big files, files that were never uploaded, and tickets for strangers", async () => {
    const ana = await signUp("Ana");
    await expect(ana.client.mutation(api.files.generateUploadUrl, { contentType: "text/plain", size: 6 * 1024 * 1024 })).rejects.toThrow(/limited to 5 MiB/);
    const ticket = await ana.client.mutation(api.files.generateUploadUrl, { contentType: "text/plain", size: 3 });
    await expect(ana.client.mutation(api.files.save, { storageId: ticket.storageId as never, name: "never.txt" })).rejects.toThrow(/was not uploaded/);
    const stranger = testClient({ defaultShard: SHARD });
    await expect(stranger.mutation(api.files.save, { storageId: ticket.storageId as never, name: "x" })).rejects.toBeInstanceOf(EmberError);
    stranger.close();
    ana.client.close();
  });
});

describe("the cron", () => {
  it("schedules the job again for an upload stuck in `processing`", async () => {
    const ana = await signUp("Ana");
    // Upload the bytes, but record the upload as the app would after a lost job: `processing`, created long ago,
    // with no job scheduled (a test-only mutation: `save` always schedules one).
    const { storageId } = await ana.client.files.upload(new Blob(["rescued by the cron"], { type: "text/plain" }), { mutation: api.files.generateUploadUrl, fetch: selfFetch });
    // (`_creationTime` never goes backwards inside one engine, so restart the shard's before moving the clock back.)
    await evictDurableObject(shard());
    clock.skew = -(STUCK_AFTER_MS + 60_000);
    const stuck = await ana.client.mutation("testing:insertStuck" as never, { storageId, name: "stuck.txt" } as never);
    clock.skew = 0;
    expect(await shard().inspect()).toMatchObject({ jobs: [] });
    expect((await ana.client.query(api.files.list, {}))[0]).toMatchObject({ _id: stuck, status: "processing" });

    // A tick of the System Durable Object at a "*/5" minute dispatches `retry-stuck-uploads` to the shard.
    const system = env.SYSTEM.get(env.SYSTEM.idFromName("system"));
    const tickAt = Math.floor(Date.now() / 300_000) * 300_000;
    const tick = await system.tick(tickAt);
    expect(tick.dispatched.map((d: { name: string }) => d.name)).toContain("retry-stuck-uploads");

    const rescued = await until(() => ana.client.query(api.files.list, {}), (rows) => rows[0]?.status === "ready");
    expect(rescued[0]).toMatchObject({ _id: stuck, meta: { kind: "text", lines: 1, words: 4 } });
    ana.client.close();
  });
});
