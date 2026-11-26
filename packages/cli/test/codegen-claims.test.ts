// Typed identity claims (docs/design/dx.md §3.7): codegen prints `ClaimsOf<typeof authConfig>` in
// `_generated/claims.d.ts`; `_generated/server` types `ctx.auth` and `fromAuth` with it. Without
// `ember/auth.config.ts`, the claims stay `Record<string, unknown>`.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { codegen } from "../src/codegen/index.ts";
import { TypeOracle } from "../src/codegen/returnTypes.ts";
import { loadProject, type Project } from "../src/config.ts";
import { init } from "../src/init.ts";
import { cleanup, sampleProject, TMP } from "./helpers.ts";

const AUTH_CONFIG = (claims: string) => `import { defineAuth } from "@freecorps/ember-auth";
import { organization } from "@freecorps/ember-auth/plugins";

export default defineAuth({
  emailAndPassword: { enabled: true },
  plugins: [organization()],
  ember: { claims: ({ user }) => (${claims}) },
});
`;

const ROLE = `{ role: (user.role === "admin" ? "admin" : "member") as "admin" | "member" }`;

const USES = `import { query } from "./_generated/server";

export const role = query((ctx) => ctx.auth.require().claims?.role ?? "member");
export const email = query((ctx) => ctx.auth.getUserIdentity()?.claims?.email ?? null);
`;

// Server code outside ember/ (type-checked, never evaluated): the mistakes fail exactly on the // ERR lines.
const SERVER_ERROR = `import { fromAuth, mutation, query, type Claims, type Identity } from "./ember/_generated/server";

export const ok = mutation({ shard: { org: fromAuth("org") }, handler: (ctx) => ctx.auth.require().claims?.org });
export const fine = query((ctx) => {
  const me: Identity | null = ctx.auth.getUserIdentity();
  const role: "admin" | "member" | undefined = me?.claims?.role;
  const verified: boolean | undefined = me?.claims?.emailVerified;
  return { role, verified };
});
export const a = fromAuth("tenant"); // ERR undeclared claim
export const b = query((ctx) => ctx.auth.require().claims?.nope); // ERR undeclared claim
export const c = query((ctx) => {
  const r: "owner" | undefined = ctx.auth.require().claims?.role; // ERR "admin" | "member"
  return r ?? null;
});
export type K = keyof Claims;
`;

const OPTIONS: ts.CompilerOptions = {
  strict: true,
  noEmit: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowImportingTsExtensions: true,
  customConditions: ["@freecorps/ember-source"],
  skipLibCheck: true,
  types: [],
  lib: ["lib.es2023.d.ts", "lib.dom.d.ts"],
};

function errorLines(project: Project, file: string): number[] {
  const path = join(project.root, file);
  const program = ts.createProgram([path], OPTIONS);
  const diags = ts.getPreEmitDiagnostics(program).filter((d) => d.file?.fileName === path);
  return [...new Set(diags.map((d) => d.file!.getLineAndCharacterOfPosition(d.start!).line + 1))].sort((x, y) => x - y);
}
const expectedLines = (text: string) =>
  text
    .split("\n")
    .map((l, i) => (l.includes("// ERR") ? i + 1 : 0))
    .filter(Boolean);
const gen = (p: Project, f: string) => readFileSync(join(p.generatedDir, f), "utf8");

describe("typed identity claims (ember/auth.config.ts → _generated/claims.d.ts)", () => {
  let project: Project;
  const oracle = new TypeOracle();

  beforeAll(async () => {
    const dir = join(TMP, `codegen-claims-${process.pid}`);
    rmSync(dir, { recursive: true, force: true });
    init({ dir, project: "chat", auth: true, force: true });
    project = loadProject(dir);
    writeFileSync(join(project.dir, "auth.config.ts"), AUTH_CONFIG(ROLE));
    writeFileSync(join(project.dir, "uses.ts"), USES);
    writeFileSync(join(project.root, "server_error.ts"), SERVER_ERROR);
    await codegen(project, { oracle });
  });
  afterAll(() => cleanup(project));

  it("prints Better Auth's claims, org (organization plugin) and ember.claims' (optional)", () => {
    expect(gen(project, "claims.d.ts")).toContain(
      'export type Claims = {\n  sid: string;\n  email: string;\n  name: string;\n  emailVerified: boolean;\n  org?: string;\n  role?: "admin" | "member";\n};',
    );
    expect(gen(project, "server.d.ts")).toContain('import type { Claims } from "./claims";');
  });

  it("types ctx.auth in the functions (their results reach api.d.ts)", async () => {
    const r = await codegen(project, { oracle, check: true });
    expect(r.contracts.get("uses:role")).toBe('Query<{}, "admin" | "member", never>');
    expect(r.contracts.get("uses:email")).toBe("Query<{}, string | null, never>");
  });

  it("an undeclared claim is a type error (fromAuth, claims.x), and the values are typed", () => {
    expect(errorLines(project, "server_error.ts")).toEqual(expectedLines(SERVER_ERROR));
  });

  it("follows edits of auth.config.ts in a session, and keeps the answer in .ember/ between processes", async () => {
    writeFileSync(join(project.dir, "auth.config.ts"), AUTH_CONFIG(`{ tenant: String(user.id), seats: 3 }`));
    await codegen(project, { oracle });
    expect(gen(project, "claims.d.ts")).toContain("  org?: string;\n  tenant?: string;\n  seats?: number;\n};");
    const cacheFile = join(project.stateDir, "codegen", "claims.json");
    const cache = JSON.parse(readFileSync(cacheFile, "utf8")) as { result: { text: string } };
    expect(cache.result.text).toContain("tenant?: string;");
    // Another process (a new oracle) takes the answer from the cache while nothing it read changed.
    writeFileSync(cacheFile, JSON.stringify({ ...cache, result: { text: "{\n  cached: true;\n}" } }));
    await codegen(project, { oracle: new TypeOracle() });
    expect(gen(project, "claims.d.ts")).toContain("export type Claims = {\n  cached: true;\n};");
    writeFileSync(join(project.dir, "auth.config.ts"), AUTH_CONFIG(ROLE));
    await codegen(project, { oracle: new TypeOracle() });
    expect(gen(project, "claims.d.ts")).toContain('  role?: "admin" | "member";\n};');
  });

  it("without ember/auth.config.ts the claims stay untyped (any name, unknown values)", async () => {
    const plain = sampleProject("codegen-claims-plain");
    try {
      await codegen(plain);
      expect(gen(plain, "claims.d.ts")).toContain("export type Claims = Record<string, unknown>;");
      writeFileSync(
        join(plain.root, "loose.ts"),
        `import { fromAuth, query } from "./ember/_generated/server";
export const s = fromAuth("whatever");
export const q = query((ctx) => {
  const x: unknown = ctx.auth.require().claims?.anything;
  return x === undefined;
});
`,
      );
      expect(errorLines(plain, "loose.ts")).toEqual([]);
    } finally {
      cleanup(plain);
    }
  });
});
