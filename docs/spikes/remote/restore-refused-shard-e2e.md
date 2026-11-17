# Restore of a shard refused by RuntimeSchemaTooNew, from the older runtime: E2E on Cloudflare production

Run on 2026-11-17 between 18:29 and 18:47 UTC on a paid Cloudflare account, at commit `2c57313` of PR #116 (the
commit that added `ember restore --discard-newer`). Local workerd has no point-in-time recovery, so the tests in
`packages/runtime/test/restore.test.ts` run the decision logic against a fake; this run is the only time the real
path (`onNextSessionRestoreBookmark`, the platform's restart on the bookmark, the key-value marker coming back with
the restore) was exercised. Nothing here runs in CI.

- **Resources.** One Worker, `ember-ember-example-chat-verify` (`examples/chat`, a throwaway `verify` environment
  added to `ember.json` locally, never committed), with its Shard and System Durable Objects, and that project's rows
  in the account registry. `ember destroy --env verify --yes` deleted the Worker (a GET of `/health` answered 404
  afterwards), and the registry rows of the project were removed (1 project, 1 environment, 7 deployments, 1 shard).
- **Runtimes.** A and C are the PR's runtime (`RUNTIME_SCHEMA = 5`). B is the same code with a temporary local patch
  to `packages/runtime/src/shard.ts`, never committed: `RUNTIME_SCHEMA = 6` and, at the end of
  `upgradeRuntimeTables`, `if (from < 6) sql.exec("CREATE TABLE IF NOT EXISTS _ember_v6_probe (x TEXT)")`.
- **Driver.** The `ember` CLI of the branch (`deploy`, `run`, `restore`, `logs`, `destroy`) and `curl` on
  `GET /api/_ember/status` and `GET /api/_ember/inspect`, with the admin token of the throwaway environment.

## Steps and what was seen

| # | Step | Expected | Seen |
|---|---|---|---|
| 1 | Deploy A; `rooms:create {"name":"before-newer"}`; `restore --list` | a `deploy:<vA>` row with a bookmark | as expected |
| 2 | Deploy B; `restore --list` | a new `deploy:<vB>` row, taken before the runtime tables were upgraded | as expected (`deploy:c25dc293…`) |
| 3 | Under B: create `under-newer`; `restore --mark under-newer` (bookmark `M`, taken under B); create `after-mark` | three rooms | as expected |
| 4 | Deploy C (the older runtime again), no `--wait` | status `ready: false`, `migrationError.code: "RuntimeSchemaTooNew"`, `restores: []`; `rooms:list` refused with the code | as expected; the message names both ways out (`data: { stored: "6", supported: "5" }`) |
| 5 | `restore --to deploy:<vB> --yes`, without `--discard-newer` | the CLI stops, nothing changes | "refused by RuntimeSchemaTooNew … restore from this runtime with --discard-newer"; status unchanged, `restores: []` |
| 6 | `restore --to <M> --discard-newer --yes` (a target still ahead) | `409 restore_still_ahead`, a pending journal entry with the undo bookmark | as expected. **This is the case that needed PITR to roll the key-value marker back with the SQL tables: it does** (a marker that survived would have answered `500 restore_failed … restore_not_scheduled`) |
| 7 | Deploy B again | the pending restore completes; rooms `before-newer`, `under-newer`, no `after-mark`; `undo:` and `restore:` rows | as expected, about 20 s after the deploy |
| 8 | Deploy C again | refused as in step 4 | as expected |
| 9 | `restore --to deploy:<vB> --discard-newer` on a terminal | the "DISCARDS everything written after that point…" note and the question "Restore global:main and discard what the newer runtime wrote?" | both printed as written |
| 10 | The same with `--yes` | `restored global:main …` and an `undo:` line | `restored global:main (version 1, schema 898976a21b11)` and the undo command |
| 11 | After step 10 | status `ready: true`, `migrationError: null`, `restores: []`; only `before-newer`; a new mutation works; `undo:<label>` and `restore:<label>` rows, no `pre-restore:<label>`; a new `deploy:<vC>` row; alarm armed | as expected (`inspect`: `alarm` set, `files.total: 0`) |
| 12 | `restore --to <undo of step 10> --discard-newer --yes` | the undo state is ahead: `409 restore_still_ahead`, pending | as expected |
| 13 | Deploy B again | the pending undo completes: `before-newer` and `under-newer` are back | as expected, 10 minutes after the deploy (see "Timing") |
| 14 | Deploy C; `restore --to deploy:<vB> --discard-newer --yes` once more | as steps 10 and 11 | as expected: `ready: true`, only `before-newer` |
| 15 | `ember destroy --env verify --yes` | the Worker is gone | `/health` answers 404 |

## Not captured

- **The log line of the restore.** `ember logs` was left tailing during steps 10 and 14, and both times the capture
  was empty because of how the tail was piped to a file (a mistake of the run, not of the runtime). A tail redone
  afterwards, with the restored shard serving a mutation, a query and `inspect`, showed `ok` for every request and no
  `ember: alarm failed`. The line `ember: restore of … scheduled from a refused shard (RuntimeSchemaTooNew,
  discardNewer)` itself was not seen.
- **`last_error` in step 6.** The pending entry had `last_error: null` on the first read of the status; the error text
  appears after the System DO's first retry.

## Timing

After a deploy, the platform kept the shard's previous instance (running the previous code) for a while: about 20
seconds in step 7 and about 5 minutes in step 13. With the journal's backoff on top, the pending restore of step 13
completed 10 minutes after the deploy. `ember deploy --wait` right after such a deploy fails at once with
`RuntimeSchemaTooNew`, because the status it reads is the old instance's.

## Found on the way

After step 10, `restore --list` no longer showed the `deploy:<vB>` row: the bookmark that had just been restored to.
`restoreFinish` re-imported the rows it had read before the restore with `INSERT OR IGNORE` by `id`, and the boot
after the restore had already recorded `deploy:<vC>` under the id that row had. The bookmark itself was never lost
(PITR keeps it); only the row in the list was. Fixed in the same PR: a row counts as present only when its bookmark
and reason are, a row whose id went to another is kept under a new id, and the list (and the CLI's deploy-point
resolution) orders by time. The fix has a test in `restore.test.ts`; it was not re-run against Cloudflare.
