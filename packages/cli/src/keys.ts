// `ember keys rotate` (PLAN §9, §7): rotate the JWT signing key, the files URL signing secret and the auth secret
// of a deployed environment.
//
// Worker secrets are write-only, so a rotation never reads a value back: secrets rotate by *generation*. `<NAME>` is
// generation 0 and `<NAME>_R<n>` generation n; the runtime signs with the highest generation and verifies with every
// one still bound. A rotation uploads generation n+1 and deletes the generations older than n (the previous one keeps
// verifying what was signed before — download URLs live ≤ TTL + 5 min, cookies until the next rotation).
//
//   --jwt          new JWT signing key (Auth DO); old keys stay in /api/auth/jwks for Better Auth's grace period (30 d),
//                  so tokens already issued (5 min TTL) keep verifying; EMBER_AUTH_JWKS is refreshed. No sign-out.
//   --files        new EMBER_STORAGE_SECRET generation (proxy-mode download URLs). No downtime.
//   --auth-secret  new EMBER_AUTH_SECRET generation + a JWT key minted under it. Signs everybody out of cookie
//                  sessions (they are signed with the old secret); generation 0 stays bound as Better Auth's legacy
//                  key, used only to decrypt key material encrypted before the first rotation. Needs --yes.

import { randomBytes } from "node:crypto";
import type { CfClient } from "./deploy/cf.ts";

export type RotateKind = "jwt" | "files" | "auth-secret";

export interface RotateOptions {
  client: CfClient;
  worker: string;
  /** Deployment base URL. */
  url: string;
  adminToken: string;
  kinds: RotateKind[];
  yes?: boolean;
  fetch?: typeof fetch;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

const GEN = (name: string) => new RegExp(`^${name}(?:_R(\\d+))?$`);

/** Generations of `name` bound to the Worker: `[{ name, gen }]`, oldest first. */
export function generations(secretNames: string[], name: string): Array<{ name: string; gen: number }> {
  const re = GEN(name);
  return secretNames
    .map((n) => [n, re.exec(n)] as const)
    .filter(([, m]) => m)
    .map(([n, m]) => ({ name: n, gen: m![1] === undefined ? 0 : Number(m![1]) }))
    .sort((a, b) => a.gen - b.gen);
}

/** The new generation's name and the old ones to delete afterwards (keeps current + new; `keep0` keeps generation 0). */
export function planRotation(secretNames: string[], name: string, keep0 = false): { next: string; remove: string[] } {
  const gens = generations(secretNames, name);
  const current = gens.length ? gens[gens.length - 1]!.gen : -1;
  return {
    next: `${name}_R${current + 1}`,
    remove: gens.filter((g) => g.gen < current && !(keep0 && g.gen === 0)).map((g) => g.name),
  };
}

async function secretNames(client: CfClient, worker: string): Promise<string[]> {
  return ((await client.call<Array<{ name: string }>>("GET", `/workers/scripts/${worker}/secrets`)) ?? []).map((s) => s.name);
}

async function putSecret(client: CfClient, worker: string, name: string, text: string) {
  await client.call("PUT", `/workers/scripts/${worker}/secrets`, { name, text, type: "secret_text" });
}

export interface RotateResult {
  jwt?: { kids: string[]; jwksSecret: boolean };
  files?: { added: string; removed: string[] };
  authSecret?: { added: string; removed: string[] };
}

export async function rotateKeys(o: RotateOptions): Promise<RotateResult> {
  const log = o.log ?? ((l: string) => console.log(l));
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const f = o.fetch ?? fetch;
  const out: RotateResult = {};
  const kinds = new Set(o.kinds.length ? o.kinds : (["jwt"] as RotateKind[]));
  if (kinds.has("auth-secret") && !o.yes) {
    throw new Error("--auth-secret signs every user out of cookie sessions (they are signed with the old secret); pass --yes to proceed");
  }
  let names = await secretNames(o.client, o.worker);

  const rotateJwt = async () => {
    // The Worker may still be rolling out a secret change: retry until the admin endpoint answers.
    let body: { ok?: boolean; kids?: string[]; error?: { code: string; message: string } } = {};
    for (let i = 0; i < 20; i++) {
      const r = await f(new URL("/api/_ember/keys/rotate", o.url), { method: "POST", headers: { authorization: `Bearer ${o.adminToken}` } });
      body = (await r.json().catch(() => ({}))) as typeof body;
      if (r.ok && body.ok) break;
      if (r.status === 404 || r.status === 401 || r.status === 403) throw new Error(`keys rotate: ${body.error?.code ?? r.status}: ${body.error?.message ?? ""}`);
      await sleep(1500);
    }
    if (!body.ok) throw new Error(`keys rotate: ${body.error?.code ?? "failed"}: ${body.error?.message ?? ""}`);
    log(`  jwt: new signing key; published kids: ${body.kids!.join(", ")}`);
    // The Worker verifies first with the JWKS embedded at deploy: refresh it so the new kid needs no DO round trip.
    let jwksSecret = false;
    if (names.includes("EMBER_AUTH_JWKS")) {
      const r = await f(new URL("/api/auth/jwks", o.url), { headers: { accept: "application/json" } });
      // The key is already rotated: say why the embedded JWKS could not be refreshed (re-run deploy to refresh it).
      if (!r.ok) throw new Error(`keys rotate: the new key is live but GET /api/auth/jwks failed (HTTP ${r.status}): EMBER_AUTH_JWKS not refreshed`);
      const jwks = (await r.json()) as { keys?: unknown[] };
      if (!Array.isArray(jwks.keys) || !jwks.keys.length) throw new Error("keys rotate: /api/auth/jwks returned no keys");
      await putSecret(o.client, o.worker, "EMBER_AUTH_JWKS", JSON.stringify(jwks));
      jwksSecret = true;
      log(`  jwt: EMBER_AUTH_JWKS refreshed (${jwks.keys.length} keys)`);
    }
    out.jwt = { kids: body.kids!, jwksSecret };
  };

  if (kinds.has("files")) {
    const plan = planRotation(names, "EMBER_STORAGE_SECRET");
    await putSecret(o.client, o.worker, plan.next, randomBytes(32).toString("base64url"));
    for (const n of plan.remove) await o.client.call("DELETE", `/workers/scripts/${o.worker}/secrets/${n}`);
    out.files = { added: plan.next, removed: plan.remove };
    log(`  files: ${plan.next} signs from now on${plan.remove.length ? `; removed ${plan.remove.join(", ")}` : ""} (the previous generation keeps verifying until the next rotation)`);
    names = await secretNames(o.client, o.worker);
  }
  if (kinds.has("auth-secret")) {
    if (!names.includes("EMBER_AUTH_SECRET")) throw new Error("--auth-secret: this Worker has no EMBER_AUTH_SECRET (no local Auth DO)");
    const plan = planRotation(names, "EMBER_AUTH_SECRET", true);
    await putSecret(o.client, o.worker, plan.next, randomBytes(32).toString("base64url"));
    for (const n of plan.remove) await o.client.call("DELETE", `/workers/scripts/${o.worker}/secrets/${n}`);
    out.authSecret = { added: plan.next, removed: plan.remove };
    log(`  auth-secret: ${plan.next} signs from now on${plan.remove.length ? `; removed ${plan.remove.join(", ")}` : ""}; cookie sessions signed before are invalid`);
    names = await secretNames(o.client, o.worker);
    // Let the new version (with the new secret) take traffic before minting the key that must be encrypted with it.
    await sleep(8000);
    // A JWT key encrypted with the new secret (the old ones are retired, still published for verification).
    kinds.add("jwt");
  }
  if (kinds.has("jwt")) await rotateJwt();
  return out;
}
