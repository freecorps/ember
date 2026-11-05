# Email E2E e R11 na produção da Cloudflare (PLAN §16, §18)

Rodado em 2026-11-04/05 (~23:45–00:40 UTC), na conta FreeCorps (`<ACCOUNT_ID>`), zona `<zone>` (uma zona da FreeCorps
que já tinha Email Routing ligado para um subdomínio de produção e Email Sending para três subdomínios). Três rodadas;
todas terminaram apagando tudo (ver Limpeza).

- **Driver:** `docs/spikes/remote/scripts/email-e2e.ts` (fases `all`, `inventory`, `cleanup`), com
  `bun --conditions=@freecorps/ember-source run docs/spikes/remote/scripts/email-e2e.ts all`.
  - **Hoje (desde 2026-11-05):** usa a API programática da CLI (`deploy`, `destroy`), publica
    `examples/email-lite` (só o componente, com rotas admin mínimas) e faz o onboarding com
    `@freecorps/ember-email/cloudflare` da máquina do operador. Com `SPIKE_ENABLE_ROUTING=1`, cria o subdomínio de
    roteamento e fecha o ciclo envio → `email()` → thread → resposta. Esse subdomínio sai depois pelo dashboard.
  - **As rodadas abaixo** rodaram com a versão anterior do driver: o `apps/mail` e o SDK dele, que agora moram em
    [freecorps/mail](https://github.com/freecorps/mail). O código do componente e do onboarding é o mesmo.
- **Segredos:** token da Cloudflare pela busca da CLI (OAuth do wrangler), só em memória e nunca enviado ao Worker; admin
  token aleatório por processo (nas rodadas abaixo, a chave `sending_access` criada pela API só existiu em memória). Saídas redigidas
  (`<ACCOUNT_ID>`, `<zone>`, `<subdomain>`, `<id>`, caminhos).
- **Recursos criados (só `ember-spike-*`):** Worker `ember-spike-mail-test` (projeto `spike-mail`, env `test`, sem
  registro D1, sem métricas, sem `files`), fila do componente `ember-spike-mail-test-email-events`, domínio de envio
  `ember-spike-mail.<zone>` (Email Sending, criado e apagado pela API), assinatura de eventos
  `ember-spike-mail-test-email-events ember-spike-mail.<zone>`.
- **Nada existente foi tocado:** nenhum registro DNS, regra de roteamento, catch-all ou configuração do apex. O
  inventário antes/depois confere as 5 regras e o subdomínio de roteamento de produção.
- **Destinatários:** só endereços inexistentes no próprio subdomínio de teste (nenhuma pessoa real).

## 1. Deploy (rodadas de 2026-11-04/05, com o `apps/mail` de então)

```
deploy ember-spike-mail-test: create (new DO classes: Shard, System)
  bundle 630.6 KiB sha256 7c0bd895385c
  component queue ember-spike-mail-test-email-events (created, email)
  uploaded ember-spike-mail-test (created Shard, System)
  cron triggers: * * * * *                      ← cron do componente (@email/sweep)
  component queue ember-spike-mail-test-email-events: Worker consumer added
ember-spike-mail-test → https://ember-spike-mail-test.<subdomain>.workers.dev
  shards ready: global:main
deploy took 15028 ms
```

Os ganchos de componente funcionaram em produção: a fila do componente foi criada antes do upload, ligada como producer
(`EMBER_Q_EMAIL_EVENTS`) e consumida pelo Worker; o binding `send_email` (`EMAIL`) e o Cron Trigger vieram do componente.

## 2. Domínio (onboarding pela API, da máquina do operador)

```
{"status":"pending","routing":"subdomain_missing","records":[
  "Sending MX cf-bounce.ember-spike-mail.<zone>" ×3, "Sending TXT cf-bounce.ember-spike-mail.<zone>",
  "Sending TXT cf-bounce._domainkey.ember-spike-mail.<zone>", "Sending TXT _dmarc.ember-spike-mail.<zone>",
  "Receiving MX ember-spike-mail.<zone>" ×3, "Receiving TXT ember-spike-mail.<zone>"],
 "notes":["Add ember-spike-mail.<zone> under Email Routing → Settings → Subdomains (adds MX/SPF on ember-spike-mail.<zone> only), or call verify with enableRouting."]}
after verify: {"capabilities":{"sending":"enabled","receiving":"enabled"},"subscription":true}
```

- `POST /zones/{z}/email/sending/subdomains {name}` criou o domínio de envio. A Cloudflare gerencia os registros
  (`cf-bounce` MX/SPF, DKIM, DMARC), sem permissão de DNS no token.
- **O domínio novo leva ~1–2 min para aceitar envio.** O `send` respondeu `E_SENDER_DOMAIN_NOT_AVAILABLE` em +22 s e
  +75 s e funcionou em +108 s. Na rodada 2 o código era tratado como permanente e os seis envios falharam. Agora é
  transitório (retry com backoff): commit `fix(email): E_SENDER_DOMAIN_NOT_AVAILABLE is transient`.
- **Assinatura de eventos:** `POST /accounts/{id}/event_subscriptions/subscriptions` com
  `source {type:"email.sending", zone_id, domain}` e `destination {type:"queues.queue", queue_id}`.
  - Os nomes em `events` são os curtos (`message.delivered`, `message.bounced`, ...).
  - Os nomes completos (`cf.email.sending.message.*`, que é o `type` das mensagens) dão
    `400 Unrecognized event types for source type` (rodada 1).
- **Recebimento: não habilitado nesta rodada (decisão de segurança).** Ver a seção 5.

## 3. R11 — fila de eventos do Email Service (rodada 3)

Seis emails pela API HTTP (`POST /emails` com `Idempotency-Key`; a repetição devolveu o mesmo id). Três para
`bounce-*@ember-spike-mail.<zone>` (o subdomínio de teste não tem MX) e três para `probe-*@cf-bounce.ember-spike-mail.<zone>`
(MX da Cloudflare, sem caixa). Esperamos 10 min por eventos.

| destino | eventos (tipo, motivo, ms após o `send`, ms do `eventTimestamp` até gravar no shard, duplicatas) | status final |
|---|---|---|
| sem MX ×3 | `deferred` "No available upstream" em ≈ +0,7–1,3 s, +18 s, +78–80 s (`terminal: false`); fila 1,0–4,6 s; 0 dup | `delivery_delayed` (a Cloudflare segue tentando) |
| cf-bounce ×3 | `bounced` "550 5.1.1 Domain does not exist" em +1,8–2,1 s; fila 2,1–2,9 s; 0 dup | `bounced` (hard → supressão do projeto) |

```
R11 summary: {"events":12,"duplicates":0,"outOfOrderEmails":0,
  "queueMs":{"min":1030,"p50":2895,"max":4607},          ← eventTimestamp → linha gravada no shard
  "sendToShardMs":{"min":4267,"p50":21142,"max":81342}}  ← chamada ao /emails → evento gravado
```

O que decide para o componente:
- **Latência:** 1–4,6 s do evento até o estado no shard (a fila entrega em lote, `maxBatchTimeoutSeconds: 2`). Status
  ao vivo com poucos segundos de atraso. Hard bounce aparece ~4–5 s depois do `send`.
- **Duplicatas:** nenhuma em 12 eventos. Mesmo assim o componente deduplica por `eventId` (a documentação não promete
  exactly-once) e conta redeliveries em `events.duplicates`.
- **Ordem:** os eventos de cada email chegaram em ordem. A documentação não garante ordem, então o status continua
  "só avança".
- **`deferred` repetidos:** o mesmo email gera vários `deferred` (`terminal: false`), cada um com seu `eventId`.
  Ficam como eventos; o status é `delivery_delayed` até um terminal.
- **Sem `delivered` nesta rodada:** não havia caixa de destino controlada (ver a seção 5). O caminho `delivered` está
  coberto pelos testes do componente e do app no workerd.

## 4. Limpeza (as três rodadas)

```
domain resources removed ok                         ← assinatura + domínio de envio (criados pelo onboarding)
  detached ember-spike-mail-test from queue ember-spike-mail-test-email-events
  deleted worker ember-spike-mail-test
  deleted queue ember-spike-mail-test-email-events
GET ember-spike-mail-test/settings → HTTP 404
inventory after: {"workers":[],"queues":[],"buckets":[],"sendingDomains":[],"subscriptions":[],"spikeRoutingRules":0,
  "routingSubdomains":["nfe.<zone>"],"routingRulesTotal":5}
routing rules unchanged: true | routing subdomains unchanged: true
```

## 5. Recebimento e `delivered` (resolvido em produção)

- **Por que o recebimento não rodou aqui:** o recebimento no subdomínio de teste exige um subdomínio de roteamento
  (`POST /zones/{z}/email/routing/dns {"name": ...}`). Não há API para remover esse subdomínio: o único
  `DELETE /zones/{z}/email/routing/dns` desliga o Email Routing da zona inteira. Como estas rodadas tinham de apagar
  tudo, o passo ficou de fora. O driver atual faz isso com `SPIKE_ENABLE_ROUTING=1`, e o subdomínio sai depois pelo
  dashboard.
- **Decisão do dono da zona:** usar o subdomínio `atendimento.freecorps.com.br` (opção b). O MX do apex continua no
  servidor de email próprio da FreeCorps.
- **Provado em 2026-11-05:** um deploy de produção do componente recebeu em `support@`/`privacy@atendimento.freecorps.com.br`:
  - inbound em 1,7–3,7 s;
  - eventos `delivered` em 3,1–7,6 s até o shard;
  - a resposta entrou na thread original;
  - 0 duplicatas.

  A operação desse deploy fica em [freecorps/mail](https://github.com/freecorps/mail) (`docs/operations.md`).
