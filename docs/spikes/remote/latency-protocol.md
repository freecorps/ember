# Latência e protocolo: onde o Ember ainda perde e o que dá para fazer (2026-11-14)

Investigação sobre a `main` em `7e57209`, com uma mudança que saiu dela: o auth carregado sob demanda (§3).

**Rótulos dos números:**
- **medido:** rodado aqui, com a saída em `evidence/` ou `../local-bench/evidence/`;
- **lido do código;**
- **extrapolado:** inferência, não medida.

**Onde rodou:**
- **Local:** Apple M3, workerd `1.20261103.1`, Miniflare `5.20261103.0-beta`.
- **Produção:** conta FreeCorps, de 22:43 a 23:44 UTC.
  - Laptop em Campinas, com a borda em VCP.
  - DOs em MIA e EWR.
  - Recursos `ember-spike-lat-*`, todos apagados (`evidence/latency-cleanup.txt`, inventário vazio).

## Resumo

| Suspeita | Veredito | Número que decide |
|---|---|---|
| **S1.** O deflate do WebSocket dobra o custo de envio do shard | **Derrubada em produção** (verdadeira só no workerd local) | CPU do DO por envio: 3–5 µs com ou sem compressão, para 472 B e 8,7 KB. No local eram 30–103 µs. |
| **S2.** Uma leitura espera o flush da escrita de outro | **Confirmada** (medido) | Com 100 escritas SQL/s, toda leitura paga +~27 ms (p50 3 → 30). Com 20/s, o p95 sobe +30. Com 5/s, o p99 sobe +30. |
| **S3.** O bundle com auth pesa no isolate frio | **Confirmada e reduzida à metade** | Antes: `startup_time_ms` 53 contra 6 sem auth, e primeira chamada ao shard +98 ms. Com o auth sob demanda: 32 ms e +48 ms. |
| **S4.** +24 ms de RTT e cauda maior | **Não reproduz hoje** (medido, sem o Convex no mesmo dia) | Query p50 de 139 ms por HTTP e 127 ms pelo socket, contra 177–179 e 169–172 na rodada 7. A cauda vem da última milha do laptop (p95 de `/health` = 104 ms). |
| **S5.** Pendências de produção das PRs #77 e #79 | **Não medido nesta rodada** | — |
| **S6.** Telemetria do usuário real | **Implementado** na v0.10 (PR 6a-2; contrato em contracts.md "Telemetria", RUM) | — |

## 1. S1: compressão do WebSocket (`permessage-deflate`)

### 1.1 Local (medido): quem negocia e quanto custa no workerd

Harness: `../local-bench/ws-compress.mjs`.
- Workerd puro, com o Worker de entrada e o DO em serviços separados, cada um com as próprias flags. O Miniflare também
  foi medido.
- O DO aceita com hibernação e só faz o laço de `ws.send`.
- Clientes em Node com o pacote `ws`.
- CPU do processo workerd, N = 300, 100 broadcasts por tamanho, mediana de 3 (`ws-compress-1.txt`, `-2.txt`).

| Variante | 101 ao cliente | CPU por envio, 415 B / 8,7 KB |
|---|---|---|
| flags padrão, cliente pede | `permessage-deflate; client_max_window_bits=15` | **30 / 103 µs** |
| flags padrão, cliente não pede | (nenhuma) | **3,3 / 5,3 µs** |
| `no_web_socket_compression` só no Worker de entrada | (nenhuma) | 3,3 / 5,0 µs |
| a flag só no Worker do DO | comprimido | 29 / 102 µs |
| a entrada **remove** `Sec-WebSocket-Extensions` antes do DO | comprimido | 29 / 103 µs |
| Miniflare com a flag no Worker | **comprimido** | 30 / 103 µs |

- **Quem negocia é o salto que segura a conexão HTTP com o cliente.** O DO entrega texto puro a esse salto, e é ele
  quem comprime.
- **A flag não pegou no Miniflare** porque quem segura o socket é o worker de entrada dele, que usa flags padrão.
- **No runtime real, local** (`reactive.ts DEFLATE=0`, `ws-compress-reactive.txt`):
  - `fanout-anon` cai de 8,5 para 3,4 ms por commit;
  - `fanout-page` cai de 9,1 para 3,35 ms.
- **RSS:** +114 MB contra +36 MB para 300 sockets, ou seja ~260 KB por socket com zlib.

### 1.2 Produção (medido): a compressão não cai na conta do DO

Harness: `scripts/latency-ws.ts`, com `workers/wsbench.js` e `workers/wsagent.js`.
- DO de broadcast com 300 sockets, segurados por 60 agentes DO dentro da Cloudflare (IAD/EWR/MIA).
- Cada agente pede a extensão ou não (upgrade por `fetch`, com ou sem o header).
- 10 frames por segundo para cada socket, durante um minuto UTC inteiro por caso.
- A CPU vem do GraphQL `durableObjectsPeriodicGroups` daquele minuto, dividida pelos envios.
- 2 rodadas, com a ordem das variantes invertida.

| µs de CPU do DO por envio (rodada 1 / 2) | patch 472 B | frame 8,7 KB |
|---|---|---|
| cliente pede deflate (o 101 confirma a extensão nos 300) | 2,0* / 4,3 | 2,9 / 3,4 |
| cliente não pede | 4,0 / 4,4 | 3,1 / 3,1 |
| Worker com `no_web_socket_compression` | 4,8 / 4,2 | 4,1 / 3,1 |

\* `outboundWebsocketMsgCount` daquele minuto veio parcial (43 mil contra 170 mil enviados). O número é a CPU dividida
pelos envios contados pelo driver.

- **O 101 visto do laptop** (`check` em `evidence/latency-ws.json`):
  - flags padrão: `permessage-deflate; client_max_window_bits=15`, com 100 patches de ~490 B em **15,2 KB** no fio,
    contra 50 KB sem compressão;
  - com `no_web_socket_compression`: sem a extensão. A flag funciona em produção.
- **Conclusão:** em produção quem comprime é a borda. Para o shard, a compressão é banda grátis: 3,3× menos bytes, CPU
  igual. **Não desligar.**
- **Mapa da rodada 2 corrigido:** os "17–21 µs por socket do `ws.send` nativo" eram o deflate do workerd local. Em
  produção, o envio custa 3–5 µs por socket na CPU do DO.

## 2. S2: leitura esperando o flush de outra escrita (medido)

- **Lido do código:**
  - O caminho de leitura (`q`, `snap`, `POST /api/query` → `Shard.query`) não escreve.
  - Nenhuma resposta faz `await storage.sync()`.
  - O que segura a saída é o output gate.
- **Harness:** `scripts/latency-gate.ts` com `workers/gatebench.js`.
  - Um DO "shard" com um laço de escrita dentro dele.
  - Um DO cliente vizinho faz 200 leituras sequenciais pelo WebSocket e por RPC, que é o caminho HTTP do Ember.
  - 2 rodadas.

| Escrita concorrente (p50 / p95 / p99, ms) | 0/s | 5/s | 20/s | 100/s |
|---|---|---|---|---|
| SQL `INSERT`, cliente no mesmo colo (rodada 1) | 3 / 4 / 4 | 3 / 4 / **32** | 3 / **34** / 36 | **30 / 31 / 32** |
| SQL, cliente a 36 ms (rodada 2) | 36 / 37 / 38 | 36 / **56** / 57 | **50** / 52 / 53 | **60** / 62 / 68 |
| KV `put` com `allowUnconfirmed` (controle) | — | 2 / 3 / 4 | 1 / 2 / 3 | 1 / 3 / 4 |

- **Uma leitura sem relação com a escrita espera o flush do commit anterior,** pelo socket e por RPC. A partir de ~30
  escritas/s isso vale para toda leitura, com +~25–30 ms.
- **O controle mostra que o mecanismo é o output gate.** `allowUnconfirmed` remove o atraso, mas só existe para `put` da
  API KV. Para `sql.exec` não há opção documentada
  ([SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/), lida em
  2026-11-14).
- **O que fazer:** documentar como limite. Não há correção no runtime que preserve a garantia de leitura, porque o gate
  segura toda saída do objeto.
  - A alternativa seria um seguidor sem storage (um DO que recebe o change log e serve queries com atraso limitado).
  - Ela muda a garantia (ler a própria escrita) e a arquitetura: ganho alto só para apps de escrita constante, com
    esforço alto.

## 3. S3: tamanho do Worker e o auth sob demanda

### 3.1 Local (medido): de onde vem o volume

Harness: `../local-bench/worker-bundle.ts` (`evidence/worker-bundle.txt`). O startup é do spawn à primeira resposta,
contra um Worker trivial.

| Bundle | min / gzip | Startup no workerd (− trivial) | Maiores fatias |
|---|---|---|---|
| `init` sem auth | 280 / 95 KiB | +8 ms | `runtime/shard.ts` 61, `ember-values` 26, `server/engine.ts` 22 KiB |
| `examples/email-lite` | 465 / 152 KiB | +18 ms | `postal-mime` 89, `ember-email` 84 KiB |
| `init` com auth local | 1.183 / 335 KiB | **+39 ms** | `better-auth` 314, `kysely` 186, `@better-auth/core` 124, `zod` 100 KiB |

- **Lido do código:** o `Shard` e o Worker só precisam de `verify(token)`, que usa `jose` e `better-auth/cookies`
  (153 KiB). Mesmo assim, todo isolate avaliava o Better Auth inteiro e o `auth.config.ts`.
- **Medido, manual:** com o Better Auth e o config atrás de `import()` no mesmo bundle (sem code splitting), o startup
  local cai de 45 para **31 ms**; sem auth são 16,5 ms.
- **Onde fica o resto:** o workerd ainda compila o texto. Tirar tudo exigiria o `Auth` num script separado, o que move o
  namespace do DO de auth de projetos em produção. Fica de fora.

### 3.2 Produção (medido): antes, depois e sem auth

Harness: `scripts/latency-cold.ts`.
- O app do `ember init`, minificado como no `ember deploy`, atrás de um módulo de sonda que mede no Worker a RPC que
  acorda um shard.
- A cada tentativa os três scripts sobem de novo com um nonce, então toda versão é nova e todo isolate frio.
- Ordem rotativa, 10 tentativas, das quais 9 medem o frio.

| | sem auth | auth antes (eager) | **auth sob demanda** |
|---|---|---|---|
| `startup_time_ms` da API de upload, p50 (faixa) | 6 (6–14) | 53 (47–76) | **32** (24–60) |
| Worker → shard existente, primeira chamada da versão nova, p50 | 144 ms | 242 ms | **192 ms** |
| idem, amostras (ms) | 116–271 | 122, 235–320 | 115–198 |
| penalidade sobre sem auth | — | **+98 ms** | **+48 ms** |
| quente | 112 ms | 118 ms | 112 ms |
| shard novo (criação + DDL) | 515 ms | 637 ms | 617 ms |

A rodada anterior, de 5 tentativas antes e depois, deu o mesmo: startup 55 → 35, frio 241 → 190.

**A mudança** (esta PR) é a entrada gerada para `ember/auth.config.ts`, que passa a usar `emberAuthLazy` de
`@freecorps/ember-auth/lazy`:
- **O `Auth` DO** carrega o Better Auth e o config dentro do `blockConcurrencyWhile` do boot, antes de qualquer evento.
  Depois disso, a migração roda como antes.
- **`/api/auth/*`** carrega na primeira requisição a esse caminho. Os outros caminhos não carregam nada.
- **`verify`** (JWT, cookie cache, sessão), `rotateKeys`, `admin`, `api` e o roteamento usam configurações estáticas
  (`{ basePath, baseURL?, cookieStrategy }`). A CLI as calcula no build, avaliando o config em Node como o codegen já
  faz.
  - O verificador é o mesmo de `emberAuth`: `settings.ts` é compartilhado, e um teste compara os dois resultados.
  - Na forma função `defineAuth((env) => …)`, o primeiro `verify` carrega tudo, como antes.
  - Se o config resolvido em runtime divergir do que o build viu, `console.error` avisa.
- **Um `@freecorps/ember-auth` antigo**, sem `/lazy`, recebe a entrada de antes.

Testes:
- `packages/auth/test/lazy.test.ts` (workerd): cadastro e login pelo caminho preguiçoso; `verify` das três formas sem
  carregar o Better Auth; o resultado igual ao do verificador completo; rotação e admin sem carga; forma função;
  divergência.
- `packages/cli/test/auth.test.ts`: o fluxo completo no Miniflare com o bundle real e a forma eager de fallback.
- `examples/files-auth-jobs`: ponta a ponta, com o painel.

## 4. S4: a query do Brasil hoje (medido)

Harness: `scripts/latency-query.ts`.
- O app do `ember init` na `main`, sem auth.
- O shard ficou em MIA (proxy: um DO `Where` criado do mesmo jeito leu `cdn-cgi/trace`), e o Worker ficou em VCP.
- 2 rodadas de 200 chamadas sequenciais, intercaladas.

| ms (p50 / p95 / p99) | rodada 1 | rodada 2 |
|---|---|---|
| laptop ↔ borda (`GET /health`, só o Worker) | 24 / 104 / 129 | 23 / 103 / 113 |
| Worker (VCP) → shard (MIA), medido no Worker | 114 / 116 / 121 | 113 / 116 / 120 |
| query HTTP (`POST /api/query`, `messages:list` take 10) | **139** / 198 / 211 | **139** / 202 / 210 |
| query pelo socket (`q` num socket aberto) | **127** / 210 / 215 | **127** / 200 / 208 |

- **Os 24 ms a mais da rodada 7 não aparecem.**
  - HTTP: 139 contra 177–179 ms.
  - Socket: 127 contra 169–172 ms.
  - Os dois ficam abaixo do Convex daquela rodada (163–166).
  - **Não é uma comparação válida:** o Convex não foi medido no mesmo dia (o projeto `ember-bench` precisa do
    `.env.local` do dono). A rota de rede varia entre dias, e o próprio perf-remote viu 36 → 61 ms entre rodadas.
- **A parcela dentro da Cloudflare é estável e cara.** Os ~114 ms do Worker em VCP até o DO em MIA são o oceano: o p99
  fica só 7 ms acima do p50.
- **A cauda medida aqui é da última milha.** O p95 do `/health`, que nem chega ao DO, já é 104 ms.
- **Sem DO na América do Sul, o que sobra é escolher melhor o colo** (MIA contra EWR, +~40 ms no R8) **e medir o
  usuário real (S6).**
- **Lido do código:** cada chamada HTTP com token faz duas RPCs ao DO (`warm()` em `waitUntil`, mais a chamada em si,
  `worker.ts:345`). Como o `verify` é local, o `warm` não antecipa nada e dobra as requisições de DO cobradas no caminho
  HTTP. É custo, não latência. Não mudado.

## 5. S5: pendências das PRs #77 e #79 (não medido)

Precisam de um app com auth e de um gerador de carga que fale o protocolo autenticado (o `loadgen.js` não fala). Ficam
para uma rodada própria:
- CPU por commit do fan-out autenticado;
- wake com inscrições dormentes;
- `httpFirst` e `resume` de cache pela borda real;
- `put` sob carga com um savepoint por lote;
- paginação com fronteira fixa.

## 6. S6: telemetria do usuário real (desenho; implementado na v0.10)

> Implementado na PR 6a-2 com estas diferenças do desenho: `rum: { sampleRate }` (não `sample`), sem ajuste pelo
> servidor no `ready`; um ponto por balde (`double10` balde, `double11` amostras, `double12` peso) em vez de baldes
> em colunas; o colo do DO só em memória (não em `_ember_rt_meta` nem no catálogo), por `ready.colo` ou `{t:"colo"}`;
> a tela mostra cartões e o mapa país × colo (sem a série com marcadores de deploy). Contrato: contracts.md, RUM.

**O que coletar no cliente** (`EmberClient`, sem custo quando desligado):

| Métrica | Como medir | Observação |
|---|---|---|
| `connect` | `new WebSocket` → `ready` (e → primeiro `snap`) | separa o socket do primeiro valor |
| `first_value` | `subscribe()` → primeiro valor | com a origem: `cache`/`http`/`snap` |
| `ack` | `mutate` → `mres` | RTT + flush; a cauda mostra fila e group commit |
| `rtt` | o heartbeat que já existe (`ping` → `pong`, auto-resposta que não acorda o DO) | RTT puro até o DO |
| `reconnect` | contagem, motivo (close code, heartbeat, `offline`) e tempo até `ready` | — |
| `resume` | `unchanged` × valor inteiro, e bytes | mostra se o cache paga |

**Envio:**
- **Sem frame novo no socket.** Um `POST /api/_ember/rum` em lote, a cada 60 s ou no `pagehide` (`sendBeacon`), com
  no máximo ~2 KB.
- **Formato:** histogramas agregados no cliente (buckets log₂ de ms) por métrica e shard.
- **Amostragem por sessão:** `rum: { sample: 0.05 }`, sorteada uma vez por carga do app. O servidor pode ajustar pelo
  `ready` (`rumSample`).
- **Sem dado pessoal.** Não vai id de usuário, IP, `clientId` nem args.
  - Vai o *kind* do shard; a *key* só quando o app marcar o shard como não sensível.
  - Vão a função, a plataforma e a versão do SDK.
  - O país vem de `request.cf.country` e o colo de entrada de `request.cf.colo`, ambos no Worker. O IP nunca é gravado.

**Onde guardar:**
- No mesmo Analytics Engine (`EMBER_METRICS`), com `blob5 = "rum"`.
- `blob4` = métrica, `blob8` = shard (ou kind), `blob10`–`12` = país, colo de entrada e colo do DO.
- `double1`–`n` = buckets ou p50/p90/p99 e contagem do lote, com o peso em `double5`.
- **O colo do DO:** o shard lê `/cdn-cgi/trace` uma vez por vida, guarda em `_ember_rt_meta` e o publica no catálogo
  (coluna `colo` em `shards`) e no `ready`.

**Tela no painel (`apps/dashboard`):** uma página "Latência real", ao lado de `health.tsx` e `shards.tsx`.
1. **Cartões:** p50/p95 de `first_value`, `ack` e `rtt` nas últimas 24 h, e a taxa de reconexão.
2. **Mapa de calor país × colo do DO**, com p50 de `rtt` e sessões.
3. **Tabela por shard:** colo, p50/p95 de `ack` e `first_value`, inscritos e última escrita.
4. **Série temporal** de p95 com marcadores de deploy.

A consulta é a de `metrics-sql.ts` com `WHERE blob5 = 'rum'`.

## 7. Recursos e custo

**Criados e apagados** (`evidence/latency-cleanup.txt`; inventário final vazio de scripts, namespaces e D1):
- Workers `ember-spike-lat-ws`, `-ws-nocomp`, `-agent`, `-gate`, `-cold-noauth`, `-cold-auth`, `-cold-eager` e `-q`.
- Os namespaces de DO deles.
- Nada de D1, rota, domínio, R2 ou Queue.
- Segredos gerados por processo, guardados como secrets dos Workers, fora de log e de arquivo versionado. A evidência
  passa por redação (conta, subdomínio).

**Volume** (extrapolado das contagens): ~2 M envios de WebSocket (que não são cobrados), ~30 mil requisições de DO e
~20 mil linhas escritas. Ficou dentro do incluído no Workers Paid, com custo marginal de ~US$ 0.

## 8. Recomendação (ordem de ganho por esforço)

1. **Feito nesta PR, S3:** Better Auth sob demanda. Corta pela metade o custo do isolate frio com auth (+98 → +48 ms no
   p50) e o startup (53 → 32 ms), sem mudar storage nem a API pública.
2. **S6, telemetria do usuário real + colo do shard:** esforço médio. Sem ela, as conclusões de latência continuam
   vindo de um laptop em Campinas. O colo (uma leitura de `cdn-cgi/trace` por vida do shard) é a parte mais barata e
   pode vir antes.
3. **`warm` só quando o `verify` vai à rede:** esforço mínimo. Metade das requisições de DO do caminho HTTP com token.
4. **S3, o resto:** o `Auth` num script separado tiraria os 48 ms que sobram, mas exige migrar o namespace do DO de auth
   dos projetos existentes. Só vale com um caminho de migração seguro.
5. **S2:** documentado como limite da plataforma, com estes números. Um seguidor sem storage só se um app real de
   escrita constante sofrer com isso.
6. **S1:** nada a fazer. A compressão fica ligada.
7. **S4 e S5:** repetir o lado Convex no mesmo dia e as pendências do §5 numa rodada própria.

## Ressalvas

- **Agentes do P1:** a contagem de bytes e o JSON no lado dos agentes (o `ev.data` de um WebSocket cliente do Workers)
  não bateram com o que o laptop recebeu. A CPU do DO e a contagem de mensagens não dependem disso, e o conteúdo foi
  conferido pelo laptop (`check`).
- **P3:** amostras de "frio" de ~115 ms, iguais ao quente, aparecem nas três variantes. Provavelmente a versão nova
  ainda não tinha chegado ao isolate do DO. As medianas usam todas as amostras.
- **P2:** é um micro-teste da plataforma, não o runtime do Ember. O efeito vale para qualquer saída do objeto, o que
  inclui o Ember.
- **Local:** o payload do S1 é sintético (ids e texto pseudoaleatórios), e o startup local inclui o processo do
  workerd.
