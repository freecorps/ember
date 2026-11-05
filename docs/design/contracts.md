# Contratos internos da Fase 1

Estas interfaces separam `@freecorps/ember-server`, que é TS puro, de `@freecorps/ember-runtime`, que roda em workerd, e de `@freecorps/ember-client`.
Se uma mudança for necessária, atualize este arquivo no mesmo commit.

## SqlDriver (`@freecorps/ember-server`)
Um adaptador mínimo e síncrono. O runtime o implementa sobre `ctx.storage.sql`; os testes usam `node:sqlite` (`@freecorps/ember-server/testing`, fora da entrada principal).
```ts
export interface SqlDriver {
  exec(sql: string, ...params: SqlValue[]): { rows: Record<string, SqlValue>[]; rowsRead: number; rowsWritten: number }
  transaction<T>(fn: () => T): T   // síncrono. Aninhado = savepoint. Lança erro se fn devolver Promise.
}
export type SqlValue = null | number | string | Uint8Array   // sem bigint/boolean: quem converte é o engine
```
- Um statement por `exec`. Parâmetros posicionais (`?` ou `?NNN`). No máximo 100 parâmetros: o engine divide linhas largas.
- BLOBs voltam como `Uint8Array` (o adaptador converte `ArrayBuffer`).

## Valores e JSON (`@freecorps/ember-values`)
- `encodeJson(value): string` / `decodeJson(text): unknown` — JSON canônico com tags: `{"$int64":"…"}` (bigint), `{"$bytes":"<base64>"}`, `{"$float":"NaN"|"Infinity"|"-Infinity"|"-0"}`. Nomes de campo começando com `$` são recusados pela validação, então as tags não colidem. `encodeJsonStable` ordena as chaves (chaves de cache).
- Chave de índice: `encodeKey(values[])` estilo tuplas do FoundationDB. Ordem de tipos `undefined < null < int64 < number < boolean < string < bytes < array < object`; números em ordem total IEEE (`-0 < +0`, NaN canônico depois de `+Infinity`); strings por code point. Comparação por bytes (memcmp). `rangeFor(eq, lower?, upper?)` devolve `[lo, hi)`; `prefixEnd(p) = p ++ 0xFF`; `keySuccessor(k) = k ++ 0x00`.

## Manifesto de schema (`@freecorps/ember-server`)
`defineSchema(...)` expõe `schema.manifest`: JSON serializável.
```ts
type SchemaManifest = {
  version: string            // = hash (sha256 do JSON canônico do resto); é a "versão de schema"
  hash: string
  formatVersion: 1
  schemaValidation: boolean
  tables: Record<string, { idPrefix: string; document: ObjectShape; shard?: { name: string; field: string }; indexes: IndexSpec[] }>
  shards: Record<string, { key: Shape; locationHint?: string }>   // sempre presente (pode ser {})
}
type IndexSpec = { kind: string; name: string; fields: string[]; config?: JSONValue }   // kind "db" = .index()
```
Ele alimenta o DDL, as migrações, o codegen e o cliente offline. `schema.indexKinds` traz os plugins de índice daquele schema (`defineSchema({ ..., indexKinds: [...] })`; `searchIndex` já vem incluído). Não há registro global.

IDs: `<idPrefix>_<ULID>` (o prefixo padrão é o nome da tabela; único por schema).

## Engine (`@freecorps/ember-server`)
```ts
createEngine({ schema, functions, driver, now?, random?, limits? }): Engine   // também é o export default
// functions: { "dir/mod:fn": fn } ou módulos { "dir/mod": { fn } }

interface Engine {
  manifest: SchemaManifest
  migrate(): MigrationReport                 // idempotente; usa _ember_meta; roda em driver.transaction (aninhável); lança MigrationRefused
  planMigration(): MigrationPlan             // dry run
  backfillStep(limit?: number): BackfillProgress   // índices staged, em blocos (padrão 500); chamar até done
  runQuery(name, args, ctx: AuthCtx, opts?: { touched?: Set<string> }): { value: unknown; readSet: ReadSet }
  runMutation(name, args, ctx: AuthCtx): { value: unknown; changes: RowChange[]; scheduled: Job[]; cancelled: string[] }
  runMutationBatch(items: { name; args; ctx: AuthCtx }[]): MutationBatchResult[]   // group commit
  matches(readSet: ReadSet, changes: RowChange[]): boolean
  tableOfId(id): string | undefined
  functionInfo(name): { type: "query" | "mutation" | "action" | "httpAction"; visibility: "public" | "internal"; sensitive?: true } | undefined
}
type Identity = { subject: string; issuer?: string; exp?: number /* s */; claims?: Record<string, unknown> }
type AuthCtx = { identity: Identity | null }
type ReadSetEntry = {
  table: string; index: string; lo: Uint8Array; hi: Uint8Array /* exclusivo */; kind: string
  filter?: FilterExpr   // kind "db": linhas que falham o filtro antes e depois não invalidam
  data?: unknown        // kinds de plugin (ex.: "search")
}
type ReadSet = ReadSetEntry[]
type RowChange = { table: string; id: string; before: Doc | null; after: Doc | null }
type Job = { id: string; fn: string; args: unknown; runAt: number /* ms */; kind: "mutation" | "action" }
type MutationBatchResult =
  | { ok: true; value: unknown; changes: RowChange[]; scheduled: Job[]; cancelled: string[] }
  | { ok: false; error: { code: string; message: string } }
type MigrationReport = { changed: boolean; fromVersion: string | null; toVersion: string; steps: MigrationStep[]; staged: { table; index; kind }[] }
```
- Queries e mutations são síncronas por dentro: `ctx.db` devolve valores, não Promises. Handler que devolve Promise → erro `AsyncHandler` (e rollback).
- `runMutationBatch`: uma `driver.transaction` com um savepoint por item, mesma ordem dos itens; a falha de um item desfaz só ele e nunca lança. O runtime pode envolver tudo numa transação externa (change log, dedup, jobs).
- `ctx.scheduler.runAfter/runAt` **não** grava nada: os jobs voltam em `scheduled` e o runtime os persiste na própria tabela `_jobs` (coluna `job_id` = `Job.id`, o id devolvido ao handler), na mesma transação. `kind` vem do tipo da função agendada.
- `ctx.scheduler.cancel(id)`: um job agendado pela própria mutation sai de `scheduled`; os demais ids voltam em `cancelled` e o runtime apaga, na mesma transação, o job **pendente** com esse `job_id` (job já rodando/despachado ou id desconhecido: nada acontece).
- `runQuery(..., { touched })`: o engine adiciona ao `Set` cada tabela que a query abriu (`db.query`, `db.get`), inclusive quando ela lança. É o que o runtime usa para reexecutar queries que falharam (ver Protocolo).
- `ctx.now` é fixo por execução; `ctx.random()` usa uma semente por mutation (derivada de `random()`).
- Erros lançados por `runQuery`/`runMutation` são `EmberError` com `code` string: `ValidationError`, `NotFound`, `TooManyReads` (16k linhas), `TooManyWrites` (8k), `DocumentTooLarge` (2 MB), `SchemaError`, `MigrationRefused`, `IndexNotReady`, `FunctionNotFound`, `InvalidFunction`, `AsyncHandler`, `QueryError`, `InvalidCursor`, `FileNotFound`, `FileInUse`, `StorageError`, `OfflineUnsupported` (só em execução local, ver "Offline"). Outros erros (do usuário) viram `code: "Error"` no batch.
- Visibilidade (`internal*`) é checada pelo runtime via `functionInfo`.
- Chaves de índice: coluna BLOB `_k_<índice>` com `encodeKey([campos..., _creationTime, _id])`. `by_id` é `encodeKey([_id])`; `by_creation_time` é `[_creationTime, _id]`.
- Kinds de índice que não são `db` (busca, por exemplo) decidem o próprio matching pelo plugin (`matchesChange`). Um kind com `debounceTableWrites: true` (busca: o bm25 depende da tabela inteira) tem as escritas na tabela que `matchesChange` rejeita reportadas como match "loose".
- **Agregados materializados** (`defineTable(...).aggregate(name, { by: [campos], count?: true, sum?, min?, max? })`): é um index kind embutido (`kind: "aggregate"`, `fields = by`, `config = {count, sum, min, max}`), então o planner cria, apaga e faz staging como qualquer índice.
  - Tabelas: `<tabela>__<nome>` (`key BLOB PRIMARY KEY` = `encodeKey(valores do grupo)`, `count INTEGER`, `v TEXT` = `encodeJson({sum, min, max})`, `WITHOUT ROWID`) e, com min/max, `<tabela>__<nome>__mm` (`key` = `encodeKey([nº do campo, ...grupo]) ++ encodeKey([valor])`, `n` = multiplicidade): remover o min/max atual custa um seek.
  - Mantidos pelo engine na transação da mutation (insert/patch/replace/delete/increment): um read + um upsert por grupo tocado; grupo com `count = 0` some. Somas: `number` → float; `int64` → bigint. Os writes contam no limite de 8k.
  - Leitura: `ctx.db.aggregate(table, name).get([...grupo])` → `{count, sum, min, max}` (grupo vazio = `count: 0`, somas 0, min/max `null`) é uma busca por chave primária; `.range(q => q.eq(...).gt(...), {order?, limit?})` → linhas com `group`. Antes do backfill terminar: `IndexNotReady`.
  - Reatividade: cada linha de agregado que muda vira um `RowChange` da pseudo-tabela `"<tabela>__<nome>"` (docs `{_id: "agg_<hex da chave>", g0..gN, count, sum, min, max}`); as leituras gravam ranges `db` no índice `by_group` (campos `g0..gN`) dessa pseudo-tabela. `readSetFields(manifest, table, index)` resolve os dois casos para `engine.matches` e `createMatchIndex`. Um agregado que volta ao valor anterior na mesma mutation não gera change.
  - Backfill (staged): escritas ao vivo ignoram linhas na janela `(cursor, until]`; `backfillStep` agrega cada linha da janela uma vez.
- **`ctx.db.sql`** (queries e mutations, somente leitura): tag `` ctx.db.sql`SELECT ...` `` (linhas `unknown`) ou `ctx.db.sql(v.object({...}))`...`` (linhas convertidas — 0/1 → boolean, TEXT → int64 — e validadas; falha → `ValidationError`).
  - Valores do template são sempre parâmetros `?`; identificadores só via `ctx.db.sql.id(nome)` (`[A-Za-z_][A-Za-z0-9_]*`, entre aspas). Placeholders escritos à mão (`?`, `:x`, `@x`, `$x`) e valores dentro de literais são recusados.
  - Validação por tokenizer (fora de strings e identificadores entre aspas): um único statement começando com `SELECT` ou `WITH`; recusa `INSERT/UPDATE/DELETE/REPLACE/CREATE/DROP/ALTER/ATTACH/DETACH/PRAGMA/VACUUM/REINDEX/ANALYZE/BEGIN/COMMIT/ROLLBACK/SAVEPOINT/RELEASE/TRIGGER/RETURNING/INTO/EXPLAIN`, `load_extension()` e funções `pragma_*`. Cada fonte de `FROM`/`JOIN`/vírgula precisa ser tabela do schema (sem diferenciar maiúsculas), CTE do statement, ou `json_each`/`json_tree`; nome qualificado (`main.t`), tabelas internas (`_*`, `sqlite_*`, `t__idx`) e outras table-valued functions → `QueryError`.
  - Colunas são o layout físico (escalares de primeiro nível; o resto em `_json`). Reatividade por tabela: grava `[lo, hi)` cheio de `by_creation_time` de cada tabela referenciada (e as põe em `touched`). `rowsRead` do cursor conta no limite de 16k.
- **`ctx.db.increment(id, field, delta)`** (mutations): soma `delta` (number, ou bigint para int64) a um campo de primeiro nível, lido e escrito pelo engine; campo ausente = 0; devolve o novo valor. É um patch comum (validação, agregados, change). Contador shardeado (escrita sem conflito entre mutations) fica para um componente.
- `createMatchIndex<K>(schema): MatchIndex<K>` — índice de read sets para muitas inscrições: `set(key, readSet | null, tables?)`, `delete(key)`, `match(changes) → { exact: Set<K>; loose: Set<K> }`. Ranges `db` ficam numa estrutura de intervalos por `(tabela, índice)` (array ordenado por `lo` + segment tree de `max(hi)`, buffer de inserções e tombstones, rebuild preguiçoso); entradas de plugin seguem por `matchesChange`, agrupadas por tabela; `readSet: null` com `tables` = casa qualquer mudança nessas tabelas. `exact` é exatamente o conjunto em que `engine.matches` é true (sem falso negativo; o fuzz compara os dois).

## Crons (`@freecorps/ember-server`)
`crons.ts` exporta por padrão `cronJobs({ shard?, tz? })` (builder: `.cron(name, schedule, fn, args?, opts?)`, `.interval`, `.hourly`, `.daily`, `.weekly`, `.monthly`) ou um `CronDef[]`:
```ts
type CronDef = { name: string; schedule: string; tz?: string; shard: string; fn: FunctionReference<"mutation" | "action"> | string; args?: unknown; kind?: "mutation" | "action" }
```
`cronList(x)` normaliza o export. O runtime resolve `fn` para o nome e `kind` para o tipo da função (default `mutation`, `action` se a função for uma action).
- Índices staged: o runtime chama `backfillStep(500)` um bloco por turno de alarm (reagendando o alarm até `done`); o índice fica consultável quando termina (antes disso → `IndexNotReady`).
- Tabelas internas: `_ember_meta`, `_ember_indexes` (engine) e `_jobs`, `_ember_migrations`, `_ember_rt_meta`, ... (runtime). O planner ignora tudo que começa com `_` ou `sqlite_`, e as tabelas-sombra do FTS5.

## Protocolo WS v1 (`@freecorps/ember-runtime` ⇄ `@freecorps/ember-client`)
Frames JSON (valores em `encodeJson`); o binário fica para depois. Ping e pong são as strings literais `"ping"` e `"pong"`, para a auto-response funcionar.
Cliente → servidor:
- `{t:"hello", clientId, token?, protocol:1, features?: string[]}` — v1.1: features opcionais; o servidor ignora as que não conhece
- `{t:"sub", qid, fn, args, resume?:{version, epoch}}`
- `{t:"unsub", qid}`
- `{t:"mut", mid, fn, args}`
- `{t:"auth", token}` — `token: null` faz sign-out: o socket passa a anônimo e todas as suas subscriptions são reavaliadas (novo `snap`)

Servidor → cliente:
- `{t:"ready", shard, version, epoch, features?}` — as features do hello que o servidor fala (hoje só `"rowdiff"`); ausente = nenhuma
- `{t:"snap", qid, version, value}`
- `{t:"snap", qid, version, unchanged:true}` — sem `value`: resposta a um `resume` bem-sucedido (o valor do cliente continua válido)
- `{t:"patch", version, changes:[{qid, value} | {qid, diff}], mids}` — um frame por versão confirmada, cobrindo todas as queries que mudaram. `mids` (sempre presente, pode ser `[]`) são os `mid`s **deste socket** cujos efeitos estão nessa versão, para o cliente descartar os updates otimistas correspondentes de forma atômica; o `mres` de cada um vem depois
- `{t:"mres", mid, ok:true, value, version} | {t:"mres", mid, ok:false, error:{code, message}}`
- `{t:"err", code, message, qid?}`
- `{t:"authExpired"}`

Regras:
- **Feature `rowdiff` (v1.1).** Sem ela, `patch` leva o valor inteiro. Com ela, quando o valor anterior que o socket recebeu (sucesso) e o novo são arrays de objetos com `_id` string distintos, e o diff é menor em JSON, o change é `{qid, diff:{remove:[ids], upsert:[docs], at?:[índices], order?:[ids]}}` (`rowDiff`/`applyRowDiff` de `@freecorps/ember-values`). Aplicar: (1) tira `remove`; (2) um doc de `upsert` cujo `_id` ainda existe é trocado no lugar, os outros são "inseridos"; (3) inseridos vão para o fim, em ordem, ou, com `at` (índice final crescente de cada inserido), entram nessa posição; (4) com `order` (todos os ids), reordena. Doc que muda de posição vai como removido + inserido (mínimo de movimentos, pela maior subsequência crescente); `order` só quando é menor. Senão, `{qid, value}`. O cliente aplica no valor confirmado (as camadas otimistas são reaplicadas por cima); se o diff não encaixa, manda `unsub` + `sub` sem `resume` e recebe `snap` completo. Medido (lista de 500 docs, 1 mudança, frame `patch` inteiro): update 69 794 → 203 bytes, insert 69 903 → 199, delete 69 764 → 128 (≈ 340–545×).
- Dedup de mutation por `(identity, clientId, mid)`.
- Só funções `public` do tipo certo podem ser chamadas por clientes (WS e HTTP), via `engine.functionInfo`: função interna ou inexistente → `FunctionNotFound` (não revela que existe); tipo errado → `InvalidFunction`. Funções `internal*` rodam só pelo scheduler/crons.
- `sub` cuja query falha continua registrada (estado "errored"): o servidor manda `err` com `qid` e, como ela não tem read set, a reexecuta só depois de commits que tocam tabelas que a função sabidamente lê (as que essa execução abriu antes de falhar + as que qualquer execução anterior da mesma função leu), e quando um índice staged fica pronto; o primeiro sucesso chega como `patch`. Uma query que falha antes de ler qualquer tabela só volta a rodar por re-`sub`, `auth` ou índice pronto. Reenviar `sub` com o mesmo `qid` de uma sub errored a reexecuta (não é `duplicate_qid`).
- Matching: o shard mantém um `createMatchIndex` sobre as queries inscritas; um commit reexecuta só as chaves `exact`.
- Busca (PLAN §4): reexecução **imediata** quando a mudança pode alterar o conjunto de resultados (linha que está nos resultados, ou texto antes/depois com um termo da busca passando nos filtros, ou um range `db` da mesma query). **Com debounce** quando a escrita só toca a tabela pesquisada (match "loose": pode mudar a ordem bm25): uma reexecução no máximo `reactivity.searchDebounceMs` (padrão 2000 ms; `0` = imediato) depois da *primeira* escrita loose, sem ser empurrada por escritas seguintes — a ordem nunca fica mais velha que isso. O patch do debounce leva a `version` atual e só sai se o valor mudou; uma reexecução imediata cancela o debounce pendente daquela query.
- Token expirado em socket aberto: na hora do patch o servidor checa o `exp` da identidade do socket; se expirou, **não** manda patches nem `err` dessas subscriptions e manda `{t:"authExpired"}` uma vez (até o próximo `auth`). Depois de `auth` com token novo, as subscriptions recebem `snap` como sempre.
- `resume` só responde `unchanged` se o último snapshot daquele `(clientId, qid)` foi calculado sob a mesma identidade do socket atual; senão vai `snap` completo.
- Frame `sub`/`mut` que chega depois do `exp` do token **não** roda como anônimo: o servidor responde `authExpired` e, para `mut`, `mres ok:false code:"auth_expired"` (para `sub`, `err` com `qid` e `code:"auth_expired"`), e descarta o frame. O cliente manda `auth` com um token novo.
- Erros de usuário em queries/mutations usam `code:"Error"` (os `EmberError` mantêm o próprio `code`).
- Um shard por socket: `/ws?shard=<tipo>:<chave>`.
- HTTP one-shot: `POST /api/query`, `POST /api/mutation` e `POST /api/action` com `{fn, args, shard}`. Resposta `{ok:true, value, version}` (`version` só em query/mutation) ou `{ok:false, error:{code, message}}` (HTTP 400; 401 para token inválido).
- Actions rodam no Worker. `ActionCtx` (`@freecorps/ember-server`): `runQuery/runMutation/scheduler` no shard da chamada (`ctx.shard`), `ctx.onShard(s)` para outro shard, `runAction`, `auth.getUserIdentity()`, `env` (bindings) e `now`. Cada chamada é um RPC ao DO do shard (sua própria transação), com a identidade de quem chamou; actions podem chamar funções `internal*`. `ctx.scheduler` grava direto no `_jobs` do shard (não é transacional) e `cancel(id) → boolean`. Erros de shard viram `ActionCallError` com o `code` original.
- Jobs de action: `ActionJobMessage = { shard, jobId: string, fn, args, attempt }` vai para a Queue `EMBER_ACTIONS` (o Worker exporta `queue()`, que roda o job e faz `retry()` em falha). Sem Queue (e sem `dispatchAction`), o próprio shard roda a action no turno do alarm.
- Location hint: o Worker (e o System) cria os stubs com `locationHint` = `shards[kind].locationHint` do manifesto (`defineShard`) ou, na falta, `env.EMBER_LOCATION_HINT`. Só vale na criação do DO.

## Auth (`@freecorps/ember-runtime` ⇄ `@freecorps/ember-auth`)
```ts
interface EmberAuthHook {   // emberAuth(...) e remoteAuth(...) de @freecorps/ember-auth/worker satisfazem
  verify(token: string, opts?: { sensitive?: boolean }): Identity | null | Promise<Identity | null>
  fetch?(request: Request, env): Response | null | undefined | Promise<...>   // /api/auth/*; tentado antes do 404
}
```
- `mutation({ sensitive: true, ... })` / `action({ sensitive: true, ... })` (query recusa). Com token, o Worker verifica com `{ sensitive: true }` (sessão no DO `Auth`); sessão encerrada → 401 `unauthenticated` mesmo com JWT ainda válido. Sem token, roda anônimo. No WS o shard guarda o token do socket (attachment) e reverifica a cada `mut` sensível: `mres ok:false code:"unauthenticated"` (sessão encerrada) ou `"reauth_required"` (token não disponível). Chamadas internas (actions → shard) não reverificam.
- Entry gerado com `ember/auth.config.ts`: `const auth = emberAuth(cfg, { project, onUserChange: outbox.onUserChange }); export const Auth = outbox.wrap(auth.Auth); createEmberWorker({ ..., auth })`. Com `ember.json` `auth.from` (SSO): `remoteAuth({ from })`, sem DO `Auth`.
- Outbox de perfil: `onUserChange` grava `_ember_outbox` no SQLite do DO `Auth` e arma o alarm; o alarm entrega em ordem `internal.users.sync({ event: "create"|"update"|"delete", user, key })` (datas em ms, campos privados removidos) no shard `auth.syncShard` (padrão `global:main`), com backoff e `dead = 1` após `maxAttempts` (10). Só grava se `users:sync` existir (internalMutation). Dedup: `Shard.mutation(shard, fn, args, identity, internal, { dedupKey })` guarda só resultados `ok` em `_ember_dedup`.
- Deploy: `Auth` em `exports` + binding `AUTH`, `nodejs_compat`; `EMBER_AUTH_URL` (plain_text: `auth.url` ou workers.dev); `EMBER_AUTH_SECRET` gerado só se o Worker ainda não tem esse secret (depois fica por `keep_bindings`); `EMBER_AUTH_JWKS` = `GET <url>/api/auth/jwks` gravado via `PUT .../secrets` se ainda não existe (cria um deployment).

## Admin / status (`@freecorps/ember-runtime`)
`GET /api/_ember/status?shard=<s>&shard=...` (padrão `global:main`, até 50) com `Authorization: Bearer <EMBER_ADMIN_TOKEN>` (secret do Worker; sem ele → 403 `admin_disabled`; token errado → 401). Acordar o shard roda a migração dele. Resposta:
```ts
{ ok: true, expectedVersion: string, shards: Array<{
  shard: string; expectedVersion: string; schemaVersion: string | null
  ready: boolean                      // schemaVersion === expectedVersion, sem índice staged, sem recusa
  staged: { table; index; kind; cursor: number; until: number }[]   // faltam as linhas (cursor, until]
  migrationError: { at; fromVersion; toVersion; code; message } | null   // a última tentativa para expectedVersion foi recusada
  lastMigrationError: (mesmo tipo) | null                                 // histórico
  version: number; databaseSize: number }> }
```
- Migração recusada (`MigrationRefused` ou falha de DDL) no boot: a transação volta atrás, o shard fica no schema antigo, registra a tentativa em `_ember_migrations(at, from_version, to_version, ok, code, message)` e recusa trabalho com esse erro (`mres`/`err`/HTTP com `code: "MigrationRefused"`, jobs e backfill parados) até um deploy que migre. Cada boot (deploy novo = isolate novo) tenta de novo.
- `ember deploy --wait [--shard s ...]` faz polling desse endpoint (sempre `global:main` + `--shard`) até todos `ready`; falha alto (`MigrationRefusedError`) se algum tiver `migrationError`. O deploy sobe `EMBER_ADMIN_TOKEN` (variável de ambiente local ou `--admin-token`) como `secret_text` e manda `keep_bindings: ["secret_text","secret_key"]`.

## PITR / `ember restore` (`@freecorps/ember-runtime` restore.ts ⇄ `@freecorps/ember-cli` restore.ts)
- **Bookmarks próprios** em `_ember_bookmarks(id, at, bookmark, reason)` de cada shard (R6: `getBookmarkForTime` é grosseiro), via `getCurrentBookmark()`:
  - `deploy:<versionId>`: no primeiro boot sob uma versão nova do Worker (binding `version_metadata` `EMBER_VERSION`), **antes** da migração e de qualquer requisição do código novo (meta `deploy_version`); shard sem schema ainda não grava;
  - `migrate` (depois de migrar), `hourly` (manutenção horária, só enquanto o shard está ativo), `manual:<label>` (`POST /api/_ember/bookmark`), `pre-restore:<id>`, `undo:<id>`, `restore:<id>`.
  - Linhas com mais de 30 dias saem na manutenção (é a janela do PITR).
- **Admin** (mesmo `EMBER_ADMIN_TOKEN`): `GET /api/_ember/bookmarks?shard=` → `{ok, shard, now, retentionMs, bookmarks}`; `POST /api/_ember/bookmark {shard, label?}` (501 `pitr_unavailable` sem PITR); `POST /api/_ember/restore {shard, bookmark, label?}` → `{ok, shard, restoredTo, undo, version, epoch, schemaVersion}`.
- **Restore** (RPCs do Shard): `restorePrepare` grava `pre-restore`, copia as linhas de bookmark e chama `onNextSessionRestoreBookmark(bm)` (devolve o **undo**); `restoreAbort` faz `ctx.abort()` (a chamada falha por desenho); `restoreFinish` roda no objeto reiniciado (o boot já migrou para o schema atual se o bookmark é anterior a uma migração; o cache de schema por isolate é limpo antes do abort), reimporta as linhas que o restore desfez (`INSERT OR IGNORE` por `id`: o banco restaurado é um prefixo), grava `undo:<id>` e `restore:<id>`, **troca o `epoch`** (clientes com `resume` recebem `snap` completo) e rearma o alarm (jobs, GC, outbox voltaram com os dados). Bookmark inválido → 400 `bad_bookmark`; workerd local → 501 `pitr_unavailable`.
- **CLI** resolve `--to`: bookmark cru; `deploy:<versão ou prefixo ≥4>` (linha `deploy:*`, prefixo ambíguo recusado); hora ISO, epoch ms ou relativa (`-2h`) → o bookmark gravado mais novo `<=` à hora. Recusa alvo fora de 30 dias − 10 min.
- **`--all --to deploy:X`**: shards do catálogo (`shards` no registro) por projeto/env; por shard: `deploy:X` se existir; senão o `deploy:*` mais antigo depois do horário do deploy X (registro `deployments`), pois o shard não rodou sob X e nada mudou entre X e esse boot; sem nenhum → já está nesse estado (pula). Algum shard sem alvo válido → nada é feito. Os undos ficam em `.ember/restores/<label>.json`.
- **Limites:** só os dados do shard voltam. Objetos do R2 já apagados pelo GC (refcount 0 há 24 h) não voltam (as linhas `_files` sim); índices externos (Vectorize/AI Search) não são reconstruídos (um documento ressuscitado só volta ao índice quando for escrito de novo); o catálogo D1 e o change log de outros shards não mudam. Escritas de instâncias da versão anterior nos segundos depois do deploy não entram no ponto `deploy:X`.

## Arquivos (`@freecorps/ember-server` ⇄ `@freecorps/ember-runtime` ⇄ `@freecorps/ember-client`)
- **Tabela `_files` por shard** (DDL `FILES_DDL`, criada pelo engine em `migrate()` e pelo runtime no boot):
  `id` (`_storage_<ULID>`), `sha256`, `size`, `content_type`, `refcount`, `state` (`pending|ready|deleting|failed`), `key`, `etag`, `token`, `multipart`, `created_at`, `updated_at`, `zero_since`.
- **Chaves:** `f/<b64url(shard)>/<sha256>` (definitiva) e `t/<b64url(shard)>/<storageId>` (temporária). `parseFileKey` recupera o shard da chave.
- **Dedup por shard:** cada shard é dono do seu prefixo. Não existe registro global de refcount.
- **Engine:** `createEngine({..., storage: { shard: () => string | null, signer?: FileSigner, gcGraceMs?, urlTtlSeconds? }})`.
  - `QueryCtx.storage`: `getUrl(id, {expiresIn?, download?})`, que devolve `string | null` (só para arquivo `ready`), e `getMetadata(id)`.
  - `MutationCtx.storage`: o mesmo, mais `generateUploadUrl(opts)`, que devolve um `UploadTicket`, e `delete(id)`, que lança `FileInUse` se `refcount > 0` e, senão, deixa o arquivo pronto para o próximo GC.
  - Refcount: insert, patch, replace e delete de tabela com `v.file()` (inclusive aninhado em objeto, array, record ou union) aplicam deltas em `_files` na mesma transação. Uma referência nova exige linha `pending` ou `ready` (senão `FileNotFound`). Dentro de union, só contam strings no formato de storage id.
  - `getUrl` assina com `now` arredondado para janelas de 5 min e `expiresIn = ttl + 300` s. O valor fica igual dentro da janela, o que deixa o resultado da query estável.
- **`UploadTicket`**: `{storageId, shard, token, exists?, url?, method?: "PUT", headers?, multipart?: {partSize}, expiresAt}`. O `token` é a capacidade usada nos endpoints `/api/storage/*`.
- **`FileSigner`** (síncrono):
  - `s3Signer(S3Config)`: presign SigV4 em `https://<acct>.r2.cloudflarestorage.com/<bucket>/<key>`. Assina `content-type`, `content-length` e `x-amz-checksum-sha256` quando são conhecidos.
  - `proxySigner({secret, baseUrl?})`: devolve `/api/storage/put|part?shard&id&token` e `/api/storage/get?k&exp&ct?&dl?&sig`, com `sig` = HMAC-SHA256(secret, `"ember-get\n" + k + "\n" + exp + "\n" + ct + "\n" + dl`).
  - O runtime escolhe pelo env (`fileSignerFromEnv`). Usa S3 se houver `EMBER_R2_ACCESS_KEY_ID`, `EMBER_R2_SECRET_ACCESS_KEY`, `EMBER_R2_ACCOUNT_ID` e `EMBER_R2_BUCKET` e `EMBER_FILES_MODE !== "proxy"`; senão, proxy, com `EMBER_STORAGE_SECRET` (sem ele, um segredo de dev com aviso) e `EMBER_PUBLIC_URL`.
  - Sem o binding `EMBER_FILES` não há signer, e quem precisa dele lança `StorageError`.
- **Endpoints do Worker** (CORS `*`, expõem `ETag`):
  - `PUT /api/storage/put`: proxy; o binding confere o `sha256` nas chaves `f/`.
  - `PUT /api/storage/part?uploadId&part`: proxy.
  - `POST /api/storage/multipart {shard, storageId, token, op: create|parts|complete|abort, uploadId?, partNumbers?, parts?}`. `create` devolve `{uploadId, partSize, parts}`. `complete` já confirma.
  - `POST /api/storage/confirm {shard, storageId, token}` → `{ok, file: FileMetadata}`. Se o objeto ainda não existe → 409 `not_uploaded`. Tamanho ou checksum errado → 400, e o objeto é apagado.
  - `GET /api/storage/get`: proxy; aceita `Range`.
- **Confirmação** (`confirmUpload`, idempotente):
  - Chave `f/`: confere o checksum sha256 guardado no R2 ou recalcula o hash.
  - Chave `t/`: calcula o hash com `DigestStream`, copia para `f/<sha>` se ainda não existir, marca `ready` e apaga o `t/`.
  - Enquanto uma linha `deleting` usa a chave de destino, `markReady` e `register` recusam com `StorageError` (tente de novo).
- **RPC do Shard** (`FileRpc`, resultados `{ok, value} | {ok:false, code, message}`): `fileUploadTarget`, `fileReady`, `fileFail`, `filesByKey`, `fileMeta`, `fileUrl`, `fileRegister`, `fileGenerateUpload`, `fileDelete`.
- **Queue:**
  - O `queue()` do Worker reconhece mensagens de evento do R2 (`{account, bucket, action, object:{key}}`) pelo formato.
  - Eventos de create confirmam as linhas `pending` com aquela chave. Eventos de delete, de lifecycle e chaves alheias recebem `ack`. Erro 5xx vira `retry()`.
- **GC** (alarm do shard; o `armAlarm` considera `nextGcAt`):
  - `gcBegin` marca como `deleting` até 100 linhas com `refcount = 0` e `zero_since <= now - grace` (para upload `pending` ainda não apagado explicitamente, `zero_since <= now - max(grace, TTL da URL + 5 min)`, para não coletar um upload em andamento), mais linhas `deleting` paradas há mais de 60 s.
  - Os objetos que nenhuma linha viva compartilha são apagados com `bucket.delete(keys)`. Depois `gcFinish` apaga as linhas.
  - Falha no R2: tenta de novo em 60 s.
  - Grace: `config.files.gcGraceMs`, senão a var `EMBER_FILES_GC_GRACE_MS`, senão 24 h.
- **Actions:**
  - `ctx.storage`: `getUrl`, `getMetadata`, `get` (stream), `store(bytes | Blob | string, {contentType})` (calcula o hash, faz `put` se a chave não existe, registra; dedup), `generateUploadUrl` e `delete`.
  - `ctx.images`: `transform`, `info` e `thumbnail` (`transform` + `store`). Usa o binding `EMBER_IMAGES` ou `config.files.images`.
- **Cliente:** `client.files.upload(data, {shard?, mutation?, args?, contentType?, multipartThreshold? = 32 MiB, concurrency? = 3, sha256?, fetch?, onProgress?, signal?})` e `uploadFile(client, ...)`.
  - A mutation (padrão `"storage:generateUploadUrl"`) recebe `{...args, contentType, size, sha256?, multipart?}` e devolve `ctx.storage.generateUploadUrl(args)`.
  - `client.files.url(path)` torna absoluta uma URL relativa do modo proxy.
  - O nome `client.storage` já é usado pelo `PendingStorage` privado do `EmberClient`.
- **Deploy** (`resources.files`):
  - Recursos: bucket `ember-<project>-<env>` (binding `EMBER_FILES`, vars `EMBER_R2_BUCKET` e `EMBER_R2_ACCOUNT_ID`); CORS; lifecycle (`t/` expira em 7 dias, multipart abortado em 7 dias); fila `ember-<project>-<env>-files` com o Worker como consumer; notificação R2 (`f/` e `t/`: `PutObject`, `CopyObject`, `CompleteMultipartUpload`); `EMBER_PUBLIC_URL`.
  - `EMBER_STORAGE_SECRET` é gerado uma vez. As credenciais S3 vêm de `EMBER_R2_ACCESS_KEY_ID`/`EMBER_R2_SECRET_ACCESS_KEY` do ambiente, ficam as que o Worker já tem, ou saem de um token criado (`POST /tokens` com "Workers R2 Storage Bucket Item Write" no recurso `com.cloudflare.edge.r2.bucket.<acct>_default_<bucket>`; secret = sha256 do valor). Sem nenhuma delas, o deploy usa o modo proxy.
  - `resources.images` adiciona o binding `EMBER_IMAGES`.
  - Ids de fila são comparados sem hífens: a API de notificações devolve o UUID com hífens.

## Telemetria, registro e painel (Fase 4b)
- **Métricas** (`@freecorps/ember-runtime` `metrics.ts`): binding Analytics Engine `EMBER_METRICS` (um dataset por conta, padrão `ember_metrics`; `ember.json` `metrics: { enabled?, dataset?, sample? }`). Sem binding: no-op. Nunca lança.
  - Um ponto por execução: `index1 = "<project>/<env>"`; `blob1..9 = project, env, shardKind, fn, kind, status, errorCode, shard, timing`; `double1..5 = durationMs, rowsRead, rowsWritten, bytesOut, weight`.
  - `kind`: `query` (RPC/HTTP), `subscription` (reexecução reativa), `mutation`, `job` (mutation agendada/cron), `action` (no Worker; linhas contadas pelas chamadas ao shard).
  - Group commit: linhas do lote divididas igualmente entre os itens; a duração (`commit`) é de cada item, do seu recebimento à durabilidade do lote. Linhas = contadores do `DoSqlDriver` em volta da chamada ao engine.
  - `EMBER_METRICS_SAMPLE` (0..1) amostra os ok; erros sempre; `weight = 1/rate`. Contagem = `SUM(_sample_interval * double5)` (o próprio Analytics Engine também amostra).
  - `blob9 = timing` diz **o que `durationMs` mede** (Fase 5b). Em produção o relógio do Workers só anda com I/O, então trabalho SQLite síncrono dentro do DO mede 0; toda duração é tempo de parede tomado onde o relógio anda:
    - `rpc`: no Worker (HTTP `/api/query|mutation`, ou `runQuery`/`runMutation` de uma action), em volta do RPC ao shard: hop até o DO + fila de entrada/group commit + execução + (mutations) o commit durável que a resposta do RPC espera. O caller passa `{ caller: true }` ao `Shard.query/mutation`; o shard não grava ponto e devolve `outcome.metrics = { rowsRead, rowsWritten, bytesOut }` (retirado da resposta HTTP). Chamadas recusadas antes de executar não geram ponto.
    - `commit`: no DO, do recebimento (`mut` por WebSocket; início do job) até a escrita durável (`ctx.storage.sync()`): espera do group commit + execução + durabilidade. O ponto é gravado depois do `sync()` (`waitUntil`).
    - `wall`: actions no Worker.
    - `none`: reexecução de subscription (síncrona no DO): 0 em produção; no workerd local (`ember dev`, testes) os timers andam, então o valor local é real.
    - `""`: pontos anteriores à Fase 5b (0 para query/mutation em produção).
    - Tempo de CPU por chamada não existe na plataforma (só por invocação, em Workers Logs / Tail). O painel e `ember metrics` agrupam p50/p95 por `timing`.
  - `EMBER_TRACE=1` (var) também loga `ember:exec {json}` por execução (filtro do `ember logs`).
- **Catálogo de shards**: binding D1 `EMBER_REGISTRY` (o registro). Cada shard faz upsert em `shards(project, env, shard, kind, key, schema_version, db_size, last_write, reported_at)` depois de migrar (quando já sabe o nome) e na manutenção horária (no máximo 1×/50 min). Escolha: binding D1 direto em vez de Queue — um upsert por shard por hora, sem consumer nem fila extra. Falha = log, nova tentativa no próximo report.
- **Admin** (mesmo `EMBER_ADMIN_TOKEN` do status): `GET /api/_ember/data?shard=&table=&cursor=&limit=` (sem `table`: lista tabelas do schema + `_jobs`, `_files`, `_ember_migrations`, `_ember_bookmarks` com contagem; com `table`: página por `_rowid`/`rowid`, até 200, documentos decodificados, colunas `_k_*` omitidas, `{rows, cursor, done}`; 404 tabela desconhecida). `GET /api/_ember/crons` → crons resolvidos + estado do System.
- **Registro da conta** (`@freecorps/ember-cli` `registry.ts`): D1 `ember-registry` (`--registry`/`EMBER_REGISTRY_NAME`), criado pelo primeiro deploy. Tabelas `projects(name, fingerprint, repo)`, `environments(project, env, worker UNIQUE, url, schema_version, version_id)`, `deployments`, `domains(host PK)`, `inbound_addresses`, `auth_links`, `shards`. `ember.json` `fingerprint` (gerado no 1º deploy) é o dono do nome; outro fingerprint → `RegistryConflictError` antes de qualquer upload; nome de Worker colidindo entre projetos também é recusado.
- **Domínios**: `ember domains add <host>` acha a zona (sufixo mais longo), recusa se o host é Custom Domain de outro Worker, casa com rota de outro Worker, ou está no registro para outro projeto/env; senão `PUT /workers/domains` e grava no registro.
- **Logs**: `POST /workers/scripts/:w/tails` → WebSocket `trace-v1` → `DELETE` ao sair.
- **Ember Dashboard** (`apps/dashboard`): Worker + SPA React embutidos num módulo (esbuild). Bindings `REGISTRY` (D1), `EMBER_SVC_<n>` (service binding por Worker de projeto registrado, mapa em `EMBER_SERVICES`), vars `CF_ACCOUNT_ID`, `METRICS_DATASET`, `ACCESS_TEAM_DOMAIN`/`ACCESS_AUD`; secrets `DASHBOARD_TOKEN`, `EMBER_ADMIN_TOKEN` (ou `EMBER_ADMIN_TOKENS` JSON por Worker), `CF_API_TOKEN` (Analytics Read). Auth: JWT do Cloudflare Access (RS256, aud, exp, certs do time) ou `Bearer DASHBOARD_TOKEN`; nenhum configurado → 403. API só GET: `/api/me|projects|deployments|shards[?status=1]|status|crons|data|functions`.

## Índices externos: Vectorize e AI Search (`@freecorps/ember-server` ⇄ `@freecorps/ember-runtime` ⇄ `@freecorps/ember-cli`) — Fase 5b
Kinds de índice embutidos (como `searchIndex`), com `external` no `IndexKind`: `ddl` vazio, `backfill = externalBackfill`, sem `query` (não são lidos em query/mutation, não são reativos). Consulta só em actions.
```ts
defineTable({ title: v.string(), body: v.string(), lang: v.string(), vec: v.array(v.number()) })
  .vectorIndex("by_vec", { vectorField: "vec", dimensions: 768, metric?: "cosine" | "euclidean" | "dot-product", filterFields?: ["lang"] })
  .vectorIndex("semantic", { embed: "body" /* ou { field, model } */, filterFields?: [...] })   // dimensions vem do modelo
  .aiSearchIndex("hybrid", { fields: ["title", "body"], filterFields?: ["lang"], embeddingModel?: "@cf/baai/bge-m3" })

ctx.vectorSearch("notes", "by_vec", { vector, limit?: 10 /* ≤100 */, filter?: { lang: "pt" | { $eq,$ne,$in,$nin,$lt,$lte,$gt,$gte } }, shard? })
  → Promise<{ _id: Id<"notes">; _score: number }[]>          // { text } no lugar de { vector } com embed
ctx.aiSearch("notes", "hybrid", { query, limit?: 10 /* ≤50 */, filter?, mode?: "hybrid" | "vector" | "keyword", fusion?: "rrf" | "max", shard? })
  → Promise<{ _id: Id<"notes">; _score: number; text: string }[]>   // um item por documento (melhor chunk)
```
- **Validação no `defineSchema`:** `vectorField` é `v.array(v.number())`; exatamente um de `vectorField`/`embed`; `dimensions` 32..1536 (faixa do Vectorize, medida); modelo de embed conhecido define `dimensions` (bge-m3 1024, qwen3 1024, embeddinggemma 768, bge-*-en). Filtros: string/number/boolean/id (inclusive aninhados), até 10 (Vectorize, chave = caminho com `.`→`_`) ou 5 (AI Search, chave em minúsculas, sem `timestamp`/`folder`/`filename`).
- **Outbox** (`_ember_ext_outbox(tbl, idx, doc_id, seq, sent, sent_at, attempts)`, criada pelo `SYSTEM_DDL`): o engine grava uma linha **na transação da mutation** quando uma escrita muda um campo do índice (insert, delete, ou patch/replace que toca `spec.fields`); linhas coalescem por documento; `seq` é um token aleatório novo por escrita. Linhas na janela de um backfill staged ficam para o backfill. Réplicas locais (offline) nunca preenchem o outbox.
- **Backfill/reindex:** índice novo, ou spec alterada (filtros, dimensões, métrica, modelo), numa tabela com dados vira *staged*; `backfillStep` insere uma linha de outbox por documento (o mesmo mecanismo de `.index()`), e a entrega reenvia tudo.
- **Entrega** (`outboxClaim`/`outboxFetch`/`outboxAck`, puras sobre `SqlDriver`):
  - Depois de cada commit com mudanças (e no alarm), o shard reivindica linhas `sent = 0` (ou em voo há mais de `resendMs`), marca `sent = claim` (um **token de claim** aleatório novo por reivindicação) e manda **uma mensagem por ≤50 documentos de um índice** para a Queue `EMBER_INDEXING`: `IndexMessage = { t: "ember.index", shard, table, index, ids, claim }`. Sem Queue (dev, testes), o próprio shard indexa no seu turno.
  - O consumer (`queue()` do Worker, ou o shard) chama `Shard.extFetch(…, claim)` → estado **atual** + `seq` lido + `current` (o claim da mensagem ainda é o da linha), escreve no serviço só os itens `current` e chama `extAck(acks, claim)`.
  - **Reenvio e cercas (fencing):** uma linha sem ack é reenviada após `resendMs` com um claim novo, então duas entregas do mesmo documento podem se sobrepor (a primeira só lenta). A escrita no serviço não pode ser condicional; quem cerca é o ack:
    - claim atual e mesmo `seq` → linha apagada (pronto);
    - claim atual e `seq` mudou (escrita no meio) → volta a `sent = 0` e é reenviada com o estado novo;
    - claim superado → a escrita desta entrega pode ter caído **depois** da mais nova: a linha ganha um `seq` novo, sem zerar `attempts` (linha estacionada continua estacionada até o documento mudar), e a entrega mais nova em voo falha a própria checagem de `seq` e reenvia;
    - linha sumida (outra entrega já confirmou) → reenfileirada como uma escrita do documento, então uma entrega reivindicada depois deste ack regrava o estado mais novo.
    - Entrega cujo claim já está superado no `extFetch` (duplicata da Queue, reenvio) pula o documento: sem escrita, sem ack. Mensagem sem `claim` (versão anterior) conta como superada. Exceção: numa **reentrega** da Queue (`attempts > 1`), a tentativa anterior pode ter escrito antes de falhar; os itens superados são então confirmados com o claim antigo, o que cai no caminho "claim superado" e garante mais uma entrega do estado mais novo.
  - **Invariante:** a última escrita no serviço para um documento é sempre seguida de uma entrega do seu estado mais novo; o índice externo converge para o estado atual do documento (estados velhos podem aparecer por um instante, nunca ficam por último). Prova curta: uma linha só sai com um ack de claim atual e `seq` igual ao lido; qualquer outra entrega que tenha escrito depois dessa escrita confirma depois dela e encontra a linha sumida/com outro claim → reenfileira.
  - Falha: `msg.retry({ delaySeconds: 5·2^n, ≤300 })`; sem ack, reenvio após 10 min (fila) ou 15 s (em processo); `sendBatch` que falha adia 30 s. Depois de 10 envios sem ack a linha é estacionada (`sent = -1`, log) até o documento mudar de novo. Linhas de índice que saiu do schema são descartadas.
  - `inspect().outbox = { pending, inFlight, parked }`.
- **Vectorize:** um índice por `(project, env, tabela, índice, dimensões, métrica, modelo)`; binding `EMBER_VEC__<tabela>__<índice>`; vector id = `_id` do documento (≤64 bytes); **namespace = shard** (`vectorNamespace`: o nome do shard, ou `h:<sha256[0..40]>` acima de 64 bytes); metadados = filtros; `query(vector, { topK, namespace, filter, returnMetadata: "none" })`. Embed: `EMBER_AI.run(model, …)` no consumer (documentos) e na busca (consulta), com a forma de entrada de cada modelo.
- **AI Search** (verificado na doc e numa sonda real em 2026-11-04): instância por `(project, env, tabela, índice)` no namespace `default` (binding de instância `ai_search`, `EMBER_AIS__<tabela>__<índice>`; nenhum dos 100 namespaces da conta é usado). Item = `s<sha256(shard)[0..32]>/<_id>.md` (`aiSearchItemKey`), texto = os `fields` em seções markdown, `metadata` = filtros como strings: o upload só aceita `Record<string, string>` (Items API), e o AI Search converte cada valor para o `data_type` do `custom_metadata` da instância ao indexar (`number` vira float, `boolean` aceita true/false/1/0/yes/no); os filtros de busca vão tipados (`{ stars: { $gte: 3 } }`, como na doc). Declarar tudo `text` e passar filtros como string deixaria faixas numéricas lexicográficas. Reenviar a mesma chave substitui o item (mesmo id, medido); delete procura o id por chave (`items.list({ search })`). A pasta (`folder`, filtro embutido) isola o shard, então os 5 campos custom ficam para `filterFields`. Busca com `cache: { enabled: false }` (o cache de similaridade, ligado por padrão por 48 h, devolveu resultado velho na sonda), `keyword_match_mode: "or"` (`and` não achou perguntas naturais em pt-BR), `max_num_results = 2·limit`, `filters: { folder, ...filtro }`; os chunks são agrupados por documento.
  - **Preço:** a cobrança do AI Search começa em **2026-12-01**: por mês 5 M tokens de ingestão, 10 GB-mês, 1.000 consultas semânticas e 1.000 full-text inclusos; depois $0,75/M tokens de ingestão, $2,00/GB-mês, **$0,75 por 1.000 consultas semânticas/vetor/híbridas**, $0,10 por 1.000 full-text. Embedding e reranking do Workers AI dentro do AI Search entram nesse preço. Até 5.000 instâncias no plano pago (depois $0,10/instância/mês), 1 M arquivos por instância (500 k com híbrido).
- **Fallback local explícito:** `EMBER_AI_INDEXES = "local"` (o `ember dev` define) e binding ausente → o shard guarda o índice no próprio SQLite (`_ember_ext_local`) e busca por força bruta: vizinhos exatos com as mesmas métricas e semântica de filtro do Vectorize; texto por BM25 (sem vetor, sem chunks); embeddings de `EMBER_AI` se houver, senão `hashEmbedding` (só palavras em comum, não semântico). Sem a flag, binding ausente = `IndexNotConfigured`, nunca fallback silencioso.
- `config.externalIndexes.env(env)` sobrepõe os bindings que o indexer e as buscas usam (fakes nos testes; proxies remotos).
- **Deploy** (`deploy/ai.ts`), antes do upload: índices Vectorize (`POST /vectorize/v2/indexes`, descrição `ember:<project>/<env> <tabela>.<índice> (<dims>/<métrica>/<modelo>)`) + um metadata index por filtro (a lista devolve `"String"`, o create recebe `"string"`; propriedades que saíram de `filterFields` são apagadas com `POST …/metadata_index/delete { propertyName }` no prune, ou já antes do create se as novas não cabem nos 10 slots do Vectorize); instâncias AI Search (`POST /ai-search/namespaces/default/instances` com `embedding_model`, `cache: false`, `custom_metadata`, `retrieval_options.keyword_match_mode: "or"`; `PUT` quando muda); Queue `ember-<project>-<env>-indexing`. Depois do upload: consumer da Queue. Bindings (`vectorize`, `ai_search`, `ai`, `queue`) vão em todo deploy, então um deploy só de código os mantém. Depois do deploy a 100%: **prune** dos recursos deste env que o schema não usa mais (dono pela descrição no Vectorize e pelo prefixo `ember-<project>-<env>__` no AI Search; nunca por prefixo de nome solto); deploy gradual não faz prune; quando a fila de indexação sai, a Worker é tirada dos consumers dela antes do delete (o mesmo `detachQueueConsumer` do `ember destroy`). Nomes: Vectorize `ember-<project>-<env>-<tabela>-<índice>-<hash8>` (o hash cobre dimensões/métrica/modelo: mudar = índice novo + backfill, o velho é apagado depois), AI Search `ember-<project>-<env>__<tabela>_<índice>_<hash6>`.
- **`ember destroy --env X --yes`:** tira a Worker dos consumers das filas do env (a Cloudflare recusa apagar um consumer), apaga a Worker (com os dados dos DOs), os recursos de índice externo do env, a fila de indexação, a fila de arquivos e o bucket (se vazio).
- **Trace:** com `EMBER_TRACE=1`, o consumer loga `ember:index {shard, index, upserted, deleted, attempt, queuedMs, deliverMs}` por mensagem.
- **Codegen:** `action`/`internalAction`/`httpAction` e `ActionCtx` gerados recebem o `DataModel`; buscas checadas por tabela, índice, `{ text }` só com `embed`, campos e tipos de filtro. Sem codegen (`ActionCtx` genérico), qualquer nome é aceito.

## Offline (`@freecorps/ember-client` ⇄ `@freecorps/ember-offline` ⇄ `@freecorps/ember-server`) — Fase 5a
Opcional (D1). Sem `StorageAdapter`, o cliente é o de sempre (cache em memória + `PendingStorage`).

**Contrato no cliente** (`@freecorps/ember-client`, `storage.ts`): `EmberClientOptions.storage` aceita `PendingStorage` (como antes) ou um `StorageAdapter` (reconhecido por `applyPatch` + `runQueryLocally`).
```ts
interface StorageAdapter {
  load(): Promise<{ identity?: LocalIdentity | null } | void>      // 1ª coisa do init: abre/migra; identidade da última sessão
  readonly persistPending: PendingStorage                          // clientId + fila de mutations (substitui `storage`)
  applyPatch(u: QueryUpdate): Promise<void> | void                 // cada valor confirmado (snap sem `unchanged`, patch), na ordem do servidor
  runQueryLocally(r: LocalQueryRequest): Promise<LocalQueryResult | undefined> | ...
  setIdentity?(id: LocalIdentity | null): ...                       // `sub`/`iss` do JWT atual; null no sign-out
  readonly sync?: readonly SyncSpec[]                              // queries inscritas pela vida inteira do cliente
  flush?(): Promise<void>; close?(): ...
}
type QueryUpdate = { shard; fn; args; argsJson /* stableStringify */; value; version }
type LocalQueryRequest = { shard; fn; args; argsJson; identity: LocalIdentity | null }
type LocalQueryResult = { value: unknown; source: "local" | "cache" }
type SyncSpec = { query: string | FunctionReference<"query">; args?; shard? }
type LocalIdentity = { subject: string; issuer?: string }
```
- Uma inscrição nova pede `runQueryLocally` (depois do `load`). Enquanto o servidor não responde, o snapshot é `success` com o valor local e `source: "local" | "cache"`; o primeiro `snap`/`patch` substitui (sem `source`). Updates otimistas são aplicados sobre `confirmed ?? local`, então funcionam offline desde o cold start.
- `options.optimisticUpdates: { "<fn>": update }`: update por nome, usado quando a chamada não passa um e nas mutations restauradas do armazenamento (os closures se perdem no restart). Assim a edição offline continua visível depois de recarregar; a reconciliação é a de sempre (`patch.mids` derruba a camada, `mres` resolve, rejeição desfaz).
- Mutations restauradas vão primeiro e são reenviadas com o mesmo `mid` no `ready` (dedup por `(identity, clientId, mid)`); o `mres` remove do `persistPending`.
- `load()` que falha: o cliente segue sem offline (memória) e reporta `storage_error`.
- `client.flushStorage()`: espera as escritas entregues ao adapter.

**Execução local** (`@freecorps/ember-server`, `local.ts`, TS puro):
- `QueryImpl` lê por `QueryEnv.scan(t, index, lo, hi, asc, limit)` e `QueryEnv.pluginQuery(kind, t, spec, arg)`. O engine implementa com `sqlScan` / `sqlPluginQuery` (o SQL de antes); réplicas locais implementam com o mesmo encoding de chave. Ranges, filtros, ordem, cursores de paginação (interoperáveis com o servidor) e read sets saem do mesmo código.
- `runLocalQuery(fn, args, { schema, reader: LocalReader, identity?, now?, rowsRead? })`: valida args e retorno como o engine; `ctx.db.get/query/normalizeId` e índices de plugin que o reader suporta. `ctx.db.aggregate`, `ctx.db.sql` e `ctx.storage` lançam `OfflineUnsupported`. Limite de 16k linhas lidas.
- Só `query()` **públicas registradas explicitamente** rodam no cliente (`localQueryRegistry`/`assertLocalQuery`: mutation, action, internal → `InvalidFunction`). O cliente importa as mesmas definições `query()` dos módulos `ember/` (são puras: só leitura síncrona).
- `LocalReader { scan, get, pluginQuery? }` é síncrono. Stores assíncronos (IndexedDB) servem o que já buscaram, registram o resto como *miss* (lançando `NeedData`) e a query é reexecutada depois do `fetch()` (até nada faltar).
- Schema: `LocalSchema = { manifest, indexKinds }` — o `SchemaDefinition` do app, ou `localSchema(manifestJson.schema, plugins?)` a partir do `_generated/manifest.json` do codegen.
- `documentsIn(manifest, value)`: documentos completos num resultado (arrays, `{page}`, objetos aninhados): `_id` de tabela conhecida, `_creationTime` number, campos válidos pelo shape da tabela. Projeções e objetos calculados ficam de fora.
- SQLite local: `prepareLocalDatabase(driver, schema)` = planner + DDL do servidor (FTS5 `unicode61 remove_diacritics 2` incluído), backfill imediato; migração recusada → `wipeLocalDatabase` + recriação (`{reset: true}`). `sqlReplicaWriter` grava docs com o codec de linha e as chaves do servidor (mantém `_id`/`_creationTime`; triggers FTS acompanham; agregados e `_files` não são mantidos). `sqlLocalReader` lê com o SQL do servidor.
- `jsSearch(docs, spec, build)`: `withSearchIndex` sem FTS5 (mesmo tokenizer, OR dos termos com o último como prefixo, trigram, filtros `.eq`, até 1024), ranking BM25 (k1 1,2, b 0,75) sobre `docs`.

**Store genérico** (`@freecorps/ember-offline`, `createOfflineStorage(backend, { schema, queries?, sync?, maxQueries? = 500, retentionMs? = 30 d })`):
- Registro por `(shard, fn, argsJson)`: último valor confirmado, `version`, `updatedAt`, `ids` (docs completos do valor).
- **Replicação por posse:** só valores de queries *offline* (registradas em `queries` ou listadas em `sync`) replicam linhas. Uma linha existe enquanto algum registro a possui; quando o novo valor do último dono não a contém mais (apagada no servidor ou fora dos ranges em cache), ela é apagada. A réplica é sempre a união dos últimos resultados do servidor — nunca uma linha que o servidor não mandou. Docs iguais aos do valor anterior não são regravados.
- Queries não registradas só têm o valor em cache (`source: "cache"`).
- `runQueryLocally`: registrada → roda local (`source: "local"`; erro → cache, se houver); senão → cache; senão `undefined`.
- Escritas (resultados, fila, meta) passam por uma fila única (ordem garantida; `flush()`); registro e linhas do mesmo shard são gravados atomicamente.
- Retenção: no `load`, registros sem atualização há mais de `retentionMs` saem (com as linhas que só eles possuíam). Acima de `maxQueries`, sai o menos recentemente atualizado. `clear()` esquece resultados e linhas (a fila fica).
- `OfflineBackend { open, setMeta, loadPending, putPending, removePending, commit(shard, {put, drop, upsert, delete}), reader(shard), close }`.

**Backends:**
- `memoryStorage` / `MemoryBackend`: referência, sem persistência (ou compartilhando o objeto `backend`).
- `sqliteStorage({ open: (name) => SqlDriver, name? })` e `expoSqliteStorage({ openDatabaseSync?, name? })` (`expo-sqlite` é peer opcional, carregado com `require` preguiçoso; FTS5 vem habilitado no expo-sqlite). Banco principal `<name>` (`_ember_local_meta`, `_ember_local_pending`, `_ember_local_shards`) e um banco por shard `<name>-<sha256(shard)[0..24]>` com as tabelas do schema + `_ember_local_queries`. `expoSqliteDriver(db)` usa `getAllSync` (SELECT/WITH/PRAGMA/RETURNING) e `runSync`, savepoints para transações aninhadas, WAL.
- `indexedDbStorage({ name?, indexedDB?, IDBKeyRange? })`: stores `meta`, `pending` (autoIncrement + índice único `mid`), `queries`, e `t:<tabela>` com keyPath `["s", "id"]` (shard, `_id`) e um índice `[s, _k_<índice>]` por índice db (inclui `by_creation_time`), onde `_k_<índice>` é a chave codificada do servidor como `ArrayBuffer`. Cada range é `IDBKeyRange.bound([shard, lo], [shard, hi], false, true)` (IndexedDB compara binário byte a byte, como o BLOB no SQLite); `desc` usa cursor `prev`. Busca carrega as linhas da tabela do shard e roda `jsSearch`. Versão de schema diferente → `versionchange` recria os stores `t:*` e limpa `queries` (a fila fica).

**Limites conhecidos:** resultados locais refletem o último sync (não são reativos enquanto offline: rodam uma vez na inscrição, mais as camadas otimistas); a réplica é parcial, então `take`/contagens/ranking bm25 locais podem diferir do servidor até a próxima resposta; mutations não rodam no cliente (o efeito offline vem dos updates otimistas); identidade local = `sub`/`iss` do JWT sem verificação (tokens não-JWT → identidade guardada ou null); um cliente por nome de armazenamento (sem coordenação entre abas); IndexedDB/memória resetam a réplica em qualquer mudança de schema (SQLite só quando o planner recusa); o valor inteiro do resultado é regravado a cada patch.
