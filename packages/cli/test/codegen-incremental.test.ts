// Incremental codegen (`ember dev`, docs/design/dx.md §3.5): one TypeOracle across runs re-infers only the edited
// modules and the ones importing them, and every run's output is the same as a codegen from scratch's.
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { codegen } from "../src/codegen/index.ts";
import { TypeOracle } from "../src/codegen/returnTypes.ts";
import { loadProject, type Project } from "../src/config.ts";
import { cleanup, sampleProject } from "./helpers.ts";

const ERRORS = `import { defineErrors, v } from "@freecorps/ember-server";

export const errors = defineErrors({
  Banned: { data: v.object({ until: v.number() }) },
  Forbidden: {},
  MessageNotFound: { data: v.object({ id: v.string() }) },
  MessageTooLong: { data: v.object({ max: v.number() }) },
});
`;

const GUARD = (extra = "") => `import { errors } from "../errors";
import type { MutationCtx } from "../_generated/server";

export function assertCanPost(ctx: MutationCtx, author: string) {
  if (author === "spam") throw errors.Banned({ until: ctx.now + 1000 });${extra}
}
`;

// "zeta" is created by the checker while it reads a.ts, before b.ts: b's union must print the same either way.
const A = (body = `"zeta" as const`) => `import { query } from "./_generated/server";

export type Item = { id: string; weight: number };

export const tag = query(() => ${body});
export const item = query((): Item => ({ id: "x", weight: 1 }));
`;

const B = (comment = "") => `import { v } from "@freecorps/ember-server";
import { internalQuery, mutation } from "./_generated/server";
import { assertCanPost } from "./lib/guard";

/** Another module's \`Item\`: printed under another name. */
export type Item = { name: string; tags: string[] };

${comment}
export const pick = internalQuery({
  args: { flag: v.boolean() },
  handler: (_ctx, { flag }) => (flag ? "alpha" : "zeta"),
});
export const item = internalQuery((): Item => ({ name: "n", tags: [] }));
export const post = mutation({
  args: { author: v.string() },
  handler: (ctx, { author }) => {
    assertCanPost(ctx, author);
    return author.length;
  },
});
`;

const C = `import { v } from "@freecorps/ember-server";
import { internal } from "./_generated/api";
import { query } from "./_generated/server";

export const relay = query({
  args: { flag: v.boolean() },
  handler: (ctx, { flag }) => ({ picked: ctx.runQuery(internal.b.pick, { flag }), item: ctx.runQuery(internal.b.item, {}) }),
});
`;

const D = `import { query } from "./_generated/server";

export const extra = query(() => ({ when: 1, items: [] as Array<{ ok: boolean }> }));
`;

/** Every generated file (path → content), with the project directory made relative. */
function snapshot(p: Project): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const f = join(d, name);
      if (statSync(f).isDirectory()) walk(f);
      else out[relative(p.generatedDir, f)] = readFileSync(f, "utf8").split(p.root).join("<root>");
    }
  };
  walk(p.generatedDir);
  return out;
}

describe("incremental codegen (one TypeOracle across ember dev runs)", () => {
  let project: Project;
  let freshRoot: string;
  const oracle = new TypeOracle();
  let inferred: string[] = [];
  const infer = oracle.infer.bind(oracle);
  oracle.infer = (o) => {
    const r = infer(o);
    inferred.push(...r.inferred);
    return r;
  };

  /** A codegen of the session (incremental), and one from scratch in a copy of the sources: same files, same warnings. */
  async function step(edit: () => void) {
    edit();
    inferred = [];
    const r = await codegen(project, { oracle });
    const reinferred = [...new Set(inferred)].sort();
    rmSync(freshRoot, { recursive: true, force: true });
    mkdirSync(freshRoot, { recursive: true });
    cpSync(project.root, freshRoot, { recursive: true, filter: (src) => !src.includes("_generated") && !src.includes(".ember") });
    const fresh = loadProject(freshRoot);
    const scratch = await codegen(fresh);
    expect(snapshot(project)).toEqual(snapshot(fresh));
    const norm = (w: string[], p: Project) => w.map((x) => x.split(p.root).join("<root>"));
    expect(norm(r.warnings, project)).toEqual(norm(scratch.warnings, fresh));
    return { r, reinferred };
  }

  beforeAll(async () => {
    project = sampleProject("codegen-incremental");
    freshRoot = `${project.root}-fresh`;
    writeFileSync(join(project.dir, "errors.ts"), ERRORS);
    mkdirSync(join(project.dir, "lib"), { recursive: true });
    writeFileSync(join(project.dir, "lib", "guard.ts"), GUARD());
    writeFileSync(join(project.dir, "a.ts"), A());
    writeFileSync(join(project.dir, "b.ts"), B());
    writeFileSync(join(project.dir, "c.ts"), C);
    rmSync(project.generatedDir, { recursive: true, force: true });
    await codegen(project, { oracle });
  });
  afterAll(() => {
    cleanup(project);
    rmSync(freshRoot, { recursive: true, force: true });
  });

  it("a run with no change infers nothing", async () => {
    const { reinferred } = await step(() => {});
    expect(reinferred).toEqual([]);
  });

  it("an edit that keeps the api re-infers the module alone (literal unions print the same)", async () => {
    const { reinferred } = await step(() => writeFileSync(join(project.dir, "b.ts"), B("// edited")));
    expect(reinferred).toEqual(["b"]);
    expect(readFileSync(join(project.generatedDir, "api.d.ts"), "utf8")).toMatch(/pick: InternalQuery<\{\n\s+flag: boolean;\n\s+\}, "alpha" \| "zeta", never>/);
  });

  it("a helper's body reaches its importers (a new thrown error joins their contracts)", async () => {
    const { r, reinferred } = await step(() => writeFileSync(join(project.dir, "lib", "guard.ts"), GUARD(`\n  if (!author) throw errors.Forbidden();`)));
    // b imports the helper; b:post's errors change api.d.ts, so a second pass re-infers the modules importing the api
    // (c, messages). a imports neither.
    expect(reinferred).toEqual(["b", "c", "lib/guard", "messages"]);
    expect(r.manifest.functions.find((f) => f.name === "b:post")?.errors).toEqual(["Banned", "Forbidden"]);
  });

  it("a return type change reaches the callers through api.d.ts, to the fixed point", async () => {
    const { reinferred } = await step(() => writeFileSync(join(project.dir, "a.ts"), A(`({ tag: "zeta" as const, at: 1 })`)));
    expect(reinferred).toContain("a");
    expect(readFileSync(join(project.generatedDir, "api.d.ts"), "utf8")).toContain("at: number;");
  });

  it("named types keep their names when only the second module is edited", async () => {
    await step(() => writeFileSync(join(project.dir, "b.ts"), B("// edited again")));
    const types = readFileSync(join(project.generatedDir, "types.d.ts"), "utf8");
    expect(types).toContain("export type Item = {");
    expect(types).toContain("export type b_Item = {");
  });

  it("modules added and removed; type errors come and go", async () => {
    await step(() => writeFileSync(join(project.dir, "d.ts"), D));
    const broken = await step(() => writeFileSync(join(project.dir, "d.ts"), D.replace("when: 1", "when: missingName")));
    expect(broken.r.warnings.some((w) => w.includes("missingName"))).toBe(true);
    const fixed = await step(() => writeFileSync(join(project.dir, "d.ts"), D));
    expect(fixed.r.warnings.some((w) => w.includes("missingName"))).toBe(false);
    // The api loses d.extra: the modules importing it are inferred again, the others are not.
    const { reinferred } = await step(() => rmSync(join(project.dir, "d.ts")));
    expect(reinferred).toEqual(["c", "messages"]);
    expect(readFileSync(join(project.generatedDir, "api.d.ts"), "utf8")).not.toContain("extra");
  });
});
