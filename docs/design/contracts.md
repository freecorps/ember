# Contratos internos da Fase 1

Estas interfaces separam `@ember/server`, que é TS puro, de `@ember/runtime`, que roda em workerd, e de `@ember/client`.
Se uma mudança for necessária, atualize este arquivo no mesmo commit.

## SqlDriver (`@ember/server`)
Um adaptador mínimo e síncrono. O runtime o implementa sobre `ctx.storage.sql`; os testes usam `node:sqlite`.
```ts
export interface SqlDriver {
  exec(sql: string, ...params: SqlValue[]): { rows: Record<string, SqlValue>[]; rowsRead: number; rowsWritten: number }
  transaction<T>(fn: () => T): T   // síncrono. Aninhado = savepoint. Lança erro se fn devolver Promise.
}
export type SqlValue = null | number | string | Uint8Array   // sem bigint/boolean: quem converte é o engine
```

## Manifesto de schema (`@ember/server`)
`defineSchema(...)` expõe `schema.manifest`: JSON serializável com as tabelas (campos → Shape), os índices (kind + config), os shards e a versão (hash).
Ele alimenta o DDL, as migrações, o codegen e o cliente offline.

## Engine (`@ember/server`)
```ts
createEngine({ schema, functions, driver, now?, random? }): Engine

interface Engine {
  migrate(): MigrationReport   // idempotente. Usa a tabela _ember_meta.
  runQuery(name, args, ctx: AuthCtx): { value: unknown; readSet: ReadSet }
  runMutation(name, args, ctx: AuthCtx): { value: unknown; changes: RowChange[]; scheduled: Job[] }
  runMutationBatch(items): Array<Result>   // group commit: uma transação, um savepoint por item
  matches(readSet: ReadSet, changes: RowChange[]): boolean
}
type ReadSet = Array<{ table: string; index: string; lo: Uint8Array; hi: Uint8Array /* exclusivo */; kind: string }>
type RowChange = { table: string; id: string; before: Doc | null; after: Doc | null }
```
- Chaves de índice: codificação do `@ember/values` que preserva a ordem. A comparação é por bytes (memcmp).
- Kinds de índice que não são `db` (busca, por exemplo) decidem o próprio matching pelo plugin (`matchesChange`).

## Protocolo WS v1 (`@ember/runtime` ⇄ `@ember/client`)
Frames JSON; o binário fica para depois. Ping e pong são as strings literais `"ping"` e `"pong"`, para a auto-response funcionar.
Cliente → servidor:
- `{t:"hello", clientId, token?, protocol:1}`
- `{t:"sub", qid, fn, args, resume?:{version, epoch}}`
- `{t:"unsub", qid}`
- `{t:"mut", mid, fn, args}`
- `{t:"auth", token}`

Servidor → cliente:
- `{t:"ready", shard, version, epoch}`
- `{t:"snap", qid, version, value}`
- `{t:"patch", version, changes:[{qid, value}]}` — um frame por versão confirmada, cobrindo todas as queries que mudaram
- `{t:"mres", mid, ok:true, value, version} | {t:"mres", mid, ok:false, error:{code, message}}`
- `{t:"err", code, message, qid?}`
- `{t:"authExpired"}`

Regras:
- Na v1, `patch` leva o valor inteiro da query; o diff por linha vem na Fase 4.
- Dedup de mutation por `(identity, clientId, mid)`.
- Um shard por socket: `/ws?shard=<tipo>:<chave>`.
- HTTP one-shot: `POST /api/query` e `POST /api/mutation` com `{fn, args, shard}`.
