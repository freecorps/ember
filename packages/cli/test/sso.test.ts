import { describe, expect, it } from "vitest";
import { authModeOf } from "../src/build.ts";
import { projectFrom, validateConfig } from "../src/config.ts";
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
