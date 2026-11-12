# Bench local: Ember × Convex (performance bruta)

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
| **0** | ✅ **Group commit sem timer** (`auto`, este branch) | piso: `setTimeout(0)` = 1,6 ms | **17× na latência de mutation**, vazão igual | feito; falta medir `sync()` em produção |
| 1 | **Outcome de mutation sem mudança no anel**, não na tabela de dedup: guardar o resultado na memória e no anexo até o `ack`, ou gravar a linha do anel mesmo sem `changes` | noop: 45% do shard; 1 linha escrita por mutation (fatura) | 1,8× em mutations idempotentes ou recusadas (`markRead` já lido, validação de negócio); −1 row written | baixo |
| 2 | **SQL fixo por commit em memória:** `getMeta("next_maint")` em todo `recordCommit`; `armAlarm` → `nextGcAt` + `getMeta` em todo commit. O próximo alarme e o maint podem ficar em memória, recalculados só quando `_jobs`/`_files` mudam | `armAlarm` 11,9% inclusivo no perfil sequencial (timer) | ~10% na latência e na CPU por commit | baixo |
| 3 | **JSON numa passada** (`encodeJson`/`decodeJson`): hoje é `toJSONValue` (cópia) + `JSON.stringify`, e `JSON.parse` + `fromJSONValue` (cópia). Caminho rápido: `JSON.stringify` direto quando não há bigint/bytes/não finitos (checagem barata ou replacer), e parse sem cópia quando o texto não tem `"$` | `toJSONValue` 3–3,5% + `stringifyValue` 2% + `parseValue`/`fromJSONValue` ~2% sob carga; também no cliente | 5–8% de CPU do shard; mais no fan-out e em snapshots grandes | baixo |
| 4 | **`deserializeAttachment` uma vez por frame** (hoje 2×: `webSocketMessage` e `handleOne`); o mapa `attachments` por `sid` já existe | 2,9% do sequencial | 2–3% | baixo |
| 5 | **Contexto da mutation preguiçoso:** `writer()` cria `reader`, `FileStore` (2×: em `writer` e em `mutateIn`), `scheduler`, `runQuery`, `runMutation`, `ctx.sql`, `storage` e `maintainers` em toda chamada; basta criar no primeiro acesso (getters) | GC 3–5% sob carga | 5–10% | baixo/médio |
| 6 | **Lote sem `SAVEPOINT` por item:** rodar o lote numa transação só e, se um item falhar, desfazer tudo e reexecutar sem ele (falha é rara) | `transactionSync` 6–9% sob carga; 1,05 µs + JS por item | 5–9% | médio (semântica de erro igual, testes de `group-commit`) |
| 7 | **Cache de linhas e índices em memória (write-through):** o DO é o único escritor do seu SQLite, então leituras por id e ranges recentes podem sair da memória. Mutations (`unique()` do doc quente), reexecução de inscrições e queries avulsas deixam de ir ao SQLite | SELECT 4,4 µs contra `Map.get` 0,05 µs; `incr`: 31% no SELECT | 1,3–1,5× em read-modify-write; 2–5× em reexecuções de fan-out com muitas queries distintas | alto (orçamento de 128 MB, despejo, rollback de savepoint, invalidação por migração/restore) |
| 8 | **Cache de resultado para query avulsa** (`q` e HTTP): hoje só reaproveita se alguém está inscrito na mesma chave. LRU por `(fn, args, identidade)` invalidado pelo índice de read-sets que já existe | `q` 8×50 = 15,6k/s, ~65 µs/op de CPU | 3–10× em leituras repetidas (listas, perfis) | médio |
| 9 | **Fan-out mais barato:** pré-codificar o patch por entrada (o corpo só muda no `qid` e nos `mids`), tirar o `split("\n")` por inscrito (guardar `{sid, qk}`), juntar inscritos lentos (backpressure, mandar só o último valor) | 3,3 µs por inscrito por atualização; 40% no `ws.send` (fixo) e 11% no `rerun` | 1,3–1,5× no fan-out | médio |
| 10 | **Manutenção incremental de resultado (IVM)** para `withIndex` + `take`/`paginate`: um insert ou delete dentro do range atualiza o resultado em cache sem reexecutar a query | `rerun` cresce com o número de queries distintas afetadas | 5–20× quando muitos usuários assinam variações da mesma lista (chat, inbox) | alto |
| 11 | **Escrita em lote por commit (write-behind):** juntar os INSERTs do lote num statement (`json_each`); exige o overlay do #7 para leituras dentro do lote | INSERT 3,85 → 2,2 µs/linha | ~1,2× em `put` sob carga (o JS domina) | alto; fazer depois do #7 |
| 12 | **JS do insert:** validação compilada a partir do `Shape` (função gerada por schema, sem interpretar a árvore), ULID mais barato (`ulid` + `makeIdMicros` ~4%), `docKey`/`encodeKey` sem alocação | ~15 µs de JS por insert | 1,3–1,5× em `put` | médio |
| 13 | **Cliente:** `ack` de carona no próximo frame de saída (hoje vai num `setTimeout(0)` próprio: ~1,1 frame enviado por mutation sequencial, e cada frame é um evento do DO, 1/20 de request na fatura); `pending.indexOf` + `splice` O(n) por `settle`; `emitState` por mutation | ~16 µs de CPU por mutation no cliente | menos eventos no DO e menos CPU no browser/RN | baixo |
| 14 | **Protocolo binário** (msgpack ou CBOR, previsto no PLAN §4) | `parseFrame` 1–3%; bytes 255 contra 474 do Convex | 1,3–2× em banda; pouco em CPU | médio (os dois lados e a compatibilidade) |
| 15 | **Medição contínua:** contadores no `DoSqlDriver` (statements e tempo por tipo), batch sizes e latência de `sync()` no `inspect()`/métricas, e este bench no CI local como guarda de regressão | o perfil V8 distorce a fatia nativa | decide o resto com números | baixo |

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

## Remoto (próximo passo)

1. Rodar `../remote/scripts/convex-vs-ember.ts` com o runtime deste branch (doc quente, espalhado, fan-out, queries)
   contra o Convex cloud.
2. Sondar em produção, num DO:
   - quanto custa `setTimeout(0)`;
   - quanto leva `storage.sync()` depois de um commit (define o tamanho dos lotes do modo `auto`);
   - o tamanho médio de lote sob carga (`inspect().stats.batchSizes`).
3. Se `sync()` em produção for curto demais para formar lotes sob carga moderada, o modo `auto` grava mais linhas de
   change log (fatura). Opção: um piso de janela adaptativo só quando há outra mutation em voo.
