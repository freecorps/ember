// The project's code is evaluated on every `ember dev` rebuild. It must not stay in memory once dropped: an ES module
// never leaves Node's module map, so importing a new bundle per rebuild grew the heap with each save. `loadProjectCode`
// runs a CommonJS bundle as a function instead (build.ts); only code with top-level await falls back to `import()`.
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setFlagsFromString } from "node:v8";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { loadProjectCode } from "../src/build.ts";
import { codegen } from "../src/codegen/index.ts";
import { SOURCE_CONDITION } from "../src/source.ts";
import { cleanup, sampleProject, TMP } from "./helpers.ts";

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;
const collect = async () => {
  for (let i = 0; i < 4; i++) {
    gc();
    await new Promise((r) => setImmediate(r));
  }
};

const project = sampleProject("evalgc");
afterAll(() => cleanup(project));

let rev = 0;
/** Edits the project (as a save does), loads it and keeps only a weak reference to what it evaluated. */
async function loadWeak() {
  appendFileSync(join(project.dir, "messages.ts"), `\nexport const rev${rev} = ${rev++};\n`);
  const loaded = await loadProjectCode(project);
  expect(Object.keys(loaded.modules)).toContain("messages");
  return new WeakRef(loaded.modules.messages!);
}

describe("evaluating the project's code (ember dev rebuilds)", () => {
  it("what an evaluation produced is garbage once dropped (no module stays loaded)", async () => {
    await codegen(project);
    const refs = [await loadWeak(), await loadWeak(), await loadWeak()];
    await collect();
    expect(refs.map((r) => r.deref() === undefined)).toEqual([true, true, true]);
  });

  it("the heap does not grow with the number of rebuilds (100 edits under a 160 MB heap; the import() fallback does)", () => {
    // In its own process with a capped heap: V8 keeps compiled code of evaluated scripts as a cache it drops only
    // under memory pressure, so an uncapped heap grows either way; a module Node keeps is never dropped.
    const run = (...flags: string[]) => {
      const r = spawnSync(
        process.execPath,
        ["--expose-gc", "--max-old-space-size=160", "--experimental-transform-types", "--no-warnings", `--conditions=${SOURCE_CONDITION}`, fileURLToPath(new URL("./fixtures/eval-heap.ts", import.meta.url)), TMP, ...flags],
        { encoding: "utf8", env: { ...process.env, ROUNDS: "5" }, timeout: 120_000 },
      );
      if (r.status !== 0) throw new Error(`eval-heap exited ${r.status}: ${r.stderr.slice(-2000)}`);
      return JSON.parse(r.stdout.trim().split("\n").pop()!) as { edits: number; growthMiB: number[] };
    };
    const cjs = run();
    const esm = run("--tla");
    console.log(`eval-gc: heap growth over ${cjs.edits} edits, CommonJS eval ${cjs.growthMiB.join(" / ")} MiB, import() ${esm.growthMiB.join(" / ")} MiB`);
    expect(Math.max(...cjs.growthMiB)).toBeLessThan(16);
    // The fallback keeps every module: it grows with each edit (about 0.35 MiB each for the sample).
    expect(esm.growthMiB.at(-1)!).toBeGreaterThan(2 * Math.max(...cjs.growthMiB));
    expect(esm.growthMiB.at(-1)!).toBeGreaterThan(esm.growthMiB[0]!);
  });

  it("import.meta read as an object and a computed import() work in the CommonJS evaluation", async () => {
    const file = join(project.dir, "messages.ts");
    const extra = [
      "",
      "const { url: metaUrl } = import.meta;",
      "export const meta = { url: metaUrl, dirname: import.meta.dirname, keys: Object.keys(import.meta).sort() };",
      'export const dynamic = import(String("node:path")).then((m) => typeof m.join);',
      "",
    ].join("\n");
    appendFileSync(file, extra);
    try {
      const m = (await loadProjectCode(project)).modules.messages as { meta: { url: string; dirname: string; keys: string[] }; dynamic: Promise<string> };
      expect(m.meta.url).toMatch(/^file:.*ember-eval\.cjs$/);
      expect(m.meta.dirname).toBe(join(project.stateDir, "build"));
      expect(m.meta.keys).toEqual(["dirname", "filename", "resolve", "url"]);
      await expect(m.dynamic).resolves.toBe("function");
    } finally {
      writeFileSync(file, readFileSync(file, "utf8").replace(extra, ""));
    }
  });

  it("code with top-level await still loads (as an ES module, which Node keeps), with one warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const file = join(project.dir, "messages.ts");
    appendFileSync(file, "\nexport const ready = await Promise.resolve(true);\n");
    try {
      const ref = await loadWeak();
      await loadWeak();
      await collect();
      // The fallback's module is kept by Node: the reason `ember dev` avoids it.
      expect(ref.deref()).toBeDefined();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toMatch(/top-level await/);
    } finally {
      warn.mockRestore();
      writeFileSync(file, readFileSync(file, "utf8").replace("\nexport const ready = await Promise.resolve(true);\n", ""));
    }
  });

  it("import.meta.resolve keeps ES module resolution (an exports entry with only \"import\"; builtins as node:)", async () => {
    // Runs after the top-level await test: the one-time warning is already spent.
    const pkg = join(project.root, "node_modules", "esm-only-pkg");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "esm-only-pkg", type: "module", exports: { "./config.json": { import: "./config.json" } } }));
    writeFileSync(join(pkg, "config.json"), "{}");
    const file = join(project.dir, "messages.ts");
    const extra = '\nexport const resolved = { cfg: import.meta.resolve("esm-only-pkg/config.json"), fs: import.meta.resolve("fs") };\n';
    appendFileSync(file, extra);
    try {
      const m = (await loadProjectCode(project)).modules.messages as { resolved: { cfg: string; fs: string } };
      expect(m.resolved.cfg).toBe(pathToFileURL(join(pkg, "config.json")).href);
      expect(m.resolved.fs).toBe("node:fs");
    } finally {
      writeFileSync(file, readFileSync(file, "utf8").replace(extra, ""));
    }
  });
});
