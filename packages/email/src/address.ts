// Addresses, plus-addressing and subjects. Pure functions (no Cloudflare APIs): used in mutations, actions and the
// mail app's HTTP API.

export type EmailAddress = { email: string; name?: string };

const BARE = /^[^\s<>@",;:()[\]\\]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

/** Is `s` a bare `local@domain.tld` address (no display name)? Deliberately strict: rejects header injection. */
export function isEmail(s: unknown): s is string {
  return typeof s === "string" && s.length <= 254 && BARE.test(s);
}

/**
 * `"Name" <a@b.c>`, `Name <a@b.c>`, `a@b.c` or `{ email, name }` → `{ email, name? }`. Parsed by position (a long
 * hostile display name must not make a regex backtrack). Throws on anything else.
 */
export function parseAddress(input: string | EmailAddress): EmailAddress {
  if (typeof input === "object" && input !== null) {
    if (!isEmail(input.email)) throw new Error(`Invalid email address ${JSON.stringify(input.email)}`);
    const name = cleanName(input.name);
    return name ? { email: input.email.toLowerCase(), name } : { email: input.email.toLowerCase() };
  }
  if (typeof input !== "string") throw new Error("Invalid email address");
  const s = input.trim();
  const open = s.lastIndexOf("<");
  if (open >= 0 && s.endsWith(">")) {
    const email = s.slice(open + 1, -1).trim();
    if (!isEmail(email)) throw new Error(`Invalid email address ${JSON.stringify(input)}`);
    const name = cleanName(s.slice(0, open));
    return name ? { email: email.toLowerCase(), name } : { email: email.toLowerCase() };
  }
  if (!isEmail(s)) throw new Error(`Invalid email address ${JSON.stringify(input)}`);
  return { email: s.toLowerCase() };
}

function cleanName(n: string | undefined): string | undefined {
  if (n === undefined) return undefined;
  let x = n.trim();
  if (x.startsWith('"') && x.endsWith('"') && x.length >= 2) x = x.slice(1, -1);
  x = x.replace(/[\r\n<>"]/g, "").trim();
  return x ? x.slice(0, 200) : undefined;
}

/** `{ email, name }` → `"Name" <email>` (or the bare address). */
export function formatAddress(a: EmailAddress): string {
  return a.name ? `"${a.name.replace(/["\\]/g, "")}" <${a.email}>` : a.email;
}

/** A list of `string | {email,name}` (or one) → parsed addresses, duplicates removed. */
export function parseAddressList(x: string | EmailAddress | ReadonlyArray<string | EmailAddress> | undefined): EmailAddress[] {
  if (x === undefined) return [];
  const arr = Array.isArray(x) ? x : [x];
  const seen = new Set<string>();
  const out: EmailAddress[] = [];
  for (const a of arr) {
    const p = parseAddress(a as string | EmailAddress);
    if (seen.has(p.email)) continue;
    seen.add(p.email);
    out.push(p);
  }
  return out;
}

export const domainOf = (email: string): string => email.slice(email.lastIndexOf("@") + 1).toLowerCase();

/**
 * Splits plus-addressing: `support+t_abc123@x.com` → `{ base: "support@x.com", tag: "t_abc123" }`. Email Routing
 * hands the Worker the envelope `to` with the `+detail` kept (the zone needs subaddressing on to route it).
 */
export function splitPlus(email: string): { base: string; tag: string | null } {
  const at = email.lastIndexOf("@");
  const local = email.slice(0, at);
  const plus = local.indexOf("+");
  if (plus < 0) return { base: email.toLowerCase(), tag: null };
  return { base: `${local.slice(0, plus)}${email.slice(at)}`.toLowerCase(), tag: local.slice(plus + 1) || null };
}

/** `support@x.com` + tag → `support+tag@x.com`. */
export function withPlus(email: string, tag: string): string {
  const at = email.lastIndexOf("@");
  return `${email.slice(0, at)}+${tag}${email.slice(at)}`;
}

/** "Re: Fwd: [#12] Hello" → "hello": the key used to match a reply to its thread by subject. */
export function subjectKey(subject: string | undefined): string {
  let s = (subject ?? "").trim();
  for (;;) {
    const next = s.replace(/^\s*((re|fw|fwd|aw|wg|sv|vs|res|enc|tr)\s*(\[\d+\])?\s*:\s*|\[#\d+\]\s*)/i, "");
    if (next === s) break;
    s = next;
  }
  return s.replace(/\s+/g, " ").trim().toLowerCase().slice(0, 300);
}

/** "Hello" → "Re: Hello" (once). */
export function replySubject(subject: string): string {
  return /^\s*re\s*:/i.test(subject) ? subject : `Re: ${subject}`;
}

/** A `Message-ID` value without the angle brackets, lowercased (header lookups). */
export function normalizeMessageId(id: string | undefined | null): string | null {
  if (!id) return null;
  const m = /<([^<>]+)>/.exec(id);
  const v = (m ? m[1]! : id).trim();
  return v ? v.toLowerCase() : null;
}

/** All Message-IDs in a `References` / `In-Reply-To` header value. */
export function messageIdList(h: string | undefined | null): string[] {
  if (!h) return [];
  const out: string[] = [];
  for (const m of h.matchAll(/<([^<>]+)>/g)) out.push(m[1]!.trim().toLowerCase());
  if (!out.length) for (const t of h.split(/\s+/)) if (t.includes("@")) out.push(t.toLowerCase());
  return out;
}

/** Addresses that must never get an automatic reply. */
export function isNoReplySender(email: string): boolean {
  const local = email.slice(0, email.lastIndexOf("@")).toLowerCase();
  return /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounces?|notifications?)([+.-]|$)/.test(local);
}
