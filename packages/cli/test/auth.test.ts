// `ember init --auth` end to end in Miniflare (the real bundle: Better Auth in the Auth DO + the Ember runtime):
// codegen auth types, generated entry, /api/auth/*, JWT → ctx.auth, profile sync outbox, sensitive mutations.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildWorker, workerEntrySource } from "../src/build.ts";
import { codegen } from "../src/codegen/index.ts";
import { loadProject, projectFrom, type Project } from "../src/config.ts";
import { init } from "../src/init.ts";
import { startLocal } from "../src/local.ts";
import { discover } from "../src/modules.ts";
import { cleanup, TMP } from "./helpers.ts";

let project: Project;
let mf: Miniflare;
let url: URL;

beforeAll(async () => {
  const dir = join(TMP, `auth-${process.pid}`);
  init({ dir, project: "chat", auth: true, force: true });
  project = loadProject(dir);
  await codegen(project);
  const build = await buildWorker(project);
  ({ mf, url } = await startLocal(project, build, { persist: false }));
});
afterAll(async () => {
  await mf?.dispose();
  if (project) cleanup(project);
});

async function call(path: string, init: { method?: string; body?: unknown; token?: string } = {}) {
  const headers: Record<string, string> = { origin: url.origin };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  const res = await mf.dispatchFetch(new URL(path, url), {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, headers: res.headers };
}
const fn = (kind: "query" | "mutation", name: string, args: unknown, token?: string) =>
  call(`/api/${kind}`, { body: { fn: name, args, shard: "global:main" }, ...(token ? { token } : {}) });

describe("codegen and entry with ember/auth.config.ts", () => {
  it("emits read-only auth:* types without hidden fields and marks sensitive functions", () => {
    const dts = readFileSync(join(project.generatedDir, "dataModel.d.ts"), "utf8");
    expect(dts).toContain(`"auth:user": {`);
    expect(dts).toContain(`"auth:organization": {`);
    expect(dts).toMatch(/export type Doc<TableName extends TableNames \| AuthTableNames>/);
    expect(dts).not.toMatch(/^\s+(password|privateKey|token|accessToken|refreshToken|value)\??:/m);
    const manifest = JSON.parse(readFileSync(join(project.generatedDir, "manifest.json"), "utf8"));
    expect(manifest.auth.mode).toBe("local");
    expect(manifest.functions.find((f: any) => f.name === "users:spendCredits").sensitive).toBe(true);
  });

  it("generated entry exports Auth with the outbox and passes auth to createEmberWorker", () => {
    const src = readFileSync(join(project.stateDir, "build", "worker", "entry.mjs"), "utf8");
    expect(src).toContain(`const auth = emberAuth(authConfig, { project: "chat", onUserChange: outbox.onUserChange });`);
    expect(src).toContain("export const Auth = outbox.wrap(auth.Auth);");
    expect(src).toContain("createEmberWorker({ schema, functions, crons, auth, app, http })");
  });

  it("SSO (auth.from) uses remoteAuth and no Auth DO; refuses a local auth.config.ts too", () => {
    const p = projectFrom(project.root, { ...project.config, auth: { from: "https://id.example.com" } });
    const files = discover(project.dir);
    expect(() => workerEntrySource(files, null)).not.toThrow();
    const remote = workerEntrySource({ ...files, authConfig: null }, { kind: "remote", from: "https://id.example.com" });
    expect(remote).toContain(`remoteAuth({ from: "https://id.example.com" })`);
    expect(remote).not.toContain("export const Auth");
    return expect(buildWorker(p)).rejects.toThrow(/mutually exclusive/);
  });

  it("refuses user tables with reserved auth names", async () => {
    const schema = join(project.dir, "schema.ts");
    const orig = readFileSync(schema, "utf8");
    try {
      writeFileSync(schema, orig.replace("profiles: defineTable", "session: defineTable"));
      await expect(codegen(project)).rejects.toThrow(/reserved for auth: session/);
    } finally {
      writeFileSync(schema, orig);
    }
  });
});

describe("auth flows in the bundled Worker (Miniflare)", () => {
  const email = `ada-${Date.now()}@example.com`;
  const password = "correct-horse-battery";
  let session = "";
  let jwt = "";

  it("sign-up, sign-in, JWT; ctx.auth sees the identity; the profile is synced through the outbox", async () => {
    const up = await call("/api/auth/sign-up/email", { body: { email, password, name: "Ada" } });
    expect(up.status).toBe(200);
    const signIn = await call("/api/auth/sign-in/email", { body: { email, password } });
    expect(signIn.status).toBe(200);
    session = signIn.headers.get("set-auth-token") ?? signIn.json.token;
    expect(session).toBeTruthy();
    const tok = await call("/api/auth/token", { token: session });
    expect(tok.status).toBe(200);
    jwt = tok.json.token;
    expect(jwt.split(".")).toHaveLength(3);

    let me: any;
    for (let i = 0; i < 100; i++) {
      me = await fn("query", "users:me", {}, jwt);
      if (me.json?.value?.profile) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(me.json.value).toMatchObject({ subject: up.json.user.id, email, profile: { email, name: "Ada", credits: 0 } });
    expect((await fn("query", "users:me", {})).json.value).toBeNull();
    expect((await fn("query", "users:me", {}, "not-a-token")).status).toBe(401);
  });

  it("sensitive mutation works signed in and is refused right after sign-out (JWT still valid)", async () => {
    expect((await fn("mutation", "users:addCredits", { amount: 10 }, jwt)).json.value).toBe(10);
    expect((await fn("mutation", "users:spendCredits", { amount: 3 }, jwt)).json).toMatchObject({ ok: true, value: 7 });
    expect((await call("/api/auth/sign-out", { body: {}, token: session })).status).toBe(200);
    const denied = await fn("mutation", "users:spendCredits", { amount: 1 }, jwt);
    expect(denied).toMatchObject({ status: 401, json: { ok: false, error: { code: "unauthenticated" } } });
    // Non-sensitive calls still accept the (short-lived) JWT.
    expect((await fn("mutation", "users:addCredits", { amount: 1 }, jwt)).json.value).toBe(8);
  });
});
