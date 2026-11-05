// Resend-compatible-ish HTTP API (same paths and shapes where they overlap, so Resend's DX carries over):
//
//   POST   /emails                 { from, to, subject, html?, text?, cc?, bcc?, reply_to?, headers?, attachments?,
//                                     tags?, scheduled_at?, template?: { name, data } }   Idempotency-Key header
//   POST   /emails/batch           [ ...same ]
//   GET    /emails/:id             POST /emails/:id/cancel
//   GET    /domains                POST /domains { name, receiving?, sending? }
//   GET    /domains/:id            POST /domains/:id/verify { enable_routing? }   DELETE /domains/:id
//   POST   /domains/import         POST /domains/:id/forget (record only; for scripts/domains.ts)
//   GET    /api-keys               POST /api-keys { name, permission?, project?, domain? }   DELETE /api-keys/:id
//   GET    /templates              POST /templates { name, subject, html, text?, layout? }   DELETE /templates/:name
//   POST   /suppressions { email } DELETE /suppressions/:email
//   GET    /inbox/mailboxes        POST /inbox/mailboxes { name, address, display_name?, auto_reply? }
//   GET    /inbox/threads?mailbox=&status=&cursor=   GET /inbox/threads/:id   POST /inbox/threads/:id/reply { text }
//   GET    /inbox/search?q=&mailbox=                  POST /inbox/members { user_id, mailboxes, admin? }
//
// Auth: `Authorization: Bearer em_...` (API keys, hashed at rest) or the Worker's EMBER_ADMIN_TOKEN (bootstrap).
import { anyComponents as components, httpActionGeneric as httpAction, httpRouter, type ActionCtx } from "@freecorps/ember-server";
import { parseAddress, domainOf, type SendInput } from "@freecorps/ember-email";
import { isDomainName } from "../src/onboard.ts";
import { ApiError, authenticate, body, errorResponse, iso, json, need, newToken, parseWhen, sha256Hex, type Principal } from "../src/api.ts";

const email = components.email.lib;
const http = httpRouter();

type Handler = (ctx: ActionCtx, request: Request, p: Principal, url: URL) => Promise<Response>;
const route = (h: Handler) =>
  httpAction(async (ctx, request) => {
    try {
      const p = await authenticate(request, ctx.env, (hash) => ctx.runQuery("keys:byHash" as any, { hash }) as Promise<any>);
      return await h(ctx, request, p, new URL(request.url));
    } catch (e) {
      return errorResponse(e);
    }
  });
/** `?limit=`: absent → `fallback`; a positive integer, capped at 100; anything else is a 422 (never NaN downstream). */
const pageLimit = (url: URL, fallback: number) => {
  const raw = url.searchParams.get("limit");
  if (raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new ApiError(422, "validation_error", "limit must be a positive integer");
  return Math.min(100, n);
};
const tail = (url: URL, prefix: string) => decodeURIComponent(url.pathname.slice(prefix.length)).split("/").filter(Boolean);

// ------------------------------------------------------------------------------------------------ emails

type ResendEmail = {
  from: string;
  to: string | string[];
  subject?: string;
  html?: string;
  text?: string;
  cc?: string | string[];
  bcc?: string | string[];
  reply_to?: string | string[];
  headers?: Record<string, string>;
  attachments?: Array<{ filename: string; content?: string; content_type?: string; content_id?: string }>;
  tags?: Array<{ name: string; value: string }>;
  scheduled_at?: string | number;
  template?: { name?: string; id?: string; data?: unknown; variables?: unknown };
};

async function toSendInput(ctx: ActionCtx, p: Principal, e: ResendEmail, key?: string): Promise<SendInput> {
  if (!e || typeof e !== "object") throw new ApiError(422, "validation_error", "each email must be an object");
  if (typeof e.from !== "string" && typeof e.from !== "object") throw new ApiError(422, "missing_required_field", "from is required");
  if (!e.to) throw new ApiError(422, "missing_required_field", "to is required");
  const fromDomain = domainOf(parseAddress(e.from as string).email);
  if (p.domain && fromDomain !== p.domain) throw new ApiError(403, "invalid_from_address", `This API key can only send from ${p.domain}`);
  const d = (await ctx.runQuery("domains:get" as any, { name: fromDomain })) as { sending: boolean; status: string } | null;
  if (!d || !d.sending || d.status === "failed") throw new ApiError(403, "invalid_from_address", `The ${fromDomain} domain is not set up for sending (POST /domains)`);
  const attachments: NonNullable<SendInput["attachments"]> = [];
  for (const a of e.attachments ?? []) {
    if (!a?.filename || typeof a.content !== "string") throw new ApiError(422, "validation_error", "attachments need filename and base64 content");
    let bytes: Uint8Array;
    try {
      bytes = Uint8Array.from(atob(a.content), (c) => c.charCodeAt(0));
    } catch {
      throw new ApiError(422, "validation_error", `attachment ${a.filename}: content must be base64`);
    }
    const contentType = a.content_type ?? "application/octet-stream";
    const file = await ctx.storage.store(bytes, { contentType });
    attachments.push({ filename: a.filename, contentType, file, ...(a.content_id ? { contentId: a.content_id, inline: true } : {}) });
  }
  const replyTo = Array.isArray(e.reply_to) ? e.reply_to[0] : e.reply_to;
  const sendAt = parseWhen(e.scheduled_at);
  const tpl = e.template ? { name: e.template.name ?? e.template.id ?? "", data: e.template.data ?? e.template.variables ?? {} } : undefined;
  return {
    project: p.project,
    from: e.from,
    to: e.to,
    ...(e.cc ? { cc: e.cc } : {}),
    ...(e.bcc ? { bcc: e.bcc } : {}),
    ...(replyTo ? { replyTo } : {}),
    ...(e.subject !== undefined ? { subject: e.subject } : {}),
    ...(e.html !== undefined ? { html: e.html } : {}),
    ...(e.text !== undefined ? { text: e.text } : {}),
    ...(e.headers ? { headers: e.headers } : {}),
    ...(attachments.length ? { attachments } : {}),
    ...(e.tags?.length ? { tags: Object.fromEntries(e.tags.map((t) => [t.name, t.value])) } : {}),
    ...(sendAt ? { sendAt } : {}),
    ...(tpl ? { template: tpl } : {}),
    ...(key ? { idempotencyKey: key } : {}),
  };
}

const idemKey = (request: Request) => {
  const k = request.headers.get("idempotency-key");
  if (k !== null && (!k || k.length > 256)) throw new ApiError(422, "invalid_idempotency_key", "Idempotency-Key must be 1-256 characters");
  return k ?? undefined;
};

http.route({
  path: "/emails",
  method: "POST",
  handler: route(async (ctx, request, p) => {
    need(p, "sending_access");
    const input = await toSendInput(ctx, p, await body<ResendEmail>(request), idemKey(request));
    const r = (await ctx.runMutation(email.send, input)) as { id: string; duplicate?: true };
    return json({ id: r.id }, 200, r.duplicate ? { "idempotent-replayed": "true" } : {});
  }),
});

http.route({
  path: "/emails/batch",
  method: "POST",
  handler: route(async (ctx, request, p) => {
    need(p, "sending_access");
    const list = await body<ResendEmail[]>(request);
    if (!Array.isArray(list) || !list.length || list.length > 100) throw new ApiError(422, "validation_error", "the body must be an array of 1 to 100 emails");
    const key = idemKey(request);
    const inputs = [];
    for (const [i, e] of list.entries()) inputs.push(await toSendInput(ctx, p, e, key ? `${key}#${i}` : undefined));
    const r = (await ctx.runMutation(email.sendBatch, { emails: inputs })) as Array<{ id: string }>;
    return json({ data: r.map((x) => ({ id: x.id })) });
  }),
});

const emailView = (e: any) => ({
  object: "email",
  id: e._id,
  to: e.to.map((a: any) => a.email),
  from: e.from.name ? `${e.from.name} <${e.from.email}>` : e.from.email,
  created_at: iso(e._creationTime),
  subject: e.subject,
  html: e.html ?? null,
  text: e.text ?? null,
  cc: (e.cc ?? []).map((a: any) => a.email),
  bcc: (e.bcc ?? []).map((a: any) => a.email),
  reply_to: e.replyTo ? [e.replyTo.email] : null,
  last_event: e.status,
  /** Email Service's message id (what delivery events refer to). */
  message_id: e.messageId ?? null,
  scheduled_at: e.status === "scheduled" ? iso(e.sendAt) : null,
  tags: e.tags ? Object.entries(e.tags).map(([name, value]) => ({ name, value })) : [],
  ...(e.error ? { error: e.error } : {}),
});

http.route({
  pathPrefix: "/emails/",
  method: "GET",
  handler: route(async (ctx, _request, p, url) => {
    need(p, "sending_access");
    const [id, sub] = tail(url, "/emails/");
    const e = id ? ((await ctx.runQuery(email.get, { id })) as any) : null;
    if (!e || (e.project !== p.project && p.permission !== "full_access")) throw new ApiError(404, "not_found", "Email not found");
    if (sub === "events") {
      const evs = (await ctx.runQuery(email.events, { id: e._id })) as any[];
      return json({ data: evs.map((x) => ({ id: x.eventId, type: x.type, recipient: x.recipient ?? null, at: iso(x.at), received_at: iso(x.receivedAt), terminal: x.terminal, reason: x.reason ?? null, bounce_type: x.bounceType ?? null, smtp_status: x.smtpStatus ?? null, duplicates: x.duplicates ?? 0 })) });
    }
    if (sub) throw new ApiError(404, "not_found", "Not found");
    return json(emailView(e));
  }),
});

http.route({
  pathPrefix: "/emails/",
  method: "POST",
  handler: route(async (ctx, _request, p, url) => {
    need(p, "sending_access");
    const [id, action] = tail(url, "/emails/");
    if (action !== "cancel" || !id) throw new ApiError(404, "not_found", "Not found");
    const e = (await ctx.runQuery(email.get, { id })) as any;
    if (!e || (e.project !== p.project && p.permission !== "full_access")) throw new ApiError(404, "not_found", "Email not found");
    const r = (await ctx.runMutation(email.cancel, { id: e._id })) as { ok: boolean; status: string };
    if (!r.ok) throw new ApiError(422, "validation_error", `Email is ${r.status} and cannot be canceled`);
    return json({ object: "email", id: e._id });
  }),
});

// ------------------------------------------------------------------------------------------------ domains

const domainView = (d: any) => ({
  object: "domain",
  id: d._id,
  name: d.name,
  status: d.status,
  created_at: iso(d.createdAt),
  capabilities: { sending: d.sending ? "enabled" : "disabled", receiving: d.receiving ? "enabled" : "disabled" },
  records: d.records.map((r: any) => ({ record: r.purpose === "receiving" ? "Receiving" : "Sending", type: r.type, name: r.name, value: r.value, ttl: r.ttl === 1 || !r.ttl ? "Auto" : String(r.ttl), ...(r.priority !== undefined ? { priority: r.priority } : {}) })),
  routing_status: d.routingStatus ?? null,
  /** What onboarding created in Cloudflare (ids only): removed with the domain. */
  cloudflare: { zone_id: d.zoneId ?? null, sending_tag: d.sendingTag ?? null, rule_ids: d.ruleIds, subscription_id: d.subscriptionId ?? null, created_sending: !!d.createdSending },
  notes: d.notes,
});

http.route({
  path: "/domains",
  method: "GET",
  handler: route(async (ctx, _r, p) => {
    need(p);
    return json({ data: ((await ctx.runQuery("domains:list" as any, {})) as any[]).map(domainView) });
  }),
});
http.route({
  path: "/domains",
  method: "POST",
  handler: route(async (ctx, request, p) => {
    need(p);
    const b = await body<{ name?: string; sending?: boolean; receiving?: boolean; enable_routing?: boolean }>(request);
    if (typeof b.name !== "string") throw new ApiError(422, "missing_required_field", "name is required");
    // Checked here: an error thrown inside the domains:sync action reaches us as an ActionCallError (no status).
    if (!isDomainName(b.name.toLowerCase())) throw new ApiError(422, "validation_error", `Invalid domain name ${JSON.stringify(b.name)}`);
    await ctx.runAction("domains:sync" as any, { name: b.name, ...(b.sending !== undefined ? { sending: b.sending } : {}), ...(b.receiving !== undefined ? { receiving: b.receiving } : {}), ...(b.enable_routing ? { enableRouting: true } : {}) });
    return json(domainView(await ctx.runQuery("domains:get" as any, { name: b.name.toLowerCase() })), 201);
  }),
});
/** Records a domain onboarded from the operator's machine (scripts/domains.ts): the Worker holds no CF token. */
http.route({
  path: "/domains/import",
  method: "POST",
  handler: route(async (ctx, request, p) => {
    need(p);
    const d = await body<Record<string, unknown>>(request);
    if (typeof d.name !== "string" || !isDomainName(d.name)) throw new ApiError(422, "validation_error", `Invalid domain name ${JSON.stringify(d.name)}`);
    await ctx.runMutation("domains:save" as any, d);
    return json(domainView(await ctx.runQuery("domains:get" as any, { name: String(d.name) })), 201);
  }),
});
const domainById = async (ctx: ActionCtx, id: string | undefined) => {
  const d = id ? ((await ctx.runQuery("domains:getById" as any, { id })) as any) : null;
  if (!d) throw new ApiError(404, "not_found", "Domain not found");
  return d;
};
http.route({
  pathPrefix: "/domains/",
  method: "GET",
  handler: route(async (ctx, _r, p, url) => {
    need(p);
    return json(domainView(await domainById(ctx, tail(url, "/domains/")[0])));
  }),
});
http.route({
  pathPrefix: "/domains/",
  method: "POST",
  handler: route(async (ctx, request, p, url) => {
    need(p);
    const [id, action] = tail(url, "/domains/");
    if (action === "forget") {
      // Record only: the operator already deleted the Cloudflare side (scripts/domains.ts remove). DELETE does both.
      const d = await domainById(ctx, id);
      await ctx.runMutation("domains:remove" as any, { name: d.name });
      return json({ object: "domain", id: d._id, deleted: true });
    }
    if (action !== "verify") throw new ApiError(404, "not_found", "Not found");
    const d = await domainById(ctx, id);
    const b = request.headers.get("content-type")?.includes("json") ? await body<{ enable_routing?: boolean }>(request).catch(() => ({}) as { enable_routing?: boolean }) : {};
    await ctx.runAction("domains:sync" as any, { name: d.name, ...(b.enable_routing ? { enableRouting: true } : {}) });
    return json(domainView(await ctx.runQuery("domains:get" as any, { name: d.name })));
  }),
});
http.route({
  pathPrefix: "/domains/",
  method: "DELETE",
  handler: route(async (ctx, _r, p, url) => {
    need(p);
    const d = await domainById(ctx, tail(url, "/domains/")[0]);
    const r = (await ctx.runAction("domains:destroy" as any, { name: d.name })) as { deleted: boolean; errors: string[] };
    if (!r.deleted) throw new ApiError(502, "application_error", r.errors.join("; "));
    return json({ object: "domain", id: d._id, deleted: true });
  }),
});

// ------------------------------------------------------------------------------------------------ api keys

http.route({
  path: "/api-keys",
  method: "POST",
  handler: route(async (ctx, request, p) => {
    need(p);
    const b = await body<{ name?: string; permission?: string; project?: string; domain_id?: string; domain?: string }>(request);
    if (!b.name) throw new ApiError(422, "missing_required_field", "name is required");
    const { token, prefix } = newToken();
    const id = await ctx.runMutation("keys:insert" as any, {
      name: b.name,
      prefix,
      hash: await sha256Hex(token),
      permission: b.permission ?? "full_access",
      project: b.project ?? p.project,
      ...(b.domain ? { domain: b.domain.toLowerCase() } : {}),
    });
    return json({ id, token }, 201);
  }),
});
http.route({ path: "/api-keys", method: "GET", handler: route(async (ctx, _r, p) => (need(p), json({ data: await ctx.runQuery("keys:list" as any, {}) }))) });
http.route({
  pathPrefix: "/api-keys/",
  method: "DELETE",
  handler: route(async (ctx, _r, p, url) => {
    need(p);
    const ok = await ctx.runMutation("keys:revoke" as any, { id: tail(url, "/api-keys/")[0] ?? "" });
    if (!ok) throw new ApiError(404, "not_found", "API key not found");
    return json({ deleted: true });
  }),
});

// ------------------------------------------------------------------------------------------------ templates & suppressions

http.route({
  path: "/templates",
  method: "POST",
  handler: route(async (ctx, request, p) => {
    need(p);
    const b = await body<{ name: string; subject: string; html: string; text?: string; layout?: unknown }>(request);
    const id = await ctx.runMutation(email.upsertTemplate, { project: p.project, name: b.name, subject: b.subject, html: b.html, ...(b.text ? { text: b.text } : {}), ...(b.layout ? { layout: b.layout } : {}) });
    return json({ object: "template", id, name: b.name }, 201);
  }),
});
http.route({ path: "/templates", method: "GET", handler: route(async (ctx, _r, p) => (need(p, "sending_access"), json({ data: await ctx.runQuery(email.templates, { project: p.project }) }))) });
http.route({
  pathPrefix: "/templates/",
  method: "DELETE",
  handler: route(async (ctx, _r, p, url) => (need(p), json({ deleted: await ctx.runMutation(email.removeTemplate, { project: p.project, name: tail(url, "/templates/")[0] ?? "" }) }))),
});
http.route({
  path: "/suppressions",
  method: "POST",
  handler: route(async (ctx, request, p) => {
    need(p, "sending_access");
    const b = await body<{ email: string; reason?: string }>(request);
    return json({ id: await ctx.runMutation(email.suppress, { project: p.project, email: b.email, reason: b.reason ?? "manual" }) }, 201);
  }),
});
http.route({
  pathPrefix: "/suppressions/",
  method: "DELETE",
  handler: route(async (ctx, _r, p, url) => (need(p, "sending_access"), json({ deleted: await ctx.runMutation(email.unsuppress, { project: p.project, email: tail(url, "/suppressions/")[0] ?? "" }) }))),
});

// ------------------------------------------------------------------------------------------------ inbox (dashboard, scripts)

http.route({ path: "/inbox/mailboxes", method: "GET", handler: route(async (ctx, _r, p) => { need(p, "inbox"); const boxes = (await ctx.runQuery(email.mailboxes, {})) as any[]; const unread = await ctx.runQuery(email.unread, {}); return json({ data: boxes.map((b) => ({ name: b.name, address: b.address, display_name: b.displayName ?? null, ...(unread as any)[b.name] })) }); }) });
http.route({
  path: "/inbox/mailboxes",
  method: "POST",
  handler: route(async (ctx, request, p) => {
    need(p);
    const b = await body<{ name: string; address: string; display_name?: string | null; auto_reply?: { subject: string; text: string; html?: string } | null }>(request);
    // Absent fields keep their stored value; null (or "" for display_name) clears them.
    const id = await ctx.runMutation(email.upsertMailbox, { name: b.name, address: b.address, ...(b.display_name !== undefined ? { displayName: b.display_name || null } : {}), ...(b.auto_reply !== undefined ? { autoReply: b.auto_reply } : {}) });
    return json({ id }, 201);
  }),
});
http.route({
  path: "/inbox/threads",
  method: "GET",
  handler: route(async (ctx, _r, p, url) => {
    need(p, "inbox");
    const mailbox = url.searchParams.get("mailbox");
    if (!mailbox) throw new ApiError(422, "missing_required_field", "mailbox is required");
    const status = url.searchParams.get("status");
    const r = await ctx.runQuery(email.threads, { mailbox, ...(status ? { status } : {}), paginationOpts: { numItems: pageLimit(url, 30), cursor: url.searchParams.get("cursor") } });
    return json(r);
  }),
});
http.route({
  pathPrefix: "/inbox/threads/",
  method: "GET",
  handler: route(async (ctx, _r, p, url) => {
    need(p, "inbox");
    const t = await ctx.runQuery(email.thread, { threadId: tail(url, "/inbox/threads/")[0] ?? "" });
    if (!t) throw new ApiError(404, "not_found", "Thread not found");
    return json(t);
  }),
});
http.route({
  pathPrefix: "/inbox/threads/",
  method: "POST",
  handler: route(async (ctx, request, p, url) => {
    need(p, "inbox");
    const [id, action] = tail(url, "/inbox/threads/");
    const b = await body<{ text?: string; status?: string; author?: string }>(request);
    if (action === "reply") return json(await ctx.runMutation(email.reply, { threadId: id ?? "", text: b.text ?? "", ...(b.author ? { author: b.author } : {}) }), 201);
    if (action === "status") return json({ status: await ctx.runMutation(email.setStatus, { threadId: id ?? "", status: b.status ?? "" }) });
    if (action === "read") return json({ ok: await ctx.runMutation(email.markRead, { threadId: id ?? "" }) });
    throw new ApiError(404, "not_found", "Not found");
  }),
});
http.route({
  path: "/inbox/search",
  method: "GET",
  handler: route(async (ctx, _r, p, url) => {
    need(p, "inbox");
    const mailbox = url.searchParams.get("mailbox");
    return json({ data: await ctx.runQuery(email.search, { query: url.searchParams.get("q") ?? "", ...(mailbox ? { mailbox } : {}) }) });
  }),
});
http.route({
  path: "/inbox/members",
  method: "POST",
  handler: route(async (ctx, request, p) => {
    need(p);
    const b = await body<{ user_id?: string; name?: string | null; mailboxes?: string[]; admin?: boolean }>(request);
    if (typeof b.user_id !== "string" || !b.user_id) throw new ApiError(422, "missing_required_field", "user_id is required");
    if (b.mailboxes !== undefined && (!Array.isArray(b.mailboxes) || b.mailboxes.some((m) => typeof m !== "string"))) throw new ApiError(422, "validation_error", "mailboxes must be an array of names");
    if (b.admin !== undefined && typeof b.admin !== "boolean") throw new ApiError(422, "validation_error", "admin must be a boolean");
    // Patch: only the fields sent change (admin: false revokes; name: null clears).
    return json({ id: await ctx.runMutation("admin:upsertMember" as any, { userId: b.user_id, ...(b.mailboxes !== undefined ? { mailboxes: b.mailboxes } : {}), ...(b.name !== undefined ? { name: b.name || null } : {}), ...(b.admin !== undefined ? { admin: b.admin } : {}) }) }, 201);
  }),
});

export default http;
