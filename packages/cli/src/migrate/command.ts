// `ember migrate convex` argument handling (the codemod itself is in index.ts).

import { writeFileSync } from "node:fs";
import { relative } from "node:path";
import { parseArgs } from "node:util";
import { migrateConvex } from "./index.ts";
import { verifyMigration } from "./verify.ts";

export async function migrateCommand(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      src: { type: "string" },
      out: { type: "string" },
      "in-place": { type: "boolean" },
      "dry-run": { type: "boolean" },
      force: { type: "boolean" },
      report: { type: "string" },
      check: { type: "boolean" },
      verify: { type: "boolean" },
    },
  });
  if (positionals[0] !== "convex") throw new Error("usage: ember migrate convex [--src convex] [--out ember | --in-place] [--dry-run] [--report file.md] [--check] [--verify]");
  if (values["in-place"] && values.out) throw new Error("--in-place and --out are exclusive");
  if (values.verify && values["dry-run"]) throw new Error("--verify needs the converted files: drop --dry-run");
  const r = migrateConvex({
    src: values.src ?? "convex",
    out: values.out ?? "ember",
    ...(values["in-place"] ? { inPlace: true } : {}),
    ...(values["dry-run"] ? { dryRun: true } : {}),
    ...(values.force ? { force: true } : {}),
  });
  if (values.report) {
    writeFileSync(values.report, r.report);
    const review = r.findings.filter((f) => f.severity === "review").length;
    console.log(
      `migrate convex: ${r.sync.converted} functions made synchronous, ${r.sync.blocked} stay async; ${r.manual} manual and ${review} review items → ${values.report}` +
        (values["dry-run"] ? " (dry run)" : ` (${r.written.length} files in ${relative(process.cwd(), r.outDir) || "."}/)`),
    );
  } else process.stdout.write(r.report);
  let code = values.check && r.manual > 0 ? 1 : 0;
  if (values.check && r.manual > 0) console.error(`migrate convex --check: ${r.manual} item(s) need a decision`);
  if (values.verify) {
    const v = await verifyMigration(r.outDir);
    if (v.codegenError) console.error(`codegen failed: ${v.codegenError}`);
    for (const w of v.codegenWarnings) console.warn(`codegen: ${w}`);
    for (const d of v.diagnostics.slice(0, 200)) console.error(`tsc: ${d}`);
    if (v.diagnostics.length > 200) console.error(`tsc: … ${v.diagnostics.length - 200} more`);
    console.log(`verify: ${v.codegenError ? "codegen failed" : "codegen ok"}, ${v.diagnostics.length} type error(s)${v.diagnostics.length ? " (typescript-eslint await-thenable finds leftover awaits)" : ""}`);
    if (v.codegenError || v.diagnostics.length) code = 1;
  }
  return code;
}
