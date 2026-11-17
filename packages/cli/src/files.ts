// `ember files orphans` (contracts.md "Files", orphan sweep): objects of the files bucket that no `_files` row of
// their shard references (an upload whose registration failed, a presigned upload never confirmed, a shard restored
// to before its rows). Pages through the runtime's `POST /api/_ember/files/orphans`, one page of the bucket per
// request: neither the CLI nor the Worker ever holds the whole bucket. A dry run by default.

import { checkCredentialUrl } from "./secure-url.ts";

/** Objects newer than this are never orphans by default (an upload in flight, an import between blob and row). */
export const DEFAULT_GRACE_MS = 24 * 3_600_000;
/** Below this the CLI warns: a slow upload or an `ember import` running now may still be between object and row. */
export const SHORT_GRACE_MS = 3_600_000;

export interface OrphanEntry {
  key: string;
  shard: string;
  size: number;
  uploaded: number;
}

interface OrphanPage {
  scanned: number;
  foreign: number;
  young: number;
  orphans: OrphanEntry[];
  deleted: number;
  skipped: Array<{ shard: string; keys: number; code: string; message: string }>;
  graceMs: number;
  cursor: string | null;
  done: boolean;
}

export interface FilesOrphansOptions {
  url: string;
  adminToken: string;
  graceMs?: number;
  delete?: boolean;
  /** Objects per request (1..1000). */
  limit?: number;
  json?: boolean;
  fetch?: typeof fetch;
  log?: (line: string) => void;
}

export interface FilesOrphansSummary {
  scanned: number;
  foreign: number;
  young: number;
  orphans: number;
  bytes: number;
  deleted: number;
  /** Shards that could not answer (refused, unreachable): their objects were left alone. */
  skipped: Array<{ shard: string; keys: number; code: string; message: string }>;
  graceMs: number;
  dryRun: boolean;
}

/** `24h`, `90m`, `7d`, `30s`, or milliseconds. */
export function parseDuration(s: string, what = "--grace"): number {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(s.trim());
  if (!m) throw new Error(`${what}: expected a duration like 24h, 90m, 7d or milliseconds, got ${JSON.stringify(s)}`);
  const mult = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[(m[2] ?? "ms") as "ms" | "s" | "m" | "h" | "d"];
  return Math.round(Number(m[1]) * mult);
}

export async function filesOrphans(o: FilesOrphansOptions): Promise<FilesOrphansSummary> {
  const log = o.log ?? ((l: string) => console.log(l));
  const base = checkCredentialUrl(o.url);
  const graceMs = o.graceMs ?? DEFAULT_GRACE_MS;
  const sum: FilesOrphansSummary = { scanned: 0, foreign: 0, young: 0, orphans: 0, bytes: 0, deleted: 0, skipped: [], graceMs, dryRun: !o.delete };
  if (!o.json && graceMs < SHORT_GRACE_MS) log(`warning: a grace period under 1h may catch an upload in flight or an \`ember import\` running now`);
  let cursor: string | null = null;
  // A cursor seen twice would page (and, with --delete, sweep) the same objects forever: an error, not a hang.
  const seen = new Set<string>();
  do {
    const res = await (o.fetch ?? fetch)(new URL("/api/_ember/files/orphans", base), {
      method: "POST",
      headers: { authorization: `Bearer ${o.adminToken}`, "content-type": "application/json" },
      body: JSON.stringify({ graceMs, delete: !!o.delete, ...(o.limit ? { limit: o.limit } : {}), ...(cursor ? { cursor } : {}) }),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; value?: OrphanPage; error?: { code: string; message: string } };
    if (res.status === 404) throw new Error("the deployed runtime has no files/orphans endpoint (admin API level 12): deploy a newer @freecorps/ember-runtime");
    if (!res.ok || !body.ok || !body.value) throw new Error(`files orphans: ${body.error?.code ?? res.status}: ${body.error?.message ?? "failed"}`);
    const p = body.value;
    sum.scanned += p.scanned;
    sum.foreign += p.foreign;
    sum.young += p.young;
    sum.deleted += p.deleted;
    sum.skipped.push(...p.skipped);
    for (const x of p.orphans) {
      sum.orphans++;
      sum.bytes += x.size;
      if (o.json) log(JSON.stringify({ [o.delete ? "deleted" : "orphan"]: x }));
      else log(`${o.delete ? "deleted" : "orphan "} ${x.key}  ${x.shard}  ${x.size} B  ${new Date(x.uploaded).toISOString()}`);
    }
    for (const s of p.skipped) if (!o.json) log(`skipped ${s.shard} (${s.keys} object(s)): ${s.code}: ${s.message}`);
    if (p.cursor !== null && seen.has(p.cursor)) throw new Error(`files orphans: the runtime returned the same cursor twice (${p.cursor})`);
    if (p.cursor !== null) seen.add(p.cursor);
    cursor = p.cursor;
  } while (cursor);
  if (o.json) log(JSON.stringify({ summary: sum }));
  else {
    const verb = o.delete ? `${sum.deleted} deleted` : `${sum.orphans} orphan(s), ${sum.bytes} bytes (dry run: pass --delete to remove them)`;
    log(`${sum.scanned} object(s) scanned: ${verb}; ${sum.young} newer than the grace period, ${sum.foreign} not Ember's, ${sum.skipped.length} shard(s) skipped`);
  }
  return sum;
}
