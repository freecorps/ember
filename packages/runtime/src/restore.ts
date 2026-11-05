// Point-in-time recovery (PLAN §11 `ember restore`, §19 "Operação"; evidence R6 in docs/spikes/remote/RESULTS.md).
//
// R6 showed that `getCurrentBookmark` + `onNextSessionRestoreBookmark` + `ctx.abort()` restores a Durable Object
// exactly and that the returned undo bookmark brings the newer state back, but that `getBookmarkForTime` is coarse
// (it resolves to an older checkpoint and fails for the first minutes of a DO's life). So every shard records its
// own bookmarks in `_ember_bookmarks`:
//   - `deploy:<versionId>`: on the first boot under a new Worker version, before the migration and before any
//     request runs (the state the previous code left behind);
//   - `migrate`: right after a schema migration;
//   - `hourly`: from the hourly maintenance alarm while the shard is active;
//   - `manual:<label>`: on demand (`POST /api/_ember/bookmark`);
//   - `pre-restore` / `undo:<id>` / `restore:<id>`: around a restore.
// The table lives in the shard's own SQLite, so a restore rolls it back too: the restore keeps a copy of every row
// and re-imports the newer ones into the restored database (they stay valid: later bookmarks are still in the
// 30-day history, which is what makes the undo bookmark work).
//
// Restore state machine (one restore = one nonce; docs/design/contracts.md "PITR"):
//   prepare  (old instance) pre-restore row; marker `restore_pending=<nonce>`; System journal entry; then
//            `onNextSessionRestoreBookmark` (→ undo). Any failure before scheduling removes marker and entry.
//   abort    `ctx.abort()`: the next session starts from the bookmark. The marker is newer than the bookmark, so
//            the restored database never has it.
//   finish   (new instance) marker of this nonce present → not applied: same instance = not restarted yet (abort
//            again), another instance = restarted without a scheduled restore (nothing changed: report failure).
//            Marker absent → applied: once per nonce, re-import rows, `undo:` row, new epoch, close sockets.
// Nothing in the shard survives the restore, so the System DO journals every scheduled restore and its alarm
// completes it (finish, abort again if needed) if the Worker request dies between prepare and finish. A restore is
// never reported as done before finish confirmed it applied.

import { stringify } from "./wire.ts";

/** Durable Object PITR history (Cloudflare): bookmarks older than this cannot be restored. */
export const PITR_RETENTION_MS = 30 * 24 * 3_600_000;

export interface BookmarkRow {
  id: number;
  at: number;
  bookmark: string;
  reason: string;
}

export interface RestorePrepared {
  /** The platform's undo bookmark (restores the state right before this restore). */
  undo: string;
  /** Every bookmark row before the restore (re-imported into the restored database). */
  rows: BookmarkRow[];
  /** This restore's id (the `restore_pending` marker). */
  nonce: string;
  /** Id of the object instance that scheduled it (a restart makes a new one). */
  instance: string;
}

export interface RestoreFinishInfo {
  nonce: string;
  instance: string;
  rows: BookmarkRow[];
  /** Null when the System DO completes a restore whose undo bookmark it never learned. */
  undo: string | null;
  bookmark: string;
  label: string;
}

/** `restoreFinish` refusals (in the error message). */
export const NOT_APPLIED = /restore_not_applied/;
export const NOT_SCHEDULED = /restore_not_scheduled/;

export interface RestoreResult {
  ok: true;
  shard: string;
  restoredTo: string;
  undo: string;
  /** Shard state after the restore (new epoch: clients resubscribe with full snapshots). */
  version: number;
  epoch: string;
  schemaVersion: string | null;
}

/** `00000000-00000008-00005119-<hash>`: the format `getCurrentBookmark` returns (R6). */
export const BOOKMARK_RE = /^[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{16,}$/i;

export const isBookmark = (s: string) => BOOKMARK_RE.test(s);

// ------------------------------------------------------------------ Worker admin endpoints

/** What the admin endpoints need from a Shard stub. */
export interface RestoreRpc {
  bookmarks(shard: string): Promise<BookmarkRow[]>;
  bookmarkNow(shard: string, reason: string): Promise<BookmarkRow | null>;
  restorePrepare(shard: string, bookmark: string, label: string): Promise<RestorePrepared>;
  restoreAbort(): Promise<void>;
  restoreFinish(shard: string, info: RestoreFinishInfo): Promise<{ version: number; epoch: string; schemaVersion: string | null }>;
}

/** The System DO's restore journal, as the Worker uses it. */
export interface RestoreJournal {
  restoreSettle(nonce: string): Promise<void>;
}

const reply = (body: unknown, status = 200) => new Response(stringify(body), { status, headers: { "content-type": "application/json" } });
const fail = (status: number, code: string, message: string) => reply({ ok: false, error: { code, message } }, status);

/**
 * `GET /api/_ember/bookmarks?shard=` (list), `POST /api/_ember/bookmark {shard, label?}` (record now) and
 * `POST /api/_ember/restore {shard, bookmark, label?}`. The caller has checked the admin token. Target resolution
 * (deploy / time) happens in the CLI, which shows the choice and asks for confirmation; this endpoint restores an
 * exact bookmark.
 */
export async function handleRestoreRequest(
  request: Request,
  url: URL,
  stub: (shard: string) => RestoreRpc,
  validShard: (s: string) => boolean,
  journal: RestoreJournal | null = null,
): Promise<Response | null> {
  const path = url.pathname;
  if (path === "/api/_ember/bookmarks") {
    if (request.method !== "GET") return fail(405, "method_not_allowed", "use GET");
    const shard = url.searchParams.get("shard") ?? "global:main";
    if (!validShard(shard)) return fail(400, "bad_shard", `invalid shard ${JSON.stringify(shard)}`);
    return reply({ ok: true, shard, now: Date.now(), retentionMs: PITR_RETENTION_MS, bookmarks: await stub(shard).bookmarks(shard) });
  }
  if (path !== "/api/_ember/bookmark" && path !== "/api/_ember/restore") return null;
  if (request.method !== "POST") return fail(405, "method_not_allowed", "use POST");
  let body: { shard?: unknown; bookmark?: unknown; label?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return fail(400, "bad_request", "expected a JSON body");
  }
  const shard = typeof body.shard === "string" ? body.shard : "";
  if (!validShard(shard)) return fail(400, "bad_shard", `invalid shard ${JSON.stringify(body.shard)}`);
  const label = typeof body.label === "string" && /^[\w.:@-]{1,80}$/.test(body.label) ? body.label : "";
  if (path === "/api/_ember/bookmark") {
    const row = await stub(shard).bookmarkNow(shard, label ? `manual:${label}` : "manual");
    return row ? reply({ ok: true, shard, bookmark: row }) : fail(501, "pitr_unavailable", "this runtime has no point-in-time recovery (local workerd?)");
  }
  const bookmark = typeof body.bookmark === "string" ? body.bookmark.trim() : "";
  if (!isBookmark(bookmark)) return fail(400, "bad_bookmark", "bookmark must look like 0000000a-0000000b-0000000c-<hash>");
  const id = label || new Date().toISOString().replace(/[:.]/g, "");
  let prepared: RestorePrepared;
  try {
    prepared = await stub(shard).restorePrepare(shard, bookmark, id);
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    if (/invalid bookmark/i.test(msg)) return fail(400, "bad_bookmark", msg);
    if (/restore_in_progress/.test(msg)) return fail(409, "restore_in_progress", msg);
    if (/point-in-time recovery/i.test(msg)) return fail(501, "pitr_unavailable", `${msg} (local workerd has no PITR; restore works on Cloudflare)`);
    return fail(500, "restore_failed", msg);
  }
  // The restore applies when the object restarts: abort it (the call itself fails by design, so its error says
  // nothing), then let restoreFinish tell whether it applied. Abort again only while finish says "not restarted".
  const info: RestoreFinishInfo = { nonce: prepared.nonce, instance: prepared.instance, rows: prepared.rows, undo: prepared.undo, bookmark, label: id };
  const settle = () => journal?.restoreSettle(prepared.nonce).catch(() => undefined);
  let abort = true;
  let last: unknown = null;
  for (let i = 0; i < 6; i++) {
    if (abort) await stub(shard).restoreAbort().catch(() => undefined);
    try {
      const after = await stub(shard).restoreFinish(shard, info);
      await settle();
      const out: RestoreResult = { ok: true, shard, restoredTo: bookmark, undo: prepared.undo, ...after };
      return reply(out);
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      if (NOT_SCHEDULED.test(msg)) {
        await settle();
        return fail(500, "restore_failed", `${msg} (the shard keeps its current data)`);
      }
      // Not restarted yet: abort again. Anything else: the aborted instance may still be shutting down; retry.
      abort = NOT_APPLIED.test(msg);
      last = e;
      await new Promise((r) => setTimeout(r, 100 * 2 ** i));
    }
  }
  return fail(
    500,
    "restore_unconfirmed",
    `restore of ${shard} to ${bookmark} is scheduled but not confirmed (${(last as Error)?.message ?? last}): it applies when the shard restarts${journal ? " and the System DO completes it" : ""}; undo bookmark ${prepared.undo}`,
  );
}
