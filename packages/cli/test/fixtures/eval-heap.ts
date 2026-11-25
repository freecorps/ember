// Run by test/eval-gc.test.ts in its own Node process (`--expose-gc --max-old-space-size=160`): `ROUNDS`×20 edits of
// a sample project, each followed by `loadProjectCode` (what an `ember dev` save does), and the heap growth after a
// full GC, printed as JSON. `--tla`: the project uses top-level await, so it takes the ES-module fallback.
import { appendFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadProjectCode } from "../../src/build.ts";
import { codegen } from "../../src/codegen/index.ts";
import { loadProject } from "../../src/config.ts";
import { init } from "../../src/init.ts";

const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error("run with --expose-gc");
const tla = process.argv.includes("--tla");
const dir = join(process.argv[2]!, `eval-heap-${tla ? "tla" : "cjs"}-${process.pid}`);
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
try {
  init({ dir, project: "chat" });
  const project = loadProject(dir);
  await codegen(project);
  const file = join(project.dir, "messages.ts");
  if (tla) appendFileSync(file, "\nexport const ready = await Promise.resolve(true);\n");
  console.warn = () => {};
  let n = 0;
  const save = async () => {
    appendFileSync(file, `\nexport const rev${n} = ${n++};\n`);
    await loadProjectCode(project);
  };
  const heap = async () => {
    for (let i = 0; i < 6; i++) {
      gc();
      await new Promise((r) => setTimeout(r, 5));
    }
    return process.memoryUsage().heapUsed / 1024 / 1024;
  };
  for (let i = 0; i < 3; i++) await save();
  const base = await heap();
  const growth: number[] = [];
  for (let k = 0; k < Number(process.env.ROUNDS ?? 5); k++) {
    for (let i = 0; i < 20; i++) await save();
    growth.push(Number(((await heap()) - base).toFixed(2)));
  }
  console.log(JSON.stringify({ edits: n - 3, growthMiB: growth }));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
