// A thin admin-only HTTP surface over the email component, enough to drive it from a script (the E2E driver in
// docs/spikes/remote/scripts/email-e2e.ts). Every route needs `Authorization: Bearer <EMBER_ADMIN_TOKEN>`.
//
//   GET  /mailboxes                 POST /mailboxes { name, address, displayName?, autoReply? }
//   POST /send { from, to, subject, text?, html?, idempotencyKey? }  → { id, duplicate? }
//   GET  /emails/:id                → { email, events }
//   GET  /threads?mailbox=          GET /threads/:id      POST /threads/:id/reply { text }
//
// Real apps call the component from their own functions (`new Email(components.email).send(ctx, ...)`) and put
// their own auth in front; this example has no users, keys or tenants on purpose.
import { anyComponents as components, httpActionGeneric as httpAction, httpRouter, type ActionCtx } from "@freecorps/ember-server";

const email = components.email.lib;
const http = httpRouter();

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function sameSecret(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

const route = (h: (ctx: ActionCtx, request: Request, url: URL) => Promise<Response>) =>
  httpAction(async (ctx, request) => {
    const admin = typeof ctx.env.EMBER_ADMIN_TOKEN === "string" ? ctx.env.EMBER_ADMIN_TOKEN : "";
    const auth = request.headers.get("authorization") ?? "";
    if (!admin || !auth.toLowerCase().startsWith("bearer ") || !sameSecret(auth.slice(7).trim(), admin)) return json({ error: "unauthorized" }, 401);
    try {
      return await h(ctx, request, new URL(request.url));
    } catch (e) {
      const err = e as Error & { code?: string };
      if (err?.code === "NotFound") return json({ error: err.message }, 404);
      if (err?.code === "ValidationError" || err?.code === "RateLimited" || err instanceof SyntaxError) return json({ error: err.message }, err?.code === "RateLimited" ? 429 : 400);
      console.error(`email-lite: ${err?.message ?? String(e)}`);
      return json({ error: "internal error" }, 500);
    }
  });
const body = async (request: Request) => (await request.json()) as Record<string, any>;
const tail = (url: URL, prefix: string) => decodeURIComponent(url.pathname.slice(prefix.length)).split("/").filter(Boolean);
const notFound = () => json({ error: "not found" }, 404);

http.route({ path: "/mailboxes", method: "GET", handler: route(async (ctx) => json(await ctx.runQuery(email.mailboxes, {}))) });
http.route({
  path: "/mailboxes",
  method: "POST",
  handler: route(async (ctx, request) => {
    const b = await body(request);
    return json({ id: await ctx.runMutation(email.upsertMailbox, { name: b.name, address: b.address, ...(b.displayName ? { displayName: b.displayName } : {}), ...(b.autoReply ? { autoReply: b.autoReply } : {}) }) });
  }),
});

http.route({
  path: "/send",
  method: "POST",
  handler: route(async (ctx, request) => {
    const b = await body(request);
    return json(await ctx.runMutation(email.send, { from: b.from, to: b.to, subject: b.subject, ...(b.text ? { text: b.text } : {}), ...(b.html ? { html: b.html } : {}), ...(b.idempotencyKey ? { idempotencyKey: b.idempotencyKey } : {}) }));
  }),
});

http.route({
  pathPrefix: "/emails/",
  method: "GET",
  handler: route(async (ctx, _r, url) => {
    const parts = tail(url, "/emails/");
    if (parts.length !== 1) return notFound();
    const id = parts[0]!;
    const e = await ctx.runQuery(email.get, { id });
    if (!e) return notFound();
    return json({ email: e, events: await ctx.runQuery(email.events, { id }) });
  }),
});

http.route({
  path: "/threads",
  method: "GET",
  handler: route(async (ctx, _r, url) => {
    const mailbox = url.searchParams.get("mailbox");
    if (!mailbox) return json({ error: "mailbox is required" }, 400);
    return json(await ctx.runQuery(email.threads, { mailbox, paginationOpts: { numItems: 50, cursor: null } }));
  }),
});
http.route({
  pathPrefix: "/threads/",
  method: "GET",
  handler: route(async (ctx, _r, url) => {
    const parts = tail(url, "/threads/");
    if (parts.length !== 1) return notFound();
    const t = await ctx.runQuery(email.thread, { threadId: parts[0]! });
    return t ? json(t) : notFound();
  }),
});
http.route({
  pathPrefix: "/threads/",
  method: "POST",
  handler: route(async (ctx, request, url) => {
    const parts = tail(url, "/threads/");
    if (parts.length !== 2 || parts[1] !== "reply") return notFound();
    const b = await body(request);
    return json(await ctx.runMutation(email.reply, { threadId: parts[0]!, text: String(b.text ?? "") }));
  }),
});

export default http;
