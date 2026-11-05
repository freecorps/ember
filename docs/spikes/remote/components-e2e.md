# Componentes E2E na produção da Cloudflare (PLAN §12)

Rodado em 2026-11-04 (~23:40 UTC), na conta FreeCorps (`<ACCOUNT_ID>`). Só foi criado o Worker `ember-spike-comp-test`;
ele foi apagado no fim (ver Limpeza).

- **Driver:** `docs/spikes/remote/scripts/components-e2e.ts` (fases `deploy`, `run`, `destroy`, `inventory`), chamando a
  API programática da CLI (`deploy`, `destroy`) e `fetch` nas URLs. Rodado com
  `bun --conditions=@freecorps/ember-source run docs/spikes/remote/scripts/components-e2e.ts <fase>` (código-fonte, sem build).
- **Segredos:** token da Cloudflare pela busca da CLI (OAuth do wrangler), só em memória; admin token aleatório por
  processo, em memória. Saídas redigidas (`<ACCOUNT_ID>`, `<subdomain>`, caminhos locais).
- **Sem recursos extras:** registro da conta desligado (`registry: false`, nenhum D1), métricas desligadas (nenhum
  dataset), sem fila de actions (jobs de action rodam no alarm do shard).
- **App** (projeto `spike-comp`, env `test`, criado em `packages/runtime/.tmp`, apagado no fim):
  ```ts
  // ember/ember.config.ts
  export default defineApp()
    .use(rateLimit, { config: { binding: { name: "EMBER_SPIKE_RL", limit: 5, period: 60 } } })
    .use(workflows)
    .use(hits, { name: "web", config: { label: "spike" } });   // componente local: tabela + rota POST /in/* (montada em /web/in/*)
  // ember/http.ts: GET /hello
  // ember/fns.ts: post (RateLimiter, token bucket 2/min), tokens, hits, edge (edgeLimit), workflow flow
  //   (action → mutation → sleep 3 s → waitForEvent → mutation), start/status/journal/event/logs
  ```

## 1. Deploy

```
deploy ember-spike-comp-test: create (new DO classes: Shard, System)
  bundle 370.2 KiB sha256 34dc70153ceb
  uploaded ember-spike-comp-test (created Shard, System)
  cron triggers: none

ember-spike-comp-test → https://ember-spike-comp-test.<subdomain>.workers.dev
waiting for shards to migrate (schema 1ab77a606b1d)...
  shards ready: global:main
deploy took 11261 ms
ratelimit bindings on the Worker: [{"name":"EMBER_SPIKE_RL","namespace_id":"2065655931","simple":{"limit":5,"period":60},"type":"ratelimit"}]
```

- O schema composto (tabelas `posts`, `log`, `rateLimit$rateLimits`, `workflows$workflows`, `workflows$steps`,
  `workflows$events`, `web$hits`) migrou no primeiro acesso ao shard, como qualquer schema.
- O binding `ratelimit` pedido pelo componente (`bindings` → `componentBindings` no deploy) foi aceito na Script PUT
  junto com `exports`, os DOs e o secret `EMBER_ADMIN_TOKEN` (`keep_bindings`); o `namespace_id` é o derivado de
  `ember-spike-comp-test/EMBER_SPIKE_RL`.

## 2. Verificações (fase `run`, shard `global:e2e-<ts>`)

```
posts (capacity 2): [{"value":{"ok":true},"ms":724},{"value":{"ok":true},"ms":206},{"value":{"ok":false,"retryAfter":29559},"ms":188}]
PASS rateLimit: 2 allowed then refused with retryAfter
PASS rateLimit: a failing caller gives the token back (same transaction) {"error":{"code":"Error","message":"post failed after taking a token"},"tokens":{"value":2,"capacity":2,…}}
PASS clients cannot call @rateLimit/lib:limit {"code":"FunctionNotFound",…}
PASS clients cannot call @web/lib:get {"code":"FunctionNotFound",…}
PASS clients cannot call @web/lib:secret {"code":"FunctionNotFound",…}
PASS clients cannot call @workflows/lib:drive {"code":"FunctionNotFound",…}
PASS http: app route
PASS http: component route in the component's scope {"n":1,"label":"spike","shard":"global:main","ms":446}
PASS http: app reads the component through components.web
PASS http: wrong method is 405
  workflow +415 ms running:3:sleep
  workflow +3331 ms running:4:event
PASS workflow: reached waitForEvent after action, mutation and sleep steps
  workflow completed 380 ms after the event (3711 ms total)
  journal: [{"index":0,"kind":"action","name":"fns:lookup","status":"done","attempts":1,"ms":0},
            {"index":1,"kind":"mutation","name":"fns:record","status":"done","attempts":1,"ms":0},
            {"index":2,"kind":"sleep","name":"sleep","status":"done","attempts":0,"ms":3000},
            {"index":3,"kind":"event","name":"event:go","status":"done","attempts":0,"ms":279},
            {"index":4,"kind":"mutation","name":"fns:record","status":"done","attempts":1,"ms":0}]
PASS workflow: completed with the result {"status":"completed","stepCount":5,"result":42,…}
PASS workflow: mutation steps ran exactly once
PASS workflow: the sleep lasted >= 3 s (alarm)
edgeLimit results: [true,true,true,true,true,true,false,false,false,false,false,false]
PASS edgeLimit: the binding works and eventually refuses {"allowed":6}
```

O que isso mostra:
- **`rateLimit` transacional em produção:** a mutation que falha depois de pegar o token devolve o token (o
  consumo e a escrita do app estão na mesma `transactionSync`); o terceiro post é recusado com `retryAfter` ≈ 30 s
  (token bucket 2/min).
- **Isolamento:** funções de componente (públicas ou internas, inclusive o laço interno do `workflows`) não são
  alcançáveis por clientes (`FunctionNotFound`, sem revelar que existem).
- **HTTP:** rota do app e rota do componente montada em `/web` (rodando no escopo do componente, com
  `ctx.component.config`), leitura da tabela do componente pelo app via `components.web.lib.get`, 405 por método.
- **`workflows`:** start → action (rodou no alarm do shard, sem fila) → mutation → sleep de 3 s (alarm) → evento →
  mutation → `completed` em 3,7 s no total; o evento destravou o workflow em 380 ms (mutation + job + action de
  drive + mutation). As mutations do workflow rodaram uma vez cada. `ms: 0` nos passos de action/mutation é o
  relógio do DO, que não anda durante trabalho síncrono (PLAN §14), não a duração real.
- **Rate Limiting binding da Cloudflare:** limite 5/60 s, 12 chamadas com a mesma chave a partir da mesma máquina:
  6 aceitas, depois recusadas. Uma a mais que o limite, como a documentação avisa (contagem local, sincronizada em
  segundo plano; aproximada e por local). Por isso o `rateLimit` usa a tabela do shard para cotas exatas e o binding
  só como corte barato em actions/HTTP.

## 3. Limpeza

```
  deleted worker ember-spike-comp-test
destroy: {"deleted":["worker ember-spike-comp-test"],"warnings":[]}
inventory ember-spike-comp*: workers [] queues [] d1 [] | local project exists: false
GET ember-spike-comp-test/settings → HTTP 404
```

O inventário antes do deploy também era vazio. O binding de Rate Limiting não cria recurso na conta (o namespace é
só um número no binding), e nenhum D1, fila, bucket ou dataset foi criado.
