# Todo

Listas de tarefas com filtros reativos e suporte offline. Mostra o `@freecorps/ember-offline` (IndexedDB) e a fila de
mutations offline.

## O que mostra

| Peça | Onde |
|---|---|
| Índices: `by_list` e `by_list_done` (o filtro "pendentes/feitas" faz parte do índice) | [`ember/schema.ts`](ember/schema.ts) |
| Filtro reativo: cada filtro é uma query viva própria e só roda de novo quando uma linha do seu intervalo muda | `todos.list` em [`ember/todos.ts`](ember/todos.ts) |
| Offline: um `StorageAdapter` (IndexedDB) guarda a fila de mutations, o último resultado de cada query e as linhas por trás deles | [`web/src/ember.ts`](web/src/ember.ts) |
| As mesmas queries rodam no aparelho, sobre a réplica local, quando não há rede (inclusive filtros que nunca foram abertos) | `queries: { ... }` em `ember.ts` |
| Atualizações otimistas registradas **por nome**: uma edição feita offline continua visível depois de recarregar a página | [`web/src/optimistic.ts`](web/src/optimistic.ts) |
| Mutations idempotentes por desenho: apagar uma tarefa que já sumiu não é erro, então reenviar a fila é seguro | `todos.remove` |

## Rodar

```sh
bun install                       # na raiz do repositório
cd examples/todo

bun run dev                       # terminal 1: o backend (ember dev) em http://localhost:8787
bun run web                       # terminal 2: a página, em http://localhost:5173
```

Para ver o offline, marque **Work offline** na barra lateral (ou use DevTools → Network → Offline). Adicione e marque
tarefas: elas aparecem na hora, esmaecidas, e o contador mostra "N changes waiting". Desmarque e a fila é reenviada, uma
vez cada (o servidor deduplica por `clientId` + `mid`), e as linhas esmaecidas viram as do servidor. Recarregar a página
com o backend parado mostra as listas e todos os filtros a partir do IndexedDB (DevTools → Application → IndexedDB →
`ember-todo`).

O que o offline **não** faz: mutations não rodam no cliente, então uma escrita offline não muda a réplica local, só as
camadas otimistas por cima dela. E a página em si (o app shell) não é guardada em cache: abrir o site sem rede exige um
service worker, que está fora do escopo deste exemplo.

## Testes

```sh
bun run test      # ember codegen + tsc (backend e web) + vitest no workerd
```

[`test/todo.test.ts`](test/todo.test.ts): os filtros por índice e as views vivas (completar uma tarefa a move de
"pendentes" para "feitas"; mudanças em outra lista não fazem a query rodar), e o cenário offline de ponta a ponta com
`fake-indexeddb` contra o runtime real: online → recarrega sem rede (lista e filtros saem do IndexedDB) → edita offline
(otimista, na fila) → recarrega de novo (a fila e as edições continuam) → volta a rede → a fila é reenviada e tudo converge
com o servidor.

## Estrutura

```
ember/            o backend: schema.ts, lists.ts, todos.ts (+ _generated, gerado)
web/              a página (Vite + React): src/App.tsx, src/ember.ts (cliente offline), src/optimistic.ts
test/             worker de teste e os testes
```
