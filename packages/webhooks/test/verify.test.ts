// Standard Webhooks signatures: the specification's test vector, verification (tolerance, rotation, header forms),
// and refusals.
import { createHmac } from "node:crypto";
import { describe, expect, test } from "vitest";
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
    const fails = (p: Promise<unknown>, re: RegExp) => expect(p).rejects.toThrow(expect.objectContaining({ name: "WebhookVerificationError", message: expect.stringMatching(re) }));
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
});
