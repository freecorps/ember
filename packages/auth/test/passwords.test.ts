/**
 * Password endpoints of plugins, hashed and verified in the Worker (`passwords.config.ts`, its own Auth DO with
 * `strictHashing`: any scrypt call inside the DO throws, so every passing flow proves the DO never hashed): sign-in by
 * username and by phone number, a third-party endpoint declared in `ember.passwordRules` (eager and lazy), and
 * `ember.hiddenUserFields` kept out of the profile sync.
 */
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Client, rnd } from "./helpers.ts";
import { smsbox } from "./passwords.config.ts";
import { pwAuth, pwStatic, pwUserEvents } from "./worker.ts";

const password = "correct horse battery staple";
const stats = () => pwAuth.stub().stats();
const hashes = () => pwAuth.workerStats().workerHashes;
const via = (which: "pw" | "pw-lazy" = "pw") => ({ "x-auth": which });
const req = (c: Client, path: string, body: unknown, which: "pw" | "pw-lazy" = "pw") => c.req(`/api/auth${path}`, { body, headers: via(which) });
const sql = <T,>(fn: (s: SqlStorage) => T) => runInDurableObject(pwAuth.stub() as unknown as DurableObjectStub, (_i, state) => fn(state.storage.sql));

describe("username() plugin", () => {
  const name = `Alice_${rnd()}`;
  const email = `${name.toLowerCase()}@pw.test`;

  it("sign-up with a username hashes in the Worker", async () => {
    const before = await stats();
    const h0 = hashes();
    const r = await req(new Client(), "/sign-up/email", { email, password, name: "Alice", username: name });
    expect(r.status).toBe(200);
    expect(r.json.user.username).toBe(name.toLowerCase());
    expect(hashes() - h0).toBe(1);
    const after = await stats();
    expect(after.plannedHashes - before.plannedHashes).toBe(1);
    expect(after.localHashes).toBe(0);
  });

  it("sign-in by username (normalized as the plugin does): the Worker finds the hash by username and verifies", async () => {
    const before = await stats();
    const c = new Client();
    const r = await req(c, "/sign-in/username", { username: name.toUpperCase(), password });
    expect(r.status).toBe(200);
    expect(r.json.user.email).toBe(email);
    expect(r.json.token).toEqual(expect.any(String));
    expect((await stats()).plannedVerifies - before.plannedVerifies).toBe(1);
  });

  it("wrong password and unknown username: same 401, and the Worker hashes for the unknown one too", async () => {
    const before = await stats();
    const wrong = await req(new Client(), "/sign-in/username", { username: name, password: "wrong-password-123" });
    const h0 = hashes();
    const unknown = await req(new Client(), "/sign-in/username", { username: `nobody_${rnd()}`, password });
    expect(hashes() - h0).toBe(1);
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(unknown.json).toEqual(wrong.json);
    expect(wrong.json.code).toBe("INVALID_USERNAME_OR_PASSWORD");
    const after = await stats();
    expect(after.plannedVerifies - before.plannedVerifies).toBe(1); // the wrong password
    expect(after.plannedHashes - before.plannedHashes).toBe(1); // the plugin's dummy hash for the unknown user
    expect(after.localHashes).toBe(0);
  });
});

describe("phoneNumber() plugin", () => {
  const phone = `+1555${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;
  const email = `phone-${rnd()}@pw.test`;

  it("sign-in with phone number and password, verified in the Worker", async () => {
    // The plugin only sets a number it verified: sign up, then verify it signed in.
    const owner = new Client();
    expect((await req(owner, "/sign-up/email", { email, password, name: "Phone" })).status).toBe(200);
    expect((await req(owner, "/phone-number/send-otp", { phoneNumber: phone })).status).toBe(200);
    const code = smsbox.findLast((m) => m.phoneNumber === phone)!.code;
    expect((await req(owner, "/phone-number/verify", { phoneNumber: phone, code, updatePhoneNumber: true })).status).toBe(200);
    const before = await stats();
    const r = await req(new Client(), "/sign-in/phone-number", { phoneNumber: phone, password });
    expect(r.status).toBe(200);
    expect(r.json.user.email).toBe(email);
    const after = await stats();
    expect(after.plannedVerifies - before.plannedVerifies).toBe(1);
    expect(after.localHashes).toBe(0);
  });

  it("wrong password and unknown number: same 401, and the Worker hashes for the unknown one too", async () => {
    const wrong = await req(new Client(), "/sign-in/phone-number", { phoneNumber: phone, password: "wrong-password-123" });
    const h0 = hashes();
    const unknown = await req(new Client(), "/sign-in/phone-number", { phoneNumber: "+15550000000", password });
    expect(hashes() - h0).toBe(1);
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(unknown.json).toEqual(wrong.json);
    expect(wrong.json.code).toBe("INVALID_PHONE_NUMBER_OR_PASSWORD");
    expect((await stats()).localHashes).toBe(0);
  });
});

describe("ember.passwordRules: a third-party plugin's endpoint", () => {
  const email = `vault-${rnd()}@pw.test`;

  it("is in the static settings the CLI embeds", () => {
    expect(pwStatic?.worker?.passwordRules).toEqual({ "/vault/unlock": { verify: { field: "secret", by: "email" } } });
  });

  it("verifies in the Worker (emberAuth): right, wrong and unknown", async () => {
    expect((await req(new Client(), "/sign-up/email", { email, password, name: "Vault" })).status).toBe(200);
    const before = await stats();
    expect((await req(new Client(), "/vault/unlock", { email, secret: password })).json).toEqual({ unlocked: true });
    expect((await req(new Client(), "/vault/unlock", { email, secret: "wrong-password-123" })).status).toBe(401);
    const h0 = hashes();
    expect((await req(new Client(), "/vault/unlock", { email: `nobody-${rnd()}@pw.test`, secret: password })).status).toBe(401);
    expect(hashes() - h0).toBe(1);
    const after = await stats();
    expect(after.plannedVerifies - before.plannedVerifies).toBe(2);
    expect(after.plannedHashes - before.plannedHashes).toBe(1);
    expect(after.localHashes).toBe(0);
  });

  it("emberAuthLazy routes it from the static settings too", async () => {
    const before = await stats();
    expect((await req(new Client(), "/vault/unlock", { email, secret: password }, "pw-lazy")).json).toEqual({ unlocked: true });
    expect((await req(new Client(), "/sign-in/username", { username: `nobody_${rnd()}`, password }, "pw-lazy")).status).toBe(401);
    const after = await stats();
    expect(after.plannedVerifies - before.plannedVerifies).toBe(1);
    expect(after.plannedHashes - before.plannedHashes).toBe(1);
    expect(after.localHashes).toBe(0);
  });
});

describe("ember.hiddenUserFields", () => {
  it("a plugin's secret on the user row never reaches the profile sync", async () => {
    const email = `hidden-${rnd()}@pw.test`;
    const c = new Client();
    expect((await req(c, "/sign-up/email", { email, password, name: "Hidden" })).status).toBe(200);
    expect((await req(c, "/vault/store", { value: "s3cret" })).json).toEqual({ stored: true });
    const row = await sql((s) => s.exec(`SELECT id, vaultSecret FROM "user" WHERE email = ?`, email).toArray()[0]);
    expect(row?.vaultSecret).toBe("s3cret");
    const events = pwUserEvents.filter((e) => e.user.email === email);
    expect(events.map((e) => e.event)).toEqual(["create", "update"]);
    for (const e of events) expect(e.user).not.toHaveProperty("vaultSecret");
    expect(events[1]!.user).toMatchObject({ email, name: "Hidden" });
    // Outbox recovery reads the user again: hidden there too.
    const synced = await pwAuth.stub().userForSync(String(row!.id));
    expect(synced).toMatchObject({ email });
    expect(synced).not.toHaveProperty("vaultSecret");
    // And the delete journal (the old row, for a delete whose hook never ran) does not copy it.
    const trigger = await sql((s) => s.exec(`SELECT sql FROM sqlite_master WHERE name = '_ember_user_journal_delete'`).toArray()[0]?.sql);
    expect(String(trigger)).toContain("'email'");
    expect(String(trigger)).not.toContain("vaultSecret");
  });
});
