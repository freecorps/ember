# Contratos internos da Fase 1

Estas interfaces separam `@ember/server`, que é TS puro, de `@ember/runtime`, que roda em workerd, e de `@ember/client`.
Se uma mudança for necessária, atualize este arquivo no mesmo commit.

## SqlDriver (`@ember/server`)
Um adaptador mínimo e síncrono. O runtime o implementa sobre `ctx.storage.sql`; os testes usam `node:sqlite` (`@ember/server/testing`, fora da entrada principal).
```ts
export interface SqlDriver {
  exec(sql: string, ...params: SqlValue[]): { rows: Record<string, SqlValue>[]; rowsRead: number; rowsWritten: number }
  transaction<T>(fn: () => T): T   // síncrono. Aninhado = savepoint. Lança erro se fn devolver Promise.
}
export type SqlValue = null | number | string | Uint8Array   // sem bigint/boolean: quem converte é o engine
```
- Um statement por `exec`. Parâmetros posicionais (`?` ou `?NNN`). No máximo 100 parâmetros: o engine divide linhas largas.
- BLOBs voltam como `Uint8Array` (o adaptador converte `ArrayBuffer`).

## Valores e JSON (`@ember/values`)
- `encodeJson(value): string` / `decodeJson(text): unknown` — JSON canônico com tags: `{"$int64":"…"}` (bigint), `{"$bytes":"<base64>"}`, `{"$float":"NaN"|"Infinity"|"-Infinity"|"-0"}`. Nomes de campo começando com `$` são recusados pela validação, então as tags não colidem. `encodeJsonStable` ordena as chaves (chaves de cache).
- Chave de índice: `encodeKey(values[])` estilo tuplas do FoundationDB. Ordem de tipos `undefined < null < int64 < number < boolean < string < bytes < array < object`; números em ordem total IEEE (`-0 < +0`, NaN canônico depois de `+Infinity`); strings por code point. Comparação por bytes (memcmp). `rangeFor(eq, lower?, upper?)` devolve `[lo, hi)`; `prefixEnd(p) = p ++ 0xFF`; `keySuccessor(k) = k ++ 0x00`.

## Manifesto de schema (`@ember/server`)
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

## Engine (`@ember/server`)
```ts
createEngine({ schema, functions, driver, now?, random?, limits? }): Engine   // também é o export default
// functions: { "dir/mod:fn": fn } ou módulos { "dir/mod": { fn } }

interface Engine {
  manifest: SchemaManifest
  migrate(): MigrationReport                 // idempotente; usa _ember_meta; roda em driver.transaction (aninhável); lança MigrationRefused
  planMigration(): MigrationPlan             // dry run
  backfillStep(limit?: number): BackfillProgress   // índices staged, em blocos (padrão 500); chamar até done
  runQuery(name, args, ctx: AuthCtx): { value: unknown; readSet: ReadSet }
  runMutation(name, args, ctx: AuthCtx): { value: unknown; changes: RowChange[]; scheduled: Job[] }
  runMutationBatch(items: { name; args; ctx: AuthCtx }[]): MutationBatchResult[]   // group commit
  matches(readSet: ReadSet, changes: RowChange[]): boolean
  tableOfId(id): string | undefined
  functionInfo(name): { type: "query" | "mutation" | "action" | "httpAction"; visibility: "public" | "internal" } | undefined
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
  | { ok: true; value: unknown; changes: RowChange[]; scheduled: Job[] }
  | { ok: false; error: { code: string; message: string } }
type MigrationReport = { changed: boolean; fromVersion: string | null; toVersion: string; steps: MigrationStep[]; staged: { table; index; kind }[] }
```
- Queries e mutations são síncronas por dentro: `ctx.db` devolve valores, não Promises. Handler que devolve Promise → erro `AsyncHandler` (e rollback).
- `runMutationBatch`: uma `driver.transaction` com um savepoint por item, mesma ordem dos itens; a falha de um item desfaz só ele e nunca lança. O runtime pode envolver tudo numa transação externa (change log, dedup, jobs).
- `ctx.scheduler.runAfter/runAt` **não** grava nada: os jobs voltam em `scheduled` e o runtime os persiste na própria tabela `_jobs`, na mesma transação. `kind` vem do tipo da função agendada.
- `ctx.now` é fixo por execução; `ctx.random()` usa uma semente por mutation (derivada de `random()`).
- Erros lançados por `runQuery`/`runMutation` são `EmberError` com `code` string: `ValidationError`, `NotFound`, `TooManyReads` (16k linhas), `TooManyWrites` (8k), `DocumentTooLarge` (2 MB), `SchemaError`, `MigrationRefused`, `IndexNotReady`, `FunctionNotFound`, `InvalidFunction`, `AsyncHandler`, `QueryError`, `InvalidCursor`. Outros erros (do usuário) viram `code: "Error"` no batch.
- Visibilidade (`internal*`) é checada pelo runtime via `functionInfo`.
- Chaves de índice: coluna BLOB `_k_<índice>` com `encodeKey([campos..., _creationTime, _id])`. `by_id` é `encodeKey([_id])`; `by_creation_time` é `[_creationTime, _id]`.
- Kinds de índice que não são `db` (busca, por exemplo) decidem o próprio matching pelo plugin (`matchesChange`).
- Índices staged: o runtime chama `backfillStep(500)` um bloco por turno de alarm (reagendando o alarm até `done`); o índice fica consultável quando termina (antes disso → `IndexNotReady`).
- Tabelas internas: `_ember_meta`, `_ember_indexes` (engine) e `_jobs` (runtime). O planner ignora tudo que começa com `_` ou `sqlite_`, e as tabelas-sombra do FTS5.

## Protocolo WS v1 (`@ember/runtime` ⇄ `@ember/client`)
Frames JSON (valores em `encodeJson`); o binário fica para depois. Ping e pong são as strings literais `"ping"` e `"pong"`, para a auto-response funcionar.
Cliente → servidor:
- `{t:"hello", clientId, token?, protocol:1}`
- `{t:"sub", qid, fn, args, resume?:{version, epoch}}`
- `{t:"unsub", qid}`
- `{t:"mut", mid, fn, args}`
- `{t:"auth", token}` — `token: null` faz sign-out: o socket passa a anônimo e todas as suas subscriptions são reavaliadas (novo `snap`)

Servidor → cliente:
- `{t:"ready", shard, version, epoch}`
- `{t:"snap", qid, version, value}`
- `{t:"snap", qid, version, unchanged:true}` — sem `value`: resposta a um `resume` bem-sucedido (o valor do cliente continua válido)
- `{t:"patch", version, changes:[{qid, value}], mids}` — um frame por versão confirmada, cobrindo todas as queries que mudaram. `mids` (sempre presente, pode ser `[]`) são os `mid`s **deste socket** cujos efeitos estão nessa versão, para o cliente descartar os updates otimistas correspondentes de forma atômica; o `mres` de cada um vem depois
- `{t:"mres", mid, ok:true, value, version} | {t:"mres", mid, ok:false, error:{code, message}}`
- `{t:"err", code, message, qid?}`
- `{t:"authExpired"}`

Regras:
- Na v1, `patch` leva o valor inteiro da query; o diff por linha vem na Fase 4.
- Dedup de mutation por `(identity, clientId, mid)`.
- Só funções `public` do tipo certo podem ser chamadas por clientes (WS e HTTP), via `engine.functionInfo`: função interna ou inexistente → `FunctionNotFound` (não revela que existe); tipo errado → `InvalidFunction`. Funções `internal*` rodam só pelo scheduler/crons.
- `sub` cuja query falha continua registrada (estado "errored"): o servidor manda `err` com `qid` e reexecuta a query depois de cada commit (ela não tem read set) e quando um índice staged fica pronto; o primeiro sucesso chega como `patch`. Reenviar `sub` com o mesmo `qid` de uma sub errored a reexecuta (não é `duplicate_qid`).
- `resume` só responde `unchanged` se o último snapshot daquele `(clientId, qid)` foi calculado sob a mesma identidade do socket atual; senão vai `snap` completo.
- Frame `sub`/`mut` que chega depois do `exp` do token **não** roda como anônimo: o servidor responde `authExpired` e, para `mut`, `mres ok:false code:"auth_expired"` (para `sub`, `err` com `qid` e `code:"auth_expired"`), e descarta o frame. O cliente manda `auth` com um token novo.
- Erros de usuário em queries/mutations usam `code:"Error"` (os `EmberError` mantêm o próprio `code`).
- Um shard por socket: `/ws?shard=<tipo>:<chave>`.
- HTTP one-shot: `POST /api/query` e `POST /api/mutation` com `{fn, args, shard}`.
