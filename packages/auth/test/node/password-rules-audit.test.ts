/**
 * Guard for `PASSWORD_RULES`: scans the installed Better Auth (core and the `@better-auth/*` plugins this package
 * depends on) for HTTP endpoints that hash or verify a password, and fails on one without a rule. Without a rule such
 * an endpoint hashes inside the single `Auth` Durable Object (slow, serializes the whole app) or fails under
 * `strictHashing`, so a Better Auth bump that adds one must not pass silently.
 *
 * What counts as password work in an endpoint's source: `password.hash(` / `password.verify(` /
 * `password.checkPassword(`, `validatePassword(` / `checkPassword(` (Better Auth's helpers), and any function of the
 * same file that does one of those (to a fixed point). Server-only endpoints (`createAuthEndpoint.serverOnly`, or no
 * path) are not routed over HTTP and are skipped.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PASSWORD_RULES } from "../../src/password-rules.ts";

const require = createRequire(import.meta.url);
const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json"), "utf8")) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

/**
 * Endpoints with password work that need no rule, each with why. Empty today: add one only with the reason it is
 * unreachable over HTTP or does its password work some other way.
 */
const ALLOWED_WITHOUT_RULE: Record<string, string> = {};

/** Rules for paths this Better Auth no longer routes (kept for older minors). */
const LEGACY_RULES = new Set(["/two-factor/view-backup-codes"]);

/** The `dist` directory of an installed package (its exports may hide package.json). */
function distOf(name: string): string {
  let dir = dirname(require.resolve(name));
  while (!dir.endsWith(`${sep}dist`) && dirname(dir) !== dir) dir = dirname(dir);
  if (!dir.endsWith(`${sep}dist`)) throw new Error(`no dist directory for ${name}`);
  return dir;
}

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      if (e !== "client" && e !== "test-utils") out.push(...sources(p));
    } else if (/\.m?js$/.test(e) && !/\.d\.m?ts$/.test(e) && !/^client\b/.test(e)) out.push(p);
  }
  return out;
}

const DIRECT = String.raw`\.password\.(?:hash|verify|checkPassword)\(|\bvalidatePassword\(|\bcheckPassword\(`;
const START = /createAuthEndpoint(\.serverOnly)?\(\s*(?:"([^"]+)"|'([^']+)')?/g;
/** A top-level declaration (the bundles are not minified: one declaration per line at column 0). */
const DECL = /^(?:export\s+)?(?:async\s+)?(?:function\s*\*?\s*([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=)/gm;

type Found = { path: string | null; file: string };

/** Endpoints (HTTP path, or null when server-only) whose source does password work. */
function scan(file: string, text: string): { all: string[]; password: Found[] } {
  // Helpers of this file that do password work, to a fixed point.
  const decls = [...text.matchAll(DECL)].map((m, i, all) => ({
    name: (m[1] ?? m[2])!,
    body: text.slice(m.index, all[i + 1]?.index ?? text.length),
  }));
  const helpers = new Set<string>();
  let pattern = new RegExp(DIRECT);
  for (let changed = true; changed; ) {
    changed = false;
    for (const d of decls) {
      if (!helpers.has(d.name) && pattern.test(d.body) && !/createAuthEndpoint/.test(d.body)) {
        helpers.add(d.name);
        changed = true;
      }
    }
    pattern = new RegExp([DIRECT, ...[...helpers].map((h) => String.raw`\b${h.replace(/\$/g, "\\$")}\(`)].join("|"));
  }
  const starts = [...text.matchAll(START)];
  const all: string[] = [];
  const password: Found[] = [];
  starts.forEach((m, i) => {
    const serverOnly = m[1] !== undefined;
    const path = serverOnly ? null : (m[2] ?? m[3] ?? null);
    if (path) all.push(path);
    const body = text.slice(m.index, starts[i + 1]?.index ?? text.length);
    if (pattern.test(body)) password.push({ path, file });
  });
  return { all, password };
}

const packages = ["better-auth", ...Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((n) => n.startsWith("@better-auth/") && n !== "@better-auth/utils" && n !== "@better-auth/test-utils")];
const results = packages.flatMap((name) => sources(distOf(name)).map((file) => scan(file, readFileSync(file, "utf8"))));
const endpoints = new Set(results.flatMap((r) => r.all));
const withPassword = results.flatMap((r) => r.password);

describe("PASSWORD_RULES covers every Better Auth endpoint that hashes or verifies a password", () => {
  it("the scan sees the endpoints it must (sanity)", () => {
    const paths = withPassword.map((f) => f.path);
    for (const p of ["/sign-up/email", "/sign-in/email", "/change-password", "/sign-in/username", "/sign-in/phone-number", "/two-factor/enable", "/admin/create-user"]) {
      expect(paths).toContain(p);
    }
  });

  it("every HTTP endpoint with password work has a rule (or a reasoned exception)", () => {
    const missing = withPassword
      .filter((f) => f.path !== null && !Object.hasOwn(PASSWORD_RULES, f.path) && !Object.hasOwn(ALLOWED_WITHOUT_RULE, f.path))
      .map((f) => `${f.path} (${f.file.split(`${sep}node_modules${sep}`).pop()})`);
    expect(missing, "add these to PASSWORD_RULES (src/password-rules.ts) or, if unreachable over HTTP, to ALLOWED_WITHOUT_RULE with why").toEqual([]);
  });

  it("every rule names an endpoint Better Auth routes (no typo), legacy ones aside", () => {
    const unknown = Object.keys(PASSWORD_RULES).filter((p) => !endpoints.has(p) && !LEGACY_RULES.has(p));
    expect(unknown).toEqual([]);
  });
});
