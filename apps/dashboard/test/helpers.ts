// Test helpers: a D1 binding over node:sqlite and a seeded account registry.
import { DatabaseSync } from "node:sqlite";
import type { D1Like } from "../src/worker.ts";

/** D1 binding stand-in over node:sqlite. */
export function d1(): { db: DatabaseSync; binding: D1Like } {
  const db = new DatabaseSync(":memory:");
  return {
    db,
    binding: {
      prepare: (sql) => ({
        bind: (...v) => ({ all: async <T,>() => ({ results: db.prepare(sql).all(...(v as any[])) as T[] }) }),
      }),
    },
  };
}

/** The registry tables the CLI creates, with one project (chat: prod and dev). */
export function seeded() {
  const { db, binding } = d1();
  db.exec(`
    CREATE TABLE projects (name TEXT PRIMARY KEY, fingerprint TEXT, repo TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE environments (project TEXT, env TEXT, worker TEXT, url TEXT, schema_version TEXT, version_id TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE deployments (id INTEGER PRIMARY KEY, project TEXT, env TEXT, worker TEXT, version_id TEXT, schema_version TEXT, url TEXT, message TEXT, strategy TEXT, at INTEGER);
    CREATE TABLE domains (host TEXT, project TEXT, env TEXT, worker TEXT, kind TEXT, zone_id TEXT, zone TEXT, created_at INTEGER);
    CREATE TABLE shards (project TEXT, env TEXT, shard TEXT, kind TEXT, key TEXT, schema_version TEXT, db_size INTEGER, last_write INTEGER, reported_at INTEGER);
    INSERT INTO projects VALUES ('chat', 'fp', 'git@x:chat', 1, 2);
    INSERT INTO environments VALUES ('chat', 'prod', 'ember-chat-prod', 'https://ember-chat-prod.acme.workers.dev', 'abc', 'v1', 1, 2);
    INSERT INTO environments VALUES ('chat', 'dev', 'ember-chat-dev', 'https://ember-chat-dev.acme.workers.dev', 'abc', 'v1', 1, 2);
    INSERT INTO deployments (project, env, worker, version_id, schema_version, strategy, at) VALUES ('chat', 'prod', 'ember-chat-prod', 'v1', 'abc', 'create', 5);
    INSERT INTO shards VALUES ('chat', 'prod', 'org:acme', 'org', 'acme', 'abc', 8192, 3, 4);
  `);
  return { db, binding };
}

export const registry = () => seeded().binding;
