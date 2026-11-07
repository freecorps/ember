import { afterEach, describe, expect, test } from "vitest";
import { clearApnsTokenCache, clearFcmTokenCache, generateRecipient, openPushEnvelope, sendToDevices, toBase64url, type PushTransports } from "../src/index.ts";
import { fakeApns, fakeFcm, hexToken, type FakeRequest } from "./fakes.ts";
import { apnsKey, serviceAccount } from "./keys.ts";

const TOPIC = "dev.ember.mail";
const fcmToken = (tag: string) => `${tag}:APA91b${"y".repeat(140)}`;
const noSleep = { sleep: async () => {}, retryDelayMs: 1 };

/** One fetch for Expo + APNs + FCM + Google OAuth, dispatching by host. */
async function world() {
  const k = await apnsKey();
  const sa = await serviceAccount("mail-prod");
  const apns = fakeApns({ publicKey: k.publicKey, teamId: k.teamId, keyId: k.keyId, topic: TOPIC });
  const fcm = fakeFcm({ publicKey: sa.publicKey, clientEmail: sa.json.client_email, projectId: "mail-prod" });
  const expo: FakeRequest[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.host === "exp.host") {
      const body = JSON.parse(String(init?.body));
      expo.push({ url: url.href, host: url.host, path: url.pathname, headers: {}, body });
      return Response.json({ data: body.map((m: any) => ({ status: "ok", id: `expo-${m.to}` })) });
    }
    if (url.host.endsWith("apple.com")) return apns.fetch(input, init);
    return fcm.fetch(input, init);
  }) as typeof globalThis.fetch;
  const transports: PushTransports = {
    expo: { fetch },
    apns: { keyId: k.keyId, teamId: k.teamId, key: k.pem, topic: TOPIC, fetch, ...noSleep },
    fcm: { serviceAccount: sa.text, fetch, ...noSleep },
    fallback: { title: "New mail", body: "Open Mail to read it" },
  };
  return { apns, fcm, expo, transports };
}

async function deviceKey() {
  const r = await generateRecipient();
  return { recipient: r, publicKey: toBase64url(r.publicKey) };
}

afterEach(() => {
  clearApnsTokenCache();
  clearFcmTokenCache();
});

const MAIL = { title: "Ana Souza", subtitle: "Re: orçamento", body: "Segue o orçamento revisado", data: { messageId: "m-42" }, urgency: "high" as const, collapseId: "m-42" };

describe("sendToDevices", () => {
  test("routes per provider and seals for devices with a key: APNs and FCM never see the content", async () => {
    const w = await world();
    const iphone = await deviceKey();
    const pixel = await deviceKey();
    const r = await sendToDevices(
      [
        { token: "ExponentPushToken[legacy]", provider: "expo" },
        { token: hexToken("ok", 1), provider: "apns", environment: "production", publicKey: iphone.publicKey },
        { token: hexToken("ok", 2), provider: "apns" }, // no key: clear under "auto"
        { token: fcmToken("pixel"), provider: "fcm", publicKey: pixel.publicKey, platform: "android" },
      ],
      MAIL,
      w.transports,
    );
    expect(r.tickets.map((t) => t.status)).toEqual(["ok", "ok", "ok", "ok"]);
    expect(r.expoTickets).toEqual([{ token: "ExponentPushToken[legacy]", status: "ok", id: "expo-ExponentPushToken[legacy]" }]);
    expect(r.unregisteredTokens).toEqual([]);

    const sealedApns = w.apns.requests.find((q) => q.path.endsWith(hexToken("ok", 1)))!;
    expect(JSON.stringify(sealedApns.body)).not.toMatch(/Ana Souza|orçamento|"m-42"/); // markers outside base64url, so ciphertext never matches by chance
    expect(sealedApns.body.aps).toEqual({ alert: { title: "New mail", body: "Open Mail to read it" }, "mutable-content": 1, "interruption-level": "time-sensitive" });
    expect(sealedApns.headers["apns-collapse-id"]).toBe("m-42"); // routing metadata stays in clear
    expect(await openPushEnvelope(iphone.recipient, sealedApns.body.ember)).toMatchObject({ title: "Ana Souza", subtitle: "Re: orçamento", body: "Segue o orçamento revisado", data: { messageId: "m-42" } });

    const clearApns = w.apns.requests.find((q) => q.path.endsWith(hexToken("ok", 2)))!;
    expect(clearApns.body.aps.alert).toEqual({ title: "Ana Souza", subtitle: "Re: orçamento", body: "Segue o orçamento revisado" });

    const fcmSend = w.fcm.requests.find((q) => q.path.endsWith("messages:send"))!;
    expect(fcmSend.body.message.notification).toBeUndefined();
    expect(JSON.stringify(fcmSend.body)).not.toMatch(/Ana Souza|orçamento|"messageId|\\"messageId/); // collapse_key/tag stay in clear by design
    expect(await openPushEnvelope(pixel.recipient, JSON.parse(fcmSend.body.message.data.ember))).toMatchObject({ title: "Ana Souza", data: { messageId: "m-42" } });

    expect(w.expo[0]!.body[0]).toMatchObject({ to: "ExponentPushToken[legacy]", title: "Ana Souza", priority: "high" });
  });

  test("required: devices without a key and Expo devices get only the fallback text, no data", async () => {
    const w = await world();
    const r = await sendToDevices(
      [
        { token: "ExponentPushToken[legacy]", provider: "expo" },
        { token: hexToken("ok", 3), provider: "apns" },
        { token: fcmToken("nokey"), provider: "fcm" },
      ],
      { ...MAIL, encryption: "required" },
      w.transports,
    );
    expect(r.tickets.every((t) => t.status === "ok")).toBe(true);
    expect(w.expo[0]!.body[0]).toEqual({ to: "ExponentPushToken[legacy]", title: "New mail", body: "Open Mail to read it", priority: "high", collapseId: "m-42", tag: "m-42" });
    const a = w.apns.requests[0]!.body;
    expect(a.aps.alert).toEqual({ title: "New mail", body: "Open Mail to read it" });
    expect(a.body).toBeUndefined();
    const f = w.fcm.requests.find((q) => q.path.endsWith("messages:send"))!.body.message;
    expect(f.notification).toEqual({ title: "New mail", body: "Open Mail to read it" });
    expect(f.data).toBeUndefined();
  });

  test("off: clear even for devices with a key", async () => {
    const w = await world();
    const iphone = await deviceKey();
    await sendToDevices([{ token: hexToken("ok", 4), provider: "apns", publicKey: iphone.publicKey }], MAIL, { ...w.transports, encryption: "off" });
    expect(w.apns.requests[0]!.body.ember).toBeUndefined();
    expect(w.apns.requests[0]!.body.aps.alert.title).toBe("Ana Souza");
  });

  test("dead tokens are reported for pruning; unconfigured providers are errors that never prune; environments discovered", async () => {
    const w = await world();
    const r = await sendToDevices(
      [
        { token: hexToken("dead"), provider: "apns" },
        { token: fcmToken("dead"), provider: "fcm" },
        { token: fcmToken("sender"), provider: "fcm" },
        { token: hexToken("sandbox", 7), provider: "apns" }, // no environment recorded: found on the sandbox host
        { token: hexToken("dead"), provider: "apns" }, // duplicate: sent once
      ],
      { body: "x" },
      w.transports,
    );
    expect(r.tickets).toHaveLength(4);
    expect(r.unregisteredTokens.sort()).toEqual([fcmToken("dead"), hexToken("dead")].sort());
    expect(r.environments).toEqual([{ token: hexToken("sandbox", 7), environment: "sandbox" }]);

    const none = await sendToDevices([{ token: hexToken("ok"), provider: "apns" }, { token: fcmToken("a"), provider: "fcm" }], { body: "x" }, { expo: false });
    expect(none.tickets.map((t) => t.status === "error" && t.error)).toEqual(["ProviderNotConfigured", "ProviderNotConfigured"]);
    expect(none.unregisteredTokens).toEqual([]);
  });

  test("VoIP goes to the PushKit tokens of iOS devices only; dead VoIP tokens are reported separately", async () => {
    const w = await world();
    const r = await sendToDevices(
      [
        { token: hexToken("ok", 5), provider: "apns", voipToken: hexToken("ok", 6), userId: "u1" },
        { token: hexToken("ok", 7), provider: "apns", voipToken: hexToken("dead", 8), userId: "u2" },
        { token: hexToken("ok", 9), provider: "apns" },
        { token: fcmToken("android"), provider: "fcm" },
      ],
      { voip: true, data: { callId: "c-1" } },
      w.transports,
    );
    expect(w.apns.requests.map((q) => q.path).sort()).toEqual([`/3/device/${hexToken("dead", 8)}`, `/3/device/${hexToken("ok", 6)}`].sort());
    expect(w.apns.requests.every((q) => q.headers["apns-push-type"] === "voip")).toBe(true);
    expect(r.unregisteredTokens).toEqual([]);
    expect(r.unregisteredVoipTokens).toEqual([{ userId: "u2", voipToken: hexToken("dead", 8) }]);
  });

  test("an unknown provider stored for a device is an error ticket for that device, not a throw for the batch", async () => {
    const w = await world();
    const r = await sendToDevices(
      [
        { token: hexToken("ok", 1), provider: "APNS" },
        { token: fcmToken("typo"), provider: "android" },
        { token: fcmToken("proto"), provider: "constructor" },
        { token: hexToken("ok", 2), provider: "apns" },
      ],
      { body: "x" },
      w.transports,
    );
    expect(r.tickets.map((t) => (t.status === "error" ? t.error : t.status))).toEqual(["ProviderNotConfigured", "ProviderNotConfigured", "ProviderNotConfigured", "ok"]);
    expect(r.tickets[0]).toMatchObject({ token: hexToken("ok", 1), message: 'unknown push provider "APNS" (expected expo, apns or fcm)' });
    expect(w.apns.requests.map((q) => q.path)).toEqual([`/3/device/${hexToken("ok", 2)}`]);
    expect(r.unregisteredTokens).toEqual([]);
  });

  test("content too big to seal is an error ticket, not a throw", async () => {
    const w = await world();
    const iphone = await deviceKey();
    const r = await sendToDevices([{ token: hexToken("ok"), provider: "apns", publicKey: iphone.publicKey }], { body: "x".repeat(3000) }, w.transports);
    expect(r.tickets[0]).toMatchObject({ status: "error", error: "MessageTooBig" });
  });
});

// An app with its own envelope (Brigade RFC 0016 gap G1): its payload goes out as given; Ember keeps the transport.
describe("app-owned payloads", () => {
  test("the seal hook's payload is sent as given to APNs and FCM; null keeps Ember's handling; Expo never reaches it", async () => {
    const w = await world();
    const iphone = await deviceKey();
    const asked: string[] = [];
    const transports: PushTransports = {
      ...w.transports,
      seal: (device, message, provider) => {
        asked.push(`${provider}:${device.token.slice(0, 8)}`);
        if (device.token === hexToken("ok", 9)) return null; // Ember's own envelope for this one
        return provider === "apns"
          ? { apns: { aps: { alert: { title: "Paged" }, "mutable-content": 1, sound: { critical: 1, name: "page.caf", volume: 1 }, "interruption-level": "critical" }, acme: { v: 2, ct: "opaque" } } }
          : { fcmData: { v: "2", ct: "opaque", kind: "page" } };
      },
    };
    const r = await sendToDevices(
      [
        { token: "ExponentPushToken[legacy]", provider: "expo" },
        { token: hexToken("ok", 1), provider: "apns", environment: "production" },
        { token: hexToken("ok", 9), provider: "apns", environment: "production", publicKey: iphone.publicKey },
        { token: fcmToken("pixel"), provider: "fcm", platform: "android" },
      ],
      { ...MAIL, ttl: 120 },
      transports,
    );
    expect(r.tickets.map((t) => t.status)).toEqual(["ok", "ok", "ok", "ok"]);
    expect(asked.sort()).toEqual(["apns:00000001", "apns:00000009", "fcm:pixel:AP"].sort());
    const own = w.apns.requests.find((q) => q.path.endsWith(hexToken("ok", 1)))!;
    expect(own.body).toEqual({ aps: { alert: { title: "Paged" }, "mutable-content": 1, sound: { critical: 1, name: "page.caf", volume: 1 }, "interruption-level": "critical" }, acme: { v: 2, ct: "opaque" } });
    // Ember still owns the transport: headers from the message.
    expect(own.headers).toMatchObject({ "apns-push-type": "alert", "apns-priority": "10", "apns-collapse-id": "m-42", "apns-topic": TOPIC });
    const ember = w.apns.requests.find((q) => q.path.endsWith(hexToken("ok", 9)))!;
    expect(await openPushEnvelope(iphone.recipient, ember.body.ember)).toMatchObject({ title: "Ana Souza" });
    const fcmSend = w.fcm.requests.find((q) => q.path.endsWith("messages:send"))!;
    expect(fcmSend.body.message).toEqual({ token: fcmToken("pixel"), android: { priority: "HIGH", ttl: "120s", collapse_key: "m-42" }, data: { v: "2", ct: "opaque", kind: "page" } });
    expect(w.expo[0]!.body[0]).not.toHaveProperty("payload");
  });

  test("a seal hook that throws is that device's RequestFailed ticket; non-string FCM data is refused", async () => {
    const w = await world();
    const r = await sendToDevices(
      [
        { token: hexToken("ok", 1), provider: "apns", environment: "production" },
        { token: fcmToken("pixel"), provider: "fcm", platform: "android" },
      ],
      MAIL,
      { ...w.transports, seal: (_d, _m, provider) => (provider === "apns" ? Promise.reject(new Error("no key for this device")) : { fcmData: { n: 1 as unknown as string } }) },
    );
    expect(r.tickets[0]).toMatchObject({ status: "error", error: "RequestFailed", message: "seal hook: no key for this device" });
    expect(r.tickets[1]).toMatchObject({ status: "error", error: "InvalidArgument" });
    expect(r.unregisteredTokens).toEqual([]);
    expect(w.apns.requests).toHaveLength(0);
  });

  test("a payload that is only content-available goes as a background push at priority 5", async () => {
    const w = await world();
    await sendToDevices([{ token: hexToken("ok", 3), provider: "apns", environment: "production" }], { contentAvailable: true }, { ...w.transports, seal: () => ({ apns: { aps: { "content-available": 1 }, sync: 1 } }) });
    expect(w.apns.requests[0]!.headers).toMatchObject({ "apns-push-type": "background", "apns-priority": "5" });
  });
});
