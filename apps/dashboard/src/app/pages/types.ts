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
  documentsRead?: number;
  /** Highest fraction of each limit one call used (absent from older dashboards' Workers). */
  limitPeaks?: { rowsRead: number; documentsRead: number; rowsWritten: number };
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

/** A field's shape (`GET /api/schema`, @freecorps/ember-values `Shape`). */
export type Shape =
  | { kind: "string" | "number" | "int64" | "boolean" | "null" | "bytes" | "file" | "any" }
  | { kind: "id"; table: string }
  | { kind: "literal"; value: unknown }
  | { kind: "array"; item: Shape }
  | { kind: "record"; value: Shape }
  | { kind: "object"; fields: Record<string, { shape: Shape; optional: boolean }> }
  | { kind: "union"; members: Shape[] };

export interface SchemaIndex {
  name: string;
  kind: string;
  fields: string[];
  /** Only documents with every field present are in the index (filtering by it leaves the others out). */
  sparse?: boolean;
  /** Search indexes (admin API level 15). */
  searchField?: string;
  filterFields?: string[];
}

export interface SchemaTable {
  name: string;
  document: Extract<Shape, { kind: "object" }>;
  indexes: SchemaIndex[];
  shard?: unknown;
  /** `.replicated()` (level 15): the shard kinds it goes to (null: every kind). */
  replicated?: { to: string[] | null };
  /** Its SQLite table and columns (level 15), for the SQL Explorer. */
  sql?: { table: string; columns: string[] };
}

export interface SchemaBody {
  version: string;
  tables: SchemaTable[];
  componentTables: string[];
  internalTables?: string[];
}
