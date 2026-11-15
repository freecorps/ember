// `ember/triggers.ts` (PLAN §22 L2): typed `defineTriggers` in `_generated/server`, passed to the worker, and checked
// against the schema at codegen time.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { workerEntrySource } from "../src/build.ts";
import { codegen } from "../src/codegen/index.ts";
import type { Project } from "../src/config.ts";
import { discover } from "../src/modules.ts";
import { cleanup, sampleProject } from "./helpers.ts";

const TRIGGERS = `import { defineTriggers } from "./_generated/server";

export default defineTriggers({
  messages: [
    (ctx, change) => {
      if (change.operation === "insert") {
        const body: string = change.newDoc.body;
        ctx.db.insert("messages", { channel: "audit", author: "trigger", body });
      }
      const nope: number = change.newDoc?.body; // ERR string is not number
      void nope;
    },
  ],
  notATable: () => {}, // ERR unknown table
});
`;

function check(project: Project, file: string) {
  const program = ts.createProgram([join(project.root, file)], {
    strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true, customConditions: ["@freecorps/ember-source"], skipLibCheck: true, types: [], lib: ["lib.es2023.d.ts", "lib.dom.d.ts"],
  });
  const sf = program.getSourceFile(join(project.root, file))!;
  const diags = ts.getPreEmitDiagnostics(program).filter((d) => d.file?.fileName === sf.fileName || d.file?.fileName.includes("_generated"));
  return [...new Set(diags.map((d) => (d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : -1)))].sort((a, b) => a - b);
}

describe("codegen: ember/triggers.ts", () => {
  let project: Project;
  beforeAll(() => {
    project = sampleProject("codegen-triggers");
  });
  afterAll(() => cleanup(project));

  it("is a reserved file, passed to createEmberWorker", () => {
    writeFileSync(join(project.dir, "triggers.ts"), `import { defineTriggers } from "./_generated/server";\nexport default defineTriggers({});\n`);
    const files = discover(project.dir);
    expect(files.triggers).toBe(join(project.dir, "triggers.ts"));
    expect(files.modules.map((m) => m.path)).not.toContain("triggers");
    const entry = workerEntrySource(files);
    expect(entry).toContain(`import triggers from`);
    expect(entry).toContain("createEmberWorker({ schema, functions, crons, auth, app, http, triggers })");
  });

  it("types defineTriggers with the DataModel (tables, documents)", async () => {
    writeFileSync(join(project.dir, "triggers.ts"), `import { defineTriggers } from "./_generated/server";\nexport default defineTriggers({});\n`);
    await codegen(project);
    expect(readFileSync(join(project.generatedDir, "server.js"), "utf8")).toContain("defineTriggers");
    writeFileSync(join(project.dir, "triggers.ts"), TRIGGERS);
    const errs = TRIGGERS.split("\n").flatMap((l, i) => (l.includes("// ERR") ? [i + 1] : []));
    expect(check(project, "ember/triggers.ts")).toEqual(errs);
  });

  it("refuses triggers on tables the app does not have", async () => {
    writeFileSync(join(project.dir, "triggers.ts"), `import { defineTriggers } from "@freecorps/ember-server";\nexport default defineTriggers({ nope: () => {} });\n`);
    await expect(codegen(project)).rejects.toThrow(/ember\/triggers\.ts: .*"nope" is not a table of the app/);
    writeFileSync(join(project.dir, "triggers.ts"), `export default { messages: () => {} };\n`);
    await expect(codegen(project)).rejects.toThrow(/must `export default defineTriggers/);
  });
});
