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
- Erros lançados por `runQuery`/`runMutation` são `EmberError` com `code` string: `ValidationError`, `NotFound`, `TooManyReads` (16k linhas), `TooManyWrites` (8k), `DocumentTooLarge` (2 MB), `SchemaError`, `MigrationRefused`, `IndexNotReady`, `FunctionNotFound`, `InvalidFunction`, `AsyncHandler`, `QueryError`, `InvalidCursor`, `FileNotFound`, `FileInUse`, `StorageError`. Outros erros (do usuário) viram `code: "Error"` no batch.
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
  - `gcBegin` marca como `deleting` até 100 linhas com `refcount = 0` e `zero_since <= now - grace`, mais linhas `deleting` paradas há mais de 60 s.
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
  - Um ponto por execução: `index1 = "<project>/<env>"`; `blob1..8 = project, env, shardKind, fn, kind, status, errorCode, shard`; `double1..5 = durationMs, rowsRead, rowsWritten, bytesOut, weight`.
  - `kind`: `query` (RPC/HTTP), `subscription` (reexecução reativa), `mutation`, `job` (mutation agendada/cron), `action` (no Worker; linhas contadas pelas chamadas ao shard).
  - Group commit: duração e linhas do lote divididas igualmente entre os itens. Linhas = contadores do `DoSqlDriver` em volta da chamada ao engine.
  - `EMBER_METRICS_SAMPLE` (0..1) amostra os ok; erros sempre; `weight = 1/rate`. Contagem = `SUM(_sample_interval * double5)` (o próprio Analytics Engine também amostra).
  - Duração de query/mutation é 0 em produção (o relógio do workerd só anda com I/O); actions têm duração real.
  - `EMBER_TRACE=1` (var) também loga `ember:exec {json}` por execução (filtro do `ember logs`).
- **Catálogo de shards**: binding D1 `EMBER_REGISTRY` (o registro). Cada shard faz upsert em `shards(project, env, shard, kind, key, schema_version, db_size, last_write, reported_at)` depois de migrar (quando já sabe o nome) e na manutenção horária (no máximo 1×/50 min). Escolha: binding D1 direto em vez de Queue — um upsert por shard por hora, sem consumer nem fila extra. Falha = log, nova tentativa no próximo report.
- **Admin** (mesmo `EMBER_ADMIN_TOKEN` do status): `GET /api/_ember/data?shard=&table=&cursor=&limit=` (sem `table`: lista tabelas do schema + `_jobs`, `_files`, `_ember_migrations`, `_ember_bookmarks` com contagem; com `table`: página por `_rowid`/`rowid`, até 200, documentos decodificados, colunas `_k_*` omitidas, `{rows, cursor, done}`; 404 tabela desconhecida). `GET /api/_ember/crons` → crons resolvidos + estado do System.
- **Registro da conta** (`@freecorps/ember-cli` `registry.ts`): D1 `ember-registry` (`--registry`/`EMBER_REGISTRY_NAME`), criado pelo primeiro deploy. Tabelas `projects(name, fingerprint, repo)`, `environments(project, env, worker UNIQUE, url, schema_version, version_id)`, `deployments`, `domains(host PK)`, `inbound_addresses`, `auth_links`, `shards`. `ember.json` `fingerprint` (gerado no 1º deploy) é o dono do nome; outro fingerprint → `RegistryConflictError` antes de qualquer upload; nome de Worker colidindo entre projetos também é recusado.
- **Domínios**: `ember domains add <host>` acha a zona (sufixo mais longo), recusa se o host é Custom Domain de outro Worker, casa com rota de outro Worker, ou está no registro para outro projeto/env; senão `PUT /workers/domains` e grava no registro.
- **Logs**: `POST /workers/scripts/:w/tails` → WebSocket `trace-v1` → `DELETE` ao sair.
- **Ember Dashboard** (`apps/dashboard`): Worker + SPA React embutidos num módulo (esbuild). Bindings `REGISTRY` (D1), `EMBER_SVC_<n>` (service binding por Worker de projeto registrado, mapa em `EMBER_SERVICES`), vars `CF_ACCOUNT_ID`, `METRICS_DATASET`, `ACCESS_TEAM_DOMAIN`/`ACCESS_AUD`; secrets `DASHBOARD_TOKEN`, `EMBER_ADMIN_TOKEN` (ou `EMBER_ADMIN_TOKENS` JSON por Worker), `CF_API_TOKEN` (Analytics Read). Auth: JWT do Cloudflare Access (RS256, aud, exp, certs do time) ou `Bearer DASHBOARD_TOKEN`; nenhum configurado → 403. API só GET: `/api/me|projects|deployments|shards[?status=1]|status|crons|data|functions`.
