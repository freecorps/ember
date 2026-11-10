// `ember env` (PLAN §13): .dev.vars parsing, .gitignore, secrets/vars against a fake Workers API, and `ember dev`
// end to end in Miniflare: .dev.vars values reach the Worker, Turnstile (auth.turnstile) uses TURNSTILE_SECRET_KEY
// from there, and `--reveal` reads a secret through the admin endpoint.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildWorker, runtimeVersion } from "../src/build.ts";
import { codegen } from "../src/codegen/index.ts";
import { loadProject, validateConfig, type Project } from "../src/config.ts";
import { CfClient } from "../src/deploy/cf.ts";
import { checkEnvArgs, ensureGitignore, envGet, envList, envRm, envSet, loadDevVars, parseDevVars, type EnvTarget } from "../src/env.ts";
import { main } from "../src/main.ts";
import { init } from "../src/init.ts";
import { startLocal } from "../src/local.ts";
import { cleanup, sampleProject, TMP } from "./helpers.ts";

const RUNTIME_VERSION = (JSON.parse(readFileSync(new URL("../../runtime/package.json", import.meta.url), "utf8")) as { version: string }).version;

describe("runtimeVersion", () => {
  it("the first @freecorps/ember-runtime up from the project, then up from the CLI; null when none", () => {
    // Outside the repository: nothing installed above it.
    const root = mkdtempSync(join(tmpdir(), "ember-rtv-"));
    try {
      const app = join(root, "apps", "web");
      mkdirSync(app, { recursive: true });
      // Nothing installed above the project or the (fake) CLI root.
      expect(runtimeVersion(app, app)).toBeNull();
      // A package of another name, or an unreadable package.json, is skipped.
      const fake = join(root, "apps", "node_modules", "@freecorps", "ember-runtime");
      mkdirSync(fake, { recursive: true });
      writeFileSync(join(fake, "package.json"), "{ not json");
      expect(runtimeVersion(app, app)).toBeNull();
      writeFileSync(join(fake, "package.json"), JSON.stringify({ name: "other", version: "1.0.0" }));
      expect(runtimeVersion(app, app)).toBeNull();
      writeFileSync(join(fake, "package.json"), JSON.stringify({ name: "@freecorps/ember-runtime", version: "9.9.9" }));
      expect(runtimeVersion(app, app)).toBe("9.9.9");
      // Without a copy near the project, the CLI's own.
      expect(runtimeVersion(join(root, "elsewhere"))).toBe(RUNTIME_VERSION);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe(".dev.vars", () => {
  it("parses dotenv syntax: export, comments, quotes, escapes, multi-line", () => {
    const vars = parseDevVars(
      [
        "# local secrets",
        "A=1",
        "export B = two words  # trailing comment",
        'C="line1\\nline2 \\"q\\" # not a comment"',
        "D='raw \\n # kept'",
        'E="multi',
        'line"',
        "EMPTY=",
        "URL=https://x.test/a#frag",
      ].join("\n"),
    );
    expect(vars).toEqual({ A: "1", B: "two words", C: 'line1\nline2 "q" # not a comment', D: "raw \\n # kept", E: "multi\nline", EMPTY: "", URL: "https://x.test/a#frag" });
    expect(() => parseDevVars("NOPE")).toThrow(/:1: expected KEY=value/);
    expect(() => parseDevVars('X="open\nmore')).toThrow(/:1: unterminated " quote/);
    expect(() => parseDevVars('X="a" b')).toThrow(/after the closing quote/);
  });

  it("init gitignores .ember/ and .dev.vars*, idempotently; EMBER_* names in .dev.vars are ignored", () => {
    const p = sampleProject("envgit");
    try {
      const gi = readFileSync(join(p.root, ".gitignore"), "utf8");
      expect(gi).toContain(".ember/\n");
      expect(gi).toContain(".dev.vars*\n");
      expect(ensureGitignore(p.root)).toBe(false);
      writeFileSync(join(p.root, ".gitignore"), "node_modules\n");
      expect(ensureGitignore(p.root)).toBe(true);
      expect(readFileSync(join(p.root, ".gitignore"), "utf8")).toMatch(/^node_modules\n\n# ember: .*\n\.ember\/\n\.dev\.vars\*\n$/);
      writeFileSync(join(p.root, ".dev.vars"), "EMBER_AUTH_SECRET=x\nOK=1\n");
      const d = loadDevVars(p);
      expect(d.vars).toEqual({ OK: "1" });
      expect(d.warnings.join("\n")).toMatch(/EMBER_AUTH_SECRET ignored/);
    } finally {
      cleanup(p);
    }
  });
});

describe("ember.json auth.turnstile", () => {
  const base = { project: "chat", compatibilityDate: "2026-10-01", environments: { prod: {} } };
  it("accepts true/false/{endpoints, expectedAction, allowedHostnames}; rejects the rest", () => {
    expect(() => validateConfig({ ...base, auth: { turnstile: true } })).not.toThrow();
    expect(() => validateConfig({ ...base, auth: { turnstile: { endpoints: ["/sign-in/email"], expectedAction: "login", allowedHostnames: ["app.test"] } } })).not.toThrow();
    expect(() => validateConfig({ ...base, environments: { prod: { auth: { turnstile: false } } } })).not.toThrow();
    expect(() => validateConfig({ ...base, auth: { turnstile: "yes" } })).toThrow(/turnstile must be true, false or an object/);
    expect(() => validateConfig({ ...base, auth: { turnstile: { endpoints: ["sign-in"] } } })).toThrow(/endpoints must be paths/);
    expect(() => validateConfig({ ...base, auth: { turnstile: { secret: "x" } } })).toThrow(/unknown key secret/);
  });
});

describe("ember env flags", () => {
  it("inapplicable flags and ignored combinations are errors, before the project is even loaded", async () => {
    // main() runs from a directory without ember.json: these must fail on the flags, not on the project lookup.
    await expect(main(["env", "list", "--var"])).rejects.toThrow(/--var does not apply to `ember env list`/);
    await expect(main(["env", "ls", "--reveal"])).rejects.toThrow(/--reveal does not apply to `ember env ls`/);
    await expect(main(["env", "get", "FOO", "--var"])).rejects.toThrow(/--var does not apply to `ember env get`/);
    await expect(main(["env", "set", "FOO", "--local"])).rejects.toThrow(/--local does not apply to `ember env set`/);
    await expect(main(["env", "set", "FOO", "--json"])).rejects.toThrow(/--json does not apply/);
    await expect(main(["env", "rm", "FOO", "--from-env", "X"])).rejects.toThrow(/--from-env does not apply to `ember env rm`/);
    await expect(main(["env", "get", "FOO", "--url", "https://x.test"])).rejects.toThrow(/--url only applies with --reveal/);
    await expect(main(["env", "list", "--local", "--env", "prod"])).rejects.toThrow(/drop --env/);
    await expect(main(["env", "get", "FOO", "BAR"])).rejects.toThrow(/unexpected argument "BAR"/);
    await expect(main(["env", "set", "FOO", "v", "--var", "--from-env", "X"])).rejects.toThrow(/not both/);
    await expect(main(["env", "nope"])).rejects.toThrow(/usage: ember env list\|set\|get\|rm/);
  });

  it("valid combinations pass, --var with --from-env included; aliases map to the canonical subcommand", () => {
    expect(checkEnvArgs("set", { var: true, "from-env": "CI_TOPIC" }, ["APNS_TOPIC"])).toBe("set");
    expect(checkEnvArgs("set", { var: true }, ["APNS_TOPIC", "com.acme"])).toBe("set");
    expect(checkEnvArgs("set", { "from-env": "X", env: "prod" }, ["STRIPE_KEY"])).toBe("set");
    expect(checkEnvArgs("get", { reveal: true, url: "https://x.test", "admin-token": "t", json: true }, ["X"])).toBe("get");
    expect(checkEnvArgs("ls", { local: true, json: true }, [])).toBe("list");
    expect(checkEnvArgs("delete", { var: true }, ["X"])).toBe("rm");
  });
});

describe("ember env against the Workers secrets API (fake)", () => {
  let p: Project;
  const secrets = new Map<string, string>();
  let deployed = true;
  let gradual = false;
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/client\/v4\/accounts\/acc\//, "/");
    const method = init?.method ?? "GET";
    calls.push(`${method} ${path}`);
    const ok = (result: unknown) => Response.json({ success: true, result, errors: [] });
    if (!deployed) return Response.json({ success: false, errors: [{ code: 10007, message: "This Worker does not exist on your account." }] }, { status: 404 });
    if (gradual && (method === "PUT" || method === "DELETE") && path.startsWith("/workers/scripts/ember-chat-prod/secrets")) {
      return Response.json({ success: false, errors: [{ code: 10215, message: "Secret edit failed. Worker has multiple versions deployed." }] }, { status: 400 });
    }
    if (method === "GET" && path === "/workers/scripts/ember-chat-prod/secrets") return ok([...secrets.keys()].map((name) => ({ name, type: "secret_text" })));
    if (method === "PUT" && path === "/workers/scripts/ember-chat-prod/secrets") {
      const b = JSON.parse(String(init!.body));
      secrets.set(b.name, b.text);
      return ok({ name: b.name, type: b.type });
    }
    const del = /^\/workers\/scripts\/ember-chat-prod\/secrets\/(.+)$/.exec(path);
    if (method === "DELETE" && del) {
      secrets.delete(decodeURIComponent(del[1]!));
      return ok(null);
    }
    if (url.pathname === "/api/_ember/env/reveal") {
      if (init?.headers && (init.headers as Record<string, string>).authorization !== "Bearer admin") return Response.json({ ok: false, error: { code: "unauthenticated", message: "x" } }, { status: 401 });
      const name = JSON.parse(String(init!.body)).name;
      return Response.json({ ok: true, name, value: secrets.get(name) });
    }
    return Response.json({ success: false, errors: [{ code: 0, message: `unexpected ${method} ${path}` }] }, { status: 500 });
  }) as typeof fetch;
  const target = (): EnvTarget => ({ client: new CfClient({ accountId: "acc", token: "t", fetch: fetchImpl, sleep: async () => {} }), project: p, env: "prod", worker: "ember-chat-prod" });

  beforeAll(() => {
    p = sampleProject("envapi");
  });
  afterAll(() => cleanup(p));

  it("set/list/get/rm a secret: values never come back without --reveal; deploy keeps them (keep_bindings)", async () => {
    expect(await envSet(target(), "STRIPE_KEY", "sk_test_123")).toEqual({ kind: "secret", created: true });
    expect(await envSet(target(), "STRIPE_KEY", "sk_test_456")).toEqual({ kind: "secret", created: false });
    secrets.set("EMBER_AUTH_SECRET", "managed");
    const list = await envList(target());
    expect(list).toEqual({ deployed: true, entries: [{ name: "EMBER_AUTH_SECRET", kind: "secret", managed: true }, { name: "STRIPE_KEY", kind: "secret", managed: false }] });
    expect(JSON.stringify(list)).not.toContain("sk_test");
    const got = await envGet(target(), "STRIPE_KEY");
    expect(got).toEqual({ name: "STRIPE_KEY", kind: "secret", managed: false });
    expect(await envGet(target(), "STRIPE_KEY", { reveal: true, url: "https://w.test", adminToken: "admin", fetch: fetchImpl })).toMatchObject({ value: "sk_test_456" });
    await expect(envGet(target(), "STRIPE_KEY", { reveal: true, url: "https://w.test" })).rejects.toThrow(/EMBER_ADMIN_TOKEN/);
    await expect(envGet(target(), "EMBER_AUTH_SECRET", { reveal: true, url: "https://w.test", adminToken: "admin", fetch: fetchImpl })).rejects.toThrow(/never revealed/);
    secrets.set("BETTER_AUTH_SECRET", "legacy");
    await expect(envGet(target(), "BETTER_AUTH_SECRET", { reveal: true, url: "https://w.test", adminToken: "admin", fetch: fetchImpl })).rejects.toThrow(/never revealed/);
    secrets.delete("BETTER_AUTH_SECRET");
    expect(await envRm(target(), "STRIPE_KEY")).toBe("secret");
    expect(await envRm(target(), "STRIPE_KEY")).toBeNull();
    expect(await envGet(target(), "STRIPE_KEY")).toBeNull();
  });

  it("refuses EMBER_* names, invalid names and empty values; a name is a secret or a var, never both", async () => {
    await expect(envSet(target(), "EMBER_ADMIN_TOKEN", "x")).rejects.toThrow(/managed by ember/);
    await expect(envSet(target(), "1BAD", "x")).rejects.toThrow(/not a valid binding name/);
    await expect(envSet(target(), "X", "")).rejects.toThrow(/empty value/);
    expect(await envSet(target(), "PUBLIC_URL", "https://app.test", { var: true })).toEqual({ kind: "var", created: true });
    expect(JSON.parse(readFileSync(p.configPath, "utf8")).environments.prod.vars).toEqual({ PUBLIC_URL: "https://app.test" });
    expect(validateConfig(JSON.parse(readFileSync(p.configPath, "utf8"))).environments.prod!.vars).toEqual({ PUBLIC_URL: "https://app.test" });
    await expect(envSet(target(), "PUBLIC_URL", "s")).rejects.toThrow(/plain var in ember.json/);
    expect(await envGet(target(), "PUBLIC_URL")).toEqual({ name: "PUBLIC_URL", kind: "var", managed: false });
    expect(await envGet(target(), "PUBLIC_URL", { reveal: true })).toMatchObject({ value: "https://app.test" });
    await envSet(target(), "TOKEN", "t1");
    await expect(envSet(target(), "TOKEN", "v", { var: true })).rejects.toThrow(/is a secret/);
    expect(await envRm(target(), "PUBLIC_URL")).toBe("var");
    expect(JSON.parse(readFileSync(p.configPath, "utf8")).environments.prod.vars).toBeUndefined();
  });

  it("during a gradual deployment both set and rm refuse with the next step (no change lands on one version only)", async () => {
    secrets.set("GRADUAL_KEY", "v1");
    gradual = true;
    try {
      await expect(envSet(target(), "GRADUAL_KEY", "v2")).rejects.toThrow(/gradual deployment in progress/);
      await expect(envRm(target(), "GRADUAL_KEY")).rejects.toThrow(/gradual deployment in progress/);
      expect(secrets.get("GRADUAL_KEY")).toBe("v1");
    } finally {
      gradual = false;
      secrets.delete("GRADUAL_KEY");
    }
  });

  it("before the first deploy secrets are refused with the next step", async () => {
    deployed = false;
    try {
      await expect(envSet(target(), "X", "1")).rejects.toThrow(/not deployed yet: run `ember deploy --env prod` first/);
      expect((await envList(target())).deployed).toBe(false);
    } finally {
      deployed = true;
    }
  });
});

describe("ember dev: .dev.vars + auth.turnstile + admin reveal (Miniflare)", () => {
  let project: Project;
  let mf: Miniflare;
  let url: URL;
  const PASS = "1x0000000000000000000000000000000AA";

  beforeAll(async () => {
    const dir = join(TMP, `envdev-${process.pid}`);
    init({ dir, project: "chat", auth: true, force: true });
    const cfg = JSON.parse(readFileSync(join(dir, "ember.json"), "utf8"));
    cfg.auth = { turnstile: true };
    writeFileSync(join(dir, "ember.json"), JSON.stringify(cfg, null, 2));
    writeFileSync(join(dir, ".dev.vars"), `TURNSTILE_SECRET_KEY=${PASS}\nGREETING="olá"\n`);
    writeFileSync(
      join(dir, "ember/hello.ts"),
      `import { action } from "./_generated/server";\nexport const greet = action({ args: {}, handler: async (ctx) => String(ctx.env.GREETING) });\nexport const version = action({ args: {}, handler: async (ctx) => String(ctx.env.EMBER_RUNTIME_VERSION) });\n`,
    );
    project = loadProject(dir);
    await codegen(project);
    const build = await buildWorker(project);
    expect(build.auth).toMatchObject({ kind: "local", turnstile: true });
    expect(readFileSync(build.entry, "utf8")).toContain(`turnstile: true`);
    ({ mf, url } = await startLocal(project, build, { persist: false, vars: { ...loadDevVars(project).vars, EMBER_ADMIN_TOKEN: "admin-dev", BETTER_AUTH_SECRET: "legacy-auth-secret-0123456789abcdef" } }));
  });
  afterAll(async () => {
    await mf?.dispose();
    if (project) cleanup(project);
  });

  const call = async (path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await mf.dispatchFetch(new URL(path, url), {
      method: body === undefined ? "GET" : "POST",
      headers: { origin: url.origin, "content-type": "application/json", ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, json: (await res.json().catch(() => null)) as any };
  };

  it(".dev.vars values reach actions as env", async () => {
    const r = await call("/api/action", { fn: "hello:greet", args: {}, shard: "global:main" });
    expect(r.json).toMatchObject({ ok: true, value: "olá" });
  });

  it("EMBER_RUNTIME_VERSION is the bundled runtime's version", async () => {
    const r = await call("/api/action", { fn: "hello:version", args: {}, shard: "global:main" });
    expect(r.json).toMatchObject({ ok: true, value: RUNTIME_VERSION });
  });

  it("sign-up needs the Turnstile token; Turnstile's always-pass test secret from .dev.vars accepts the dummy token", async () => {
    const body = { email: `t-${Date.now()}@vip.test`, password: "correct horse battery staple", name: "T" };
    expect(await call("/api/auth/sign-up/email", body)).toMatchObject({ status: 400, json: { code: "MISSING_RESPONSE" } });
    const ok = await call("/api/auth/sign-up/email", body, { "x-captcha-response": "XXXX.DUMMY.TOKEN.XXXX" });
    expect(ok.status).toBe(200);
    expect(ok.json.user.email).toBe(body.email);
  });

  it("POST /api/_ember/env/reveal: admin only, user names only, no-store", async () => {
    expect((await call("/api/_ember/env/reveal", { name: "GREETING" })).status).toBe(401);
    const auth = { authorization: "Bearer admin-dev" };
    const res = await mf.dispatchFetch(new URL("/api/_ember/env/reveal", url), { method: "POST", headers: auth, body: JSON.stringify({ name: "GREETING" }) });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: true, name: "GREETING", value: "olá" });
    expect(await call("/api/_ember/env/reveal", { name: "EMBER_AUTH_SECRET" }, auth)).toMatchObject({ status: 403, json: { error: { code: "managed" } } });
    // The auth secret's legacy name is read by packages/auth too: refused like EMBER_*, value never echoed.
    const legacy = await call("/api/_ember/env/reveal", { name: "BETTER_AUTH_SECRET" }, auth);
    expect(legacy).toMatchObject({ status: 403, json: { error: { code: "managed" } } });
    expect(JSON.stringify(legacy.json)).not.toContain("legacy-auth-secret");
    expect(await call("/api/_ember/env/reveal", { name: "NOPE" }, auth)).toMatchObject({ status: 404 });
    expect((await call("/api/_ember/env/reveal", { name: "a b" }, auth)).status).toBe(400);
    expect(existsSync(join(project.root, ".gitignore"))).toBe(true);
  });
});
