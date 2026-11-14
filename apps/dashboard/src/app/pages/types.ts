// Shapes of the dashboard API answers the pages read (apps/dashboard/src/worker.ts, runtime admin endpoints).

export interface FunctionRow {
  project: string;
  env: string;
  fn: string;
  kind: string;
  timing: string;
  calls: number;
  errors: number;
  errorRate: number;
  p50: number;
  p95: number;
  rowsRead: number;
  rowsWritten: number;
  avgRowsRead: number;
  bytesOut: number;
}

export interface ShardRow {
  shard: string;
  kind: string;
  key: string;
  schema_version: string | null;
  db_size: number;
  last_write: number | null;
  reported_at: number;
}

export interface ShardStatus {
  shard: string;
  expectedVersion: string;
  schemaVersion: string | null;
  ready: boolean;
  staged: Array<{ table: string; index: string; kind: string; cursor: number; until: number }>;
  migrationError: { at: number; fromVersion: string; toVersion: string; code: string; message: string } | null;
  version: number;
  databaseSize: number;
}

export interface StatusBody {
  ok: true;
  expectedVersion: string;
  shards: ShardStatus[];
}

export interface Project {
  name: string;
  repo: string | null;
  envs: Array<{ env: string; worker: string; url: string | null; schema_version: string | null; version_id: string | null; last_deploy: number | null; shards: number }>;
  domains: Array<{ host: string; env: string; kind: string }>;
}

export interface Bookmark {
  id: number;
  at: number;
  bookmark: string;
  reason: string;
}

export interface AuditEntry {
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
  outcome: "started" | "ok" | "error" | "denied";
  status: number | null;
  error: string | null;
  finished_at: number | null;
}
