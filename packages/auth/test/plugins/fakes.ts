/**
 * Fakes for the parties outside Ember that the Better Auth plugins talk to, all in this isolate (the Auth Durable
 * Object runs in the same isolate as the tests under @cloudflare/vitest-plugin), with no network:
 *
 * - `idp`: an OpenID Connect issuer at `https://idp.test` (discovery, token endpoint with PKCE and client_secret_basic,
 *   JWKS, userinfo), reached by the sso plugin's own `fetch` through `interceptFetch`.
 * - `stripeApi`: the few Stripe REST endpoints the stripe plugin calls, handed to the Stripe SDK as its fetch client.
 * - `Authenticator`: a software WebAuthn authenticator (ES256, attestation "none") for the passkey ceremonies.
 * - `pwned`: the Have I Been Pwned range API (`haveIBeenPwned`), k-anonymity as the real one (5 hex chars in, padded
 *   suffix list out).
 * - `google`: Google's signing keys (`/oauth2/v3/certs`) and ID tokens signed with them (`oneTap`).
 * - `Wallet`: an Ethereum wallet for SIWE. The siwe plugin hands signature checks to the app (`verifyMessage`, viem in
 *   a real app); here the "signature" is an HMAC under the wallet's key, checked by the config's `verifyMessage`.
 */
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";

const enc = new TextEncoder();
export const b64url = (bytes: Uint8Array | ArrayBuffer) => {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of u) s += String.fromCharCode(b);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};
export const fromB64url = (s: string) => Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const sha256 = async (data: Uint8Array | string) => new Uint8Array(await crypto.subtle.digest("SHA-256", typeof data === "string" ? enc.encode(data) : data));
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) out.set(p, (o += p.length) - p.length);
  return out;
};

/** A deferred: lets a test hold a fake's answer until it decides (slow third parties). */
export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

// ---------------------------------------------------------------------------------------------------------------
// Outbound fetch interception (sso's discovery/token/JWKS calls go through the global fetch).

type Handler = (request: Request) => Response | Promise<Response>;
const hosts = new Map<string, Handler>();
/** Every outbound request a fake answered, in order (method + URL). */
export const outbound: string[] = [];
let installed = false;

/** Routes `fetch` to `origin` to `handler`; any other origin still reaches the real fetch. */
export function interceptFetch(origin: string, handler: Handler) {
  hosts.set(origin, handler);
  if (installed) return;
  installed = true;
  const real = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input as RequestInfo, init);
    const h = hosts.get(new URL(request.url).origin);
    if (!h) return real(input as RequestInfo, init);
    outbound.push(`${request.method} ${request.url}`);
    return h(request);
  }) as typeof fetch;
}

// ---------------------------------------------------------------------------------------------------------------
// OpenID Connect issuer.

export type IdpUser = { sub: string; email: string; name: string; email_verified?: boolean };
type Grant = { user: IdpUser; clientId: string; redirectUri: string; challenge: string | null; nonce: string | null; scope: string | null };

export const IDP = "https://idp.test";
export const idp = {
  issuer: IDP,
  clients: new Map<string, string>(), // clientId → secret
  codes: new Map<string, Grant>(),
  tokens: new Map<string, IdpUser>(), // access token → user
  /** Set to hold the token endpoint (a slow IdP). */
  hold: null as null | Promise<void>,
  /** Set to hold the discovery document. */
  holdDiscovery: null as null | Promise<void>,
  keys: null as null | { privateKey: CryptoKey; jwk: JWK },
  async key() {
    if (!this.keys) {
      const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
      this.keys = { privateKey: privateKey as CryptoKey, jwk: { ...(await exportJWK(publicKey)), kid: "idp-1", alg: "RS256", use: "sig" } };
    }
    return this.keys;
  },
  /** What the user's browser does at the IdP: signs in as `user` and is sent back with a code. */
  async authorize(authorizationUrl: string, user: IdpUser): Promise<string> {
    const u = new URL(authorizationUrl);
    if (u.origin !== IDP || u.pathname !== "/authorize") throw new Error(`not the fake IdP: ${authorizationUrl}`);
    const clientId = u.searchParams.get("client_id")!;
    if (!this.clients.has(clientId)) throw new Error(`unknown client ${clientId}`);
    const code = `code-${crypto.randomUUID()}`;
    this.codes.set(code, {
      user,
      clientId,
      redirectUri: u.searchParams.get("redirect_uri")!,
      challenge: u.searchParams.get("code_challenge"),
      nonce: u.searchParams.get("nonce"),
      scope: u.searchParams.get("scope"),
    });
    const back = new URL(u.searchParams.get("redirect_uri")!);
    back.searchParams.set("code", code);
    back.searchParams.set("state", u.searchParams.get("state")!);
    return back.toString();
  },
  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    switch (url.pathname) {
      case "/.well-known/openid-configuration":
        if (this.holdDiscovery) await this.holdDiscovery;
        return Response.json({
          issuer: IDP,
          authorization_endpoint: `${IDP}/authorize`,
          token_endpoint: `${IDP}/token`,
          userinfo_endpoint: `${IDP}/userinfo`,
          jwks_uri: `${IDP}/jwks`,
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
          token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
          code_challenge_methods_supported: ["S256"],
        });
      case "/jwks":
        return Response.json({ keys: [(await this.key()).jwk] });
      case "/userinfo": {
        const user = this.tokens.get(request.headers.get("authorization")?.replace(/^Bearer /i, "") ?? "");
        // `id` too: a plain OAuth 2.0 profile API (no OIDC) names the subject that way.
        return user ? Response.json({ ...user, id: user.sub }) : new Response("unauthorized", { status: 401 });
      }
      case "/token": {
        if (this.hold) await this.hold;
        const form = new URLSearchParams(await request.text());
        const basic = request.headers.get("authorization");
        const [id, secret] = basic?.startsWith("Basic ") ? atob(basic.slice(6)).split(":").map(decodeURIComponent) : [form.get("client_id"), form.get("client_secret")];
        if (!id || this.clients.get(id) !== secret) return Response.json({ error: "invalid_client" }, { status: 401 });
        const grant = this.codes.get(form.get("code") ?? "");
        this.codes.delete(form.get("code") ?? "");
        if (!grant || grant.clientId !== id || grant.redirectUri !== form.get("redirect_uri")) return Response.json({ error: "invalid_grant" }, { status: 400 });
        if (grant.challenge && b64url(await sha256(form.get("code_verifier") ?? "")) !== grant.challenge) return Response.json({ error: "invalid_grant", error_description: "pkce" }, { status: 400 });
        const access = `at-${crypto.randomUUID()}`;
        this.tokens.set(access, grant.user);
        // Plain OAuth 2.0 (no `openid` scope): an access token only, the profile comes from /userinfo.
        if (grant.scope !== null && !grant.scope.split(" ").includes("openid")) {
          return Response.json({ access_token: access, token_type: "Bearer", expires_in: 300, scope: grant.scope });
        }
        const { privateKey } = await this.key();
        const idToken = await new SignJWT({ ...grant.user, ...(grant.nonce ? { nonce: grant.nonce } : {}) })
          .setProtectedHeader({ alg: "RS256", kid: "idp-1" })
          .setIssuer(IDP)
          .setAudience(id)
          .setSubject(grant.user.sub)
          .setIssuedAt()
          .setExpirationTime("5m")
          .sign(privateKey);
        return Response.json({ access_token: access, token_type: "Bearer", expires_in: 300, id_token: idToken, scope: "openid email profile" });
      }
    }
    return new Response("not found", { status: 404 });
  },
};

// ---------------------------------------------------------------------------------------------------------------
// Stripe REST API (only what the stripe plugin calls in these flows).

type Customer = { id: string; object: "customer"; email: string | null; name: string | null; metadata: Record<string, string> };
export const stripeApi = {
  customers: new Map<string, Customer>(),
  subscriptions: new Map<string, Record<string, unknown>>(),
  calls: [] as string[],
  /** Checkout sessions created (what the plugin sent: customer, client_reference_id, metadata). */
  checkouts: [] as { id: string; customer: string | null; client_reference_id: string | null; metadata: Record<string, string> }[],
  /** Set to hold customer creation (a slow Stripe). */
  hold: null as null | Promise<void>,
  /** The `fetch` the Stripe SDK gets (`Stripe.createFetchHttpClient(stripeApi.fetch)`). */
  fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input as RequestInfo, init);
    const url = new URL(request.url);
    stripeApi.calls.push(`${request.method} ${url.pathname}`);
    const form = request.method === "POST" ? new URLSearchParams(await request.text()) : url.searchParams;
    const metadata = () => Object.fromEntries([...form].flatMap(([k, v]) => (k.startsWith("metadata[") ? [[k.slice(9, -1), v]] : [])));
    const list = (data: unknown[]) => Response.json({ object: "list", data, has_more: false, url: url.pathname });
    if (request.method === "POST" && url.pathname === "/v1/customers") {
      if (stripeApi.hold) await stripeApi.hold;
      const c: Customer = { id: `cus_${crypto.randomUUID().slice(0, 12)}`, object: "customer", email: form.get("email"), name: form.get("name"), metadata: metadata() };
      stripeApi.customers.set(c.id, c);
      return Response.json(c);
    }
    const customer = /^\/v1\/customers\/(cus_[^/]+)$/.exec(url.pathname);
    if (customer) {
      const c = stripeApi.customers.get(customer[1]!);
      if (!c) return Response.json({ error: { type: "invalid_request_error", message: "No such customer" } }, { status: 404 });
      if (request.method === "POST") {
        if (form.has("email")) c.email = form.get("email");
        if (form.has("name")) c.name = form.get("name");
      }
      return Response.json(c);
    }
    if (url.pathname === "/v1/customers/search") return Response.json({ object: "search_result", data: [], has_more: false, url: url.pathname });
    if (url.pathname === "/v1/customers") return list([...stripeApi.customers.values()]);
    if (request.method === "GET" && url.pathname === "/v1/subscriptions") return list([...stripeApi.subscriptions.values()].filter((s) => s.customer === url.searchParams.get("customer")));
    if (request.method === "GET" && url.pathname.startsWith("/v1/subscriptions/")) {
      const s = stripeApi.subscriptions.get(url.pathname.slice("/v1/subscriptions/".length));
      return s ? Response.json(s) : Response.json({ error: { type: "invalid_request_error", message: "No such subscription" } }, { status: 404 });
    }
    if (request.method === "POST" && url.pathname === "/v1/checkout/sessions") {
      const id = `cs_test_${crypto.randomUUID().slice(0, 12)}`;
      const session = { id, customer: form.get("customer"), client_reference_id: form.get("client_reference_id"), metadata: metadata() };
      stripeApi.checkouts.push(session);
      return Response.json({ ...session, object: "checkout.session", url: `https://checkout.stripe.test/${id}`, mode: form.get("mode") });
    }
    return Response.json({ error: { type: "invalid_request_error", message: `fake stripe: ${request.method} ${url.pathname}` } }, { status: 404 });
  }) as typeof fetch,
  /** A Stripe subscription object as the API returns it. */
  subscription(o: { id: string; customer: string; priceId: string; status: string; cancelAtPeriodEnd?: boolean; metadata?: Record<string, string> }) {
    const now = Math.floor(Date.now() / 1000);
    const sub = {
      id: o.id,
      object: "subscription",
      customer: o.customer,
      status: o.status,
      cancel_at_period_end: o.cancelAtPeriodEnd ?? false,
      cancel_at: null,
      canceled_at: null,
      ended_at: null,
      trial_start: null,
      trial_end: null,
      metadata: o.metadata ?? {},
      items: {
        object: "list",
        data: [
          {
            id: `si_${o.id}`,
            object: "subscription_item",
            quantity: 1,
            current_period_start: now,
            current_period_end: now + 30 * 86400,
            price: { id: o.priceId, object: "price", lookup_key: null, recurring: { interval: "month" } },
          },
        ],
      },
    };
    this.subscriptions.set(o.id, sub);
    return sub;
  },
};

// ---------------------------------------------------------------------------------------------------------------
// WebAuthn: a software authenticator (ES256, attestation "none", user verification on).

/** Minimal CBOR encoder: unsigned/negative ints, byte and text strings, arrays and maps. */
export function cbor(value: unknown): Uint8Array {
  const head = (major: number, n: number): Uint8Array => {
    if (n < 24) return Uint8Array.of((major << 5) | n);
    if (n < 0x100) return Uint8Array.of((major << 5) | 24, n);
    if (n < 0x10000) return Uint8Array.of((major << 5) | 25, n >> 8, n & 0xff);
    return Uint8Array.of((major << 5) | 26, (n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
  };
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (value instanceof Uint8Array) return concat(head(2, value.length), value);
  if (typeof value === "string") {
    const b = enc.encode(value);
    return concat(head(3, b.length), b);
  }
  if (Array.isArray(value)) return concat(head(4, value.length), ...value.map(cbor));
  if (value instanceof Map) return concat(head(5, value.size), ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)]));
  if (value && typeof value === "object") return cbor(new Map(Object.entries(value)));
  throw new Error(`cbor: unsupported ${typeof value}`);
}

/** WebCrypto's ECDSA signature is r‖s; WebAuthn wants it DER-encoded. */
function derSignature(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let v = b.slice(i);
    if (v[0]! & 0x80) v = concat(Uint8Array.of(0), v);
    return concat(Uint8Array.of(0x02, v.length), v);
  };
  const body = concat(int(raw.slice(0, 32)), int(raw.slice(32)));
  return concat(Uint8Array.of(0x30, body.length), body);
}

export class Authenticator {
  private keys: CryptoKeyPair | null = null;
  readonly credentialId = crypto.getRandomValues(new Uint8Array(32));
  signCount = 0;
  constructor(readonly origin: string, readonly rpId: string) {}

  private async authData(flags: number, attested?: Uint8Array) {
    const count = new Uint8Array(4);
    new DataView(count.buffer).setUint32(0, this.signCount);
    return concat(await sha256(this.rpId), Uint8Array.of(flags), count, attested ?? new Uint8Array());
  }

  private clientData(type: "webauthn.create" | "webauthn.get", challenge: string) {
    return enc.encode(JSON.stringify({ type, challenge, origin: this.origin, crossOrigin: false }));
  }

  /** `navigator.credentials.create()`: answers the server's registration options with a RegistrationResponseJSON. */
  async register(options: { challenge: string; rp?: { id?: string } }) {
    this.keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const jwk = await crypto.subtle.exportKey("jwk", this.keys.publicKey) as JsonWebKey;
    const cose = cbor(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, fromB64url(jwk.x!)], [-3, fromB64url(jwk.y!)]]));
    const idLen = Uint8Array.of(this.credentialId.length >> 8, this.credentialId.length & 0xff);
    const attested = concat(new Uint8Array(16) /* aaguid */, idLen, this.credentialId, cose);
    const authData = await this.authData(0x45 /* UP | UV | AT */, attested);
    const attestationObject = cbor(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]));
    const id = b64url(this.credentialId);
    return {
      id,
      rawId: id,
      type: "public-key",
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
      response: {
        clientDataJSON: b64url(this.clientData("webauthn.create", options.challenge)),
        attestationObject: b64url(attestationObject),
        transports: ["internal"],
      },
    };
  }

  /** `navigator.credentials.get()`: an AuthenticationResponseJSON for the server's challenge. */
  async authenticate(options: { challenge: string }, userHandle?: string) {
    if (!this.keys) throw new Error("register first");
    this.signCount++;
    const authData = await this.authData(0x05 /* UP | UV */);
    const clientDataJSON = this.clientData("webauthn.get", options.challenge);
    const raw = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.keys.privateKey, concat(authData, await sha256(clientDataJSON))));
    const id = b64url(this.credentialId);
    return {
      id,
      rawId: id,
      type: "public-key",
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authData),
        signature: b64url(derSignature(raw)),
        ...(userHandle ? { userHandle } : {}),
      },
    };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Have I Been Pwned: GET https://api.pwnedpasswords.com/range/<first 5 of SHA-1>.

export const PWNED = "https://api.pwnedpasswords.com";
const sha1Hex = async (s: string) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-1", enc.encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
export const pwned = {
  /** SHA-1 (upper hex) → times seen. */
  hashes: new Map<string, number>(),
  /** Prefixes asked for, in order (what left the Auth DO). */
  asked: [] as string[],
  /** Per request (same order as `asked`): whether the client sent `Add-Padding: true`. */
  padded: [] as boolean[],
  async add(password: string, count = 12345) {
    this.hashes.set(await sha1Hex(password), count);
  },
  async handle(request: Request): Promise<Response> {
    const m = /^\/range\/([0-9A-F]{5})$/i.exec(new URL(request.url).pathname);
    if (!m) return new Response("not found", { status: 404 });
    const prefix = m[1]!.toUpperCase();
    this.asked.push(prefix);
    const padding = request.headers.get("Add-Padding") === "true";
    this.padded.push(padding);
    const lines = [...this.hashes].filter(([h]) => h.startsWith(prefix)).map(([h, n]) => `${h.slice(5)}:${n}`);
    // `Add-Padding: true`: decoy suffixes with a count of 0 (only when asked for, as the real API does).
    if (padding) for (let i = 0; i < 5; i++) lines.push(`${(await sha1Hex(`pad-${prefix}-${i}`)).slice(5)}:0`);
    return new Response(lines.join("\r\n"), { headers: { "content-type": "text/plain" } });
  },
};

// ---------------------------------------------------------------------------------------------------------------
// Google: the One Tap ID token and the keys it is checked against.

export const GOOGLE_APIS = "https://www.googleapis.com";
export const google = {
  keys: null as null | { privateKey: CryptoKey; jwk: JWK },
  async key() {
    if (!this.keys) {
      const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
      this.keys = { privateKey: privateKey as CryptoKey, jwk: { ...(await exportJWK(publicKey)), kid: "google-1", alg: "RS256", use: "sig" } };
    }
    return this.keys;
  },
  async handle(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== "/oauth2/v3/certs") return new Response("not found", { status: 404 });
    return Response.json({ keys: [(await this.key()).jwk] });
  },
  /** What Google Identity Services hands the page after One Tap. `key` signs instead of Google's (a forgery). */
  async idToken(o: { aud: string; sub: string; email: string; name: string; key?: CryptoKey }) {
    return new SignJWT({ email: o.email, email_verified: true, name: o.name, picture: "https://lh3.googleusercontent.test/a.png" })
      .setProtectedHeader({ alg: "RS256", kid: "google-1" })
      .setIssuer("https://accounts.google.com")
      .setAudience(o.aud)
      .setSubject(o.sub)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(o.key ?? (await this.key()).privateKey);
  },
};

// ---------------------------------------------------------------------------------------------------------------
// SIWE (EIP-4361) wallet.

export class Wallet {
  /** Wallets by checksum-insensitive address, for the config's `verifyMessage`. */
  static all = new Map<string, Wallet>();
  readonly address: string;
  private readonly secret = crypto.getRandomValues(new Uint8Array(32));
  constructor() {
    this.address = `0x${[...crypto.getRandomValues(new Uint8Array(20))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
    Wallet.all.set(this.address.toLowerCase(), this);
  }
  /** The EIP-4361 message a dapp asks the wallet to sign. */
  message(o: { domain: string; uri: string; nonce: string; chainId?: number }) {
    return [
      `${o.domain} wants you to sign in with your Ethereum account:`,
      this.address,
      "",
      "Sign in to Ember",
      "",
      `URI: ${o.uri}`,
      "Version: 1",
      `Chain ID: ${o.chainId ?? 1}`,
      `Nonce: ${o.nonce}`,
      `Issued At: ${new Date().toISOString()}`,
    ].join("\n");
  }
  async sign(message: string) {
    const key = await crypto.subtle.importKey("raw", this.secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return `0x${[...new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message)))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  }
  /** `verifyMessage` of the siwe plugin, for this fake. */
  static async verify({ message, signature, address }: { message: string; signature: string; address: string }) {
    const w = Wallet.all.get(address.toLowerCase());
    return !!w && (await w.sign(message)) === signature;
  }
}
