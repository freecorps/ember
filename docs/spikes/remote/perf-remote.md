# Performance em produção: sonda da plataforma, A/B de group commit e Convex cloud × Ember (2026-11-12)

Continuação de `../local-bench/RESULTS.md`, que mediu o custo bruto sem rede. Aqui tudo roda na Cloudflare e no Convex
cloud.

- **Conta:** FreeCorps; todos os recursos se chamavam `ember-spike-perf-*` ou `ember-spike-cvx-*` e foram apagados no fim
  (inventário vazio, `evidence/perf-remote-cleanup.txt`).
- **Convex:** o mesmo projeto `ember-bench` (Professional, aws-us-east-1) de `convex-vs-ember.md`.
- **Scripts:**
  - `scripts/perf-remote.ts`: sonda, deploy das variantes e carga dentro da Cloudflare com `workers/loadgen.js`;
  - `scripts/convex-vs-ember.ts`: laptop → os dois backends, rodada 7.
- **Evidências:**
  - `evidence/perf-remote.json`: `probe`, `timer#1..4`, `auto#1..2`, `frame#2`, `max500#4`;
  - `evidence/convex-vs-ember.json`: `convex#7`, `ember-us#7`, `f`, `convex-inregion`.

## 1. Sonda da plataforma (DO em MIA/EWR, p50 de 50–100 repetições)

| Medida | Produção | workerd local |
|---|---|---|
| `setTimeout(0)` | **~0 ms** (abaixo da resolução do relógio) | 1,6 ms |
| `queueMicrotask` | ~0 ms | ~0 ms |
| 1 INSERT + `storage.sync()` (confirmação durável) | **23–30 ms** | ~0,03 ms |
| 100 INSERTs numa transação + `sync()` | 25–33 ms | — |
| 2 commits seguidos + 1 `sync()` | 24–30 ms (a plataforma junta) | — |

- **O `setTimeout(0)` de 1,6 ms é do workerd local.** Em produção o timer do group commit é quase grátis.
- **O piso de uma mutation em produção é o flush durável:** ~25–30 ms. Ele custa o mesmo para 1 ou 100 linhas e
  absorve commits seguidos.
- Medir CPU pelo relógio não funciona em produção: o relógio só anda com subrequest, e até 100k round trips de JSON
  "custaram" 2 ms. A CPU real veio das métricas da Cloudflare (GraphQL `durableObjectsPeriodicGroups`, seção 3).

## 2. A/B do group commit, dentro da região

As variantes são o mesmo app (`items` com `by_n`, `bench:put`), cada uma num Worker:
- `timer`: o runtime da `main` (`setTimeout(drain, 0)`);
- `auto`: o commit no fim do frame e o próximo lote espera o `storage.sync()` do anterior (branch, commit `6c07e55`);
- `frame`: o commit no fim do frame, sem esperar o `sync()`;
- `max500`: igual a `timer`, com `maxBatch` padrão de 500 em vez de 100.

A carga vem de agentes DO do loadgen (IAD/EWR/MIA, perto dos shards), 15 s por caso, alternando a ordem das variantes.
O loadgen fala o protocolo v1 "cru": 1 mutation por frame, sem `batch`/`ack`.

| Cenário (vazão; ack p50) | timer | auto | frame |
|---|---|---|---|
| sequencial, 4 shards × 1 em voo (rodada 1 / 2) | 95/s; 36 ms / 61/s; 61 ms | 93/s; 36 ms / 61/s; 62 ms | — / 61/s; 63 ms |
| shard quente 6×1 (r1 / r2) | **129/s; 35 ms** / **110/s** | 96/s; 63 ms / 100/s | — / 120/s; 58 ms |
| shard quente 6×10 (r1 / r2) | **885/s** / **1.077/s; 47 ms** | 666/s / 732/s; 73 ms | — / 707/s; 85 ms |
| shard quente 6×100 (r1 / r2) | **3.487/s** / **3.160/s; 153 ms** | 3.339/s / 2.508/s; 201 ms | — / 1.131/s; 471 ms |
| 8 shards × 50 (r1 / r2) | 4.586/s / 5.108/s | 4.341/s / 4.695/s | — / 6.187/s |
| fan-out 100, ack do escritor p50 (r1 / r2) | **37 / 41 ms** | 67 / 76 ms | — / 85 ms |
| mutations por commit, shard quente 6×10 | 13–16 | 25–27 | **1** |

- **O `timer` vence.**
  - `auto` serializa o que a plataforma faria em paralelo: ela já junta os flushes, e esperar o `sync()` de ~30 ms
    antes do próximo lote só adiciona espera.
  - `frame` não junta mutations de frames diferentes e faz 1 commit por mutation, o que derruba o shard quente a
    1,1k/s. O commit custa ~0,9 ms fixo em produção.
- **Por isso o branch reverteu o group commit sem timer** (`6180145`). A otimização valia só para o `ember dev`, e lá
  a latência de 1,6 ms não importa.
- Entre rodadas a latência sequencial mudou de 36 para 61 ms nas três variantes juntas: posicionamento e momento da
  plataforma. Só a comparação dentro da mesma rodada vale.

## 3. CPU e linhas por mutation em produção (analytics da Cloudflare)

Nos minutos do shard quente (rodada 1), com `cpuTime` e `rowsWritten` somados por minuto e por namespace:
- **timer:** 29,4 s de CPU para ~139k mensagens de saída (~1 `mres` por mutation);
- **auto:** 22,7 s para ~117k;
- **resultado:** **~200 µs de CPU por mutation** e **~2,7 linhas escritas por mutation**.

O número inclui o custo por evento de WebSocket, porque esse protocolo manda 1 frame por mutation. No Miniflare local o
mesmo `put` custa ~30 µs. A CPU de produção custa ~6–7× a do laptop por operação, então **as otimizações de CPU do mapa
pesam ~6× mais em produção**. Com lotes cheios, o shard quente fica limitado pela CPU (~3,3k/s × 200 µs ≈ 66% de um
núcleo).

## 4. Protocolo do cliente oficial (frames em lote + `ack`) e `maxBatch`

O loadgen ganhou `batch: true` (features `batch` e `ack`, os `mut` de um turno num frame só, acks de carona), que é o
que o `EmberClient` faz.

| Cenário (variante `timer`) | 1 frame por mutation | frames em lote | lote + `maxBatch` 500 |
|---|---|---|---|
| shard quente 6×10 (r3 / r4) | 947/s; 54 ms | 1.044/s; 68 ms / 1.657/s; 32 ms | 1.134/s; 39 ms |
| shard quente 6×100 (r3 / r4) | 2.585/s; p50 198 ms | **5.715/s; 95 ms** / 5.193/s; 109 ms | **6.689/s; 80 ms**, 157 por commit |
| 8 shards × 50 (r3 / r4) | 5.759/s; 69 ms | **7.305/s; 46 ms** / 5.968/s | 6.235/s |

- **Frames em lote dobram o shard quente** (2,2×) e cortam o p50 pela metade: o custo por evento de WebSocket em
  produção é grande. Os clientes first-party já usam `batch`; outros SDKs e o loadgen antigo não.
- **Com lote, o shard quente bate no teto `maxBatch = 100`** (100,0 por commit). Com 500, sobe 29% na vazão e o p50
  cai de 109 para 80 ms. Nos casos sem fila (6×1, 6×10) a variação entre rodadas é maior que a diferença.

## 5. Laptop (Campinas) → Convex cloud × Ember, rodada 7 (clientes oficiais)

Mesmo harness de `convex-vs-ember.md`, runtime igual ao da `main` (depois do revert). RTT HTTP p50:
- Convex 155 ms (edge GRU);
- Ember 179 ms (edge VCP, DO em MIA/EWR).

O Ember entra ~24 ms atrás na rede.

| Cenário | Convex (#7) | Ember (#7) | Ember ÷ Convex |
|---|---|---|---|
| a. doc quente 6×10 | 45/s, p99 12.419 ms | **337/s, p99 292 ms** | 7,5× (p99 43×) |
| a. doc quente 6×100 | 31/s, p50 6.240 ms, p99 47.463 ms | **1.765/s, p50 309 ms, p99 536 ms** | **57×** (p99 **88×**) |
| a. doc quente 60×1 | 24/s, p99 7.888 ms | **269/s, p99 353 ms** | 11× |
| b. inserts espalhados 8×50 | 388/s, p50 941 ms | **2.057/s, p50 183 ms** | 5,3× |
| b. inserts espalhados 32×50 | 1.234/s, p50 1.187 ms | **7.774/s, p50 195 ms** | 6,3× |
| b. inserts espalhados 256×1 | 1.217/s | 1.338/s | 1,1× (RTT dos dois) |
| c. fan-out 100 (p50 / p99) | 189 / 297 ms | **181 / 221 ms** | ~1× / 1,3× |
| c. fan-out 430 (p50, atualizações) | 524 ms, **66%** | **197 ms, 100%** | 2,7× |
| d. query pelo socket (p50) | 165–166 ms | 169–172 ms | empate (RTT) |
| d. query HTTP (p50) | 163–165 ms | 177–179 ms | Convex −14 ms (o RTT do Ember é 24 ms pior) |
| e. bytes por atualização | 477 | **255** | 1,9× |
| f. cliente novo, quente / após 100 s parado (p50) | 622 / 673 ms | **480 / 519 ms** | 1,3× |

Convex dentro da região hoje (action → `ctx.runMutation`, a medida mais favorável a ele):
- `incr` no doc quente: 59/s com 60 em voo (1.348 falhas OCC) e **26/s com 600 em voo (12.737 falhas)**;
- `put`: 3.949/s com 256 em voo e 4.165/s com 800.

O Ember dentro da região:
- **um shard** faz 5,7–6,7k/s de inserts com o protocolo oficial;
- 8 shards fazem 7,3k/s;
- 32 shards fizeram 23k/s (`bench.md`, com o protocolo cru).

O doc quente com read-modify-write não foi medido dentro da região no Ember (o loadgen só tem `put`); pelo laptop ele
faz 1,8k/s contra 31/s do Convex.

## 6. O que isso muda no mapa (`../local-bench/RESULTS.md`)

- **#0 (group commit sem timer):** revertido; não ajuda em produção e o `auto` atrapalha.
- **Novo, barato e medido:**
  - **`maxBatch` padrão maior** (500, ou adaptativo pelo tamanho da fila): +29% no shard quente;
  - **todo cliente falando `batch`** (SDKs de terceiros, `loadgen`, HTTP em rajada): 2,2×.
- **CPU por mutation vira a alavanca principal do shard quente:** ~200 µs em produção, contra ~30 µs no local.
  Os itens #1–#6 e #12 (dedup sem mudança, SQL fixo por commit, JSON numa passada, contexto preguiçoso, lote sem
  savepoint, validação compilada) cortam CPU que em produção vale ~6× mais. Estimativa: −40–50% de CPU, levando o
  shard quente de ~6k/s para ~10k/s.
- **Latência:** o piso por mutation é o flush durável (~25–30 ms) mais o RTT.
  - Do Brasil, o RTT (~150–180 ms) domina os dois backends.
  - O que ainda dá: posicionamento (não há DO na América do Sul hoje), update otimista e queries locais (offline).
  - O Ember não ganha 100× em latência de ponta a ponta. Ganha onde o Convex trava: doc quente (57× na vazão, 88× no
    p99 pelo laptop; 100×+ dentro da região contra 26/s) e fan-out com muitos inscritos (100% contra 66% das
    atualizações).
- **Fatura:** ~2,7 linhas escritas por mutation hoje. Lotes maiores dividem a linha do change log por mais mutations.
