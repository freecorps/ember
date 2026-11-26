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

## Depois da 0.9.0: hot path do engine e filtros no SQLite (PR 3b da 0.10)

**Como foi medido (2026-11-25):** o mesmo laptop (Apple M3, load ~2 com outro processo pesado), `scripts/bench-hot-path.ts`
nas duas árvores, `main` em `268a7f63` contra a PR, três rodadas alternando as árvores e o menor tempo de cada linha.
O bench ganhou linhas de filtro, de lote e de strings (rodadas também no `main`, a mesma API pública). As linhas de
`.filter()` e de group commit foram medidas de novo depois do review (três rodadas alternadas, load ~3): o filtro
passou a olhar o `_json` em toda linha (abaixo) e o group commit de 1 `patch` media um `patch` sem mudança (que não
escreve nada; era 10.382 → 8.398 ns).

| Caminho | `main` (ns/op) | PR 3b (ns/op) | |
|---|---|---|---|
| `validate` objeto (string com `max`, email, regex) | 505 | **216** | −57% |
| `validate` string `min`/`max` (40 caracteres) | 56 | **12** | −79% |
| `validate` string regex | 123 | **42** | −66% |
| query `db.get` | 5.884 | **5.156** | −12% |
| query `withIndex().take(10)` | 27.116 | **22.900** | −16% |
| query `.filter()` `take(10)` (1 em 10 passa; ~540 linhas lidas) | 711.500 | **496.654** | −30% |
| query `.filter()` `collect()` (1.000 linhas, 12 passam) | 1.222.114 | **808.282** | −34% |
| query `withIndex` + `.filter()` `collect()` | 365.596 | **281.683** | −23% |
| mutation `.filter()` `first()` (lê 1.000) | 1.225.699 | **943.670** | −23% |
| group commit de 1 `patch` que muda o valor, como o shard faz | 15.478 | **13.758** | −11% |
| group commit de 10 `patch` | 119.111 | 115.705 | −3% |
| mutation vazia / query vazia | 1.858 / 568 | 1.806 / 550 | −3% / −3% |
| `patch` / `increment` / `db.sql` / chaves / JSON | — | — | igual (±1%) |

`valueSize doc` saiu +21% na rodada completa e igual (626 × 633 ns) rodado sozinho nas duas árvores: efeito de JIT da
ordem do arquivo, o código não mudou. Contador do workerd (`packages/runtime/test/perf-counters.test.ts`): transações
por mutation **3 → 1**; statements, linhas lidas e escritas iguais (2,17 / 3,88 / 2).

- **Group commit em uma transação** (`engine.commitMutationBatch`, `shard.ts` `commitBatch`): eram a transação do
  shard, a do `runMutationBatch` e um savepoint (do item, ou do lote). Agora os itens e as linhas do commit (ring,
  dedup, jobs) dividem uma transação sem savepoint; um item que falha desfaz essa transação e a seguinte faz o commit
  (sozinho, com o erro dele, sem rodar de novo; num lote, com um savepoint por item, como antes).
- **`.filter()` no SQLite** (`pushdown.ts`): comparações de campo tipado com literal viram uma coluna calculada do
  scan (1 / 0 / NULL). A linha que o SQLite rejeita não é decodificada nem avaliada em JS e, numa query, chega sem
  `_json` e sem colunas de texto. O scan é o mesmo (faixa, `LIMIT`, lotes), então `rowsRead`, `documentsRead`, read
  set e paginação não mudam: o teste no workerd compara o pushdown ligado e desligado no DO SQLite, com as linhas
  lidas que o DO conta. Na primeira versão a expressão era repetida por coluna escondida (o SQLite achata a
  subquery) e o filtro ficou 18% mais lento que o JS; a co-rotina (`LIMIT -1` por fora) virou isso no ganho acima.
  A linha cujo `_json` cita o campo fica com o JS mesmo com a coluna preenchida (o decoder lê o `_json` primeiro, e
  uma coluna adicionada depois das linhas, ou um `patch` antigo, pode deixar o valor nos dois): ler o `_json` em toda
  linha custa ~8% contra lê-lo só com a coluna NULL (a primeira versão), e o veredito do SQLite é sempre o do
  documento. O filtro tem teto de 256 nós e 32 KiB de SQL (um `or` plano é uma árvore funda no SQLite, que recusa
  profundidade acima de 1.000; o DO recusa statement acima de 100 KB); acima disso fica com o JS.
- **Linhas como arrays** (`SqlDriver.execRaw`, `DoSqlDriver` sobre `cursor.raw()`): os scans e o `db.get` de query
  decodificam do array (`decodeValues`), sem montar um objeto por linha. Medido com o filtro desligado: −24% num
  `take(10)` filtrado, −29% num `collect()` de 1.000 linhas.
- **`validate`:** o tamanho de uma string sai do `length` UTF-16 (entre `ceil(L/2)` e `L` code points) sem contar,
  salvo quando o intervalo cruza um limite; o `RegExp` é criado uma vez por validador, não procurado num cache por
  chave a cada valor.
- **Alocações:** `docKey` reusa o array das partes da chave, `withIndex` usa uma classe para o `q` (eram 5 closures por
  chamada), `deliverFlush` escreve `"mids":[]` sem serializar um array vazio por socket, o `ctx` da mutation monta
  `storage` e `scheduler` sem spread e o `ctx.db.sql` com um closure só.
- **Não entrou: `ctx` preguiçoso com getters.** Um objeto literal com `get`/`set` sai pelo caminho lento do V8: ~300 ns
  o primeiro par, ~50 ns cada um a mais (medido), mais do que construir os membros. Com getters no `ctx` e no `db.sql`, a
  query vazia ficou 96% mais lenta e a mutation vazia 44%; voltaram a ser propriedades de dados.

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
