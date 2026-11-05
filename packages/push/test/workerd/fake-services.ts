/**
 * Fake APNs, FCM and Google OAuth for the workerd test, running in Node behind miniflare's `outboundService`: every
 * `fetch` the Worker (or its Durable Objects) makes lands here. They verify the ES256 provider token and the RS256
 * assertion with WebCrypto, like the real services. `https://fake.test/__log` returns what they received.
 */
import { fakeApns, fakeFcm, type FakeRequest } from "../fakes.ts";
import { apnsKey, serviceAccount } from "../keys.ts";

export async function createFakeServices() {
  const k = await apnsKey();
  const sa = await serviceAccount("mail-prod");
  const apns = fakeApns({ publicKey: k.publicKey, teamId: k.teamId, keyId: k.keyId, topic: "dev.ember.mail" });
  const fcm = fakeFcm({ publicKey: sa.publicKey, clientEmail: sa.json.client_email, projectId: "mail-prod" });
  const bindings = { APNS_KEY: k.pem, APNS_KEY_ID: k.keyId, APNS_TEAM_ID: k.teamId, APNS_TOPIC: "dev.ember.mail", FCM_SERVICE_ACCOUNT: sa.text };
  const log = (): Array<FakeRequest & { service: string }> => [
    ...apns.requests.map((r) => ({ ...r, service: "apns" })),
    ...fcm.requests.map((r) => ({ ...r, service: r.host === "oauth2.googleapis.com" ? "oauth" : "fcm" })),
  ];
  const handler = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.host === "fake.test" && url.pathname === "/__log") return Response.json(log());
    const init: RequestInit = { method: request.method, headers: request.headers, body: await request.text() };
    if (url.host === "api.push.apple.com" || url.host === "api.sandbox.push.apple.com") return apns.fetch(url.href, init);
    if (url.host === "fcm.googleapis.com" || url.host === "oauth2.googleapis.com") return fcm.fetch(url.href, init);
    return new Response(`unexpected outbound fetch to ${url.host}`, { status: 599 });
  };
  return { bindings, handler };
}
