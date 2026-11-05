# Integrações Cloudflare E2E na produção (PLAN §13, §6, §11)

Rodado em 2026-11-05, entre ~04:25 e ~05:05 UTC, na conta FreeCorps (`<ACCOUNT_ID>`). Só recursos `ember-spike-*`
foram criados; todos foram apagados no fim e a remoção conferida com GET (ver Limpeza).

- **Projeto.** `ember init --auth` (`project: "spike-integ"`, env `e2e`, `metrics.enabled: false`,
  `resources.browser: true`, `auth.turnstile: true`) em `packages/cli/.tmp/ember-spike-integ` (apagado no fim).
  Worker `ember-spike-integ-e2e`. Registro da conta desligado (`registry: false`): nenhum D1 criado.
- **Schema.**
  ```ts
  notes: defineTable({ title: v.string(), body: v.string(), topic: v.string() })
    .vectorIndex("semantic", { embed: "body", filterFields: ["topic"], shardIsolation: "filter" })
    .aiSearchIndex("kb_porter", { fields: ["title", "body"], defaultMode: "vector" })
    .aiSearchIndex("kb_trigram", { fields: ["title", "body"], keywordTokenizer: "trigram" })
  ```
  Actions `notes:semantic`, `notes:kb` (índice e `mode`), `tools:pdf` / `tools:shot` (`ctx.browser`),
  `tools:secretHash` (sha256 truncado de um env, nunca o valor).
- **Driver.** `docs/spikes/remote/scripts/integrations-e2e.ts` (Node, não Bun: o proxy remoto do wrangler recusa Bun),
  fases `deploy,env,turnstile,browser,load,search,remote-dev` e depois `destroy,verify-gone`, sobre a API programática
  da CLI (`deploy`, `envSet/envList/envGet/envRm`, `dev`, `destroy`).
- **Segredos.** Token da Cloudflare pela CLI (OAuth do wrangler), só em memória; admin token aleatório por processo,
  só em memória; o valor de teste de `E2E_SECRET` também (o log só tem booleanos e hashes). Saídas redigidas
  (`<ACCOUNT_ID>`, `<subdomain>`, caminhos locais). O log do próprio wrangler foi conferido: nenhum token.
- **Dados.** Os 30 documentos e 30 consultas pt-BR de `docs/spikes/ai-embeddings/dataset.ts`, em `global:main`, mais
  1 documento em `global:other` (isolamento).

## 1. Deploy (provisionamento)

```
deploy ember-spike-integ-e2e: create (new DO classes: Shard, System, Auth)
  bundle 2479.2 KiB sha256 76e9c00a6ff7
  auth: https://ember-spike-integ-e2e.<subdomain>.workers.dev (EMBER_AUTH_SECRET generated now)
  warning: auth.turnstile is on but ember-spike-integ-e2e has no TURNSTILE_SECRET_KEY: sign-up/sign-in answer 500 until `ember env set TURNSTILE_SECRET_KEY --env e2e`
  ai indexes: … (vectorize ember-spike-integ-e2e-notes-semantic-93fa1e74; vectorize …-semantic-93fa1e74 metadata _shard:string;
    vectorize …-semantic-93fa1e74 metadata topic:string; ai-search ember-spike-integ-e2e__notes_kb_porter_54cedd;
    ai-search ember-spike-integ-e2e__notes_kb_trigram_4d8ba3; queue ember-spike-integ-e2e-indexing)
  uploaded ember-spike-integ-e2e (created Shard, System, Auth)
  auth: embedded the JWKS (1 key) as EMBER_AUTH_JWKS
first deploy: deploy took 87438 ms (strategy create); bindings: …, browser:EMBER_BROWSER, vectorize:EMBER_VEC__notes__semantic,
  ai_search:EMBER_AIS__notes__kb_porter, ai_search:EMBER_AIS__notes__kb_trigram, ai:EMBER_AI, queue:EMBER_INDEXING
```

- O binding `{ "type": "browser", "name": "EMBER_BROWSER" }` foi aceito no upload por script.
- `_shard` foi criado como metadata index (`string`) **antes** de `topic` e antes do upload.
- `POST /ai-search/namespaces/default/instances` aceitou `indexing_options.keyword_tokenizer: "trigram"`. O GET
  devolve `{"keyword_tokenizer":"trigram","use_ocr":false}` (e `porter` na outra instância).

## 2. `ember env` (secrets de Worker)

```
ember env set E2E_SECRET: {"kind":"secret","created":true}
ember env set TURNSTILE_SECRET_KEY (test secret, always passes): {"kind":"secret","created":true}
ember env list: E2E_SECRET:secret EMBER_ADMIN_TOKEN:secret(managed) EMBER_AUTH_JWKS:secret(managed) EMBER_AUTH_SECRET:secret(managed) TURNSTILE_SECRET_KEY:secret
list output contains the value: false
ember env get (no --reveal): {"name":"E2E_SECRET","kind":"secret","managed":false} has value: false
ember env get --reveal matches what was set: true
--reveal EMBER_AUTH_SECRET refused: EMBER_AUTH_SECRET is managed by ember and is never revealed
--reveal EMBER_ADMIN_TOKEN refused: EMBER_ADMIN_TOKEN is managed by ember and is never revealed
set EMBER_ADMIN_TOKEN refused: EMBER_ADMIN_TOKEN: EMBER_* names are managed by ember (deploy, keys rotate); pick another name
secret visible to actions 159 ms after ember env set returned
deploy ember-spike-integ-e2e: code-only
  auth: … (EMBER_AUTH_SECRET kept from the previous deploy)
  uploaded version 87878596-… (#5)
  deployed 87878596@100%
after redeploy, ember env list: E2E_SECRET TURNSTILE_SECRET_KEY
after redeploy, actions see the same E2E_SECRET: true
```

- O `PUT …/secrets` publica uma versão nova na hora: a action já via o secret 159 ms depois.
- O deploy só de código (com uma função nova) mantém os secrets: os uploads levam `keep_bindings: secret_text`.
- `--reveal` passa por `POST /api/_ember/env/reveal`, que exige o admin token; nomes `EMBER_*` são recusados nos dois
  sentidos.

## 3. Turnstile no auth (chaves de teste da Cloudflare)

```
sign-up without token: 400 MISSING_RESPONSE
sign-up with the dummy token (secret 1x…AA, always passes): 200 user created
sign-in without token: 400 MISSING_RESPONSE
sign-in with the dummy token: 200 session token issued
sign-in with the always-fail secret (2x…AA): 403 VERIFICATION_FAILED (6119 ms after the secret change)
```

- A verificação é a do plugin `captcha` do Better Auth (`cloudflare-turnstile`), contra o siteverify real. Ela roda
  na Worker antes do hash de senha.
- Trocar o secret com `ember env set` passou a valer em ~6 s.
- Na suíte local (`packages/auth/test/turnstile.test.ts`, também contra o siteverify real) há mais casos:
  `3x…AA` (token já usado) → 403; `expectedAction` diferente → 403; sem secret → 500 `CAPTCHA_NOT_CONFIGURED`;
  nenhum hash gasto quando o pedido é recusado.

## 4. `ctx.browser` (quick actions do Browser Rendering)

```
deployed ctx.browser.pdf: 26839 bytes, application/pdf, starts with "%PDF-1.4", browserMs 0, action 1445 ms
deployed pdf pages: 1; sha256 36f87679b2f48989
deployed ctx.browser.screenshot: {"size":21798,"contentType":"image/png","png":true,"browserMs":0}
```

- HTML de fatura → PDF A4 com margens e CSS. O arquivo está em `evidence/integrations-deployed-invoice.pdf`: uma
  página, renderizada e conferida.
- O header `X-Browser-Ms-Used` veio `0` nas quick actions. O `browserMs` reflete o header como ele veio.

## 5. Vectorize com `shardIsolation: "filter"` e AI Search porter × trigram (`load`, `search`)

Escrita → buscável (30 docs numa mutation, 1025 ms HTTP):

| Índice | Buscável depois de |
|---|---|
| Vectorize `semantic` (bge-m3, `_shard` como filtro) | 83,9 s |
| AI Search `kb_porter` | 166,1 s |
| AI Search `kb_trigram` | 169,6 s |

Qualidade (30 consultas pt-BR, uma resposta certa cada). Foram duas rodadas, a segunda ~4 min depois da primeira, e
as métricas de qualidade saíram idênticas. A latência é de ação HTTP a partir de Campinas.

| Caminho | R@1 | R@3 | MRR@10 | p50 / p95 (ms) |
|---|---|---|---|---|
| `ctx.vectorSearch` semantic, shard como filtro | 0,933 | 1,000 | **0,967** | 359–720 / 823–2082 |
| AI Search porter, `hybrid` | 0,567 | 0,700 | 0,681 | 662–673 / 1089–1552 |
| AI Search porter, `keyword` | 0,267 | 0,433 | 0,385 | 543 / 652–739 |
| AI Search porter, `vector` | 0,900 | 1,000 | **0,950** | 575–621 / 769–1398 |
| AI Search **trigram**, `hybrid` | 0,567 | 0,800 | 0,717 | 644–783 / 1147–2022 |
| AI Search **trigram**, `keyword` | 0,267 | 0,367 | 0,332 | 510–513 / 603–769 |
| AI Search trigram, `vector` | 0,900 | 1,000 | **0,950** | 609–648 / 813–983 |
| AI Search porter, sem `mode` (`defaultMode: "vector"`) | 0,900 | 1,000 | 0,950 | 640–1188 / 900–2246 |

- **O shard como filtro não custa qualidade.** O MRR é o mesmo do modo namespace (0,967, `ai-indexes-e2e.md`).
- **Isolamento com filtro:** de `global:other`, a busca devolve 1 resultado, o documento dele, e nada de
  `global:main`. `topic: "rh"` combinado com `_shard` devolve só os 4 de RH (`d13, d14, d15, d24`).
- **Tokenizer:** o AI Search só oferece `porter` (stemming inglês) ou `trigram`. Não há opção de idioma nem de
  stemmer (API conferida em 2026-11).
  - O trigram melhora um pouco o híbrido: MRR 0,681 → 0,717 e R@3 0,70 → 0,80.
  - O keyword puro fica pior: 0,385 → 0,332.
  - Nenhum dos dois chega perto do vetor (0,950).
- **Recomendação para pt-BR:** `defaultMode: "vector"` no índice (quem quiser passa `mode` por busca). Se precisar de
  híbrido (termos exatos, códigos, nomes), use `keywordTokenizer: "trigram"`.
- `defaultMode` foi aplicado sem `mode`, com o mesmo resultado de `vector`.

## 6. `ember dev --remote` (workerd local, bindings remotos)

```
[dev] ember dev --remote: binding real resources of "e2e" (billed; writes land in them)
[dev] ember dev --remote: AI Search stays local (BM25 fallback) for notes.kb_porter, notes.kb_trigram: wrangler's remote proxy cannot carry AI Search bindings
[dev]   ai indexes: ember-spike-integ-e2e-notes-semantic-93fa1e74 (ok)
⎔ Establishing remote connection...
[dev] remote bindings (e2e): EMBER_AI, EMBER_VEC__notes__semantic, EMBER_BROWSER
[remote dev] inserted 3 notes on global:devremote (local shard; delivered to the remote indexes in the shard's turn)
[remote dev] local action → remote Workers AI + Vectorize found the right note: true (30490 ms after the write)
[remote dev] semantic action p50 581 ms, max 992 ms (local workerd, remote AI + Vectorize)
[remote dev] AI Search on the local BM25 fallback (not proxied) found it: true (36900 ms after the write)
remote-dev ctx.browser.pdf: 26570 bytes, application/pdf, starts with "%PDF-1.4", browserMs 0, action 2546 ms
remote-dev ctx.browser.screenshot: {"size":21798,"contentType":"image/png","png":true,"browserMs":0}
[remote dev] global:devremote semantic results: 6 (only its 3 notes: false)
[remote dev] after close: GET /workers/scripts/ember-spike-integ-e2e-dev-proxy -> 404
```

- Funcionam pelo proxy: Workers AI (embeddings do consumer local e da busca), Vectorize (upsert e query com
  `_shard`) e o binding `browser`, inclusive `quickAction`.
- **AI Search não passa pelo proxy.** Numa primeira rodada ele estava ligado remoto e falhou:
  - `items.upload` → `The RPC receiver does not implement the method "upload"`;
  - `search()` → `internal error; reference = …` (wrangler 4.157);
  - também não está na lista de bindings remotos da Cloudflare.

  O código foi mudado para deixar o AI Search no fallback local no modo `--remote`, com aviso, e esta é a rodada
  depois da mudança.
- **Dados compartilhados (trade-off documentado):** as 6 notas de `global:devremote` são as 3 desta rodada mais as 3
  da rodada abortada. O nome de shard era o mesmo e os vetores remotos persistem entre sessões do dev, embora o
  SQLite local não persista (`persist: false`). Por isso a recomendação é um env `dev` dedicado.
- Latência da ação semântica no dev: p50 581 ms, contra 359–720 ms com o Worker deployado. Cada embed e cada query
  atravessam a rede a partir do laptop.
- Nenhuma Worker com o nome do proxy ficou na conta depois do `close`.

## Limpeza

```
ember env rm E2E_SECRET: secret
ember env rm TURNSTILE_SECRET_KEY: secret
  detached ember-spike-integ-e2e from queue ember-spike-integ-e2e-indexing
  deleted worker ember-spike-integ-e2e
  deleted vectorize ember-spike-integ-e2e-notes-semantic-93fa1e74
  deleted ai-search ember-spike-integ-e2e__notes_kb_trigram_4d8ba3
  deleted ai-search ember-spike-integ-e2e__notes_kb_porter_54cedd
  deleted queue ember-spike-integ-e2e-indexing
GET /workers/scripts/ember-spike-integ-e2e -> 404 [10007 This Worker does not exist on your account.]
GET /workers/scripts/ember-spike-integ-e2e-dev-proxy -> 404 [10007 This Worker does not exist on your account.]
GET /vectorize/v2/indexes/ember-spike-integ-e2e-notes-semantic-93fa1e74 -> 410 [3005 vectorize.index.deleted]
GET /ai-search/namespaces/default/instances/ember-spike-integ-e2e__notes_kb_porter_54cedd -> 404 [7002 ai_search_not_found]
GET /ai-search/namespaces/default/instances/ember-spike-integ-e2e__notes_kb_trigram_4d8ba3 -> 404 [7002 ai_search_not_found]
GET /queues?name=ember-spike-integ-e2e-indexing -> 0 queues
vectorize indexes named ember-spike-integ*: 0
ai-search instances named ember-spike-integ*: 0
workers named ember-spike-integ*: []
```

Nenhum D1 foi criado (`registry: false`) e nenhum dataset de Analytics Engine (`metrics.enabled: false`). O diretório
local do projeto foi apagado.
