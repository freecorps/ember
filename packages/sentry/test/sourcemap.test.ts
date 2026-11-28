// VLQ decoding against mappings worked out by hand, lookups by binary search, index maps, and a minified stack
// symbolicated against a hand-made map (expected original file, line, column and name).
import { describe, expect, it } from "vitest";
import { decodeMappings, normalizeDebugId, parseSourceMap, sourceComments } from "../src/sourcemap.ts";
import { Lru, cachedMap, symbolicate } from "../src/symbolicate.ts";
import { artifactName, fingerprintOf, parseStack, stackText, type SentryEvent } from "../src/event.ts";

const segs = (a: Int32Array) => Array.from({ length: a.length / 5 }, (_, i) => [...a.slice(i * 5, i * 5 + 5)]);

describe("decodeMappings", () => {
  it("decodes known segments: 4 and 5 fields, relative values, new lines reset the column only", () => {
    // AAAA = [0,0,0,0]; SAASA = [+9,0,0,+9,0]; IAAI = [+4,0,0,+4]; `;`; AACA = [0,0,+1,0]: the original column stays
    // relative across lines (13), only the generated column restarts at 0.
    const lines = decodeMappings("AAAA,SAASA,IAAI;AACA");
    expect(lines.map(segs)).toEqual([
      [
        [0, 0, 0, 0, -1],
        [9, 0, 0, 9, 0],
        [13, 0, 0, 13, -1],
      ],
      [[0, 0, 1, 13, -1]],
    ]);
  });

  it("multi-digit and negative values; 1-field segments; empty lines", () => {
    // gB = 32 → +16 (then A,A,A: 4 fields); D = -1; 1-field segment "E" = column +2
    expect(decodeMappings("gBAAA,E;;DACD").map(segs)).toEqual([[[16, 0, 0, 0, -1], [18, -1, -1, -1, -1]], [], [[-1, 0, 1, -1, -1]]]);
  });

  it("rejects a bad character and a segment with 2 or 3 fields", () => {
    expect(() => decodeMappings("AA*A")).toThrow(/invalid base64/);
    expect(() => decodeMappings("AA")).toThrow(/2 fields/);
  });
});

// src/app.ts (original):
//   0: function greet(name) {
//   1:   throw new Error("boom " + name);
//   2: }
//   3: greet("x");
// app.min.js (generated, one line):
//   function g(n){throw new Error("boom "+n)}g("x");
//   0        9    14    20             41
// Segments (generated col → original line:col, name): 0→0:0, 9→0:9 greet, 14→1:2, 20→1:8, 41→3:0 greet
// Relative VLQ: AAAA, SAASA, KACP (+5, 0, +1, -7), MAAM (+6, 0, 0, +6), qBAERA (+21, 0, +2, -8, 0).
const SOURCE = 'function greet(name) {\n  throw new Error("boom " + name);\n}\ngreet("x");\n';
const MAP = JSON.stringify({ version: 3, file: "app.min.js", sources: ["src/app.ts"], sourcesContent: [SOURCE], names: ["greet"], mappings: "AAAA,SAASA,KACP,MAAM,qBAERA" });

describe("parseSourceMap", () => {
  it("looks a generated position up: the last segment at or before the column", () => {
    const m = parseSourceMap(MAP);
    expect(m.lookup(1, 20)).toMatchObject({ source: "src/app.ts", line: 2, column: 8, name: null });
    expect(m.lookup(1, 25)).toMatchObject({ line: 2, column: 8 });
    expect(m.lookup(1, 9)).toMatchObject({ line: 1, column: 9, name: "greet" });
    expect(m.lookup(1, 41)).toMatchObject({ line: 4, column: 0, name: "greet" });
    expect(m.lookup(2, 0)).toBeNull();
    expect(m.lookup(1, 20)!.sourceLines![1]).toBe('  throw new Error("boom " + name);');
  });

  it("sourceRoot prefixes relative sources; index maps (sections) offset lines and columns", () => {
    expect(parseSourceMap({ ...JSON.parse(MAP), sourceRoot: "webpack://app" }).lookup(1, 0)!.source).toBe("webpack://app/src/app.ts");
    const index = parseSourceMap({ version: 3, sections: [{ offset: { line: 0, column: 0 }, map: { version: 3, sources: ["a.ts"], names: [], mappings: "AAAA" } }, { offset: { line: 2, column: 10 }, map: JSON.parse(MAP) }] });
    expect(index.lookup(1, 5)).toMatchObject({ source: "a.ts", line: 1, column: 0 });
    // Line 3, column 10 + 41 is column 41 of the second section's first line.
    expect(index.lookup(3, 51)).toMatchObject({ source: "src/app.ts", line: 4, name: "greet" });
    expect(index.lookup(4, 9)).toBeNull();
  });

  it("reads sourceMappingURL and debugId comments; debug ids are normalized", () => {
    const js = `x();\n//# debugId=8A0B6F4C1E2D4F3A9B8C7D6E5F4A3B2C\n//# sourceMappingURL=app.min.js.map\n`;
    expect(sourceComments(js)).toEqual({ sourceMappingURL: "app.min.js.map", debugId: "8a0b6f4c-1e2d-4f3a-9b8c-7d6e5f4a3b2c" });
    expect(normalizeDebugId("8a0b6f4c-1e2d-4f3a-9b8c-7d6e5f4a3b2c")).toBe("8a0b6f4c-1e2d-4f3a-9b8c-7d6e5f4a3b2c");
  });
});

describe("symbolicate", () => {
  const minifiedStack = 'Error: boom x\n    at g (https://cdn.example.com/assets/app.min.js?v=3:1:21)\n    at https://cdn.example.com/assets/app.min.js?v=3:1:42';

  it("a minified stack maps back to file, line, column, the function name and source context", async () => {
    const frames = parseStack(minifiedStack);
    expect(frames.map((f) => [f.function, f.lineno, f.colno])).toEqual([
      [undefined, 1, 42],
      ["g", 1, 21],
    ]);
    const e: SentryEvent = { release: "1.0.0", exception: { values: [{ type: "Error", value: "boom x", stacktrace: { frames } }] } };
    const asked: string[] = [];
    const map = parseSourceMap(MAP);
    const n = await symbolicate(e, async (f) => (asked.push(artifactName(f.abs_path!)), { map, key: "sha" }));
    expect(n).toBe(2);
    expect(asked).toEqual(["~/assets/app.min.js", "~/assets/app.min.js"]);
    const [outer, inner] = e.exception!.values![0]!.stacktrace!.frames!;
    expect(inner).toMatchObject({ filename: "src/app.ts", abs_path: "src/app.ts", lineno: 2, colno: 9, function: "greet", context_line: '  throw new Error("boom " + name);', in_app: true });
    expect(inner!.pre_context).toEqual(["function greet(name) {"]);
    expect(inner!.post_context).toEqual(["}", 'greet("x");', ""]);
    expect(inner!.data).toMatchObject({ symbolicated: true, minified: "https://cdn.example.com/assets/app.min.js?v=3:1:21", minifiedFunction: "g", sourcemap: "sha" });
    expect(outer).toMatchObject({ filename: "src/app.ts", lineno: 4, colno: 1 });
    expect(stackText(e)).toContain("at greet (src/app.ts:2:9)");
    // Symbolicating twice changes nothing (frames are marked).
    expect(await symbolicate(e, async () => ({ map, key: "sha" }))).toBe(0);
  });

  it("minified builds of the same code group together once symbolicated (the fingerprint uses original frames)", async () => {
    const build = (url: string, col: number) => ({ release: "1", exception: { values: [{ type: "Error", value: "boom x", stacktrace: { frames: parseStack(`Error\n    at g (${url}:1:${col})\n    at ${url}:1:42`) } }] } }) as SentryEvent;
    const a = build("https://cdn.example.com/assets/app.min.js", 21);
    const b = build("https://cdn.example.com/assets/app.min.js", 25);
    expect(await fingerprintOf(a)).not.toBe(await fingerprintOf(build("https://cdn.example.com/assets/other.js", 21)));
    const map = parseSourceMap(MAP);
    await symbolicate(a, async () => ({ map, key: "k" }));
    await symbolicate(b, async () => ({ map, key: "k" }));
    expect(await fingerprintOf(a)).toBe(await fingerprintOf(b));
  });

  it("artifact names: URL path, app:/// bundles, absolute and relative paths", () => {
    expect(artifactName("https://x.com/assets/app.js?v=1#h")).toBe("~/assets/app.js");
    expect(artifactName("app:///main.jsbundle")).toBe("~/main.jsbundle");
    expect(artifactName("/index.js")).toBe("~/index.js");
    expect(artifactName("index.js")).toBe("~/index.js");
    expect(artifactName("~/a/b.js")).toBe("~/a/b.js");
  });
});

describe("Lru", () => {
  it("evicts the least recently used by entries and by weight; a map heavier than the budget is not kept", async () => {
    const lru = new Lru<{ weight: number }>(2, 100);
    lru.set("a", { weight: 10 });
    lru.set("b", { weight: 10 });
    lru.get("a");
    lru.set("c", { weight: 10 });
    expect([lru.get("a"), lru.get("b"), lru.get("c")].map(Boolean)).toEqual([true, false, true]);
    lru.set("d", { weight: 95 });
    expect([lru.size, lru.weight]).toEqual([1, 95]);
    lru.set("e", { weight: 500 });
    expect(lru.get("e")).toBeUndefined();
  });

  it("a map's weight counts its decoded segments (20 bytes each, more than their VLQ text) and sources twice", () => {
    // 100k one-field segments (",C": 2 characters of text each), 20 bytes each decoded.
    const mappings = "A" + ",C".repeat(100_000);
    const m = parseSourceMap({ version: 3, sources: ["a.ts"], sourcesContent: ["x".repeat(1000)], names: [], mappings });
    expect(m.weight).toBeGreaterThanOrEqual(100_001 * 20 + 1000 * 4);
    expect(m.weight).toBeGreaterThan(mappings.length * 5);
    // An index map weighs its sections (not the length of its JSON text).
    const idx = parseSourceMap(JSON.stringify({ version: 3, sections: [{ offset: { line: 0, column: 0 }, map: { version: 3, sources: ["a.ts"], names: [], mappings } }] }));
    expect(idx.weight).toBeGreaterThanOrEqual(100_001 * 20);
  });

  it("entries of sources/sourcesContent that are not strings count as absent: the weight stays a number, the LRU evicts", () => {
    const bad = parseSourceMap({ version: 3, sources: ["a.js", 7], sourcesContent: [1, null], names: [], mappings: "AAAA" });
    expect(Number.isFinite(bad.weight)).toBe(true);
    expect(bad.lookup(1, 0)).toMatchObject({ source: "a.js", sourceLines: null });
    expect(Number.isFinite(parseSourceMap({ version: 3, sources: ["a.js"], sourcesContent: {}, mappings: "AAAA" }).weight)).toBe(true);
    const lru = new Lru<{ weight: number }>(10, 1000);
    lru.set("bad", bad);
    lru.set("big", { weight: 900 });
    expect(Number.isFinite(lru.weight)).toBe(true);
    expect(lru.size).toBe(1);
  });

  it("cachedMap parses a map once per hash", async () => {
    const lru = new Lru<ReturnType<typeof parseSourceMap>>(4, 1 << 20);
    let fetches = 0;
    const load = async () => (fetches++, MAP);
    const a = await cachedMap("h1", load, lru);
    const b = await cachedMap("h1", load, lru);
    expect(a).toBe(b);
    expect(fetches).toBe(1);
    expect(await cachedMap("bad", async () => "{not json", lru)).toBeNull();
  });
});
