# DO SQLite spike: results

Everything below ran **locally only**: `@cloudflare/vitest-plugin@1.5.1` (the renamed `@cloudflare/vitest-pool-workers`, which is deprecated at 0.23.0), using miniflare `5.20261103.0-beta` and workerd `1.20261103.1`, vitest 4.1.12, wrangler 4.157.0, on macOS arm64. Nothing was deployed and no remote resources were used. `compatibility_date` is `2026-10-01` with `nodejs_compat`.

Result: **25 tests passed, 1 opt-in long test passed separately (retry limit, about 245 s).**

Source tags used in the table:
- **[local]**: measured in this spike.
- **[docs]**: from developers.cloudflare.com, fetched 2026-11-04.
- **[unknown→remote]**: production behaviour may differ and needs a remote test.

## Rerun

```bash
cd spikes/do-sqlite
pnpm install                                  # pnpm.onlyBuiltDependencies already allows esbuild + workerd
pnpm test                                     # = vitest run --silent=false --reporter=verbose (~20 s)
pnpm test 2>&1 | grep '^RESULT'               # every measurement is printed as: RESULT <id> <json>
RUN_LONG=1 npx vitest run test/q5-alarms.test.ts -t "retry limit" --silent=false   # ~4 min, alarm retry exhaustion
```
Saved outputs are in `test-output.log` (full suite) and `test-output-long-alarm.log`.

Files:
- `src/index.ts`: the `SpikeDO` class (scheduler, alarm retry probe, hibernating WebSocket handlers).
- `test/q*.test.ts`: one file per question group.
- `wrangler.jsonc` and `vitest.config.ts`.

---

## Q1: FTS5

| Check | Result | Evidence |
|---|---|---|
| `tokenize='unicode61 remove_diacritics 2'`: does `acao` match `ação`? | **PASS** [local] | `MATCH 'acao'` and `MATCH 'AÇÃO'` both return "Uma ação judicial". The prefix query `cora*` returns "Coração valente". |
| `tokenize='trigram'` substring search | **PASS** [local] | `MATCH 'nvoic'` returns "Overdue INVOICE #42". `LIKE '%nvoic%'` works too. A 2-char query returns `[]` with no error, because trigram needs at least 3 chars. `trigram case_sensitive 0 remove_diacritics 1` is accepted, and `acao` matches "Fatura de ação". |
| External-content table (`content='messages', content_rowid='id'`) kept in sync by AFTER INSERT/UPDATE/DELETE triggers | **PASS** [local] | Insert gives 2 hits. After the UPDATE, `fox` gives 1 hit and `animals` gives 1. After the DELETE, `fox` gives 0. The `'integrity-check'`, `'rebuild'` and `'optimize'` commands all return ok. |
| `bm25()`, `ORDER BY rank`, `snippet()`, `highlight()` | **PASS** [local] | e.g. `score=-1.64e-6`, `snip="[fox] [fox]"`, `hl="<b>fox</b> once in a long sentence…"` |
| `fts5vocab` | **PASS** [local] | `fts5vocab(messages_fts,'row')` returns `{term:"fox",doc:2,cnt:3}` and so on. |
| Other virtual tables | [local] | `rtree`: **ok**. `fts4`: `not authorized: SQLITE_AUTH`. `dbstat` and `generate_series`: `no such table`. |
| Version / compile options | [local] | `sqlite_version()` gives `not authorized to use function: sqlite_version`. `PRAGMA compile_options` and `sqlite_compileoption_used()` are not authorized either. **You cannot detect the SQLite version at runtime.** |

## Q2: SQL features

| Check | Result | Evidence |
|---|---|---|
| `json_extract`, `->`, `->>`, `json_each`, `json_tree`, `json_group_array`, `json_set`, `json_patch`, `jsonb()`, `json_valid` | **PASS** [local] | All return the expected values. |
| Math functions | **PASS, with one gap** [local] | These work: `sqrt`, `pow`, `ln`, `log(x)`, `log(b,x)`, `log2`, `exp`, `sin`, `atan2`, `trunc`, `sign`, `degrees`, `floor`, `ceil`, `pi`, `mod`. **`log10()` fails with `not authorized to use function: log10`**; use `log(x)` (base 10) instead. `printf`/`format`, `concat_ws`, `unhex`, `iif`, `unixepoch()`, `octet_length` all work. |
| Generated columns: VIRTUAL and STORED in CREATE TABLE | **PASS** [local] | `email ... VIRTUAL` and `age ... STORED` from `json_extract(doc,…)` both compute correctly. |
| Indexes on generated columns, indexes on expressions, partial indexes | **PASS** [local] | The query plans use them: `SEARCH users USING INDEX users_email (email=?)`, `USING INDEX users_name_expr (<expr>=?)`, and `USING INDEX users_live_age (age>?)` for a `deleted = 0` partial index. A UNIQUE index on a generated column enforces uniqueness: `UNIQUE constraint failed: users.email`. |
| STRICT | **PASS** [local] | Bad types are rejected: `cannot store TEXT value in INTEGER column users.deleted: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_DATATYPE)` |
| WITHOUT ROWID (combined with STRICT) | **PASS** [local] | |
| RETURNING (on INSERT, UPDATE and upsert) | **PASS** [local] | |
| Upsert: `ON CONFLICT(k) DO UPDATE SET v = excluded.v` and `DO NOTHING` | **PASS** [local] | |
| Window functions, recursive CTE | **PASS** [local] | |
| **Foreign keys enforced by default** | [local] | Inserting a dangling FK fails: `FOREIGN KEY constraint failed`. `PRAGMA foreign_keys` returns 1. |
| ALTER ADD COLUMN | **PASS** [local] | `ADD COLUMN d INTEGER NOT NULL DEFAULT 7` works. Adding a NOT NULL column without a default fails with `Cannot add a NOT NULL column with default value NULL`, which is standard SQLite. |
| ALTER ADD generated column | VIRTUAL: **PASS**. STORED: **FAIL** [local] | `cannot add a STORED column`. This is standard SQLite: migrations that need a STORED column must rebuild the table. |
| ALTER DROP COLUMN | **PASS** [local] | A plain column drops fine. These are standard SQLite failures: an indexed column gives `error in index t_c after drop column: no such column: c` (drop the index first), and a column referenced by a generated column gives `error in table t after drop column: no such column: b`. |
| ALTER RENAME COLUMN / RENAME TABLE | **PASS** [local] | Generated expressions are rewritten (`a || b` becomes `a2 || b`). |
| Cursor API | [local] | Methods: `next, toArray, one, raw, columnNames, rowsRead, rowsWritten`. `SqlStorage` has `exec, databaseSize, Cursor, Statement`. BLOBs come back as `ArrayBuffer`. A multi-statement `exec` works, but `When executing multiple SQL statements in a single call, only the last statement can have parameters.` **Binding a BigInt fails** (`Cannot convert a BigInt value to a number`). **INT64_MAX comes back as a lossy JS number** (9223372036854776000). **Binding a boolean `true` stores the TEXT `"true"`.** `one()` on an empty result throws `Expected exactly one result from SQL query, but got no results.` |

## Q3: databaseSize, 100k × 1 KB rows

| Check | Result | Evidence [local] |
|---|---|---|
| `ctx.storage.sql.databaseSize` exists and changes | **PASS** | It is a `number`. The empty DB with a few tables is 40,960 B. After 100k rows it is **132,612,096 B (126.5 MiB)**, and after a second 100k-row table it is 236,576,768 B. `DELETE FROM docs2` shrinks it right away to 132,620,288, and `DROP TABLE` to 132,612,096, so freed pages are returned. |
| Insert 100k rows, one `exec` per row, in a single DO invocation (implicit txn) | **~530 ms** in the DO (`performance.now`), 722 ms end-to-end | `rowsWritten = 200,000`: 1 table row + 1 index row (`docs_k`) per insert. |
| Bulk insert, 1k rows per statement via `json_each(?)` (one ~1 MB JSON param) | **~365 ms** | `rowsWritten = 200,000`. A 10k-row batch (~10 MB param) fails with `string or blob too big: SQLITE_TOOBIG` (see Q8). |
| Indexed range query (1,000 rows out of 100k) | **~0.4 ms/query** (8 ms for 20 queries) | Plan: `SEARCH docs USING COVERING INDEX docs_k`. **rowsRead = 1,001** |
| The same range on an unindexed column (full scan) | **~20.7 ms/query** (414 ms for 20) | Plan: `SCAN docs`. **rowsRead = 100,000** |
| Other counters | | `COUNT(*)`: rowsRead = 100,000 (full scan, billed as such). Point lookup by index: rowsRead = 2. `ORDER BY k DESC LIMIT 10` on the index: rowsRead = 10. UPDATE of 100 rows (indexed column unchanged): rowsRead = 101, rowsWritten = 100. `rowsRead` grows as you iterate: it is 1 before `next()`, 2 after one row, and 101 at the end, so read it after consuming the cursor. |
| Clocks | | `Date.now()` and `performance.now()` **do advance** during synchronous code locally. In production, timers are coarsened or frozen until I/O **[unknown→remote]**, so do production benchmarks from outside. |
| Production performance | **[unknown→remote]** | Local numbers come from a laptop SSD. Production adds replication and output gates on commit. |

## Q4: Transactions and PRAGMAs

| Check | Result | Evidence [local] |
|---|---|---|
| `transactionSync(fn)` commits and returns fn's value | **PASS** | It returns `"return-value"`. |
| Rollback on throw | **PASS** | Row count is unchanged (1 before, 1 after) and the error is rethrown (`boom`). |
| Nesting | **PASS: works like SAVEPOINTs** | An inner `transactionSync` that throws, caught by the outer one, rolls back only the inner insert. Final rows: `["committed","outer","inner-ok"]`. The docs don't mention nesting. |
| async callback passed to `transactionSync` | **Footgun** | It does **not** throw; it returns a Promise silently. The docs say the callback "should not be declared async". |
| `storage.transaction(async)` | **PASS** | On throw, both the SQL insert and `txn.put` are rolled back. `txn.rollback()` also rolls back, and the promise resolves. |
| `BEGIN`, `BEGIN IMMEDIATE`, `COMMIT`, `ROLLBACK`, `SAVEPOINT`, `RELEASE` in `exec` | **Disallowed** | `To execute a transaction, please use the state.storage.transaction() or state.storage.transactionSync() APIs instead of the SQL BEGIN TRANSACTION or SAVEPOINT statements...` |
| Other statements | | `ATTACH`: `not authorized: SQLITE_AUTH`. `VACUUM`: `cannot VACUUM from within a transaction` (there is always an implicit txn). `ANALYZE` and `REINDEX`: **ok**. `CREATE TEMP TABLE`: not authorized. `load_extension`: not authorized. Tables named `_cf_*` are not authorized (`_cf_KV` is visible in `sqlite_master`, but reading it gives `access to _cf_KV.key is prohibited`). `sqlite_*` names are reserved. |
| KV API in the same DB | | `storage.put` creates `_cf_KV`. A synchronous `ctx.storage.kv.get()` exists and works. |
| **PRAGMAs allowed** | | `table_info`, `table_xinfo`, `table_list`, `index_list`, `index_info`, `index_xinfo`, `foreign_key_list`, `foreign_keys` (get and set), `defer_foreign_keys`, `foreign_key_check`, `page_size` (4096), `data_version`, `quick_check`, `optimize`, `case_sensitive_like`, `recursive_triggers`, `legacy_alter_table`, `ignore_check_constraints`, `reverse_unordered_selects`. Table-valued forms (`pragma_table_info('t')` etc.) work in SELECT/JOIN. |
| **PRAGMAs that fail with `not authorized: SQLITE_AUTH`** | | `page_count`, `freelist_count`, `max_page_count`, `journal_mode`, `synchronous`, `cache_size`, **`user_version`** (both get and set; store schema versions in your own table), `schema_version`, `application_id`, **`integrity_check`** (`quick_check` is allowed), `compile_options`, `function_list`, `module_list`, `pragma_list`, `collation_list`, `database_list`, `wal_checkpoint`, `auto_vacuum`, `incremental_vacuum`, `encoding`, `busy_timeout`, `temp_store`, `mmap_size`, `writable_schema`, `trusted_schema`, `secure_delete`, `cell_size_check`, `automatic_index`, `query_only`, `analysis_limit`, `hard/soft_heap_limit`, `threads`. |
| Is the allow-list documented? | [docs] | No. The SQLite API page has no PRAGMA list; only the local results above. |

## Q5: Alarms

| Check | Result | Evidence |
|---|---|---|
| One alarm per DO, `setAlarm` overwrite | **PASS** [local] [docs] | `setAlarm(+60s)`, then `+120s`, then `+30s`: `getAlarm()` returns +30s. **The last write wins, not the earliest.** `deleteAlarm()` makes `getAlarm()` return `null`. A `Date` argument is accepted. Docs: "it will override the existing alarm". |
| Alarms fire on their own locally | **PASS** [local] | An alarm set for +200 ms fired at +212 ms. After success, `getAlarm()` is `null`. |
| `getAlarm()` inside `alarm()` | [local] [docs] | Returns `null`, unless `setAlarm` was called during the handler. |
| Retry when `alarm()` throws | **PASS** [local] | `alarmInfo` sequence: `{retryCount:0,isRetry:false}`, then `{1,true}`, `{2,true}`, `{3,true}`. Gaps between attempts: **2.25 s, 4.45 s, 8.75 s** (exponential, starting at 2 s). |
| Retry limit | **PASS** [local] [docs] | An always-throwing alarm made **7 attempts (initial + 6 retries)**. Gaps: 2.5, 4.4, 9.8, 16.5, 37.2, 73.6 s. After that the alarm is cleared (`getAlarm()` gives `null`) and never reruns until the next `setAlarm`. Docs: "exponential backoff starting at a 2 second delay ... up to 6 retries". |
| SQL writes made in an `alarm()` that throws | **Kept** [local]. Production: **[unknown→remote]** | Every failed attempt's `INSERT INTO alarm_log` persisted. The docs say nothing. Do not rely on rollback: wrap the handler body in `transactionSync`, or make it idempotent. |
| Multiplexed scheduler (`jobs` table + `run_at` index; alarm = `MIN(run_at)`; run due jobs, re-arm) | **PASS** [local] | 5 jobs plus one job (`spawned-child`, +250 ms) scheduled from **inside** the alarm handler. They ran in exact order `job-300, spawner-450, spawner, job-600, spawned-child, job-900`, each 3–6 ms late. `jobs` was empty and `getAlarm()` null at the end. Logic is in `SpikeDO.schedule/armAlarm/alarm`. |
| Production alarm delay | [docs] | Alarms "can be delayed by up to a minute" during maintenance or failover. Execution is at-least-once, so jobs must be idempotent. |

## Q6: Point-in-time recovery

| Check | Result | Evidence |
|---|---|---|
| Methods exist | **PASS** [local] | `getCurrentBookmark`, `getBookmarkForTime` and `onNextSessionRestoreBookmark` are all `function`s on `ctx.storage`. |
| `getCurrentBookmark()` | Returns a dummy value locally [local] | `"00000000-00000000-00000000-00000000000000000000000000000000"` |
| `getBookmarkForTime()` and `onNextSessionRestoreBookmark()` | **Throw locally** [local] | `This Durable Object's storage back-end does not implement point-in-time recovery.` |
| Real semantics | [docs], **[unknown→remote]** | 30-day window. Covers SQL and KV. Bookmarks are lexically comparable. After `onNextSessionRestoreBookmark` you should call `ctx.abort()`. It returns an undo bookmark. Docs: "not supported in local development". |

## Q7: WebSocket hibernation

| Check | Result | Evidence |
|---|---|---|
| `acceptWebSocket(ws, tags)`, `getWebSockets(tag)`, `getTags` | **PASS** [local] | With 2 sockets, `getWebSockets("room:1")` returns 1. `getWebSockets()` order is **not** connection order. |
| Tag limits | [local] [docs] | 10 tags accepted; 11 fails with `a Hibernatable WebSocket cannot have more than 10 tags`. A 256-char tag is accepted; 257 chars fails with `... is longer than the max tag length (256 characters).` |
| `setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping","pong"))` | **PASS** [local] | The client gets `pong`. `webSocketMessage` never sees `"ping"` (msgs = `[]`). `getWebSocketAutoResponseTimestamp(ws)` is set for the pinging socket and `null` for the other. The getter returns an object with `.request`/`.response` **properties**; `getRequest()` is not a function locally. Docs: it doesn't wake the DO, and request and response are limited to 2,048 chars each. |
| Hibernation survival (`evictDurableObject(stub)`, which hibernates the sockets) | **PASS** [local] | The constructor runs again (count 1, then 2). Both sockets survive. The `deserializeAttachment()` value is the same before and after. |
| `serializeAttachment` limit | **16,384 bytes** [local] [docs] | A 16,000-char string works. 16,384 chars fails: `A WebSocket 'attachment' cannot be larger than 16384 bytes.'attachment' was 16390 bytes.` The limit applies to the structured-clone size (about +6 B overhead). |
| Broadcast to N=200 | [local] | Connecting 200 sockets one after another took 144 ms. Broadcasting 32 B: send loop 1 ms, all 200 received in **2 ms**. 1 KB: **1 ms**. 64 KB: **8 ms**. A tag-filtered broadcast (`getWebSockets("odd")`, 100 sockets): 2 ms. Production fan-out latency is **[unknown→remote]**. |
| Other limits | [docs] | 32,768 hibernatable WebSockets per DO. Incoming message size 32 MiB. Each incoming message resets the CPU budget (30 s by default, up to 5 min). |

## Q8: Limits

| Check | Local result | Docs |
|---|---|---|
| Bound parameters | 100 OK. **101 fails: `too many SQL variables at offset 207: SQLITE_ERROR`** | "100" |
| Workaround for large IN lists | One JSON param read with `json_each(?)` handles 10,000 ids. A 5,000-item literal `IN (…)` list also works, as long as the statement stays under 100 KB. | |
| SQL statement length | 100,000 bytes OK. **100,001 fails: `statement too long: SQLITE_TOOBIG`** | "100 KB" |
| Columns per table | 100 OK. **101 fails: `too many columns on wide101`** | "100" |
| String/BLOB/row size | **Not enforced at 2 MB locally.** 2 MiB+1, 4 MiB and 8 MiB BLOBs and TEXTs all insert. **16 MiB fails: `string or blob too big: SQLITE_TOOBIG`**. A row with two 1.5 MB columns is OK locally. | "Maximum string, BLOB or table row size: 2 MB". **Production enforcement and its exact error string are [unknown→remote].** Design for ≤ 2 MB per row. |
| LIKE/GLOB pattern | A 60,000-char pattern fails: `LIKE or GLOB pattern too complex` | The limits page lists "50" (presumably 50 KB, matching SQLite's default of 50,000) |
| SQL function arguments | not tested | "32" |
| Storage per DO | not tested | 10 GB (1 GB on the Free plan) |

## Q9: Introspection for schema-diff migrations

| Check | Result | Evidence [local] |
|---|---|---|
| `sqlite_master` / `sqlite_schema` | **PASS** | Returns type, name, tbl_name, and the original `sql`, including STRICT, generated expressions, and the partial index `WHERE` clause. FTS5 shadow tables (`*_fts_data/_idx/_config/_docsize/_content`) and `sqlite_autoindex_*` show up and must be filtered out. `_cf_KV` appears once KV has been used. |
| `pragma_table_list` | **PASS** | Gives `type` (table/virtual/shadow), `ncol`, `wr` (WITHOUT ROWID) and `strict` per table. |
| `pragma_table_info` vs `pragma_table_xinfo` | **PASS** | **`table_info` hides generated columns; use `table_xinfo`** (`hidden=2` for VIRTUAL, 3 for STORED). A JOIN with `sqlite_master` works: `FROM sqlite_master m, pragma_table_xinfo(m.name) c`. |
| `pragma_index_list` + `pragma_index_info` / `index_xinfo` | **PASS** | Gives `unique`, `partial`, `origin` and the column order. Joining them works. |
| Schema version | | `PRAGMA user_version` and `schema_version` are **not authorized**, so keep a `_migrations` table. `data_version` is allowed. |

## Design takeaways for the Convex-on-CF engine

1. FTS5 is fully usable for search indexes, including diacritic folding (unicode61 rd=2), trigram substring search, external-content tables kept in sync by triggers, bm25/snippet/highlight, and fts5vocab. There is no fts4.
2. Use `json_each(?)` bulk statements to get past the 100-param limit. It is also about 30% faster than one `exec` per row. Keep each param under ~8 MB locally, and design for ≤ 2 MB.
3. Every index entry counts as a billed row written: 100k inserts with 1 index cost 200k `rowsWritten`. `COUNT(*)` bills a full scan.
4. Schema-diff migrations can rely on `sqlite_master` and `pragma_table_xinfo`/`index_list`/`index_xinfo`. Track versions in your own table, because `user_version` is blocked. A STORED generated column cannot be added with ALTER and needs a table rebuild; VIRTUAL can be added.
5. Use `transactionSync` for the mutation and commit boundary. It nests like savepoints, and an async callback is silently accepted, so lint against it. Raw `BEGIN` and `SAVEPOINT` are blocked.
6. The alarm scheduler pattern works: jobs table, alarm = MIN(run_at), re-arm at the end. Because `setAlarm` is last-write-wins, always re-arm from `MIN(run_at)` rather than blindly setting. Make jobs idempotent: delivery is at-least-once, writes from a throwing handler persist locally, and there are 6 retries before the alarm is dropped. To avoid losing the schedule, catch errors in `alarm()` and re-arm yourself.
7. The JS↔SQLite type mapping needs a codec layer: BigInt can't be bound, int64 above 2^53 is lossy, booleans become `"true"`, and BLOBs come back as `ArrayBuffer`.
8. Foreign keys are ON by default.

## Still needs a remote test (not done, as instructed)
- Whether production enforces the 2 MB row limit, and its error string.
- Production write and commit latency and range-scan timings.
- Whether writes from a throwing `alarm()` are rolled back in production.
- PITR (`getBookmarkForTime` and restore).
- Production broadcast latency at N=200+.
- Whether the PRAGMA and function authorizer is identical in production. It is the same workerd code, but this spike didn't verify it.
