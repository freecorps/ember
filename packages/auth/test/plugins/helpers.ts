import { SELF } from "cloudflare:test";
import { decodeServerMessage, encodeClientMessage, type ClientMessage, type ServerMessage } from "@freecorps/ember-runtime";
import { expect } from "vitest";
import { Client, rnd } from "../helpers.ts";
import { ORIGIN } from "./auth.config.ts";

export { Client, ORIGIN, rnd };
export const password = "correct horse battery staple";
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A browser that signed up with email + password (hashed in the Worker: the test Worker runs `strictHashing`). */
export async function signedUp(prefix: string, name = "User") {
  const c = new Client();
  const email = `${prefix}-${rnd()}@example.test`;
  const r = await c.req("/api/auth/sign-up/email", { body: { email, password, name } });
  expect(r.status, r.text).toBe(200);
  return { c, email, user: r.json.user as { id: string; email: string }, sessionToken: r.headers.get("set-auth-token")! };
}

/** The Ember JWT for a browser session (`/api/auth/token`). */
export async function jwtOf(c: Client, headers?: Record<string, string>) {
  const r = await c.req("/api/auth/token", headers ? { headers } : {});
  expect(r.status, r.text).toBe(200);
  return r.json.token as string;
}

export const claimsOf = (jwt: string) => JSON.parse(atob(jwt.split(".")[1]!.replaceAll("-", "+").replaceAll("_", "/"))) as Record<string, unknown>;

/** An Ember query over HTTP with a bearer token (what `ctx.auth` sees in the shard). */
export async function query(fn: string, args: unknown, token?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await SELF.fetch(`${ORIGIN}/api/query`, { method: "POST", headers, body: JSON.stringify({ fn, args, shard: "global:main" }) });
  return { status: res.status, body: (await res.json()) as { ok: boolean; value?: any; error?: { code: string } } };
}

export const whoami = async (token?: string) => {
  const r = await query("app:whoami", {}, token);
  if (!r.body.ok && r.body.error?.code !== "unauthenticated") throw new Error(JSON.stringify(r.body));
  return (r.body.value ?? null) as null | { subject: string; claims: Record<string, unknown> };
};

export interface AppSocket {
  ws: WebSocket;
  frames: ServerMessage[];
  send(m: ClientMessage): void;
  waitFor(t: ServerMessage["t"], ms?: number): Promise<ServerMessage>;
  snap: Extract<ServerMessage, { t: "snap" }>;
  close(): void;
}

/** A socket on the app's shard, signed in with `token`, subscribed to `app:whoami`. */
export async function socket(token: string): Promise<AppSocket> {
  const res = await SELF.fetch(`${ORIGIN}/ws?shard=global:main`, { headers: { Upgrade: "websocket" } });
  if (!res.webSocket) throw new Error(`upgrade failed: ${res.status}`);
  const ws = res.webSocket;
  ws.accept();
  const frames: ServerMessage[] = [];
  ws.addEventListener("message", (e) => {
    const text = String(e.data);
    if (text === "pong") return;
    for (const m of text.startsWith("[") ? (JSON.parse(text) as unknown[]).map((x) => decodeServerMessage(JSON.stringify(x))) : [decodeServerMessage(text)]) frames.push(m);
  });
  const send = (m: ClientMessage) => ws.send(encodeClientMessage(m));
  const waitFor = async (t: ServerMessage["t"], ms = 3000) => {
    const end = Date.now() + ms;
    for (;;) {
      const i = frames.findIndex((f) => f.t === t);
      if (i >= 0) return frames.splice(i, 1)[0]!;
      if (Date.now() > end) throw new Error(`no ${t} frame; got ${JSON.stringify(frames)}`);
      await sleep(10);
    }
  };
  send({ t: "hello", clientId: crypto.randomUUID(), protocol: 1, token });
  await waitFor("ready");
  send({ t: "sub", qid: 1, fn: "app:whoami", args: {} });
  const snap = (await waitFor("snap")) as Extract<ServerMessage, { t: "snap" }>;
  return { ws, frames, send, waitFor, snap, close: () => ws.close(1000, "done") };
}

/** Polls until `ok` (the profile outbox and the shards are eventually consistent). */
export async function until<T>(get: () => Promise<T>, ok: (v: T) => boolean, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await get();
    if (ok(v) || Date.now() > end) return v;
    await sleep(25);
  }
}

/** What `internal.users.sync` delivered for a user (the app's `profiles` table). */
export type Profile = { event: string; fields: string[]; user: Record<string, unknown> };
export const profilesOf = async (userId: string) => ((await query("app:profiles", { userId })).body.value ?? []) as Profile[];

/** Polls the profile outbox until `ok`, then checks no delivered copy carries a credential. */
export async function profilesUntil(userId: string, ok: (p: Profile[]) => boolean): Promise<Profile[]> {
  const profiles = await until(() => profilesOf(userId), ok);
  expect(ok(profiles), JSON.stringify(profiles.map((p) => [p.event, p.user]))).toBe(true);
  for (const p of profiles) expect(p.fields.filter((f) => /password|secret|token|key/i.test(f))).toEqual([]);
  return profiles;
}

/** A signed-in browser for an existing account (`/sign-in/email`: the Worker verifies the password). */
export async function signedIn(email: string, pw = password) {
  const c = new Client();
  const r = await c.req("/api/auth/sign-in/email", { body: { email, password: pw } });
  return { c, r };
}
