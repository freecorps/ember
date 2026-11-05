// `ember restore` (PLAN §11, §19 "Operação"): point-in-time recovery of shards through the bookmarks each shard
// records itself (per deploy, per migration, hourly; R6 showed `getBookmarkForTime` is too coarse). The Worker's
// admin endpoints (`@freecorps/ember-runtime` restore.ts) list bookmarks and restore an exact one; this module
// resolves `--to` (bookmark | deploy:<version> | time), shows the plan, asks for confirmation and prints the undo
// bookmark of every restore.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Project } from "./config.ts";

/** Durable Object PITR history (Cloudflare): bookmarks older than this cannot be restored. */
export const PITR_RETENTION_MS = 30 * 24 * 3_600_000;
/** Margin: a bookmark this close to the 30-day edge may expire while the restore runs. */
export const PITR_SAFETY_MS = 10 * 60_000;

/** `_ember_bookmarks` row (same shape as `BookmarkRow` in @freecorps/ember-runtime restore.ts). */
export interface BookmarkRow {
  id: number;
  at: number;
  bookmark: string;
  reason: string;
}

/** `00000000-00000008-00005119-<hash>`: the format `getCurrentBookmark` returns (R6). */
export const BOOKMARK_RE = /^[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{16,}$/i;
export const isBookmark = (s: string) => BOOKMARK_RE.test(s);

export type RestoreTarget =
  | { kind: "bookmark"; bookmark: string }
  | { kind: "deploy"; version: string }
  | { kind: "time"; at: number };

/**
 * Parses `--to`: a raw bookmark, `deploy:<versionId or prefix>`, an ISO time (`2026-11-04T20:00:00Z`), epoch ms, or a
 * relative time (`-90m`, `-2h`, `-1d`).
 */
export function parseRestoreTarget(to: string, now = Date.now()): RestoreTarget {
  const s = to.trim();
  if (isBookmark(s)) return { kind: "bookmark", bookmark: s };
  if (s.startsWith("deploy:")) {
    const version = s.slice("deploy:".length);
    if (!/^[0-9a-f-]{4,}$/i.test(version)) throw new Error(`invalid deploy target ${JSON.stringify(s)}: expected deploy:<version id (or a prefix of ≥4 chars)>`);
    return { kind: "deploy", version: version.toLowerCase() };
  }
  const rel = /^-(\d+(?:\.\d+)?)(s|m|h|d)$/.exec(s);
  if (rel) {
    const mult = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[rel[2] as "s" | "m" | "h" | "d"];
    return { kind: "time", at: Math.round(now - Number(rel[1]) * mult) };
  }
  if (/^\d{12,}$/.test(s)) return { kind: "time", at: Number(s) };
  const t = Date.parse(s);
  if (Number.isFinite(t) && /\d{4}-\d{2}-\d{2}/.test(s)) return { kind: "time", at: t };
  throw new Error(`cannot parse restore target ${JSON.stringify(to)}: use a bookmark, deploy:<version>, an ISO time or -2h`);
}

export type ResolvedBookmark =
  | { ok: true; bookmark: string; at: number | null; reason: string; exact: boolean }
  | { ok: false; code: "not_found" | "expired" | "ambiguous"; message: string };

/**
 * Picks the bookmark for `target` among a shard's recorded rows.
 * - bookmark: as given (its age is checked if it is one of ours);
 * - deploy: the row `deploy:<version>` (prefix match; refuses an ambiguous prefix);
 * - time: the newest row at or before the time (exact: our bookmarks are exact, the time is not).
 */
export function resolveBookmark(rows: BookmarkRow[], target: RestoreTarget, now = Date.now()): ResolvedBookmark {
  const minAt = now - PITR_RETENTION_MS + PITR_SAFETY_MS;
  const expired = (at: number) => at < minAt;
  if (target.kind === "bookmark") {
    const row = rows.find((r) => r.bookmark === target.bookmark);
    if (row && expired(row.at)) return { ok: false, code: "expired", message: `bookmark from ${new Date(row.at).toISOString()} is outside the 30-day PITR window` };
    return { ok: true, bookmark: target.bookmark, at: row?.at ?? null, reason: row?.reason ?? "bookmark", exact: true };
  }
  if (target.kind === "deploy") {
    const r = resolveDeployPoint(rows, target.version, null, now);
    return "skip" in r ? { ok: false, code: "not_found", message: r.message } : r;
  }
  if (target.at > now) return { ok: false, code: "not_found", message: "the target time is in the future" };
  if (expired(target.at)) return { ok: false, code: "expired", message: `${new Date(target.at).toISOString()} is outside the 30-day PITR window` };
  const before = rows.filter((r) => r.bookmark && r.at <= target.at).sort((a, b) => b.at - a.at || b.id - a.id)[0];
  if (!before) return { ok: false, code: "not_found", message: `no bookmark recorded at or before ${new Date(target.at).toISOString()}` };
  if (expired(before.at)) return { ok: false, code: "expired", message: `the newest bookmark before that time (${new Date(before.at).toISOString()}) is outside the 30-day PITR window` };
  return { ok: true, bookmark: before.bookmark, at: before.at, reason: before.reason, exact: before.at === target.at };
}

/** A boot record: `deploy:<v>` (bookmark taken on the first boot under v) or `deploy-missed:<v>` (it could not be). */
const bootVersion = (r: BookmarkRow): string | null =>
  r.reason.startsWith("deploy:") ? r.reason.slice(7).toLowerCase() : r.reason.startsWith("deploy-missed:") ? r.reason.slice(14).toLowerCase() : null;

/**
 * `--to deploy:X`: per shard, the state right before it first ran X or any version deployed after X (deployed at
 * `deployedAt`, from the registry), i.e. everything written by X and later code is rolled back, nothing older is.
 * Every first boot under a new version records `deploy:<v>` before the migration and before any request (a new
 * shard too: its state then is empty), so the target is the shard's oldest boot record that is X itself (by
 * version, independent of clocks) or was recorded at or after `deployedAt`:
 * - none: the shard has not booted since X went live, so nothing changed: skip;
 * - `deploy-missed:<v>`: that boot could not take a bookmark: refuse (restore the shard by time);
 * - any other bookmark row recorded after `deployedAt` but before that boot record (or with no boot record) means
 *   the shard ran without recording its boot (e.g. no version binding): refuse rather than guess.
 * Not "the newest bookmark at or before deployedAt": that one can be hours or days older and would also roll
 * back writes made by the previous code before X went live.
 */
export function resolveDeployPoint(rows: BookmarkRow[], version: string, deployedAt: number | null, now = Date.now()): ResolvedBookmark | { ok: true; skip: true; message: string } {
  const v = version.toLowerCase();
  const sorted = [...rows].sort((a, b) => a.id - b.id);
  const own = new Set(sorted.map(bootVersion).filter((b): b is string => b !== null && b.startsWith(v)));
  if (own.size > 1) return { ok: false, code: "ambiguous", message: `deploy:${v} matches ${[...own].map((x) => `deploy:${x}`).join(", ")}` };
  const target = sorted.find((r) => {
    const b = bootVersion(r);
    return b !== null && (b.startsWith(v) || (deployedAt !== null && r.at >= deployedAt));
  });
  if (deployedAt !== null) {
    const stray = sorted.find((r) => bootVersion(r) === null && r.at > deployedAt && (!target || r.id < target.id));
    if (stray) {
      return { ok: false, code: "not_found", message: `${stray.reason} (${new Date(stray.at).toISOString()}) was recorded after deploy:${v} went live with no boot record before it: restore this shard by time` };
    }
  }
  if (!target) {
    if (deployedAt === null) return { ok: false, code: "not_found", message: `no bookmark for deploy:${v} on this shard (it did not boot under that version)` };
    return { ok: true, skip: true, message: "no boot since that deploy: already in that state" };
  }
  if (!target.bookmark) return { ok: false, code: "not_found", message: `${target.reason}: the boot under that version could not record a bookmark; restore this shard by time` };
  if (target.at < now - PITR_RETENTION_MS + PITR_SAFETY_MS) return { ok: false, code: "expired", message: `${target.reason} (${new Date(target.at).toISOString()}) is outside the 30-day PITR window` };
  const exact = bootVersion(target)!.startsWith(v);
  return { ok: true, bookmark: target.bookmark, at: target.at, reason: exact ? target.reason : `${target.reason} (first boot since deploy:${v})`, exact };
}


// ------------------------------------------------------------------ admin API client

export interface RestoreClientOptions {
  /** Deployment base URL. */
  url: string;
  adminToken: string;
  fetch?: typeof fetch;
}

export interface RestoreResult {
  ok: true;
  shard: string;
  restoredTo: string;
  undo: string;
  version: number;
  epoch: string;
  schemaVersion: string | null;
}

async function admin<T>(o: RestoreClientOptions, method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const res = await (o.fetch ?? fetch)(new URL(path, o.url), {
    method,
    headers: { authorization: `Bearer ${o.adminToken}`, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed: { ok?: boolean; error?: { code: string; message: string } } & Record<string, unknown>;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${method} ${path}: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  if (!res.ok || parsed.ok === false) throw Object.assign(new Error(`${method} ${path}: ${parsed.error?.code ?? res.status}: ${parsed.error?.message ?? text.slice(0, 200)}`), { code: parsed.error?.code });
  return parsed as T;
}

export const listBookmarks = async (o: RestoreClientOptions, shard: string) =>
  (await admin<{ bookmarks: BookmarkRow[]; now: number }>(o, "GET", `/api/_ember/bookmarks?shard=${encodeURIComponent(shard)}`)).bookmarks;

export const recordBookmark = async (o: RestoreClientOptions, shard: string, label?: string) =>
  (await admin<{ bookmark: BookmarkRow }>(o, "POST", "/api/_ember/bookmark", { shard, ...(label ? { label } : {}) })).bookmark;

export const restoreShard = (o: RestoreClientOptions, shard: string, bookmark: string, label?: string) =>
  admin<RestoreResult>(o, "POST", "/api/_ember/restore", { shard, bookmark, ...(label ? { label } : {}) });

// ------------------------------------------------------------------ command

export interface RestoreCommandOptions extends RestoreClientOptions {
  /** One shard (`--shard`), or every shard in the catalog (`all`). */
  shard?: string;
  all?: boolean;
  list?: boolean;
  /** Record a bookmark now (`--mark [label]`), e.g. before a risky import. */
  mark?: string | true;
  to?: string;
  /** Skip the confirmation prompt. */
  yes?: boolean;
  json?: boolean;
  concurrency?: number;
  /** `--all`: shards of this project/env in the registry catalog, and the deploy time of a version (prefix). */
  catalog?: () => Promise<string[]>;
  deployTime?: (versionPrefix: string) => Promise<number | null>;
  /** Writes the undo plan of an `--all` restore (default: `<project>/.ember/restores/<time>.json`). */
  project?: Project;
  confirm?: (question: string) => Promise<boolean>;
  log?: (line: string) => void;
  now?: () => number;
}

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const ago = (ms: number) => {
  const s = Math.round(ms / 1000);
  if (s < 120) return `${s}s ago`;
  if (s < 7200) return `${Math.round(s / 60)}m ago`;
  if (s < 172800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

export async function promptYesNo(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) throw new Error("refusing to restore without confirmation: not a terminal (pass --yes)");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
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

/** `ember restore`. Returns the restores done (empty for `--list`, a refusal or a cancelled prompt). */
export async function restoreCommand(o: RestoreCommandOptions): Promise<RestoreResult[]> {
  const log = o.log ?? ((l: string) => console.log(l));
  const now = (o.now ?? Date.now)();
  const confirm = o.confirm ?? promptYesNo;
  if (!!o.all === !!o.shard) throw new Error("pass exactly one of --shard <kind:key> or --all");

  if (o.mark !== undefined) {
    if (!o.shard) throw new Error("--mark needs --shard");
    const row = await recordBookmark(o, o.shard, o.mark === true ? undefined : o.mark);
    log(`${o.shard}: bookmark ${row.bookmark} (${row.reason}, ${iso(row.at)})`);
    log(`restore with: ember restore --shard ${o.shard} --to ${row.bookmark}`);
    return [];
  }

  if (o.list) {
    if (!o.shard) throw new Error("--list needs --shard");
    const rows = await listBookmarks(o, o.shard);
    if (o.json) {
      log(JSON.stringify(rows, null, 2));
      return [];
    }
    if (!rows.length) {
      log(`${o.shard}: no bookmarks recorded yet (the first one is taken on the next deploy, migration or active hour)`);
      return [];
    }
    log(`${o.shard}: ${rows.length} bookmark(s), oldest first (PITR keeps 30 days)`);
    for (const r of rows) {
      const expired = r.at < now - PITR_RETENTION_MS;
      log(`  ${String(r.id).padStart(4)}  ${iso(r.at)}  ${ago(now - r.at).padStart(8)}  ${r.reason.padEnd(28)} ${r.bookmark || "(no bookmark: PITR was unavailable)"}${expired ? "  (expired)" : ""}`);
    }
    log(`restore with: ember restore --shard ${o.shard} --to <bookmark | deploy:<version> | ISO time | -2h>`);
    return [];
  }

  if (!o.to) throw new Error("pass --to <bookmark | deploy:<version> | ISO time | -2h> (or --list)");
  const target = parseRestoreTarget(o.to, now);

  // Unknown deploy time (no registry access): only shards with their own deploy:<v> row resolve; others refuse.
  const deployedAt =
    target.kind === "deploy" && o.deployTime
      ? await o.deployTime(target.version).catch((e: Error) => (log(`warning: deploy time of ${target.version} unknown (${e.message})`), null))
      : null;

  if (o.shard) {
    const rows = await listBookmarks(o, o.shard);
    const r = target.kind === "deploy" ? resolveDeployPoint(rows, target.version, deployedAt, now) : resolveBookmark(rows, target, now);
    if ("skip" in r) {
      log(`${o.shard}: ${r.message}`);
      return [];
    }
    if (!r.ok) throw new Error(`${o.shard}: ${r.message}`);
    log(`restore ${o.shard} to ${r.bookmark}`);
    log(`  ${r.reason}${r.at !== null ? ` recorded ${iso(r.at)} (${ago(now - r.at)})` : " (not one of this shard's recorded bookmarks)"}${target.kind === "time" && !r.exact ? `: the newest bookmark at or before ${iso(target.at)}` : ""}`);
    log("  every write after that point is rolled back (data, jobs, files metadata); an undo bookmark is printed after the restore");
    if (!o.yes && !(await confirm(`Restore ${o.shard}?`))) {
      log("cancelled");
      return [];
    }
    const out = await restoreShard(o, o.shard, r.bookmark);
    log(`restored ${o.shard} (version ${out.version}, schema ${out.schemaVersion?.slice(0, 12) ?? "-"})`);
    log(`  undo: ember restore --shard ${o.shard} --to ${out.undo} --yes`);
    return [out];
  }

  // --all: every shard of the catalog, to a deploy point (or a time).
  if (target.kind === "bookmark") throw new Error("--all needs --to deploy:<version> or a time (a raw bookmark belongs to one shard)");
  if (!o.catalog) throw new Error("--all needs the account registry (the shard catalog)");
  const shards = await o.catalog();
  if (!shards.length) throw new Error("the registry catalog lists no shards for this environment (shards report after their first migration)");
  type Plan = { shard: string; bookmark?: string; note: string };
  const plans: Plan[] = await pool(shards, o.concurrency ?? 8, async (shard): Promise<Plan> => {
    try {
      const rows = await listBookmarks(o, shard);
      const r = target.kind === "deploy" ? resolveDeployPoint(rows, target.version, deployedAt, now) : resolveBookmark(rows, target, now);
      if ("skip" in r) return { shard, note: `skip: ${r.message}` };
      if (!r.ok) return { shard, note: `cannot restore: ${r.message}` };
      return { shard, bookmark: r.bookmark, note: `${r.reason}${r.at !== null ? ` @ ${iso(r.at)}` : ""}` };
    } catch (e) {
      return { shard, note: `cannot read bookmarks: ${(e as Error).message}` };
    }
  });
  const todo = plans.filter((p) => p.bookmark);
  const blocked = plans.filter((p) => !p.bookmark && !p.note.startsWith("skip"));
  log(`restore ${shards.length} shard(s) to ${o.to}${deployedAt !== null ? ` (deployed ${iso(deployedAt)})` : ""}:`);
  for (const p of plans) log(`  ${p.shard.padEnd(32)} ${p.bookmark ? "restore  " : ""}${p.note}`);
  if (blocked.length) throw new Error(`${blocked.length} shard(s) cannot be restored to that point; nothing was changed`);
  if (!todo.length) {
    log("nothing to restore");
    return [];
  }
  if (!o.yes && !(await confirm(`Restore ${todo.length} shard(s)?`))) {
    log("cancelled");
    return [];
  }
  const label = `all-${iso(now).replace(/[:]/g, "")}`;
  const results = await pool(todo, o.concurrency ?? 4, async (p) => {
    try {
      return await restoreShard(o, p.shard, p.bookmark!, label);
    } catch (e) {
      return { ok: false as const, shard: p.shard, error: (e as Error).message };
    }
  });
  const done = results.filter((r): r is RestoreResult => r.ok);
  for (const r of results) {
    if (r.ok) log(`  restored ${r.shard}; undo: ember restore --shard ${r.shard} --to ${r.undo} --yes`);
    else log(`  FAILED ${r.shard}: ${r.error}`);
  }
  if (o.project) {
    const dir = join(o.project.stateDir, "restores");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${label}.json`);
    writeFileSync(file, JSON.stringify({ to: o.to, at: now, shards: results }, null, 2) + "\n");
    log(`undo bookmarks saved to ${file}`);
  }
  if (done.length !== results.length) throw new Error(`${results.length - done.length} of ${results.length} restore(s) failed (see above)`);
  return done;
}
