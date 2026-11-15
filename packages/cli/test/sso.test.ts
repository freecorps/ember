import { describe, expect, it } from "vitest";
import { authModeOf, workerEntrySource } from "../src/build.ts";
import { projectFrom, validateConfig } from "../src/config.ts";
import { discover } from "../src/modules.ts";
import { parseAuthFrom, resolveAuthFrom, withAuthFrom } from "../src/sso.ts";

const registry = (rows: Record<string, Array<{ env: string; url: string | null }>>) => ({
  exec: async (_sql: string, project: unknown) => rows[String(project)] ?? [],
});

describe("SSO by project name (auth.from)", () => {
  it("parses names and URLs; config validation accepts both", () => {
    expect(parseAuthFrom("https://id.example.com")).toBeNull();
    expect(parseAuthFrom("identity")).toEqual({ project: "identity" });
    expect(parseAuthFrom("identity/prod")).toEqual({ project: "identity", env: "prod" });
    expect(() => parseAuthFrom("Identity Project")).toThrow(/must be an http/);
    const base = { project: "app", compatibilityDate: "2026-10-01", environments: { prod: {} } };
    expect(() => validateConfig({ ...base, auth: { from: "identity/prod" } })).not.toThrow();
    expect(() => validateConfig({ ...base, auth: { from: "not a name" } })).toThrow(/"auth"\.from must be/);
    // URLs as accepted before names were added: trailing slash and a path prefix included.
    for (const from of ["https://id.example.com", "https://id.example.com/", "https://example.com/identity", "http://localhost:8787/"]) {
      expect(() => validateConfig({ ...base, auth: { from } })).not.toThrow();
    }
    expect(() => validateConfig({ ...base, auth: { from: "https://" } })).toThrow(/"auth"\.from must be/);
    expect(() => validateConfig({ ...base, auth: { from: "https://id.example.com/a b" } })).toThrow(/"auth"\.from must be/);
  });

  it("resolves the environment: explicit, same name, prod, only one; refuses ambiguity and missing URLs", async () => {
    const reg = registry({
      identity: [
        { env: "dev", url: "https://ember-identity-dev.x.workers.dev" },
        { env: "prod", url: "https://id.example.com/" },
        { env: "staging", url: null },
      ],
      solo: [{ env: "main", url: "https://solo.example.com" }],
    });
    expect(await resolveAuthFrom(reg, { project: "identity" }, "dev")).toEqual({ project: "identity", env: "dev", url: "https://ember-identity-dev.x.workers.dev" });
    expect(await resolveAuthFrom(reg, { project: "identity" }, "qa")).toMatchObject({ env: "prod", url: "https://id.example.com" });
    expect(await resolveAuthFrom(reg, { project: "solo" }, "prod")).toMatchObject({ env: "main" });
    await expect(resolveAuthFrom(reg, { project: "identity", env: "staging" }, "prod")).rejects.toThrow(/no public URL/);
    await expect(resolveAuthFrom(reg, { project: "identity", env: "x" }, "prod")).rejects.toThrow(/no environment "x"/);
    await expect(resolveAuthFrom(reg, { project: "ghost" }, "prod")).rejects.toThrow(/not in the account registry/);
    const amb = registry({ two: [{ env: "a", url: "https://a" }, { env: "b", url: "https://b" }] });
    await expect(resolveAuthFrom(amb, { project: "two" }, "prod")).rejects.toThrow(/several environments/);
  });

  it("the resolved URL drives the build; an unresolved name fails with a clear message", () => {
    const p = projectFrom("/tmp/app", { project: "app", compatibilityDate: "2026-10-01", environments: { prod: {} }, auth: { from: "identity" } } as any);
    expect(() => authModeOf(p, { authConfig: null }, "prod")).toThrow(/ember deploy` resolves it/);
    const resolved = withAuthFrom(p, "prod", "https://id.example.com");
    expect(authModeOf(resolved, { authConfig: null }, "prod")).toEqual({ kind: "remote", from: "https://id.example.com" });
    expect(p.config.auth?.from).toBe("identity"); // not mutated
  });
});

describe("auth.sessionLookup (remote auth during a migration, L14)", () => {
  const base = { project: "app", compatibilityDate: "2026-10-01", environments: { prod: {} } };
  const lookup = { url: "https://origin.example/ember/session" };

  it("validates url, secretEnv, timeoutMs, cacheMs", () => {
    expect(() => validateConfig({ ...base, auth: { from: "https://origin.example", sessionLookup: lookup } })).not.toThrow();
    expect(() => validateConfig({ ...base, auth: { from: "https://origin.example", sessionLookup: { ...lookup, secretEnv: "LOOKUP_KEY", timeoutMs: 1500, cacheMs: 0 } } })).not.toThrow();
    expect(() => validateConfig({ ...base, auth: { sessionLookup: { url: "http://localhost:3000/s" } } })).not.toThrow();
    expect(() => validateConfig({ ...base, auth: { sessionLookup: { url: "http://origin.example/s" } } })).toThrow(/https URL/);
    expect(() => validateConfig({ ...base, auth: { sessionLookup: "https://origin.example/s" } })).toThrow(/must be an object/);
    expect(() => validateConfig({ ...base, auth: { sessionLookup: { ...lookup, secretEnv: "EMBER_X" } } })).toThrow(/not EMBER_/);
    expect(() => validateConfig({ ...base, auth: { sessionLookup: { ...lookup, timeoutMs: 0 } } })).toThrow(/timeoutMs must be/);
    expect(() => validateConfig({ ...base, auth: { sessionLookup: { ...lookup, cacheMs: 1.5 } } })).toThrow(/cacheMs must be/);
    expect(() => validateConfig({ ...base, auth: { sessionLookup: { ...lookup, secret: "inline" } } })).toThrow(/unknown key secret/);
  });

  it("goes into the generated remoteAuth; refused without auth.from", () => {
    const p = projectFrom("/tmp/app", { ...base, auth: { from: "https://origin.example", sessionLookup: { ...lookup, timeoutMs: 1500 } } } as any);
    const mode = authModeOf(p, { authConfig: null }, "prod");
    expect(mode).toEqual({ kind: "remote", from: "https://origin.example", sessionLookup: { url: lookup.url, timeoutMs: 1500 } });
    const files = { ...discover(new URL("../../../examples/chat/ember", import.meta.url).pathname), authConfig: null };
    const src = workerEntrySource(files, mode);
    expect(src).toContain(`remoteAuth({ from: "https://origin.example", sessionLookup: {"url":"https://origin.example/ember/session","timeoutMs":1500} })`);
    expect(src).toContain("secret SESSION_LOOKUP_SECRET");
    const local = projectFrom("/tmp/app", { ...base, auth: { sessionLookup: lookup } } as any);
    expect(() => authModeOf(local, { authConfig: null }, "prod")).toThrow(/set auth\.from too/);
  });
});
