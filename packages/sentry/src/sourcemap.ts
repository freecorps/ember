// Source maps in pure JS (Source Map Revision 3, tc39.es/ecma426): a base64 VLQ decoder for `mappings`, lookup of a
// generated position by binary search, and index maps (`sections`). No WASM, no dependency.
//
// `mappings` is one group per generated line (`;`), segments per line (`,`), each segment 1, 4 or 5 VLQ fields:
// generated column (relative to the previous segment of the line), then source index, original line, original
// column and name index (each relative to the previous value across the whole map).

const B64 = new Int8Array(128).fill(-1);
for (let i = 0; i < 64; i++) B64["ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".charCodeAt(i)] = i;

/** Five int32 per segment: generated column, source, original line, original column, name (-1 when absent). */
export type LineSegments = Int32Array;

/** Decodes `mappings` into one sorted flat segment array per generated line (0-based lines and columns). */
export function decodeMappings(mappings: string): LineSegments[] {
  const lines: LineSegments[] = [];
  let line: number[] = [];
  let sorted = true;
  let genCol = 0, src = 0, oLine = 0, oCol = 0, name = 0;
  const fields = [0, 0, 0, 0, 0];
  const endLine = () => {
    const arr = Int32Array.from(line);
    if (!sorted) sortSegments(arr);
    lines.push(arr);
    line = [];
    sorted = true;
    genCol = 0;
  };
  let i = 0;
  const n = mappings.length;
  while (i < n) {
    const c = mappings.charCodeAt(i);
    if (c === 59 /* ; */) {
      endLine();
      i++;
      continue;
    }
    if (c === 44 /* , */) {
      i++;
      continue;
    }
    let count = 0;
    while (i < n) {
      const ch = mappings.charCodeAt(i);
      if (ch === 44 || ch === 59) break;
      let value = 0, shift = 0, digit: number;
      do {
        if (i >= n) throw new Error("source map: truncated VLQ");
        const code = mappings.charCodeAt(i++);
        digit = code < 128 ? B64[code]! : -1;
        if (digit < 0) throw new Error(`source map: invalid base64 character ${JSON.stringify(String.fromCharCode(code))}`);
        value += (digit & 31) * 2 ** shift;
        shift += 5;
      } while (digit & 32);
      if (count < 5) fields[count] = value & 1 ? -Math.floor(value / 2) : Math.floor(value / 2);
      count++;
    }
    if (count !== 1 && count !== 4 && count !== 5) throw new Error(`source map: a segment has ${count} fields`);
    const prev = genCol;
    genCol += fields[0]!;
    if (genCol < prev) sorted = false;
    if (count === 1) {
      line.push(genCol, -1, -1, -1, -1);
      continue;
    }
    src += fields[1]!;
    oLine += fields[2]!;
    oCol += fields[3]!;
    if (count === 5) name += fields[4]!;
    line.push(genCol, src, oLine, oCol, count === 5 ? name : -1);
  }
  endLine();
  return lines;
}

function sortSegments(arr: Int32Array) {
  const segs: Int32Array[] = [];
  for (let i = 0; i < arr.length; i += 5) segs.push(arr.slice(i, i + 5));
  segs.sort((a, b) => a[0]! - b[0]!);
  segs.forEach((s, k) => arr.set(s, k * 5));
}

/** Where a generated position came from: 1-based `line`, 0-based `column` (as in the spec). */
export interface OriginalPosition {
  source: string;
  line: number;
  column: number;
  name: string | null;
  /** `sourcesContent` of that source, split in lines, when the map has it. */
  sourceLines: readonly string[] | null;
}

export interface SourceMap {
  /** `line` is 1-based, `column` 0-based (a Sentry frame's `colno` - 1). */
  lookup(line: number, column: number): OriginalPosition | null;
  /**
   * Rough memory weight in bytes (for the LRU): the decoded segments (20 bytes each, 5 to 7 times their VLQ text),
   * per-line arrays, and `sourcesContent` twice (the strings and their split lines), UTF-16.
   */
  readonly weight: number;
}

interface RawMap {
  version?: number;
  sources?: Array<string | null>;
  sourcesContent?: Array<string | null>;
  sourceRoot?: string;
  names?: string[];
  mappings?: string;
  sections?: Array<{ offset: { line: number; column: number }; map: RawMap }>;
}

/** Parses a source map (a JSON string or object). Regular and index maps. Throws on a malformed map. */
export function parseSourceMap(input: string | object): SourceMap {
  const raw = (typeof input === "string" ? JSON.parse(input.replace(/^\)\]\}'[^\n]*\n/, "")) : input) as RawMap;
  if (!raw || typeof raw !== "object") throw new Error("source map: not an object");
  if (Array.isArray(raw.sections)) return indexMap(raw);
  if (typeof raw.mappings !== "string") throw new Error("source map: no mappings");
  const root = raw.sourceRoot ? raw.sourceRoot.replace(/\/?$/, "/") : "";
  // Entries that are not strings (a malformed map) count as absent: no lookup returns them, the weight stays a number.
  const sources = (raw.sources ?? []).map((s) => (typeof s !== "string" ? "" : root && !/^[a-z][a-z0-9+.-]*:|^\//i.test(s) ? root + s : s));
  const names = raw.names ?? [];
  const contents = Array.isArray(raw.sourcesContent) ? raw.sourcesContent : [];
  const split = new Map<number, string[]>();
  const lines = decodeMappings(raw.mappings);
  return {
    weight: weightOf(lines, contents, sources, names),
    lookup(line, column) {
      const segs = lines[line - 1];
      if (!segs || !segs.length) return null;
      // The last segment whose generated column is <= column.
      let lo = 0, hi = segs.length / 5 - 1, at = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (segs[mid * 5]! <= column) {
          at = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      if (at < 0) return null;
      const s = segs[at * 5 + 1]!;
      if (s < 0) return null;
      const nameIdx = segs[at * 5 + 4]!;
      let content = split.get(s);
      if (content === undefined && typeof contents[s] === "string") split.set(s, (content = contents[s]!.split(/\r?\n/)));
      return { source: sources[s] ?? "", line: segs[at * 5 + 2]! + 1, column: segs[at * 5 + 3]!, name: nameIdx >= 0 ? (names[nameIdx] ?? null) : null, sourceLines: content ?? null };
    },
  };
}

/** Per typed array (header, backing store bookkeeping) and per retained string. */
const ARRAY_OVERHEAD = 64;

function weightOf(lines: readonly LineSegments[], contents: ReadonlyArray<string | null>, sources: readonly string[], names: readonly string[]): number {
  let n = 0;
  for (const l of lines) n += l.byteLength + ARRAY_OVERHEAD;
  for (const c of contents) if (typeof c === "string") n += c.length * 4 + ARRAY_OVERHEAD;
  for (const x of sources) n += x.length * 2 + ARRAY_OVERHEAD;
  for (const x of names) n += (typeof x === "string" ? x.length * 2 : 0) + ARRAY_OVERHEAD;
  return n;
}

function indexMap(raw: RawMap): SourceMap {
  const sections = raw.sections!.map((s) => ({ line: s.offset.line, column: s.offset.column, map: parseSourceMap(s.map) }));
  return {
    weight: sections.reduce((n, s) => n + s.map.weight, ARRAY_OVERHEAD * sections.length),
    lookup(line, column) {
      const l0 = line - 1;
      let pick: (typeof sections)[number] | undefined;
      for (const s of sections) {
        if (s.line < l0 || (s.line === l0 && s.column <= column)) pick = s;
        else break;
      }
      if (!pick) return null;
      return pick.map.lookup(l0 - pick.line + 1, l0 === pick.line ? column - pick.column : column);
    },
  };
}

/** `//# sourceMappingURL=` and `//# debugId=` of a generated file (the last of each). */
export function sourceComments(js: string): { sourceMappingURL: string | null; debugId: string | null } {
  const tail = js.length > 4096 ? js.slice(-4096) : js;
  const url = [...tail.matchAll(/\/\/[#@]\s*sourceMappingURL=(\S+)/g)].pop()?.[1] ?? null;
  const id = [...tail.matchAll(/\/\/[#@]\s*debugId=([0-9a-fA-F-]{32,36})/g)].pop()?.[1] ?? null;
  return { sourceMappingURL: url, debugId: id ? normalizeDebugId(id) : null };
}

/** A debug id as lowercase dashed UUID (`//# debugId=` may come without dashes). */
export function normalizeDebugId(id: string): string {
  const hex = id.replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) return id.toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
