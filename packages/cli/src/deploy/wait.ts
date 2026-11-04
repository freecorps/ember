// `ember deploy --wait`: polls `GET /api/_ember/status` (admin token) for a sample of shards until each one runs
// the new schema with no index still backfilling, and fails loudly when a shard refused the migration.
//
// Waking a shard is what migrates it (PLAN §11 step 5), so the poll itself drives the sample. Shards not in the
// sample migrate when they next wake.

/** `ShardStatus` of `@freecorps/ember-runtime` (redeclared: the CLI does not typecheck against workers types). */
export interface ShardStatus {
  shard: string;
  expectedVersion: string;
  schemaVersion: string | null;
  ready: boolean;
  staged: Array<{ table: string; index: string; kind: string; cursor: number; until: number }>;
  migrationError: { at: number; fromVersion: string | null; toVersion: string; code: string; message: string } | null;
  lastMigrationError: ShardStatus["migrationError"];
  version: number;
  databaseSize: number;
}
type StatusResponse = { ok: true; expectedVersion: string; shards: ShardStatus[] };

export class MigrationRefusedError extends Error {
  override readonly name = "MigrationRefusedError";
  readonly shards: ShardStatus[];
  constructor(shards: ShardStatus[]) {
    super(
      `Schema migration refused on ${shards.length} shard(s); they keep the old schema and reject requests until a fixed deploy:\n` +
        shards.map((s) => `  ${s.shard}: ${s.migrationError?.code}: ${s.migrationError?.message.split("\n").join("\n    ")}`).join("\n"),
    );
    this.shards = shards;
  }
}

export interface WaitOptions {
  /** Deployment base URL (workers.dev or custom domain). */
  url: string;
  adminToken: string;
  /** Shards to check; `global:main` is always included. */
  shards?: string[];
  /** Schema version of this deploy. */
  expectedVersion: string;
  timeoutMs?: number;
  intervalMs?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  now?: () => number;
}

const describe = (s: ShardStatus) =>
  s.ready
    ? "ready"
    : s.schemaVersion !== s.expectedVersion
      ? `schema ${s.schemaVersion?.slice(0, 12) ?? "none"} → ${s.expectedVersion.slice(0, 12)}`
      : `backfilling ${s.staged.map((i) => `${i.table}.${i.index} (${Math.max(0, i.until - i.cursor)} rows left)`).join(", ")}`;

export async function waitForShards(o: WaitOptions): Promise<ShardStatus[]> {
  const doFetch = o.fetch ?? fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const log = o.log ?? ((l: string) => console.log(l));
  const now = o.now ?? Date.now;
  const shards = [...new Set(["global:main", ...(o.shards ?? [])])];
  const deadline = now() + (o.timeoutMs ?? 5 * 60_000);
  const qs = new URLSearchParams(shards.map((s) => ["shard", s]));
  const endpoint = new URL(`/api/_ember/status?${qs}`, o.url).href;
  let last = "";
  let lastStatus: ShardStatus[] = [];
  for (;;) {
    let line: string;
    try {
      const res = await doFetch(endpoint, { headers: { authorization: `Bearer ${o.adminToken}` } });
      const body = (await res.json().catch(() => null)) as (StatusResponse & { error?: { code: string; message: string } }) | null;
      if (res.status === 403 && body?.error?.code === "admin_disabled")
        throw new Error("The Worker has no EMBER_ADMIN_TOKEN: deploy with EMBER_ADMIN_TOKEN set (it is uploaded as a secret) or set the secret by hand.");
      if (res.status === 401) throw new Error("The Worker rejected the admin token (EMBER_ADMIN_TOKEN differs from the deployed secret).");
      if (!res.ok || !body?.ok) {
        line = `status endpoint answered HTTP ${res.status}; retrying`;
      } else if (body.expectedVersion !== o.expectedVersion) {
        // The previous version still serves this request (propagation, or a gradual split).
        line = `waiting for the new version to serve requests (schema ${body.expectedVersion.slice(0, 12)} still live)`;
      } else {
        lastStatus = body.shards;
        const refused = body.shards.filter((s) => s.migrationError);
        if (refused.length) throw new MigrationRefusedError(refused);
        if (body.shards.every((s) => s.ready)) {
          log(`  shards ready: ${body.shards.map((s) => s.shard).join(", ")}`);
          return body.shards;
        }
        line = body.shards.map((s) => `${s.shard}: ${describe(s)}`).join("; ");
      }
    } catch (e) {
      if (e instanceof MigrationRefusedError || (e instanceof Error && /EMBER_ADMIN_TOKEN/.test(e.message))) throw e;
      line = `status endpoint unreachable (${(e as Error).message}); retrying`;
    }
    if (line !== last) log(`  ${line}`);
    last = line;
    if (now() >= deadline) {
      throw new Error(`Timed out waiting for shards (${shards.join(", ")}): ${lastStatus.length ? lastStatus.map((s) => `${s.shard}: ${describe(s)}`).join("; ") : line}`);
    }
    await sleep(o.intervalMs ?? 2000);
  }
}
