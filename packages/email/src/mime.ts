// Inbound MIME (Email Routing → the Worker's email() handler): postal-mime parses the raw RFC 5322 message (it is
// dependency-free, streams, and is what the Cloudflare docs use in Workers). Authentication results come from the
// header Cloudflare's MX adds (`Authentication-Results: mx.cloudflare.net; dkim=…; dmarc=…; spf=…`): only the
// first such header is trusted, and only when its authserv-id is mx.cloudflare.net (the sender can add others).

import PostalMime, { type Address, type Email } from "postal-mime";
import { messageIdList, normalizeMessageId, type EmailAddress } from "./address.ts";
import { htmlToText } from "./template.ts";

export type AuthResult = "pass" | "fail" | "none" | "neutral" | "softfail" | "temperror" | "permerror" | "unknown";
export type AuthResults = { spf: AuthResult; dkim: AuthResult; dmarc: AuthResult };

export interface InboundAttachment {
  filename: string;
  contentType: string;
  content: Uint8Array;
  contentId?: string;
  inline: boolean;
}

export interface ParsedInbound {
  /** Message-ID without brackets, lowercased (null when the sender gave none). */
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  from: EmailAddress | null;
  replyTo: EmailAddress | null;
  to: EmailAddress[];
  cc: EmailAddress[];
  subject: string;
  date: number | null;
  text: string;
  html: string | null;
  truncated: boolean;
  attachments: InboundAttachment[];
  /** Attachments over `maxAttachments` (counted, not kept). */
  droppedAttachments: number;
  /** `Auto-Submitted` other than "no", or `Precedence: bulk|junk|list|auto_reply`, or a mailer-daemon sender. */
  autoSubmitted: boolean;
  auth: AuthResults;
}

export interface ParseLimits {
  maxText?: number;
  maxHtml?: number;
  maxAttachments?: number;
}

const flat = (list: Address[] | undefined): EmailAddress[] => {
  const out: EmailAddress[] = [];
  for (const a of list ?? []) {
    for (const m of a.group ?? [a]) {
      if (!m.address) continue;
      out.push(m.name ? { email: m.address.toLowerCase(), name: m.name } : { email: m.address.toLowerCase() });
    }
  }
  return out;
};

// A method result starts a token (after `;` or whitespace), never a property: Cloudflare writes
// `dmarc=pass header.from=example.com policy.dmarc=reject`, and `policy.dmarc=reject` is not the DMARC result.
const RESULT = /(?:^|[;\s])(spf|dkim|dmarc)\s*=\s*([a-z]+)/gi;
const RESULTS: readonly string[] = ["pass", "fail", "none", "neutral", "softfail", "temperror", "permerror"];

/**
 * Reads Cloudflare's `Authentication-Results` (first header, authserv-id mx.cloudflare.net). Comments in
 * parentheses are ignored. Cloudflare reports several results per method (two DKIM signatures; SPF for the HELO and
 * for MAIL FROM): for dkim and spf any `pass` wins; otherwise the last result counts.
 */
export function authResultsFrom(headers: ReadonlyArray<{ key: string; value: string }>): AuthResults {
  const out: AuthResults = { spf: "unknown", dkim: "unknown", dmarc: "unknown" };
  const first = headers.find((h) => h.key.toLowerCase() === "authentication-results");
  if (!first) return out;
  const authserv = first.value.split(";")[0]!.trim().toLowerCase();
  if (authserv !== "mx.cloudflare.net") return out;
  const value = first.value.slice(first.value.indexOf(";") + 1).replace(/\([^()]*\)/g, " ");
  for (const m of value.matchAll(RESULT)) {
    const k = m[1]!.toLowerCase() as keyof AuthResults;
    if (k !== "dmarc" && out[k] === "pass") continue; // several signatures / identities: any pass wins
    const v = m[2]!.toLowerCase();
    out[k] = (RESULTS.includes(v) ? v : "unknown") as AuthResult;
  }
  return out;
}

function isAutoSubmitted(email: Email, from: EmailAddress | null): boolean {
  const h = (k: string) => email.headers.find((x) => x.key === k)?.value?.toLowerCase().trim();
  const auto = h("auto-submitted");
  if (auto && auto !== "no") return true;
  const prec = h("precedence");
  if (prec && /^(bulk|junk|list|auto_reply)$/.test(prec)) return true;
  if (h("x-autoreply") || h("x-autorespond") || h("list-id")) return true;
  if (from && /^(mailer-daemon|postmaster)@/i.test(from.email)) return true;
  return false;
}

/** Parses a raw message. Bodies are capped (`truncated`), attachments over the cap are only counted. */
export async function parseInbound(raw: Uint8Array | ArrayBuffer | string, limits: ParseLimits = {}): Promise<ParsedInbound> {
  const maxText = limits.maxText ?? 100_000;
  const maxHtml = limits.maxHtml ?? 300_000;
  const maxAtt = limits.maxAttachments ?? 50;
  const email = await PostalMime.parse(raw, { attachmentEncoding: "arraybuffer" });
  const from = flat(email.from ? [email.from] : undefined)[0] ?? null;
  const html = email.html ?? null;
  let text = email.text ?? (html ? htmlToText(html) : "");
  let truncated = false;
  if (text.length > maxText) {
    text = text.slice(0, maxText);
    truncated = true;
  }
  let keptHtml = html;
  if (keptHtml && keptHtml.length > maxHtml) {
    keptHtml = null; // never store a cut HTML document (broken markup); the text part stays
    truncated = true;
  }
  const attachments: InboundAttachment[] = [];
  for (const a of email.attachments.slice(0, maxAtt)) {
    const content = typeof a.content === "string" ? new TextEncoder().encode(a.content) : a.content instanceof Uint8Array ? a.content : new Uint8Array(a.content);
    attachments.push({
      filename: (a.filename ?? "attachment").replace(/[\r\n/\\]/g, "_").slice(0, 200) || "attachment",
      contentType: a.mimeType || "application/octet-stream",
      content,
      ...(a.contentId ? { contentId: a.contentId.replace(/^<|>$/g, "") } : {}),
      inline: a.disposition === "inline" || !!a.related,
    });
  }
  const date = email.date ? Date.parse(email.date) : NaN;
  return {
    messageId: normalizeMessageId(email.messageId),
    inReplyTo: normalizeMessageId(email.inReplyTo),
    references: messageIdList(email.references),
    from,
    replyTo: flat(email.replyTo)[0] ?? null,
    to: flat(email.to),
    cc: flat(email.cc),
    subject: (email.subject ?? "").replace(/[\r\n]+/g, " ").slice(0, 998),
    date: Number.isFinite(date) ? date : null,
    text,
    html: keptHtml,
    truncated,
    attachments,
    droppedAttachments: Math.max(0, email.attachments.length - maxAtt),
    autoSubmitted: isAutoSubmitted(email, from),
    auth: authResultsFrom(email.headers),
  };
}

/** First characters of a body, one line (thread lists, push notifications). */
export function snippetOf(text: string, n = 160): string {
  const s = text.replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
