// Bundle cost of the client (PR 4a v0.10, not run in CI): esbuild with minify, from the sources, for small apps that
// import the package's entry point. Each entry below is bundled twice: as one file (what a bundler without code
// splitting ships) and with `splitting` (what Vite/Rollup/webpack do: an `import()` becomes a chunk loaded on use).
//
//   bun packages/client/bench/bundle-size.ts            # this tree
//   bun packages/client/bench/bundle-size.ts <repo>     # another checkout (e.g. a worktree of the base commit)
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";

const repo = resolve(process.argv[2] ?? join(import.meta.dirname, "../../.."));
const src = join(repo, "packages/client/src");
const entries: Record<string, string> = {
  "new EmberClient(...)": `import { EmberClient } from "@freecorps/ember-client";\nglobalThis.c = new EmberClient({ url: "https://x.test" });\n`,
  "EmberClient + multiTab": readFileSync(join(src, "multitab.ts"), "utf8").includes("export function multiTab(")
    ? `import { EmberClient } from "@freecorps/ember-client";\nimport { multiTab } from "@freecorps/ember-client/multitab";\nglobalThis.c = new EmberClient({ url: "https://x.test", multiTab: multiTab() });\n`
    : `import { EmberClient } from "@freecorps/ember-client";\nglobalThis.c = new EmberClient({ url: "https://x.test", multiTab: true });\n`,
};

const dir = mkdtempSync(join(tmpdir(), "ember-bundle-"));
const kib = (n: number) => `${(n / 1024).toFixed(1)} KiB`;
try {
  for (const [name, code] of Object.entries(entries)) {
    const entry = join(dir, "entry.js");
    writeFileSync(entry, code);
    const common = {
      entryPoints: [entry],
      bundle: true,
      minify: true,
      format: "esm" as const,
      platform: "browser" as const,
      conditions: ["@freecorps/ember-source"],
      // The entry lives outside the repo: the package's entry points by path (as its `exports` map them in the repo).
      alias: { "@freecorps/ember-client/multitab": join(src, "multitab.ts"), "@freecorps/ember-client": join(src, "index.ts") },
      logLevel: "error" as const,
      write: false,
    };
    const one = await build({ ...common, outfile: join(dir, "one.js") });
    const whole = one.outputFiles[0]!.contents;
    const split = await build({ ...common, splitting: true, outdir: join(dir, "split"), metafile: true });
    // What loads with the page: the entry and the chunks it imports statically (shared code); the rest is `import()`.
    const outs = split.metafile!.outputs;
    const file = (p: string) => split.outputFiles.find((f) => f.path.endsWith(p.replace(/^.*\//, "/")))!.contents;
    const eager = new Set<string>();
    const walk = (p: string) => {
      if (eager.has(p)) return;
      eager.add(p);
      for (const i of outs[p]!.imports) if (i.kind === "import-statement") walk(i.path);
    };
    walk(Object.keys(outs).find((p) => p.endsWith("entry.js"))!);
    const join_ = (ps: string[]) => Buffer.concat(ps.map((p) => Buffer.from(file(p))));
    const now = join_([...eager]);
    const lazy = join_(Object.keys(outs).filter((p) => p.endsWith(".js") && !eager.has(p)));
    console.log(
      `${name.padEnd(26)} one file ${kib(whole.length)} (gzip ${kib(gzipSync(whole, { level: 9 }).length)}) | split: on load ${kib(now.length)} (gzip ${kib(gzipSync(now, { level: 9 }).length)}), import() ${kib(lazy.length)}`,
    );
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
