// Client for the Ember mail service (apps/mail), in the shape of Resend's SDK: every call resolves to
// `{ data, error }` (never throws for API errors), so code written for Resend ports by changing the import and the
// base URL.
//
//   import { EmberMail } from "@freecorps/ember-mail-sdk";
//   const mail = new EmberMail(process.env.MAIL_API_KEY!, { baseUrl: "https://mail.example.com" });
//   const { data, error } = await mail.emails.send({ from: "Acme <hi@acme.com>", to: "ana@example.com", subject: "Hi", html: "<p>Hi</p>" });

export type Address = string;

export interface Attachment {
  filename: string;
  /** Base64, or bytes (encoded by the SDK). */
  content: string | Uint8Array;
  content_type?: string;
  /** Set to reference it inline (`<img src="cid:...">`). */
  content_id?: string;
}

export interface CreateEmailOptions {
  from: Address;
  to: Address | Address[];
  subject?: string;
  html?: string;
  text?: string;
  cc?: Address | Address[];
  bcc?: Address | Address[];
  reply_to?: Address | Address[];
  /** Resend's camelCase alias. */
  replyTo?: Address | Address[];
  headers?: Record<string, string>;
  attachments?: Attachment[];
  tags?: Array<{ name: string; value: string }>;
  /** ISO 8601 date (or a Date). */
  scheduled_at?: string | Date;
  scheduledAt?: string | Date;
  /** A stored template and its data (`templates.create`). */
  template?: { name: string; data?: Record<string, unknown> };
}

export interface RequestOptions {
  /** Sent as `Idempotency-Key`: retrying with the same key returns the first email. */
  idempotencyKey?: string;
}

export type EmailStatus =
  | "scheduled"
  | "queued"
  | "sending"
  | "sent"
  | "delivery_delayed"
  | "delivered"
  | "bounced"
  | "complained"
  | "failed"
  | "canceled"
  | "suppressed";

export interface Email {
  object: "email";
  id: string;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  reply_to: string[] | null;
  subject: string;
  html: string | null;
  text: string | null;
  created_at: string;
  scheduled_at: string | null;
  last_event: EmailStatus;
  /** The provider's message id (Email Service), once sent. */
  message_id: string | null;
  tags: Array<{ name: string; value: string }>;
  error?: { code: string; message: string };
}

export interface DnsRecord {
  record: "Sending" | "Receiving";
  type: string;
  name: string;
  value: string;
  ttl: string;
  priority?: number;
}

export interface Domain {
  object: "domain";
  id: string;
  name: string;
  status: "not_started" | "pending" | "verified" | "failed";
  created_at: string;
  capabilities: { sending: "enabled" | "disabled"; receiving: "enabled" | "disabled" };
  records: DnsRecord[];
  routing_status: string | null;
  notes: string[];
}

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  permission: "full_access" | "sending_access" | "inbox";
  project: string;
  created_at: string;
}

export interface Thread {
  _id: string;
  mailbox: string;
  number: number;
  subject: string;
  contact: string;
  contactName?: string;
  status: "open" | "waiting" | "closed" | "spam";
  messageCount: number;
  unreadCount: number;
  lastMessageAt: number;
  snippet: string;
}

export interface ErrorResponse {
  statusCode: number;
  name: string;
  message: string;
}

export type Result<T> = { data: T; error: null } | { data: null; error: ErrorResponse };

export interface EmberMailOptions {
  /** The mail Worker's URL (e.g. https://ember-mail-prod.<you>.workers.dev or your custom domain). */
  baseUrl: string;
  fetch?: typeof fetch;
  /** Extra headers on every request. */
  headers?: Record<string, string>;
}

function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function emailBody(o: CreateEmailOptions): Record<string, unknown> {
  const { replyTo, scheduledAt, attachments, scheduled_at, ...rest } = o;
  const when = scheduled_at ?? scheduledAt;
  return {
    ...rest,
    ...(rest.reply_to === undefined && replyTo !== undefined ? { reply_to: replyTo } : {}),
    ...(when !== undefined ? { scheduled_at: when instanceof Date ? when.toISOString() : when } : {}),
    ...(attachments ? { attachments: attachments.map((a) => ({ ...a, content: typeof a.content === "string" ? a.content : b64(a.content) })) } : {}),
  };
}

export class EmberMail {
  private readonly base: string;
  private readonly f: typeof fetch;

  constructor(
    private readonly key: string,
    private readonly opts: EmberMailOptions,
  ) {
    if (!key) throw new Error("EmberMail: missing API key");
    if (!opts?.baseUrl) throw new Error("EmberMail: missing baseUrl");
    this.base = opts.baseUrl.replace(/\/+$/, "");
    this.f = opts.fetch ?? ((...a) => fetch(...a));
  }

  /** Low-level request: `{ data, error }`. */
  async request<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Result<T>> {
    let res: Response;
    try {
      res = await this.f(`${this.base}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.key}`, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...this.opts.headers, ...headers },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (e) {
      return { data: null, error: { statusCode: 0, name: "network_error", message: (e as Error).message } };
    }
    const json = (await res.json().catch(() => null)) as unknown;
    if (!res.ok) {
      const e = (json ?? {}) as Partial<ErrorResponse>;
      return { data: null, error: { statusCode: e.statusCode ?? res.status, name: e.name ?? "application_error", message: e.message ?? res.statusText } };
    }
    return { data: json as T, error: null };
  }

  readonly emails = {
    send: (o: CreateEmailOptions, r: RequestOptions = {}) => this.request<{ id: string }>("POST", "/emails", emailBody(o), r.idempotencyKey ? { "idempotency-key": r.idempotencyKey } : {}),
    /** Resend's alias. */
    create: (o: CreateEmailOptions, r: RequestOptions = {}) => this.emails.send(o, r),
    get: (id: string) => this.request<Email>("GET", `/emails/${encodeURIComponent(id)}`),
    cancel: (id: string) => this.request<{ object: "email"; id: string }>("POST", `/emails/${encodeURIComponent(id)}/cancel`),
    /** Delivery events received for the email (Email Service via the events queue). */
    events: (id: string) =>
      this.request<{ data: Array<{ id: string; type: string; recipient: string | null; at: string; received_at: string; terminal: boolean; reason: string | null; bounce_type: string | null; smtp_status: string | null; duplicates: number }> }>("GET", `/emails/${encodeURIComponent(id)}/events`),
  };

  readonly batch = {
    send: (list: CreateEmailOptions[], r: RequestOptions = {}) => this.request<{ data: Array<{ id: string }> }>("POST", "/emails/batch", list.map(emailBody), r.idempotencyKey ? { "idempotency-key": r.idempotencyKey } : {}),
    create: (list: CreateEmailOptions[], r: RequestOptions = {}) => this.batch.send(list, r),
  };

  readonly domains = {
    create: (o: { name: string; sending?: boolean; receiving?: boolean; enable_routing?: boolean }) => this.request<Domain>("POST", "/domains", o),
    list: () => this.request<{ data: Domain[] }>("GET", "/domains"),
    get: (id: string) => this.request<Domain>("GET", `/domains/${encodeURIComponent(id)}`),
    verify: (id: string, o: { enable_routing?: boolean } = {}) => this.request<Domain>("POST", `/domains/${encodeURIComponent(id)}/verify`, o),
    remove: (id: string) => this.request<{ object: "domain"; id: string; deleted: true }>("DELETE", `/domains/${encodeURIComponent(id)}`),
  };

  readonly apiKeys = {
    create: (o: { name: string; permission?: ApiKey["permission"]; project?: string; domain?: string }) => this.request<{ id: string; token: string }>("POST", "/api-keys", o),
    list: () => this.request<{ data: ApiKey[] }>("GET", "/api-keys"),
    remove: (id: string) => this.request<{ deleted: true }>("DELETE", `/api-keys/${encodeURIComponent(id)}`),
  };

  readonly templates = {
    create: (o: { name: string; subject: string; html: string; text?: string; layout?: { brand?: string; color?: string; footer?: string; preheader?: string } }) =>
      this.request<{ object: "template"; id: string; name: string }>("POST", "/templates", o),
    list: () => this.request<{ data: Array<{ name: string; subject: string; html: string; text?: string }> }>("GET", "/templates"),
    remove: (name: string) => this.request<{ deleted: boolean }>("DELETE", `/templates/${encodeURIComponent(name)}`),
  };

  readonly suppressions = {
    add: (email: string, reason?: string) => this.request<{ id: string }>("POST", "/suppressions", { email, ...(reason ? { reason } : {}) }),
    remove: (email: string) => this.request<{ deleted: boolean }>("DELETE", `/suppressions/${encodeURIComponent(email)}`),
  };

  readonly inbox = {
    mailboxes: () => this.request<{ data: Array<{ name: string; address: string; display_name: string | null; unread: number; threads: number }> }>("GET", "/inbox/mailboxes"),
    upsertMailbox: (o: { name: string; address: string; display_name?: string | null; auto_reply?: { subject: string; text: string; html?: string } | null }) => this.request<{ id: string }>("POST", "/inbox/mailboxes", o),
    threads: (o: { mailbox: string; status?: Thread["status"]; cursor?: string; limit?: number }) => {
      const q = new URLSearchParams({ mailbox: o.mailbox, ...(o.status ? { status: o.status } : {}), ...(o.cursor ? { cursor: o.cursor } : {}), ...(o.limit ? { limit: String(o.limit) } : {}) });
      return this.request<{ page: Thread[]; isDone: boolean; continueCursor: string }>("GET", `/inbox/threads?${q}`);
    },
    thread: (id: string) => this.request<{ thread: Thread; messages: Array<Record<string, unknown>> }>("GET", `/inbox/threads/${encodeURIComponent(id)}`),
    reply: (id: string, text: string, author?: string) => this.request<{ emailId: string; messageId: string; status: string }>("POST", `/inbox/threads/${encodeURIComponent(id)}/reply`, { text, ...(author ? { author } : {}) }),
    setStatus: (id: string, status: Thread["status"]) => this.request<{ status: string }>("POST", `/inbox/threads/${encodeURIComponent(id)}/status`, { status }),
    markRead: (id: string) => this.request<{ ok: boolean }>("POST", `/inbox/threads/${encodeURIComponent(id)}/read`, {}),
    search: (q: string, mailbox?: string) => this.request<{ data: Array<{ threadId: string; subject: string; snippet: string; mailbox: string }> }>("GET", `/inbox/search?${new URLSearchParams({ q, ...(mailbox ? { mailbox } : {}) })}`),
    addMember: (o: { user_id: string; mailboxes?: string[]; name?: string | null; admin?: boolean }) => this.request<{ id: string }>("POST", "/inbox/members", o),
  };
}

export default EmberMail;
