# Convex vs Ember, lado a lado (PLAN §19)

Rodado em 2026-11-05 entre 06:17 e 06:57 UTC, a partir deste laptop em Campinas (SP), contra:

- **Convex**: projeto `ember-bench` no time FreeCorps (plano **Convex Professional**, classe de deployment S256),
  deployment de dev em **aws-us-east-1** (região padrão do time; a URL do deployment não tem sufixo de região).
  O tráfego entra pela Cloudflare em VCP (Campinas) e segue para a Virgínia.
- **Ember**: projeto `spike-cvx`, env `test`, Worker `ember-spike-cvx-test` na conta FreeCorps (`<ACCOUNT_ID>`),
  deployado com `ember deploy` a partir do runtime de `origin/main`, métricas desligadas. Shards `us:*` com
  `locationHint: "enam"`. Edge em VCP; os DOs ficaram nos EUA (ver "Onde cada backend roda").

Todo recurso Cloudflare tinha nome `ember-spike-cvx-*` e foi apagado no fim (`evidence/convex-vs-ember-cleanup.txt`).
Os dados do Convex foram apagados; o projeto continua lá (ver "Limpeza").

## Rodada 7 (2026-11-12)

Em `perf-remote.md` §5, junto com a sonda da plataforma, o A/B de group commit dentro da Cloudflare e o protocolo em
lote. Mesmo harness e runtime da `main`. Resumo:
- doc quente: Ember 1.765/s contra 31/s do Convex (57×; p99 536 ms contra 47 s);
- espalhado 32×50: Ember 7.774/s contra 1.234/s;
- fan-out 430: Ember 100% das atualizações contra 66%, p50 197 contra 524 ms;
- queries: empate (RTT);
- cliente novo: Ember 1,3× mais rápido.

## Rodada de 2026-11-09 (depois dos PRs #31–#34)

Mesmo harness, mesmo laptop (load ~2 em 8 núcleos, bem mais calmo que em 2026-11-05) e mesmos projetos. As chaves no
`evidence/convex-vs-ember.json` são:
- `convex#3` e `ember-us#3`: os dois lados, rodada 3, com o runtime da `main` depois de #31–#33;
- `ember-us#4`: só o Ember, com #34;
- `ember-us#5`: repetição de `a` e `b` com #34, porque na rodada 4 o `b 8x50` pegou uma queda de rede do laptop (os 8
  shards pararam juntos por ~20 s e voltaram por reconexão);
- `ember-us#6`: `d` refeito com HTTP de verdade (ver nota ² da tabela);
- `f#3` e `f#4`: primeiro resultado de um cliente novo;
- `convex-inregion`: a medida dentro da região refeita (a de 2026-11-05 está em `convex-inregion#1`).

O que mudou no Ember desde a rodada de 2026-11-05:
- **#31:** query one-shot pelo socket (`q`) e frames de patch pré-codificados.
- **#32:** armazenamento compacto (1 linha por documento inserido).
- **#33:** resultado das mutations no anel do change log, com ack do cliente (sem linha de dedup).
- **#34:**
  - frames em lote (feature `batch`): de ~3 frames por mutation para ~0,03 sob carga;
  - `patch` grava só as colunas que mudaram;
  - cache de leitura da mutation;
  - bundle sem `keepNames`.

| Cenário | Convex (#3) | Ember #3 (antes do #34) | **Ember com #34** (#4 / #5) |
|---|---|---|---|
| a. Documento quente, 6×10 em voo | 44/s, p99 7.240 ms | 298/s, p99 322 ms | **335/s**, p99 276 ms |
| a. Documento quente, 6×100 em voo | 45/s, p99 36.168 ms | 1.459/s, p50 381 ms | **2.750/s**, p50 205 ms, p99 356 ms |
| a. Documento quente, 60×1 | 38/s, p99 7.837 ms | 259/s | **275–301/s**, p99 ≤ 441 ms |
| b. Inserts espalhados, 8×50 | 402/s, p50 973 ms | 2.113/s | **2.205/s**, p99 273 ms |
| b. Inserts espalhados, 32×50 | 1.293/s, p50 1.207 ms | 7.815/s | **8.493–8.560/s**, p99 ≤ 313 ms |
| b. Inserts espalhados, 256×1 | 1.125/s, p99 1.305 ms | 1.279/s | **1.430/s**, p99 263 ms |
| c. Fan-out, 100 inscritos (entrega p50/p99) | 206 / 426 ms | 184 / 234 ms | 176 ms / 1.114 ms¹ |
| c. Fan-out, 430 inscritos (entrega p50/p99, atualizações) | 512 / 1.597 ms, 65% | 216 / 534 ms, 100% | **213 / 302 ms, 100%** |
| d. Query socket `recent` (p50/p95/p99) | 168 / 196 / 260 | 137 / 218 / 385 | **132 / 145 / 216** (#6) |
| d. Query socket `page` | 167 / 218 / 273 | 139 / 242 / 313 | **131 / 140** / 327 (#6) |
| d. Query HTTP `recent` | 159 / 230 / 236 | —² | **146** / 230 / 253 (#6) |
| d. Query HTTP `page` | 157 / 227 / 232 | —² | **146** / 234 / 239 (#6) |
| e. Bytes por atualização | 477 | 255 | **255** |
| f. Cliente novo, backend quente (p50) | 673 ms | 351 ms | **355 ms** |
| f. Cliente novo depois de 100 s parado (p50) | 621 ms | 494 ms | **365 ms** |
| Convex dentro da região (action, sem rede) | hot doc 56/s (60 em voo), 18/s (600); put 4.472–5.124/s | | |

² Nas rodadas #3 e #4, as linhas "HTTP" do Ember não mediram HTTP: com a inscrição aberta do cenário, o
`client.query` do Ember (feature `query`) foi pelo socket. O harness agora força `transport: "http"`, e `d` foi
refeito na rodada `ember-us#6`, que também mediu o socket de novo.

¹ Uma das 20 escritas atrasou ~0,9 s para todos os inscritos (p95 = p99 = max); com 430 inscritos, a mesma rodada deu
p99 302 ms.

- **RTT do laptop** (HTTP keep-alive p50): Convex 147–158 ms (edge GRU), Ember 164–167 ms (edge VCP, DO em MIA/EWR).
  O Ember entra com ~10–17 ms de desvantagem de rede.
- **Documento quente:** 61× o Convex pelo laptop e 150× o Convex dentro da região (18/s com 600 em voo). Com 600 em
  voo e ~190 ms de RTT, o teto que só a rede impõe é ~3.150/s, e o Ember chega a 2.750/s. Antes do #34 o shard era o
  gargalo (custo fixo por frame do runtime); agora quase não é.
- **Escala:** 8,5k/s em 32 shards pelo laptop, limitado pelo cliente (21% de CPU, 1.600 em voo × RTT). O Convex
  Professional fica em ~5k/s mesmo dentro da região.
- **Queries:**
  - O Ember ganha o p50 nos 4 casos, mesmo com RTT pior.
  - Pelo socket, ganha também o p95 (145 contra 196–218 ms) e o p99 de `recent`. Perde o p99 de `page` (327 contra
    273 ms); com 200 amostras, o p99 é a 2ª pior.
  - Por HTTP, que passa pelo Worker antes do DO, o p95 empata e o p99 fica 7–17 ms atrás.
  - Nenhum dos dois põe dados no Brasil: a cauda é da rede.
- **Erros:** zero em todas as corridas do Ember; o Convex teve 11.511 conflitos OCC dentro da região com o documento
  quente e reconexões no cliente.

### Custo por operação (preços de 2026-11-05)

Linhas escritas medidas no workerd (`packages/runtime/test/rows-written.test.ts`), a US$ 1 por milhão:

| Operação | Convex Professional | Ember, 1 mutation por commit | Ember sob carga (group commit) |
|---|---|---|---|
| Insert sem índice do usuário (WS, com `ack`) | US$ 2,00/M chamadas + I/O (~US$ 0,05/M) | US$ 2/M (2 linhas) | **~US$ 1/M** |
| Insert com 1 índice (`bench:put`) | US$ 2,05/M | US$ 3/M (3 linhas) | ~US$ 2/M |
| Contador quente (`unique()` + `patch`, 1 índice; `bench:incr`) | US$ 2,05/M, e 45/s no máximo | **US$ 2/M** (2 linhas; eram 3 antes do #34) | **~US$ 1/M** |
| Query, atualização de inscrição | US$ 2,00/M cada | linhas lidas a US$ 0,001/M; saída de WS grátis | idem |
| Fan-out de 1 escrita para 430 inscritos | até 431 chamadas (~US$ 0,00086) | 1 mutation | idem |
| Base mensal | US$ 25 por desenvolvedor (25M chamadas) | US$ 5 por conta (50M linhas escritas) | |

- **Onde o Ember ainda não ganha:** insert numa tabela com índice, uma mutation por vez. Cada índice do usuário é uma
  linha escrita (a Cloudflare cobra a entrada de índice), e o Convex cobra a chamada inteira com preço fixo. Sob carga,
  o change log se divide pelo lote, e o Ember empata (1 índice) ou ganha (sem índice).
- **Na conta de um app real, o Ember fica muito abaixo:** cada escrita dispara re-execuções de inscrição, que o Convex
  cobra como chamada e o Ember entrega de graça. A base também é US$ 5 contra US$ 25 por desenvolvedor.

### Veredito

- **Ember ganha:** documento quente (61–150×); escrita espalhada (5–7× com 8×50 e 32×50; 1,3× com 256×1, limitado pelo RTT dos dois lados); fan-out (2,4× no p50, 5× no p99, 100% das
  atualizações); p50 de query; cliente novo (1,7–1,9×); banda (1,9×); custo de leitura, reatividade e base.
- **Empata:**
  - cauda de query por HTTP vinda do Brasil (rede, mais o salto Worker → DO);
  - tempo para inscrever 430 clientes (~4,8–5 s nos dois, porque o harness abre os sockets em lotes de 20 com
    200 ms entre eles).
- **Perde:** custo marginal de um insert com índice a uma mutation por vez (US$ 3 contra US$ 2,05 por milhão).

As seções abaixo são a rodada de 2026-11-05 (runtime antes de #31) e ficam como histórico.

## Método

- **Mesmo app nos dois lados.**
  - **Tabelas:** `items { n, sentAt, body }`, com índice `by_n`, e `counters { name, value }`, com índice `by_name`.
  - **Funções:**
    - `bench:put` insere uma linha de 64 bytes;
    - `bench:incr` faz read-modify-write de um contador: `withIndex("by_name").unique()` e depois `patch`;
    - `bench:recent` faz `withIndex("by_n").order("desc").take(10)`;
    - `bench:page` faz `.paginate({ numItems: 20 })`;
    - `bench:latest` devolve a linha mais nova;
    - `bench:counter` lê o contador.
  - **Onde estão:**
    - Convex: `convex-bench/convex/{schema,bench}.ts`;
    - Ember: `EMBER_SCHEMA` e `EMBER_BENCH` em `scripts/convex-vs-ember.ts`.
  - **Diferença de API:** no Ember os handlers são síncronos. O `ctx.db` é síncrono, e o tipo recusa `async`. No
    Convex os handlers são `async`.
- **Mesmo harness e clientes oficiais.** `scripts/convex-vs-ember.ts` roda os dois backends com a mesma lógica:
  - Convex usa `ConvexClient` (`convex/browser` 1.49.0) para mutations, inscrições e queries pelo socket, e
    `ConvexHttpClient` para queries HTTP.
  - Ember usa `EmberClient` (`@freecorps/ember-client`, fonte deste repo) com `mutation`, `subscribe` e `query`
    (HTTP).
  - Cada `WebSocket` é embrulhado para contar bytes e frames.
  - Bun 1.4.2.
  - Latência é `performance.now()` no mesmo processo. Na fan-out não há relógio de outra máquina na conta, ao
    contrário do B4 do `bench.md`.
- **Carga em laço fechado.** `clients` sockets, cada um com `window` chamadas em voo, por 20 s. A vazão é `ok /
  parede`, e a parede inclui o dreno das chamadas ainda em voo no fim.
- **Dentro da região (só Convex).** `convex-bench/convex/inregion.ts` é uma action que mantém `parallel`
  `ctx.runMutation` em voo por 20 s. Ela mede o Convex sem o link Brasil→EUA e sem o laptop. É a contrapartida do
  load generator do Ember dentro da Cloudflare (`bench.md`, mesmo dia, 01:30 UTC).
- **Reproduzir.**
  - Rode `npx convex dev --once` em `convex-bench/`. Isso cria o `.env.local`, que não é versionado.
  - Depois rode `bun --conditions=@freecorps/ember-source run docs/spikes/remote/scripts/convex-vs-ember.ts deploy
    where inregion bench cleanup`.
  - Use `BACKENDS=convex,ember-us`, `ONLY=a,b,c,d,f`, `ROUND=2` e `SPREAD=8x50,32x50,256x1` para rodar só uma parte.
- **Números brutos.** Estão em `evidence/convex-vs-ember.json`:
  - as chaves `convex`, `ember-us`, `convex#2` e `ember-us#2` são as rodadas 1 e 2;
  - `convex-inregion` e `f` também estão lá;
  - `evidence/convex-vs-ember-where.json` tem o posicionamento dos DOs;
  - os `.txt` são os logs do último processo de cada fase.
- **Máquina.** Laptop de 8 núcleos dividido com outro agente pesado (build mobile).
  - O load average ficou entre 37 e 109 durante as rodadas. Cada rodada registra o seu em `machine.loadavg`.
  - O harness rodou com `nice` e usou 1–8% de um núcleo.
  - A carga da máquina pesa nas caudas (p95/p99) dos dois lados. Por isso as rodadas de b, c e d foram repetidas,
    alternando os backends. A rodada 2 pegou a máquina mais calma (load 37–64) e é a usada nas tabelas, salvo
    indicação.
- **Volume.** Cerca de 344 mil chamadas de função no Convex (`npx convex deployment usage`: 0,136 GB-h de
  query/mutation, 0,007 GB-h de action, 0,084 GB de I/O), dentro do incluído no Pro. No Ember foram cerca de 300 mil
  mutations. Nenhuma corrida passou de 20 s de carga.

### Onde cada backend roda

| Medida | Convex | Ember `us:*` (enam) |
|---|---|---|
| Região dos dados | aws-us-east-1 (Virgínia) | DO em MIA, EWR ou IAD |
| Edge de entrada | VCP | VCP |
| HTTP keep-alive p50 (ms) | 151–153 | 159–164 |

- **A sonda `where`** (Worker temporário `ember-spike-cvx-where`, apagado no fim) criou 3 DOs por hint e leu
  `/cdn-cgi/trace` de dentro de cada um:
  - sem hint: EWR, MIA, EWR;
  - `enam`: MIA, MIA, MIA;
  - **`sam`: IAD, ORD, MIA.**
- **A Cloudflare ignorou o hint `sam` para este laptop.** Hoje nenhum DO fica na América do Sul, então o Ember
  também não põe dados no Brasil. Os shards `sa:*` foram medidos na rodada de fumaça (`d`) e deram a mesma latência
  dos `us:*`. Por isso ficaram fora das tabelas.
- **Os dois backends ficam a ~150 ms do laptop.** A comparação abaixo é, na prática, Virgínia contra Miami/Nova
  Jersey.

## Resultados

### a. Documento quente: contador com read-modify-write (20 s)

| Em voo (sockets × janela) | Convex mutations/s | Convex ack p50 / p95 / p99 (ms) | Ember mutations/s | Ember ack p50 / p95 / p99 (ms) |
|---|---|---|---|---|
| 60 (6×10) | 45 | 239 / 5.709 / 9.677 | **212** | 219 / 582 / 1.184 |
| 600 (6×100) | 38 | 2.481 / 40.575 / 41.815 | **1.454** | 397 / 558 / 592 |
| 60 (60×1) | 26 | 803 / 7.677 / 14.293 | **127** | 217 / 1.118 / 5.185 |

Dentro da região (Convex: action com `ctx.runMutation`; Ember: `bench.md` B2, mesmo shard quente mas com inserts):

| Em voo | Convex ok/s | Convex falhas OCC | Ember (B2) mutations/s |
|---|---|---|---|
| 60 | 53 | 1.314 (54% das tentativas) | 660 |
| 600 | **18** | **11.768 (97%)** | **1.479** |

- **O Convex não escala num documento quente.** Mutations concorrentes no mesmo documento conflitam (OCC). O Convex
  tenta de novo e desiste com `Documents read from or written to the "counters" table changed while this mutation
  was being run and on every subsequent retry`.
  - Com mais concorrência a vazão cai: 53/s com 60 em voo e 18/s com 600.
  - Pelo `ConvexClient`, a falha não chega ao app. O cliente derruba o WebSocket (`WebSocket reconnected … after
    disconnect due to OptimisticConcurrencyControlFailure`), reconecta e reenvia. A mutation acaba confirmada, mas
    com p99 de 10 a 42 s.
- **O Ember serializa no shard e faz group commit.** Com 600 em voo chega a 1.454/s, a mesma vazão do B2 medido
  dentro da Cloudflare (1.479/s). O teto do shard quente é a CPU do DO, não o link.
  - O ack p50 de ~400 ms é o tempo de fila no shard mais o RTT.
  - **Ember: 38× a vazão do Convex daqui do laptop, e 80× dentro da região.**
- **Nenhum incremento perdido em nenhum dos dois.** O contador final é igual ao número de acks
  (`lostOrExtra: 0`).
- **Aqui o Ember usa o mesmo read-modify-write do Convex.** `ctx.db.increment` existe, mas não foi usado.
- **Quando o Convex ganha:** não há cenário de documento quente em que o Convex ganhe. A recomendação do Convex para
  esse caso é um contador shardeado (componente), o que é trabalho do app.

### b. Escritas espalhadas: inserts independentes (20 s)

No Convex tudo vai para um único deployment. No Ember cada socket escreve no seu próprio shard (`us:sp-…-i`).

| Sockets × janela (em voo) | Convex mutations/s | Convex ack p50 / p99 (ms) | Ember mutations/s | Ember ack p50 / p99 (ms) |
|---|---|---|---|---|
| 8×50 (400) | 276 | 1.312 / 3.804 | **1.778** | 190 / 712 |
| 32×50 (1.600) | 623 | 1.576 / 9.007 | **4.483** | 252 / 2.360 |
| 256×1 (256) | 410 | 271 / 6.457 | **1.065** | 180 / 1.738 |

Dentro da região:

| Em voo | Convex (action) mutations/s | Convex ack p50 / p99 (ms) | Ember (`bench.md` B1) mutations/s | Ember ack p50 / p99 (ms) |
|---|---|---|---|---|
| 256 (4 actions × 64) | 4.547 | 56 / 84 | — | — |
| 800 (8 × 100) | **5.166** | 150 / 550 | — | — |
| 400 (8 shards × 50) | — | — | 5.683 | 59 / 137 |
| 1.600 (32 shards × 50) | — | — | **23.158** | 59 / 152 |

- **O teto do Convex no Pro fica em ~5k inserts/s**, perto do limite de 256 mutations concorrentes da classe S256:
  - de 256 para 800 em voo a vazão sobe só 14%;
  - o ack p50 sobe de 56 para 150 ms, porque as chamadas fazem fila.
- **O Ember escala com o número de shards:** 5,7k/s em 8 e 23k/s em 32 (`bench.md`). Com shards suficientes passa o
  Convex Pro em ~4,5×. **Não há teto de plano:** o limite vem do número de shards e do orçamento do cliente.
- **Do laptop, o Convex é limitado pelo número de conexões, não pela janela.** 8×50 dá ~280/s, ou ~35/s por
  conexão. 32×50 dá ~620–790/s, ou ~20–25/s por conexão. Isso é consistente com o Convex executar em ordem as
  mutations de um mesmo cliente.
  - O Ember faz pipeline numa conexão: ~220/s por socket a 50 em voo.
  - Com o mesmo orçamento de sockets e em voo, **o Ember fez 2,6–7× mais**.
- **A rodada 1 de 32×50 no Ember deu 1.836/s, com o load da máquina em 109.** A rodada 2, com load 37, deu 4.483/s.
  O cliente sofre com a carga da máquina, e essa diferença é a margem de erro do laptop.

### c. Fan-out reativo: N inscritos em `bench:latest`, um escritor (20 escritas, 500 ms entre elas)

As aberturas de socket foram escalonadas, 20 a cada 200 ms. "Entrega" é o tempo do envio da mutation pelo escritor
até a atualização chegar a cada inscrito, no mesmo relógio.

| Inscritos | Backend | Atualizações recebidas / esperadas | Inscritos com o valor final | Entrega p50 / p95 / p99 / max (ms) | Ack do escritor p50 (ms) |
|---|---|---|---|---|---|
| 100 | Convex | 2.000 / 2.000 | 100 | 210 / 417 / 459 / 483 | 190 |
| 100 | Ember | 2.000 / 2.000 | 100 | **198 / 274 / 275** / 276 | 200 |
| 430 | Convex | **5.679 / 8.600 (66%)** | 430 | 587 / 2.003 / 2.234 / 2.614 | 174 |
| 430 | Ember | **8.600 / 8.600** | 430 | **208 / 542 / 1.223** / 1.233 | 214 |

- **Com 100 inscritos os dois empatam no p50** (~200 ms, ou seja RTT mais commit). O Ember tem cauda menor.
- **Com 430 inscritos o Convex junta estados.** Todos chegam ao valor final, mas um terço dos valores intermediários
  nunca chega aos inscritos.
  - Isso segue a semântica do Convex: o cliente recebe o estado consistente mais recente, não cada transição.
  - Não é perda de dado. Mas um app que precisa de cada evento tem de ler um log, não um `latest`.
  - A entrega p50 sobe para 587 ms (rodada 1: 627 ms).
- **O Ember entregou todas as 8.600 atualizações, com p50 de 208 ms.**
- **"Do ack até a atualização" tem sentidos diferentes nos dois.**
  - No Convex, a atualização chega 15–300 ms depois do ack do escritor.
  - No Ember, ela chega junto ou antes do `mres` do escritor (p50 ≈ 0 ms). O shard manda os patches na mesma volta
    do commit, antes ou junto com o ack.
  - O JSON tem `deliveryFromAckMs`, mas a medida que compara melhor é a do envio.

### d. Latência de query a partir do Brasil (4 concorrentes, 200 por caso, args distintos, sem cache)

| Caso | Convex p50 / p95 / p99 (ms) | Ember p50 / p95 / p99 (ms) |
|---|---|---|
| socket, `recent` (take 10) | **168 / 354 / 827** | 229 / 538 / 1.197 |
| socket, `page` (paginate 20) | **155 / 348 / 637** | 228 / 659 / 759 |
| HTTP, `recent` | **159 / 223 / 289** | 230 / 739 / 1.169 |
| HTTP, `page` | 158 / 225 / 282 | 162 / 295 / 354 |

Os números são da rodada 2. A rodada 1 está no JSON: Convex 163–204 de p50, Ember 164–205.

- **Empate técnico no p50.** Os dois ficam entre RTT e RTT + 70 ms, e a rodada 1 inverteu metade das posições.
- **O Convex teve cauda menor nas duas rodadas.**
  - No Ember, a "query pelo socket" é `subscribe` → snapshot → `unsubscribe`. Isso registra e remove a inscrição em
    `_ember_subs`, uma escrita no shard, enquanto o `client.query` do Convex é uma inscrição em memória.
  - O HTTP do Ember passa pelo Worker antes do DO.
- **O Ember não ganha aqui.** Para cortar latência, o Ember precisaria pôr o shard perto do usuário, e hoje não há DO
  na América do Sul.

### e. Banda por atualização (fan-out, c)

| Backend | Bytes por atualização por inscrito | Frames por atualização |
|---|---|---|
| Convex | 476 | 1,00 |
| Ember | **255** | 1,03 |

- **É o payload dos frames recebidos**, contado no `onmessage` depois de qualquer descompressão. Não foi medido se o
  permessage-deflate estava ativo no fio.
- **O Ember manda ~46% menos para um documento de 64 bytes:**
  - Convex: um `Transition` com versão, `modifications`, `QueryUpdated` e o valor inteiro;
  - Ember: um `patch` com o valor.
- **Em listas a diferença cresce:** o `rowdiff` do Ember manda só as linhas mudadas (PLAN §19, ~400× numa lista de
  500 docs). Esse caso não foi medido aqui.

### f. Primeiro resultado de um cliente novo

Cada medida abre um cliente, faz o socket e o handshake, roda `bench:latest` e espera o primeiro resultado.

| Situação | Convex p50 / max (ms) | Ember p50 / max (ms) |
|---|---|---|
| Backend quente, 10 clientes em sequência | 681 / 825 | **379** / 1.409 |
| Após 100 s parado (6 amostras; Ember: shards novos, já hibernados ou despejados) | 774 / 843 | **508** / 512 |

- **O Ember abre mais rápido:** o socket já leva as inscrições junto com o `hello`.
- **Depois de 100 s parado, o Ember paga ~130 ms acordando o DO**, e o Convex ~90 ms. Os dois ficam abaixo de 1 s.
- **O Convex não tem cold start de shard.** O deployment fica sempre de pé, e o custo extra é da conexão e da
  sincronização inicial.

## Custo (preços públicos lidos em 2026-11-05)

Fontes:
- Convex: https://www.convex.dev/pricing e https://docs.convex.dev/production/state/limits
- Cloudflare: https://developers.cloudflare.com/durable-objects/platform/pricing/ e
  https://developers.cloudflare.com/workers/platform/pricing/

| Item | Convex Professional | Ember na conta do usuário (Workers Paid) |
|---|---|---|
| Base | US$ 25 por desenvolvedor por mês; 25M chamadas, 50 GB de I/O e 50 GB de armazenamento incluídos | US$ 5 por mês; 1M requests de DO, 400k GB-s, 50M linhas escritas, 25 bi linhas lidas e 5 GB incluídos |
| Mutation (marginal) | **US$ 2,00 por milhão de chamadas**, mais I/O a US$ 0,20/GB (medido: ~0,25 KB por chamada, ou ~US$ 0,05/M) | Mensagem de WS que chega ao DO: 1/20 de request a US$ 0,15/M = US$ 0,0075/M. Linhas escritas a US$ 1,00/M: **US$ 6 por milhão de inserts via WS** (US$ 5 via HTTP) na tabela deste bench, que tem o índice `by_n`; medido depois do PR #15; antes, ~US$ 10 |
| Query ou atualização de inscrição | US$ 2,00/M: os limites dizem que "subscription updates" contam como chamada | Pedido do cliente: US$ 0,0075/M. Mensagem do DO para o cliente: **grátis**. Linhas lidas: US$ 0,001/M |
| Fan-out de 1 escrita para 430 inscritos | até 431 chamadas, ou ~US$ 0,00086 se cada atualização contar como chamada | 1 mutation, mais 430 mensagens de saída grátis |
| Armazenamento | US$ 0,20 por GB por mês acima de 50 GB | US$ 0,20 por GB por mês acima de 5 GB |
| Duração e computação | query/mutation grátis; action a US$ 0,30/GB-h | DO a US$ 12,50 por milhão de GB-s; 128 MB × tempo ativo; sockets hibernados não pagam. Shard ocupado 24/7: ~US$ 4/mês |
| Teto de vazão | 256 mutations concorrentes; ~5k inserts/s medidos; 10.000 sessões concorrentes | Por shard (~1,5k/s quente); sem teto de plano somando shards |

- **Linhas escritas por insert no Ember (medidas depois do PR #15, `docs/spikes/rows-written.md`).** Contadas com
  `cursor.rowsWritten`, o mesmo contador que a Cloudflare cobra, no workerd local (a API de analytics da conta recusou a
  consulta por limite de orçamento, então não foi conferido na fatura).
  - **Antes:** 8 linhas por insert via WebSocket sem índice do usuário (+1 remoção da linha de dedup 7 dias depois); 6 via HTTP. A tabela deste bench tem o índice `by_n`, que soma 1 linha: 9 (+1) e 7.
  - **Depois:** **5** via WebSocket e **4** via HTTP sem índice do usuário; **6** e **5** na tabela do bench. Sob carga, o changelog é dividido pelo lote e o insert via WS
    chega a 4. Restam o documento, os índices `_id`/`_creationTime` do engine e a linha de dedup (sem índice; a
    tabela inteira é descartada a cada semana, sem custo de linha). Inscrições não escrevem mais nada.
  - **Resultado:** na carga deste bench, a marginal de escrita do Ember fica ~2,5–3× acima dos US$ 2/M do Convex (antes, ~5×); sem índice do usuário, ~2–2,5×.
  - **Folga incluída:** os 50M de linhas incluídas cobrem ~8M de mutations por mês (com 1 índice) nos US$ 5, contra 25M de
    chamadas nos US$ 25 do Convex Pro.
- **Leituras, inscrições e fan-out:** o Ember fica 2–3 ordens de grandeza abaixo. Mensagem de saída de WS é grátis,
  e linha lida custa US$ 0,001/M.
- **Este experimento custou US$ 0 a mais nos dois.** Ficou tudo dentro do incluído: ~344k chamadas no Convex, e
  menos de 1M de linhas escritas no Ember.

## Onde o Ember ganha e onde perde

**Ganha**
- **Documento ou shard quente:** 1.454/s contra 38/s (laptop) e 1.479/s contra 18/s (dentro da região), sem erro de
  conflito. É a maior diferença medida.
- **Escala horizontal:** 23k/s em 32 shards contra o teto de ~5k/s do Convex Pro. Com o mesmo orçamento de cliente
  no laptop, 2,6–7× mais.
- **Fan-out com muitos inscritos:** 430 inscritos com p50 de 208 ms e 100% das atualizações, contra 587 ms e 66% dos
  estados intermediários.
- **Banda:** 255 contra 476 bytes por atualização, e o `rowdiff` amplia a diferença em listas.
- **Custo de leitura e reatividade:** a saída de WS é grátis, e o Convex cobra cada atualização de inscrição como
  chamada.
- **Primeira resposta de um cliente novo:** 379 contra 681 ms, quente.

**Perde ou empata**
- **Latência de query a partir do Brasil:** empata no p50, e o Convex tem cauda menor. A `query` do Ember pelo socket
  cria e apaga uma inscrição, e o HTTP passa pelo Worker.
- **Custo marginal de escrita:** US$ 5–6 por milhão de inserts na tabela do bench (1 índice) contra US$ 2 (era ~US$ 10 antes do PR #15). O que
  sobra é o documento, os índices do engine e a linha de dedup por mutation; tirar os índices do engine exige mudar o
  formato de id.
- **Região:** nenhum dos dois põe dados no Brasil. O hint `sam` não pegou, e os DOs foram para MIA/IAD/ORD, então o
  "perto do usuário" do PLAN §19 não vale para a América do Sul hoje.
- **Modelo de programação:** OCC com handlers `async` no Convex, contra handlers síncronos num shard no Ember. O
  Convex tem transação serializável global, e o Ember não (PLAN §19).

## Ressalvas

- **Máquina carregada.** O laptop tinha load 37–109 em 8 núcleos, por causa de outro agente. As caudas do lado do
  cliente estão infladas nos dois backends, e foram feitas duas rodadas alternadas. Dentro de cada rodada, os
  backends rodaram em sequência e não intercalados.
- **Deployment de dev no Convex.** Classe S256, a mesma do plano. Prod não foi medido.
- **Inserts no B1/B2 do Ember dentro da região.** O "dentro da região" do Ember usa `bench.md` (inserts no B2, load
  generator em IAD/EWR). O do Convex usa `ctx.runMutation` de uma action, que está a um salto do banco, sem
  WebSocket, ou seja, a medida mais favorável possível ao Convex.
- **Clientes diferentes.** Os clientes têm semânticas diferentes: o Convex executa em ordem as mutations de um
  cliente, e o Ember faz pipeline com group commit. O harness é o mesmo, mas "8 sockets × 50" significa paralelismo
  de servidor diferente nos dois.
- **Bytes do frame descomprimido.** Os bytes são do payload do frame depois da descompressão; a compressão no fio não
  foi medida.
- **Pontos a medir.** Conferir na fatura (analytics de DO SQL) as linhas escritas medidas no workerd; as inscrições
  pelo socket já não escrevem em `_ember_subs` (PR #15).

## Limpeza

- **Cloudflare.** Foram apagados `ember-spike-cvx-test` (Worker e DOs), `ember-spike-cvx-where` e o D1
  `ember-spike-cvx-registry`. O inventário final de `ember-spike*` está vazio: nenhum script, namespace ou D1.
- **Convex.**
  - `items` e `counters` foram esvaziados (`npx convex import --replace` com arquivo vazio; `bench:clear` devolve 0).
  - Ainda existem o projeto `ember-bench` no time FreeCorps e o seu deployment de dev (o CLI não apaga deployments).
  - O dono pode apagar os dois em Dashboard → ember-bench → Settings → Delete project.
