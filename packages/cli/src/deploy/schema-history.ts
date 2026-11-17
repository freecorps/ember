// Schema rollback check (contracts.md "Deploy"): before uploading, `ember deploy` reads this environment's deploy
// history from the account registry (`deployments`, in insertion order) and notices when the app schema about to be
// deployed is one the environment already left for a newer one. Shards migrate to the deployed schema when they
// wake, so a schema rollback runs the migration planner backwards on every shard that already took the newer schema:
// fields only the newer schema has that hold values make the shard refuse (offline until a roll-forward), its empty
// columns and indexes are dropped, and a later roll-forward rebuilds those indexes with a backfill. The deploy stops
// unless the operator passes --allow-schema-rollback.
//
// Schema versions are content hashes with no order of their own; the order is the registry's. A version is "older"
// than the current one when this environment first deployed it before it first deployed the current one, so a
// roll-forward after an allowed rollback (S1, S2, S1, then S2 again) is not a rollback.

export const ALLOW_SCHEMA_ROLLBACK_FLAG = "--allow-schema-rollback";

/** One row of the registry's `deployments` table for this environment, oldest first. */
export interface DeployHistoryRow {
  id: number;
  at: number;
  schemaVersion: string | null;
  versionId: string | null;
  message: string | null;
}

/** A deploy as the finding names it. */
export interface DeployRef {
  at: number;
  versionId: string | null;
  message: string | null;
}

export interface SchemaRollback {
  /** The schema being deployed (one this environment ran before `current`). */
  target: string;
  /** The environment's current schema (its latest deploy). */
  current: string;
  /** The deploy that moved the environment onto `current` (the first of the latest run of deploys with it). */
  introducedBy: DeployRef;
  /** The last deploy that ran `target`. */
  lastRanTarget: DeployRef;
  /** The live deployment splits traffic between versions (a gradual deploy): only some shards may have migrated. */
  split?: boolean;
}

export type SchemaHistoryCheck =
  /** `same`: redeploy of the current schema; `new`: never deployed here; `forward`: deployed here, but after the
   *  current one was introduced; `no-history`: no deploy recorded; `first-deploy`: the Worker does not exist (no shards). */
  | { status: "ok"; reason: "same" | "new" | "forward" | "no-history" | "first-deploy" }
  | { status: "rollback"; allowed: boolean; rollback: SchemaRollback }
  /** The history could not be read: the deploy goes ahead (see `schemaHistoryWarning`). */
  | { status: "unchecked"; reason: string };

/** Classifies `target` against this environment's deploy history (pure). */
export function classifySchema(rows: readonly DeployHistoryRow[], target: string, allowed = false): SchemaHistoryCheck {
  const seen = [...rows].filter((r) => r.schemaVersion).sort((a, b) => a.id - b.id);
  const last = seen.at(-1);
  if (!last) return { status: "ok", reason: "no-history" };
  const current = last.schemaVersion!;
  if (target === current) return { status: "ok", reason: "same" };
  const firstSeen = (v: string) => seen.findIndex((r) => r.schemaVersion === v);
  const t = firstSeen(target);
  if (t < 0) return { status: "ok", reason: "new" };
  if (t > firstSeen(current)) return { status: "ok", reason: "forward" };
  let start = seen.length - 1;
  while (start > 0 && seen[start - 1]!.schemaVersion === current) start--;
  const ran = seen.findLast((r) => r.schemaVersion === target)!;
  const ref = (r: DeployHistoryRow): DeployRef => ({ at: r.at, versionId: r.versionId, message: r.message });
  return { status: "rollback", allowed, rollback: { target, current, introducedBy: ref(seen[start]!), lastRanTarget: ref(ran) } };
}

const short = (v: string) => v.slice(0, 12);
const when = (at: number) => new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z");
const deployName = (d: DeployRef) => `${when(d.at)}${d.versionId ? `, version ${d.versionId.slice(0, 8)}` : ""}${d.message ? ` ("${d.message}")` : ""}`;

/**
 * The explanation printed (and thrown) for a schema rollback. `env` names the environment in the commands it suggests.
 */
export function schemaRollbackLines(r: SchemaRollback, o: { env: string; allowed: boolean; dryRun?: boolean }): string[] {
  const envFlag = `--env ${o.env}`;
  return [
    `schema rollback: this deploy takes ${o.env} back to schema ${short(r.target)}, which it left for schema ${short(r.current)}`,
    `  ${short(r.current)} (current) was introduced by the deploy of ${deployName(r.introducedBy)}`,
    `  ${short(r.target)} last ran in the deploy of ${deployName(r.lastRanTarget)}`,
    ...(r.split ? ["  the live deployment splits traffic between two versions (gradual deploy): only shards that ran the newer one have migrated"] : []),
    `  every shard that already migrated to ${short(r.current)} runs the migration backwards when it wakes:`,
    `  - no document data is deleted. A shard with documents holding a field only ${short(r.current)} has refuses ${short(r.target)}:`,
    `    it stays on ${short(r.current)} and answers nothing (MigrationRefused) until ${short(r.current)} is deployed again`,
    `  - columns only ${short(r.current)} has that are empty, and its indexes (db, aggregate, search), are dropped`,
    `  - deploying ${short(r.current)} again rebuilds those indexes with a backfill (queries on them fail with IndexNotReady`,
    `    until it ends), and also the intact indexes of tables ${short(r.target)} does not declare`,
    `  \`ember deploy --preflight ${envFlag}\` shows, shard by shard, what would be dropped or refused`,
    o.allowed
      ? `  ${o.dryRun ? "a real deploy would go ahead" : "deploying anyway"}: ${ALLOW_SCHEMA_ROLLBACK_FLAG} was passed`
      : `  ${o.dryRun ? "a real deploy stops here" : "nothing was uploaded"}. To deploy it anyway: ember deploy ${envFlag} ${ALLOW_SCHEMA_ROLLBACK_FLAG}`,
  ];
}

/** Why an unchecked history does not stop the deploy (printed as a warning). */
export function schemaHistoryWarning(reason: string): string {
  return `warning: schema rollback not checked: ${reason}. The deploy goes ahead; shards never lose document data to an older schema (they refuse it), and \`ember deploy --preflight\` asks them directly`;
}

/** Thrown by `ember deploy` for a schema rollback without --allow-schema-rollback, before anything is uploaded. */
export class SchemaRollbackError extends Error {
  override name = "SchemaRollbackError";
  readonly check: Extract<SchemaHistoryCheck, { status: "rollback" }>;
  constructor(check: Extract<SchemaHistoryCheck, { status: "rollback" }>, env: string) {
    super(schemaRollbackLines(check.rollback, { env, allowed: false }).join("\n"));
    this.check = check;
  }
}

/** Reads the history and classifies `target`; a failed read is `unchecked`, never an exception. */
export async function checkSchemaHistory(
  history: () => Promise<DeployHistoryRow[]>,
  target: string,
  o: { allowed?: boolean; split?: boolean } = {},
): Promise<SchemaHistoryCheck> {
  let rows: DeployHistoryRow[];
  try {
    rows = await history();
  } catch (e) {
    return { status: "unchecked", reason: `the registry's deploy history could not be read (${(e as Error).message})` };
  }
  const c = classifySchema(rows, target, o.allowed ?? false);
  if (c.status === "rollback" && o.split) c.rollback.split = true;
  return c;
}
