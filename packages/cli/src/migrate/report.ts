// The markdown report of `ember migrate convex`: summary, the items that need a human (manual first), "use node"
// files, generated errors and triggers, then what changed per file and the next steps.

import { relative } from "node:path";
import type { MigrateOptions, MigrateResult } from "./index.ts";

const esc = (s: string) => s.replace(/\|/g, "\\|");

export function renderReport(r: Omit<MigrateResult, "report">, options: MigrateOptions): string {
  const out: string[] = [];
  const to = options.inPlace ? "in place" : `→ ${relative(process.cwd(), r.outDir) || "."}/`;
  const by = (s: string) => r.files.filter((f) => f.status === s).length;
  out.push(`# ember migrate convex`, "");
  out.push(`\`${relative(process.cwd(), r.src) || "."}/\` ${to}${options.dryRun ? " (dry run: nothing written)" : ""}`, "");

  const totals = new Map<string, number>();
  for (const f of r.files) for (const [k, n] of Object.entries(f.changes)) totals.set(k, (totals.get(k) ?? 0) + n);
  const manual = r.findings.filter((f) => f.severity === "manual");
  const review = r.findings.filter((f) => f.severity === "review" && f.code !== "use-node");
  const useNode = r.findings.filter((f) => f.code === "use-node");
  out.push("## Summary", "", "| | |", "|---|---|");
  out.push(`| Files | ${r.files.length}: ${by("converted")} converted, ${by("unchanged")} unchanged, ${by("copied")} copied, ${by("generated")} generated, ${by("skipped")} skipped |`);
  out.push(`| Made synchronous | ${r.sync.converted} functions (${r.sync.handlers} query/mutation handlers, ${r.sync.helpers} helpers) |`);
  out.push(`| Stay async | ${r.sync.blocked} (listed below) |`);
  for (const [k, n] of [...totals].sort((x, y) => y[1] - x[1])) out.push(`| ${esc(k)} | ${n} |`);
  out.push(`| **Needs a decision** | **${manual.length}** manual, ${review.length} to review, ${useNode.length} "use node" files |`, "");

  const item = (f: (typeof r.findings)[number], box: boolean) => `- ${box ? "[ ] " : ""}\`${f.file}:${f.line}\` **${f.code}**: ${f.message}`;
  out.push("## Needs a decision", "");
  out.push(manual.length ? manual.map((f) => item(f, true)).join("\n") : "Nothing: every query and mutation converted.", "");
  if (review.length) out.push("## To review", "", review.map((f) => item(f, false)).join("\n"), "");
  if (useNode.length) out.push('## "use node" files (PLAN §22 L13)', "", "| File | Imports |", "|---|---|", ...useNode.map((f) => `| \`${f.file}\` | ${esc(f.message.replace(/^.*imports: /, ""))} |`), "");
  if (r.errors.length) {
    out.push("## Errors (`errors.ts`)", "", "| Code | From | Sites |", "|---|---|---|");
    for (const e of r.errors) out.push(`| \`${e.code}\` | ${e.code === "AppError" ? "no code" : [...e.raw].map((x) => `\`${esc(x)}\``).join(", ")} | ${e.sites.length} |`);
    out.push("");
  }
  if (r.triggers.length) {
    out.push("## Triggers (`triggers.ts`)", "", ...r.triggers.map((t) => `- \`${t.table}\`: \`${t.module}.${t.name}\``), "");
  }

  out.push("## Per file", "");
  for (const f of r.files) {
    const info = r.findings.filter((x) => x.file === f.file && x.severity === "info");
    const changes = Object.entries(f.changes);
    if (f.status === "copied" || (f.status === "unchanged" && !info.length)) continue;
    out.push(`### \`${f.file}\` (${f.status})`, "");
    if (f.note) out.push(f.note, "");
    if (changes.length) out.push(...changes.map(([k, n]) => `- ${k}: ${n}`));
    const grouped = new Map<string, number[]>();
    for (const x of info) grouped.set(x.message, [...(grouped.get(x.message) ?? []), x.line]);
    for (const [msg, lines] of grouped) out.push(`- line${lines.length > 1 ? "s" : ""} ${lines.join(", ")}: ${msg}`);
    out.push("");
  }
  const copied = r.files.filter((f) => f.status === "copied").map((f) => `\`${f.file}\``);
  if (copied.length) out.push(`Copied as is: ${copied.join(", ")}`, "");

  out.push("## Next steps", "");
  out.push("1. `ember.json` at the project root (`ember init` creates one) with `\"functionsDir\"` pointing at the converted folder.");
  out.push("2. `ember codegen`, then `tsc --noEmit` (or `ember migrate convex --verify`): each remaining error is a place listed above or an API difference.");
  out.push("3. Leftover `await`s on values that are no longer Promises: typescript-eslint `@typescript-eslint/await-thenable` lists them.");
  out.push("4. Data: `ember import convex` (PLAN §22 L4); tests: `@freecorps/ember-testing/convex-test` (L8).", "");
  return out.join("\n");
}
