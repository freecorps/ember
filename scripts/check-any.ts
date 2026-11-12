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

/** The text with comments and string/template contents blanked (a small scanner: a regex cannot tell `"//"` from `//`). */
function codeOnly(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    const n = text[i + 1];
    if (c === "/" && n === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && n === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) out += text[i++] === "\n" ? "\n" : "";
      i += 2;
    } else if (c === '"' || c === "'" || c === "`") {
      out += '""';
      i++;
      while (i < text.length && text[i] !== c) {
        if (text[i] === "\\") i++;
        // Template expressions are code: count what is inside ${...}.
        else if (c === "`" && text[i] === "$" && text[i + 1] === "{") {
          let depth = 0;
          i++;
          const start = i;
          while (i < text.length) {
            if (text[i] === "{") depth++;
            else if (text[i] === "}" && --depth === 0) break;
            i++;
          }
          out += codeOnly(text.slice(start + 1, i));
        }
        i++;
      }
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const count = (text: string): number => codeOnly(text).match(ANY)?.length ?? 0;

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
