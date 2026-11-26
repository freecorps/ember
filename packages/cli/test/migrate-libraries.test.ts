// `ember migrate convex`: the library check against the node-actions spike's verdicts (fixture test/fixtures/convex-libs).
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { migrateCommand } from "../src/migrate/command.ts";
import { checkLibraries, importSpecifiers, libraryLines, lookup, packageOf } from "../src/migrate/deps.ts";
import { migrateConvex } from "../src/migrate/index.ts";
import { LIBRARIES, VERDICTS } from "../src/migrate/libraries.ts";
import { TMP } from "./helpers.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/convex-libs/convex", import.meta.url));
const SPIKE = fileURLToPath(new URL("../../../docs/spikes/node-actions/libraries.json", import.meta.url));
const out = join(TMP, `migrate-libs-${process.pid}`);
afterAll(() => rmSync(out, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

describe("migrate convex: libraries", () => {
  it("libraries.ts is the spike's libraries.json (regenerate it when the evidence changes)", () => {
    const spike = JSON.parse(readFileSync(SPIKE, "utf8")) as { version: number; runtime: unknown; verdicts: unknown; modules: unknown };
    expect(LIBRARIES).toEqual({ version: spike.version, runtime: spike.runtime, modules: spike.modules });
    expect(VERDICTS).toEqual(spike.verdicts);
  });

  it("finds import specifiers (not type-only ones) and matches them, longest key first", () => {
    const text = `import a from "a";\nimport { b,\n c } from '@s/b/sub';\nimport "side";\nexport * from "re";\nexport { x } from "rx";\nimport type { T } from "types-only";\nexport type { U } from "types-too";\nconst l = await import("lazy");\nconst r = require("req");\nimport * as fs from "fs";\nimport x from "./rel";`;
    expect(importSpecifiers(text).sort()).toEqual(["./rel", "@s/b/sub", "a", "fs", "lazy", "re", "req", "rx", "side"]);
    // Parsed, not matched as text: comments and strings never count; a comment inside a declaration does not hide it.
    const tricky = [
      `// import sharp from "sharp";`,
      `/* const b = require("bcrypt"); */`,
      `const msg = "import x from 'in-a-string'";`,
      "const tpl = `require(\"in-a-template\")`;",
      `import img /* image processing */ from "inline-comment";`,
      `import {\n  a, // the first\n  b,\n} from "multiline-comment";`,
      `import eq = require("import-equals");`,
      `type Lazy = typeof import("type-position");`,
      `import { type OnlyType } from "mixed-but-loaded";`,
    ].join("\n");
    expect(importSpecifiers(tricky).sort()).toEqual(["import-equals", "inline-comment", "mixed-but-loaded", "multiline-comment"]);
    // Plain JavaScript (JSX allowed) parses too.
    expect(importSpecifiers(`const a = require("cjs"); export default () => <div/>;`, "x.jsx")).toEqual(["cjs"]);
    // Each extension's grammar: in .ts/.mts/.cts `<T>expr` is a type assertion (in .tsx it would be JSX).
    for (const f of ["x.ts", "x.mts", "x.cts"]) expect(importSpecifiers(`const lib = <unknown>import("sharp");`, f), f).toEqual(["sharp"]);
    // A class's runtime base expression loads its module; type arguments, implements and interface heritage do not.
    const heritage = [
      `class Background extends require("node:worker_threads").Worker {}`,
      `const C = class extends (require("base-expr") as any).B<import("erased-arg").T> {};`,
      `interface I extends Ifc<typeof import("erased-iface")> {}`,
      `class K implements Ifc<import("erased-impl").T> {}`,
      // An instantiation expression keeps its runtime operand.
      `export const factory = (require("instantiated") as <T>(input: T) => T)<Uint8Array>;`,
    ].join("\n");
    expect(importSpecifiers(heritage, "x.ts").sort()).toEqual(["base-expr", "instantiated", "node:worker_threads"]);
    expect([packageOf("@s/b/sub"), packageOf("fs"), packageOf("fs/promises"), packageOf("node:zlib"), packageOf("./x"), packageOf("lodash/fp")]).toEqual(["@s/b", "node:fs", "node:fs/promises", "node:zlib", null, "lodash"]);
    expect(lookup("sharp")).toMatchObject({ matched: "sharp", verdict: "no" });
    expect(lookup("crypto")).toMatchObject({ matched: "node:crypto", verdict: "works" });
    expect(lookup("node:fs/promises")).toMatchObject({ matched: "node:fs/promises", verdict: "partial" });
    expect(lookup("exceljs/lib/exceljs.nodejs.js")?.matched).toBe("exceljs/lib/exceljs.nodejs.js");
    expect(lookup("exceljs/dist/es5")?.matched).toBe("exceljs");
    expect(lookup("@aws-sdk/client-s3/dist-cjs")?.matched).toBe("@aws-sdk/client-s3");
    expect(lookup("left-pad-pro")).toBeNull();
    expect(lookup("./local")).toBeNull();
  });

  it("checks the functions' imports and the package.json next to them", () => {
    const c = checkLibraries(FIXTURE);
    expect(c.packageJson).toBe(join(FIXTURE, "..", "package.json"));
    const by = Object.fromEntries(c.findings.map((f) => [f.module, f]));
    // Imported by a function, cannot run: blocking (what --strict fails on).
    expect(by.sharp).toMatchObject({ verdict: "no", files: ["images.ts"], version: "^0.35.5" });
    expect(c.blocking.map((f) => f.module)).toEqual(["sharp"]);
    // A dependency nobody under convex/ imports: listed, never blocking.
    expect(by.bcrypt).toMatchObject({ verdict: "no", files: [] });
    expect(by.exceljs).toMatchObject({ verdict: "partial", files: ["node/report.ts"] });
    expect(by["node:fs/promises"]).toMatchObject({ verdict: "partial", files: ["images.ts"] });
    expect(by["node:crypto"]).toMatchObject({ verdict: "works", files: ["node/report.ts"] });
    expect(by.openai).toMatchObject({ verdict: "works", version: "^4.70.0" });
    expect(by["left-pad-pro"]).toMatchObject({ verdict: "unknown", files: ["node/report.ts"], version: "^1.0.0" });
    // Rewritten by the codemod, not known, or front-end only: not listed.
    for (const m of ["convex", "convex-helpers", "react"]) expect(by[m], m).toBeUndefined();
    // Sorted worst first.
    expect(c.findings.map((f) => f.verdict)).toEqual([...c.findings.map((f) => f.verdict)].sort((a, b) => ["no", "partial", "unknown", "works"].indexOf(a) - ["no", "partial", "unknown", "works"].indexOf(b)));
    const lines = libraryLines(c).join("\n");
    expect(lines).toMatch(/does not run\s+sharp@\^0\.35\.5 \(imported by images\.ts\)/);
    expect(lines).toMatch(/does not run\s+bcrypt@\^5\.1\.1 \(a dependency the functions do not import\)/);
    expect(lines).toMatch(/unknown\s+left-pad-pro/);
    expect(lines).not.toMatch(/openai/);
    expect(checkLibraries(join(FIXTURE, "missing")).findings).toEqual([]);
  });

  it("the configuration files the conversion skips (auth.config, convex.config) are not checked", () => {
    const src = join(out, "configs", "convex");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "convex.config.ts"), `import { execSync } from "node:child_process";\nexport default execSync;\n`);
    writeFileSync(join(src, "auth.config.js"), `const sharp = require("sharp");\nmodule.exports = { sharp };\n`);
    writeFileSync(join(src, "run.ts"), `import { Worker } from "node:worker_threads";\nexport const w = Worker;\n`);
    expect(checkLibraries(src).findings.map((f) => [f.module, f.files])).toEqual([["node:worker_threads", ["run.ts"]]]);
  });

  it("declaration files (.d.ts, .d.mts, .d.cts) are not run: their imports never block", () => {
    const src = join(out, "decl", "convex");
    mkdirSync(src, { recursive: true });
    for (const ext of ["d.ts", "d.mts", "d.cts"]) writeFileSync(join(src, `types.${ext}`), `import { Sharp } from "sharp";\nexport type Image = Sharp;\n`);
    writeFileSync(join(src, "run.mts"), `import { Worker } from "node:worker_threads";\nexport const w = Worker;\n`);
    const c = checkLibraries(src);
    expect(c.findings.map((f) => [f.module, f.files])).toEqual([["node:worker_threads", ["run.mts"]]]);
  });

  it("the report has a Libraries section", () => {
    const r = migrateConvex({ src: FIXTURE, dryRun: true });
    expect(r.libraries.blocking.map((f) => f.module)).toEqual(["sharp"]);
    expect(r.report).toMatch(/## Libraries \(workerd \+ nodejs_compat\)/);
    expect(r.report).toMatch(/\| `sharp` \^0\.35\.5 \| \*\*does not run\*\* \| `images\.ts` \|/);
  });

  it("--in-place: the check reads the original sources, not the files the conversion writes into them", () => {
    const dir = join(out, "in-place");
    cpSync(join(FIXTURE, ".."), dir, { recursive: true });
    const r = migrateConvex({ src: join(dir, "convex"), inPlace: true, force: true });
    expect(r.written.length).toBeGreaterThan(0);
    const listed = r.libraries.findings.map((f) => f.module);
    expect(listed.filter((m) => m.startsWith("@freecorps/"))).toEqual([]);
    expect(r.libraries.findings).toEqual(checkLibraries(FIXTURE).findings);
  });

  it("warns before converting; --strict fails on a blocking library and writes nothing", async () => {
    const err: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void err.push(a.join(" ")));
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const strictOut = join(out, "strict");
    expect(await migrateCommand(["convex", "--src", FIXTURE, "--out", strictOut, "--strict"])).toBe(1);
    expect(existsSync(strictOut)).toBe(false);
    expect(err.join("\n")).toMatch(/does not run\s+sharp/);
    expect(err.join("\n")).toMatch(/--strict: sharp cannot run in the Worker; nothing was converted/);
    // Without --strict: the same warnings, then the conversion.
    err.length = 0;
    const loose = join(out, "loose");
    expect(await migrateCommand(["convex", "--src", FIXTURE, "--out", loose])).toBe(0);
    expect(err.join("\n")).toMatch(/does not run\s+sharp/);
    expect(existsSync(join(loose, "images.ts"))).toBe(true);
  });
});
