// Probes for PLAN §18 R12 (APNs over HTTP/2 from a Worker, ES256 JWT), R14 (HEIC through the Images binding) and
// R15 (Cron Triggers: fire timing). Deployed as `ember-spike-ops-probe` by docs/spikes/remote/scripts/probes.ts.
import { DurableObject } from "cloudflare:workers";

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const enc = (o) => b64url(new TextEncoder().encode(JSON.stringify(o)));

export class Log extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS fires (scheduled INTEGER, at INTEGER, cron TEXT)");
  }
  async add(scheduled, at, cron) {
    this.ctx.storage.sql.exec("INSERT INTO fires VALUES (?, ?, ?)", scheduled, at, cron);
  }
  async list() {
    return this.ctx.storage.sql.exec("SELECT * FROM fires ORDER BY at").toArray();
  }
}

async function es256() {
  // APNs provider tokens are ES256 JWTs (P-256 + SHA-256; JWS wants the raw r||s signature WebCrypto produces).
  const t0 = performance.now();
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", kp.privateKey);
  // Re-import as an Apple .p8 key would be (PKCS#8).
  const key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const input = `${enc({ alg: "ES256", kid: "ABC123DEFG" })}.${enc({ iss: "DEF123GHIJ", iat: Math.floor(Date.now() / 1000) })}`;
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(input));
  const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, kp.publicKey, sig, new TextEncoder().encode(input));
  return { jwt: `${input}.${b64url(sig)}`, sigBytes: sig.byteLength, verified: ok, ms: performance.now() - t0 };
}

async function apns(host) {
  const { jwt, sigBytes, verified } = await es256();
  const t0 = Date.now();
  try {
    const r = await fetch(`https://${host}/3/device/${"0".repeat(64)}`, {
      method: "POST",
      headers: { authorization: `bearer ${jwt}`, "apns-topic": "com.example.ember", "apns-push-type": "alert", "content-type": "application/json" },
      body: JSON.stringify({ aps: { alert: "probe" } }),
    });
    const text = await r.text();
    const headers = Object.fromEntries([...r.headers].filter(([k]) => /apns|content-type|server|alt-svc/i.test(k)));
    return { host, status: r.status, body: text.slice(0, 300), headers, ms: Date.now() - t0, jwtSigBytes: sigBytes, jwtVerified: verified };
  } catch (e) {
    return { host, error: String(e), ms: Date.now() - t0, jwtSigBytes: sigBytes, jwtVerified: verified };
  }
}

async function images(env, bytes, format) {
  const out = {};
  try {
    out.info = await env.IMAGES.info(new Blob([bytes]).stream());
  } catch (e) {
    out.infoError = String(e);
  }
  try {
    const t0 = Date.now();
    const res = await env.IMAGES.input(new Blob([bytes]).stream()).transform({ width: 256, height: 256, fit: "scale-down" }).output({ format });
    const r = res.response();
    const buf = await r.arrayBuffer();
    const head = [...new Uint8Array(buf.slice(0, 16))].map((b) => b.toString(16).padStart(2, "0")).join("");
    out.transform = { contentType: r.headers.get("content-type"), bytes: buf.byteLength, head, ms: Date.now() - t0 };
  } catch (e) {
    out.transformError = String(e);
  }
  return out;
}

export default {
  async fetch(request, env) {
    if (request.headers.get("authorization") !== `Bearer ${env.PROBE_TOKEN}`) return new Response("no", { status: 401 });
    const url = new URL(request.url);
    if (url.pathname === "/es256") return Response.json(await es256());
    if (url.pathname === "/apns") return Response.json([await apns("api.sandbox.push.apple.com"), await apns("api.push.apple.com")]);
    if (url.pathname === "/expo") {
      // Expo Push (what @freecorps/ember-push uses today): an invalid token gets a per-ticket error, proving the path.
      const r = await fetch("https://exp.host/--/api/v2/push/send", { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify([{ to: "ExponentPushToken[ember-probe-invalid]", body: "probe" }]) });
      return Response.json({ status: r.status, body: (await r.text()).slice(0, 400) });
    }
    if (url.pathname === "/image") {
      const bytes = await request.arrayBuffer();
      return Response.json(await images(env, bytes, url.searchParams.get("format") ?? "image/webp"));
    }
    if (url.pathname === "/fires") return Response.json(await env.LOG.get(env.LOG.idFromName("log")).list());
    return new Response("not found", { status: 404 });
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(env.LOG.get(env.LOG.idFromName("log")).add(controller.scheduledTime, Date.now(), controller.cron));
  },
};
