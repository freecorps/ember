// Audit log of every dashboard write (docs/design/contracts.md "Dashboard"): who, when, where, what, a summary of the
// arguments without secrets, and the outcome. Stored in the account registry (D1 `REGISTRY`, table `audit_log`) next
// to the projects it describes. A write starts by inserting its row (`started`); if that insert fails the write is
// refused, so nothing reaches a project without a trace. The row is then closed with `ok` / `error`. Refused attempts
// by a signed-in caller (role, CSRF) are recorded as `denied`.

import type { Principal } from "./auth.ts";

export interface D1Like {
  prepare(sql: string): { bind(...v: unknown[]): { all<T = Record<string, unknown>>(): Promise<{ results: T[] }> } };
}

/** Same statements as `DASHBOARD_DDL` in @freecorps/ember-cli registry.ts (the CLI creates them on deploy too). */
export const DASHBOARD_DDL = [
  "CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor TEXT NOT NULL, via TEXT NOT NULL, role TEXT NOT NULL, " +
    "project TEXT, env TEXT, shard TEXT, action TEXT NOT NULL, target TEXT, args TEXT, outcome TEXT NOT NULL, status INTEGER, error TEXT, finished_at INTEGER)",
  "CREATE INDEX IF NOT EXISTS audit_by_env ON audit_log (project, env, id)",
  "CREATE TABLE IF NOT EXISTS dashboard_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
];

const ready = new WeakMap<D1Like, Promise<void>>();

/** Creates the dashboard's own tables once per isolate (idempotent DDL). */
export function ensureTables(db: D1Like): Promise<void> {
  let p = ready.get(db);
  if (!p) {
    p = (async () => {
      for (const sql of DASHBOARD_DDL) await db.prepare(sql).bind().all();
    })();
    p.catch(() => ready.delete(db));
    ready.set(db, p);
  }
  return p;
}

export type AuditOutcome = "started" | "ok" | "error" | "denied";

export interface AuditEntry {
  action: string;
  project?: string | null;
  env?: string | null;
  shard?: string | null;
  target?: string | null;
  args?: unknown;
}

export interface AuditRow {
  id: number;
  at: number;
  actor: string;
  via: string;
  role: string;
  project: string | null;
  env: string | null;
  shard: string | null;
  action: string;
  target: string | null;
  args: string | null;
  outcome: AuditOutcome;
  status: number | null;
  error: string | null;
  finished_at: number | null;
}

/** Argument names whose values never reach the log. */
const SECRET_KEY = /secret|token|passw|pwd|api[-_]?key|private|authorization|cookie|jwt|credential|^value$/i;
const MAX_ARGS_JSON = 2000;

/** A bounded, secret-free copy of `v` for the audit log. */
export function summarizeArgs(v: unknown, depth = 0): unknown {
  if (v === null || typeof v === "boolean" || typeof v === "number") return v;
  if (typeof v === "string") return v.length > 120 ? `${v.slice(0, 120)}… (${v.length} chars)` : v;
  if (typeof v === "bigint") return `${v}n`;
  if (Array.isArray(v)) {
    if (depth >= 3) return `[${v.length} items]`;
    const head = v.slice(0, 10).map((x) => summarizeArgs(x, depth + 1));
    return v.length > 10 ? [...head, `… ${v.length - 10} more`] : head;
  }
  if (typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>);
    if (depth >= 3) return `{${entries.length} fields}`;
    const out: Record<string, unknown> = {};
    for (const [k, x] of entries.slice(0, 30)) out[k] = SECRET_KEY.test(k) ? "[redacted]" : summarizeArgs(x, depth + 1);
    if (entries.length > 30) out["…"] = `${entries.length - 30} more fields`;
    return out;
  }
  return String(typeof v);
}

function argsJson(args: unknown): string | null {
  if (args === undefined) return null;
  const s = JSON.stringify(summarizeArgs(args));
  return s.length > MAX_ARGS_JSON ? `${s.slice(0, MAX_ARGS_JSON)}…` : s;
}

const clip = (s: string | null | undefined, n = 500) => (s == null ? null : s.length > n ? `${s.slice(0, n)}…` : s);

export async function auditBegin(db: D1Like, who: Principal, e: AuditEntry, now = Date.now()): Promise<number> {
  await ensureTables(db);
  const r = await db
    .prepare("INSERT INTO audit_log (at, actor, via, role, project, env, shard, action, target, args, outcome) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'started') RETURNING id")
    .bind(now, who.actor, who.via, who.role, e.project ?? null, e.env ?? null, e.shard ?? null, e.action, clip(e.target, 300), argsJson(e.args))
    .all<{ id: number }>();
  const id = Number(r.results[0]?.id);
  if (!Number.isSafeInteger(id)) throw new Error("audit insert returned no id");
  return id;
}

export async function auditFinish(db: D1Like, id: number, outcome: "ok" | "error", status: number, error: string | null, now = Date.now()): Promise<void> {
  await db.prepare("UPDATE audit_log SET outcome = ?, status = ?, error = ?, finished_at = ? WHERE id = ?").bind(outcome, status, clip(error), now, id).all();
}

/** A refused attempt (role, CSRF). Best effort: a failure here never turns a refusal into something else. */
export async function auditDenied(db: D1Like | undefined, who: Principal, e: AuditEntry, status: number, code: string, now = Date.now()): Promise<void> {
  if (!db) return;
  try {
    await ensureTables(db);
    await db
      .prepare("INSERT INTO audit_log (at, actor, via, role, project, env, shard, action, target, args, outcome, status, error, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'denied', ?, ?, ?)")
      .bind(now, who.actor, who.via, who.role, e.project ?? null, e.env ?? null, e.shard ?? null, e.action, clip(e.target, 300), argsJson(e.args), status, code, now)
      .all();
  } catch {
    // the refusal stands either way
  }
}

export async function listAudit(db: D1Like, o: { project?: string | null; env?: string | null; before?: number | null; limit?: number }): Promise<AuditRow[]> {
  await ensureTables(db);
  const where: string[] = [];
  const params: unknown[] = [];
  if (o.project) {
    where.push("project = ?");
    params.push(o.project);
  }
  if (o.env) {
    where.push("env = ?");
    params.push(o.env);
  }
  if (o.before) {
    where.push("id < ?");
    params.push(o.before);
  }
  const limit = Math.max(1, Math.min(200, Math.floor(o.limit ?? 100)));
  const sql = `SELECT * FROM audit_log ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ${limit}`;
  return (await db.prepare(sql).bind(...params).all<AuditRow>()).results;
}

/** A per-registry random value in `dashboard_meta` (created on first use). */
export async function metaSecret(db: D1Like, key: string): Promise<string> {
  await ensureTables(db);
  const fresh = new Uint8Array(32);
  crypto.getRandomValues(fresh);
  const hex = [...fresh].map((b) => b.toString(16).padStart(2, "0")).join("");
  await db.prepare("INSERT INTO dashboard_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING").bind(key, hex).all();
  const r = await db.prepare("SELECT value FROM dashboard_meta WHERE key = ?").bind(key).all<{ value: string }>();
  const v = r.results[0]?.value;
  if (!v) throw new Error(`dashboard_meta ${key} missing`);
  return v;
}
