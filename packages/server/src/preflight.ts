// Migration preflight (`ember deploy --preflight`, contracts.md "Deploy"): what `migrate()` would do on this database
// with a schema that is not deployed yet, without writing anything. The manifest is plain data (it comes over the admin
// API from the CLI); index kinds are code, so the plan uses the kinds of the runtime that answers, and a manifest that
// names a kind this runtime does not have is reported as not checked instead of planned without it.

import { q, type SqlDriver } from "./driver.ts";
import { errorInfo } from "./errors.ts";
import { classicTables, COMPACT_MAX_ROWS, introspect, planMigration, stagedIndexes, type MigrationStep, type PlanOptions } from "./migrate.ts";
import type { IndexKind } from "./indexKinds.ts";
import type { SchemaManifest } from "./schema.ts";

/** A migration step without its SQL (what an operator reads). */
export type PreflightStep = { [K in MigrationStep["op"]]: Omit<Extract<MigrationStep, { op: K }>, "sql"> }[MigrationStep["op"]];

export type PreflightResult =
  | {
      /** `refused`: `migrate()` would throw MigrationRefused (the `refuse` steps say why). */
      status: "ok" | "refused";
      fromVersion: string | null;
      toVersion: string;
      /** false when the database already has this schema version (nothing would run). */
      changed: boolean;
      steps: PreflightStep[];
      /** Indexes the migration would create staged (backfilled in the background before they can be queried). */
      staged: Array<{ table: string; index: string; kind: string }>;
      /** Classic tables `migrate()` would try to convert to compact storage; `skipped`: why it would not (yet). */
      conversions: Array<{ table: string; skipped?: string }>;
    }
  | {
      /** The plan could not be made here: the deploy is not checked for this database. */
      status: "unchecked";
      code: "BadManifest" | "UnknownIndexKind" | "PlanFailed";
      message: string;
    };

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** Enough shape for the planner not to trip over the manifest (it was made by `ember codegen`, not by hand). */
export function manifestProblem(m: unknown): string | null {
  if (!isObj(m)) return "the schema manifest must be an object";
  if (typeof m.version !== "string" || !m.version) return "manifest.version must be a non-empty string";
  if (!isObj(m.tables)) return "manifest.tables must be an object";
  for (const [name, t] of Object.entries(m.tables)) {
    if (!isObj(t) || typeof t.idPrefix !== "string") return `manifest.tables.${name} is not a table manifest`;
    if (!isObj(t.document) || t.document.kind !== "object" || !isObj(t.document.fields)) return `manifest.tables.${name}.document must be an object shape`;
    if (!Array.isArray(t.indexes)) return `manifest.tables.${name}.indexes must be an array`;
    for (const i of t.indexes as unknown[]) {
      if (!isObj(i) || typeof i.kind !== "string" || typeof i.name !== "string" || !Array.isArray(i.fields)) return `manifest.tables.${name}.indexes has an invalid index`;
    }
  }
  return null;
}

/** Index kinds the manifest uses that `kinds` (the answering runtime's) does not have. */
export function unknownIndexKinds(m: SchemaManifest, kinds: ReadonlyMap<string, IndexKind>): string[] {
  const out = new Set<string>();
  for (const t of Object.values(m.tables)) for (const i of t.indexes) if (i.kind !== "db" && !kinds.has(i.kind)) out.add(i.kind);
  return [...out].sort();
}

/** Thrown inside the transaction so it always rolls back. */
const ROLLBACK = Symbol("preflight rollback");

/**
 * Plans the migration of `driver`'s database to `manifest` (`opts` as `planMigration`), in a transaction that is
 * always rolled back: the planner only reads (introspection, `IS NULL` counts), and the rollback makes sure of it.
 * Never throws for a bad manifest or a planner error: those are `unchecked`.
 */
export function preflightMigration(driver: SqlDriver, manifest: unknown, kinds: ReadonlyMap<string, IndexKind>, opts: Omit<PlanOptions, "classic"> = {}): PreflightResult {
  const bad = manifestProblem(manifest);
  if (bad) return { status: "unchecked", code: "BadManifest", message: bad };
  const m = manifest as SchemaManifest;
  const unknown = unknownIndexKinds(m, kinds);
  if (unknown.length) {
    return {
      status: "unchecked",
      code: "UnknownIndexKind",
      message: `the schema uses index kind(s) ${unknown.join(", ")} that the deployed runtime does not have (index kinds are code): those tables cannot be planned here`,
    };
  }
  let out: PreflightResult | undefined;
  try {
    driver.transaction(() => {
      out = plan(driver, m, kinds, opts);
      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) {
      const { code, message } = errorInfo(e, "Error");
      return { status: "unchecked", code: "PlanFailed", message: `${code}: ${message}` };
    }
  }
  return out!;
}

function plan(driver: SqlDriver, m: SchemaManifest, kinds: ReadonlyMap<string, IndexKind>, opts: Omit<PlanOptions, "classic">): PreflightResult {
  const classic = classicTables(driver);
  const p = planMigration(driver, m, kinds, { ...opts, classic });
  const steps = p.steps.map((s) => {
    const { sql: _sql, ...rest } = s as MigrationStep & { sql?: string[] };
    return rest as PreflightStep;
  });
  const changed = p.fromVersion !== m.version;
  const staged = steps.flatMap((s) => (s.op === "createIndex" && s.staged ? [{ table: s.table, index: s.index, kind: s.kind }] : []));
  return {
    status: p.ok ? "ok" : "refused",
    fromVersion: p.fromVersion,
    toVersion: m.version,
    changed,
    steps: changed ? steps : steps.filter((s) => s.op !== "noop"),
    staged,
    conversions: opts.compact ? conversions(driver, m, classic, staged) : [],
  };
}

/** What `compactTables` would look at after this migration (the conversion itself is only tried by `migrate()`). */
function conversions(driver: SqlDriver, m: SchemaManifest, pinned: ReadonlySet<string>, staged: Array<{ table: string }>): Array<{ table: string; skipped?: string }> {
  const cur = introspect(driver);
  const busy = new Set([...stagedIndexes(driver).map((x) => x.table), ...staged.map((x) => x.table)]);
  const out: Array<{ table: string; skipped?: string }> = [];
  for (const [table, t] of Object.entries(m.tables)) {
    const have = cur.tables.get(table);
    if (!have || have.storage.compact || t.replicated) continue;
    if (pinned.has(table)) out.push({ table, skipped: "pinned to classic storage (imported ids)" });
    else if (busy.has(table)) out.push({ table, skipped: "an index backfill is in progress (converted once it is done)" });
    else {
      const n = Number(driver.exec(`SELECT count(*) AS n FROM ${q(table)}`).rows[0]!.n);
      out.push(n > COMPACT_MAX_ROWS ? { table, skipped: `${n} rows (more than ${COMPACT_MAX_ROWS})` } : { table });
    }
  }
  return out;
}
