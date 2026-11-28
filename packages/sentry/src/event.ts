// Sentry events as this component reads them (the public event payload: develop.sentry.dev/sdk/data-model/event-payloads):
// frames, grouping (fingerprint, title, culprit), stack text, and JS stack-string parsing for errors captured here.

export interface StackFrame {
  filename?: string;
  abs_path?: string;
  module?: string;
  function?: string;
  lineno?: number;
  colno?: number;
  in_app?: boolean;
  pre_context?: string[];
  context_line?: string;
  post_context?: string[];
  /** Set by symbolication: the minified position it came from. */
  data?: { [k: string]: unknown };
  [k: string]: unknown;
}

export interface ExceptionValue {
  type?: string;
  value?: string;
  module?: string;
  stacktrace?: { frames?: StackFrame[] };
  mechanism?: { type?: string; handled?: boolean };
  [k: string]: unknown;
}

export type Level = "fatal" | "error" | "warning" | "info" | "debug";
export const LEVELS: readonly Level[] = ["fatal", "error", "warning", "info", "debug"];

export interface SentryEvent {
  event_id?: string;
  timestamp?: number | string;
  level?: string;
  platform?: string;
  release?: string;
  dist?: string;
  environment?: string;
  message?: string | { formatted?: string; message?: string };
  logentry?: { message?: string; formatted?: string };
  transaction?: string;
  culprit?: string;
  fingerprint?: string[];
  exception?: { values?: ExceptionValue[] };
  stacktrace?: { frames?: StackFrame[] };
  threads?: { values?: Array<{ stacktrace?: { frames?: StackFrame[] }; crashed?: boolean; current?: boolean }> };
  debug_meta?: { images?: Array<{ type?: string; code_file?: string; debug_id?: string }> };
  breadcrumbs?: unknown;
  contexts?: { [k: string]: unknown };
  tags?: unknown;
  user?: unknown;
  [k: string]: unknown;
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const FRAME_STRINGS = ["filename", "abs_path", "module", "function", "context_line"] as const;
const EVENT_STRINGS = ["event_id", "level", "platform", "release", "dist", "environment", "transaction", "culprit"] as const;

function cleanFrames(st: unknown): { frames: StackFrame[] } | undefined {
  if (!isObj(st) || !Array.isArray(st.frames)) return undefined;
  const frames = st.frames.filter(isObj).map((x) => {
    const f: StackFrame = { ...x };
    for (const k of FRAME_STRINGS) if (f[k] !== undefined && typeof f[k] !== "string") delete f[k];
    for (const k of ["lineno", "colno"] as const) if (f[k] !== undefined && !(typeof f[k] === "number" && Number.isFinite(f[k]))) delete f[k];
    if (f.in_app !== undefined && typeof f.in_app !== "boolean") delete f.in_app;
    for (const k of ["pre_context", "post_context"] as const) if (f[k] !== undefined && !(Array.isArray(f[k]) && f[k].every((l) => typeof l === "string"))) delete f[k];
    if (f.data !== undefined && !isObj(f.data)) delete f.data;
    return f;
  });
  return { ...st, frames };
}

/**
 * The event with the shapes this component reads made safe (an SDK or a client may send anything that is JSON):
 * `exception.values`, frames, threads and `debug_meta.images` keep only objects, and the fields read as strings or
 * numbers are dropped when they are not. Everything else is kept as sent.
 */
export function normalizeEvent(input: SentryEvent): SentryEvent {
  const e: SentryEvent = { ...input };
  for (const k of EVENT_STRINGS) if (e[k] !== undefined && typeof e[k] !== "string") delete e[k];
  if (e.fingerprint !== undefined && !Array.isArray(e.fingerprint)) delete e.fingerprint;
  if (e.message !== undefined && typeof e.message !== "string" && !isObj(e.message)) delete e.message;
  if (e.logentry !== undefined && !isObj(e.logentry)) delete e.logentry;
  for (const k of ["message", "logentry"] as const) {
    const o = e[k];
    if (!isObj(o)) continue;
    const c: Record<string, unknown> = { ...o };
    for (const f of ["message", "formatted"]) if (c[f] !== undefined && typeof c[f] !== "string") delete c[f];
    e[k] = c as { message?: string; formatted?: string };
  }
  if (e.exception !== undefined) {
    const values = isObj(e.exception) && Array.isArray(e.exception.values) ? e.exception.values : [];
    e.exception = {
      ...(isObj(e.exception) ? e.exception : {}),
      values: values.filter(isObj).map((x) => {
        const y: ExceptionValue = { ...x };
        for (const k of ["type", "value", "module"] as const) if (y[k] !== undefined && typeof y[k] !== "string") delete y[k];
        const st = cleanFrames(y.stacktrace);
        if (st) y.stacktrace = st;
        else delete y.stacktrace;
        return y;
      }),
    };
  }
  if (e.stacktrace !== undefined) {
    const st = cleanFrames(e.stacktrace);
    if (st) e.stacktrace = st;
    else delete e.stacktrace;
  }
  if (e.threads !== undefined) {
    const values = isObj(e.threads) && Array.isArray(e.threads.values) ? e.threads.values : [];
    e.threads = {
      values: values.filter(isObj).map((t) => {
        const st = cleanFrames(t.stacktrace);
        const { stacktrace: _s, ...rest } = t;
        return { ...rest, ...(st ? { stacktrace: st } : {}) } as { stacktrace?: { frames?: StackFrame[] }; crashed?: boolean; current?: boolean };
      }),
    };
  }
  if (e.debug_meta !== undefined) {
    const images = isObj(e.debug_meta) && Array.isArray(e.debug_meta.images) ? e.debug_meta.images : [];
    e.debug_meta = {
      ...(isObj(e.debug_meta) ? e.debug_meta : {}),
      images: images.filter(isObj).map((im) => {
        const y = { ...im } as Record<string, unknown>;
        for (const k of ["type", "code_file", "debug_id"]) if (y[k] !== undefined && typeof y[k] !== "string") delete y[k];
        return y as { type?: string; code_file?: string; debug_id?: string };
      }),
    };
  }
  return e;
}

/** Every stack of the event (exceptions, then the top-level or thread stack), frames oldest first as sent. */
export function stacksOf(e: SentryEvent): StackFrame[][] {
  const out: StackFrame[][] = [];
  for (const x of e.exception?.values ?? []) if (x?.stacktrace?.frames?.length) out.push(x.stacktrace.frames);
  if (e.stacktrace?.frames?.length) out.push(e.stacktrace.frames);
  for (const t of e.threads?.values ?? []) if ((t.crashed || t.current) && t.stacktrace?.frames?.length) out.push(t.stacktrace.frames);
  return out;
}

/** A frame is in-app when it says so; otherwise when it does not come from node_modules or the runtime. */
export function isInApp(f: StackFrame): boolean {
  if (typeof f.in_app === "boolean") return f.in_app;
  const p = f.abs_path ?? f.filename ?? "";
  if (!p || p === "<anonymous>" || p.startsWith("node:") || p === "native") return false;
  return !/(^|[/\\])node_modules[/\\]/.test(p);
}

/**
 * The artifact name a frame's file is uploaded under: `~/` + the URL path (`https://x.com/assets/app.js?v=1` →
 * `~/assets/app.js`; `app:///main.jsbundle` → `~/main.jsbundle`; `/index.js` → `~/index.js`). `ember sentry sourcemaps
 * upload` names files the same way.
 */
export function artifactName(path: string): string {
  let p = path.split("#")[0]!.split("?")[0]!;
  const m = /^[a-z][a-z0-9+.-]*:\/\/[^/]*(\/.*)?$/i.exec(p);
  if (m) p = m[1] ?? "/";
  if (p.startsWith("~/")) return p;
  return "~" + (p.startsWith("/") ? p : "/" + p);
}

/** Lowercased, digits/hex/uuids folded: `User 42 not found (id 9f2c…)` and `User 7 not found` group together. */
export function normalizeMessage(s: string): string {
  return s
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/\b0x[0-9a-f]+\b/gi, "<hex>")
    .replace(/\b[0-9a-f]{16,}\b/gi, "<hex>")
    .replace(/\d+(\.\d+)?/g, "<n>")
    .slice(0, 512);
}

export function messageOf(e: SentryEvent): string {
  if (typeof e.message === "string") return e.message;
  return e.logentry?.message ?? e.logentry?.formatted ?? (typeof e.message === "object" ? (e.message?.message ?? e.message?.formatted) : undefined) ?? "";
}

/** The file a frame is grouped by: its module, else the file name without query, hash or a content hash. */
function frameFile(f: StackFrame): string {
  if (f.module) return f.module;
  const p = (f.filename ?? f.abs_path ?? "").split("?")[0]!.split("#")[0]!;
  const base = p.split(/[/\\]/).pop() ?? p;
  return base.replace(/[.-][0-9a-f]{6,}(?=\.)/gi, "");
}

/** The grouping components of the event (`fingerprint` hashes them): what Sentry's default grouping looks at. */
export function groupingComponents(e: SentryEvent, maxFrames = 5): string[] {
  const parts: string[] = [];
  const values = e.exception?.values ?? [];
  if (values.length) {
    for (const x of values) {
      const frames = (x.stacktrace?.frames ?? []).filter(isInApp).slice(-maxFrames);
      parts.push(`type:${x.type ?? "Error"}`);
      if (frames.length) for (const f of frames) parts.push(`frame:${frameFile(f)}:${f.function ?? "?"}`);
      else parts.push(`value:${normalizeMessage(x.value ?? "")}`);
    }
    return parts;
  }
  const frames = stacksOf(e)[0]?.filter(isInApp).slice(-maxFrames) ?? [];
  if (frames.length) {
    for (const f of frames) parts.push(`frame:${frameFile(f)}:${f.function ?? "?"}`);
    return parts;
  }
  return [`message:${normalizeMessage(messageOf(e))}`];
}

/** `event.fingerprint` (with `{{ default }}` expanded) or the default grouping, hashed (32 hex). */
export async function fingerprintOf(e: SentryEvent): Promise<string> {
  const def = groupingComponents(e);
  const custom = Array.isArray(e.fingerprint) && e.fingerprint.length ? e.fingerprint.map(String) : null;
  const parts = custom ? custom.flatMap((p) => (/^\{\{\s*default\s*\}\}$/.test(p) ? def : [`custom:${p}`])) : def;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parts.join("\n")));
  return [...new Uint8Array(digest).slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export function titleOf(e: SentryEvent): string {
  const x = e.exception?.values?.at(-1);
  if (x) return clip(x.value ? `${x.type ?? "Error"}: ${x.value}` : (x.type ?? "Error"), 200);
  return clip(messageOf(e) || e.transaction || "<unlabeled event>", 200);
}

/** The top in-app frame as `function (file)`, or the transaction. */
export function culpritOf(e: SentryEvent): string {
  if (typeof e.culprit === "string" && e.culprit) return clip(e.culprit, 200);
  const frames = stacksOf(e)[0] ?? [];
  const f = [...frames].reverse().find(isInApp) ?? frames.at(-1);
  if (f) return clip(`${f.function ?? "?"} (${f.filename ?? f.abs_path ?? f.module ?? "?"})`, 200);
  return clip(e.transaction ?? "", 200);
}

export function levelOf(e: SentryEvent): Level {
  const l = String(e.level ?? "error").toLowerCase();
  return (LEVELS as readonly string[]).includes(l) ? (l as Level) : l === "warn" ? "warning" : l === "critical" ? "fatal" : "error";
}

/** The event time in ms (Sentry sends seconds, as a number or RFC 3339). */
export function timestampOf(e: SentryEvent, fallback: number): number {
  const t = e.timestamp;
  if (typeof t === "number" && Number.isFinite(t)) return Math.round(t * 1000);
  if (typeof t === "string") {
    const ms = Date.parse(t);
    if (Number.isFinite(ms)) return ms;
  }
  return fallback;
}

/** The stack as text, newest frame first, the way the dashboard's `stacktrace` section shows it (capped). */
export function stackText(e: SentryEvent, max = 16_384): string {
  const out: string[] = [];
  const values = e.exception?.values ?? [];
  const blocks: Array<{ head: string; frames: StackFrame[] }> = values.length
    ? [...values].reverse().map((x) => ({ head: x.value ? `${x.type ?? "Error"}: ${x.value}` : (x.type ?? "Error"), frames: x.stacktrace?.frames ?? [] }))
    : [{ head: messageOf(e) || titleOf(e), frames: stacksOf(e)[0] ?? [] }];
  for (const b of blocks) {
    out.push(b.head);
    for (const f of [...b.frames].reverse()) {
      const where = `${f.abs_path ?? f.filename ?? f.module ?? "?"}${f.lineno ? `:${f.lineno}${f.colno ? `:${f.colno}` : ""}` : ""}`;
      out.push(`    at ${f.function ? `${f.function} (${where})` : where}${isInApp(f) ? "" : " [lib]"}`);
      if (f.context_line !== undefined && isInApp(f)) out.push(`        > ${f.context_line.trim()}`);
    }
  }
  const s = out.join("\n");
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/**
 * Frames of a JS `error.stack` (V8 `    at fn (file:line:col)` and Firefox/Safari `fn@file:line:col`), oldest
 * first as Sentry wants them.
 */
export function parseStack(stack: string | undefined): StackFrame[] {
  if (!stack) return [];
  const frames: StackFrame[] = [];
  for (const raw of stack.split("\n").slice(0, 100)) {
    const line = raw.trim();
    let m = /^at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/.exec(line);
    if (m) {
      frames.push(frame(m[1], m[2]!, m[3]!, m[4]!));
      continue;
    }
    m = /^(.*?)@(.+?):(\d+):(\d+)$/.exec(line);
    if (m) frames.push(frame(m[1] || undefined, m[2]!, m[3]!, m[4]!));
  }
  return frames.reverse();
}

function frame(fn: string | undefined, file: string, line: string, col: string): StackFrame {
  const f: StackFrame = { filename: file, abs_path: file, lineno: Number(line), colno: Number(col) };
  if (fn) f.function = fn.replace(/^async /, "");
  f.in_app = isInApp(f);
  return f;
}

/** A random event id (32 hex, as Sentry's). */
export function eventId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

/** An event for a thrown value (the shape the official SDKs send). */
export function eventFromError(error: unknown, o: { level?: Level; release?: string; environment?: string; platform?: string; tags?: Record<string, string>; extra?: Record<string, unknown>; now?: number; handled?: boolean } = {}): SentryEvent {
  const err = error instanceof Error ? error : null;
  const ev: SentryEvent = {
    event_id: eventId(),
    timestamp: (o.now ?? Date.now()) / 1000,
    platform: o.platform ?? "javascript",
    level: o.level ?? "error",
    exception: {
      values: [
        {
          type: err ? err.name || "Error" : "Error",
          value: err ? err.message : typeof error === "string" ? error : safeString(error),
          ...(err?.stack ? { stacktrace: { frames: parseStack(err.stack) } } : {}),
          mechanism: { type: "generic", handled: o.handled ?? true },
        },
      ],
    },
  };
  if (o.release) ev.release = o.release;
  if (o.environment) ev.environment = o.environment;
  if (o.tags) ev.tags = o.tags;
  if (o.extra) ev.extra = o.extra;
  return ev;
}

function safeString(v: unknown): string {
  try {
    return typeof v === "object" ? JSON.stringify(v) : String(v);
  } catch {
    return String(v);
  }
}
