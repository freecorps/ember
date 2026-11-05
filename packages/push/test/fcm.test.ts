import { afterEach, describe, expect, test } from "vitest";
import { clearFcmTokenCache, fcmAccessToken, fcmErrorCode, fcmMessage, isFcmToken, parseServiceAccount, sendFcm, type FcmOptions } from "../src/fcm.ts";
import { decodeJwt } from "../src/jwt.ts";
import { fakeFcm } from "./fakes.ts";
import { serviceAccount } from "./keys.ts";

const noSleep = { sleep: async () => {}, retryDelayMs: 1 };
const fcmToken = (tag: string) => `${tag}:APA91b${"x".repeat(140)}`;

async function setup(extra: { revokeOnce?: boolean; tokenTtl?: number } = {}, opts: Partial<FcmOptions> = {}) {
  const sa = await serviceAccount("mail-prod");
  const fake = fakeFcm({ publicKey: sa.publicKey, clientEmail: sa.json.client_email, projectId: "mail-prod", ...extra });
  const o: FcmOptions = { serviceAccount: sa.text, fetch: fake.fetch, ...noSleep, ...opts };
  return { sa, fake, o };
}

afterEach(() => clearFcmTokenCache());

describe("FCM HTTP v1", () => {
  test("OAuth: an RS256 assertion for the messaging scope, exchanged once and reused", async () => {
    const { sa, fake, o } = await setup();
    const tickets = await sendFcm(
      [
        { to: fcmToken("a"), title: "Ana", body: "Segue", data: { id: 7 } },
        { to: fcmToken("b"), title: "Bia", body: "Oi" },
      ],
      o,
    );
    expect(tickets.map((t) => t.status)).toEqual(["ok", "ok"]);
    expect(tickets[0]).toMatchObject({ id: expect.stringMatching(/^projects\/mail-prod\/messages\//) });
    expect(fake.tokenCalls()).toBe(1);
    const tokenReq = fake.requests.find((r) => r.host === "oauth2.googleapis.com")!;
    const { header, claims } = decodeJwt(tokenReq.body.assertion);
    expect(header).toEqual({ alg: "RS256", typ: "JWT", kid: "kid-1" });
    expect(claims).toMatchObject({ iss: sa.json.client_email, aud: "https://oauth2.googleapis.com/token", scope: "https://www.googleapis.com/auth/firebase.messaging" });
    const send = fake.requests.find((r) => r.path.endsWith("messages:send"))!;
    expect(send.url).toBe("https://fcm.googleapis.com/v1/projects/mail-prod/messages:send");
    expect(send.headers.authorization).toBe("Bearer ya29.fake-1");
  });

  test("message format: notification + data.body in clear; data-only when sealed; priority and TTL from urgency", () => {
    expect(fcmMessage({ to: "t", title: "Ana", body: "Segue", data: { id: 7 }, channelId: "mail", sound: "default", collapseId: "m7", badge: 2 })).toEqual({
      token: "t",
      notification: { title: "Ana", body: "Segue" },
      data: { body: '{"id":7}' },
      android: { priority: "HIGH", ttl: "3600s", collapse_key: "m7", notification: { channel_id: "mail", sound: "default", tag: "m7", notification_count: 2 } },
    });
    const sealed = { v: 1 as const, k: "AAAAAAAA", enc: "e", ct: "c" };
    expect(fcmMessage({ to: "t", title: "secret", body: "secret", data: { s: 1 }, sealed, urgency: "high", channelId: "mail", collapseId: "m7" }, { title: "New mail", body: "Open Mail" })).toEqual({
      token: "t",
      data: { ember: JSON.stringify(sealed), urgency: "high", fallbackTitle: "New mail", fallbackBody: "Open Mail", channelId: "mail", tag: "m7" },
      android: { priority: "HIGH", ttl: "900s", collapse_key: "m7" },
    });
    expect(fcmMessage({ to: "t", contentAvailable: true, data: { sync: 1 }, urgency: "low" })).toEqual({ token: "t", data: { body: '{"sync":1}' }, android: { priority: "NORMAL", ttl: "14400s" } });
    expect(fcmMessage({ to: "t", body: "x", ttl: 60 * 24 * 3600 }).android).toMatchObject({ ttl: `${28 * 24 * 3600}s` });
  });

  test("errors: UNREGISTERED prunes, SENDER_ID_MISMATCH does not; 503 retried; 401 refetches the access token once", async () => {
    const { fake, o } = await setup({ revokeOnce: true });
    const tickets = await sendFcm(
      [
        { to: fcmToken("ok"), body: "x" },
        { to: fcmToken("dead"), body: "x" },
        { to: fcmToken("sender"), body: "x" },
        { to: fcmToken("busy"), body: "x" },
        { to: "ExponentPushToken[x]", body: "x" },
      ],
      { ...o, concurrency: 1 },
    );
    expect(tickets.map((t) => (t.status === "error" ? t.error : "ok"))).toEqual(["ok", "DeviceNotRegistered", "MismatchSenderId", "ok", "InvalidToken"]);
    expect(tickets[1]).toMatchObject({ message: expect.stringContaining("FCM 404 UNREGISTERED") });
    expect(fake.tokenCalls()).toBe(2); // the first send was answered 401, a new token was fetched
    expect(fcmErrorCode(400, "INVALID_ARGUMENT")).toBe("InvalidArgument");
    expect(fcmErrorCode(429, "QUOTA_EXCEEDED")).toBe("MessageRateExceeded");
    expect(fcmErrorCode(401, undefined)).toBe("InvalidCredentials");
    expect(fcmErrorCode(500, "INTERNAL")).toBe("RequestFailed");
  });

  test("the access token is refetched 5 minutes before it expires", async () => {
    let now = 1_700_000_000_000;
    const real = Date.now;
    Date.now = () => now; // the fake checks iat against the clock
    try {
      const { fake, o } = await setup({ tokenTtl: 3600 }, { now: () => now });
      await fcmAccessToken(o);
      now += 54 * 60_000;
      await fcmAccessToken(o);
      expect(fake.tokenCalls()).toBe(1);
      now += 2 * 60_000;
      await fcmAccessToken(o);
      expect(fake.tokenCalls()).toBe(2);
    } finally {
      Date.now = real;
    }
  });

  test("a broken or wrong service account fails every message with InvalidCredentials", async () => {
    const { o } = await setup();
    const bad = await sendFcm([{ to: fcmToken("a"), body: "x" }], { ...o, serviceAccount: "{not json" });
    expect(bad[0]).toMatchObject({ status: "error", error: "InvalidCredentials", message: expect.stringMatching(/not valid JSON/) });
    const missing = await sendFcm([{ to: fcmToken("a"), body: "x" }], { ...o, serviceAccount: { project_id: "p" } as any });
    expect(missing[0]).toMatchObject({ error: "InvalidCredentials", message: "FCM service account is missing client_email, private_key" });
    const other = await serviceAccount("mail-prod");
    const wrong = await sendFcm([{ to: fcmToken("a"), body: "x" }], { ...o, serviceAccount: other.text });
    expect(wrong[0]).toMatchObject({ status: "error", error: "InvalidCredentials", message: expect.stringMatching(/invalid_grant/) });
    expect(() => parseServiceAccount({ project_id: "p", client_email: "e", private_key: "k" })).not.toThrow();
  });

  test("token format and payload size", async () => {
    expect(isFcmToken(fcmToken("a"))).toBe(true);
    expect(isFcmToken("short")).toBe(false);
    expect(isFcmToken("ExponentPushToken[abcdefghijklmnopqrstu]")).toBe(false);
    const { o } = await setup();
    const [t] = await sendFcm([{ to: fcmToken("a"), body: "x".repeat(5000) }], o);
    expect(t).toMatchObject({ status: "error", error: "MessageTooBig" });
  });
});
