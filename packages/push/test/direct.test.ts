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
    expect(JSON.stringify(sealedApns.body)).not.toMatch(/Ana|orçamento|m-42/);
    expect(sealedApns.body.aps).toEqual({ alert: { title: "New mail", body: "Open Mail to read it" }, "mutable-content": 1, "interruption-level": "time-sensitive" });
    expect(sealedApns.headers["apns-collapse-id"]).toBe("m-42"); // routing metadata stays in clear
    expect(await openPushEnvelope(iphone.recipient, sealedApns.body.ember)).toMatchObject({ title: "Ana Souza", subtitle: "Re: orçamento", body: "Segue o orçamento revisado", data: { messageId: "m-42" } });

    const clearApns = w.apns.requests.find((q) => q.path.endsWith(hexToken("ok", 2)))!;
    expect(clearApns.body.aps.alert).toEqual({ title: "Ana Souza", subtitle: "Re: orçamento", body: "Segue o orçamento revisado" });

    const fcmSend = w.fcm.requests.find((q) => q.path.endsWith("messages:send"))!;
    expect(fcmSend.body.message.notification).toBeUndefined();
    expect(JSON.stringify(fcmSend.body)).not.toMatch(/Ana|orçamento|messageId/); // collapse_key/tag stay in clear by design
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
    expect(w.expo[0]!.body[0]).toEqual({ to: "ExponentPushToken[legacy]", title: "New mail", body: "Open Mail to read it", priority: "high" });
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

  test("content too big to seal is an error ticket, not a throw", async () => {
    const w = await world();
    const iphone = await deviceKey();
    const r = await sendToDevices([{ token: hexToken("ok"), provider: "apns", publicKey: iphone.publicKey }], { body: "x".repeat(3000) }, w.transports);
    expect(r.tickets[0]).toMatchObject({ status: "error", error: "MessageTooBig" });
  });
});
