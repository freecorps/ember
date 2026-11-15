/**
 * The origin's side of the session lookup in plain Node (no workerd): `@freecorps/ember-auth/session-lookup` has no
 * imports beyond WebCrypto and `Request`, so the old backend can run it wherever it is (Node 20+, Workers, Convex).
 * Served over a real `node:http` server, signed by Ember's own `signSessionLookup`.
 */
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SESSION_LOOKUP_HEADER, signSessionLookup, verifySessionLookupRequest } from "../../src/session-lookup.ts";

const SECRET = "node-secret";
let server: Server;
let url = "";

beforeAll(async () => {
  // The example handler of the docs: an endpoint that checks the session id in the app's own session table.
  const sessions = new Map([["s1", { userId: "u1", expiresAt: Date.now() + 60_000 }]]);
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const request = new Request(`http://localhost${req.url}`, { method: req.method!, headers: req.headers as Record<string, string>, ...(req.method === "POST" ? { body: Buffer.concat(chunks) } : {}) });
    const q = await verifySessionLookupRequest(request, SECRET);
    if (!q.ok) return void res.writeHead(q.status).end(q.reason);
    const s = sessions.get(q.sid);
    const active = !!s && s.userId === q.sub && s.expiresAt > Date.now();
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ active, ...(s ? { expiresAt: s.expiresAt } : {}) }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/ember/session`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const ask = async (body: unknown, secret = SECRET, t = Date.now()) => {
  const raw = JSON.stringify(body);
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", [SESSION_LOOKUP_HEADER]: await signSessionLookup(raw, secret, t) }, body: raw });
  return { status: res.status, text: await res.text() };
};

describe("session lookup origin helper (Node)", () => {
  it("answers signed requests from the app's own sessions", async () => {
    expect(JSON.parse((await ask({ sid: "s1", sub: "u1" })).text)).toMatchObject({ active: true });
    expect(JSON.parse((await ask({ sid: "s1", sub: "someone-else" })).text)).toMatchObject({ active: false });
    expect(JSON.parse((await ask({ sid: "nope", sub: "u1" })).text)).toEqual({ active: false });
  });

  it("refuses a wrong secret and a stale timestamp", async () => {
    expect(await ask({ sid: "s1", sub: "u1" }, "wrong")).toEqual({ status: 401, text: "signature" });
    expect(await ask({ sid: "s1", sub: "u1" }, SECRET, Date.now() - 6 * 60_000)).toEqual({ status: 401, text: "skew" });
  });

  it("imports nothing (runs in any JS runtime)", () => {
    const src = readFileSync(new URL("../../src/session-lookup.ts", import.meta.url).pathname, "utf8");
    expect(src).not.toMatch(/^\s*import\s/m);
  });
});
