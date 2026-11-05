# Arquivos, login e jobs

Login com Better Auth, upload de arquivos para o R2 com URLs pré-assinadas e um job agendado (mais um cron) que processa
cada upload e atualiza o documento em tempo real. É o "exemplo com login, upload e job agendado" da Fase 2 do
[PLAN](../../docs/PLAN.md).

## O que mostra

| Peça | Onde |
|---|---|
| Better Auth no Durable Object `Auth` (e-mail + senha); `ember` acrescenta o banco, o segredo e os plugins `bearer()` e `jwt()` | [`ember/auth.config.ts`](ember/auth.config.ts) |
| `ctx.auth.getUserIdentity()` nas funções: o Worker verifica o JWT (5 min) antes de rodar a função | [`ember/users.ts`](ember/users.ts), [`ember/files.ts`](ember/files.ts) |
| Upload em dois passos: a mutation `generateUploadUrl` decide quem pode enviar e devolve a URL pré-assinada do R2; os bytes vão direto para o R2; `save` registra o documento | `files.generateUploadUrl`, `files.save`, `client.files.upload` em [`web/src/App.tsx`](web/src/App.tsx) |
| `v.file()`: referência a um arquivo, com contagem de referências (o objeto é coletado depois que o último documento some) | [`ember/schema.ts`](ember/schema.ts) |
| Job agendado: `ctx.scheduler.runAfter(0, internal.files.process, ...)`, uma action que lê o arquivo do R2, calcula os metadados e grava o resultado com uma mutation | `files.process`, `files.finish` |
| Reatividade: a linha vai de `processing` para `ready` (ou `failed`) sozinha na tela | `files.list` |
| Cron: `retry-stuck-uploads` a cada 5 min reagenda o job de quem ficou em `processing` (job perdido, deploy no meio) | [`ember/crons.ts`](ember/crons.ts), `files.sweep` |

O job entende texto (linhas, palavras, prévia) e PNG (largura e altura); um PNG corrompido termina em `failed` com o erro.
Cada pessoa só vê e apaga os próprios uploads.

## Rodar

```sh
bun install                       # na raiz do repositório
cd examples/files-auth-jobs

bun run dev                       # terminal 1: o backend (ember dev) em http://localhost:8787
bun run web                       # terminal 2: a página, em http://localhost:5173
```

Crie uma conta, envie um `.txt` ou um `.png` e veja o selo passar de `processing` para `ready`.

- **R2.** Em `ember dev` o bucket é local (Miniflare) e as URLs de upload e download são assinadas pelo próprio Worker
  (modo proxy). Num deploy com `resources.files` e credenciais S3 do R2 (`EMBER_R2_ACCESS_KEY_ID` e
  `EMBER_R2_SECRET_ACCESS_KEY`, ou o token que o `ember deploy` cria), as URLs passam a ser pré-assinadas (SigV4) e os bytes
  nunca passam pelo Worker. O código do app é o mesmo nos dois modos.
- **Origem.** O Better Auth recusa origens que não conhece. A página em `localhost:5173` está em `trustedOrigins`
  (`ember/auth.config.ts`); troque pela origem do seu site. O Worker não envia cabeçalhos CORS em `/api`, então a página
  fala com ele na mesma origem (proxy do Vite aqui).
- **Sessão.** [`web/src/auth.ts`](web/src/auth.ts) guarda o token de sessão no `localStorage` e troca por um JWT curto em
  `GET /api/auth/token`, que é o que o `EmberClient` envia. Entrar e sair reautentica a conexão aberta (`client.setAuth`),
  e todas as queries rodam de novo com a nova identidade.

## Testes

```sh
bun run test      # ember codegen + tsc (backend e web) + vitest no workerd
```

[`test/uploads.test.ts`](test/uploads.test.ts) roda tudo no workerd, com o Durable Object `Auth` de verdade:

- sem login, as funções não veem identidade e o upload é recusado; depois do cadastro o JWT identifica a pessoa, e sair
  encerra isso;
- upload → o documento nasce `processing` → o job (pelo alarm do shard) o termina → a query viva mostra os metadados
  (texto, PNG, PNG inválido → `failed`); a URL de download funciona; uma pessoa não vê nem apaga os uploads de outra;
- arquivo grande demais, arquivo que não foi enviado e quem não está logado são recusados;
- o cron: um tick do System Durable Object despacha `retry-stuck-uploads` e o upload esquecido é processado.

O teste usa o mesmo `web/src/auth.ts` da página. O worker de teste ([`test/worker.ts`](test/worker.ts)) tem um relógio que o
teste pode mover, e [`test/testing.ts`](test/testing.ts) uma mutation só de teste que cria o upload "esquecido".

## Estrutura

```
ember/            o backend: schema.ts, auth.config.ts, files.ts, users.ts, crons.ts, _metadata.ts (+ _generated)
web/              a página (Vite + React): src/App.tsx, src/auth.ts, src/ember.ts
test/             worker de teste (com o DO Auth) e os testes
ember.json        resources.files: true cria o bucket do R2 (e a fila de eventos) no deploy
```
