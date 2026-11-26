# Performance: 0.8.1 → 0.9.0

A 0.9.0 junta as ondas 1–4 da auditoria de performance e custo (#123–#162) e o hook `onScreen` do email (#163). Este
documento compara as duas versões com os mesmos benches, na mesma máquina, e lista o que cada PR mediu.

**Como foi medido (2026-11-25):** laptop Apple M3 (8 núcleos, 16 GB, load ~2), sem rede. `0.8.1` é a tag `v0.8.1`;
`0.9.0` é o `main` em `ea1b683a`. Os benches são os do repositório, rodados nas duas árvores. Números brutos e logs em
`spikes/local-bench/evidence/release-0.9.{json,txt}`.

## Ponta a ponta (`spikes/local-bench/bench.ts`, só Ember)

Worker do `ember deploy` no Miniflare/workerd, DO SQLite em disco, `EmberClient` oficial, laço fechado de 8 s. A CPU do
servidor é a do processo workerd (ps), dividida pelas operações.

| Cenário | 0.8.1 | 0.9.0 | Ganho |
|---|---|---|---|
| noop, 6×100 em voo: vazão | 84.311/s (p50 6,5 ms) | **273.102/s** (p50 2,0 ms) | **3,2×**; CPU 12 → 4 µs/op |
| doc quente (`incr`), 6×10: vazão | 28.151/s (p50 1,93 ms) | **35.179/s** (p50 1,55 ms) | **+25%**; CPU 37 → 29 µs/op |
| doc quente, 6×100: vazão | 38.354/s (p99 25,9 ms) | **45.151/s** | **+18%**; CPU 27 → 23 µs/op |
| doc quente, 60 clientes × 1: vazão | 15.727/s (p50 3,5 ms) | **20.261/s** (p50 2,7 ms) | **+29%**; CPU 68 → 51 µs/op |
| inserts espalhados, 8×50: vazão | 48.629/s | **54.758/s** | **+13%**; CPU 20 → 17 µs/op |
| inserts espalhados, 32×50: vazão | 46.799/s (p50 33 ms) | **52.723/s** (p50 27,5 ms) | **+13%** |
| query HTTP, 8×50: vazão | 16.566/s | 17.917/s | +8% (o teto é o pool de conexões do harness: 52 e 120 conexões recusadas no loopback) |
| fan-out para 1.000 inscritos: entrega p99 | 58,1 ms | 54,0 ms | −7% |

- **1 operação em voo** (noop, `incr`, insert com 1 em voo; query por WS ou HTTP com 1–4 clientes; primeiro resultado
  de um cliente novo) fica igual dentro do ruído. Localmente a latência é o piso do timer do workerd (~1,6 ms no group
  commit) e do loopback, não o motor. Uma primeira rodada da 0.8.1 deu `incr` 1×1 em 1,61 ms contra 2,45 ms na 0.9.0.
  Repetido alternando as versões, deu 2,16 / 2,46 ms (0.8.1) contra 2,47 / 2,27 ms (0.9.0): ruído. Sob carga, a
  repetição confirma o ganho: `incr` 6×10 deu 30,5k / 30,1k contra 35,4k / 35,4k por segundo.
- Em produção o piso de uma mutation é o flush durável (~25–30 ms). O que estes números mostram é CPU por operação e
  vazão por shard, que é o que vira custo (`spikes/remote/perf-remote.md`).

## Motor (`scripts/bench-hot-path.ts`, Node/V8)

| Caminho | 0.8.1 (ns/op) | 0.9.0 (ns/op) | |
|---|---|---|---|
| `patch` de um campo numa mutation | 23.324 | **11.889** | −49% |
| `db.increment` | 24.341 | **13.794** | −43% |
| query `db.get` | 11.259 | **5.903** | −48% |
| query `withIndex().take(10)` | 44.618 | **27.040** | −39% |
| query `db.sql` | 5.546 | **3.565** | −36% |
| `matchIndex.match` (update fora da chave, 1.000 chaves) | 167.983 | **90.600** | −46% |
| `matchIndex.set` (mesmo read set) | 1.637 | **42** | −97% |
| `rowDiffJson` 50 docs | 7.470 | **5.608** | −25% |
| `encodeParts` objeto sem docs | 984 | **438** | −55% |
| `encodeKey` / `decodeKey` / `rangeFor` | 62–535 | 62–305 | −15% a −74% |
| `bytesToBase64` 1 KiB | 5.348 | **1.210** | −77% |
| mutation vazia / query vazia | 1.833 / 541 | 1.608 / 559 | −12% / igual |

## Cliente e offline (benches de `packages/*/bench`, "antes" = fontes da 0.8.1)

| Medida | 0.8.1 | 0.9.0 |
|---|---|---|
| frame `patch` com 5.000 inscrições (main thread) | 0,063 ms | **0,024 ms** |
| recompute de uma edição otimista (40 listas × 50 linhas) | 24,30 ms | **1,19 ms** |
| flush do `snapshotCache` (100 queries × 50 linhas, 1 mudou) | 1.018,5 KiB | **15,3 KiB** (aba leitora: 0) |
| rajada de 20 queries mudadas (SQLite) | 20 transações, 10,7 ms | **1 transação, 3,1 ms** |
| rajada de 20 queries mudadas (IndexedDB) | 20 transações, 2,1 ms | **1 transação, 1,6 ms** |
| ponte por patch (500 linhas, 1 mudou) | 92,8 KiB | **298 B** |

## O que cada PR mediu (custo na Cloudflare)

Linhas lidas e escritas do DO, jobs e requisições, medidas nos testes de contador de cada PR:

- **Wake de shard (#123):** boot + primeira query 47 → 14 statements SQL; `migrate()` sem mudança: até 3 statements;
  `System` ocioso grava 1 linha por minuto em vez de uma por cron; `reportShard` 1 query D1 em vez de 2.
- **Componentes (#129, #147):** workflow de 40 passos: rowsRead 985 → 95, rowsWritten 182 → 102, jobs 40 → 2. Email:
  ingest de conversa nova 18 → 10 linhas escritas, compose 11 → 9, Enviadas 96 → 46 lidas. Workpool: item sem
  `onComplete` 8 → 4 escritas, `cancelAll` de 49 itens 247 → 199.
- **Mutations (#157):** sem `SELECT *` e com cache de leitura do que a própria mutation escreveu: 15–28% menos linhas
  lidas (ex.: 447 → 333); escritas iguais.
- **Replicação (#151):** 7 alvos em 2 kinds: leituras de snapshot 12 → 3, uma leitura do log por rodada em vez de 7.
- **Bundles (#154):** `import()` nos caminhos frios: Worker do exemplo `chat` 399 → 380 KiB, mapas de 1,8 MiB → 566 KiB.
- **Cliente (#146, #160, #162):** ack a cada 30 s em vez de um frame 2 s depois de cada mutation; `httpFirst` em lote
  (`POST /api/query/batch`, uma requisição por turno e shard); `multiTab`: um WebSocket por shard para todas as abas da
  mesma identidade.
- **Offline (#155):** um frame que liquida mutations entre updates: 3 commits → 1; registro frio comparado por
  fingerprint sem ler as linhas.

## Depois da 0.9.0: índices esparsos e uma escrita por documento (PR 3a da 0.10)

Contadores dos testes de cada pacote (`node:sqlite`: linhas devolvidas / alteradas, sem contar entradas de índice) e,
para o índice esparso, as linhas cobradas pelo DO no workerd (`spikes/rows-written.md`, "Índice esparso"):

- **Índice esparso** (`.index(name, fields, { sparse: true })`): insert sem o campo opcional 4 → 3 linhas cobradas no
  DO (a entrada do índice some); com o campo, igual.
- **Email:** `send` sem chave nem thread 4 → 3 linhas escritas e 6 → 3 entradas de índice no email (no DO, ~10 → 6);
  `reply` 6 → 5, `compose` 9 → 8 (o email gravado uma vez, já com o job e a mensagem da thread).
- **Agent:** `send` com prompt e resposta 4 → 3 escritas e 3 → 2 lidas; `toolResults` 2 → 1 lida; instalação padrão
  sem índice FTS5 (busca opt-in, `{ search: true }`): nenhuma linha de FTS por mensagem.
- **Migrations:** `start` 2 → 1 linha escrita. **Workpool:** item sem `key` sem entrada no `by_key`.

## Reproduzir

```sh
# ponta a ponta (uma árvore por vez; a máquina parada)
BACKENDS=ember ROUND=x bun --conditions=@freecorps/ember-source run docs/spikes/local-bench/bench.ts
# motor
node --conditions=@freecorps/ember-source --experimental-transform-types --no-warnings scripts/bench-hot-path.ts
# cliente/offline: ver o cabeçalho de cada arquivo em packages/client/bench e packages/offline/bench
```

O `bench.ts` precisa do cliente do Convex em `docs/spikes/remote/convex-bench/node_modules` mesmo com
`BACKENDS=ember` (import estático). O `summary` dele não usa mais `Math.max(...xs)`, que estourava a pilha do Bun com
as ~700k amostras do noop 6×100 na 0.8.1.
