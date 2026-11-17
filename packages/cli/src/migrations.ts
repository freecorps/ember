// `ember migrations run|status|cancel <name>`: data migrations of the `@freecorps/ember-migrations` component
// (PLAN §22 L10) across shards. Not `ember migrate` (that is the Convex codemod).
//
// Every call goes through the admin function runner (`POST /api/_ember/run`, EMBER_ADMIN_TOKEN) to the component's
// public functions on each shard: `@<install>/lib:start` (run / dry run), `lib:status`, `lib:list`, `lib:cancel`. The
// migration itself runs in the shard (batches chained by its scheduler); the CLI only starts it and reads its row.
// `--all` walks the registry's shard catalog with bounded concurrency.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EmberManifest } from "./codegen/index.ts";
import type { Project } from "./config.ts";
import { normalizeFnName } from "./run.ts";
import { apiUrl, checkCredentialUrl } from "./secure-url.ts";

export type MigrationStatus = {
  name: string;
  status: "running" | "done" | "failed" | "canceled";
  processed: number;
  changed: number;
  failed: number;
  batches: number;
  batchSize: number | null;
  cursor: string | null;
  lastError?: string;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  next: string[];
};

export type DryRunReport = { processed: number; changed: number; isDone: boolean; samples: Array<{ _id: string; before: unknown; after: unknown }> };

export interface MigrationsOptions {
  url: string;
  adminToken: string;
  project: Project;
  fetch?: typeof fetch;
  /** One shard (default `global:main`), or every shard of the catalog (`all`, optionally only `kind`). */
  shard?: string;
  all?: boolean;
  kind?: string;
  /** Install name of the component (default: the only `migrations` install in the manifest). */
  component?: string;
  concurrency?: number;
  json?: boolean;
  catalog?: () => Promise<string[]>;
  log?: (line: string) => void;
}

export interface RunMigrationOptions extends MigrationsOptions {
  dryRun?: boolean;
  reset?: boolean;
  batchSize?: number;
  /** Poll until no shard is running any more. */
  wait?: boolean;
  waitTimeoutMs?: number;
  pollMs?: number;
}

export type ShardOutcome = { shard: string; status: MigrationStatus | null; dryRun?: DryRunReport; error?: string };

function manifestOf(project: Project): EmberManifest {
  const p = join(project.generatedDir, "manifest.json");
  if (!existsSync(p)) throw new Error("No ember/_generated/manifest.json (run `ember codegen`)");
  return JSON.parse(readFileSync(p, "utf8")) as EmberManifest;
}

/** The component's install name: `--component`, else the only install of `migrations`. */
export function migrationsInstall(manifest: EmberManifest, component?: string): string {
  const comps = (manifest.schema.components ?? {}) as Record<string, { component: string }>;
  const installs = Object.entries(comps).filter(([, c]) => c.component === "migrations").map(([k]) => k);
  if (component) {
    if (!comps[component]) throw new Error(`No component installed as "${component}" (installed: ${Object.keys(comps).join(", ") || "none"})`);
    return component;
  }
  if (installs.length === 1) return installs[0]!;
  if (!installs.length) throw new Error("The migrations component is not installed: add `.use(migrations)` (@freecorps/ember-migrations) to ember/ember.config.ts and run `ember codegen`");
  throw new Error(`The migrations component is installed more than once (${installs.join(", ")}): pass --component <name>`);
}

/** `migrations.addPlan`, `migrations:addPlan`, or `addPlan` when only one module defines it; must be a `Migrations.define`. */
export function resolveMigration(manifest: EmberManifest, name: string): string {
  const isMigration = (f: EmberManifest["functions"][number]) =>
    !f.component && f.type === "mutation" && f.visibility === "internal" && !!f.args && "cursor" in f.args.fields && "dryRun" in f.args.fields;
  let fn: string;
  if (!/[:./]/.test(name)) {
    const found = manifest.functions.filter((f) => isMigration(f) && f.name.endsWith(`:${name}`));
    if (found.length !== 1) throw new Error(found.length ? `"${name}" is ambiguous: ${found.map((f) => f.name).join(", ")}` : `No migration named "${name}" (Migrations.define in an ember/ module; run \`ember codegen\`)`);
    fn = found[0]!.name;
  } else fn = normalizeFnName(name);
  const info = manifest.functions.find((f) => f.name === fn);
  if (!info) throw new Error(`Unknown function "${fn}" (run \`ember codegen\`)`);
  if (!isMigration(info)) throw new Error(`"${fn}" is not a migration (export the result of Migrations.define)`);
  return fn;
}

async function adminRun<T>(o: MigrationsOptions, fn: string, args: Record<string, unknown>, shard: string): Promise<T> {
  const res = await (o.fetch ?? fetch)(apiUrl(checkCredentialUrl(o.url), "/api/_ember/run"), {
    method: "POST",
    headers: { authorization: `Bearer ${o.adminToken}`, "content-type": "application/json" },
    body: JSON.stringify({ fn, args, shard }),
  });
  const text = await res.text();
  let body: { ok?: boolean; value?: unknown; error?: { code: string; message: string } };
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  if (res.status === 403 || res.status === 401) throw new Error(`the admin endpoint refused the token (${body.error?.message ?? res.status}): set EMBER_ADMIN_TOKEN (or pass --admin-token)`);
  if (!res.ok || body.ok === false) throw new Error(`${body.error?.code ?? res.status}: ${body.error?.message ?? text.slice(0, 200)}`);
  return body.value as T;
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

async function shardsOf(o: MigrationsOptions): Promise<string[]> {
  if (o.all && o.shard) throw new Error("pass --shard <kind:key> or --all, not both");
  if (o.kind && !o.all) throw new Error("--kind needs --all");
  if (!o.all) return [o.shard ?? "global:main"];
  if (!o.catalog) throw new Error("--all needs the account registry (the shard catalog); pass --shard for one shard");
  const all = await o.catalog();
  const shards = o.kind ? all.filter((s) => s.startsWith(`${o.kind}:`)) : all;
  if (!shards.length) throw new Error(`the registry catalog lists no ${o.kind ? `${o.kind}: ` : ""}shards for this environment (shards report after their first migration)`);
  return shards;
}

const line = (shard: string, s: MigrationStatus | null, width: number) => {
  if (!s) return `  ${shard.padEnd(width)}  never ran here`;
  const err = s.lastError ? `  ${s.status === "running" ? "note" : "error"}: ${s.lastError}` : "";
  const next = s.next.length ? `  then ${s.next.join(", ")}` : "";
  return `  ${shard.padEnd(width)}  ${s.status.padEnd(8)}  processed ${s.processed}, changed ${s.changed}, failed batches ${s.failed}, batches ${s.batches}${next}${err}`;
};

function summary(outs: ShardOutcome[]): string {
  const by = new Map<string, number>();
  for (const o of outs) {
    const k = o.error ? "error" : (o.status?.status ?? "never ran");
    by.set(k, (by.get(k) ?? 0) + 1);
  }
  return [...by].map(([k, n]) => `${n} ${k}`).join(", ");
}

function print(o: MigrationsOptions, outs: ShardOutcome[]) {
  const log = o.log ?? ((l: string) => console.log(l));
  if (o.json) return log(JSON.stringify(outs, null, 2));
  const width = Math.max(...outs.map((x) => x.shard.length));
  for (const x of outs) {
    if (x.error) log(`  ${x.shard.padEnd(width)}  FAILED: ${x.error}`);
    else if (x.dryRun) {
      const d = x.dryRun;
      log(`  ${x.shard.padEnd(width)}  dry run: ${d.changed} of ${d.processed} document(s) in the first batch would change${d.isDone ? " (whole table)" : ""}; nothing was written`);
      for (const s of d.samples.slice(0, 3)) log(`      ${s._id}: ${JSON.stringify(s.before)} -> ${JSON.stringify(s.after)}`);
    } else log(line(x.shard, x.status, width));
  }
  if (outs.length > 1) log(`${outs.length} shard(s): ${summary(outs)}`);
}

/** `ember migrations run <name>`: starts (or resumes) it on each shard; `--dry-run` reports one batch per shard. */
export async function runMigration(o: RunMigrationOptions, name: string): Promise<ShardOutcome[]> {
  const log = o.log ?? ((l: string) => console.log(l));
  const manifest = manifestOf(o.project);
  const install = migrationsInstall(manifest, o.component);
  const fn = resolveMigration(manifest, name);
  if (o.batchSize !== undefined && (!Number.isInteger(o.batchSize) || o.batchSize < 1)) throw new Error("--batch-size must be a positive integer");
  // NaN would never pass `Date.now() > deadline`: a bad value would wait forever instead of timing out.
  if (o.waitTimeoutMs !== undefined && (!Number.isFinite(o.waitTimeoutMs) || o.waitTimeoutMs <= 0)) throw new Error("--wait-timeout must be a positive number of seconds");
  const shards = await shardsOf(o);
  const args: Record<string, unknown> = { name: fn, fn: `&${fn}` };
  if (o.dryRun) args.dryRun = true;
  if (o.reset) args.reset = true;
  if (o.batchSize !== undefined) args.batchSize = o.batchSize;
  if (!o.json) log(`${o.dryRun ? "dry run of" : "run"} ${fn} on ${shards.length} shard(s)`);
  let outs = await pool(shards, o.concurrency ?? 8, async (shard): Promise<ShardOutcome> => {
    try {
      const r = await adminRun<{ status: MigrationStatus | null; dryRun?: DryRunReport }>(o, `@${install}/lib:start`, args, shard);
      return { shard, status: r.status, ...(r.dryRun ? { dryRun: r.dryRun } : {}) };
    } catch (e) {
      return { shard, status: null, error: (e as Error).message };
    }
  });
  if (o.wait && !o.dryRun) outs = await waitFor(o, install, fn, outs);
  print(o, outs);
  return outs;
}

async function waitFor(o: RunMigrationOptions, install: string, fn: string, outs: ShardOutcome[]): Promise<ShardOutcome[]> {
  const deadline = Date.now() + (o.waitTimeoutMs ?? 30 * 60_000);
  const pollMs = o.pollMs ?? 2000;
  let cur = outs;
  for (;;) {
    const running = cur.filter((x) => !x.error && x.status?.status === "running");
    if (!running.length) return cur;
    if (Date.now() > deadline) throw new Error(`${running.length} shard(s) still running ${fn} after the wait timeout (see \`ember migrations status ${fn}\`)`);
    await new Promise((r) => setTimeout(r, pollMs));
    const fresh = new Map(
      (await pool(running, o.concurrency ?? 8, async (x) => {
        try {
          return { shard: x.shard, status: await adminRun<MigrationStatus | null>(o, `@${install}/lib:status`, { name: fn }, x.shard) };
        } catch (e) {
          return { shard: x.shard, status: x.status, error: (e as Error).message };
        }
      })).map((x) => [x.shard, x as ShardOutcome]),
    );
    cur = cur.map((x) => fresh.get(x.shard) ?? x);
  }
}

/** `ember migrations status [name]`: the migration's row on each shard (every migration of the shard without a name). */
export async function migrationStatus(o: MigrationsOptions, name?: string): Promise<ShardOutcome[]> {
  const log = o.log ?? ((l: string) => console.log(l));
  const manifest = manifestOf(o.project);
  const install = migrationsInstall(manifest, o.component);
  const shards = await shardsOf(o);
  if (!name) {
    const lists = await pool(shards, o.concurrency ?? 8, async (shard) => {
      try {
        return { shard, list: await adminRun<MigrationStatus[]>(o, `@${install}/lib:list`, {}, shard) };
      } catch (e) {
        return { shard, list: [] as MigrationStatus[], error: (e as Error).message };
      }
    });
    const outs = lists.flatMap((l): ShardOutcome[] => (l.error ? [{ shard: l.shard, status: null, error: l.error }] : l.list.map((s) => ({ shard: l.shard, status: s }))));
    if (o.json) log(JSON.stringify(outs, null, 2));
    else if (!outs.length) log("no migrations recorded");
    else {
      const width = Math.max(...outs.map((x) => x.shard.length));
      for (const x of outs) log(x.error ? `  ${x.shard.padEnd(width)}  FAILED: ${x.error}` : `${line(x.shard, x.status, width)}  ${x.status!.name}`);
    }
    return outs;
  }
  const fn = resolveMigration(manifest, name);
  const outs = await pool(shards, o.concurrency ?? 8, async (shard): Promise<ShardOutcome> => {
    try {
      return { shard, status: await adminRun<MigrationStatus | null>(o, `@${install}/lib:status`, { name: fn }, shard) };
    } catch (e) {
      return { shard, status: null, error: (e as Error).message };
    }
  });
  if (!o.json) log(`${fn} on ${shards.length} shard(s)`);
  print(o, outs);
  return outs;
}

/** `ember migrations cancel <name>`: stops it after the current batch on each shard. */
export async function cancelMigration(o: MigrationsOptions, name: string): Promise<Array<{ shard: string; canceled: boolean; error?: string }>> {
  const log = o.log ?? ((l: string) => console.log(l));
  const manifest = manifestOf(o.project);
  const install = migrationsInstall(manifest, o.component);
  const fn = resolveMigration(manifest, name);
  const shards = await shardsOf(o);
  const outs = await pool(shards, o.concurrency ?? 8, async (shard) => {
    try {
      return { shard, canceled: await adminRun<boolean>(o, `@${install}/lib:cancel`, { name: fn }, shard) };
    } catch (e) {
      return { shard, canceled: false, error: (e as Error).message };
    }
  });
  if (o.json) log(JSON.stringify(outs, null, 2));
  else for (const x of outs) log(`  ${x.shard}  ${x.error ? `FAILED: ${x.error}` : x.canceled ? "canceled" : "not running"}`);
  return outs;
}

/** Exit code: 0 when every shard is done (status / run --wait) or started (run), 1 otherwise. */
export function exitCode(outs: ShardOutcome[], mode: "run" | "wait" | "status"): number {
  if (outs.some((x) => x.error)) return 1;
  if (mode === "run") return outs.some((x) => x.status && x.status.status !== "running" && x.status.status !== "done") ? 1 : 0;
  return outs.every((x) => x.dryRun || x.status?.status === "done") ? 0 : 1;
}
