// Where the CLI may send a credential (the admin token, a user's bearer token, a Convex deploy key): https always,
// plain http only to this machine (`ember dev` binds 127.0.0.1). Anything else is refused before a request is made,
// so a typo'd or copied `--url http://...` never puts the token on the network in clear text (CWE-319).
//
// Opt-out for a dev runtime on another machine of a trusted LAN: EMBER_ALLOW_INSECURE_HTTP=1 (one warning per origin).

export const INSECURE_HTTP_ENV = "EMBER_ALLOW_INSECURE_HTTP";

/** `localhost`, 127.0.0.0/8 and `::1` (also as an IPv4-mapped address): what never leaves this machine. */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (h === "localhost") return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
  if (h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
  // WHATWG URL normalizes `[::ffff:127.0.0.1]` to `[::ffff:7f00:1]`.
  return /^::ffff:(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|7f[0-9a-f]{2}:[0-9a-f]{1,4})$/.test(h);
}

const warned = new Set<string>();

export interface CredentialUrlOptions {
  /** What is being sent, for the messages (default "the admin token"). */
  what?: string;
  /** Default: `process.env`. */
  env?: Record<string, string | undefined>;
  /** Default: stderr. */
  warn?: (line: string) => void;
}

/**
 * Checks a base URL the CLI is about to send a credential to, and returns it parsed. Throws for a non-http(s) URL and
 * for `http://` to a host other than loopback unless EMBER_ALLOW_INSECURE_HTTP=1 is set (then warns once per origin).
 */
export function checkCredentialUrl(url: string | URL, opts: CredentialUrlOptions = {}): URL {
  const what = opts.what ?? "the admin token";
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`"${String(url)}" is not a valid URL (expected https://...)`);
  }
  if (u.protocol === "https:") return u;
  if (u.protocol !== "http:") throw new Error(`Refusing to send ${what} to ${u.origin || String(url)}: only https:// URLs (http:// only for localhost)`);
  if (isLoopbackHost(u.hostname)) return u;
  const env = opts.env ?? process.env;
  const optOut = env[INSECURE_HTTP_ENV];
  if (optOut === "1" || optOut === "true") {
    if (!warned.has(u.origin)) {
      warned.add(u.origin);
      (opts.warn ?? ((l: string) => console.error(l)))(`warning: sending ${what} to ${u.origin} over plain http (${INSECURE_HTTP_ENV} is set): anyone on the network path can read it`);
    }
    return u;
  }
  throw new Error(
    `Refusing to send ${what} over plain http to ${u.origin}: anyone on the network path could read it. ` +
      `Use the deployment's https:// URL (http:// is accepted only for localhost, 127.0.0.1 and [::1], where \`ember dev\` runs). ` +
      `For a dev runtime on another machine of a network you trust, set ${INSECURE_HTTP_ENV}=1.`,
  );
}
