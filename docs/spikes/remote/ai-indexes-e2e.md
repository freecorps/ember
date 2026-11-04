# Índices externos E2E na produção da Cloudflare (PLAN §6, §13, §14 — Fase 5b)

Rodado em 2026-11-04, entre ~22:30 e ~23:50 UTC, na conta FreeCorps (`<ACCOUNT_ID>`). Só recursos `ember-spike-*`
foram criados; todos foram apagados no fim (ver Limpeza).

- **Projeto.** `init` do `ember` (`project: "spike-ai"`, env `test`, var `EMBER_TRACE=1`, métricas no dataset
  `ember_spike_metrics`) em `packages/cli/.tmp/ember-spike-ai` (apagado no fim). Worker `ember-spike-ai-test`.
  Registro da conta desligado (`registry: false`): nenhum D1 criado.
- **Schema.**
  ```ts
  notes: defineTable({ title: v.string(), body: v.string(), lang: v.string(), topic: v.string(), vec: v.optional(v.array(v.number())) })
    .vectorIndex("semantic", { embed: "body", filterFields: ["topic"] })                          // Workers AI bge-m3, 1024 dims
    .vectorIndex("by_vec", { vectorField: "vec", dimensions: 32, metric: "cosine", filterFields: ["lang"] })
    .aiSearchIndex("hybrid", { fields: ["title", "body"], filterFields: ["topic"] })
  ```
  Actions `semantic` (`ctx.vectorSearch(..., { text })`), `similar` (`{ vector }`), `hybrid` (`ctx.aiSearch`, com
  `mode`/`fusion`); mutations `addMany`, `patch`, `remove`.
- **Driver.** `docs/spikes/remote/scripts/ai-indexes-e2e.ts` (fases `deploy`, `load`, `search`, `update`,
  `durations`, `metric`, `destroy`), chamando a API programática da CLI (`deploy`, `destroy`) e `fetch` nas URLs.
- **Segredos.** Token da Cloudflare pela CLI (OAuth do wrangler), em memória. Admin token aleatório por processo, em
  memória. Saídas redigidas (`<ACCOUNT_ID>`, `<subdomain>`, caminhos locais).
- **Dados.** Os 30 documentos e 30 consultas pt-BR de `docs/spikes/ai-embeddings/dataset.ts` (uma resposta certa por
  consulta), num shard `global:main`, mais 1 documento em `global:other` (isolamento).

## 1. Deploy (`ember deploy --env test --wait`)

```
deploy ember-spike-ai-test: create (new DO classes: Shard, System)
  bundle 310.6 KiB sha256 933be9fd58aa
  ai indexes: ember-spike-ai-test-notes-semantic-2d7cc194, ember-spike-ai-test-notes-by-vec-f93e3e4d,
    ember-spike-ai-test__notes_hybrid_e091d3, ember-spike-ai-test-indexing
    (vectorize …-by-vec-f93e3e4d; vectorize …-by-vec-f93e3e4d metadata lang:string;
     ai-search ember-spike-ai-test__notes_hybrid_e091d3; queue ember-spike-ai-test-indexing)
  uploaded ember-spike-ai-test (created Shard, System)
  ai indexes: indexing queue consumer added
ember-spike-ai-test → https://ember-spike-ai-test.<subdomain>.workers.dev
  shards ready: global:main
deploy (cosine) took 32433 ms
```

- Upload da Worker com os bindings novos aceito numa Script PUT junto com os `exports` dos DOs:
  `{"type":"vectorize","name":"EMBER_VEC__notes__semantic","index_name":"…"}`, `{"type":"ai_search","name":"EMBER_AIS__notes__hybrid","instance_name":"…"}`,
  `{"type":"ai","name":"EMBER_AI"}`, `{"type":"queue","name":"EMBER_INDEXING",…}`.
- Instância AI Search criada com `embedding_model: @cf/baai/bge-m3`, `cache: false`, `custom_metadata: [{topic,text}]`,
  `retrieval_options.keyword_match_mode: "or"` (namespace `default`).
- **Três achados da API real, corrigidos no código antes deste deploy passar:**
  1. Vectorize recusa índice de 3 dimensões: `3003 vectorize.index.invalid_config - Dimensions must be in range: [32, 1536]`.
     O `defineSchema` agora recusa fora de 32..1536.
  2. `GET …/metadata_index/list` devolve `indexType: "String"`; o create recebe `"string"`. A comparação estava
     sensível a maiúsculas e um re-deploy tentou recriar (`40004 metadata index already exists`). Corrigido
     (comparação sem caixa; 40004 = já feito).
  3. (No destroy, seção 7.)

## 2. Escrita → buscável (`load`)

Uma mutation com 30 documentos (855 ms HTTP), polling das actions a partir do fim da escrita:

| Índice | Buscável depois de |
|---|---|
| Vectorize `by_vec` (30 vetores, valores do documento) | 74,3 s |
| Vectorize `semantic` (embed bge-m3 no consumer) | 89,3 s |
| AI Search `hybrid` | 95,6 s |

De onde vem o tempo (linhas `ember:index` com `EMBER_TRACE=1`, patches avulsos depois):

```
ember:index {"index":"notes.hybrid","upserted":1,"attempt":1,"queuedMs":637,"deliverMs":2033}
ember:index {"index":"notes.semantic","upserted":1,"attempt":1,"queuedMs":2670,"deliverMs":995}
ember:index {"index":"notes.hybrid","upserted":1,"attempt":1,"queuedMs":3429,"deliverMs":1901}
ember:index {"index":"notes.semantic","upserted":1,"attempt":1,"queuedMs":5330,"deliverMs":936}
```

A mensagem chega ao consumer 0,6–5,3 s depois do commit, e a entrega leva ~1 s (embed + upsert no Vectorize) ou ~2 s
(upload no AI Search). **O resto (minutos) é a indexação assíncrona dos próprios serviços.** O AI Search respondeu
várias vezes `AiSearchError: ai_search_instance_overloaded` e `DownstreamConfigApiError: rag_config_api request timed
out after 30000ms`; o consumer fez `retry` com backoff e entregou depois. O patch só mudou `body`: `by_vec` (campos
`vec`, `lang`) **não** recebeu mensagem (detecção de mudança por campo, em produção).

## 3. Qualidade e latência das buscas (`search`, antes de qualquer update)

30 consultas, ação HTTP a partir de Campinas (latência inclui RTT + Worker + serviço):

| Caminho | R@1 | R@3 | MRR@10 | ação p50 / p95 |
|---|---|---|---|---|
| `ctx.vectorSearch` semantic (Vectorize + bge-m3, via Ember) | 0,933 | 1,000 | **0,967** | 483 / 830 ms |
| `ctx.aiSearch` `mode: "vector"` | 0,900 | 1,000 | **0,950** | 747 / 1086 ms |
| `ctx.aiSearch` `mode: "hybrid"` (RRF, padrão) | 0,50–0,53 | 0,667 | 0,63–0,65 | 851–955 / 1287–2343 ms |
| `ctx.aiSearch` `mode: "keyword"` | 0,267 | 0,40–0,43 | 0,37–0,39 | 562–663 / 783–852 ms |
| `ctx.aiSearch` `fusion: "max"` (rodada pós-update) | 0,233 | 0,367 | 0,368 | 792 / 1223 ms |

- O Vectorize via Ember repete exatamente o MRR do teste offline do bge-m3 (0,967): outbox, embed no consumer e
  busca com o mesmo modelo não perdem nada.
- **O híbrido do AI Search piora em pt-BR:** o lado BM25 usa o tokenizer `porter` (stemming inglês) e, na fusão,
  derruba o que o vetor acertou. Para pt-BR, `mode: "vector"`. `fusion: "max"` é pior ainda. (Faixas: duas rodadas;
  a rodada pós-update tem 5 documentos relevantes alterados/apagados e por isso números menores em todas as linhas.)
- Filtros: `semantic` com `topic: "rh"` → só os 4 documentos de RH (`d14, d24, d13, d15`); AI Search com
  `topic: "rh"` → `d13, d14`; `by_vec` com `lang: "en"` → só documentos `en`.
- **Isolamento por shard:** do shard `global:other`, `ctx.vectorSearch` (namespace) e `ctx.aiSearch` (pasta) devolvem
  1 resultado cada, o documento dele, nenhum de `global:main`.

## 4. Update e delete (`update`)

`patch` do `body` de um documento e `delete` de outro, polling até refletir:

| | Vectorize (semantic) | AI Search |
|---|---|---|
| documento alterado achado pelo texto novo | 210,0 s | 212,8 s |
| documento apagado some dos resultados | 210,7 s | 214,3 s |

(Uma primeira rodada foi interrompida por um erro de rede do lado do cliente — `socket connection was closed
unexpectedly` no laptop — e repetida com outros documentos. O driver agora repete chamadas idempotentes.)

## 5. Mudança de métrica: índice novo + backfill (`metric`)

`by_vec` de `cosine` para `euclidean` (imutável no Vectorize):

```
deploy ember-spike-ai-test: code-only
  ai indexes: … ember-spike-ai-test-notes-by-vec-4907be06 … (vectorize ember-spike-ai-test-notes-by-vec-4907be06;
    vectorize ember-spike-ai-test-notes-by-vec-4907be06 metadata lang:string)
  uploaded version f7674804-… (#2)
  deployed f7674804@100%
  ai indexes: deleted vectorize ember-spike-ai-test-notes-by-vec-f93e3e4d
waiting for shards to migrate (schema 2b0dc98f9c37)...
  global:main: backfilling notes.by_vec (30 rows left)
  shards ready: global:main
```

- Índice novo criado antes do upload; o velho apagado só depois do deploy a 100%; o shard fez o backfill staged
  pelo outbox. Depois: `similar` devolve `d01` com distância **0** (métrica euclidiana: menor é melhor), seguido de
  `1.009, 1.478…`.
- O tempo exato do refill não foi medido: o driver perdeu o mapa de ids no re-deploy (corrigido) e a checagem só rodou
  num segundo re-deploy, já com o índice cheio.
- O segundo re-deploy (só código, mesmo schema) mostrou `ai indexes: … (ok)`: nada criado, bindings mantidos.

## 6. Durações (`durations`, Analytics Engine SQL)

Tráfego: 10 × (HTTP `notes:count` + HTTP `notes:addMany`) e 10 `mut` por WebSocket com uma inscrição aberta, além das
ações das fases anteriores. `ember_spike_metrics`, projeto `spike-ai`:

| kind | timing | n | p50 | média | mín | máx |
|---|---|---|---|---|---|---|
| query | rpc | 20 | 8 ms | 21,7 ms | 6 ms | 131 ms |
| mutation | rpc | 30 | 42 ms | 93,8 ms | 39 ms | 236 ms |
| mutation | commit | 8 | 49 ms | 49 ms | 49 ms | 49 ms |
| subscription | none | 5 | 0 | 0 | 0 | 0 |
| action | wall | 445 | 553 ms | 578 ms | 181 ms | 6233 ms |

- Antes (Fase 4b, `platform-e2e.md`) toda query/mutation saía **0 ms**. Agora: `rpc` = tempo de parede no Worker em
  volta do RPC ao DO (hop + fila + execução + commit durável para mutations); `commit` = do recebimento do `mut` no DO
  até `storage.sync()` (um lote de group commit: todos os itens com o mesmo fim); `none` = reexecução de
  subscription, síncrona no DO, sem medida possível em produção (0, como esperado).
- `commit` n=8: a segunda rodada de `mut` reusou os mesmos `mid`/`clientId` e foi deduplicada (sem execução, sem
  ponto).

## 7. Limpeza (`ember destroy --env test --yes`)

Primeira tentativa:
```
FAILED: DELETE worker ember-spike-ai-test: Cannot delete this Worker as it is a consumer for a Queue. Remove it from
the Queue's consumers first, then retry.
```
Corrigido (`destroy` tira a Worker dos consumers das filas do env antes). Segunda:
```
  detached ember-spike-ai-test from queue ember-spike-ai-test-indexing
  deleted worker ember-spike-ai-test
  deleted vectorize ember-spike-ai-test-notes-by-vec-4907be06
  deleted vectorize ember-spike-ai-test-notes-semantic-2d7cc194
  deleted ai-search ember-spike-ai-test__notes_hybrid_e091d3
  deleted queue ember-spike-ai-test-indexing
after destroy: {"workers":[],"vectorize":[],"aiSearch":[],"queues":[],"d1":[],"durableObjectNamespaces":[]}   (filtro /ember-spike/)
```
Verificação independente por GET de cada nome:
```
GET /workers/scripts/ember-spike-ai-test                               -> 404 [10007 This Worker does not exist on your account.]
GET /vectorize/v2/indexes/ember-spike-ai-test-notes-semantic-2d7cc194  -> 410 [3005 vectorize.index.deleted]
GET /vectorize/v2/indexes/ember-spike-ai-test-notes-by-vec-4907be06    -> 410 [3005 vectorize.index.deleted]
GET /vectorize/v2/indexes/ember-spike-ai-test-notes-by-vec-f93e3e4d    -> 410 [3005 vectorize.index.deleted]   (apagado pelo prune do deploy da seção 5)
GET /ai-search/namespaces/default/instances/ember-spike-ai-test__notes_hybrid_e091d3 -> 404 [7002 ai_search_not_found]
GET /ai-search/namespaces/default/instances/ember-spike-probe          -> 404 [7002 ai_search_not_found]   (sonda da API, abaixo)
queues named ember-spike-ai-test-indexing: 0
```
O inventário antes do run não tinha nenhum recurso `ember-spike-*`. Ficam só os pontos no dataset do Analytics
Engine `ember_spike_metrics` (datasets não são recursos apagáveis; o mesmo dataset dos spikes anteriores).

## Anexo: sonda da API do AI Search (antes do código)

Instância `ember-spike-probe` (REST, namespace `default`), apagada no fim (404 acima):
- `POST …/instances {id, custom_metadata}` → 201 em 3,1 s. Padrões da instância: `embedding_model: @cf/qwen/qwen3-embedding-0.6b`,
  `cache: true` (`close_enough`, TTL 172800 s), `keyword_tokenizer: porter`, `keyword_match_mode: and`.
- `POST …/items` multipart (`file` + `metadata` JSON + `wait_for_completion`) → 200 em ~26 s (orçamento de 25 s),
  item ainda `queued`/`running`. Reenviar a **mesma chave** devolveu o **mesmo id** com metadados novos (substitui).
- `GET …/items?key=<chave>` acha o item pela chave exata; `DELETE …/items/<id>` → 200, e de novo → 200 (idempotente);
  o chunk apagado ainda saiu na busca logo depois e sumiu minutos depois.
- Busca com o cache padrão devolveu o texto **antigo** minutos depois da substituição (mesmo score 0,5711); com
  `cache: { enabled: false }` veio o novo (0,8272). Por isso o Ember cria instâncias com `cache: false` e desliga o
  cache por consulta.
- `filters: { folder: "s-aaa/" }` isola a pasta; combinado com metadado custom (`prio: { $lte: 1 }`) funciona.
- Keyword `and` não achou "estorno no cartão"; `or` achou, e "cartao" casa com "cartão".
