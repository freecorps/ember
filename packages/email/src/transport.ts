// Outbound transports. The default is Cloudflare Email Service through the Workers `send_email` binding
// (`env.EMAIL.send({ from, to, subject, html, text, ... })` → `{ messageId }`, docs 2026-10). The REST API
// (`POST /accounts/{id}/email/sending/send`) is the same message as JSON, for Workers without the binding. Errors
// carry Cloudflare's code; `isPermanent` decides between failing the email and retrying it.

import type { EmailAddress } from "./address.ts";

export interface OutboundAttachment {
  filename: string;
  contentType: string;
  /** Base64. */
  content: string;
  disposition?: "attachment" | "inline";
  contentId?: string;
}

export interface OutboundMessage {
  from: EmailAddress;
  to: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  replyTo?: EmailAddress;
  subject: string;
  html?: string;
  text?: string;
  headers?: Record<string, string>;
  attachments?: OutboundAttachment[];
}

export interface SendResult {
  /** The provider's id (Email Service `messageId`): delivery events refer to it. */
  messageId: string;
}

export interface Transport {
  send(message: OutboundMessage): Promise<SendResult>;
}

export class TransportError extends Error {
  override name = "TransportError";
  constructor(
    message: string,
    /** Cloudflare's code (`E_RATE_LIMIT_EXCEEDED`, `10004`, ...) or an HTTP status. */
    readonly code: string,
    readonly permanent: boolean,
  ) {
    super(message);
  }
}

/**
 * Email Service error codes that will not succeed on retry. `E_SENDER_DOMAIN_NOT_AVAILABLE` is NOT here: a domain
 * that was just onboarded answers it for a while (measured in the E2E), so it retries with backoff.
 */
const PERMANENT = new Set([
  "E_VALIDATION_ERROR",
  "E_FIELD_MISSING",
  "E_TOO_MANY_RECIPIENTS",
  "E_TOO_MANY_ATTACHMENTS",
  "E_CONTENT_TOO_LARGE",
  "E_SENDER_NOT_VERIFIED",
  "E_RECIPIENT_NOT_ALLOWED",
  "E_RECIPIENT_SUPPRESSED",
  "E_ACCOUNT_SUSPENDED",
  "E_HEADER_NOT_ALLOWED",
  "E_HEADER_USE_API_FIELD",
  "E_HEADER_VALUE_INVALID",
  "E_HEADER_VALUE_TOO_LONG",
  "E_HEADER_NAME_INVALID",
  "E_HEADERS_TOO_LARGE",
  "E_HEADERS_TOO_MANY",
  // REST
  "10001",
  "10101",
  "10102",
  "10105",
  "10200",
  "10202",
  "10203",
  "10207",
]);

export const isPermanentCode = (code: string): boolean => PERMANENT.has(code);

/**
 * Codes that must be retried even when the REST API answers them with a 4xx (which otherwise means permanent):
 * a just-onboarded sending domain answers `E_SENDER_DOMAIN_NOT_AVAILABLE` for a minute or two (E2E).
 */
const TRANSIENT = ["E_SENDER_DOMAIN_NOT_AVAILABLE", "E_RATE_LIMIT_EXCEEDED"];

/** REST: 429/5xx and known-transient codes retry; other 4xx fail. The code may only appear in the message. */
export function isPermanentRest(status: number, code: string, message: string): boolean {
  if (status === 429 || status >= 500) return false;
  if (TRANSIENT.some((t) => code === t || message.includes(t))) return false;
  return isPermanentCode(code) || (status >= 400 && status < 500);
}

const addr = (a: EmailAddress) => (a.name ? { email: a.email, name: a.name } : a.email);

/** The structured message the binding (and, with snake_case, the REST API) takes. */
export function bindingMessage(m: OutboundMessage): Record<string, unknown> {
  return {
    from: addr(m.from),
    to: m.to.length === 1 ? addr(m.to[0]!) : m.to.map(addr),
    ...(m.cc?.length ? { cc: m.cc.map(addr) } : {}),
    ...(m.bcc?.length ? { bcc: m.bcc.map(addr) } : {}),
    ...(m.replyTo ? { replyTo: addr(m.replyTo) } : {}),
    subject: m.subject,
    ...(m.html !== undefined ? { html: m.html } : {}),
    ...(m.text !== undefined ? { text: m.text } : {}),
    ...(m.headers && Object.keys(m.headers).length ? { headers: m.headers } : {}),
    ...(m.attachments?.length
      ? { attachments: m.attachments.map((a) => ({ content: a.content, filename: a.filename, type: a.contentType, disposition: a.disposition ?? "attachment", ...(a.contentId ? { contentId: a.contentId } : {}) })) }
      : {}),
  };
}

type SendEmailBinding = { send(message: unknown): Promise<{ messageId?: string } | undefined | void> };

/** The `send_email` binding (Email Service). */
export function bindingTransport(binding: SendEmailBinding): Transport {
  return {
    async send(m) {
      try {
        const r = await binding.send(bindingMessage(m));
        const id = (r && typeof r === "object" && typeof r.messageId === "string" && r.messageId) || "";
        if (!id) throw new TransportError("send_email returned no messageId", "E_NO_MESSAGE_ID", false);
        return { messageId: id };
      } catch (e) {
        if (e instanceof TransportError) throw e;
        const code = typeof (e as { code?: unknown })?.code === "string" ? (e as { code: string }).code : "E_UNKNOWN";
        throw new TransportError((e as Error)?.message ?? String(e), code, isPermanentCode(code));
      }
    },
  };
}

/** The REST API (`POST /accounts/{id}/email/sending/send`), with an API token. */
export function restTransport(o: { accountId: string; apiToken: string; fetch?: typeof fetch; baseUrl?: string }): Transport {
  const f = o.fetch ?? fetch;
  return {
    async send(m) {
      const b = bindingMessage(m);
      if (b.replyTo) {
        b.reply_to = b.replyTo;
        delete b.replyTo;
      }
      const res = await f(`${o.baseUrl ?? "https://api.cloudflare.com/client/v4"}/accounts/${encodeURIComponent(o.accountId)}/email/sending/send`, {
        method: "POST",
        headers: { authorization: `Bearer ${o.apiToken}`, "content-type": "application/json" },
        body: JSON.stringify(b),
      });
      const body = (await res.json().catch(() => null)) as { success?: boolean; errors?: Array<{ code?: number | string; message?: string }>; result?: Record<string, unknown> } | null;
      if (!res.ok || body?.success !== true) {
        const e = body?.errors?.[0];
        const code = String(e?.code ?? res.status);
        const message = e?.message ?? res.statusText;
        throw new TransportError(`Email Sending ${res.status}: ${message}`, code, isPermanentRest(res.status, code, message));
      }
      const id = (body.result?.message_id ?? body.result?.messageId) as string | undefined;
      if (!id) throw new TransportError("Email Sending returned no message_id", "E_NO_MESSAGE_ID", false);
      return { messageId: id };
    },
  };
}
