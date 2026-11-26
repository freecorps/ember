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

## 0.10, PR 4a: cliente (multiTab, bundle, batching, upload, `zframe`)

Medido em 2026-11-25, mesmo laptop (Apple M3), "antes" = `main` em `6a0b8e20`.

| Medida | Antes | Depois |
|---|---|---|
| Bundle, `new EmberClient(...)` (esbuild `--minify`), carga com code splitting (Vite/Rollup/webpack) | 90,8 KiB (gzip 28,0) | **73,3 KiB** (gzip 23,3, cada arquivo comprimido à parte), −19%; hub do multitab + upload num chunk de `import()` (28,8 KiB) só baixado por quem usa |
| Bundle, arquivo único (bundler sem code splitting) | 90,8 KiB (gzip 28,0) | 102,5 KiB (gzip 32,6): o dedup do multitab (+5 KiB), retry do upload, `zframe` e o lote HTTP entram junto |
| Bundle com `multiTab: multiTab()`, carga com code splitting | 90,8 KiB | 96,8 KiB (o hub é estático de novo, com dedup) |
| N abas na mesma query: `sub` no shard | N | **1** (ref-count; a 2ª aba recebe o valor do líder, sem ida ao shard) |
| Frames da aba líder para o próprio líder | 2 mensagens de `BroadcastChannel` por frame | **0** (in-process) |
| `query()` HTTP / `fetchForHydration` de um turno, mesmo shard | 1 requisição por query | **1 requisição** (`POST /api/query/batch`, até 32) |
| `patch` de outra query com update otimista pendente, 1.000 / 5.000 inscrições | 0,042 / 0,100 ms | **0,004 / 0,015 ms** (o update não roda de novo; só o que mudou é reconstruído) |
| Decodes do JWT por token (`fromAuth`: watch, query, chaves do multitab) | 1 por chamada | **1** |
| Parte de multipart com 5xx/429/rede | upload inteiro abortado | até 3 tentativas (`Retry-After` ou backoff) antes de abortar |
| `snap` de 120 linhas com `zframe` | 21.638 B (texto) | **2.498 B** (11,5%, binário deflate-raw) |

- O bundle "arquivo único" cresce: um bundler sem code splitting inlina o `import()` (e embrulha os módulos para init
  lazy). Para não embrulhar o pacote `values` inteiro, `multitab.ts`, `files.ts` e o que eles importam (`jwt.ts`,
  `zframe.ts`, `protocol.ts`, `errors.ts`) não importam o `values` em runtime (os diffs chegam ao líder pelo
  `MultiTabHost.applyDiff`).
- `zframe` é opt-in no cliente (`zframe: true`): a compressão gasta CPU do shard, que é cobrada, para economizar bytes
  de saída, que não são; vale em link lento ou medido. Sem efeito em React Native (sem `DecompressionStream`).

## Offline e actions fora do cold start do Shard (PR 4b da 0.10)

`packages/offline/bench/cold.ts` (node:sqlite, fake-indexeddb, TinyBase em memória; antes = `main` em 268a7f63, na
mesma máquina) e o teste `packages/cli/test/lazy-actions.test.ts`:

| | antes | depois |
| --- | --- | --- |
| boot com 20 shards (5 queries × 50 linhas): bancos abertos antes do `hello` | 21 | **1** |
| idem: ms até o `hello` poder sair / até o 1º resultado local de um shard | 4,9 / 5,0 | **0,5 / 1,3** |
| `clear()`: bancos no disco (principal + shards) | 21 | **1** |
| rajada de 40 puts + 40 removes da fila: transações de escrita (SQLite, IndexedDB, TinyBase) | 80 | **2** |
| idem, SQLite em arquivo | 18,5 ms | **0,8 ms** |
| mesmo valor de novo (200 linhas, N abas), objetos do cliente / clone estruturado | 57 / 98 µs | **4,3** / 111 µs |
| ponte: rajada de 20 updates, mensagens página→Worker / Worker→página | 20 / 21 | **1 / 2** |
| ponte: resultado observado (500 linhas, 1 mudou), bytes Worker→página | 102 KB | **404 B** |
| Worker com um módulo só de actions que importa ~195 KiB: módulos avaliados no startup | 896 KiB | **702 KiB** |

- **Cold start lazy por shard:** `SqliteBackend.open()` lê só o banco principal (meta, fila, lista de shards) e
  `openShard()` lê os registros de um shard no primeiro uso. O `hello` espera load + clientId + fila: só o principal.
- **Shards vazios:** o banco de um shard sem registros, linhas, log nem pendência é apagado (`remove`; `unlink` do
  `opfs-sahpool`; `deleteDatabaseSync` do expo-sqlite). Bancos novos com `auto_vacuum = INCREMENTAL` e um
  `incremental_vacuum(256)` a cada 32 commits que liberam páginas; os existentes só mudam de modo com `VACUUM`
  (contracts.md, "Offline").
- **Fingerprint estrutural:** hash de 53 bits memoizado por objeto (`WeakMap`) em vez de `encodeJson` + hash; um
  fingerprint igual só pula a escrita depois de `sameValue` (comparação completa, identidade primeiro). O caso de um
  clone estruturado (valor de outra aba) fica ~13% mais caro: são os ~16 µs da comparação completa, o preço de uma
  colisão nunca pular uma escrita; o caso comum (o cliente reusa as linhas que não mudaram) cai 13×.
- **`batchPending`:** o lote da fila (a última escrita de cada mutation) numa transação no SQLite, IndexedDB e TinyBase
  (um `save()` do persister).
- **Ponte:** lotes por microtask nos dois sentidos (feature `batch`) e diff nas streams `watch` (a reexecução do store
  devolve os mesmos objetos das linhas que já leu, então o diff sai por identidade).
- **Linhas lidas no LRU do store** (`maxCachedRows`, 50 000): `get` sem ida ao IndexedDB, mesmos objetos entre
  reexecuções, e depois de reabrir o primeiro valor do servidor regrava só as linhas que mudaram (antes, todas: a
  assinatura das linhas só existia para as escritas na sessão). Varredura descendente do IndexedDB numa requisição com
  `getAllRecords({ direction: "prev" })` (Chrome 141+), cursor como fallback.
- **Actions fora do cold start:** um módulo `ember/*.ts` só com actions entra por `import()` (`lazyActions`); o
  `examples/chat` não tem um (Worker igual); no fixture, o módulo e o SDK saem do index.js (241 → 45 KiB) e do
  conjunto que todo isolate avalia no startup (896 → 702 KiB, sem minificar).
- Iguais (ruído da máquina à parte): rajada de 20 queries mudadas, 10,1 → 2,6 ms (SQLite) e 2,0 → 1,4 ms (IndexedDB),
  como na 3B-1; bytes por patch na ponte, ~300 B.

## Reproduzir

```sh
# ponta a ponta (uma árvore por vez; a máquina parada)
BACKENDS=ember ROUND=x bun --conditions=@freecorps/ember-source run docs/spikes/local-bench/bench.ts
# motor
node --conditions=@freecorps/ember-source --experimental-transform-types --no-warnings scripts/bench-hot-path.ts
# cliente/offline: ver o cabeçalho de cada arquivo em packages/client/bench e packages/offline/bench
bun packages/client/bench/bundle-size.ts            # bundle do cliente (esbuild --minify), com e sem code splitting
# zframe: packages/runtime/test/zframe.test.ts imprime o tamanho do snap em texto e comprimido
bun --conditions=@freecorps/ember-source packages/offline/bench/cold.ts
# actions fora do startup (imprime os tamanhos)
bun run --cwd packages/cli vitest run test/lazy-actions.test.ts --disableConsoleIntercept
```

O `bench.ts` precisa do cliente do Convex em `docs/spikes/remote/convex-bench/node_modules` mesmo com
`BACKENDS=ember` (import estático). O `summary` dele não usa mais `Math.max(...xs)`, que estourava a pilha do Bun com
as ~700k amostras do noop 6×100 na 0.8.1.
