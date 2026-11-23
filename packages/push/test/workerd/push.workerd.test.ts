/**
 * The push component end to end in workerd: real runtime (Worker + Shard DO, scheduler alarm, action runner), devices
 * registered over HTTP, sends going out through the runtime's `fetch` to fake APNs/FCM/Google (Node, outboundService),
 * which verify the ES256 provider token and the RS256 assertion. Covers sendNow from an action (Worker) and the
 * atomic `push.send` from a mutation (delivered by the shard's alarm, i.e. fetch from a Durable Object).
 */
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { generateRecipient, openPushEnvelope, toBase64url, type HpkeRecipient } from "../../src/index.ts";

const SHARD = "global:main";
const call = async (kind: "query" | "mutation" | "action", fn: string, args: unknown) => {
  const res = await SELF.fetch(`http://ember/api/${kind}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fn, args, shard: SHARD }) });
  const body = (await res.json()) as { ok: boolean; value?: any; error?: unknown };
  if (!body.ok) throw new Error(`${kind} ${fn}: ${JSON.stringify(body)}`);
  return body.value;
};
const fakeLog = async () => (await (await fetch("https://fake.test/__log")).json()) as Array<{ service: string; host: string; path: string; headers: Record<string, string>; body: any }>;

const hex = (marker: string, n: number) => (marker + n.toString(16).padStart(4, "0")).padEnd(64, "0");
const fcmToken = (tag: string) => `${tag}:APA91b${"w".repeat(140)}`;
const key = async (): Promise<{ recipient: HpkeRecipient; publicKey: string }> => {
  const recipient = await generateRecipient();
  return { recipient, publicKey: toBase64url(recipient.publicKey) };
};

describe("push component in workerd (direct APNs + FCM, fake endpoints)", () => {
  it("sendNow from an action: sealed to device keys, JWTs accepted by the fakes, dead tokens pruned", async () => {
    const iphone = await key();
    const pixel = await key();
    const user = `u-${crypto.randomUUID()}`;
    await call("mutation", "push:register", { user, device: { token: hex("0000", 1), platform: "ios", environment: "production", publicKey: iphone.publicKey } });
    await call("mutation", "push:register", { user, device: { token: hex("dead", 2), platform: "ios", environment: "production" } });
    await call("mutation", "push:register", { user, device: { token: fcmToken("pixel"), platform: "android", publicKey: pixel.publicKey } });
    await call("mutation", "push:register", { user, device: { token: fcmToken("dead"), platform: "android" } });

    const result = await call("action", "push:notifyNow", { user, message: { title: "Ana Souza", body: "Re: orçamento", urgency: "high", collapseId: "m-1" } });
    expect(result).toEqual({ sent: 2, errors: 2, removedTokens: 2, errorCodes: { DeviceNotRegistered: 2 } });

    const log = await fakeLog();
    const apns = log.find((r) => r.service === "apns" && r.path.endsWith(hex("0000", 1)))!;
    expect(apns.host).toBe("api.push.apple.com");
    expect(apns.headers).toMatchObject({ "apns-topic": "dev.ember.mail", "apns-push-type": "alert", "apns-priority": "10", "apns-collapse-id": "m-1" });
    expect(apns.body.aps).toEqual({ alert: { title: "New mail", body: "Open Mail to read it" }, "mutable-content": 1, "interruption-level": "time-sensitive" });
    expect(JSON.stringify(apns.body)).not.toMatch(/Ana|orçamento/);
    expect(await openPushEnvelope(iphone.recipient, apns.body.ember)).toMatchObject({ title: "Ana Souza", body: "Re: orçamento" });

    const fcm = log.find((r) => r.service === "fcm" && r.body.message.token === fcmToken("pixel"))!;
    expect(fcm.path).toBe("/v1/projects/mail-prod/messages:send");
    expect(fcm.body.message.notification).toBeUndefined();
    expect(fcm.body.message.android).toMatchObject({ priority: "HIGH", ttl: "900s", collapse_key: "m-1" });
    expect(await openPushEnvelope(pixel.recipient, JSON.parse(fcm.body.message.data.ember))).toMatchObject({ title: "Ana Souza" });
    expect(log.filter((r) => r.service === "oauth").length).toBeGreaterThanOrEqual(1);

    const devices = (await call("query", "push:devices", { user })) as Array<{ token: string }>;
    expect(devices.map((d) => d.token).sort()).toEqual([hex("0000", 1), fcmToken("pixel")].sort());
  });

  it("push.send from a mutation is delivered by the shard's scheduler (fetch from the Durable Object)", async () => {
    const iphone = await key();
    const user = `u-${crypto.randomUUID()}`;
    const token = hex("0000", 77);
    await call("mutation", "push:register", { user, device: { token, platform: "ios", environment: "production", publicKey: iphone.publicKey } });
    await call("mutation", "mail:receive", { to: user, from: "Bia", subject: "Contrato assinado" });

    let req: Awaited<ReturnType<typeof fakeLog>>[number] | undefined;
    for (let i = 0; i < 100 && !req; i++) {
      req = (await fakeLog()).find((r) => r.service === "apns" && r.path.endsWith(token));
      if (!req) await new Promise((r) => setTimeout(r, 100));
    }
    expect(req, "the scheduled delivery reached APNs").toBeDefined();
    expect(await openPushEnvelope(iphone.recipient, req!.body.ember)).toMatchObject({ title: "Bia", body: "Contrato assinado", data: { mailbox: "inbox" } });
  });

  it("Expo receipts of several sends are checked in batches by one drain chain; dead devices pruned", async () => {
    const run = crypto.randomUUID().slice(0, 8);
    const users = Array.from({ length: 6 }, (_, i) => `${run}-${i}`);
    // The last two devices are DeviceNotRegistered in their receipts.
    const tokenOf = (u: string, i: number) => `ExponentPushToken[${i >= 4 ? "late" : "ok"}-${u}]`;
    for (const [i, u] of users.entries()) await call("mutation", "expo:register", { user: u, token: tokenOf(u, i) });
    const ids = (await call("mutation", "expo:notifyEach", { users: [...users, `${run}-nobody`] })) as string[];
    expect(ids.slice(0, 6).every((id) => id.length > 0)).toBe(true);
    expect(ids[6]).toBe(""); // no device: nothing scheduled

    const mine = (r: { body: any }) => JSON.stringify(r.body).includes(run);
    let checked: string[] = [];
    for (let i = 0; i < 100 && checked.length < 6; i++) {
      const log = await fakeLog();
      checked = log.filter((r) => r.service === "expo" && r.path.endsWith("/getReceipts") && mine(r)).flatMap((r) => r.body.ids as string[]);
      if (checked.length < 6) await new Promise((r) => setTimeout(r, 100));
    }
    // Every ticket checked exactly once (one request per batch, not one per send).
    expect(checked.sort()).toEqual(users.map((u, i) => `t-${tokenOf(u, i)}`).sort());
    const requests = (await fakeLog()).filter((r) => r.service === "expo" && r.path.endsWith("/getReceipts") && mine(r));
    expect(requests.length).toBeLessThanOrEqual(6);
    for (const r of requests) expect(r.body.ids.length).toBeLessThanOrEqual(1000);

    let left: string[][] = [];
    for (let i = 0; i < 50; i++) {
      left = await Promise.all(users.map((u) => call("query", "expo:devices", { user: u }) as Promise<string[]>));
      if (left.flat().length === 4) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(left.map((d) => d.length)).toEqual([1, 1, 1, 1, 0, 0]);
  });
});
