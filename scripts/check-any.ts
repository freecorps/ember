// `bun run lint:any` (docs/design/dx.md §3.4): explicit `any` in packages/*/src may only go down. Each file has a budget
// in scripts/any-allowlist.json; a file over its budget (or a new file with any) fails. `--update` rewrites the
// allowlist with the current counts (run it after removing some).
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const root = join(import.meta.dir, "..");
const ALLOWLIST = join(root, "scripts", "any-allowlist.json");
// An explicit `any` type: `: any`, `as any`, `<any>`, `any[]`, `, any`, `any>` ... (not the word in comments or strings).
const ANY = /(?<![\w$."'`])any(?![\w$"'`])/g;

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

function count(text: string): number {
  let n = 0;
  for (const line of text.split("\n")) {
    const code = line.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "").replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""');
    if (/^\s*\*/.test(code)) continue; // inside a block comment
    n += code.match(ANY)?.length ?? 0;
  }
  return n;
}

const counts: Record<string, number> = {};
for (const pkg of readdirSync(join(root, "packages"))) {
  const src = join(root, "packages", pkg, "src");
  try {
    statSync(src);
  } catch {
    continue;
  }
  for (const f of files(src)) {
    const n = count(readFileSync(f, "utf8"));
    if (n) counts[relative(root, f)] = n;
  }
}

if (process.argv.includes("--update")) {
  writeFileSync(ALLOWLIST, JSON.stringify(Object.fromEntries(Object.entries(counts).sort()), null, 2) + "\n");
  console.log(`any allowlist: ${Object.values(counts).reduce((a, b) => a + b, 0)} in ${Object.keys(counts).length} files`);
  process.exit(0);
}

const allowed = JSON.parse(readFileSync(ALLOWLIST, "utf8")) as Record<string, number>;
const over = Object.entries(counts).filter(([f, n]) => n > (allowed[f] ?? 0));
const shrunk = Object.entries(allowed).filter(([f, n]) => (counts[f] ?? 0) < n);
for (const [f, n] of over) console.error(`${f}: ${n} explicit any (allowed ${allowed[f] ?? 0}). Type it, or narrow from unknown.`);
if (shrunk.length) console.log(`any: ${shrunk.length} file(s) below budget; run \`bun scripts/check-any.ts --update\` to lock it in`);
if (over.length) process.exit(1);
console.log(`any: ${Object.values(counts).reduce((a, b) => a + b, 0)} explicit any in packages/*/src, none over budget`);
