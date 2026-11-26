// The Function Runner's extras: the run history kept in this browser, and the same call as cURL (the project's admin
// `run` endpoint) or as TypeScript (client or `ctx.run*`). Pure functions, so they are tested without a browser.
//
// The cURL text never carries a token: the admin token is the placeholder `$EMBER_ADMIN_TOKEN` (the dashboard does not
// have the project's token in the browser anyway, and a copied command must not leak one).

export type FnType = "query" | "mutation" | "action";

export interface RunEntry {
  /** Unique per entry (time + random). */
  id: string;
  at: number;
  project: string;
  env: string;
  fn: string;
  type: FnType;
  shard: string;
  args: Record<string, unknown>;
  /** The subject run as (act as a user), if any. */
  as?: string;
  claims?: Record<string, unknown>;
  ok: boolean;
  /** The value or the error as JSON text, cut at RESULT_MAX characters. */
  result: string;
  ms: number | null;
}

/** Runs kept (newest first), all projects and environments of this browser together. */
export const HISTORY_MAX = 50;
/** Characters of a run's result kept in the history. */
export const RESULT_MAX = 2000;
export const HISTORY_KEY = "ember-dashboard-runs";

/** The history, newest first; [] when storage is unavailable or holds something else. */
export function loadHistory(): RunEntry[] {
  return stored() ?? [];
}

/** The stored history, or null when storage cannot be read (then the page's own list is all there is). */
function stored(): RunEntry[] | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(HISTORY_KEY);
  } catch {
    return null;
  }
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? (v.filter(isEntry) as RunEntry[]).slice(0, HISTORY_MAX) : [];
  } catch {
    return [];
  }
}

function isEntry(x: unknown): boolean {
  const e = x as Partial<RunEntry> | null;
  return !!e && typeof e === "object" && typeof e.id === "string" && typeof e.fn === "string" && typeof e.shard === "string" && !!e.args && typeof e.args === "object" && !Array.isArray(e.args);
}

/**
 * Adds a run (newest first, HISTORY_MAX kept) and returns the new list; storage failures keep it in memory only.
 * Built on the history stored now, not on `list` (the page's copy): another tab's runs and clears are kept.
 */
export function saveRun(list: RunEntry[], entry: Omit<RunEntry, "id" | "result"> & { result: unknown }): RunEntry[] {
  let text: string;
  try {
    text = JSON.stringify(entry.result) ?? "null";
  } catch {
    text = String(entry.result);
  }
  const e: RunEntry = { ...entry, id: `${entry.at.toString(36)}-${Math.random().toString(36).slice(2, 8)}`, result: text.length > RESULT_MAX ? `${text.slice(0, RESULT_MAX)}…` : text };
  const next = [e, ...(stored() ?? list)].slice(0, HISTORY_MAX);
  write(next);
  return next;
}

/** Drops a function's runs (of one project and environment), from the history stored now (as `saveRun`). */
export function clearHistory(list: RunEntry[], scope: { project: string; env: string; fn: string }): RunEntry[] {
  const next = (stored() ?? list).filter((e) => e.project !== scope.project || e.env !== scope.env || e.fn !== scope.fn);
  write(next);
  return next;
}

/** Signing out forgets the history (args, results and act-as subjects of the runs of whoever used this browser). */
export function forgetHistory(): void {
  try {
    localStorage.removeItem(HISTORY_KEY);
  } catch {
    // storage unavailable: nothing was kept
  }
}

function write(list: RunEntry[]): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
  } catch {
    // storage unavailable or full: the history lasts this page
  }
}

/** `s` as one POSIX shell word: single quotes, a `'` inside written as `'\''`. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The admin `run` call as cURL. `url`: the environment's URL (null → `$EMBER_URL`). The token is always the
 * placeholder `$EMBER_ADMIN_TOKEN`, in double quotes so the shell expands it.
 */
export function curlFor(o: { url: string | null; shard: string; fn: string; args: Record<string, unknown>; as?: { subject: string; claims?: Record<string, unknown> } | null }): string {
  const base = o.url ? shellQuote(`${o.url.replace(/\/+$/, "")}/api/_ember/run`) : `"$EMBER_URL/api/_ember/run"`;
  const body = JSON.stringify({ shard: o.shard, fn: o.fn, args: o.args, ...(o.as ? { as: o.as } : {}) });
  return [`curl -sS -X POST ${base}`, `  -H "Authorization: Bearer $EMBER_ADMIN_TOKEN"`, `  -H 'Content-Type: application/json'`, `  --data-raw ${shellQuote(body)}`].join(" \\\n");
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
/** Words a property name may be without quotes in a TS object literal or after a dot (all of them, in ES5+). */
// `__proto__: v` in a literal sets the prototype instead of a key: a computed key keeps it an own property.
const prop = (k: string) => (k === "__proto__" ? `["__proto__"]` : IDENT.test(k) ? k : JSON.stringify(k));
const member = (k: string) => (IDENT.test(k) ? `.${k}` : `[${JSON.stringify(k)}]`);

/** A JSON value as a TypeScript literal: identifier keys unquoted, strings JSON-quoted (valid TS), indented. */
export function tsLiteral(v: unknown, indent = ""): string {
  if (v === null || typeof v !== "object") {
    // undefined (absent) and non-finite numbers do not survive JSON either.
    if (v === undefined || (typeof v === "number" && !Number.isFinite(v))) return "null";
    return JSON.stringify(v);
  }
  const inner = `${indent}  `;
  if (Array.isArray(v)) return v.length ? `[\n${v.map((x) => `${inner}${tsLiteral(x, inner)}`).join(",\n")},\n${indent}]` : "[]";
  const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined);
  return entries.length ? `{\n${entries.map(([k, x]) => `${inner}${prop(k)}: ${tsLiteral(x, inner)}`).join(",\n")},\n${indent}}` : "{}";
}

/** The function's reference in generated code: `api.dir.mod.fn` / `internal.…`; a component's by name (`unsafeRef`). */
export function refFor(fn: string, visibility: "public" | "internal"): string {
  const at = fn.indexOf(":");
  if (fn.startsWith("@") || at < 0) return `unsafeRef(${JSON.stringify(fn)})`;
  const path = [...fn.slice(0, at).split("/"), fn.slice(at + 1)];
  return `${visibility === "internal" ? "internal" : "api"}${path.map(member).join("")}`;
}

const CAP: Record<FnType, string> = { query: "Query", mutation: "Mutation", action: "Action" };

/**
 * The call as TypeScript: from the client (`await client.mutation(api.x.y, args)`, public functions) and from an
 * action (`await ctx.runMutation(…)`; the only form for an internal one).
 */
export function tsFor(o: { fn: string; type: FnType; visibility: "public" | "internal"; args: Record<string, unknown> }): string {
  const ref = refFor(o.fn, o.visibility);
  const args = tsLiteral(o.args);
  const fromFn = `await ctx.run${CAP[o.type]}(${ref}, ${args});`;
  if (o.visibility === "internal" || o.fn.startsWith("@")) return `// From an action (${o.visibility === "internal" ? "an internal function is not callable from a client" : "a component's function"})\n${fromFn}`;
  return `// From a client\nawait client.${o.type}(${ref}, ${args});\n\n// From an action\n${fromFn}`;
}
