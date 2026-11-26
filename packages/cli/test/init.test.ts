// `ember init` (with and without `--auth`): the generated project goes through codegen and type-checks with the
// tsconfig it ships (strict, noUncheckedIndexedAccess), and the sample shows the APIs it should: `defineErrors`,
// `.aggregate()` for counts, `ctx.auth.require()`, generated references in crons.
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { afterAll, describe, expect, it } from "vitest";
import { codegen } from "../src/codegen/index.ts";
import { loadProject, type Project } from "../src/config.ts";
import { init } from "../src/init.ts";
import { TMP } from "./helpers.ts";

const made: string[] = [];
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

async function generated(auth: boolean): Promise<Project> {
  const dir = join(TMP, `init-${auth ? "auth" : "plain"}-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  made.push(dir);
  init({ dir, project: "chat", auth, force: true });
  const project = loadProject(dir);
  const r = await codegen(project);
  expect(r.warnings).toEqual([]);
  return project;
}

/** Type-checks every `.ts` of `ember/` with the shipped `ember/tsconfig.json` (as `tsc -p ember` would). */
function typecheck(project: Project): string[] {
  const tsconfig = join(project.root, "ember", "tsconfig.json");
  const parsed = ts.parseJsonConfigFileContent(ts.readConfigFile(tsconfig, ts.sys.readFile).config, ts.sys, join(project.root, "ember"));
  // In the repo the packages resolve to their sources (what an installed app gets from `dist/`).
  const program = ts.createProgram(parsed.fileNames, { ...parsed.options, customConditions: ["@freecorps/ember-source"], types: [] });
  return ts
    .getPreEmitDiagnostics(program)
    .filter((d) => !d.file || d.file.fileName.startsWith(project.root))
    .map((d) => `${d.file ? `${d.file.fileName.slice(project.root.length + 1)}:${d.file.getLineAndCharacterOfPosition(d.start ?? 0).line + 1}: ` : ""}${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`);
}

describe("ember init", () => {
  it("the sample app passes codegen and tsc (strict) and uses aggregates, defineErrors and generated cron refs", async () => {
    const project = await generated(false);
    expect(typecheck(project)).toEqual([]);
    const messages = readFileSync(join(project.root, "ember/messages.ts"), "utf8");
    expect(messages).not.toMatch(/\.collect\(\)\.length/);
    expect(messages).toMatch(/ctx\.db\.aggregate\("messages", "per_channel"\)/);
    expect(messages).toMatch(/throw errors\.MessageNotFound/);
    const crons = readFileSync(join(project.root, "ember/crons.ts"), "utf8");
    expect(crons).toMatch(/internal\.messages\.trim/);
    expect(crons).not.toMatch(/"messages:trim"/);
    const m = JSON.parse(readFileSync(join(project.generatedDir, "manifest.json"), "utf8"));
    expect(m.crons).toEqual([{ name: "trim-general", schedule: "0 * * * *", shard: "global:main", fn: "messages:trim" }]);
  });

  it("--auth passes codegen and tsc: typed profile sync args, ctx.auth.require() and app errors", async () => {
    const project = await generated(true);
    expect(typecheck(project)).toEqual([]);
    const users = readFileSync(join(project.root, "ember/users.ts"), "utf8");
    expect(users).not.toMatch(/v\.any\(\)/);
    expect(users).toMatch(/ctx\.auth\.require\(\)/);
    expect(users).toMatch(/throw errors\.NotEnoughCredits/);
    expect(readFileSync(join(project.root, "ember/errors.ts"), "utf8")).toMatch(/ProfileNotSynced[\s\S]*NotEnoughCredits/);
    expect(readdirSync(join(project.root, "ember")).sort()).toEqual(
      ["_generated", "auth.config.ts", "crons.ts", "errors.ts", "messages.ts", "schema.ts", "tsconfig.json", "users.ts"].sort(),
    );
  });
});
