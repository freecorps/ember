# Chat

Salas e mensagens em tempo real. É o app de exemplo da Fase 1 do [PLAN](../../docs/PLAN.md): o menor chat que usa o que
o Ember tem de mais característico, escrito como se escreve no Convex.

## O que mostra

| Peça | Onde |
|---|---|
| Schema com índice, `_creationTime` implícito no fim de todo índice e índice de busca (FTS5) | [`ember/schema.ts`](ember/schema.ts) |
| Queries reativas: o React re-renderiza quando alguém, em qualquer aba, envia algo | `useQuery` em [`web/src/App.tsx`](web/src/App.tsx) |
| Histórico paginado: cada página é uma query viva (`.paginate()` no servidor, `usePaginatedQuery` no cliente) | [`ember/messages.ts`](ember/messages.ts) |
| Envio otimista: a mensagem aparece na hora, a versão do servidor a substitui, e uma falha desfaz | [`web/src/optimistic.ts`](web/src/optimistic.ts) |
| Busca de texto numa sala (`withSearchIndex`, melhor resultado primeiro) | `messages.search` |
| Mutation que valida e rejeita (mensagem vazia, longa demais, sala inexistente) | `messages.send` |

Não há login: cada pessoa escolhe um apelido. O [exemplo de arquivos, login e jobs](../files-auth-jobs) mostra o login.

## Rodar

```sh
bun install                       # na raiz do repositório
cd examples/chat

bun run dev                       # terminal 1: o backend (ember dev) em http://localhost:8787
bun run web                       # terminal 2: a página, em http://localhost:5173
```

Abra duas abas, crie uma sala e converse. O `ember dev` roda no workerd (Miniflare) e gera `ember/_generated` (tipos de
`api` e `server`) a cada mudança em `ember/`. O Vite faz proxy de `/api` e `/ws` para o backend: o Worker não envia
cabeçalhos CORS, então a página precisa falar com ele na mesma origem. Se o backend estiver em outra porta:
`EMBER_URL=http://localhost:8798 bun run web`.

Para publicar: `ember deploy --env dev --wait` (precisa de `CLOUDFLARE_API_TOKEN`; veja o README da raiz). A página (`bun run
build:web` gera `web/dist`) precisa ser servida na mesma origem do Worker ou atrás de um proxy.

## Testes

```sh
bun run test      # ember codegen + tsc (backend e web) + vitest no workerd
```

[`test/chat.test.ts`](test/chat.test.ts) roda o backend de verdade no workerd e fala com ele pelo `EmberClient` (o mesmo
que os hooks do React usam): criação idempotente de salas, validação, o histórico percorrido página a página sem repetir
nem perder mensagens, a busca por sala (sem diferenciar maiúsculas nem acentos) e, por WebSocket, o envio otimista, a
troca pela versão do servidor, o rollback quando a mutation falha e a atualização em tempo real em outro cliente.

## Estrutura

```
ember/            o backend: schema.ts, rooms.ts, messages.ts (+ _generated, gerado)
web/              a página (Vite + React): src/App.tsx, src/optimistic.ts, src/ember.ts
test/             worker de teste (o mesmo que o ember gera) e os testes
ember.json        nome do projeto e ambientes
```
