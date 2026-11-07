import { afterEach, describe, expect, test } from "vitest";
import {
  APNS_PRODUCTION_URL,
  APNS_SANDBOX_URL,
  apnsErrorCode,
  apnsPayload,
  apnsProviderToken,
  clearApnsTokenCache,
  isApnsToken,
  sendApns,
  type ApnsOptions,
} from "../src/apns.ts";
import { decodeJwt, verifyJwt } from "../src/jwt.ts";
import { fakeApns, hexToken } from "./fakes.ts";
import { apnsKey, serviceAccount, toPem } from "./keys.ts";

const TOPIC = "dev.ember.mail";
const noSleep = { sleep: async () => {}, retryDelayMs: 1 };

async function setup(extra: Partial<ApnsOptions> & { expiredOnce?: boolean } = {}) {
  const k = await apnsKey();
  const { expiredOnce, ...rest } = extra;
  const fake = fakeApns({ publicKey: k.publicKey, teamId: k.teamId, keyId: k.keyId, topic: TOPIC, ...(expiredOnce ? { expiredOnce } : {}) });
  const opts: ApnsOptions = { keyId: k.keyId, teamId: k.teamId, key: k.pem, topic: TOPIC, fetch: fake.fetch, ...noSleep, ...rest };
  return { k, fake, opts };
}

afterEach(() => clearApnsTokenCache());

describe("APNs request format", () => {
  test("an alert: host per environment, path, headers, ES256 provider token and payload", async () => {
    const { k, fake, opts } = await setup({ now: () => 1_700_000_000_000 });
    const tickets = await sendApns(
      [
        { to: hexToken("ok", 1), title: "Ana", subtitle: "Re: orçamento", body: "Segue", data: { id: 7 }, sound: "default", badge: 3, threadId: "t-1", categoryId: "mail", collapseId: "msg-7" },
        { to: hexToken("sandbox", 2), environment: "sandbox", body: "dev build" },
      ],
      opts,
    );
    expect(tickets).toEqual([
      { token: hexToken("ok", 1), status: "ok", id: `apns-${hexToken("ok", 1).slice(0, 8)}` },
      { token: hexToken("sandbox", 2), status: "ok", id: `apns-${hexToken("sandbox", 2).slice(0, 8)}` },
    ]);
    const find = (t: string) => fake.requests.find((r) => r.path.endsWith(t));
    const [a, b] = [find(hexToken("ok", 1)), find(hexToken("sandbox", 2))];
    expect(a!.url).toBe(`${APNS_PRODUCTION_URL}/3/device/${hexToken("ok", 1)}`);
    expect(b!.url).toBe(`${APNS_SANDBOX_URL}/3/device/${hexToken("sandbox", 2)}`);
    expect(a!.headers).toMatchObject({
      "apns-topic": TOPIC,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-expiration": String(1_700_000_000 + 3600),
      "apns-collapse-id": "msg-7",
      "content-type": "application/json",
    });
    expect(a!.body).toEqual({
      aps: { alert: { title: "Ana", subtitle: "Re: orçamento", body: "Segue" }, sound: "default", badge: 3, "thread-id": "t-1", category: "mail" },
      body: { id: 7 },
    });
    const jwt = a!.headers.authorization!.slice("bearer ".length);
    expect(decodeJwt(jwt).header).toEqual({ alg: "ES256", typ: "JWT", kid: k.keyId });
    expect(decodeJwt(jwt).claims).toEqual({ iss: k.teamId, iat: 1_700_000_000 });
    expect(await verifyJwt(jwt, "ES256", k.publicKey)).toBe(true);
  });

  test("urgency maps to priority, TTL and interruption level; ttl 0 means once; background pushes go at 5", async () => {
    const { fake, opts } = await setup({ now: () => 1_700_000_000_000 });
    await sendApns(
      [
        { to: hexToken("ok", 1), body: "low", urgency: "low" },
        { to: hexToken("ok", 2), body: "high", urgency: "high" },
        { to: hexToken("ok", 3), body: "expo-style normal priority", priority: "normal" },
        { to: hexToken("ok", 4), body: "once", ttl: 0 },
        { to: hexToken("ok", 5), contentAvailable: true, data: { sync: 1 } },
        { to: hexToken("ok", 6), body: "explicit", urgency: "high", interruptionLevel: "passive", ttl: 60 },
      ],
      opts,
    );
    fake.requests.sort((a, b) => a.path.localeCompare(b.path));
    const h = fake.requests.map((r) => [r.headers["apns-priority"], Number(r.headers["apns-expiration"]) - 1_700_000_000, r.headers["apns-push-type"], r.body.aps["interruption-level"]]);
    expect(h).toEqual([
      ["5", 4 * 3600, "alert", undefined],
      ["10", 15 * 60, "alert", "time-sensitive"],
      ["5", 4 * 3600, "alert", undefined],
      ["10", -1_700_000_000, "alert", undefined],
      ["5", 3600, "background", undefined],
      ["10", 60, "alert", "passive"],
    ]);
    expect(fake.requests[3]!.headers["apns-expiration"]).toBe("0");
    expect(fake.requests[4]!.body).toEqual({ aps: { "content-available": 1 }, body: { sync: 1 } });
  });

  test("a sealed push carries only the fallback, mutable-content and the envelope", () => {
    const sealed = { v: 1 as const, k: "AAAAAAAA", enc: "e", ct: "c" };
    expect(apnsPayload({ to: "x", title: "secret", body: "secret", data: { s: 1 }, sealed, badge: 1 }, { title: "New mail", body: "Open Mail" })).toEqual({
      aps: { alert: { title: "New mail", body: "Open Mail" }, "mutable-content": 1, badge: 1 },
      ember: sealed,
    });
    expect(apnsPayload({ to: "x", sealed }, { titleLocKey: "PUSH_TITLE", locKey: "PUSH_BODY", title: "ignored" }).aps).toEqual({
      alert: { "title-loc-key": "PUSH_TITLE", "loc-key": "PUSH_BODY" },
      "mutable-content": 1,
    });
  });

  test("VoIP pushes use the .voip topic and push type voip", async () => {
    const { fake, opts } = await setup();
    const [t] = await sendApns([{ to: hexToken("ok", 9), voip: true, data: { callId: "c1" } }], opts);
    expect(t!.status).toBe("ok");
    expect(fake.requests[0]!.headers).toMatchObject({ "apns-topic": `${TOPIC}.voip`, "apns-push-type": "voip", "apns-priority": "10" });
    expect(fake.requests[0]!.body).toEqual({ aps: {}, body: { callId: "c1" } });
  });
});

describe("APNs answers", () => {
  test("error reasons map to Ember codes; Unregistered and BadDeviceToken mean prune, topic errors do not", async () => {
    const { opts } = await setup();
    const tickets = await sendApns(
      [
        { to: hexToken("dead"), body: "x" },
        { to: hexToken("bad"), body: "x", environment: "production" },
        { to: hexToken("topic"), body: "x" },
        { to: "not-hex", body: "x" },
        { to: hexToken("ok"), body: "x".repeat(5000) },
        { to: hexToken("ok"), body: "x", collapseId: "c".repeat(65) },
      ],
      opts,
    );
    expect(tickets.map((t) => (t.status === "error" ? t.error : "ok"))).toEqual([
      "DeviceNotRegistered",
      "DeviceNotRegistered",
      "MismatchSenderId",
      "InvalidToken",
      "MessageTooBig",
      "RequestFailed",
    ]);
    expect(tickets[0]).toMatchObject({ message: "APNs 410 Unregistered" });
    expect(apnsErrorCode(403, "InvalidProviderToken")).toBe("InvalidCredentials");
    expect(apnsErrorCode(429, "TooManyProviderTokenUpdates")).toBe("MessageRateExceeded");
    expect(apnsErrorCode(413, "PayloadTooLarge")).toBe("MessageTooBig");
    expect(apnsErrorCode(500, "InternalServerError")).toBe("RequestFailed");
    expect(apnsErrorCode(410, undefined)).toBe("DeviceNotRegistered");
  });

  test("error tickets carry APNs' own reason and HTTP status, for rules Ember's codes fold together", async () => {
    const { opts } = await setup();
    const [dead, topic] = await sendApns([{ to: hexToken("dead"), body: "x" }, { to: hexToken("topic"), body: "x" }], opts);
    expect(dead).toMatchObject({ status: "error", error: "DeviceNotRegistered", reason: "Unregistered", httpStatus: 410 });
    expect(topic).toMatchObject({ status: "error", error: "MismatchSenderId", reason: "DeviceTokenNotForTopic", httpStatus: 400 });
    // A ticket Ember made without asking APNs has neither.
    const [local] = await sendApns([{ to: "not-hex", body: "x" }], opts);
    expect(local).not.toHaveProperty("reason");
    expect(local).not.toHaveProperty("httpStatus");
  });

  test("timeoutMs bounds the whole send, retries included; signal aborts it", async () => {
    const { opts } = await setup();
    const hang = ((_u: unknown, init?: RequestInit) =>
      new Promise((_r, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as unknown as typeof fetch;
    const started = Date.now();
    const [t] = await sendApns([{ to: hexToken("ok"), body: "x" }], { ...opts, fetch: hang, timeoutMs: 50 });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(t).toMatchObject({ status: "error", error: "RequestFailed", message: expect.stringContaining("APNs unreachable") });
    // A deadline also stops the wait between retries (a 503 asks for a retry after 30 s).
    const busy = (async () => new Response(null, { status: 503, headers: { "retry-after": "30" } })) as unknown as typeof fetch;
    const t0 = Date.now();
    const { sleep: _instant, ...realSleep } = opts;
    const [u] = await sendApns([{ to: hexToken("ok"), body: "x" }], { ...realSleep, fetch: busy, timeoutMs: 50 });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(u).toMatchObject({ status: "error", error: "RequestFailed" });
    const aborted = new AbortController();
    aborted.abort(new Error("caller gave up"));
    const [v] = await sendApns([{ to: hexToken("ok"), body: "x" }], { ...opts, signal: aborted.signal });
    expect(v).toMatchObject({ status: "error", error: "RequestFailed", message: expect.stringContaining("caller gave up") });
  });

  test("a device without a recorded environment is tried on the other host after BadDeviceToken", async () => {
    const { fake, opts } = await setup();
    const [t] = await sendApns([{ to: hexToken("sandbox", 3), body: "x" }], opts);
    expect(t).toMatchObject({ status: "ok", environment: "sandbox" });
    expect(fake.requests.map((r) => r.host)).toEqual(["api.push.apple.com", "api.sandbox.push.apple.com"]);
    // A recorded environment is trusted: no second try.
    fake.requests.length = 0;
    const [u] = await sendApns([{ to: hexToken("sandbox", 3), body: "x", environment: "production" }], opts);
    expect(u).toMatchObject({ status: "error", error: "DeviceNotRegistered" });
    expect(fake.requests).toHaveLength(1);
  });

  test("429 is retried after Retry-After; a wrong key is InvalidCredentials; network errors are RequestFailed", async () => {
    const slept: number[] = [];
    const { fake, opts } = await setup({ sleep: async (ms) => void slept.push(ms) });
    const [t] = await sendApns([{ to: hexToken("busy"), body: "x" }], opts);
    expect(t!.status).toBe("ok");
    expect(slept).toEqual([1000]);
    expect(fake.requests).toHaveLength(2);

    const other = await apnsKey();
    const [w] = await sendApns([{ to: hexToken("ok"), body: "x" }], { ...opts, key: other.pem });
    expect(w).toMatchObject({ status: "error", error: "InvalidCredentials", message: "APNs 403 InvalidProviderToken" });

    const down = (async () => {
      throw new TypeError("Network connection lost.");
    }) as unknown as typeof fetch;
    const [n] = await sendApns([{ to: hexToken("ok"), body: "x" }], { ...opts, fetch: down });
    expect(n).toMatchObject({ status: "error", error: "RequestFailed", message: "APNs unreachable: Network connection lost." });
  });

  test("a broken .p8 (not PEM, not PKCS#8, wrong curve, RSA) is InvalidCredentials, not RequestFailed", async () => {
    const { fake, opts } = await setup();
    const p384 = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-384" }, true, ["sign"])) as CryptoKeyPair;
    const rsa = await serviceAccount();
    const keys = {
      notPem: "not a key",
      sec1: "-----BEGIN EC PRIVATE KEY-----\nAAAA\n-----END EC PRIVATE KEY-----",
      p384: toPem(await crypto.subtle.exportKey("pkcs8", p384.privateKey)),
      rsa: rsa.json.private_key,
    };
    for (const [name, key] of Object.entries(keys)) {
      const [t] = await sendApns([{ to: hexToken("ok"), body: "x" }], { ...opts, key });
      expect(t, name).toMatchObject({ status: "error", error: "InvalidCredentials" });
      expect((t as { message: string }).message, name).not.toMatch(/unreachable/);
    }
    expect(fake.requests).toHaveLength(0);
  });

  test("the provider token is reused for 40 minutes, re-signed after, and after ExpiredProviderToken", async () => {
    let now = 1_700_000_000_000;
    const { fake, opts } = await setup({ now: () => now, expiredOnce: true });
    await sendApns([{ to: hexToken("ok", 1), body: "x" }], opts); // expired once → re-signed and retried
    expect(fake.requests).toHaveLength(2);
    const jwtOf = (i: number) => fake.requests[i]!.headers.authorization;
    const first = jwtOf(1);
    now += 39 * 60_000;
    await sendApns([{ to: hexToken("ok", 2), body: "x" }], opts);
    expect(jwtOf(2)).toBe(first);
    now += 2 * 60_000;
    await sendApns([{ to: hexToken("ok", 3), body: "x" }], opts);
    expect(jwtOf(3)).not.toBe(first);
    expect(await apnsProviderToken(opts, now)).toBe(jwtOf(3)!.slice(7));
  });

  test("concurrent callers share one provider token; a stale-token refresh signs once", async () => {
    clearApnsTokenCache();
    const { opts } = await setup({});
    const t0 = 1_700_000_000_000;
    const cold = await Promise.all([0, 1, 2, 3, 4].map((i) => apnsProviderToken(opts, t0 + i * 1000)));
    expect(new Set(cold).size).toBe(1);
    const stale = cold[0]!;
    const refreshed = await Promise.all([0, 1, 2].map((i) => apnsProviderToken(opts, t0 + 60_000 + i * 1000, stale)));
    expect(new Set(refreshed).size).toBe(1);
    expect(refreshed[0]).not.toBe(stale);
    // A late caller still holding the old token does not re-sign again.
    expect(await apnsProviderToken(opts, t0 + 120_000, stale)).toBe(refreshed[0]);
  });

  test("token format", () => {
    expect(isApnsToken("a".repeat(64))).toBe(true);
    expect(isApnsToken("A1".repeat(80))).toBe(true); // Simulator tokens are 80 bytes
    expect(isApnsToken("a".repeat(63))).toBe(false);
    expect(isApnsToken("ExponentPushToken[x]")).toBe(false);
    expect(isApnsToken(1)).toBe(false);
  });
});
