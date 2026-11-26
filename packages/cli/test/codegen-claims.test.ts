// Typed identity claims (docs/design/dx.md §3.7): codegen prints `ClaimsOf<typeof authConfig>` in
// `_generated/claims.d.ts`; `_generated/server` types `ctx.auth` and `fromAuth` with it. Without
// `ember/auth.config.ts`, the claims stay `Record<string, unknown>`.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { codegen } from "../src/codegen/index.ts";
import { currentManifest } from "../src/codegen/current.ts";
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

  it("a type auth.config.ts imports from outside ember/ (type only) is a source: editing it makes the manifest stale", async () => {
    writeFileSync(join(project.root, "roles.ts"), 'export type Role = "admin" | "member";\n');
    try {
      writeFileSync(
        join(project.dir, "auth.config.ts"),
        AUTH_CONFIG(`{ role: (user.role === "admin" ? "admin" : "member") as Role }`).replace(
          'import { organization }',
          'import type { Role } from "../roles";\nimport { organization }',
        ),
      );
      await codegen(project, { oracle });
      expect(currentManifest(project)?.manifest.sources?.files).toContain("roles.ts");
      writeFileSync(join(project.root, "roles.ts"), 'export type Role = "admin" | "member" | "guest";\n');
      expect(currentManifest(project)).toBeNull();
    } finally {
      writeFileSync(join(project.dir, "auth.config.ts"), AUTH_CONFIG(ROLE));
      rmSync(join(project.root, "roles.ts"), { force: true });
      await codegen(project, { oracle });
    }
  });

  it("the cached claims follow a sibling package's package.json (its `types` picks another declaration)", async () => {
    const sibling = `${project.root}-roles`;
    mkdirSync(sibling, { recursive: true });
    try {
      writeFileSync(join(sibling, "v1.d.ts"), 'export type Role = "alpha";\n');
      writeFileSync(join(sibling, "v2.d.ts"), 'export type Role = "beta";\n');
      writeFileSync(join(sibling, "package.json"), JSON.stringify({ name: "roles", types: "v1.d.ts" }));
      writeFileSync(
        join(project.dir, "auth.config.ts"),
        AUTH_CONFIG(`{ role: "alpha" as unknown as Role }`).replace("import { organization }", `import type { Role } from "../../${basename(sibling)}";\nimport { organization }`),
      );
      await codegen(project, { oracle: new TypeOracle() });
      expect(gen(project, "claims.d.ts")).toContain('  role?: "alpha";');
      // Only the package.json changes: a new process must not take the cached answer.
      writeFileSync(join(sibling, "package.json"), JSON.stringify({ name: "roles", types: "v2.d.ts" }));
      await codegen(project, { oracle: new TypeOracle() });
      expect(gen(project, "claims.d.ts")).toContain('  role?: "beta";');
      // The same oracle (`ember dev`) too: its previous program must not keep the resolution to v1.d.ts.
      const same = new TypeOracle();
      writeFileSync(join(sibling, "package.json"), JSON.stringify({ name: "roles", types: "v1.d.ts" }));
      await codegen(project, { oracle: same });
      expect(gen(project, "claims.d.ts")).toContain('  role?: "alpha";');
      writeFileSync(join(sibling, "package.json"), JSON.stringify({ name: "roles", types: "v2.d.ts" }));
      await codegen(project, { oracle: same });
      expect(gen(project, "claims.d.ts")).toContain('  role?: "beta";');
    } finally {
      writeFileSync(join(project.dir, "auth.config.ts"), AUTH_CONFIG(ROLE));
      rmSync(sibling, { recursive: true, force: true });
      await codegen(project, { oracle });
    }
  });

  it("a built-in generic over a project type keeps its name (Record, Map) with the arguments spelled out: claims.d.ts stands alone", async () => {
    writeFileSync(
      join(project.dir, "auth.config.ts"),
      AUTH_CONFIG(`{ roles: {} as Record<string, Role>, seen: new Map<string, Role>(), at: new Date() }`).replace("import { organization }", 'type Role = "admin" | "member";\nimport { organization }'),
    );
    try {
      await codegen(project, { oracle });
      const text = gen(project, "claims.d.ts");
      expect(text).not.toMatch(/\bRole\b/);
      expect(text).toContain('roles?: Record<string, "admin" | "member">;');
      expect(text).toContain('seen?: Map<string, "admin" | "member">;');
      expect(text).toContain("at?: Date;");
      const file = join(project.generatedDir, "claims.d.ts");
      // skipLibCheck off: a .d.ts is otherwise not checked at all (an unknown name in it would pass).
      const program = ts.createProgram([file], { ...OPTIONS, skipLibCheck: false });
      expect(ts.getPreEmitDiagnostics(program).filter((d) => d.file?.fileName === file).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))).toEqual([]);
    } finally {
      writeFileSync(join(project.dir, "auth.config.ts"), AUTH_CONFIG(ROLE));
      await codegen(project, { oracle });
    }
  });

  it("a literal containing the word any is a fine claim; a brand prints structurally (claims.d.ts imports nothing)", async () => {
    writeFileSync(
      join(project.dir, "auth.config.ts"),
      AUTH_CONFIG(`{ permission: "read:any" as const, tenant: user.id as string & { readonly __tableName: "orgs" } }`),
    );
    const r = await codegen(project, { oracle });
    expect(r.warnings.filter((w) => w.startsWith("ember/auth.config.ts"))).toEqual([]);
    const text = gen(project, "claims.d.ts");
    expect(text).toContain('  permission?: "read:any";');
    expect(text).not.toMatch(/\bId</);
    expect(text).toMatch(/tenant\?: string & \{\n\s+__tableName: "orgs";\n\s+\};/);
    // The file stands alone: every name it uses is declared in it.
    const file = join(project.generatedDir, "claims.d.ts");
    const program = ts.createProgram([file], { ...OPTIONS, skipLibCheck: false });
    expect(ts.getPreEmitDiagnostics(program).filter((d) => d.file?.fileName === file).map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))).toEqual([]);
    writeFileSync(join(project.dir, "auth.config.ts"), AUTH_CONFIG(ROLE));
    await codegen(project, { oracle });
  });

  it("an any in the claims leaves them untyped, and that failure is not kept (its fix may be a file it never read)", () => {
    const authConfig = join(project.dir, "auth.config.ts");
    const extra = join(project.dir, "claims_extra.ts");
    const cacheFile = join(project.stateDir, "codegen", "claims-test.json");
    const ask = (o = new TypeOracle()) => o.claims({ authConfig, generatedDir: project.generatedDir, projectDir: project.dir, cacheFile });
    rmSync(cacheFile, { force: true });
    writeFileSync(authConfig, `// @ts-nocheck: the helper is not written yet\nimport { plan } from "./claims_extra";\n${AUTH_CONFIG("{ plan }")}`);
    try {
      const failed = ask();
      expect("problem" in failed && failed.problem).toMatch(/plan\?: any/);
      expect(existsSync(cacheFile)).toBe(false);
      // Only the new file changes (auth.config.ts as it was): the next run, in this process or another, sees it.
      writeFileSync(extra, "export const plan = 3 as number;\n");
      const session = new TypeOracle();
      const ok = ask(session);
      expect("text" in ok && ok.text).toContain("  plan?: number;");
      // A file it read goes away: checked again (and the failure is not kept either).
      rmSync(extra);
      expect("problem" in ask(session)).toBe(true);
      writeFileSync(extra, "export const plan = 3 as number;\n");
      expect(ask(session)).toEqual(ok);
      // Kept now, and stamped by auth.config.ts and what it read; Better Auth's files by their package.json.
      const cache = JSON.parse(readFileSync(cacheFile, "utf8")) as { files: string[] };
      expect(cache.files).toContain(extra);
      const installed = cache.files.filter((f) => f.split(/[\\/]/).includes("node_modules"));
      expect(installed.length).toBeGreaterThan(0);
      expect(installed.every((f) => f.endsWith("/package.json"))).toBe(true);
      expect(ask(new TypeOracle())).toEqual(ok);
    } finally {
      rmSync(extra, { force: true });
      rmSync(cacheFile, { force: true });
      writeFileSync(authConfig, AUTH_CONFIG(ROLE));
    }
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
