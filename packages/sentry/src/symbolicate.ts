// Symbolication of an event's JS frames against uploaded source maps (consumer side). Maps are found by debug id
// (`debug_meta.images[{ type: "sourcemap", code_file, debug_id }]`) or by `(release, dist, artifact name)`; parsed maps
// stay in a bounded per-isolate LRU, so a busy release parses its bundle once per isolate, not once per event.

import { artifactName, isInApp, stacksOf, type SentryEvent, type StackFrame } from "./event.ts";
import { parseSourceMap, type SourceMap } from "./sourcemap.ts";

/** A least-recently-used cache bounded by entries and by total weight. */
export class Lru<V extends { weight: number }> {
  private readonly map = new Map<string, V>();
  private total = 0;
  constructor(
    readonly maxEntries: number,
    readonly maxWeight: number,
  ) {}
  get(k: string): V | undefined {
    const v = this.map.get(k);
    if (v !== undefined) {
      this.map.delete(k);
      this.map.set(k, v);
    }
    return v;
  }
  set(k: string, v: V): void {
    const old = this.map.get(k);
    if (old) {
      this.total -= old.weight;
      this.map.delete(k);
    }
    // One map heavier than the whole budget is used for this batch but not kept.
    if (v.weight > this.maxWeight) return;
    this.map.set(k, v);
    this.total += v.weight;
    while (this.map.size > this.maxEntries || this.total > this.maxWeight) {
      const first = this.map.keys().next().value as string;
      this.total -= this.map.get(first)!.weight;
      this.map.delete(first);
    }
  }
  get size(): number {
    return this.map.size;
  }
  get weight(): number {
    return this.total;
  }
  clear(): void {
    this.map.clear();
    this.total = 0;
  }
}

/** Parsed maps by content hash, shared by every batch of this isolate (64 maps, ~48 MB by `SourceMap.weight`: decoded segments and sources). */
export const mapCache = new Lru<SourceMap>(64, 48 * 1024 * 1024);

/** What to look up for one event: artifact names of its frames and the debug ids its `debug_meta` names. */
export function lookupsOf(e: SentryEvent): { names: string[]; debugIds: string[] } {
  const names = new Set<string>();
  for (const frames of stacksOf(e)) for (const f of frames) if (f.lineno && (f.abs_path || f.filename)) names.add(artifactName(f.abs_path ?? f.filename!));
  const debugIds = new Set<string>();
  for (const im of e.debug_meta?.images ?? []) if (im?.type === "sourcemap" && im.debug_id) debugIds.add(im.debug_id.toLowerCase());
  return { names: [...names], debugIds: [...debugIds] };
}

const CONTEXT = 5;

/**
 * Rewrites the event's frames in place with `mapFor(frame)` (a parsed map or null). A symbolicated frame keeps where
 * it came from in `data` (`minified: "file:line:col"`, `sourcemap`). Returns how many frames were mapped.
 */
export async function symbolicate(e: SentryEvent, mapFor: (f: StackFrame, debugId: string | undefined) => Promise<{ map: SourceMap; key: string } | null>): Promise<number> {
  const debugIdOf = new Map<string, string>();
  for (const im of e.debug_meta?.images ?? []) if (im?.type === "sourcemap" && im.code_file && im.debug_id) debugIdOf.set(im.code_file, im.debug_id.toLowerCase());
  let mapped = 0;
  for (const frames of stacksOf(e)) {
    // Frames are oldest first: the token at a caller's position is the call, and its original name is the name of
    // the function the next frame runs in (a minified `g(...)` called from there is `greet`).
    const found = await Promise.all(frames.map(async (f) => {
      const path = f.abs_path ?? f.filename;
      if (!path || !f.lineno || f.data?.symbolicated) return null;
      const m = await mapFor(f, debugIdOf.get(path));
      const pos = m?.map.lookup(f.lineno, Math.max(0, (f.colno ?? 1) - 1));
      return m && pos ? { key: m.key, pos, path } : null;
    }));
    for (const [k, f] of frames.entries()) {
      const hit = found[k];
      if (!hit) continue;
      const { pos, path } = hit;
      const minified = `${path}:${f.lineno}:${f.colno ?? 0}`;
      const fn = found[k - 1]?.pos.name ?? f.function;
      f.data = { ...(f.data ?? {}), symbolicated: true, minified, sourcemap: hit.key, ...(f.function && f.function !== fn ? { minifiedFunction: f.function } : {}) };
      f.abs_path = pos.source;
      f.filename = pos.source.replace(/^webpack:\/\/[^/]*\//, "").replace(/^\.\//, "");
      f.lineno = pos.line;
      f.colno = pos.column + 1;
      if (fn) f.function = fn;
      delete f.in_app;
      f.in_app = isInApp(f);
      if (pos.sourceLines) {
        const i = pos.line - 1;
        f.pre_context = pos.sourceLines.slice(Math.max(0, i - CONTEXT), i).map(clipLine);
        f.context_line = clipLine(pos.sourceLines[i] ?? "");
        f.post_context = pos.sourceLines.slice(i + 1, i + 1 + CONTEXT).map(clipLine);
      }
      mapped++;
    }
  }
  return mapped;
}

const clipLine = (s: string) => (s.length > 300 ? s.slice(0, 299) + "…" : s);

/** Loads (or reuses) a parsed map by its content hash; `fetch` returns the map's text or null. */
export async function cachedMap(sha256: string, fetch: () => Promise<string | null>, cache: Lru<SourceMap> = mapCache): Promise<SourceMap | null> {
  const hit = cache.get(sha256);
  if (hit) return hit;
  const text = await fetch();
  if (text === null) return null;
  let map: SourceMap;
  try {
    map = parseSourceMap(text);
  } catch (e) {
    console.error(`ember-sentry: source map ${sha256} is malformed: ${(e as Error).message}`);
    return null;
  }
  cache.set(sha256, map);
  return map;
}
