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
 *    fetched with one cheap internal RPC (`Auth.credentialHash`, a SQL read). If no hash exists
 *    the Worker hashes the password anyway so Better Auth's anti-enumeration dummy hash is free.
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

export type CredentialLookup = { email: string } | { headers: [string, string][] };

export type PasswordRule = {
  /** Body fields holding new passwords (hashed in the Worker). */
  hash?: string[];
  /** Body field holding a password to verify, and how to find the stored hash. */
  verify?: { field: string; by: "email" | "session" };
};

/** Better Auth 1.7 endpoints (relative to basePath) that hash or verify passwords. */
export const PASSWORD_RULES: Record<string, PasswordRule> = {
  "/sign-up/email": { hash: ["password"] },
  "/sign-in/email": { verify: { field: "password", by: "email" } },
  "/change-password": { hash: ["newPassword"], verify: { field: "currentPassword", by: "session" } },
  "/reset-password": { hash: ["newPassword"] },
  "/delete-user": { verify: { field: "password", by: "session" } },
  "/two-factor/enable": { verify: { field: "password", by: "session" } },
  "/two-factor/disable": { verify: { field: "password", by: "session" } },
  "/two-factor/get-totp-uri": { verify: { field: "password", by: "session" } },
  "/two-factor/generate-backup-codes": { verify: { field: "password", by: "session" } },
  "/two-factor/view-backup-codes": { verify: { field: "password", by: "session" } },
  "/email-otp/reset-password": { hash: ["password"] },
  "/phone-number/reset-password": { hash: ["newPassword"] },
  "/admin/create-user": { hash: ["password"] },
  "/admin/set-user-password": { hash: ["newPassword"] },
};

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
        let key: CredentialLookup | null = null;
        if (v.by === "email") {
          if (typeof body.email === "string") key = { email: body.email };
        } else {
          key = { headers: [...request.headers.entries()] };
        }
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
