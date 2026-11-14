# Bench local: Ember × Convex (performance bruta)

> **Atualização (mesmo dia): o remoto corrige este documento.** Ver `../remote/perf-remote.md`.
> - O `setTimeout(0)` de 1,6 ms é do workerd local; em produção é ~0.
> - O group commit sem timer (`auto`) **perdeu** para o timer no A/B dentro da Cloudflare e foi revertido (`6180145`).
> - Em produção o piso de uma mutation é o flush durável (~25–30 ms) e uma mutation custa ~200 µs de CPU (~6× o
>   local), então os itens de CPU do mapa valem mais lá.
> - Dois itens novos e medidos: `maxBatch` maior (+29% no shard quente) e frames em lote em todo cliente (2,2×).
>
> - ✅ Feitos 0a, 2, 3 e 4: em produção, CPU por mutation 163 → 107 µs e shard quente +28–42% (`../remote/perf-remote.md` §7).
>
> - ✅ Feitos (2026-11-14, seção "Reatividade, wake e DX" no fim): cache de query compartilhado entre identidades e
>   `authorize`, JSON por documento na reexecução, validadores compilados (#12, parcial), wake sem reexecutar, memo do
>   `resume`, anexo por frame, recompute por frame no cliente, HTTP-first, lote sem savepoint por item (#6), contadores
>   SQL no `inspect()` (#15).
>
> - ✅ Feitos (2026-11-14, rodada 2, seção "Paginação, patches e cliente" no fim): paginação com fronteira fixa, `vdiff`
>   para listas dentro de objetos, `resume` do valor que o cliente já tem (offline, SSR, cache leve, HTTP), `ctx.runQuery`
>   aninhado reaproveitado entre identidades, guarda de regressão por contadores.
>
> As linhas `ember#2` abaixo são do modo `auto` revertido; o Ember da `main` no local é `ember#1`.

Rodado em 2026-11-12 neste laptop (Apple M3, 8 núcleos, 16 GB, load ~2), sem rede: os dois backends e o harness na
mesma máquina. Objetivo: medir o custo do engine sem o RTT Brasil→EUA que domina `../remote/convex-vs-ember.md`, achar
onde vai o tempo do Ember e mapear o que dá para acelerar. O remoto vem depois (fim deste arquivo).

- **Convex:** o backend open-source (`convex-local-backend`, o binário que `npx convex dev --local` baixa,
  `precompiled-2026-10-22-1447815`), SQLite em disco, cliente `convex@1.49.0`. Rodada 2 com os knobs da classe S256 do
  plano Pro (`CONVEX_KNOBS=s256`: 256 queries e mutations concorrentes, 8 threads de isolate). O padrão local é 16
  queries concorrentes, e a rodada 1 bateu nesse teto.
- **Ember:** o Worker do `ember deploy` (minificado, sem `keepNames`) no Miniflare/workerd, DO SQLite em disco,
  `EmberClient` desta árvore.
- **Mesmo app** (`./convex` e `EMBER_BENCH` em `bench.ts`): o de `../remote`, mais `noop` (custo fixo por chamada).
- **Carga:** laço fechado de 8 s (`clients × window` em voo). `serverCpu` é a CPU do processo do backend (ps);
  `clientCpu` é a do harness.

Reproduzir:

```sh
CONVEX_KNOBS=s256 docs/spikes/local-bench/up-convex.sh &      # Convex em :3210
ROUND=2 bun --conditions=@freecorps/ember-source run docs/spikes/local-bench/bench.ts
# por partes: BACKENDS=ember ONLY=n,a DUR_MS=4000
# perfil de CPU do shard (V8 via inspector): bun --conditions=@freecorps/ember-source run docs/spikes/remote/scripts/profile-shard.ts incr 60000 100 6
```

Números brutos em `evidence/local.json`:
- `convex#1` e `ember#1`: rodada 1, Convex com os knobs padrão e Ember com o group commit por timer (`main`);
- `convex#2` e `ember#2`: rodada 2, Convex S256 com banco novo e Ember com o group commit `auto` deste branch.

Logs em `evidence/local-{1,2}.txt`.

## Resultado (rodada 2)

| Cenário | Convex local (S256) | Ember (`auto`) | Ember ÷ Convex |
|---|---|---|---|
| noop, 1 em voo: ack p50 | 1,04 ms | **0,10 ms** | **10×** |
| noop, 6×100: vazão | 1.525/s (p50 383 ms) | **68.549/s** (p50 8 ms) | **45×** |
| doc quente (`incr`), 1 em voo: ack p50 | 1,63 ms | **0,13 ms** | **12,5×** |
| doc quente, 6×10: vazão / p99 | 493/s / 2.574 ms | **24.444/s / 6 ms** | **50× / 420×** |
| doc quente, 6×100: vazão / p99 | 345/s / 14.840 ms | **32.065/s / 29 ms** | **93× / 510×** |
| doc quente, 60×1: vazão | 360/s | **14.215/s** | **39×** |
| inserts espalhados, 1 em voo: ack p50 | 1,31 ms | **0,13 ms** | **10×** |
| inserts espalhados, 8×50 | 1.377/s | **29.572/s** | **21×** |
| inserts espalhados, 32×50 | 1.763/s | **30.900/s** ¹ | **17,5×** |
| point query (`counter`), 1 / 4 concorrentes: p50 | 0,59 / 1,52 ms | **0,06 / 0,16 ms** | **10×** |
| `recent(10)` pelo socket, 8×50: vazão | 507/s ² | **15.578/s** | 31× ² |
| fan-out, 100 inscritos: entrega p50 / p99 | 26,1 / 34,3 ms | **6,6 / 11,5 ms** | **4×** |
| fan-out, 1.000 inscritos: entrega p50 / atualizações | 117,6 ms / **26%** | **25,9 ms / 100%** | **4,5×** |
| cliente novo, primeiro resultado p50 | 0,33 ms | 0,35 ms | 1× |
| bytes por atualização | 474 | **255** | 1,9× |
| CPU do servidor por mutation sob carga | ~1.800–2.200 µs | **15–34 µs** | **60–140×** |
| erros | 0 (muitos `OptimisticConcurrencyControlFailure` + reconexões no doc quente) | 0 | |

¹ Localmente todos os DOs do Miniflare dividem uma thread do workerd: 8 ou 32 shards dão a mesma vazão de 1 shard
(~31k/s). Em produção cada DO tem a sua; a escala horizontal só se mede no remoto (`../remote/bench.md`: 23k/s em 32
shards).

² A persistência SQLite local do Convex lê `by_n` em ordem desc em tempo linear no tamanho da tabela:
- 1 em voo: 5,5 ms com 2 mil linhas e ~106 ms com ~45 mil, mesmo com `limit: 1`;
- `latest` (por `_creationTime`) e `counter` ficam abaixo de 1 ms.

Isso é do backend local e não representa o Convex cloud (lá, query p50 ≈ RTT; ver `../remote`). Por isso a comparação de
query justa é o point read: 10×.

### O que o group commit `auto` mudou no Ember (rodada 1 → 2, mesmo harness)

| Cenário | Ember `main` (timer) | Ember `auto` | |
|---|---|---|---|
| noop 1 em voo: p50 | 1,77 ms | **0,10 ms** | 17× |
| `incr` 1 em voo: p50 | 2,19 ms | **0,13 ms** | 17× |
| `put` 1 em voo: p50 | 2,32 ms | **0,13 ms** | 18× |
| fan-out 100 / 1.000: entrega p50 | 9,6 / 32,0 ms | **6,6 / 25,9 ms** | 1,2–1,5× |
| cliente novo (shard quente / novo) p50 | 0,83 / 3,44 ms | **0,35 / 2,52 ms** | 1,4–2,4× |
| vazão sob carga (noop, `incr`, `put`) | 73,5k / 32,0k / 30,5k/s | 68,5k / 32,1k / 29,6k/s | igual (±7%, ruído) |

Com o timer, o Ember era **mais lento** que o Convex numa mutation sozinha (1,77 contra 1,04 ms). Agora é 10× mais
rápido.

## Onde vai o tempo

### 1. Latência fixa: `setTimeout(0)` no workerd custa ~1,6 ms

Piso medido no mesmo workerd (`floor`, eco de WebSocket com 1 em voo, p50):

| Caminho | p50 |
|---|---|
| Bun ⇄ Bun | 0,018 ms |
| Bun ⇄ Worker | 0,027 ms |
| Bun ⇄ Worker → DO (hibernação) | 0,034 ms |
| + `transactionSync` com 1 INSERT por mensagem | **0,067 ms** |
| + `setTimeout(0)` antes de responder | **1,649 ms** |

O group commit da `main` agenda o commit com `setTimeout(drain, windowMs ?? 0)`, e só isso já era a latência inteira de
uma mutation.

**Feito neste branch** (`shard.ts`, modo `auto`, o padrão quando `groupCommit.windowMs` não é definido):
- um shard ocioso faz o commit no fim do frame que trouxe a mutation, ou num microtask para RPC;
- enquanto as escritas do último commit são confirmadas (`storage.sync()`), as mutations que chegam esperam e saem
  juntas quando ele resolve.

O resultado é o group commit líder/seguidor clássico:
- **latência mínima quando ocioso;**
- **o lote cresce com a carga**, e a vazão é a mesma do timer;
- `windowMs` explícito mantém o comportamento antigo. A suíte do runtime roda nos dois modos (`GROUP_COMMIT=auto`,
  180/180).

Em produção, `sync()` espera a replicação (alguns ms), então os lotes devem ficar maiores que no local. É preciso medir
(ver "Remoto").

O Ember está em 0,10 ms contra um piso de 0,067 ms. Num perfil sequencial sobram ~35 µs de JS por mutation:
- dedup: a mutation `noop` não muda nada, então não tem linha de change log e o resultado vai para a tabela de dedup
  (`spill`, 1 INSERT) e é procurado ali depois (`dedupLookup`);
- `armAlarm`;
- `deserializeAttachment`, chamado 2× por frame.

### 2. Sob carga: o shard satura um núcleo; SQL e JS do engine dividem o tempo

Perfis com 6×100 em voo (`profile-shard.ts`, Miniflare em memória):

| Mutation | µs/op | Onde |
|---|---|---|
| `noop` | 14 | 45% em SQL de dedup (`spill` + `dedupLookup`); `SAVEPOINT` por item 9% |
| `incr` (`unique()` + `patch`) | 29 | SELECT do `unique()` 31%; UPDATE 7% |
| `put` (insert, 1 índice) | 35 | INSERT ~46% pelo perfil; o resto é JS do engine (validação, `encodeFields`, `docKey`, ULID, `toJSONValue`/`stringifyValue` do change log) |

Microbench do DO SQLite no workerd (por linha):

| Operação | µs |
|---|---|
| INSERT, 1 statement | 3,85 |
| INSERT, mesmo statement com o wrapper do `DoSqlDriver` (`columnNames`, `raw()`, contadores) | 4,05 |
| INSERT de 100 linhas via `json_each` | 2,2 por linha |
| SELECT por índice | 4,4 |
| `SAVEPOINT` + `RELEASE` | 1,05 |
| `Map.get` em memória | **0,05** |

Ressalva: o perfil V8 com amostragem de 100 µs parece exagerar a fatia nativa. Pela diferença direta entre `put` e
`noop` (~21 µs), um insert custa ~4 µs de SQL e ~15 µs de JS. A divisão exata precisa de contadores no driver (ver mapa).

### 3. Fan-out: ~3,3 µs por inscrito por atualização no shard

Com 500 inscritos, 40% do tempo do shard é o `ws.send` nativo (chamado dentro de `flushSockets`) e 11% é `rerun`:
- `split` por inscrito;
- montagem do patch por socket.

No harness, o gargalo de parede é o cliente (500 `EmberClient` num processo).

## Mapa: o que dá para acelerar

Ordem: ganho esperado ÷ esforço. "Evidência" é o que está medido aqui.

| # | O quê | Evidência | Ganho esperado | Esforço / risco |
|---|---|---|---|---|
| ~~0~~ | ~~Group commit sem timer~~ | **revertido**: o ganho de 17× é só do workerd local; em produção `setTimeout(0)` ≈ 0 e o `auto` perdeu no A/B (`../remote/perf-remote.md` §2) | — | — |
| **0a** ✅ | **`maxBatch` padrão maior** (feito: 500) (500, ou adaptativo pelo tamanho da fila) | produção: com frames em lote o shard quente bate em 100 por commit; 500 dá +29% e p50 109 → 80 ms | +29% no shard quente | baixo (uma transação maior: ~30 ms de CPU por lote em produção) |
| **0b** | **Frames em lote em todo cliente** (SDKs de terceiros, HTTP em rajada, loadgen) | produção: 2.585 → 5.715/s no shard quente | 2,2× no shard quente | baixo |
| 1 | **Outcome de mutation sem mudança no anel**, não na tabela de dedup: guardar o resultado na memória e no anexo até o `ack`, ou gravar a linha do anel mesmo sem `changes` | noop: 45% do shard; 1 linha escrita por mutation (fatura) | 1,8× em mutations idempotentes ou recusadas (`markRead` já lido, validação de negócio); −1 row written | baixo |
| 2 ✅ | **SQL fixo por commit em memória** (feito): `getMeta("next_maint")` em todo `recordCommit`; `armAlarm` → `nextGcAt` + `getMeta` em todo commit. O próximo alarme e o maint podem ficar em memória, recalculados só quando `_jobs`/`_files` mudam | `armAlarm` 11,9% inclusivo no perfil sequencial (timer) | ~10% na latência e na CPU por commit | baixo |
| 3 ✅ | **JSON numa passada** (feito) (`encodeJson`/`decodeJson`): hoje é `toJSONValue` (cópia) + `JSON.stringify`, e `JSON.parse` + `fromJSONValue` (cópia). Caminho rápido: `JSON.stringify` direto quando não há bigint/bytes/não finitos (checagem barata ou replacer), e parse sem cópia quando o texto não tem `"$` | `toJSONValue` 3–3,5% + `stringifyValue` 2% + `parseValue`/`fromJSONValue` ~2% sob carga; também no cliente | 5–8% de CPU do shard; mais no fan-out e em snapshots grandes | baixo |
| 4 ✅ | **`deserializeAttachment` uma vez por frame** (feito: cache por socket) (hoje 2×: `webSocketMessage` e `handleOne`); o mapa `attachments` por `sid` já existe | 2,9% do sequencial | 2–3% | baixo |
| 5 | **Contexto da mutation preguiçoso:** `writer()` cria `reader`, `FileStore` (2×: em `writer` e em `mutateIn`), `scheduler`, `runQuery`, `runMutation`, `ctx.sql`, `storage` e `maintainers` em toda chamada; basta criar no primeiro acesso (getters) | GC 3–5% sob carga | 5–10% | baixo/médio |
| 6 ✅ | **Lote sem `SAVEPOINT` por item** (feito: um savepoint para o lote; refeito item a item só se algum falhar; `put` 6×100 27,2 → 18,1 µs/op): rodar o lote numa transação só e, se um item falhar, desfazer tudo e reexecutar sem ele (falha é rara) | `transactionSync` 6–9% sob carga; 1,05 µs + JS por item | 5–9% | médio (semântica de erro igual, testes de `group-commit`) |
| 7 | **Cache de linhas e índices em memória (write-through):** o DO é o único escritor do seu SQLite, então leituras por id e ranges recentes podem sair da memória. Mutations (`unique()` do doc quente), reexecução de inscrições e queries avulsas deixam de ir ao SQLite | SELECT 4,4 µs contra `Map.get` 0,05 µs; `incr`: 31% no SELECT | 1,3–1,5× em read-modify-write; 2–5× em reexecuções de fan-out com muitas queries distintas | alto (orçamento de 128 MB, despejo, rollback de savepoint, invalidação por migração/restore) |
| 8 | **Cache de resultado para query avulsa** (`q` e HTTP): hoje só reaproveita se alguém está inscrito na mesma chave. LRU por `(fn, args, identidade)` invalidado pelo índice de read-sets que já existe | `q` 8×50 = 15,6k/s, ~65 µs/op de CPU | 3–10× em leituras repetidas (listas, perfis) | médio |
| 9 | **Fan-out mais barato:** pré-codificar o patch por entrada (o corpo só muda no `qid` e nos `mids`), tirar o `split("\n")` por inscrito (guardar `{sid, qk}`), juntar inscritos lentos (backpressure, mandar só o último valor) | 3,3 µs por inscrito por atualização; 40% no `ws.send` (fixo) e 11% no `rerun` | 1,3–1,5× no fan-out | médio |
| 10 | **Manutenção incremental de resultado (IVM)** (adiado em 2026-11-14: com o cache compartilhado, uma lista vista por N usuários é 1 entrada; a query é 44 de 57 µs por reexecução em `take(50)`, contra ~8,5 ms dos envios para 300 inscritos; só paga com muitas variações distintas por commit) para `withIndex` + `take`/`paginate`: um insert ou delete dentro do range atualiza o resultado em cache sem reexecutar a query | `rerun` cresce com o número de queries distintas afetadas | 5–20× quando muitos usuários assinam variações da mesma lista (chat, inbox) | alto |
| 11 | **Escrita em lote por commit (write-behind)** (adiado: depende do overlay do #7 para leituras dentro do lote): juntar os INSERTs do lote num statement (`json_each`); exige o overlay do #7 para leituras dentro do lote | INSERT 3,85 → 2,2 µs/linha | ~1,2× em `put` sob carga (o JS domina) | alto; fazer depois do #7 |
| 12 (parcial ✅) | **JS do insert:** validação compilada a partir do `Shape` (feita: predicado por Shape, o interpretador só na falha; `returns` em `take(50)` 17,1 → 8,8 µs) (função gerada por schema, sem interpretar a árvore), ULID mais barato (`ulid` + `makeIdMicros` ~4%), `docKey`/`encodeKey` sem alocação | ~15 µs de JS por insert | 1,3–1,5× em `put` | médio |
| 13 | **Cliente:** `ack` de carona no próximo frame de saída (hoje vai num `setTimeout(0)` próprio: ~1,1 frame enviado por mutation sequencial, e cada frame é um evento do DO, 1/20 de request na fatura); `pending.indexOf` + `splice` O(n) por `settle`; `emitState` por mutation | ~16 µs de CPU por mutation no cliente | menos eventos no DO e menos CPU no browser/RN | baixo |
| 14 | **Protocolo binário** (msgpack ou CBOR, previsto no PLAN §4) | `parseFrame` 1–3%; bytes 255 contra 474 do Convex | 1,3–2× em banda; pouco em CPU | médio (os dois lados e a compatibilidade) |
| 15 (parcial ✅) | **Medição contínua:** contadores no `DoSqlDriver` (feito: statements e linhas por tipo e transações no `inspect()` e em `GET /api/_ember/inspect`; tempo por tipo não, o relógio não anda em produção), batch sizes e latência de `sync()` no `inspect()`/métricas, e este bench no CI local como guarda de regressão | o perfil V8 distorce a fatia nativa | decide o resto com números | baixo |

Em produção, a CPU por mutation é ~200 µs (`../remote/perf-remote.md` §3), então #1–#6 e #12 pesam ~6× mais que aqui.

**Combinação esperada no shard** (local, sob carga):
- #1–#6 juntos: ~1,4–1,8× de CPU por mutation;
- #7 + #12: mais 1,5–2× em read-modify-write e insert.

O doc quente passaria de 32k/s para ~60–80k/s, contra 345/s do Convex local: 170–230×.

### "100× mais rápido": onde dá e onde não dá

- **Já passou de 100×:**
  - cauda do doc quente (p99 420–510×: o Convex entra em tempestade de OCC);
  - CPU de servidor por mutation (60–140×).
- **Perto, e o mapa leva além:** vazão sob carga (45–93× hoje). Com #1–#7, doc quente e inserts por shard passam de
  100×.
- **Teto físico de ~15×: latência de uma chamada.**
  - O piso do workerd é 0,067 ms (eco no DO + INSERT), contra ~1 ms do Convex.
  - Em produção os dois pagam o RTT até o datacenter, então a latência percebida vem de colocar o shard perto do usuário
    (§5 do PLAN: hoje não há DO na América do Sul), de update otimista e de query local (`@freecorps/ember-offline`:
    0 RTT).
- **Fan-out (4–4,5×):** o `ws.send` por socket é fixo. Ganha com #9/#10 e já entrega 100% das atualizações contra 26%
  do Convex com 1.000 inscritos.
- **Primeiro resultado (1×):** empate local (0,33 ms). Em produção pesa o cold start do DO, que precisa ser medido de
  novo.

## Ressalvas

- **Convex local não é o Convex cloud:** SQLite local em vez da persistência de produção, e um nó só. As queries por
  índice em ordem desc degradam com o tamanho da tabela (nota ²). Os números de mutation e de OCC batem com o remoto
  (doc quente: 18–45/s no cloud).
- **Ember local divide uma thread entre todos os DOs:** a escala horizontal não aparece aqui.
- **Mesma máquina:** cliente e servidor competem por CPU. O cliente do Ember usou até 33% de um núcleo; o servidor do
  Convex, até 365% (multithread).
- **Pouca repetição:** 8 s por caso e uma rodada por configuração. As diferenças de 10× ou mais estão muito acima do
  ruído; as de ±10% não.

## Remoto

Feito: `../remote/perf-remote.md` traz a sonda da plataforma, o A/B do group commit dentro da Cloudflare, a CPU por
mutation pelas métricas da conta, o protocolo em lote, o `maxBatch` e o Convex cloud × Ember pelo laptop (rodada 7).

## Reatividade, wake e DX (2026-11-14)

Análise sobre a `main` (a572660): o caminho de escrita já estava enxuto; a alavanca era a reatividade com usuários
logados (a chave do cache incluía a identidade: N usuários na mesma lista = N reexecuções por commit), depois o wake e a
reconexão em massa, depois a latência percebida. Tudo no mesmo laptop (Apple M3), mesmo harness antes e depois, mediana
de pelo menos 3 rodadas. Evidências em `evidence/`:

- `reactive.ts` (Miniflare, sockets crus, CPU do processo do workerd por commit): `reactive-baseline.txt`,
  `reactive-1-shared.txt`, `reactive-2-docjson.txt`, `reactive-3-wake.txt`, `reactive-final.txt`;
- `rerun.ts` (engine sobre `node:sqlite`): `rerun-baseline.txt`, `rerun-2a-compiled-validators.txt`, `rerun-2b-doc-json.txt`;
- `ab-shard.sh` (`profile-shard.ts`, agora com 0,1 µs e mediana de 5): `ab-baseline-pr.txt`, `ab-pre-6.txt`, `ab-post-6.txt`;
- `client-frame.ts`: `client-frame.txt`; `first-data.ts` (proxy com RTT simulado): `first-data.txt`.

| Etapa | Cenário | Antes | Depois | |
|---|---|---|---|---|
| 1. Cache compartilhado entre identidades | 300 usuários logados na mesma lista `take(50)`, CPU por commit | 52,0 ms | **8,45 ms** | **6,2×** (19 → 104 commits/s; p50 52,7 → 9,4 ms) |
| 1. `authorize` | mesma lista com checagem de acesso: `authorize` × checagem no handler | 53,5 ms | **8,65 ms** | **6,2×** |
| 2. JSON por documento | reexecução `take(50)` / `take(200)` | 70,9 / 247 µs | **57,4 / 198 µs** | −19% / −20% (JSON + diff 28,4 → 13,9 µs) |
| 2. Validadores compilados | `returns` em `take(50)` / reexecução tipada | 17,1 / 88,0 µs | **8,8 / 67,2 µs** | −48% / −24% (com o item anterior) |
| 2. (fim a fim) | 300 entradas por identidade, CPU por commit | 52,35 ms | 49,1 ms | −6% |
| 3. Wake sem reexecutar | 2.000 inscrições distintas, primeira resposta após hibernar | 232 ms | **4,0 ms** | **58×** |
| 3. (custo movido) | idem, primeira mensagem é um commit: até o último patch | 482 ms | 494 ms | +2,5% (faixas 478–488 × 479–499; CPU 510 ms nos dois) |
| 4. Memo do `resume` | 500 sockets × 4 listas reconectando juntos | 138 ms | **43 ms** | **3,2×** (CPU 140 → 40 ms) |
| 5. Anexo por frame | 10 sockets × 200 `sub` num frame, CPU por inscrição | 50 µs | **35 µs** | −30% (resume: 43 → 34 ms) |
| 5. Recompute por frame (cliente) | frame de 200 patches com 20 otimistas / 500 com 50 | 1.944 µs / 12,4 ms | **165 µs / 0,69 ms** | **12× / 18×** |
| 6. HTTP-first | cliente novo, RTT 180 ms: anônimo / token em storage / token por HTTP | 396 / 397 / 396 ms | **189 / 189 / 376 ms** | 2,1× / 2,1× / −5% |
| 7. Lote sem savepoint por item (#6) | `put` / `incr` / `noop` 6×100 | 27,2 / 26,5 / 12,8 µs | **18,1 / 24,6 / 11,7 µs** | −33% / −7% / −9% |

Notas:
- **1:** o engine marca a execução que leu `ctx.auth` (middlewares, `authorize`, `runQuery` aninhado). A entrada
  compartilhada que passa a ler a identidade é dividida antes de qualquer envio; o fuzz (`shared-cache.test.ts`, 3
  sementes) compara cada socket com uma execução por identidade. A checagem dentro do handler continua correta, mas por
  usuário (o `ember dev` avisa).
- **3:** o boot não cresce mais com o número de queries; o trabalho vai para o primeiro commit (ou para lotes de fundo
  quando a primeira mensagem não é commit). Produção paga o mesmo; o ganho é em wakes por `sub`, `q`, HTTP ou `ack`.
- **6:** a borda termina TCP/TLS perto do cliente, então o que se economiza é o round trip do upgrade até o DO. Com o
  token buscado por HTTP, o token já custa esse round trip: quase nada a ganhar, e o cliente só usa HTTP-first se o socket
  ainda não abriu quando o token chega.
- **Deixados de fora:** IVM (#10, ver o mapa), INSERT único por commit (#11, precisa do overlay do #7) e **chaves de
  índice mais curtas (item 8)**. Medido em `node:sqlite` (20 mil linhas, 1 índice): a chave `by_n` tem 52 B, dos quais
  43 B são o sufixo `_creationTime, _id`, e `_k_by_creation_time` grava mais 43 B por linha (linha 242 B, entrada do
  índice 76 B): cortar os dois economizaria ~35% do tamanho. Mas muda o formato do armazenamento de shards em produção
  e das réplicas offline (mesmo DDL) e invalida cursores de paginação que clientes já têm (o cursor é a chave
  codificada); a conversão segura e o teste de migração não cabiam nesta rodada.
- **Pendente em produção:** CPU por commit do fan-out autenticado (métricas da conta), wake real de DO em produção,
  HTTP-first com a borda real (VCP → MIA), `put` sob carga com um savepoint por lote. Extrapolação, não medida: se a CPU
  de produção é ~4× a do laptop por operação, 300 usuários logados numa lista sairiam de ~200 ms para ~35 ms de CPU por
  commit.

## Paginação, patches e cliente (2026-11-14, rodada 2)

Depois da rodada anterior o shard estava perto do piso da plataforma (no fan-out, a maior parte é o `ws.send` nativo:
um DO que só faz o laço de envio para 300 sockets gasta 5,2–6,3 ms dos 8,2 ms do Ember; pré-codificar frames muda menos
de 7%, então não foi tocado). O que sobrava de grande estava na paginação, no formato dos patches de listas dentro de
objetos e no cliente. Mesmo laptop (Apple M3), mesmo harness antes e depois, mediana de pelo menos 3 rodadas; o "antes" é
a `main` em `32eb80f`, e os harnesses que ganharam métricas depois do baseline foram rodados de novo contra ela num
worktree à parte. Harnesses novos: `pagination.ts` (o hook React real em happy-dom + `EmberClient` + Miniflare pelo
proxy com RTT simulado de `first-data.ts`, agora em `lib.ts`), `client-apply.ts` e `client-render.ts` (aplicar um patch;
aplicar + render React de linhas `memo`), `reopen.ts` (reabrir com valor em cache, SSR), `bundle.mjs`; cenários novos no
`reactive.ts` (`fanout-page`, `fanout-obj`, `fanout-liked`; os sockets crus agora pedem `vdiff`). Evidências em
`evidence/`: `*-baseline*.txt` e `ab-round2-before.txt` (antes), `pagination-1-fixed.txt`, `*-2-vdiff.txt`,
`offline-persist-2-vdiff.txt`, `reopen-3-resume.txt`, `reactive2-4-nested.txt`, `*-final.txt` e `ab-round2-after.txt`
(árvore final), `bundle.txt`.

| Etapa | Cenário | Antes | Depois | Variação | Como |
|---|---|---|---|---|---|
| 1. Fronteira fixa | 6 páginas de 20 carregadas, item novo no topo (RTT 180 ms): `sub`/`unsub` enviados | 5 / 5 | **0 / 0** | −100% | `pagination.ts` |
| 1. | idem: snapshots completos recebidos | 5 | **0** | −100% | `pagination.ts` |
| 1. | idem: tempo até a lista completa de novo | 1 017 ms (5,65 RTT) | **97 ms (0,54 RTT)** | **10,5×** (só a ida do patch) | `pagination.ts` |
| 1. | idem: menor tamanho da lista exposta na transição | 20 | **120** (nunca encolhe) | — | `pagination.ts` |
| 1. | idem, 3 páginas: reinscrições / tempo | 2 / 463 ms | **0 / 96 ms** | 4,8× | `pagination.ts` |
| 1. | carregar as 6 páginas (fixar incluído): bytes / snapshots completos | 32 293 B / 4 | 32 613 B / 4 | +1% (5 frames `unchanged`) | `pagination.ts` (`load*`) |
| 1.+2. | 6 páginas, item novo: bytes recebidos | 48 053 B | **522 B** | **92×** | `pagination.ts` |
| 2. `vdiff` | 300 inscritos num `paginate()` de 50: CPU do shard por commit | 15,5 ms | **9,1 ms** | **−41%** (8,75 na rodada da etapa; array no topo: 8,55) | `reactive.ts fanout-page` |
| 2. | idem: bytes por patch | 9 099 | **425** | **21×** | `reactive.ts fanout-page` |
| 2. | 300 inscritos em `{ title, items }`: CPU por commit / bytes por patch | 15,0 ms / 9 011 | **8,65 ms / 329** | −42% / 27× | `reactive.ts fanout-obj` |
| 2. | aplicar no cliente um item novo num `{page}` de 50 | 14,2 µs, 50 de 50 docs com identidade nova | **5,2 µs, 1 de 50** | 2,7× | `client-apply.ts` |
| 2. | valor inteiro de 500 docs (ressubscrição, servidor/cliente sem diff): só aplicar | 125,8 µs | 219,4 µs | **+74%** (a comparação que reaproveita) | `client-apply.ts big/full` |
| 2. | idem, aplicar + render React de linhas `memo` | 630 µs, 500 linhas renderizadas | **485 µs, 1 linha** | −23% (470 na rodada da etapa) | `client-render.ts` |
| 2. | offline: 100 mudanças de 1 linha num `{page}` de 500 (só cache, SQLite) | 15 146 KiB gravados | **202 KiB** | **75×** | `persist-size.test.ts` |
| 3. `resume` do que o cliente tem | reabrir com o cache offline: bytes até o valor confirmado | 19 798 | **323** | **61×** (mesmo 1 RTT: 190 → 191 ms) | `reopen.ts offline-reopen` |
| 3. | visita repetida com `snapshotCache`: primeira pintura / bytes | 188 ms / 19 798 | **1 ms / 323** | 0 RTT / 61× | `reopen.ts repeat-visit` |
| 3. | SSR hidratado: primeira pintura / bytes no navegador | 190 ms / 19 798 | **0 ms / 217** | 0 RTT / 91× | `reopen.ts ssr-hydrate` |
| 4. `ctx.runQuery` reaproveitado | 300 usuários, query por usuário sobre a lista comum + "curtido por mim": CPU por commit | 58,5 ms | **25,9 ms** | **2,3×** (17 → 38 commits/s; 28,9 ms na rodada da etapa) | `reactive.ts fanout-liked` |
| 4. | idem, custo da cópia por usuário (proteção) | — | ~15 µs/usuário (24,3 ms sem cópia) | +11% sobre o sem cópia | variante temporária sem cópia |
| — | sem regressão: fan-out anônimo / 300 usuários / `authorize` / `authz` no handler | 8,35 / 8,2 / 8,4 / 49,0 ms | 8,55 / 8,6 / 8,75 / 49,15 ms | +2–5% (ver nota) | `reactive.ts` |
| — | sem regressão: wake (1ª resposta / com commit), resume em massa, sub-burst | 3,88 / 491 / 41,8 / 71,2 ms | 3,89 / 487 / 38,4 / 70,6 ms | igual | `reactive.ts` (`reactive-final.txt` da #77) |
| — | sem regressão no caminho de escrita: `noop` / `put` 60 000 × janela 100 × 6 clientes; `put` com 100 inscritos | 11,9 / 18,4 / 3 107 µs | 12,0 / 21,1 / 3 053 µs | intercalado: `put` 20,2 → 19,4 µs | `ab-shard.sh`, `ab-round2-interleaved.txt` |
| — | bundle, app só com `EmberClient` (min / gzip) | 38,9 / 12,7 KB | 47,5 / 14,9 KB | **+8,6 / +2,2 KB** | `bundle.mjs` |
| — | bundle, app com os hooks e `usePaginatedQuery` | 41,6 / 13,8 KB | 54,3 / 17,1 KB | +12,7 / +3,3 KB | `bundle.mjs` |
| 5. Contadores | por mutation (insert, WS + ack): statements / linhas lidas / gravadas / transações | — | 2,15 / 3,6 / 2 / 3 | travados em ≤ 2,5 / 4 / 2 / 3 | `perf-counters.test.ts` |
| 5. | reexecuções por commit, 10 usuários: lista sem `ctx.auth` / `authorize` / checagem no handler / visão por usuário sobre `ctx.runQuery` | — | 1 / 1 / 10 / 10 (9 aninhadas do memo) | travados | `perf-counters.test.ts` |
| 5. | frames por inscrito por commit; bytes por patch (array rowdiff, `paginate()` vdiff; clientes antigos) | — | 1; 209, 367 (7 209, 6 919) | travados | `perf-counters.test.ts` |

Notas:
- **Rótulos:** tudo na tabela é **medido** neste laptop. "Lido do código" e "extrapolação" vão marcados abaixo.
- **1:** o tempo depois é o da ida do patch (RTT/2 = 90 ms + processamento): o item novo cai na página 1, que cresce, e as
  outras nem são reexecutadas (o read set delas não contém a linha). Fixar uma página é um `sub` com `resume` do valor
  que o cliente já tem, respondido `unchanged`; a página antiga é solta no mesmo turno. Divisão (página com mais que o
  dobro) e fusão (página vazia) baixam páginas inteiras, mas uma vez a cada `n` itens novos (**extrapolação**: ~2
  documentos baixados por item novo no regime, contra 1 do `vdiff`; não medido, o harness não chega a dividir). Testes:
  `packages/client/test/paginate.test.ts` (inclui fuzz de inserções, remoções e `loadMore`, 4 sementes no `check`, 60
  rodadas à parte), o hook em `packages/react/test/hooks.test.tsx` e o E2E no workerd contra o shard real
  (`client.workerd.test.ts`: 0 `sub`/`unsub`, 0 snapshots, 1 change por item novo).
- **2:** o shard paga menos porque manda 21× menos bytes (o custo de `ws.send` cresce com o tamanho do frame, como
  medido antes da rodada: 31 µs × 17–19 µs por socket entre página inteira e diff) e não codifica a página inteira por
  inscrito. O reaproveitamento de identidade num valor que chega inteiro custa uma comparação (+88 µs em 500 docs) e
  economiza o render das linhas iguais; no happy-dom a conta já fecha (−145 µs); num DOM real o render custa mais
  (**extrapolação**: ganho maior). `vdiff` só sai quando é menor que o valor inteiro; o fuzz de `valuediff.test.ts`
  compara o valor reconstruído (mesmo texto JSON) com o inteiro, e `rowdiff.test.ts` do runtime faz o mesmo pelo shard
  real com um cliente antigo ao lado (que nunca recebe `vdiff`).
- **3:** com `httpFirst`, o `POST /api/query` leva o mesmo `resume` e volta `unchanged` sem valor: o valor confirmado
  chega no mesmo 1 RTT de antes. Sem isso o cache só seria confirmado depois de o socket abrir (medido: 397 ms, 2 RTT),
  por isso o campo aditivo. No SSR o "confirmado" é o valor que o servidor renderizou (o socket o confirma com
  `unchanged` depois). Segurança em `packages/client/test/resume-cache.test.ts` (troca de conta, token expirado, token
  recusado pelo shard, sign-out, erros, limite de tamanho, época nova), `packages/offline/test/resume.test.ts` (dono por
  registro, 4 backends) e o E2E no workerd (HTTP e socket `unchanged` contra o shard real).
- **4:** a hipótese pagou. O que sobra por usuário (~85 µs): a cópia da lista (~15 µs), a junção dele, o JSON do valor
  dele, o diff e o envio. Fuzz em `shared-cache.test.ts` (3 sementes, agora com quatro queries aninhadas, uma que altera
  o resultado no lugar) comparando cada socket com uma execução nova por identidade, e `nested-memo.test.ts` no engine.
- **Sem regressão:** os fan-outs de array saíram 2–5% acima do baseline do mesmo dia (8,35 → 8,55 ms). No A/B
  intercalado (`ab-round2-interleaved.txt`: antes, depois, antes, depois, na mesma sessão) o `fanout-anon` oscilou de
  8,8 a 11,1 ms nos dois lados sem tendência (a máquina estava mais carregada) e o `put` saiu 20,2 → 19,4 µs (medianas
  de 6): ruído, não regressão. O `put` de 21,1 µs do `ab-round2-after.txt` tem uma rodada de 28,7 µs entre 18,2 e 23,6. O
  caminho de escrita não mudou nesta rodada (o memo aninhado nasce uma vez por versão, só quando uma query roda).
- **Bundle:** o cliente cresceu 2,2 KB gzip para quem não pagina (o `resume` de cache, hidratação e o `applyValueDiff`) e
  3,3 KB com a paginação nova. **Não feito, o item opcional:** tirar `validate.ts` (6,9 KB min) do caminho de quem não usa
  a opção `validate` exige mudar a forma da opção (uma função vinda do `_generated/validators`) ou um import de registro;
  as duas quebram quem passa os shapes de hoje (deixariam de validar, ou lançariam).
- **Pendente em produção:** CPU por commit de `fanout-page`/`fanout-obj`/`fanout-liked` nas métricas da conta (lá a CPU
  por operação foi ~4–6× a daqui); paginação e reabertura com a borda real (VCP → MIA: aqui o RTT é de um proxy TCP;
  a forma — 0 contra K round trips, 1 RTT para confirmar um cache — deve se manter, os milissegundos não); o cache leve
  em navegadores e no React Native (custo de gravar um blob de até 512 KiB a cada 250 ms no `localStorage`/AsyncStorage);
  `reuseUnchanged` em celulares fracos.

### Mapa depois da rodada 2

1. **Envio por socket** continua sendo a maior parte do fan-out (17–21 µs por socket no `ws.send` nativo). Sai do mesmo
   jeito de antes: menos sockets (multiplexar shards num socket só do cliente, PLAN §10) ou broadcast DOs (fora do escopo).
2. **Visão por usuário** (`fanout-liked`, 25,9 ms): o que sobra é por usuário e é codificação (JSON do valor dele, o
   diff). Um próximo passo seria deixar a aninhada devolver o valor congelado e sem cópia (opt-in), o que permitiria
   reaproveitar o JSON de cada documento entre usuários (**extrapolação**: ~24 ms medidos sem a cópia; o JSON por usuário
   ainda ficaria).
3. **Divisão de página** baixa uma sonda e meia página: um cursor do meio dado pelo servidor (campo aditivo do
   `paginate()`) evitaria a sonda, mas um validador `returns` escrito à mão recusaria o campo novo; não feito.
4. **Bundle do cliente:** `validate.ts` (6,9 KB) só sai do caminho padrão com uma mudança na opção `validate` (próxima
   versão maior).
5. **Offline antes do token:** o adaptador offline usa a identidade guardada da sessão anterior até o token chegar (como
   antes); quando o token diz outra, os valores mostrados saem. O cache leve espera o token.

