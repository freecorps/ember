// Standard Webhooks signatures: the specification's test vector, verification (tolerance, rotation, header forms),
// and refusals.
import { createHmac } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import { generateWebhookSecret, signWebhook, verifyWebhook, webhookHeaders, WebhookVerificationError } from "../src/verify.ts";

// From the Standard Webhooks specification's reference libraries (standard-webhooks/standard-webhooks, test vectors).
const VECTOR = {
  secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
  id: "msg_p5jXN8AQM9LWM0D4loKWxJek",
  timestamp: 1614265330,
  body: '{"test": 2432232314}',
  signature: "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
};
const at = VECTOR.timestamp * 1000;
const fails = (p: Promise<unknown>, re: RegExp) => expect(p).rejects.toThrow(expect.objectContaining({ name: "WebhookVerificationError", message: expect.stringMatching(re) }));

describe("signatures", () => {
  test("the specification's vector", async () => {
    expect(await signWebhook(VECTOR.secret, VECTOR.id, VECTOR.timestamp, VECTOR.body)).toBe(VECTOR.signature);
    // And the same HMAC as Node's own implementation, for a fresh secret.
    const secret = generateWebhookSecret();
    expect(secret).toMatch(/^whsec_[A-Za-z0-9+/]{32}$/);
    const mac = createHmac("sha256", Buffer.from(secret.slice(6), "base64")).update("m.1.{}").digest("base64");
    expect(await signWebhook(secret, "m", 1, "{}")).toBe(`v1,${mac}`);
  });

  test("verifyWebhook accepts the vector (Headers or a plain object, any case) and returns the body", async () => {
    const headers = { "webhook-id": VECTOR.id, "webhook-timestamp": String(VECTOR.timestamp), "webhook-signature": VECTOR.signature };
    expect(await verifyWebhook(VECTOR.secret, headers, VECTOR.body, { now: at })).toEqual({ test: 2432232314 });
    expect(await verifyWebhook(VECTOR.secret, new Headers(headers), VECTOR.body, { now: at + 60_000 })).toEqual({ test: 2432232314 });
    expect(await verifyWebhook(VECTOR.secret, { "Webhook-Id": VECTOR.id, "WEBHOOK-TIMESTAMP": String(VECTOR.timestamp), "Webhook-Signature": VECTOR.signature }, VECTOR.body, { now: at })).toEqual({ test: 2432232314 });
  });

  test("refusals: tampered body, wrong secret, missing headers, stale or future timestamp, unknown version", async () => {
    const headers = { "webhook-id": VECTOR.id, "webhook-timestamp": String(VECTOR.timestamp), "webhook-signature": VECTOR.signature };
    await fails(verifyWebhook(VECTOR.secret, headers, '{"test": 2432232315}', { now: at }), /no matching signature/);
    await fails(verifyWebhook(generateWebhookSecret(), headers, VECTOR.body, { now: at }), /no matching signature/);
    await fails(verifyWebhook(VECTOR.secret, { ...headers, "webhook-id": "msg_other" }, VECTOR.body, { now: at }), /no matching signature/);
    await fails(verifyWebhook(VECTOR.secret, { "webhook-id": VECTOR.id, "webhook-timestamp": String(VECTOR.timestamp) }, VECTOR.body, { now: at }), /missing/);
    await fails(verifyWebhook(VECTOR.secret, headers, VECTOR.body, { now: at + 301_000 }), /too old/);
    await fails(verifyWebhook(VECTOR.secret, headers, VECTOR.body, { now: at - 301_000 }), /too new/);
    await fails(verifyWebhook(VECTOR.secret, { ...headers, "webhook-timestamp": "1e9" }, VECTOR.body, { now: at }), /invalid webhook-timestamp/);
    await fails(verifyWebhook(VECTOR.secret, { ...headers, "webhook-signature": VECTOR.signature.replace("v1,", "v2,") }, VECTOR.body, { now: at }), /no matching signature/);
    expect(await verifyWebhook(VECTOR.secret, headers, VECTOR.body, { now: at + 3_000_000, toleranceSeconds: 3600 })).toEqual({ test: 2432232314 });
    await expect(signWebhook("whsec_!!!", "m", 1, "{}")).rejects.toBeInstanceOf(WebhookVerificationError);
  });

  test("rotation: one header with both signatures; a receiver with either secret verifies", async () => {
    const next = generateWebhookSecret();
    const h = await webhookHeaders([next, VECTOR.secret], VECTOR.id, VECTOR.timestamp, VECTOR.body);
    expect(h["webhook-signature"].split(" ")).toEqual([await signWebhook(next, VECTOR.id, VECTOR.timestamp, VECTOR.body), VECTOR.signature]);
    expect(await verifyWebhook(next, h, VECTOR.body, { now: at })).toEqual({ test: 2432232314 });
    expect(await verifyWebhook(VECTOR.secret, h, VECTOR.body, { now: at })).toEqual({ test: 2432232314 });
    // A receiver mid-rotation on its side can pass both of its secrets.
    expect(await verifyWebhook([generateWebhookSecret(), next], h, VECTOR.body, { now: at })).toEqual({ test: 2432232314 });
  });

  test("verification options: a NaN or negative tolerance and a NaN clock are refused, not treated as fresh", async () => {
    const headers = { "webhook-id": VECTOR.id, "webhook-timestamp": String(VECTOR.timestamp), "webhook-signature": VECTOR.signature };
    // Years after the timestamp: only a NaN comparison would let it through.
    const late = at + 10 * 365 * 86_400_000;
    await fails(verifyWebhook(VECTOR.secret, headers, VECTOR.body, { now: late, toleranceSeconds: Number.NaN }), /toleranceSeconds/);
    await fails(verifyWebhook(VECTOR.secret, headers, VECTOR.body, { now: at, toleranceSeconds: -1 }), /toleranceSeconds/);
    await fails(verifyWebhook(VECTOR.secret, headers, VECTOR.body, { now: Number.NaN }), /invalid now/);
    // Omitted: the defaults (Date.now(), 300 s).
    expect(await verifyWebhook(VECTOR.secret, { ...headers, "webhook-timestamp": String(Math.floor(Date.now() / 1000)), "webhook-signature": await signWebhook(VECTOR.secret, VECTOR.id, Math.floor(Date.now() / 1000), VECTOR.body) }, VECTOR.body)).toEqual({ test: 2432232314 });
  });

  test("a correctly signed body that is not JSON is a WebhookVerificationError (without the body)", async () => {
    const body = "not json {secret}";
    const headers = { "webhook-id": VECTOR.id, "webhook-timestamp": String(VECTOR.timestamp), "webhook-signature": await signWebhook(VECTOR.secret, VECTOR.id, VECTOR.timestamp, body) };
    const err = await verifyWebhook(VECTOR.secret, headers, body, { now: at }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WebhookVerificationError);
    expect((err as Error).message).not.toContain("secret}");
  });

  test("a repeated webhook-signature header joined with \", \" (Node's req.headers, fetch's Headers.get) verifies", async () => {
    const other = await signWebhook(generateWebhookSecret(), VECTOR.id, VECTOR.timestamp, VECTOR.body);
    const base = { "webhook-id": VECTOR.id, "webhook-timestamp": String(VECTOR.timestamp) };
    // The valid signature first: its entry carries the trailing ", " separator.
    expect(await verifyWebhook(VECTOR.secret, { ...base, "webhook-signature": `${VECTOR.signature}, ${other}` }, VECTOR.body, { now: at })).toEqual({ test: 2432232314 });
    expect(await verifyWebhook(VECTOR.secret, { ...base, "webhook-signature": `${other}, ${VECTOR.signature}` }, VECTOR.body, { now: at })).toEqual({ test: 2432232314 });
    const h = new Headers(base);
    h.append("webhook-signature", VECTOR.signature);
    h.append("webhook-signature", other);
    expect(await verifyWebhook(VECTOR.secret, h, VECTOR.body, { now: at })).toEqual({ test: 2432232314 });
  });

  test("a repeated webhook-signature header as an array (Node's req.headersDistinct) is one space-separated list", async () => {
    const other = await signWebhook(generateWebhookSecret(), VECTOR.id, VECTOR.timestamp, VECTOR.body);
    const headers = { "webhook-id": VECTOR.id, "webhook-timestamp": String(VECTOR.timestamp), "webhook-signature": [other, VECTOR.signature] };
    expect(await verifyWebhook(VECTOR.secret, headers, VECTOR.body, { now: at })).toEqual({ test: 2432232314 });
    // Other versions' entries next to the v1 one are skipped, not compared.
    expect(await verifyWebhook(VECTOR.secret, { ...headers, "webhook-signature": `v1a,xyz ${VECTOR.signature}` }, VECTOR.body, { now: at })).toEqual({ test: 2432232314 });
  });

  test("a failed key import is not cached: the same secret is tried again", async () => {
    const real = crypto.subtle.importKey.bind(crypto.subtle);
    const secret = generateWebhookSecret();
    let calls = 0;
    const spy = vi.spyOn(crypto.subtle, "importKey").mockImplementation(((...args: Parameters<SubtleCrypto["importKey"]>) => (++calls === 1 ? Promise.reject(new Error("transient")) : real(...args))) as SubtleCrypto["importKey"]);
    try {
      await expect(signWebhook(secret, "m", 1, "{}")).rejects.toThrow(/transient/);
      expect(await signWebhook(secret, "m", 1, "{}")).toMatch(/^v1,/);
      expect(calls).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });
});
