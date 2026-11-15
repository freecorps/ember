// Better Auth organizations in each org shard (PLAN §22 L3), on top of the replication primitive (replication.ts).
//
// The Auth DO's SQLite triggers (`@freecorps/ember-auth` `replicaJournalDDL`) journal every write to `organization`,
// `member`, `invitation`, `team`, `teamMember` and `user` **in the same transaction** as the write, with its route (the
// organization id) and, for members, the user. The Auth DO's alarm turns journal rows into replication rows
// (`convertAuthJournal`, one transaction: journal rows out, outbox rows in), reading the rows' *current* state:
//
//   organization/member/invitation/team/teamMember  →  `<kind>:<organizationId>` (`auth:<model>`)
//   member insert/update                            →  also the member's `auth:user` to that org shard
//   member delete                                   →  also removes `auth:user` there when the user has no other membership
//   user update / delete                            →  every org shard the user is a member of
//
// No Better Auth hook is involved, so a crash between the write and any hook loses nothing (the journal committed with
// the write), and plugins writing around the hooks are covered too. Hidden fields (`returned: false`, tokens, secrets)
// are not in the spec, so they never leave the Auth DO. The spec is computed by `@freecorps/ember-auth`
// (`authReplicaSpec`, at codegen/build) so the runtime never loads Better Auth.

import type { ReplicaFieldSpec, ReplicaSnapshotRow, ReplicaTableSpec } from "@freecorps/ember-server";
import { isValidShardName } from "./config.ts";
import { enqueueReplica, requestSnapshot, type ReplicaChange } from "./replication.ts";

const META = "_ember_replication_meta";

/** One replicated Better Auth model: the replica table plus how to read it in the Auth DO. */
export interface AuthReplicaTable extends ReplicaTableSpec {
  /** Better Auth model key: `member`. */
  model: string;
  /** Physical table in the Auth DO. */
  table: string;
  /** Field key → physical column and Better Auth field type (decoding). */
  columns: Record<string, { column: string; kind: string }>;
}

/** What `authReplicaSpec(config)` (`@freecorps/ember-auth`) computes; JSON. */
export interface AuthReplicaSpec {
  /** Target shard kind: rows go to `<shardKind>:<organizationId>`. */
  shardKind: string;
  /** Fingerprint of the replicated tables and fields: a change resyncs every organization. */
  version: string;
  /**
   * Table the triggers write (`REPLICA_JOURNAL_TABLE` of `@freecorps/ember-auth`, carried by the spec so the name is
   * declared once, on the side that writes it).
   */
  journal: string;
  tables: AuthReplicaTable[];
}

const q = (ident: string) => `"${ident.replaceAll('"', '""')}"`;

/** The plain `ReplicaTableSpec`s (what the Shards' schema gets). */
export const replicaTablesOfSpec = (spec: AuthReplicaSpec): ReplicaTableSpec[] =>
  spec.tables.map(({ name, source, idType, fields, indexes }) => ({ name, source, idType, fields, ...(indexes ? { indexes } : {}) }));

function decode(kind: string, x: unknown): unknown {
  if (x === null || x === undefined) return undefined;
  switch (kind) {
    case "date":
      return typeof x === "string" ? Date.parse(x) : x;
    case "boolean":
      return typeof x === "number" ? x !== 0 : x;
    case "json":
    case "string[]":
    case "number[]":
      if (typeof x !== "string") return x;
      try {
        return JSON.parse(x);
      } catch {
        return kind === "json" ? x : undefined;
      }
    default:
      return x;
  }
}

/** The L3 reader over the Auth DO's SQLite: rows by id, by organization, memberships. */
export function authReplicaReader(spec: AuthReplicaSpec) {
  const J = q(spec.journal);
  const hasJournal = (sql: SqlStorage) => sql.exec(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, spec.journal).toArray().length > 0;
  /** Journal rows not converted yet. */
  const journalPending = (sql: SqlStorage): boolean => hasJournal(sql) && sql.exec(`SELECT 1 FROM ${J} LIMIT 1`).toArray().length > 0;
  const journalCount = (sql: SqlStorage): number => (hasJournal(sql) ? Number(sql.exec(`SELECT COUNT(*) AS n FROM ${J}`).toArray()[0]!.n) : 0);
  const byModel = new Map(spec.tables.map((t) => [t.model, t]));
  const col = (t: AuthReplicaTable, field: string) => q(t.columns[field]?.column ?? field);
  const docOf = (t: AuthReplicaTable, row: Record<string, unknown>): { id: string | number; doc: Record<string, unknown> } => {
    const doc: Record<string, unknown> = {};
    for (const f of t.fields as ReplicaFieldSpec[]) {
      const c = t.columns[f.name];
      const x = decode(c?.kind ?? "string", row[c?.column ?? f.name]);
      if (x !== undefined) doc[f.name] = x;
    }
    return { id: row.id as string | number, doc };
  };
  const one = (sql: SqlStorage, model: string, id: unknown) => {
    const t = byModel.get(model);
    if (!t) return null;
    const row = sql.exec(`SELECT * FROM ${q(t.table)} WHERE "id" = ?`, id).toArray()[0];
    return row ? docOf(t, row) : null;
  };
  const where = (sql: SqlStorage, model: string, cond: string, ...params: unknown[]) => {
    const t = byModel.get(model);
    if (!t) return [];
    return sql.exec(`SELECT * FROM ${q(t.table)} WHERE ${cond}`, ...params).toArray().map((r) => docOf(t, r));
  };
  const member = byModel.get("member");
  const team = byModel.get("team");
  const target = (org: unknown) => `${spec.shardKind}:${String(org)}`;
  /** Organizations a user is a member of (now). */
  const orgsOf = (sql: SqlStorage, userId: unknown): string[] =>
    member
      ? sql
          .exec(`SELECT DISTINCT ${col(member, "organizationId")} AS org FROM ${q(member.table)} WHERE ${col(member, "userId")} = ?`, userId)
          .toArray()
          .map((r) => String(r.org))
      : [];
  const isMember = (sql: SqlStorage, org: unknown, userId: unknown): boolean =>
    !!member &&
    sql.exec(`SELECT 1 FROM ${q(member.table)} WHERE ${col(member, "organizationId")} = ? AND ${col(member, "userId")} = ? LIMIT 1`, org, userId).toArray().length > 0;

  /** Every row of organization `org` (a resync of `<kind>:<org>`). */
  const snapshot = (sql: SqlStorage, shard: string): ReplicaSnapshotRow[] => {
    const prefix = `${spec.shardKind}:`;
    if (!shard.startsWith(prefix)) return [];
    const org = shard.slice(prefix.length);
    const rows: ReplicaSnapshotRow[] = [];
    const push = (model: string, list: Array<{ id: string | number; doc: Record<string, unknown> }>) => {
      const t = byModel.get(model);
      if (t) for (const r of list) rows.push({ table: t.name, id: r.id, doc: r.doc });
    };
    const o = one(sql, "organization", org);
    if (o) push("organization", [o]);
    for (const model of ["member", "invitation", "team"]) {
      const t = byModel.get(model);
      if (t) push(model, where(sql, model, `${col(t, "organizationId")} = ?`, org));
    }
    const tm = byModel.get("teamMember");
    if (tm && team) push("teamMember", where(sql, "teamMember", `${col(tm, "teamId")} IN (SELECT "id" FROM ${q(team.table)} WHERE ${col(team, "organizationId")} = ?)`, org));
    const user = byModel.get("user");
    if (user && member) push("user", where(sql, "user", `"id" IN (SELECT ${col(member, "userId")} FROM ${q(member.table)} WHERE ${col(member, "organizationId")} = ?)`, org));
    return rows;
  };

  /**
   * Journal rows → replication rows, oldest first, in one transaction (the caller's). Returns how many journal rows
   * were consumed.
   */
  const convert = (sql: SqlStorage, limit = 200, now = Date.now()): number => {
    if (!hasJournal(sql)) return 0;
    const journal = sql.exec(`SELECT seq, model, row_id, event, org, user_id FROM ${J} ORDER BY seq LIMIT ?`, limit).toArray();
    if (!journal.length) return 0;
    const out: ReplicaChange[] = [];
    const name = (model: string) => byModel.get(model)?.name;
    for (const j of journal) {
      if (j.event === "resync") {
        // Replication turned on (again): writes made while it was off were never journaled. Changes before this row go
        // first; every organization is then resynced from its current rows.
        enqueueReplica(sql, out.splice(0), now);
        for (const t of allTargets(sql)) requestSnapshot(sql, t, now);
        continue;
      }
      const model = String(j.model);
      const t = byModel.get(model);
      if (!t) continue;
      const id = j.row_id as string | number;
      const del = j.event === "delete";
      if (model === "user") {
        // Fan-out to the user's organizations as they are now (a membership added later sends the user itself).
        const cur = del ? null : one(sql, "user", id);
        if (!del && !cur) continue; // deleted since: its own delete row follows
        for (const org of orgsOf(sql, id)) out.push(cur ? { target: target(org), table: t.name, id, op: "upsert", doc: cur.doc } : { target: target(org), table: t.name, id, op: "delete" });
        continue;
      }
      // A row whose organization cannot be known (a team member removed with its team: the team's delete journaled it).
      if (j.org === null || j.org === undefined) continue;
      const to = target(j.org);
      if (del) {
        out.push({ target: to, table: t.name, id, op: "delete" });
        const u = name("user");
        if (model === "member" && u && j.user_id !== null && !isMember(sql, j.org, j.user_id)) out.push({ target: to, table: u, id: j.user_id as string | number, op: "delete" });
        continue;
      }
      const cur = one(sql, model, id);
      if (!cur) continue; // deleted since: its delete row follows
      out.push({ target: to, table: t.name, id, op: "upsert", doc: cur.doc });
      if (model === "member" && j.user_id !== null) {
        const u = one(sql, "user", j.user_id);
        const un = name("user");
        if (u && un) out.push({ target: to, table: un, id: u.id, op: "upsert", doc: u.doc });
      }
    }
    enqueueReplica(sql, out, now);
    sql.exec(`DELETE FROM ${J} WHERE seq <= ?`, journal[journal.length - 1]!.seq);
    return journal.length;
  };

  /**
   * Replication enabled for the first time, or its tables/fields changed (the spec's fingerprint): every organization
   * is resynced (their shards may have nothing, or rows of the old shape). Returns how many were asked. Turning it
   * off and on again with the same spec is the journal's `resync` row (`convert`): the fingerprint cannot see it.
   */
  const bootstrap = (sql: SqlStorage, now = Date.now()): number => {
    sql.exec(`CREATE TABLE IF NOT EXISTS ${META} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    const have = sql.exec(`SELECT value FROM ${META} WHERE key = 'auth'`).toArray()[0]?.value;
    if (have === spec.version) return 0;
    const org = byModel.get("organization");
    let n = 0;
    if (org) {
      for (const r of sql.exec(`SELECT "id" FROM ${q(org.table)}`).toArray()) {
        const s = target(r.id);
        if (!isValidShardName(s)) continue;
        requestSnapshot(sql, s, now);
        n++;
      }
    }
    sql.exec(`INSERT INTO ${META} (key, value) VALUES ('auth', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, spec.version);
    return n;
  };

  /** Every org shard (an admin resync of all of them). */
  const allTargets = (sql: SqlStorage): string[] => {
    const org = byModel.get("organization");
    return org ? sql.exec(`SELECT "id" FROM ${q(org.table)}`).toArray().map((r) => target(r.id)).filter(isValidShardName) : [];
  };

  return { snapshot, convert, bootstrap, allTargets, journalPending, journalCount };
}
