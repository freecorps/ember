# Ember — "Convex na Cloudflare": plano

> Nome provisório: **Ember**, com CLI `ember`. Dá para trocar quando quiser.
> Licença MIT. Primeiro cliente: o serviço de email self-hosted da FreeCorps. Depois, talvez o Brigade.
> Evidências: `do-sqlite/RESULTS.md` (25 testes), `typegen/RESULTS.md` (46 testes), `better-auth/RESULTS.md` (472 testes), `research/CLOUDFLARE.md`.
> Legenda: ✅ testado localmente no workerd · 📄 confirmado na documentação · 🌐 depende de um teste remoto (seção 18).

---

## 0. Decisões fechadas

| # | Decisão |
|---|---|
| D1 | O servidor é a fonte da verdade. O protocolo é nosso. O offline-first é um adaptador opcional no cliente: sem ele, o cliente funciona só com cache em memória. |
| D2 | A API segue o modelo do Convex: `defineSchema`, `defineTable`, `v`, `query`, `mutation`, `action`, `internal*`, `httpAction`, `ctx.db.query().withIndex()`. Não é um clone byte a byte. |
| D3 | Cada shard é um Durable Object com SQLite e tabelas tipadas de verdade (não um blob de JSON numa tabela única). |
| D4 | O código roda num conjunto fixo de classes de DO: `Shard`, `Auth`, `System` (scheduler de crons, catálogo, inscrições globais). O deploy normal nunca mexe no ciclo de vida das classes 📄. |
| D5 | O deploy roda dentro da conta Cloudflare do próprio usuário, por chamada direta à API (sem depender do wrangler em produção). Multi-tenant via Workers for Platforms fica fora. |
| D6 | Mutations são síncronas por dentro, sem I/O. Rodam inteiras dentro de um `transactionSync` ✅. Todo I/O fica em `action`. |
| D7 | Tipos de índice são plugins. O core traz `.index()`. `searchIndex` (FTS5), `vectorIndex` (Vectorize) e `aiSearchIndex` (AI Search) são plugins oficiais. O usuário pode criar os seus ✅. |
| D8 | Auth: Better Auth first-party, rodando num DO `Auth` dedicado ✅. `ctx.auth` usa um JWT curto verificado no Worker ✅. |
| D9 | Arquivos: só metadados no DO, bytes no R2, endereçados por sha256. |
| D10 | Agendamento: tabela de jobs em cada shard, disparada pelo alarm ✅. `crons.ts` passa pelo DO `System`. |
| D11 | Clientes first-party: núcleo em TS, React, **React Query**, React Native/Expo (compatível com EAS e TestFlight, sem módulo nativo obrigatório). |
| D12 | O repo começa do zero. O Brigade é só referência. |
| D13 | **Contrato por função, estático** (docs/design/dx.md): `api.d.ts` traz args, retorno, erros e shard de cada função sem importar código do servidor; o codegen chega a um ponto fixo, imprime `Doc<"t">` e os tipos exportados pelo app pelo nome, leva o JSDoc e um declaration map (F12 abre o handler). Erros da aplicação são `defineErrors` (código PascalCase + payload validado), inferidos dos handlers e declaráveis (`errors: [...]`); no wire `{code, message, data?, kind: "app"}`. Sem `any` na superfície pública: refs por string só com `unsafeRef`, `v.any()` é `unknown`. |
| D14 | **Contexto tipado** (docs/design/dx.md §3.6–3.8): uma função declara `shard: "org"` (quem chama nomeia `org:<key>`) ou `shard: { room: "roomId" }` (o cliente roteia sozinho pelo argumento); o engine e as actions recusam outro shard (`WrongShard`). `defineApp({ env })` tipa `ctx.env` e checa ao ler (`EnvMissing`). Middlewares `builder.use(...)` somam ctx, args, erros e `onSuccess` ao contrato. Componentes tipam seus helpers com `ComponentCtx<schema, Config>`. |
| D15 | **Bordas** (docs/design/dx.md §3.10–3.12): refinamentos serializáveis no Shape (`v.string().min().email()`, `v.number().int()`, `v.array().max()`, `.describe()`), `.default()` só em argumentos, `ValidationError.data.issues`, Standard Schema, pré-validação opcional no cliente (`_generated/validators`). Rotas HTTP tipadas (`:params`, query, body, `returns`, `errors` com `status`) + cliente fetch gerado + `ember openapi` (funções em `POST /api/<kind>/<fn>`). `_generated/ai/guidelines.md` do próprio app, `@freecorps/ember-testing` e `@freecorps/eslint-plugin-ember`. |

---

## 1. Pacotes

```
ember/                     (monorepo, MIT)
  packages/
    values        v.* validators, Shape, JSON Schema, encoding de chave de índice
    server        defineSchema/defineTable, query/mutation/action builders, plugin API de índices
    runtime       Worker + DO Shard/Auth/System: SQL, transações, read-sets, protocolo, scheduler, files
    client        SyncClient (WS, rebase otimista, fila), StorageAdapter interface
    react         EmberProvider, useQuery, useMutation, usePaginatedQuery, useAction
    react-query   emberQuery(), EmberQueryClient, mutation helpers
    react-native  adaptador de reconexão (AppState/NetInfo), helpers Expo, registro de push (token Expo ou nativo)
    expo-push     lado do aparelho do push E2E: plugin Expo (NSE no iOS), chave do aparelho, tarefa Android (✅)
    offline       StorageAdapter: memory, indexeddb, sqlite, expo-sqlite (✅ Fase 5a); opfs (SQLite-Wasm), tinybase, abas (✅ Fase 5c)
    plugins/
      search-fts5   vector-vectorize   ai-search
    components/            (✅ mecanismo em server/runtime/cli; oficiais: rate-limit, workflows, push — files e auth embutidos)
      auth (better-auth)   files   push   rate-limit   workflows
    cli           ember init/dev/codegen/deploy/logs/data/export/import/env/restore/shards
  apps/
    dashboard     painel (dados, logs, tamanho por shard, crons, deploys)
    examples/     chat, todo, files-auth-jobs, email-lite   (✅ todos existem; tests no workerd, `bun run check` os cobre)
```

**Distribuição (npm):** escopo `@freecorps`, nomes `@freecorps/ember-<pacote>` (`ember-values`, `ember-server`, `ember-runtime`, `ember-client`, `ember-react`, `ember-react-query`, `ember-react-native`, `ember-offline`, `ember-push`, `ember-expo-push`, `ember-auth`, `ember-rate-limit`, `ember-workflows`, `ember-email`, `ember-cli`), todos na mesma versão. Cada pacote publica `dist/` (ESM + `.d.ts`; `tsc`, e o CLI num bundle esbuild). No repo, a condição de export `@freecorps/ember-source` aponta para `src/*.ts`, então testes, typecheck e `ember dev` rodam sem build. O release (`docs/RELEASING.md`) prepara cópias em `.release/`: fixa `workspace:*` na versão, remove a condição e publica com `npm publish --provenance` a partir de uma tag `v*`. `apps/*` são privados.

---

## 2. Schema e validadores

```ts
// ember/schema.ts
export default defineSchema({
  shards: {
    mailbox: defineShard({ key: v.id("mailboxes"), locationHint: "sam" }),
  },
  tables: {
    messages: defineTable({
      mailboxId: v.id("mailboxes"),
      subject: v.string(),
      text: v.string(),
      receivedAt: v.number(),
      flags: v.object({ read: v.boolean(), starred: v.boolean() }),
      raw: v.file(),
    })
      .shard("mailbox", "mailboxId")
      .index("by_received", ["receivedAt"])
      .searchIndex("search_text", { searchField: "text", filterFields: ["flags.read"] })
      .aiSearchIndex("semantic", { fields: ["subject", "text"] }),
  },
})
```

**Validadores** ✅: `string`, `number`, `int64` (BigInt), `boolean`, `null`, `id(table)`, `literal`, `union`, `object`, `array`, `record`, `optional`, `bytes`, `file`, `any`. Cada um carrega um `Shape` em JSON, e esse mesmo Shape alimenta a validação, o DDL, as migrações, o codegen, o JSON Schema e o OpenAPI.

**Campos de sistema:** `_id` e `_creationTime` (ms, float). Todo índice termina implicitamente em `_creationTime, _id` para desempatar ✅.

**Formato do ID:** prefixo da tabela + ULID (`msg_01J...`). É ordenável, gerável no cliente (mutation otimista) e legível. No servidor, o ULID também carrega o `_rowid` do documento (o `_creationTime` em µs: armazenamento compacto, `contracts.md`), então ler por id e por ordem de criação não precisa de índice e um insert grava uma linha só. Uma tabela pode ter ID que não é ULID (ex.: auth), desde que o tipo seja string.

**Ordem de índice igual à do Convex.** Resolve o problema de ordenação apontado no spike:
- Cada índice ganha uma coluna `BLOB` com a chave **codificada de forma que a comparação de bytes dê a ordem certa**: uma tag de tipo seguida do valor, no estilo da codificação de tuplas do FoundationDB.
- A ordem de tipos é `undefined < null < int64 < number < boolean < string < bytes < array < object`.
- A ordenação sai direto de `memcmp` no BLOB, e o `CREATE INDEX` é feito sobre essa coluna.
- O engine calcula a chave em toda escrita.
- Com isso: `null` e `undefined` ficam distintos, booleanos não colidem com 0/1, campos aninhados (`flags.read`) podem ser indexados, e um range vira `key >= ? AND key < ?`.

**Colunas no SQLite** ✅:
- Escalares de primeiro nível viram colunas tipadas numa tabela `STRICT`.
- Objetos aninhados vão para uma coluna `_json`.
- Opcionais que também aceitam null vão para o JSON (resolve a ambiguidade entre NULL e "ausente").
- **Coerções feitas pelo engine** ✅:
  - boolean → 0/1 (bind de `true` vira o texto "true")
  - int64 → texto ou BLOB (não dá bind de BigInt)
  - inteiros acima de 2^53 → `int64`

---

## 3. Funções e runtime

| Tipo | Onde roda | Banco | I/O | Tempo real (reativo) | Offline (fila) |
|---|---|---|---|---|---|
| `query` | DO do shard | leitura | não | sim | roda local (se registrada no cliente) |
| `mutation` | DO do shard, dentro de `transactionSync` | leitura e escrita | não | — | sim (otimista) |
| `action` | Worker | via `ctx.runQuery/Mutation` | sim (`fetch`, AI, email, R2) | não | não |
| `httpAction` | Worker | via `ctx.run*` | sim | não | não |
| `internal*` | igual ao tipo base | — | — | — | não exposto ao cliente |

**Regras do runtime:**
- `BEGIN`/`COMMIT` são bloqueados e um callback `async` passado ao `transactionSync` é aceito em silêncio ✅. O builder de mutation exige um handler síncrono, checado no tipo e em runtime.
- Determinismo: `Date.now()` e `Math.random()` vêm do `ctx`, com seed pela mutation. Isso permite reexecutar no cliente.
- Lote: inserção em massa via `json_each(?)` ✅, porque o limite é de 100 bind params ✅.
- Limites por transação, para manter a latência previsível:
  - 16k linhas lidas e 8k escritas, contadas com `rowsRead`/`rowsWritten` ✅;
  - 1 s de CPU;
  - 2 MB por documento, um limite do próprio engine. Em produção o SQLite aceita até ~8 MiB por valor (R5); o engine fica em 2 MB por segurança e o resto vai para o R2.
- Versão do schema e metadados ficam em `_ember_meta`, porque `user_version` é bloqueado ✅.

**Roteamento:** o cliente manda `{function, args, shardKey}`. O codegen sabe o shard de cada função a partir de `.shard()` ou de `shard: "mailbox"` na definição. O Worker resolve com `idFromName(shardKey)` e o location hint.

---

## 4. Reatividade e protocolo

**Servidor (DO)** ✅:
1. Cada execução de query grava um **read-set**: `(table, index, [lo, hi))`, cortado no ponto onde a leitura parou, de modo que escrever além do `take(n)` não invalida a query.
2. Cada commit gera as linhas alteradas, com a versão antiga e a nova.
3. Matching: uma inscrição é afetada se a chave antiga ou a nova cair dentro do range. Isso cobre linha que entra e linha que sai.
4. Reexecuta só as inscrições afetadas, faz o diff do resultado e manda um `patch` com a versão.
- Escala: uma **árvore de intervalos por `(table, index)`** substitui o loop linear do spike.
- Cache de resultado por `(função, args)`, compartilhado entre os sockets do shard **e entre identidades** quando a execução não leu `ctx.auth` (o engine rastreia a leitura); senão por `(função, args, identidade)`. `query({ authorize, handler })` separa a checagem de acesso por identidade (read set próprio) do handler sem `ctx.auth`, compartilhado por todos os autorizados (docs/design/dx.md §3.13). Medido: 300 usuários logados na mesma lista, 52 → 8,5 ms de CPU por commit (`docs/spikes/local-bench/RESULTS.md`, "Reatividade").
- No fuzz do spike, de 83 a 87% das reexecuções eram necessárias e nenhuma atualização foi perdida ✅.
- ✅ Wake de hibernação sem reexecutar as inscrições no boot (dormentes até um lote de fundo, uma mensagem do socket ou o próximo commit); `resume` em massa memorizado por (entrada, versão); primeiro valor por HTTP enquanto o socket abre (`httpFirst`, depois `resume`); `ember dev` mostra as reexecuções por commit e avisa sobre queries caras ou não compartilháveis. Números em `docs/spikes/local-bench/RESULTS.md`, "Reatividade, wake e DX".

**Busca (relevância).** O conjunto de resultados é exato, mas o bm25 depende do corpus inteiro. Decisão: uma assinatura de busca é reexecutada com debounce de 2 s quando qualquer escrita toca a tabela FTS do shard, além do matching exato. Assim a ordem nunca fica desatualizada por mais de 2 s.

**Protocolo v1** (JSON sobre WebSocket com hibernação ✅; o binário msgpack vem depois):
- Do cliente: `hello{clientId, auth}`, `subscribe{qid, fn, args, shard, resume?{version,epoch}}`, `unsubscribe`, `mutate{mid, fn, args, shard}`, `action`, `ping`.
- Do servidor: `snapshot`, `patch{shard, version, changes}` (um por versão), `mutationResult{mid, ok|error, version}`, `authExpired`, `error`, `pong`.
- Dedup de mutation por `(identity, clientId, mid)`, guardado por 7 a 14 dias (tabelas de geração, `docs/spikes/rows-written.md`).
- Ping/pong por auto-response, sem acordar o DO ✅.
- Sockets e anexos sobrevivem à hibernação ✅. Anexo de socket tem limite de 16 KB ✅: guarda `identity`, `clientId` e as subscriptions do socket (as que não cabem vão para `_ember_subs`), então assinar não grava linha.
- Resume: o change log mantém N versões. Se o cliente estiver mais atrás que isso, recebe um snapshot completo.

**Cliente:**
- Mutations otimistas pendentes são reaplicadas sobre o estado confirmado. A resposta do servidor substitui o otimista, e uma rejeição desfaz a mudança com um erro tipado.

---

## 5. Shards

- Declarados no schema (`defineShard`). Cada tabela pertence a um tipo de shard. Tabelas sem shard vão para o shard `global`, um DO único com limite de ~1k req/s 📄 e por isso desaconselhado para dados quentes.
- **Location hint por tipo de shard ou por chave** ✅ (G3 do Brigade), configurável: `defineShard({ locationHint: "weur" })`, ou `{ fromKey: true }` (o último segmento da chave, quando é um hint da Cloudflare: `probe:ws_1:weur` → `weur`), ou por código, `createEmberWorker({ locationHint: (shard) => … })`. Medido (R8): `sam` **não** coloca DOs na América do Sul; eles caíram em MIA/ATL/ORD/EWR. Partindo de Campinas, uma query HTTP leva p50 148 ms e um patch de mutation p50 163 ms. Por isso o padrão é sem hint (MIA), e updates otimistas são obrigatórios na UX.
- **Tamanho:** cada shard expõe `databaseSize` ✅. Alerta em 70% de 10 GB 📄. Blobs nunca ficam no DO.
- **Leitura entre shards:**
  - Uma `action` lê vários shards em paralelo, sem garantia de consistência entre eles.
  - **Projeções declaradas:** `defineProjection(source, target, map)` é mantida por outbox e entregue pelo menos uma vez, com idempotência. Exemplo: uma lista de threads por organização num shard `org`.
- **Partições por tempo (fase 4):** `.partitionBy("receivedAt", "year")` cria um DO filho por partição, e o range de tempo seleciona as partições.
- **Catálogo:** a lista de shards existentes, tamanhos e versões de schema fica no D1 📄 (read replicas). Ela alimenta o painel e as migrações em massa.
- **Split automático de shard:** fora do escopo. Com chave explícita e partições, não deve fazer falta.

---

## 6. Índices plugáveis

API de plugin ✅ (spike): `defineIndexKind({ builder, ddl, backfill, query, matchesChange, types })`, com tipagem por augmentation de interface.

| Plugin | Onde | Uso | Reativo | Status |
|---|---|---|---|---|
| `.index()` | SQLite (BLOB codificado) | `withIndex` range | exato | ✅ |
| `.searchIndex()` | FTS5 com external content e triggers ✅ | `withSearchIndex(q => q.search("text", "ação"))` | exato + debounce de rank | ✅ `unicode61 remove_diacritics 2`, `trigram`, bm25, snippet e highlight |
| `.vectorIndex()` | Vectorize (20M vetores, 32–1536 dims ✅🌐, 10 campos de filtro, namespace = shard) | só em `action` (`ctx.vectorSearch`) | não | ✅🌐 Fase 5b. Dev: fallback local explícito |
| `.aiSearchIndex()` | AI Search, via Items API ✅🌐 | `action`, híbrido BM25 + vetor | não | ✅🌐 Fase 5b. Instância por índice no namespace `default` (nenhum dos 100 namespaces), shard = pasta do item. Cobrança a partir de 2026-12-01. |
| do usuário | qualquer coisa | — | o que o plugin declarar | ✅ mecanismo provado |

- **Escrita em índices externos:** o outbox do shard publica numa Queue, um consumer indexa no Vectorize ou AI Search, e há reindex com backfill.
- **Embeddings:** modelo padrão definido pelo teste 🌐 11 (`bge-m3` vs `qwen3-embedding` vs `embeddinggemma` em pt-BR), configurável por índice.
- ✅ **Como ficou (Fase 5b)** — contrato em `docs/design/contracts.md` ("Índices externos"), E2E em `docs/spikes/remote/ai-indexes-e2e.md`:
  ```ts
  defineTable({ title: v.string(), body: v.string(), topic: v.string() })
    .vectorIndex("semantic", { embed: "body", filterFields: ["topic"] })            // Workers AI, bge-m3, 1024 dims
    .aiSearchIndex("hybrid", { fields: ["title", "body"], filterFields: ["topic"] })
  // numa action:
  await ctx.vectorSearch("notes", "semantic", { text: "esqueci a senha", limit: 5, filter: { topic: "atendimento" } }) // [{ _id, _score }]
  await ctx.aiSearch("notes", "hybrid", { query: "reembolso", mode: "vector" })                                     // [{ _id, _score, text }]
  ```
  - Outbox `_ember_ext_outbox` gravado **na transação da mutation** (só quando um campo do índice muda; coalesce por documento), Queue `EMBER_INDEXING` (≤50 documentos por mensagem), consumer que lê o estado **atual** do shard e confirma com `seq` sob um token de claim (reenvios podem sobrepor entregas; o ack cerca e reenfileira a entrega superada, então nunca fica um estado velho por último — contracts.md), retries com backoff, reenvio e estacionamento. Índice novo ou alterado = staged backfill pelo mesmo outbox.
  - **Modelo padrão: `@cf/baai/bge-m3`** (`docs/spikes/ai-embeddings/RESULTS.md`: MRR@10 0,967 em 30 pares pt-BR, empatado com embeddinggemma — beta e dependente de prompt —, qwen3 0,921, BM25 0,340). O mesmo modelo nas instâncias do AI Search.
  - Medido em produção: escrita → buscável em ~74 s (Vectorize), ~89 s (com embed) e ~96 s (AI Search) no primeiro lote de 30 (a fila entrega em 0,6–5 s; o resto é indexação dos serviços; update/delete ~210 s); via Ember o Vectorize + bge-m3 repete o MRR do teste (0,967). **AI Search híbrido (RRF) caiu para MRR 0,63–0,65 em pt-BR; só vetor dá 0,95** — o lado BM25 usa stemmer `porter` (inglês). Por isso `mode`/`fusion` por consulta; para pt-BR, `mode: "vector"`. ✅🌐 O AI Search não tem idioma/stemmer, só `keyword_tokenizer` `porter` | `trigram`: medido (`integrations-e2e.md` §5), trigram leva o híbrido de 0,681 a 0,717 e o vetor fica em 0,950 nos dois. Agora é por índice: `defaultMode: "vector"` (recomendado para pt-BR) e `keywordTokenizer: "trigram"` (se precisar de híbrido); nenhum dos dois reindexa pelo Ember.
  - `ember deploy` cria índices Vectorize (+ metadata indexes), instâncias AI Search (cache de similaridade desligado, `keyword_match_mode: "or"`), a fila e os bindings; dimensão/métrica/modelo no hash do nome (mudar = índice novo + backfill; o velho é apagado depois do deploy a 100%); `ember destroy` remove tudo do env.
  - **Dev:** sem emulação local. O `ember dev` liga o fallback local explícito (`EMBER_AI_INDEXES=local`): índice no SQLite do shard, vizinhos exatos por força bruta, BM25 no lugar do AI Search, embeddings por hashing sem Workers AI (não semântico). Sem a flag, binding ausente é erro.
  - Limites: Vectorize aceita até 50 k namespaces por índice; ✅ acima disso, `shardIsolation: "filter"` (shard no metadado indexado `_shard`, 9 filtros livres; trocar de modo = índice novo + staged backfill; `ember deploy` avisa a partir de 40 k shards do tipo no catálogo); AI Search tem 5 campos de filtro e 1 M arquivos por instância (500 k com híbrido); resultados são eventualmente consistentes e podem citar documentos já apagados.

---

## 7. Arquivos (R2)

Implementado ✅ (detalhes em `docs/design/contracts.md`, seção "Arquivos"; E2E real em `docs/spikes/remote/files-e2e.md`).

- `v.file()` guarda um `storageId` (`_storage_<ULID>`). A tabela de sistema `_files` de cada shard tem `{sha256, size, contentType, refcount, state (pending|ready|deleting|failed), key, createdAt}`.
- **Chaves e dedup por shard:** `f/<base64url(shard)>/<sha256>`. O conteúdo é endereçado por hash e deduplicado **dentro do shard**, não entre shards. Cada shard é dono do seu prefixo, então o refcount local é a verdade inteira e o GC não precisa de registro global nem de coordenação entre shards. O custo é guardar duas vezes o mesmo conteúdo enviado a shards diferentes.
- **Upload:**
  - `ctx.storage.generateUploadUrl({contentType?, size?, sha256?, multipart?})` roda dentro da mutation, que é síncrona. Por isso o SigV4 é JS puro e síncrono, conferido contra os vetores da AWS e contra o WebCrypto.
  - Com `sha256` conhecido, o ticket é um PUT presigned direto para `f/…/<sha>`, com checksum e tamanho assinados. Se o mesmo conteúdo já está pronto, volta `exists: true` e nada é enviado.
  - Sem `sha256`, ou em multipart, o upload vai para `t/<shard>/<id>`. A confirmação calcula o hash, copia para `f/<sha>` e apaga o temporário. Uma regra de lifecycle expira `t/` em 7 dias.
  - **Multipart:** create, URLs das partes e complete passam por `POST /api/storage/multipart`. No modo S3 são assinados no Worker; no modo proxy usam o binding. Partes de 10 MiB, iguais entre si (exigência do R2).
  - O presign só funciona em `*.r2.cloudflarestorage.com` 📄. Sem credenciais S3, o deploy cai no **modo proxy**: upload e download passam pelo Worker, o que funciona em domínio próprio e no `ember dev`.
- **Confirmação:**
  - Eventos `object-create` dos prefixos `f/` e `t/` vão para a Queue `ember-<project>-<env>-files`, e o consumer marca o arquivo `ready` ✅🌐 (1–4 s depois do PUT, medido).
  - Há também `POST /api/storage/confirm`, que o helper do cliente sempre chama. As duas vias são idempotentes.
- **Download:** `ctx.storage.getUrl()` em query ou mutation, depois da checagem de permissão do app. A assinatura usa um horário arredondado para janelas de 5 min, então o valor da query fica estável. Actions têm `ctx.storage.get/store/getUrl/generateUploadUrl/delete`.
- **Miniaturas:** `ctx.images.transform/info/thumbnail` sobre o Images binding. PNG para WebP testado de verdade 🌐; **HEIC também** ✅🌐 (R14: `info` reconhece `image/heic`, e HEIC → WebP/JPEG/AVIF funciona; foto de iPhone vai direto, sem fallback).
- **Coleta de lixo:**
  - O refcount muda **na mesma transação** de insert, patch, replace e delete dos documentos com campos `v.file()`.
  - Um arquivo com refcount 0 há mais de 24 h (configurável) é apagado pelo alarm do shard em duas fases: a linha vira `deleting`, o objeto é apagado do R2 se nenhuma outra linha viva usa a mesma chave, e então a linha some.
  - Upload pendente nunca referenciado também é coletado.
  - Uma linha em `deleting` não pode ser referenciada de novo. Um novo upload do mesmo conteúdo vai por `t/` para não correr contra o delete.
- **Limite do R2:** 1 escrita por segundo por chave 📄. Como a chave é o sha256, o conteúdo é imutável e o limite não pega.
- **`ember deploy`** (`resources.files`) cria e configura de forma idempotente:
  - o bucket `ember-<project>-<env>` com CORS e lifecycle;
  - a fila, o consumer e as notificações;
  - os secrets `EMBER_STORAGE_SECRET` e as credenciais S3, que vêm do ambiente (`EMBER_R2_ACCESS_KEY_ID` / `EMBER_R2_SECRET_ACCESS_KEY`), ficam as que já existem, ou saem de um API token criado com escopo no bucket, quando o token da Cloudflare permite (o OAuth do wrangler não permite).
- **Cliente:** `client.files.upload(blob | bytes, {shard, mutation})` usa só `fetch` (browser e RN), faz multipart acima de 32 MiB e chama `confirm`.
- **Offline:** o arquivo é baixado sob demanda e fica em cache (Expo FileSystem ou OPFS). A pré-carga é opcional e declarada.

---

## 8. Scheduler e crons

- `ctx.scheduler.runAfter(ms, fn, args)` e `runAt(date, ...)` gravam numa tabela `_jobs(run_at, fn, args, state, attempts)` **na mesma transação da mutation**, então são atômicos com ela ✅.
- O alarm do shard aponta para `min(run_at)`. O handler roda os jobs vencidos e reagenda o alarm ✅. Todo `setAlarm` sobrescreve o anterior ✅, então o engine sempre recalcula o mínimo.
- **Retries:** quem conta as tentativas é o engine, na tabela de jobs, com backoff próprio. Não dependemos dos 6 retries do alarm ✅. Escrita feita durante um alarm que falhou **não sofre rollback, nem em produção** (R5), então cada job roda dentro da sua própria `transactionSync` e o estado do job é gravado na mesma transação. Precisão medida do alarm: p50 2 ms, p95 15 ms. Alarm a 5 anos é aceito e persiste (R3), mas o encadeamento de 30 dias fica por robustez.
- **Jobs de mutation** rodam no DO. **Jobs de action** são enviados a uma Queue e executados no Worker, **sob um lease** ✅ (G2 do Brigade): a linha fica em `_jobs` (`dispatched`, depois `claimed` pelo consumer) até o consumer informar o resultado; se a Queue aceitar e travar (o Brigade viu 7 min em produção) ou o consumer morrer, o lease vence (`scheduler.actionLeaseMs`, padrão 5 min; por action `action({ leaseMs })`) e o próprio shard roda o job no alarm. As retentativas são do shard. `action({ dispatch: "shard" })` roda sempre no alarm, sem Queue.
- **Datas muito no futuro (anos):** o job fica guardado na tabela e o alarm é armado no máximo 30 dias à frente, com reagendamento em cadeia. Isso independe do limite real de prazo do alarm 🌐 3.
- **`crons.ts`:**
  - Um único Cron Trigger do sistema roda a cada minuto (o limite é 250 por conta e só em UTC 📄). R15 ✅🌐: um Worker aceitou 50 expressões (sem limite pequeno por Worker), segundos e `CRON_TZ=` são recusados, `L`/`#` aceitos; num Worker novo o primeiro disparo veio **~11 min** (666 s) depois de configurar; depois, 0,3–0,8 s após o `scheduledTime` (o `ember deploy` avisa no primeiro deploy). N crons do Ember custam 1 trigger da conta.
  - Ele acorda o DO `System`, que avalia as expressões com **fuso horário** (`America/Sao_Paulo`), aplica lock e roda cada cron como job.
- **Workflows:** usados só para processos de vários passos e longos, como o onboarding de domínio. Workflows dorme até 365 dias 📄. Ficam expostos como `ctx.workflows.start()` num componente.
  - ✅ **Decidido (§12):** o componente `workflows` roda sobre **este scheduler**, não sobre Cloudflare Workflows: começa atômico com a mutation (D6), passos de query/mutation rodam exatamente uma vez com o diário, `status` é uma query reativa no shard, funciona igual no `ember dev`/testes e não usa recurso da conta. `workflow.start(ctx, internal.x.flow, args)`; `step.runQuery/runMutation/runAction/sleep/sleepUntil/waitForEvent`. Comparação completa em contracts.md.
- **"Enviar email depois":** `scheduler.runAt(t, internal.email.send, {...})` enfileira o job, que no horário manda para uma Queue de envio com retry.

---

## 9. Auth (Better Auth first-party)

- ✅ **Revogação pelo servidor** (G8 do Brigade): o hook de fim de sessão de um app chama `revokeSockets(shard, { claim: "sid", value } | { subject })`; os sockets daquela sessão recebem `authExpired` na hora (ou fecham), e por 10 min o shard recusa um token emitido antes disso, no socket e no HTTP (contracts.md "Auth").

Provado no spike ✅:
- Adapter em SQLite de DO passa **460/460** testes da suíte oficial.
- Fluxos de ponta a ponta 10/10: email e senha, bearer, jwt/jwks, organization (convite e aceite), 2FA TOTP.
- Sign-up leva 36–49 ms, get-session 3–6 ms.
- O scrypt nativo custa ~36 ms de CPU, por isso exige o plano Workers Paid.

**Design:**
- `ember/auth.config.ts` exporta as opções do Better Auth com os plugins.
- O codegen chama `getAuthTables(options)` ✅ (testado com 12 plugins → 13 tabelas). Isso gera:
  - os tipos read-only `Doc<"auth:user">`;
  - a migração do DO `Auth`.
- O usuário não pode criar tabelas com os nomes reservados. Campos extras entram por `additionalFields`.
- O Better Auth roda **dentro do DO `Auth`**, porque cada fluxo faz de 5 a 15 consultas ao banco, todas locais. Isso também dá unicidade forte de email e de slug.
- **Hash de senha no Worker**, não no DO. Já está implementado e evita o teto de ~27 sign-ins/s que existe com um DO só 🌐 (precisa de teste de carga).
- **`ctx.auth`:** a ordem de verificação no Worker é:
  1. JWT curto, verificado em ~0,04 ms com as JWKS em cache;
  2. cookie de sessão assinado;
  3. consulta ao DO `Auth`.
- **TTL do JWT de 5 min.** Mutations marcadas como `sensitive: true` sempre consultam a sessão no DO, o que garante revogação imediata.
- Depois de sign-out, o socket recebe `authExpired` e o cliente renova o token.
- **Perfil do usuário no app:** hooks do Better Auth (`databaseHooks`) chamam `internal.users.sync` no shard de destino via outbox. ✅ Lacuna de crash fechada: triggers na tabela de usuário gravam um journal na mesma transação da escrita; o hook consome a linha junto com o outbox, e o alarm recupera (estado atual) as que ficaram órfãs depois de 60 s (contracts.md).
- **Rotação de chaves** ✅🌐: `ember keys rotate [--jwt | --files | --auth-secret --yes]`. JWT: chave nova no DO `Auth`, as antigas continuam publicadas no JWKS (sem logout). Secrets rotacionam por geração (`<NOME>_R<n>`: a mais nova assina, todas verificam), porque secrets de Worker não podem ser lidos. `--auth-secret` encerra as sessões por cookie.
- `secondaryStorage` não é usado. O rate limit fica no próprio SQLite do DO `Auth`.
- A versão minor do Better Auth fica fixada, porque o helper de índices é interno.
- Os demais plugins (passkey, magic-link, email-otp, api-key, admin, anonymous, social) só tiveram o schema validado. Precisam de teste de fluxo na Fase 2. O email do magic-link e do OTP sai pelo componente de email.

---

## 10. Clientes

- **`@freecorps/ember-client`:**
  - `SyncClient` com reconexão e backoff, heartbeat e uma conexão por shard (multiplexada depois).
  - Fila de mutations, com `PendingStorage` plugável.
  - Rebase otimista.
- **`@freecorps/ember-react`:** `useQuery`, `usePaginatedQuery`, `useMutation(...).withOptimisticUpdate`, `useAction`, `useConvexAuth`-like, todos sobre `useSyncExternalStore`.
  - ✅ `usePaginatedQuery` sobre `client.watchPaginatedQuery` (no `@freecorps/ember-client`, para React, React Native e quem mais quiser): páginas com fronteira fixa (`endCursor`, fixadas por `resume` sem novo download), divisão e fusão, lista que nunca encolhe numa troca de inscrição (contracts.md "Paginação").
- **`@freecorps/ember-react-query`:**
  - `emberQuery(api.x.y, args)` devolve `queryOptions`.
  - O `EmberQueryClient` abre e fecha a inscrição conforme a query ganha ou perde observadores (respeitando `gcTime`) e transforma cada patch em `setQueryData`.
  - `staleTime: Infinity`.
  - SSR: `prefetchQuery` com HTTP one-shot, hidratação e depois inscrição ao vivo.
  - Offline leve: `persistQueryClient` com `resumePausedMutations`.
- **Offline completo (opcional):** `StorageAdapter { load, applyPatch, runQueryLocally, persistPending }`.
  - `indexeddb`: cada índice vira um `IDBKeyRange` sobre a mesma chave codificada.
  - `expo-sqlite`: o mesmo DDL e o mesmo compilador SQL do servidor, com FTS5 incluído 📄.
  - `opfs`: SQLite-Wasm (o build oficial, não wa-sqlite: FTS5) num Worker, VFS `opfs-sahpool` ✅ 5c.
  - `tinybase`: para quem já usa TinyBase, como store reativo local ✅ 5c.
  - Queries rodam localmente pelo mesmo compilador, porque o cliente tem o manifesto do schema.
  - Recorte offline por função: `offline: { window: "90d" }`.
- ✅ **Como ficou (Fase 5a)** — pacote `@freecorps/ember-offline`, contrato em `docs/design/contracts.md` ("Offline"):
  ```ts
  import { indexedDbStorage } from "@freecorps/ember-offline/indexeddb";   // ou expoSqliteStorage (expo-sqlite)
  import schema from "../ember/schema";
  import { list, search } from "../ember/messages";                       // as mesmas definições query()

  const client = new EmberClient({
    url,
    storage: indexedDbStorage({
      name: "chat",
      schema,
      queries: { "messages:list": list, "messages:search": search },     // rodam no cliente
      sync: [{ query: api.messages.recent, args: { days: 90 } }],         // sempre inscritas: mantêm a réplica
    }),
    optimisticUpdates: { "messages:send": addMessage },                  // sobrevivem ao restart
  });
  ```
  - `StorageAdapter { load, persistPending, applyPatch, runQueryLocally, setIdentity?, sync? }` no cliente. Cold start sem rede: `useQuery` mostra o valor local (`snapshot.source: "local"`) ou o último do servidor (`"cache"`) até o primeiro `snap`.
  - **Execução local explícita:** só `query()` públicas registradas no cliente rodam lá, pelo mesmo `QueryImpl` do engine (o acesso ao armazenamento virou `QueryEnv.scan`/`pluginQuery`). `ctx.db.aggregate`, `ctx.db.sql` e `ctx.storage` → `OfflineUnsupported` (cai no cache).
  - **Réplica por posse:** os docs completos dos resultados das queries offline são replicados; uma linha some quando nenhum resultado guardado a contém mais. É sempre a união dos últimos resultados do servidor.
  - **Recorte (`window`):** é o range da query de `sync` (ex.: índice por data com `gt(now - 90d)`), mais `retentionMs` (padrão 30 dias sem atualização → sai) e `maxQueries` (500).
  - **Fila:** mutations offline ficam no armazenamento, voltam no restart com o update otimista registrado por nome, e são reenviadas com o mesmo `mid` (dedup no servidor) e o rebase de sempre.
  - `indexeddb`: um object store por tabela, um índice IndexedDB por índice db sobre `[shard, chave codificada]`; cada range do compilador é um `IDBKeyRange`. Reads assíncronos: miss → busca → reexecução. Busca via `jsSearch` (BM25 em JS).
  - `expo-sqlite` (peer opcional) e `sqlite` (qualquer `SqlDriver`): mesmo DDL e SQL do servidor, FTS5 `unicode61 remove_diacritics 2`; um banco por shard; testado em `node:sqlite` pela mesma interface.
  - Provado: `packages/offline/test/workerd/offline.workerd.test.ts` (Shard DO real no workerd + IndexedDB: inscreve, offline, recarrega, lista e busca locais, mutation offline com update otimista, recarrega, reconecta, converge, fila vazia) e o mesmo roteiro nos 4 backends em Node.
- ✅ **Como ficou (Fase 5c)** — o resto do offline, mesmo contrato ("Offline" em `contracts.md`):
  ```ts
  // OPFS: SQLite-Wasm (@sqlite.org/sqlite-wasm, FTS5) num Worker dedicado; as abas elegem quem abre os arquivos
  // ember-offline.worker.ts
  serveOpfsStorage({ name: "chat", schema, queries: { "messages:list": list, "messages:search": search }, sync });
  // página
  storage: opfsStorage({ worker: new Worker(new URL("./ember-offline.worker.ts", import.meta.url), { type: "module" }) })

  // TinyBase: a réplica no Store do app (uma tabela por tabela Ember), persistida pelo persister dele
  storage: tinybaseStorage({ store, persister, schema, queries })

  // IndexedDB (ou qualquer adapter) com várias abas: um líder escreve, as outras passam por ele
  storage: coordinateTabs({ name: "chat", open: () => indexedDbStorage({ name: "chat", schema, queries, sync }) })
  ```
  - `opfs`: o store inteiro roda no Worker (o `SqlDriver` é síncrono e access handles síncronos só existem em Workers), sobre o VFS `opfs-sahpool` (sem COOP/COEP); a página fala com ele por mensagens. `@sqlite.org/sqlite-wasm` em vez de wa-sqlite: FTS5 no build oficial, mantido pelo SQLite, e roda em Node (os cenários de todos os backends também rodam nele).
  - `tinybase`: `OfflineBackend` sobre o `Store` (não persister): o app lê as linhas com os hooks do TinyBase; escritas do app reexecutam as queries locais.
  - Resultados locais reativos: `watchQueryLocally` guarda o read set da execução local e reexecuta quando linhas replicadas mudam dentro dele (deste cliente, de outra aba, ou de fora no TinyBase), até o servidor responder.
  - Abas: Web Lock elege o líder, `BroadcastChannel` leva as chamadas (o mesmo protocolo página ⇄ Worker do OPFS); morte do líder → o próximo abre o armazenamento e os seguidores reenviam o que estava em voo. `clientId` e fila compartilhados (dedup do servidor).
  - Rowdiffs: docs replicados guardados como referência à linha, mudanças como `RowDiff` num log por registro (compactado quando passaria da base). 100 mudanças de 1 linha num resultado de 500: 170× menos bytes gravados (replicada), 75× (só cache).
  - Provado no Chromium real (playwright-core, `test/browser/`): OPFS em Worker e IndexedDB coordenado, duas abas, troca de líder, persistência.
  - ✅ **Mutations no cliente** (G5 do Brigade): `localOptimisticUpdates({ schema, mutations, queries })` (`@freecorps/ember-offline`) dá um update otimista por mutation, sem escrever um por query: a mutation do servidor roda (`runLocalMutation`, `@freecorps/ember-server`) sobre os documentos dos resultados carregados, e as queries registradas rodam de novo sobre o resultado. Só recebe valor otimista a query que a réplica reproduz (rodada antes da mutation, dá o valor confirmado), então projeções e contagens que a tela não cobre mantêm o valor do servidor. `ctx.random` semeado; ids locais trocados pelos do servidor na confirmação.
  - ✅ `_generated/offline.js` emitido pelo codegen (`schema`, queries e mutations públicas por nome): `optimisticUpdates: localOptimisticUpdates(offline)` dá um update otimista a toda mutation sem escrever nenhum.
  - Fica para depois: escritas offline mudando a réplica persistida (hoje a camada otimista vive na memória do cliente, por cima dos resultados carregados); `offline: {...}` declarado na função; cache de arquivos (§7); criptografia em repouso. (✅ feito: diffs para valores paginados `{page}`, com o `ValueDiff` da feature `vdiff`.)
- **Expo:**
  - Funciona no Expo Go e em builds EAS sem módulo nativo obrigatório.
  - Reconexão com `AppState` e NetInfo.
  - O sync em background no iOS é raro 📄, então novidades chegam **por push**.
  - EAS Submit para TestFlight, com `ascAppId` e chave da App Store Connect API no CI.
- ✅ **Push: como ficou** — contrato em `docs/design/contracts.md` ("Push direto e E2E"), guia em `packages/push/README.md`:
  - **Dois transportes, escolhidos por device** pelo registro: Expo Push (padrão, zero configuração) e **direto** — APNs HTTP/2 com token `.p8` (JWT ES256) e FCM HTTP v1 com conta de serviço (JWT RS256 → OAuth), saindo do próprio Worker (action ou componente `push`). Sem relay: o Ember é self-hosted por empresa. Segredos `APNS_KEY`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_TOPIC`, `FCM_SERVICE_ACCOUNT` no Worker.
  - **Modelado no Brigade:** comportamento do relay dele (reuso de 40 min do provider token, TTL 15 min/1 h/4 h por urgência, prioridade 5 só para `low`, `time-sensitive` para `high`, ambiente sandbox/production por device, poda em `Unregistered`/`BadDeviceToken`/`UNREGISTERED`, nunca em `SENDER_ID_MISMATCH`). O relay e o app móvel do Brigade são AGPL: o código de APNs/FCM/NSE/plugin foi escrito do zero a partir da documentação da Apple, do Google e da Expo; só o `packages/push` (MIT) — HPKE e formato do envelope — foi portado, com atribuição.
  - **Registro de devices:** `platform`, `token`, `provider`, `environment` (sandbox|production, vindo do build), `voipToken` (PushKit), `publicKey`. Tokens mortos podados pela resposta do transporte; ambiente descoberto (device sem ambiente: tenta o outro host depois de `BadDeviceToken`) é gravado.
  - **E2E opcional** (`encryption: "off" | "auto" | "required"`): HPKE (RFC 9180, P-256 + AES-128-GCM) para a chave pública que o aparelho publica no registro; Apple/Google veem só o envelope e um texto de fallback. iOS: Notification Service Extension (CryptoKit, iOS 17+) gerada pelo plugin `@freecorps/ember-expo-push`, chave compartilhada pelo App Group; Android: mensagem só de dados, aberta por uma tarefa em background (noble, JS puro). O app de email usa `required` (assunto e remetente nunca em claro).
  - Provado localmente: servidores falsos de APNs/FCM (assinaturas verificadas com WebCrypto), componente no workerd (envio por action e pelo alarm do shard), vetor RFC 9180 A.3.1, interop WebCrypto ⇄ noble ⇄ CryptoKit (Swift compilado no macOS), NSE gerado por `expo prebuild` e compilado com `xcodebuild`. Falta o aparelho real (R12).
  - Camada de token usável sozinha (G6/G7 do Brigade) ✅: `force` com o token recusado também no `fcmAccessToken`; `timeoutMs`/`signal` por envio (retentativas e token incluídos; o prazo de um chamador não corta a troca de token compartilhada); tickets de erro com o `reason` cru do provedor e o `httpStatus`.
  - Payload do próprio app (G1 do Brigade) ✅: `AddressedPushMessage.payload = { apns?, fcmData? }` vai como está, com o Ember cuidando de headers, token, retentativas e erros; hook `seal(device, message, provider)` em `PushTransports` e, para o componente, `setPushSeal(seal)` no módulo de entrada; `sound: { critical: true, name?, volume? }` para Critical Alerts.
  - Não feito: transporte via relay estilo Brigade (o payload do relay é específico do app Brigade); registro PushKit no cliente (o expo-notifications não tem PushKit: módulo nativo à parte; servidor e registro já aceitam `voipToken`). Segredos: `ember env set` (§11).

- ✅ **Runtime embutido num Worker existente** (G4 do Brigade): `createEmberWorker({ basePath: "/ember" })` monta todas as rotas sob o prefixo (`handles(request)` para o roteamento do hospedeiro, URLs de arquivo com o prefixo) e o contrato de bindings e variáveis está em contracts.md "Embutir o runtime".

---

## 11. CLI

Distribuído como `@freecorps/ember-cli` (binário `ember`, Node >= 22, sem flags experimentais): `npx @freecorps/ember-cli init`, depois `npm i -D @freecorps/ember-cli`. O pacote leva o dashboard pré-compilado (`dist/dashboard`: SPA + Worker) e não depende de `apps/dashboard`. O runtime que entra no Worker do usuário vem do `@freecorps/ember-runtime` instalado no projeto (ou da dependência do próprio CLI).

| Comando | O que faz |
|---|---|
| `ember init` | Cria `ember/` (schema, auth.config, crons) e `ember.json` (conta, nome, location hint) |
| `ember dev` | `getPlatformProxy`/Miniflare local 📄 com watch: codegen, bundle (esbuild), reload, logs. Vectorize/AI Search: fallback local explícito (`EMBER_AI_INDEXES=local`, §6). Secrets locais em `.dev.vars` (gitignored). ✅🌐 `--remote [--env dev]`: Workers AI, Vectorize, Browser Rendering e Images reais do env via remote bindings do wrangler (AI Search fica no fallback local: o proxy não o transporta) (opt-in; custo, latência e dados compartilhados em contracts.md) |
| `ember codegen` | Gera `_generated/{api,server,dataModel}` e o manifesto. **Os tipos de cliente são emitidos estaticamente:** a CLI usa a API do compilador TS para gerar os `.d.ts` de args e retorno, então o cliente não importa código do servidor (resolve a questão em aberto do spike) |
| `ember deploy` | Detalhado abaixo |
| `ember logs` | `wrangler tail` via API |
| `ember data` | Navega e edita os dados de um shard |
| `ember env` | ✅🌐 `list/set/get/rm [--env] [--var] [--reveal]`: secrets de Worker (vivos na hora, mantidos pelo deploy), vars no `ember.json`; valor nunca impresso sem `--reveal` (lido pela própria Worker, admin token) nem gravado em disco. Secrets Store avaliado e adiado (1 store e 100 secrets por conta no beta) |
| `ember shards ls/inspect` | Lista e inspeciona shards |
| `ember export/import` | NDJSON no R2 |
| `ember destroy --yes` | Apaga o env: Worker (dados dos DOs), índices Vectorize, instâncias AI Search, filas, bucket vazio ✅ |
| `ember restore --shard X --to <bookmark>` | Point-in-time recovery. Usa bookmarks que o engine grava a cada deploy, migração e hora; `getBookmarkForTime` é impreciso (R6). Restore por bookmark reverte de forma exata e é desfazível. ✅🌐 `--list`, `--mark <label>`, `--to <bookmark \| deploy:<versão> \| hora ISO \| -2h>` com confirmação/`--yes`, undo impresso, `--all --to deploy:<v>` (catálogo); ~1,1 s por shard; E2E em `docs/spikes/remote/ops-e2e.md` |
| `ember keys rotate` | ✅🌐 JWT (sem logout), secret de URLs de arquivos e secret do auth, por geração de secret |
| `ember run fn '{args}'` | Executa uma função |

**`ember deploy`:**
1. Faz o bundle e calcula o diff do schema contra o catálogo.
2. Classifica o plano de migração ✅:
   - campo opcional novo → nada a fazer;
   - escalar opcional novo → `ADD COLUMN`;
   - campo obrigatório ou mudança de tipo → recusado se houver dados (é preciso uma migração explícita);
   - índice novo → *staged*, com backfill em blocos de 500 linhas por alarm, ativado ao terminar.
3. Faz o upload multipart pela API de Workers com o mapa `exports` **completo** (R1). Sem wrangler: o token OAuth do wrangler ou um API token funciona. Mudança só de código usa versão com deploy gradual (R2: cada DO fica preso a uma versão). Mudança em `exports` sempre vai a 100%, num PUT do script (o gradual retorna erro `100405`; uma versão cujo binding aponta para a classe nova é recusada com `100406`).
4. Registra no D1 a nova versão de schema.
5. Cada shard aplica a migração com lock na primeira vez que acorda e reporta ao catálogo.
6. `ember deploy --wait` acompanha o progresso de todos os shards.

**Migração no cliente:** quando a versão de schema muda, o adaptador offline reaplica o DDL. Se a mudança for incompatível, ele faz reset e ressincroniza, preservando a fila de mutations pendentes, que é revalidada.
✅ Como ficou (Fase 5a): SQLite/expo-sqlite usam o planner do servidor (`prepareLocalDatabase`: migração compatível mantém a réplica; recusada → reset); IndexedDB, memória e TinyBase resetam a réplica em qualquer versão nova; OPFS usa o planner (é o backend SQLite). A fila sempre fica e a revalidação é a do servidor ao reenviar.

---

## 12. Componentes (estilo Convex)

`ember/ember.config.ts` → `app.use(component)`. Cada componente traz tabelas isoladas com namespace, funções próprias e configuração.
- Oficiais: `auth`, `files`, `push`, `rateLimit`, `workflows`.
- O `email` (`send`, `scheduled`, eventos, inbound) também é oficial; o produto de email (freecorps/mail) é um app que o instala.
- Isso dá ao serviço de email o mesmo mecanismo que um usuário usaria para empacotar features.
- ✅ **Como ficou** — contrato em `docs/design/contracts.md` ("Componentes"), E2E real em `docs/spikes/remote/components-e2e.md`:
  ```ts
  // ember/ember.config.ts
  export default defineApp()
    .use(rateLimit)                                                     // @freecorps/ember-rate-limit
    .use(workflows)                                                     // @freecorps/ember-workflows
    .use(pushComponent, { config: { receiptsDelayMs: 15 * MINUTE } }); // @freecorps/ember-push
  // ember/messages.ts
  import { components, mutation } from "./_generated/server";
  const limiter = new RateLimiter(components.rateLimit, { send: { kind: "token bucket", rate: 10, period: MINUTE, capacity: 3 } });
  export const send = mutation({ args: {...}, handler: (ctx, a) => {
    const { ok, retryAfter } = limiter.limit(ctx, "send", { key: me });   // síncrono, mesma transação
    ...
  }});
  ```
  - **Composição:** app + componentes viram um schema só (tabelas `<install>$<tabela>`, funções `@<install>/<módulo>:<fn>`, `manifest.components`). Migrações, staged indexes, agregados, índices externos, catálogo e reatividade funcionam sem código novo. As tabelas do componente ficam **no shard de quem chama**; apps sem componentes mantêm o mesmo hash de schema.
  - **Escopos:** `ctx.db` só vê as tabelas do próprio escopo (nomes lógicos; `ctx.db.sql` via CTEs). O app chama só funções públicas dos filhos diretos (`components.x.mod.fn`), por `ctx.runQuery/runMutation` — **síncronos dentro de queries e mutations, na mesma `transactionSync`** (savepoint por chamada) — e `ctx.runAction` em actions. Componentes chamam de volta o app por *function handles* (`createFunctionHandle`). Clientes nunca chamam funções de componente.
  - Componentes agendam jobs (nomes relativos ao escopo), expõem rotas HTTP (`httpRouter()`, montadas em `/<install>`; o Ember ganhou `ember/http.ts`) e pedem bindings ao deploy (Rate Limiting). Componentes aninham (`defineComponent(...).use(outro)`).
  - Codegen: `components` tipado em `_generated/server` (nome, args, visibilidade e retorno checados; `api.d.ts` do cliente continua sem imports).
  - Oficiais: `rateLimit` (token bucket e fixed window por chave, transacional; binding da Cloudflare opcional para actions/HTTP), `workflows` (diário + replay sobre o scheduler, ver §8), `push` (componente sobre os helpers existentes). `files` e `auth` continuam embutidos (decisão e motivo em contracts.md).
  - ✅ Ganchos (Fase 6): componentes declaram **crons** (`crons: (config) => cronJobs(...)`), **Queues próprias** (`queues: { events: { handler } }`: o deploy cria `ember-<project>-<env>-<install>-<nome>`, liga o producer e o consumer; o `queue()` entrega o lote ao componente) e o **`email()` do Worker** (`email: { match, handler }`); binding `send_email`. Contrato em contracts.md ("Componentes", ganchos).
  - Falta: passos paralelos em workflows.

---

## 13. Integrações Cloudflare nativas

| Serviço | No Ember |
|---|---|
| Email Service + Email Routing | componente `email`: `ctx.email.send`, handler `inbound`, eventos via Queue |
| Workers AI / AI Gateway | `ctx.ai` em actions, embeddings para os índices |
| Vectorize / AI Search | plugins de índice |
| R2 + Images | `files` e miniaturas |
| Queues | outbox, jobs de action, indexação externa |
| Workflows | componente `workflows` sobre o scheduler do shard (§8, §12); Cloudflare Workflows fica como backend futuro |
| Analytics Engine | métricas por função (latência, `rowsRead`/`rowsWritten`, erros) e o painel |
| D1 | catálogo global |
| Turnstile | ✅🌐 `auth.turnstile` no `ember.json`: plugin `captcha` do Better Auth verificado na Worker antes do hash; secret `TURNSTILE_SECRET_KEY` via `ember env` |
| Rate Limiting binding | `rateLimit`: limite exato no shard; binding opcional (`edgeLimit`, aproximado por local) provisionado pelo `ember deploy` |
| Secrets Store | `ember env` usa secrets de Worker por enquanto (Secrets Store: 1 store/100 secrets por conta no beta, `get()` assíncrono, sem acesso local) |
| Browser Rendering | ✅🌐 `ctx.browser.pdf/screenshot/content` em actions (quick actions do binding `EMBER_BROWSER`, `resources.browser`); `ctx.browser.binding` para o `@cloudflare/puppeteer` |

---

## 14. Observabilidade

- Toda execução registra no Analytics Engine: função, shard, duração, `rowsRead`/`rowsWritten` ✅ e status.
- ✅ Como ficou (Fase 4b): `EMBER_METRICS` (Analytics Engine, amostragem configurável, opcional) e consultas pela API SQL; ver contracts.md e `docs/spikes/remote/platform-e2e.md`.
- ✅ Durações (Fase 5b): em produção o relógio só anda com I/O, então SQLite síncrono no DO media 0. Agora toda duração é **tempo de parede** medido onde o relógio anda, com `blob9 = timing`: `rpc` (Worker em volta do RPC ao shard, para HTTP e chamadas de actions: hop + fila + execução + commit durável), `commit` (no DO, do recebimento do `mut` WebSocket/job até `storage.sync()`), `wall` (actions), `none` (reexecução de subscription: sem medida em produção). CPU por chamada não existe na plataforma (só por invocação, nos Workers Logs). Painel e `ember metrics` mostram p50/p95 por `timing`. Medido em produção: `docs/spikes/remote/ai-indexes-e2e.md`.
- O painel mostra:
  - p50/p95 por função;
  - queries caras (as que leem muito mais linhas do que devolvem, um sinal de índice faltando);
  - tamanho por shard;
  - crons e jobs;
  - deploys e migrações.

---

## 15. Limites e mitigações

| Limite | Mitigação |
|---|---|
| 10 GB por DO 📄 | shard explícito, blobs no R2, FTS com external content, compactação de logs, partições por tempo, alerta em 70% |
| ~1k req/s por DO 📄 | modelagem por shard, cache de query, projeções. Shard global desaconselhado |
| 100 bind params ✅ | `json_each(?)` |
| 100 KB por statement ✅ | lotes no compilador |
| 100 colunas por tabela ✅ | o excedente vai para o `_json` |
| `STORED` generated column não entra via `ALTER` ✅ | o engine usa `VIRTUAL` ou faz rebuild de tabela |
| Alarm: 1 por DO, 6 retries ✅ | scheduler multiplexado com retries próprios |
| Anexo de WebSocket de 16 KB ✅ | estado mínimo no anexo, o resto no SQL |
| Fan-out: 10k sockets num DO ok, mas broadcast para 10k leva ~1 s no DO e ~2,5 s até o último cliente (R4) | meta de ≤5k inscritos por shard para patch em menos de 1 s; acima disso, fan-out em DOs de broadcast |
| Escrita durável `storage.sync()` p50 22–34 ms (X2) | group commit amortiza esse custo |
| scrypt ~96 ms de CPU em produção (R7) | hash no Worker **antes** da transação do Better Auth; parâmetros de custo configuráveis |
| Sem PITR local ✅ | ✅🌐 `ember restore` com bookmarks próprios (deploy, migração, hora, manual); local → 501 `pitr_unavailable` |
| Shard quente: ~0,3 ms de runtime por mutation (bench B2) | group commit (97 por commit com 600 em voo → 1,5k/s); vazão vem de espalhar em shards (23k/s em 32). Otimizar o caminho por mutation é o próximo passo |
| Worker cliente: 6 conexões de saída abertas por invocação, WebSockets inclusos (bench) | actions/agentes que abrem WebSockets para shards seguram 6 por vez |
| CPU por requisição | backfill em blocos, limites por transação |

---

## 16. Email (primeiro cliente)

O Ember entrega as **peças** de email; o **produto** (API HTTP estilo Resend com chaves, inbox web, app móvel, SDK
HTTP tipado) mora em [freecorps/mail](https://github.com/freecorps/mail), que depende do Ember pelo npm.

- **No Ember** — contrato em contracts.md ("Email"):
  - **`@freecorps/ember-email`** (componente): `send` atômico com a mutation (idempotência, supressões e `rateLimit` por projeto, `sendAt`), entrega por action com claim (sem reenvio duplicado), retries e fallback de headers; templates guardados (motor `{{}}` próprio + layout responsivo; React Email fica opcional, renderizado numa action); eventos do Email Service pela Queue do componente (dedup por `eventId`, status só avança, bounce/complaint → supressão); inbound pelo gancho `email()` (postal-mime, `.eml` e anexos no `files`, DKIM/DMARC/SPF do `Authentication-Results` do MX da Cloudflare, threads por token/References/assunto, spam por remetente, auto-resposta sem loop, gancho `onInbound` na mesma transação); mailboxes e inbox reativa (`threads`, `unread` por agregado, `search` por `searchIndex`, `reply`, `compose`, `assign`, `markRead`/`markUnread`, `recent` para réplicas offline).
  - **`@freecorps/ember-email/cloudflare`**: onboarding de domínio pela API da Cloudflare, sem produto em volta: envio (Email Sending), recebimento (Email Routing verificado; subdomínio de roteamento só quando pedido), uma regra literal por mailbox → Worker, assinatura de eventos → fila do componente, e remoção do que criou. Roda no Worker ou na máquina do operador.
  - **`@freecorps/ember-email/schema`**: só as tabelas, para clientes offline montarem a réplica local.
  - **`examples/email-lite`**: o menor app sobre o componente (mailboxes, envio, inbound); é o que o E2E (`docs/spikes/remote/scripts/email-e2e.ts`) publica.
- Mudou em relação ao resumo original: DKIM/DMARC vêm do cabeçalho do MX da Cloudflare (sem DNS-over-HTTPS); tudo num shard (`global:main`), não um shard `mailbox` por caixa; webhooks, pixel/links, inbox web e app móvel são do produto (freecorps/mail).
- ✅ **Provado em produção (2026-11-05):** um deploy do componente na conta da FreeCorps recebe em `support@` e `privacy@atendimento.freecorps.com.br` (subdomínio de roteamento, sem tocar o MX do apex). Medido: inbound em 1,7–3,7 s; eventos `delivered` em 3,1–7,6 s até o shard; resposta pela inbox entrou na thread original; 0 duplicatas. R11 (bounces/deferred) em `docs/spikes/remote/email-e2e.md`.

---

## 17. Fases

| Fase | Entrega | Critério de pronto |
|---|---|---|
| **0. Repo + remotos** | monorepo, CI, rodar os testes 🌐 da seção 18 | todos os 🌐 respondidos e o plano revisado |
| **1. Núcleo** | `values` (encoding de chave), `server`, `runtime` Shard, compilador SQL, read-sets com árvore de intervalos, protocolo, `client`, `react`, CLI `dev`/`codegen`/`deploy` | app de exemplo (chat) rodando, fuzz de reatividade e migrações básicas. ✅ `examples/chat`: salas e mensagens, `useQuery`, envio otimista, histórico paginado e busca (`ember dev` + Vite; testes no workerd com o `EmberClient`) |
| **2. Auth + scheduler + files** | Better Auth com os plugins testados em fluxo, `ctx.auth`, `_jobs`, crons com fuso, R2 com presign e GC | exemplo com login, upload e job agendado. ✅ `examples/files-auth-jobs`: Better Auth + `ctx.auth`, upload para o R2 com URL pré-assinada, job agendado e cron que processam o arquivo e atualizam o documento em tempo real (testes no workerd com o DO `Auth` de verdade) |
| **3. Busca + React Query + Expo** | `searchIndex`, `react-query`, `react-native`, push | exemplo mobile no TestFlight. ⏳ falta o TestFlight: `apps/example-expo` roda (Expo Go e build de desenvolvimento) e tem `eas.json`, mas o projeto EAS, o app no App Store Connect e as credenciais da Apple dependem do dono |
| **4. Escala** | projeções, partições, catálogo D1, staged indexes, painel, Analytics Engine | benchmark de carga em vários shards. ✅ `docs/spikes/remote/bench.md`: 23,2k mutations/s em 32 shards (linear; ~0,8k/s por shard, ack p50 59 ms), 11,7k ciclos de query/s, fan-out para 430 inscritos com p99 91 ms, 0 erros |
| **5. Offline + IA** ✅ | adaptadores IndexedDB/expo-sqlite/OPFS/TinyBase, `vectorIndex`, `aiSearchIndex` | exemplo offline com busca local. ✅ `examples/todo` (fila offline em IndexedDB, queries locais, edições otimistas que sobrevivem a recarregar). ✅ 5a: `@freecorps/ember-offline` (memory, IndexedDB, SQLite/expo-sqlite com FTS5), execução local pelo mesmo compilador, cenário offline E2E no workerd. ✅ 5b: `vectorIndex` (Vectorize) e `aiSearchIndex` (AI Search) por outbox → Queue → consumer, `ctx.vectorSearch`/`ctx.aiSearch` tipados, provisionamento e `ember destroy`, fallback local, modelo padrão bge-m3 (teste 11), durações reais nas métricas; E2E real em `docs/spikes/remote/ai-indexes-e2e.md`. ✅ 5c: OPFS (SQLite-Wasm em Worker) e TinyBase, resultados locais reativos, coordenação entre abas (Web Locks + BroadcastChannel), rowdiffs persistidos; provado no Chromium real. **Fase 5 concluída.** |
| **6. Email** ✅ | peças de email no Ember: componente `email`, onboarding de domínio (`@freecorps/ember-email/cloudflare`), `examples/email-lite` | o componente envia e recebe em produção. ✅ Ganchos de componente (crons, Queues, `email()`), `@freecorps/ember-email` (+ `/cloudflare`, `/schema`); R11 medido na conta; em 2026-11-05 recebendo em `support@`/`privacy@atendimento.freecorps.com.br` (inbound 1,7–3,7 s, `delivered` 3,1–7,6 s, resposta na thread, 0 duplicatas). O produto (API estilo Resend, inbox web, app móvel, SDK) segue em [freecorps/mail](https://github.com/freecorps/mail) |
| **7. Brigade** | migração ([RFC 0016 do Brigade](https://github.com/freecorps/brigade/blob/main/docs/rfcs/0016-ember.md)): transporte de push do Ember primeiro, depois o shard `workspace`, clientes, monitoramento e corte por workspace | ✅ passos 1–3, 6 e 7: relay e envio direto da API sobre o transporte do Ember (provados em aparelho em `dev`), o shard `workspace` com mutations, queries, eventos e páginas, monitoramento, status e Slack, e a troca de todo workspace de `dev` e da produção em 2026-11-08 (cópia conferida, sem divergência). Clientes antigos falam pelo adaptador do Brigade Sync no shard. Lacunas pedidas ao Ember (clean-room) G1–G8 entregues na 0.3.0 e G9 (tabelas SQL privadas) na 0.4.0. ⏳ falta: dashboard e app nos clientes do Ember (passos 4–5), o Brigade adotar G1–G8 no lugar das soluções provisórias e apagar o `WorkspaceDO` depois de alguns dias no Ember (passo 8) |

---

## 18. Testes remotos (precisam de autorização para rodar na conta FreeCorps)

Todos rodam num Worker descartável `ember-spike-*`, que é apagado no fim.

| # | Teste | Decide |
|---|---|---|
| R1 | Upload pela API com `exports` vs `migrations` e binding de DO no mesmo upload | pipeline de deploy da CLI |
| R2 | Versão só de código com DO inalterado e deploy gradual | `ember deploy` sem downtime |
| R3 | Alarm a 5 anos e precisão de alarm de 60 s | limite real do scheduler |
| R4 | N WebSockets por DO (1k → 32k) e broadcast | limite de inscrições por shard |
| R5 | Limite de 2 MB por linha, se a produção bloqueia os mesmos PRAGMAs e funções, e rollback de escrita em alarm que falhou | limites do runtime |
| R6 | PITR: bookmark e restore | `ember restore`. ✅🌐 implementado e testado de ponta a ponta (`ops-e2e.md` §1) |
| R7 | Carga de sign-in com hash no Worker vs no DO | design de auth |
| R8 | Latência real São Paulo → DO `sam`: query, mutation e fan-out | números de performance |
| R9 | Vectorize e AI Search com `remote: true`, upload e consulta pt-BR | plugins de IA. ✅ `ai-indexes-e2e.md`; ✅ `ember dev --remote` (`integrations-e2e.md`) |
| R10 | Embeddings pt-BR (dimensões e MRR@10) | modelo padrão. ✅ bge-m3 (`docs/spikes/ai-embeddings/RESULTS.md`) |
| R11 | Fila de eventos do Email Service (latência, duplicatas, ordem) | componente de email. ✅ `email-e2e.md`: assinatura `email.sending` → fila do componente; 12 eventos reais (`bounced` hard em ~2 s, `deferred` em +1/+18/+78 s), fila 1,0–4,6 s (p50 2,9 s) do evento ao shard, 0 duplicatas, ordem mantida por email; dedup por `eventId` e status só-avança mantidos (sem garantia documentada). Domínio de envio novo aceita envio ~1–2 min depois do onboarding |
| R12 | APNs HTTP/2 a partir do Worker | push direto vs Expo Push. ✅🌐 parcial (`ops-e2e.md` §4): `fetch` do Worker fala HTTP/2 com `api.push.apple.com` e sandbox (403 `InvalidProviderToken` com `apns-id` para um JWT falso), e o JWT ES256 é assinado com WebCrypto puro. ✅🌐 **camada de token com credenciais reais** (Brigade RFC 0016, 2026-11-06): `apnsProviderToken` com o `.p8` real e `fcmAccessToken` com a conta de serviço real, de dois Workers (relay e consumer de fila da API), entregando em iPhone real bloqueado, iOS Simulator e emulador Android; 26 envios seguidos reusando o token, 0 `TooManyProviderTokenUpdates`. Falta: o envelope `ember` e a NSE do `ember-expo-push` num aparelho, `sendApns`/`sendFcm`/componente `push`, envio do alarm do Shard DO, regras de topic e poda. Expo Push também alcançável do Worker. |
| R13 | Multipart presigned de 300 MB a partir do RN | `files`: multipart presigned de 60 MiB validado em produção, assim como checksum e tamanho assinados, CORS e eventos (`files-e2e.md`). Falta RN num aparelho. |
| R14 | HEIC no Images binding | miniaturas. ✅🌐 suportado: HEIC 1200² → WebP 399 ms (1ª), JPEG 75 ms, AVIF 130 ms; `info` = `image/heic` (`ops-e2e.md` §5). Sem fallback. |
| R15 | Limites de cron por Worker/conta | `crons.ts`. ✅🌐 50 expressões aceitas num Worker (limite é o da conta, 250); só 5 campos e UTC (`CRON_TZ`/segundos recusados), `L`/`#` aceitos, duplicata recusada; primeiro disparo ~11 min depois de configurar num Worker novo, depois 0,3–0,8 s de atraso. Ember usa 1 trigger por env e avalia fuso no System DO (`ops-e2e.md` §6). |
| R16 | Custo por linha escrita (US$ 1 por milhão no SQLite do DO) | marginal de escrita vs Convex (US$ 2/M chamadas). ✅ medido no runtime (`cursor.rowsWritten`, o contador cobrado; `rows-written.md`): insert via WebSocket numa tabela sem índice de usuário **8 → 5 linhas** (HTTP 6 → 4), +1 por índice; subscription 2 → 0 linhas (anexo do socket + feature `ident`); job agendado 6 → 4. Dedup em tabelas de geração (`DROP TABLE` é grátis), change log em anel (1 upsert por commit), `_jobs.dedup_key` com índice parcial. Restam por insert: linha + índice único de `_id` + índice de `_creationTime` (engine; seguimento). Não confirmado no analytics da Cloudflare (limite de orçamento da API no PR #14). |

R1–R8 bloqueiam a Fase 1. R9–R15 podem rodar antes das fases que dependem deles.

**R12 — push direto (estado):** o transporte direto existe (§10, `packages/push/README.md`). **Provado em aparelho via Brigade (2026-11-06, [RFC 0016 "Result"](https://github.com/freecorps/brigade/blob/main/docs/rfcs/0016-ember.md#real-device-check)):** o relay e a API do Brigade em `dev` usam `apnsProviderToken`/`fcmAccessToken` do `@freecorps/ember-push` 0.2.0 com o `.p8` e a conta de serviço reais, em volta do payload e do envelope do próprio Brigade. Resultado: iPhone 15 Pro Max (iOS 27.2) bloqueado tocou (CallKit, VoIP) e mostrou o alerta decifrado pela NSE do Brigade; Simulator e emulador Android (FCM, app em primeiro plano, em background e fechado) receberam; todo `APNs response` 200 com `signer: ember`, todo `FCM response` 200; 12 páginas em um minuto (26 envios) reusaram o token sem `TooManyProviderTokenUpdates` nem `ExpiredProviderToken`; com o Key ID errado de propósito, o fallback do Brigade entregou. Isso fecha `.p8` real, entrega e reuso do token. Os itens abaixo continuam para o caminho **do próprio Ember** (envelope `ember`, NSE do `ember-expo-push`, componente `push`). Evidências anteriores: o `fetch` de um Worker publicado fala HTTP/2 com o APNs (`ops-e2e.md` §4) e o Brigade, também da FreeCorps, entrega em produção por um Worker com o mesmo desenho (spike S1 dele: Simulator e iPhone real, bloqueado, com a NSE decifrando); o workerd local não fala HTTP/2, então `ember dev` não alcança o APNs (FCM sim). Falta, com credenciais e aparelho (o usuário vai testar com o app de email):
- **Apple:** Team ID; chave APNs `.p8` + Key ID (Keys → APNs; serve sandbox e produção); bundle id com Push Notifications, App Groups (`group.<bundle>.ember`) e Time Sensitive Notifications; App ID da extensão `<bundle>.EmberNotificationService` com o mesmo App Group (o EAS cria e sincroniza a partir do `appExtensions` que o plugin declara).
- **Google:** projeto Firebase com o app Android (package name) e o `google-services.json` (fora do repositório); conta de serviço com `roles/firebasecloudmessaging.admin`, API FCM v1 ativa, chave JSON → `FCM_SERVICE_ACCOUNT`.
**Provado pelo caminho do próprio Ember (2026-11-09, app de email `freecorps/mail`, build 5 no TestFlight):** a API do mail em produção (Ember 0.5.1) tem `pushComponent` com `encryption: "required"`, e o app registra o token nativo com a chave do aparelho (`ensurePushKey`, `registerForPush({ kind: "device" })`). Um email externo para `support@` disparou o `support:onInbound`. Esse hook é do componente `email`, roda na transação que arquiva a mensagem e chama `push.send`, então a entrega saiu do Shard DO. O iPhone bloqueado mostrou o remetente e o assunto reais, abertos pela NSE do `ember-expo-push`; a Apple viu só o envelope e o fallback. Isso fecha o envelope `ember`, a NSE, o componente `push` e o envio a partir do shard com o `.p8` real. Achados no caminho, corrigidos e publicados:
- o plugin não carregava no `eas-cli` (0.5.1, #37);
- o deploy de uma classe nova num Worker vivo dava `100406` (0.5.2, #39);
- com só a chave de API, o EAS não cria o App Group nem liga Time Sensitive (documentado em `packages/push/README.md`).
- **Ainda falta verificar:** Android em primeiro plano, em background e com o app fechado (tarefa headless); poda real (`Unregistered` após desinstalar, `BadDeviceToken` com ambiente errado); banner Time Sensitive; `collapseId`; envio por `sendNow` (Worker), já que o `push.send` a partir do shard está provado; nenhum `TooManyProviderTokenUpdates` em muitos envios; latência até o aparelho.

---

## 19. Como ganhar do Convex (sem contar a latência por região)

A única coisa que não vamos igualar é uma **transação serializável global entre shards**. Para isso oferecemos outbox e sagas, e quem precisar de verdade usa um shard único.

| Área | Onde o Convex ganha hoje | Como o Ember vira o jogo | Fase |
|---|---|---|---|
| Vazão de escrita num shard quente | OCC paralelo | **Group commit:** várias mutations numa `transactionSync` e uma única confirmação de durabilidade (X1 mede o ganho; bench B2 no runtime completo: 11 → 97 mutations por commit e 660 → 1.479/s ao subir de 60 para 600 em voo; em vários shards, 23k/s em 32). `ctx.db.increment` ✅ (açúcar: o engine lê e escreve) e contador shardeado como componente (futuro). Tabelas append-only vão para Analytics Engine, Queue ou R2. | 1 / 4 |
| Consultas globais | banco único | **Views materializadas nativas**: `.aggregate(name, {by, count, sum, min, max})` ✅ mantido na transação de escrita, leitura O(1) por grupo, reativo por grupo, backfill staged; `defineView` ainda não. Projeções por outbox. Índice global secundário (DO ou D1). Fan-out paralelo por RPC. | 4 |
| Recursos de índice | — | Índices parciais, de expressão e sobre colunas geradas. FTS com várias colunas e peso, trigram, sem acento, snippet e highlight, paginação sem teto. Busca híbrida via plugin. | 1 / 3 |
| Consultas analíticas | não existem | `ctx.db.sql` ✅ tipado (validador de linha) e somente leitura (tokenizer + allowlist, parâmetros só por template), com JOIN, GROUP BY e agregações dentro do shard. A reatividade é por tabela: qualquer escrita numa tabela lida reexecuta a consulta. | 4 |
| Banda e tempo de patch | resultado inteiro | **Patches por linha** ✅ (feature `rowdiff` do protocolo v1.1; ~400× menos bytes numa lista de 500 docs com 1 mudança; feature `vdiff` para listas dentro de objetos, como `paginate()`), protocolo binário (msgpack), cache de resultado compartilhado no DO, statements preparados. | 1 / 4 |
| Primeira requisição | backend sempre quente | **Pré-aquecimento** do shard em paralelo ao handshake de auth. Schema verificado uma vez por isolate. Plano de consulta fixo, sem planner. ✅🌐 o cliente abre o socket durante o fetch do token e manda as inscrições junto com o `hello`: primeiro snapshot de um cliente novo em shard frio p50 **1.384 → 944 ms** (−32%), quente 1.171 → 839 ms; a penalidade do shard frio cai de 213 para 105 ms (`ops-e2e.md` §2). | 1 |
| Previsibilidade | limites de transação | Mesmos limites (linhas lidas e escritas, CPU), mais **isolamento por shard**, então um vizinho barulhento não afeta os outros. | 1 |
| Offline-first | — | Adaptadores first-party: IndexedDB ✅ e expo-sqlite com FTS5 ✅ (mesmo compilador de query no cliente), OPFS e TinyBase depois. | 5 |
| Operação | backups pagos | PITR de 30 dias por shard (`ember restore`), preview por branch, jurisdição de dados por shard, dev no mesmo runtime (`workerd`). ✅🌐 `ember restore` (bookmarks por deploy/migração/hora/manual, undo, `--all --to deploy:<v>`; ~1,1 s por shard), `ember keys rotate`. | 4 |
| Actions | uma região | Actions na borda e Smart Placement perto das APIs externas. Serviços Cloudflare nativos no `ctx`. | 2 |
| Custo | por chamada de função | Roda na conta do usuário, com o preço do DO, do R2 (sem taxa de saída) e do Workers. Linhas escritas medidas por operação (`rows-written.md`, R16): insert via WebSocket ~5 linhas (~US$ 5/M, +US$ 1/M por índice), subscription e fan-out sem escrita. Para chegar perto dos US$ 2/M do Convex falta tirar os índices de `_id`/`_creationTime` do engine. | — |

Os números medidos (R1–R8, X1, X2) ficam em `docs/spikes/remote/RESULTS.md`, que entra quando os testes remotos terminarem.

**Medido contra o Convex (2026-11-05, [`docs/spikes/remote/convex-vs-ember.md`](spikes/remote/convex-vs-ember.md)).** Mesmo app e mesmo harness, clientes oficiais, laptop em Campinas; Convex Pro em aws-us-east-1, Ember com DOs em MIA/EWR/IAD.

| Carga | Convex | Ember |
|---|---|---|
| Contador quente, 600 em voo | 38/s do laptop (p99 42 s, reconexões por OCC); 18/s dentro da região (97% de falhas OCC) | **1.454/s** (p99 592 ms), sem conflito |
| Inserts espalhados | ~5,2k/s dentro da região (teto de 256 mutations concorrentes); 410–790/s do laptop | **23k/s** em 32 shards (`bench.md`); 1,1–4,5k/s do laptop |
| Fan-out para 430 inscritos | p50 587 ms; 66% dos estados intermediários entregues | **p50 208 ms; 100%** |
| Bytes por atualização | 476 | **255** |
| Query indexada ou paginada do Brasil | **p50 155–168 ms, cauda menor** | p50 162–230 ms |
| Custo marginal de escrita | **US$ 2 por milhão** | US$ 5–6 por milhão no bench, com 1 índice (6 linhas por insert via WS, 5 via HTTP; sem índice do usuário, 5 e 4), medido depois do PR #15; era ~US$ 10 |

- **O Ember ganha onde este §19 apostava:** shard quente, escala, fan-out e banda.
- **O Ember perde ou empata em três pontos:**
  - **Latência de query.** Empata no p50; o Convex tem cauda menor. (Depois do PR #15 a `query` pelo socket não escreve mais em `_ember_subs`; falta medir de novo.)
  - **Custo por escrita.** Depois do PR #15 (sem índice da dedup, inscrições sem escrita), o que resta é o documento, os índices do engine e a linha de dedup; tirar os índices do engine exige mudar o formato de id.
  - **Região.** O hint `sam` não pegou, e hoje não há DO na América do Sul.

---

## 20. Resultados remotos (R1–R8, X1, X2): o que mudou

Detalhes em `docs/spikes/remote/RESULTS.md`. Todos os recursos `ember-spike-*` foram apagados.

- **Group commit vira padrão da Fase 1.** Um DO aguenta ~1,1–2,2k mutations/s quando cada mensagem é uma mutation (~166 µs de CPU cada). Juntando 10 por `transactionSync`, passa para 6,7–10,5k/s; juntando 100, chega a **32,5k/s** (17–20 µs por mutation). O runtime drena a fila de mensagens a cada volta e confirma tudo junto, mas o resultado de cada mutation continua isolado: uma falha vira savepoint e só aquela é desfeita.
- **A tese de latência caiu para o Brasil.** Hoje os DOs não ficam na América do Sul, então a latência é parecida com a do Convex em us-east. O ganho do Ember fica em vazão, recursos de índice e consulta, banda, custo e operação (seção 19). Isso precisa ser medido de novo quando a Cloudflare abrir DOs na região, e também a partir de um domínio próprio em vez de workers.dev (o tráfego do workers.dev foi atendido em Miami).
- **Acordar o DO depois de ~75 s parado custa 56–60 ms** (contra 3–8 ms quente). ✅ Pré-aquecimento feito: o socket abre durante o fetch do token e as inscrições vão com o `hello` (primeiro snapshot frio p50 1.384 → 944 ms).
- **Benchmark multi-shard (Fase 4, `bench.md`)**, gerado de dentro da Cloudflare (agentes DO em IAD/EWR): 23,2k mutations/s em 32 shards (5,7k em 8: escala linear, ~0,8k/s por shard, ack p50 59 ms / p99 152 ms); um shard quente chega a 1,5k/s com 97 mutations por commit (CPU do runtime ~0,3 ms por mutation, contra 20 µs de SQL no X1: próximo alvo de otimização); 11,7k ciclos `sub→snap`/s (p50 46 ms); fan-out a 430 inscritos sem perda, p50 61 / p99 91 ms.
- **Auth:** sign-up é a parte cara (10/s com hash no DO). Com hash no Worker o sign-in vai a 39/s. Sign-up exige mudar o fluxo para fazer o hash antes de abrir a transação. Para cadastros em massa, o sign-up pode ser shardeado por domínio de email.

---

## 21. Modelo de projeto e convivência na mesma conta

**Onde as coisas ficam**
- O "control plane" é a **conta Cloudflare do usuário**. Não existe servidor central do Ember. A CLI fala direto com a API da Cloudflare.
- O **Ember Dashboard** (`apps/dashboard`) é um Worker que o `ember deploy` sobe **na própria conta**, numa URL do usuário. Funciona como o painel do Convex, mas self-hosted: lista os projetos da conta, mostra dados, logs, funções, crons, tamanho por shard, deploys e migrações.
- O painel da Cloudflare continua mostrando os recursos crus (Workers, DOs, R2...).

**Projeto e ambientes**
- `ember.json`: `{ account, project, environments }`.
- Cada projeto e ambiente vira recursos com prefixo `ember-<project>-<env>`:
  - um Worker com as classes `Shard`, `Auth` e `System`;
  - R2, D1 (catálogo) e Queues próprios.
- Ambientes `prod`, `dev` e `preview-<branch>` ficam isolados. Uma conta pode ter N projetos.
- O domínio é opcional. Padrão é workers.dev; `ember domains add` adiciona domínio custom ou rota.

**Registro da conta** (D1 `ember-registry`, criado no primeiro `ember init`)
- Guarda projetos, ambientes, domínios, rotas e endereços de email.
- Recusa duplicatas de nome de projeto, rota ou domínio, e de endereço de email inbound.
- É a fonte do Ember Dashboard.

✅ Como ficou (Fase 4b): o registro é criado pelo primeiro `ember deploy` (ou `ember dashboard deploy`); dono do nome = `fingerprint` no `ember.json`; os shards reportam ao catálogo pelo binding D1 `EMBER_REGISTRY`; `ember projects ls`, `ember domains add`, `ember logs`, `ember metrics`, `ember dashboard deploy` (Worker `ember-dashboard`, Access ou token). Evidência: `docs/spikes/remote/platform-e2e.md`. `ember dashboard deploy --access --access-email <e>` cria (ou reusa) a aplicação Access self-hosted do host do painel com política de allow e liga `ACCESS_AUD`/`ACCESS_TEAM_DOMAIN` (precisa de uma organização Zero Trust; o time vem de `/access/organizations` ou `--access-team`). Não testado ao vivo: a conta não tem organização Zero Trust legível pelo token OAuth.

**Regras de convivência**
- Domínios: um subdomínio por projeto. `ember domains add` verifica as rotas e custom domains já usados na zona.
- Auth:
  - Cada projeto tem seu DO `Auth`.
  - `cookiePrefix` = nome do projeto, com o cookie no escopo do subdomínio.
  - Para SSO, é opcional: `auth: { from: "<projeto>" }` valida o JWT pelo JWKS do projeto de identidade. ✅ `from` aceita a URL ou o nome (`"<projeto>"`/`"<projeto>/<env>"`): o `ember deploy` resolve pelo registro e grava `auth_links`.
- Email Routing: as regras são por endereço. O catch-all fica reservado ao serviço de email, e os outros projetos recebem via SDK ou webhook dele.
- Reputação de envio é por conta, então todo envio passa pelo serviço de email, com supressão e rate limit por projeto. Para isolamento total, use uma conta separada: o `ember.json` aceita conta por projeto.
- Limites por conta (crons 250, classes de DO 500, Workers, AI Search 100 namespaces): o `ember deploy` mostra o consumo e avisa antes de estourar.
- API da Cloudflare: retry com backoff na CLI.

**Futuro opcional: Ember Cloud**
- Mesmo runtime hospedado via Workers for Platforms, com um dispatch namespace na conta da FreeCorps.
- `ember login` aponta para a nossa API em vez do token Cloudflare.
- Nada no desenho atual impede esse caminho.
