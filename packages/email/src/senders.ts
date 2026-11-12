// Sender rules: block (reject), file as spam, or allow a sender's address or domain. Pure functions (no Cloudflare
// APIs): the component's screening and the apps that show or edit the rules use the same normalization.

import { isEmail, splitPlus } from "./address.ts";

/** What a rule does to inbound mail from a matching sender. */
export const SENDER_ACTIONS = ["reject", "spam", "allow"] as const;
export type SenderAction = (typeof SENDER_ACTIONS)[number];

export type SenderPattern = { pattern: string; kind: "address" | "domain" };

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Is `s` a hostname with at least two labels (`acme.com`, `mail.acme.com`; not `com`)? */
export function isDomain(s: string): boolean {
  if (s.length > 253) return false;
  const labels = s.split(".");
  return labels.length >= 2 && labels.every((l) => LABEL.test(l)) && !/^\d+$/.test(labels[labels.length - 1]!);
}

/**
 * A rule's pattern from what a person typed: an address (`ana@acme.com`; a `+tag` is kept, so the rule matches only
 * that tagged address) or a domain (`acme.com`, also written `@acme.com`, `*.acme.com` or `*@acme.com`). Lowercased.
 * Throws on anything else.
 */
export function senderPattern(input: string): SenderPattern {
  let s = String(input ?? "").trim().toLowerCase();
  if (s.startsWith("<") && s.endsWith(">")) s = s.slice(1, -1).trim();
  if (s.startsWith("*@")) s = s.slice(2);
  else if (s.startsWith("@")) s = s.slice(1);
  else if (s.startsWith("*.")) s = s.slice(2);
  if (s.includes("@")) {
    if (!isEmail(s)) throw new Error(`not an address or domain: ${JSON.stringify(input)}`);
    return { pattern: s, kind: "address" };
  }
  if (s.endsWith(".")) s = s.slice(0, -1);
  if (!isDomain(s)) throw new Error(`not an address or domain: ${JSON.stringify(input)}`);
  return { pattern: s, kind: "domain" };
}

/**
 * The patterns that match `email`, most specific first: the address, the address without its `+tag`, then its
 * domain and each parent domain down to two labels (`ana@mail.acme.com` → `mail.acme.com`, `acme.com`). A domain
 * rule covers its subdomains.
 */
export function senderCandidates(email: string): string[] {
  const e = email.trim().toLowerCase();
  if (!isEmail(e)) return [];
  const out = [e];
  const base = splitPlus(e).base;
  if (base !== e) out.push(base);
  const labels = e.slice(e.lastIndexOf("@") + 1).split(".");
  for (let i = 0; i <= labels.length - 2; i++) out.push(labels.slice(i).join("."));
  return out;
}
