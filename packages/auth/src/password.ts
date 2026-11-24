/**
 * Worker-side password hashing (PLAN §9, §20 R7).
 *
 * scrypt costs ~36 ms locally / ~96 ms in production. Running it inside the single `Auth` DO caps
 * the whole app at ~10 sign-ups/s, and Better Auth hashes inside `runWithTransaction` (sign-up),
 * so a call-back hasher (RpcTarget) would hold a storage transaction open across an RPC. Instead:
 *
 * 1. The Worker reads the JSON body of password-bearing endpoints (`PASSWORD_RULES`).
 * 2. New passwords (`hash` fields) are hashed in the Worker.
 * 3. Passwords to check (`verify` field) are verified in the Worker against the stored hash,
 *    fetched with one cheap internal RPC (`Auth.credentialHash`, a SQL read by email, username, phone number or
 *    session). If no hash exists the Worker hashes the password anyway, so Better Auth's anti-enumeration dummy hash
 *    is free and an unknown user costs the same as a known one.
 * 4. The request is forwarded unchanged to the DO over RPC together with a `PasswordPlan`
 *    (`{ hashes, verdicts }`). The DO's `password.hash/verify` hooks answer from the plan with no
 *    CPU work. A verdict only applies to the exact (hash, password) pair it was computed for, so
 *    it can never vouch for a different account.
 *
 * Plans only travel over Worker→DO RPC (never HTTP), so clients cannot forge them. Endpoints not
 * in the table fall back to hashing in the DO (counted in `stats().localHashes`), or fail when
 * `strictHashing` is on.
 */
import { hashPassword, verifyPassword } from "better-auth/crypto";
import type { PasswordHooks } from "./options.ts";

export type PasswordPlan = {
  /** plaintext → hash computed in the Worker. */
  hashes: [password: string, hash: string][];
  /** (stored hash, candidate password) → result computed in the Worker. */
  verdicts: { hash: string; password: string; ok: boolean }[];
};

/**
 * What `Auth.credentialHash` looks the stored hash up by. `username` and `phoneNumber` are newer than the others: an
 * `Auth` object from before them (only during a deploy) reads such a lookup as a session lookup with no headers and
 * answers null, so the Worker hashes and the DO verifies locally (or fails under `strictHashing`).
 */
export type CredentialLookup = { email: string } | { username: string } | { phoneNumber: string } | { headers: [string, string][] };

export { assertPasswordRules, CREDENTIAL_KEYS, PASSWORD_RULES, type CredentialKey, type PasswordRule } from "./password-rules.ts";
import { PASSWORD_RULES, type PasswordRule } from "./password-rules.ts";

/** The lookup for a `verify` rule, from the body (or the request's headers), or null when the body has no key. */
function lookupOf(v: NonNullable<PasswordRule["verify"]>, body: Record<string, unknown>, request: Request): CredentialLookup | null {
  if (v.by === "session") return { headers: [...request.headers.entries()] };
  const key = body[v.keyField ?? v.by];
  if (typeof key !== "string" || key.length === 0 || key.length > 1024) return null;
  return v.by === "email" ? { email: key } : v.by === "username" ? { username: key } : { phoneNumber: key };
}

export const defaultHasher: PasswordHooks = {
  hash: (password) => hashPassword(password),
  verify: ({ hash, password }) => verifyPassword({ hash, password }),
};

export const emptyPlan = (): PasswordPlan => ({ hashes: [], verdicts: [] });

/**
 * Build the plan for a request in the Worker. Returns the (re-readable) request to forward and the
 * plan, or `plan: undefined` when the endpoint needs no password work.
 */
export async function preparePasswordPlan(
  request: Request,
  route: string,
  hasher: PasswordHooks,
  lookup: (by: CredentialLookup) => Promise<string | null>,
  rules: Record<string, PasswordRule> = PASSWORD_RULES,
): Promise<{ request: Request; plan: PasswordPlan | undefined }> {
  const rule = rules[route];
  if (!rule || request.method !== "POST") return { request, plan: undefined };
  if (!(request.headers.get("content-type") ?? "").includes("application/json")) return { request, plan: undefined };
  const text = await request.text();
  const forward = new Request(request, { body: text });
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object") return { request: forward, plan: undefined };
    body = parsed as Record<string, unknown>;
  } catch {
    return { request: forward, plan: undefined };
  }
  const plan = emptyPlan();
  const jobs: Promise<void>[] = [];
  for (const field of rule.hash ?? []) {
    const pw = body[field];
    if (typeof pw === "string" && pw.length > 0 && pw.length <= 1024) {
      jobs.push(hasher.hash(pw).then((h) => void plan.hashes.push([pw, h])));
    }
  }
  const v = rule.verify;
  const candidate = v ? body[v.field] : undefined;
  if (v && typeof candidate === "string" && candidate.length <= 1024) {
    jobs.push(
      (async () => {
        const key = lookupOf(v, body, request);
        const stored = key ? await lookup(key) : null;
        if (stored) {
          plan.verdicts.push({ hash: stored, password: candidate, ok: await hasher.verify({ hash: stored, password: candidate }) });
        } else if (candidate.length > 0) {
          // Better Auth hashes the candidate to equalize timing when the user is unknown.
          plan.hashes.push([candidate, await hasher.hash(candidate)]);
        }
      })(),
    );
  }
  await Promise.all(jobs);
  return { request: forward, plan };
}

/** Thrown in the DO when `strictHashing` is on and a hash/verify was not precomputed. */
export class LocalHashError extends Error {
  constructor(what: string) {
    super(`auth: ${what} was not precomputed by the Worker and strictHashing is on`);
    this.name = "LocalHashError";
  }
}
