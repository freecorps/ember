// `writeWorkerOutput` (build.ts): what a split Worker build leaves in its out dir. Every output must be index.js, a
// chunk or the map of one (checked before anything is written), and an earlier build's chunks go only once this
// build is on disk.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeWorkerOutput } from "../src/build.ts";

const dirs: string[] = [];
const outDir = () => {
  const d = mkdtempSync(join(tmpdir(), "ember-build-output-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const file = (dir: string, name: string, text = `// ${name}`) => ({ path: join(dir, name), contents: new TextEncoder().encode(text), text });

describe("writeWorkerOutput", () => {
  it("writes index.js, chunks and their maps, then removes an earlier build's chunks", () => {
    const dir = outDir();
    writeFileSync(join(dir, "chunk-OLD234.js"), "old");
    writeFileSync(join(dir, "chunk-OLD234.js.map"), "{}");
    const { text, code } = writeWorkerOutput(dir, [file(dir, "index.js"), file(dir, "index.js.map", "{}"), file(dir, "chunk-NEW567.js"), file(dir, "chunk-NEW567.js.map", "{}")]);
    expect(code).toBe("// index.js");
    expect([...text.keys()].sort()).toEqual(["chunk-NEW567.js", "chunk-NEW567.js.map", "index.js", "index.js.map"]);
    expect(readdirSync(dir).sort()).toEqual(["chunk-NEW567.js", "chunk-NEW567.js.map", "index.js", "index.js.map"]);
  });

  it("a chunk name CHUNK_RE does not know, or a stray map, fails before anything is written", () => {
    for (const odd of ["chunk-new567.js", "other.js", "foo.js.map", "chunk-new567.js.map"]) {
      const dir = outDir();
      writeFileSync(join(dir, "chunk-OLD234.js"), "old");
      expect(() => writeWorkerOutput(dir, [file(dir, "index.js"), file(dir, odd)])).toThrow(`unexpected Worker build output ${odd}`);
      expect(readdirSync(dir)).toEqual(["chunk-OLD234.js"]);
    }
  });

  it("a write that fails leaves the earlier build's chunks in place", () => {
    const dir = outDir();
    writeFileSync(join(dir, "chunk-OLD234.js"), "old");
    // A directory where a chunk goes: writing it throws (EISDIR).
    mkdirSync(join(dir, "chunk-NEW567.js"));
    expect(() => writeWorkerOutput(dir, [file(dir, "index.js"), file(dir, "chunk-NEW567.js")])).toThrow();
    expect(existsSync(join(dir, "chunk-OLD234.js"))).toBe(true);
  });
});
