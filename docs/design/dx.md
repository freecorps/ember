# DX e tipos: o mapa completo

> Status: aceita (2026-11-12), com as recomendações da §7, e implementada: Fases A–C no PR #73 (`D13`), D no PR #74 (`D14`), E no PR 3 (`D15`); contratos em `contracts.md`.
> Ficou de fora (para depois): o plugin de language service (§3.12, opcional); claims da identidade tipados pelo `auth.config.ts` (`ctx.auth.require()` existe; os claims seguem `Record<string, unknown>`); os componentes `push` (fronteira genérica do registro de devices) e partes polimórficas do `email` continuam com `any`, dentro do orçamento de `bun run lint:any`.
> Evidências: o código atual do Ember (com reproduções feitas nesta análise) e o `groceryops`, um app grande em produção no Convex 1.46 (215 módulos em `convex/`, 1.208 linhas de `api.d.ts`).

**Objetivo:** passar o mouse sobre `api.messages.send` no VS Code e ver, sem abrir o servidor: os args, o retorno com nomes legíveis (`Doc<"messages">`, não 40 linhas expandidas), **os erros que a função pode lançar e o payload de cada um**, o shard onde ela roda, a documentação dela e um link para o handler. Tudo isso sem `any` na superfície pública e sem o cliente fazer typecheck do código do servidor.

---

## 0. Resumo em uma tela

| # | Proposta | Por quê | Convex tem? |
|---|---|---|---|
| DX1 | **Contrato por função** gerado estaticamente: args, retorno, **erros**, shard, visibilidade, docs, origem | é a base de todo o resto | parcial (sem erros e sem shard) |
| DX2 | **Erros tipados por função** (`defineErrors`, `throw errors.X(...)`), inferidos pelo codegen e exibidos no hover | hoje `code: string` e `data: unknown`; o groceryops reinventa isso com casts | não (`ConvexError<any>`) |
| DX3 | **Zero `any` público**: `unknown` no lugar de `any`, refs por string só com `unsafeRef()` | hoje `useQuery("x:y", { qualquer: 1 })` compila | não |
| DX4 | **Args obrigatórios de verdade** no cliente | hoje `useMutation(api.messages.send)()` compila sem args (reproduzido) | sim |
| DX5 | **Codegen convergente e incremental** (ponto fixo, programa TS reaproveitado, `--check` no CI) | hoje um clone limpo gera `any` em silêncio (reproduzido) | n/a (Convex importa os módulos) |
| DX6 | **Hover curto + Go to Definition** (tipos nomeados, JSDoc propagado, declaration map) | hoje o retorno vem expandido inline, sem docs e sem F12 | F12 sim, à custa de typechecar o servidor inteiro |
| DX7 | **Shards tipados e roteamento pelos args** | hoje `shard?: string` montado à mão | não existe (sem shards) |
| DX8 | **Middleware tipado no builder** (`query.use(...)`) que soma ctx, args e erros | o groceryops depende de `convex-helpers` para isso | via `convex-helpers` |
| DX9 | **Tipos do contexto**: `ctx.env`, claims da identidade, componentes gerados | hoje `Record<string, unknown>` e `Ref<>` escritos à mão | parcial |
| DX10 | **Validadores v2**: `pick/omit/partial/extend`, `schema.doc()`, paginação, refinamentos, Standard Schema, pré-validação no cliente | o exemplo `chat` recria `paginationOpts` à mão | parcial |
| DX11 | **Rotas HTTP tipadas** + cliente fetch tipado + OpenAPI | `httpAction` hoje é `Request → Response` cru | não |
| DX12 | **Ferramentas**: diagnósticos no `ember dev`, ESLint plugin, guia para IA gerado a partir do projeto, harness de teste tipado | fecham o ciclo | parcial |

---

## 1. Onde estamos

### 1.1 O que o Ember já faz melhor que o Convex (manter)

- **`api.d.ts` estático e sem imports do servidor** (`packages/cli/src/codegen/index.ts`). O Convex gera `import type * as accounts from "../accounts.js"` para **cada** módulo e monta `api` com `ApiFromModules<typeof fullApi>`. Consequências medidas no groceryops:
  - o typecheck do projeto raiz usa **~3,6 GB de RAM** e só ficou tolerável depois de migrar para o TypeScript 7 (`scripts/typecheck.mjs`: "about five times faster than 5.9");
  - **ciclos de inferência**: `api` depende dos módulos, que dependem de `api`. O guia oficial do Convex (`convex/_generated/ai/guidelines.md`) manda anotar o retorno do handler; o groceryops tem **35 `makeFunctionReference("mod:fn")` por nome** e comentários como `// inference across the pair is circular and resolves to any for both` (`convex/emailAutomationActions.ts:196`). Também escreveu **1.745 validadores `returns:`**, em boa parte para quebrar ciclos e baratear o typecheck.
  - No Ember, o servidor importa o `api.d.ts` estático e o ciclo não existe. **Essa vantagem é estrutural e deve ser preservada em qualquer redesenho.**
- Handlers síncronos checados no tipo (`SyncOnly<R>`), `ctx.vectorSearch`/`ctx.aiSearch` tipados por índice, `ctx.db.increment` restrito a campos numéricos, `IndexRangeBuilder` que segue a ordem dos campos do índice.
- Os exemplos (`examples/*/ember`) têm zero `any`.

### 1.2 Defeitos confirmados

Todos foram reproduzidos nesta análise numa cópia do `examples/chat` (já apagada).

| # | Defeito | Onde | Reprodução |
|---|---|---|---|
| B1 | **Args obrigatórios são opcionais no cliente.** `client.query/mutation/action` recebem `args?`; `useQuery` tem default `{}`; `ReactMutation` é `(args?) =>`; `useAction` idem. | `client/src/client.ts:793,855,891`, `react/src/index.ts:81,90,117`, `react-query` (`emberQuery`, `emberQueryOneShot`) | `c.mutation(api.messages.send)`, `useQuery(api.rooms.get)` e `send()` compilam; o erro só aparece em runtime (`ValidationError`). O lado do servidor já faz isso certo com `OptionalRestArgs`. |
| B2 | **Refs por string são aceitas em toda a API e viram `unknown`/`Record<string, unknown>`.** | `QueryRef = FunctionReference<"query"> \| string` (react, react-query, client) | `useQuery("rooms:get", { nope: 1 })` compila. Um typo no nome da função só aparece em runtime (`FunctionNotFound`). |
| B3 | **Codegen não converge: em um clone limpo, retornos que dependem de `ctx.runQuery` saem `any`, sem aviso.** O passo 1 escreve o stub `export declare const api: any` (`codegen/index.ts:72`), e a inferência roda uma vez sobre ele. | `codegen/index.ts`, `codegen/returnTypes.ts` | `outer = query({ handler: (ctx) => ctx.runQuery(internal.rooms.inner) })` → 1ª execução: `FunctionReference<"query","public",{},any>`; 2ª: o tipo certo. Pelo mesmo motivo, quando o callee muda, o chamador fica **uma geração atrasado**. Como `_generated/` não é commitado, todo CI e todo clone novo passa por isso. |
| B4 | **Erros sem tipo.** `EmberError.code` é `string` e `data` é `unknown` no cliente; no servidor, `code` é restrito a `EmberErrorCode`, e o app não tem como lançar um código próprio. `throw new Error("No such room")` chega como `code: "Error"`. | `server/src/errors.ts:27`, `client/src/errors.ts` | O componente de email faz `new EmberError("RateLimited" as any, …)` (`email/src/component.ts:249`). |
| B5 | **Hover ruim.** O retorno é impresso inline e expandido (sem `Doc<"rooms">`), sem o JSDoc da função e sem Go to Definition (o `.d.ts` não tem declaration map). | `codegen/returnTypes.ts` (`TypePrinter`), `apiDts()` | Em `api.messages.list`, o hover tem ~20 linhas de objeto literal. Num app como o groceryops, chega a centenas. |
| B6 | **`any` vazando para o usuário.** `v.any()` infere `any` (`values/src/validators.ts:84`), `AnyDataModel.document: any`, `OptimisticUpdate<Args = any>`, `MutationOptions<Args = any>`, `anyApi: any`, `anyComponents: any`. | `values`, `server`, `client` | Um `v.any()` num campo desliga o typecheck de tudo que lê esse documento. |
| B7 | **Componentes escrevem os próprios tipos à mão.** As refs do cliente são `Ref<"query", {...}, ...>` duplicadas (`email/src/client.ts:92+`, `workflows/src/index.ts:37+`), e os helpers internos usam `type Ctx = { db: any; … }` (`email/src/component.ts:108`) porque `componentBuilders` não exporta os tipos de ctx. | `email`, `workflows`, `push`, `rate-limit` | É a maior parte dos ~330 `any` (contagem por regex) em `packages/*/src`: email 97, server 83, workflows 33, push 27, client 20. |
| B8 | **Shards são strings.** `ShardOptions.shard?: string`, e uma função não declara em que tipo de shard roda (o PLAN §3 previa `shard: "mailbox"` na definição; isso não foi feito). | `client/src/client.ts:104`, `server/src/functions.ts` | Chamar uma função de `mailbox` no shard `org:acme` compila. |
| B9 | **Contexto sem tipo:** `ctx.env: Record<string, unknown>` e `Identity.claims?: Record<string, unknown>`. | `functions.ts:222`, `types.ts:59` | `ctx.env.STRIPE_KEY` é `unknown` e precisa de cast. |
| B10 | **Faltam helpers de validador:** `paginationOptsValidator` (o chat recria à mão em `examples/chat/ember/messages.ts:7`), `paginationResultValidator`, `.pick/.omit/.partial/.extend`, `schema.doc(table)`, `v.record(keys, values)`. | `values` | — |
| B11 | **Tipo de paginação duplicado e divergente:** o React declara `continueCursor: string \| null` (`react/src/index.ts:147`) e o servidor, `string` (`server/src/query.ts`). | `react`, `server` | — |
| B12 | **Custo do codegen:** um `ts.createProgram` novo a cada salvamento no `ember dev`, sem reaproveitar o programa anterior. São ~550 ms no chat (8 funções); vai crescer com o app. Além disso, o TS 7 (que o groceryops já usa) não tem API JavaScript. | `returnTypes.ts` | — |

### 1.3 O que o groceryops ensina sobre o Convex em produção

Os números são ocorrências em `apps/`, `packages/` e `convex/`.

| Sinal | Números | O que significa para o Ember |
|---|---|---|
| Tipos derivados à mão a partir de `api` | 476× `FunctionReturnType<typeof api.x.y>`, 100× `FunctionArgs<>`, padrões como `FunctionReturnType<typeof api.buyerPortalInvoices.listInvoices>["page"][number]` | Gerar **aliases nomeados** por função (`Returns<>`, `Item<>` para páginas) e exportar os tipos que o usuário declara no servidor |
| `Doc<>` e `Id<>` por toda parte | 2.624× `Doc<"…">`, 3.720× `Id<"…">` | Manter `Doc`/`Id` e imprimi-los **pelo nome** no retorno gerado (B5) |
| Erros de aplicação | `convex/lib/appError.ts`: uma união global com 50+ códigos, `details: Record<string, Value>` sem tipo, `appErrorCode(error: unknown)` com `(error as { data?: { code?: string } })` | Erros **por função**, com payload tipado por validador (DX2) |
| Consumo dos erros no cliente | `apps/web/lib/app-errors.ts` normaliza `error.data` e `error.cause` e chega a ter `inferCodeFromMessage(...)`; diálogos fazem `if (data?.code !== "STOCK_SHORTFALL") return false` e depois `readStockShortfall(data.details)` para validar o payload em runtime | `isError(e, api.orders.confirm, "StockShortfall")` estreita o tipo; `e.data` já vem validado |
| Commitou ou não? | o app mobile usa `!(error instanceof ConvexError)` para marcar trabalho como `uncertain` | O erro precisa dizer se a mutation **foi recusada** ou se o resultado **é desconhecido** (rede) |
| Mensagens | `DEFAULT_MESSAGES` no servidor, `DEFAULT_ERROR_MESSAGES` e `ERROR_TITLES` no web | Mensagem padrão por código no servidor e mapa tipado por código no cliente (i18n) |
| Middleware | `convex-helpers` `customMutation` + `Triggers`, com 7 "acumuladores" executados no fim da mutation (`convex/lib/functions.ts`) | `query.use()` / `mutation.use()` first-class, com `onSuccess` (DX8) |
| Ciclos de tipo | 35 refs por nome, handlers anotados, 1.745 `returns:` | O Ember já resolve isso; o codegen só precisa convergir (B3) |
| Custo do typecheck | TS 7, `--checkers 2`, ~3,6 GB | O cliente não deve importar o servidor (já é assim); o codegen precisa de estratégia para TS 7 (B12) |

---

## 2. Princípios

1. **Um contrato por função, gerado, estático.** O `api.d.ts` continua sem importar código do servidor. O que o servidor sabe (validadores, handler, erros, shard, docs) vira texto de tipo.
2. **O tipo diz a verdade ou falha alto.** Um `any` ou `unknown` inferido gera aviso no `ember dev` e erro no `ember codegen --strict`. Nunca em silêncio.
3. **O caminho tipado é o caminho fácil.** Refs por string existem só atrás de um nome que assusta (`unsafeRef`).
4. **Hover é UI.** Os tipos gerados são escritos para humanos: nomes curtos, docs, uma linha por conceito.
5. **Inferir por padrão, declarar para travar.** Retornos e erros são inferidos; `returns:` e `errors:` viram contrato checado quando o autor quer estabilidade (API pública, componentes).
6. **Nada de nova dependência obrigatória** em `values`/`server` (eles rodam em workerd, browser e RN).

---

## 3. Design

### 3.1 Contrato e `FunctionReference` v2

```ts
// tipo único, compartilhado por server, client e o api.d.ts gerado (estruturalmente compatível)
declare const REF: unique symbol;
export interface FunctionReference<
  Type extends "query" | "mutation" | "action",
  Vis extends "public" | "internal",
  Args,            // o que o chamador manda (input: campos com default são opcionais)
  Returns,
  Errors extends AppErrorShape = never,
  Shard extends ShardSpec = ShardSpec,
> {
  readonly [REF]: true;          // uma string não é atribuível (DX3)
  readonly _type: Type;
  readonly _visibility: Vis;
  readonly _args: Args;
  readonly _returnType: Returns;
  readonly _errors: Errors;
  readonly _shard: Shard;
}
```

- Os campos continuam fantasmas (só existem no tipo); o runtime segue sendo o Proxy com `Symbol.for("ember.functionName")`.
- Helpers públicos: `Args<F>`, `Returns<F>`, `Errors<F>`, `Item<F>` (item de um retorno paginado), `Doc<T>`, `DocInput<T>` (sem campos de sistema), `Id<T>`.
- Para o hover, o `api.d.ts` gerado usa aliases curtos: `Query<Args, Returns, Errors>`, `Mutation<…>`, `Action<…>`, `InternalQuery<…>`.

**Hover alvo** (`api.messages.send`):

```
(property) send: Mutation<{ roomId: Id<"rooms">; author: string; body: string }, Id<"messages">, RoomNotFound | MessageTooLong | Unauthenticated>

Sends a message to a room.

@shard room (from args.roomId)
@throws RoomNotFound — { roomId: Id<"rooms"> }
@throws MessageTooLong — { max: number }
@throws Unauthenticated — (from middleware authed)
@source ember/messages.ts:24
```

### 3.2 Erros tipados (DX2)

**Servidor:**

```ts
// ember/errors.ts (convenção; pode ficar em qualquer módulo de ember/)
import { defineErrors, v } from "@freecorps/ember-server";

export const errors = defineErrors({
  RoomNotFound: { data: v.object({ roomId: v.id("rooms") }), message: "This room no longer exists." },
  MessageTooLong: { data: v.object({ max: v.number() }), message: (d) => `Messages are limited to ${d.max} characters.` },
  StockShortfall: { data: v.object({ canOverride: v.boolean(), lines: v.array(shortLine) }) },
  Unauthenticated: {},
});

// ember/messages.ts
export const send = mutation({
  args: { roomId: v.id("rooms"), author: v.string(), body: v.string() },
  errors: [errors.RoomNotFound, errors.MessageTooLong],   // opcional: trava o contrato
  handler: (ctx, { roomId, body }) => {
    if (body.length > MAX) throw errors.MessageTooLong({ max: MAX });
    if (!ctx.db.get(roomId)) throw errors.RoomNotFound({ roomId });
    return ctx.db.insert("messages", { roomId, author, body });
  },
});
```

- `errors.X(data)` devolve uma `AppError<"X", Data>` (subclasse de `EmberError`) e funciona em qualquer lugar: handlers e helpers de `lib/` (o `throwAppError` do groceryops vira isso).
- **No wire:** `{ kind: "app", code, message, data }`. O servidor valida `data` contra o validador antes de enviar: um payload errado vira erro de sistema e é logado, nunca vaza.
- **Erros de sistema** continuam sendo `EmberErrorCode` (`ValidationError`, `TooManyReads`, …), com `kind: "system"`. `throw new Error(...)` do usuário vira `{ kind: "system", code: "Internal" }`, com a mensagem escondida em produção (como o Convex faz) e visível no `ember dev`.
- **Do lado do cliente, o erro diz se houve commit:** `error.outcome: "rejected"` (o servidor respondeu e nada foi gravado) ou `"unknown"` (caiu a rede depois do envio; o dedup por `mid` torna o reenvio seguro). Isso substitui o `instanceof ConvexError → uncertain` do groceryops.

**Como o codegen descobre os erros** (porque o TypeScript não tem `throws`):

1. **Inferência por grafo de chamadas** (melhor esforço, pelo type checker): no corpo do handler e nas funções do projeto que ele chama (resolvidas pelo checker, até N níveis), o codegen procura `throw errors.X(...)` e `ctx.fail.X(...)`, além de `ctx.runQuery/runMutation(ref)`, cujos erros são propagados. Uma chamada dentro de `try` só propaga se o `catch` relançar.
2. **Declaração** (`errors: [...]`): é o contrato. O codegen avisa se a inferência encontrar um erro fora da lista ("`send` pode lançar `Forbidden` (lib/authz.ts:40) e não o declara") e, com `--strict`, falha.
3. Erros somados por middleware (`.use()`, §3.8) entram automaticamente.
4. Opcional, em nível de tipo: com `errors` declarado, `ctx.fail` só expõe os códigos da lista. Isso dá erro de compilação ao tentar lançar algo não declarado.

**Cliente:**

```ts
import { isError } from "@freecorps/ember-client";

try { await send({ roomId, author, body }); }
catch (e) {
  if (isError(e, api.messages.send, "MessageTooLong")) toast(`max ${e.data.max}`);   // e.data: { max: number }
  else throw e;
}

// ou sem exceção:
const r = await send.safe({ roomId, author, body });
if (!r.ok) switch (r.error.code) {           // união discriminada: "RoomNotFound" | "MessageTooLong" | SystemErrorCode
  case "RoomNotFound": …
}
```

- `_generated/errors.js` + `.d.ts`: cada erro com `.code` e `.is(e)`, sem importar o servidor, para usar fora do contexto de uma função.
- Mensagens: o servidor tem a mensagem padrão; o cliente pode passar `errorMessages: { [code]: (data) => string }`, tipado pelos códigos do app (i18n).
- React Query: `TError` vira `EmberErrorOf<F>`, e `useMutation({ ...emberMutation(api.x.y) })` já vem tipado.

### 3.3 Args precisos (DX4)

- Todas as entradas do cliente usam o mesmo `OptionalRestArgs<F>` do servidor: `[args?]` só quando `{}` é atribuível a `Args`.
  - `client.query(ref, ...args)`, `client.mutation(ref, ...[args, opts])`: as opções vão para um 3º parâmetro posicional, ou para uma sobrecarga com `{ args, shard, optimisticUpdate }`.
  - `useQuery(ref, ...argsOrSkip)`: `"skip"` continua valendo.
  - `ReactMutation<M>` vira `(...args: OptionalRestArgs<M>) => Promise<Returns<M>>`.
- Args de **input** e de **output** se separam quando existirem `.default()` e transformações (§3.10): o cliente vê o input, o handler recebe o output.
- Testes de tipo garantem os casos (`expectTypeOf`, §5).

### 3.4 Sem `any` público (DX3)

- Refs: os overloads tipados aceitam só `FunctionReference`. String só via `unsafeRef<"query">("mod:fn")`, que devolve `FunctionReference<"query", …, unknown, unknown>`.
  - Um codemod troca as strings literais por `api.x.y` quando o nome existe no manifest.
  - `optimisticUpdates: { "messages:send": … }` e `queries: { "messages:list": list }` (offline) passam a ser chaves tipadas (`keyof typeof api` achatado) ou uma lista de pares `[api.messages.send, fn]`.
- `v.any()` → `unknown`. Quem quiser mesmo `any` usa `v.unsafeAny()`. É uma mudança que quebra código de propósito e vem anunciada no CHANGELOG.
- `OptimisticUpdate<Args = unknown>`, `MutationOptions<Args = unknown>`. `anyApi`/`anyComponents` ficam internos.
- Lint interno no CI: `@typescript-eslint/no-explicit-any` como erro em `packages/*/src`, com uma allowlist por arquivo que só pode encolher.

### 3.5 Codegen v2 (DX5, DX6)

**Pipeline:**

```
discover → load (esbuild/eval, como hoje) → manifest
        → type oracle (programa TS reaproveitado, com host virtual)
        → ponto fixo: api.d.ts em memória → inferir → comparar → repetir (máx. 4)
        → emitir: api.d.ts (+ .map), types.d.ts, errors.{js,d.ts}, dataModel.d.ts, server.d.ts, components.d.ts, manifest.json
```

1. **Convergência (corrige B3).** A inferência enxerga o `api.d.ts` da iteração anterior por um `CompilerHost` virtual (nada é escrito em disco entre as iterações).
   - A 1ª iteração parte das funções com `returns:` e dos tipos já conhecidos. Para de iterar quando o texto não muda.
   - Um ciclo real (A retorna B, que retorna A) termina em `unknown`, com um aviso que mostra o ciclo e sugere `returns:`.
   - O stub `api: any` deixa de existir; o primeiro arquivo em disco já é o resultado convergido.
2. **Incremental.** `ts.createSemanticDiagnosticsBuilderProgram` / `oldProgram`, reaproveitado entre salvamentos do `ember dev`. Só reinfere os módulos alterados e quem chama funções deles (grafo do manifest). Metas: **< 150 ms por salvamento** e **< 3 s a frio** num projeto sintético de 200 módulos (bench novo em `packages/cli/test`).
3. **TS 7.** O "type oracle" fica atrás de uma interface. Hoje roda sobre o `typescript` 5.9 embutido no CLI, uma dependência própria que não se mistura com a versão do usuário. Quando a API do `tsgo` estabilizar, entra como segundo backend. O usuário pode usar `tsc` 7 no typecheck do app à vontade, porque o `api.d.ts` é texto.
4. **Tipos nomeados (corrige B5).** O `TypePrinter` reconhece:
   - `DocFor<T, V>` → `Doc<"t">` e `WithoutSystemFields<Doc<"t">>` → `DocInput<"t">`; `PaginationResult<X>` → `PaginationResult<…>`; os brands `Id`/`FileId` (como já faz);
   - **tipos exportados pelo usuário em `ember/`** (`export type RoomSummary = …`, `export interface …`): emitidos uma vez em `_generated/types.d.ts` com o mesmo nome e referenciados pelo nome. O cliente faz `import type { RoomSummary } from "../ember/_generated/types"`.
   - Um tipo anônimo grande (> N linhas) vira um alias gerado `Returns_messages_list`, para o hover mostrar o nome.
5. **JSDoc propagado:** o comentário do `export const` vai para o membro do `api` e ganha as tags geradas `@shard`, `@throws`, `@source` e `@deprecated` (este último se o autor marcou).
6. **Go to Definition:** `api.d.ts.map` (declaration map) mapeia cada membro para o `export const` no arquivo do servidor. F12 em `api.messages.send` abre `ember/messages.ts`, sem que o cliente precise typechecar o servidor.
7. **Diagnósticos:** os erros de tipo dos módulos de `ember/` saem com code frame no `ember dev`, e cada retorno `unknown`/`any` vem com o motivo ("`res.json()` é `any` em ember/stripe.ts:31; use `returns:` ou um validador").
8. **CLI:**
   - `ember codegen --check` (CI: falha se o `_generated` mudaria);
   - `ember codegen --strict` (falha em `any`/`unknown` inferidos e em erros não declarados);
   - `ember types <fn>` (imprime o contrato de uma função no terminal).

### 3.6 Shards tipados (DX7)

```ts
// schema
shards: { room: defineShard({ key: v.id("rooms") }), org: defineShard({ key: v.string() }) },

// função: declara o tipo de shard e de onde vem a chave (serializável no manifest)
export const list = query({
  shard: { room: "roomId" },                    // a chave é args.roomId
  args: { roomId: v.id("rooms"), paginationOpts },
  handler: …,
});
export const stats = query({ shard: "org", handler: … });   // a chave vem do chamador
```

- **Cliente:** `useQuery(api.messages.list, { roomId, paginationOpts })` roteia sozinho para `room:<roomId>`, sem `shard` nas opções. Para `stats`, o tipo **exige** `{ shard: ShardRef<"org"> }`. `shards.org("acme")` é gerado e devolve o brand `ShardRef<"org">`.
- **Servidor:** `ctx.onShard(shards.room(id))`; o `runtime` confere que as tabelas tocadas pertencem ao tipo de shard da função (o erro aponta a tabela).
- No manifest, `FunctionManifest.shard = { kind, fromArg? }`. É o que o PLAN §3 previa.
- `defaultShard` continua existindo para apps de shard único e fica tipado por `ShardRef`.

### 3.7 Contexto tipado (DX9)

- **`ctx.env`:** o codegen gera `Env` a partir de `ember.json` (`resources`: R2, AI, Queues, Browser…) e de uma declaração de variáveis em `ember.config.ts` (`env: { STRIPE_KEY: v.string(), FEATURE_X: v.optional(v.string()) }`).
  - O deploy recusa subir se faltar variável obrigatória.
  - O `ember dev` valida o `.dev.vars` contra a declaração.
- **Identidade:** `Identity<Claims>`, com os claims vindos do `auth.config.ts`. Com o `ember-auth` local, `ctx.auth.user()` devolve `Doc<"auth:user"> | null`. `ctx.auth.require()` devolve a identidade ou lança o erro de sistema tipado `Unauthenticated`.
- **Componentes:**
  - o codegen emite a API pública de cada componente instalado em `_generated/components.d.ts`, a partir do manifest dele (mesmo mecanismo do `api.d.ts`), e os pacotes de componente param de manter `Ref<…>` à mão (`email/src/client.ts`, `workflows/src/index.ts`);
  - `componentBuilders<typeof schema, Config>()` passa a exportar também `QueryCtx`/`MutationCtx`/`ActionCtx` do componente, o que remove os `type Ctx = { db: any … }`;
  - erros de componente ficam com namespace (`email.RateLimited`).

### 3.8 Middleware tipado (DX8)

```ts
// ember/lib/builders.ts
export const authed = mutation.use((ctx) => {
  const user = ctx.auth.require();                       // pode lançar Unauthenticated (entra no contrato)
  return { ctx: { user } };
});

export const orgMutation = authed.use({
  args: { orgId: v.id("orgs") },                         // args somados e validados antes do handler
  errors: [errors.Forbidden],
  handler: (ctx, { orgId }) => {
    const member = membership(ctx, orgId);
    if (!member) throw errors.Forbidden({});
    return { ctx: { org: member.org }, onSuccess: (ctx) => flushAccumulators(ctx) };   // os "acumuladores" do groceryops
  },
});

export const rename = orgMutation({ args: { name: v.string() }, handler: (ctx, { orgId, name }) => … });
// hover de api.orgs.rename: args { orgId, name }, erros Unauthenticated | Forbidden | ...
```

- Middlewares de query e mutation são síncronos (D6); os de action podem ser `async`.
- O `RegisteredFunction` guarda a cadeia (`args` compostos, `errors` unidos), então o manifest e o codegen veem o contrato final.
- Fica fora deste documento, mas é vizinho: triggers por tabela (o `Triggers` do `convex-helpers` que o groceryops usa). Vale um documento próprio, porque interage com reatividade e group commit.

### 3.9 APIs de cliente

- **React:**
  - `useQuery` (valor ou `undefined`, lança o erro para o error boundary, como hoje);
  - `useQueryState` → `{ status: "loading" } | { status: "success"; data; optimistic; source? } | { status: "error"; error: EmberErrorOf<F> }`;
  - `useSuspenseQuery`;
  - `useMutation` devolve uma função com `.safe()` e `.withOptimisticUpdate()`, e `useMutationState` dá `{ isPending, error }`.
- **Optimistic updates tipados:** `store.update(api.messages.list, { roomId }, (prev) => …)`, com `prev`/retorno do tipo do retorno da query. Os overloads por string saem.
- **Paginação:**
  - `usePaginatedQuery` só aceita refs cujos args têm `paginationOpts` e cujo retorno é `PaginationResult<T>`; a restrição vem com uma mensagem legível no erro de tipo;
  - o `PaginationResult` passa a ter uma fonte só (`values` ou `server`), o que corrige B11.
- **React Query:** `emberQuery` com `TError` tipado; `emberMutation(ref, opts)` devolve `mutationOptions` completo (`mutationFn`, `TVariables`, `TError`).
- **Offline:** o `_generated/offline.ts` (já previsto no PLAN §10) gera o mapa `queries` e o registro de optimistic updates com chaves tipadas.
- **Fetch tipado e OpenAPI:**
  - `createEmberHttpClient<typeof api>({ url })`, para server-to-server, scripts e SSR fora do React;
  - `ember openapi`, para consumidores que não usam TS (os Shapes já carregam tudo).

### 3.10 Validadores v2 (DX10)

- **Composição:** `v.object(f).pick("a")`, `.omit()`, `.partial()`, `.extend({…})`, `.fields`; `schema.doc("messages")`, `schema.input("messages")`; `v.record(keys, values)`.
- **Paginação:** `paginationOptsValidator`, `paginationResultValidator(item)`.
- **Refinamentos no Shape** (serializáveis, portanto chegam ao cliente, ao JSON Schema e ao OpenAPI):
  - `v.string().min(1).max(200).email().url().regex(/…/)`;
  - `v.number().int().min(0)`;
  - `v.array(x).max(50)`;
  - `.describe("…")` (vira JSDoc no tipo gerado);
  - `.default(value)` (separa input de output, §3.3).
  - Refinamento com closure fica de fora: o Shape precisa continuar sendo JSON.
- **`ValidationError` com `issues: Array<{ path: (string | number)[]; expected: string; message }>`,** que é exatamente o que um formulário precisa para marcar o campo.
- **Pré-validação no cliente (opcional):**
  - com o manifest no bundle (`EmberClient({ manifest })`), args inválidos falham antes de sair, e no offline **antes de entrar na fila** (hoje uma mutation inválida fica na fila até a rede voltar);
  - é um tree-shake por função: só os Shapes usados.
- **Standard Schema:** os validadores `v.*` implementam `~standard`, então plugam direto em TanStack Form, react-hook-form e afins. O caminho inverso (aceitar Zod/Valibot em `args`) fica num pacote à parte `ember-zod`, convertendo pelo JSON Schema, e só se houver demanda; o core continua sem dependência.

### 3.11 Rotas HTTP tipadas (DX11)

```ts
http.route({
  method: "POST", path: "/mailboxes/:id/messages",
  params: { id: v.string() }, query: { dryRun: v.optional(v.boolean()) },
  body: v.object({ to: v.array(v.string()), subject: v.string() }),
  returns: v.object({ id: v.string() }),
  errors: [errors.MailboxNotFound],
  handler: async (ctx, { params, query, body }) => ({ id: … }),   // Response opcional; objeto vira JSON
});
```

- `httpAction` cru continua existindo para webhooks.
- As rotas declaradas entram no manifest e geram `_generated/http.d.ts` (cliente fetch tipado) e o OpenAPI.
- O `email-lite/ember/http.ts` (`await r.json() as any` nos testes) é o primeiro a migrar.

### 3.12 Ferramentas (DX12)

- **`ember dev`:** diagnósticos de tipo e de contrato com code frame; um resumo por salvamento ("3 funções mudaram de contrato: `messages.send` ganhou o erro `Forbidden`").
- **`@freecorps/eslint-plugin-ember`:**
  - `no-string-function-refs`;
  - `no-floating-mutation` (Promise de mutation ignorada);
  - `throw-declared-errors`;
  - `no-async-query-handler` (reforça o `SyncOnly`, com uma mensagem melhor);
  - `require-args-validators`;
  - `no-db-in-loop` (dica de performance).
- **Guia para IA gerado a partir do projeto:** `_generated/ai/guidelines.md`. O Convex entrega um guia estático (o groceryops tem o dele); o do Ember pode incluir as tabelas, índices, shards, erros e builders deste app, e ser bem melhor.
- **Harness de teste tipado:** promover `examples/_testing` a `@freecorps/ember-testing`, com:
  - `const t = emberTest({ schema, modules })`;
  - `await t.mutation(api.messages.send, args)` tipado;
  - `t.withIdentity(...)`;
  - `await expect(t.mutation(...)).rejects.toBeEmberError(api.messages.send, "RoomNotFound")`.
- **Plugin de language service (opcional, depois):** dicas no hover que só o Ember tem, como "esta query reexecuta quando `messages` muda no range `by_room[roomId]`" (o read set é conhecido), "índice usado: `by_room`" e "custo estimado: 1 range scan".

### 3.13 Resultado compartilhado e `authorize`

O shard guarda o resultado de cada inscrição por `(função, args)` e reexecuta depois de cada commit que toca o read set. Uma execução que **não leu** `ctx.auth` dá o mesmo valor para qualquer usuário, então o shard calcula uma vez para todos: 430 usuários numa lista são uma reexecução por commit, não 430. Isso é automático. Quase toda query real começa checando acesso, e ler a identidade faz o resultado ser de um usuário só; `authorize` separa as duas coisas:

```ts
export const list = query({
  args: { roomId: v.id("rooms") },
  errors: [errors.NotMember],
  // Por usuário, com o próprio read set: reexecuta só quando a associação dele muda.
  authorize: (ctx, { roomId }) => {
    const me = ctx.auth.require();
    if (!isMember(ctx, roomId, me.subject)) ctx.fail.NotMember({ roomId });
  },
  // Uma vez para todos os membros: `ctx.auth` não existe aqui (erro de tipo).
  handler: (ctx, { roomId }) => ctx.db.query("messages").withIndex("by_room", (q) => q.eq("roomId", roomId)).order("desc").take(50),
});
```

- Recusar é lançar em `authorize` (`ctx.fail.X`, `ctx.auth.require()`); os erros entram no contrato como os do handler (o codegen os infere dos dois).
- Middlewares rodam antes da checagem e antes do handler (as duas fases têm o `ctx` que o handler teria), ou seja, duas vezes numa chamada completa: mantenha-os sem efeitos colaterais; `onSuccess` só depois do handler. Um middleware que lê `ctx.auth` (`withUser`) torna o resultado por usuário de novo: correto, mas não compartilhado. Leia a identidade em `authorize`.
- Segurança: o valor compartilhado só chega a quem passou na checagem e sai de quem deixa de passar (o socket recebe o erro). Se o handler ler a identidade por outro caminho (um middleware, JS sem tipos), o shard detecta a leitura e volta a calcular por usuário antes de mandar qualquer coisa.
- Chamada aninhada (`ctx.runQuery`) e HTTP rodam `authorize` e depois o handler, como uma query comum.


---

## 4. Comparativo

| Capacidade | Convex | Ember hoje | Ember proposto |
|---|---|---|---|
| Cliente typecheca o servidor | sim (lento; ~3,6 GB no groceryops) | não | não |
| Ciclos de inferência servidor ↔ `api` | sim (anotar ou ref por nome) | não | não |
| Codegen converge sozinho | n/a | **não (B3)** | sim, ponto fixo |
| Args obrigatórios no cliente | sim | **não (B1)** | sim |
| Ref por string aceita sem aviso | não | **sim (B2)** | só `unsafeRef` |
| Hover com nomes (`Doc<"t">`) | sim (via `typeof`) | não | sim + aliases + tipos do usuário |
| JSDoc da função no hover | sim | não | sim + `@throws`/`@shard`/`@source` |
| Go to Definition para o handler | sim | não | sim (declaration map) |
| Erros tipados por função | não | não | **sim, inferidos e declaráveis** |
| "Commitou ou não?" no erro | não | não | `outcome: "rejected" \| "unknown"` |
| Middleware tipado que soma erros | `convex-helpers` (sem erros) | não | first-class |
| Shards tipados e roteamento por args | n/a | não | sim |
| `env` tipado | não (`process.env`) | não | sim, validado no deploy |
| Componentes com tipos gerados | sim | à mão | gerados |
| Rotas HTTP tipadas + OpenAPI | não | não | sim |
| Pré-validação no cliente / antes da fila offline | não | não | sim (opt-in) |
| Standard Schema | não | não | sim |
| Guia de IA do projeto | estático | não | gerado do projeto |

---

## 5. Fases

Cada fase tem PRs pequenos (conventional commits) e testes de tipo:
- **Testes de tipo:** arquivos `*.test-d.ts` com `expectTypeOf` do Vitest, rodando com `vitest --typecheck` em cada pacote;
- **Golden files do codegen:** `packages/cli/test/codegen/__golden__/` para `api.d.ts`, `types.d.ts` e `errors.d.ts` de projetos de fixture;
- **Bench:** projeto sintético de 200 módulos, com medição de tempo a frio e incremental.

**Fase A — correções (sem conceito novo).**
- B1: `OptionalRestArgs` em `client`, `react`, `react-query` e `react-native`.
- B3: ponto fixo no codegen e fim do stub `any`.
- B6: `v.any()` → `unknown`, defaults `unknown`.
- B10: `paginationOptsValidator`/`paginationResultValidator`, `pick/omit/partial/extend`.
- B11: uma fonte só para `PaginationResult`.
- Lint interno de `any`, com allowlist.
- *Aceite:* os casos da §1.2 viram testes de tipo que falham hoje e passam depois; um clone limpo + `ember codegen` uma vez gera o mesmo `api.d.ts` que duas execuções.

**Fase B — contrato v2 e erros tipados.**
- `FunctionReference` v2 (brand, `_errors`, `_shard`), `defineErrors`, `AppError` e o wire `kind/outcome`.
- `isError`, `.safe()`, `useQueryState`/`useMutationState`, `TError` no React Query.
- Inferência de erros por grafo de chamadas, `errors:` declarado, `_generated/errors.*`.
- Refs por string só via `unsafeRef`, mais o codemod.
- *Aceite:* o `examples/chat` usa `RoomNotFound`/`MessageTooLong` de ponta a ponta, e o hover mostra os erros.

**Fase C — codegen v2 (hover e navegação).**
- Tipos nomeados (`Doc<>`, tipos exportados do usuário, aliases).
- JSDoc + tags geradas, declaration map, programa incremental, `--check`/`--strict`/`ember types`, diagnósticos no `ember dev`.
- Interface de "type oracle" (TS 5.9 hoje, tsgo depois).
- *Aceite:* o hover de `api.messages.list` cabe em 3 linhas; F12 abre o handler; bench de 200 módulos < 150 ms incremental.

**Fase D — contexto e composição.**
- Shards tipados + roteamento por args (com runtime e manifest).
- `env` tipado, `Identity<Claims>`, `ctx.auth.require()`.
- `.use()` (middleware) com args, erros e `onSuccess`.
- Componentes com tipos gerados e ctx exportado (migrar `email`, `workflows`, `push`, `rate-limit` e zerar os `any` deles).
- *Aceite:* `packages/email` sem `any` fora da allowlist; um exemplo com dois tipos de shard que roteia sem `shard:` explícito.

**Fase E — bordas.**
- Refinamentos e `.default()` nos validadores, `issues` no `ValidationError`, pré-validação no cliente, Standard Schema.
- Rotas HTTP tipadas + cliente fetch + `ember openapi`.
- Plugin ESLint, guia de IA gerado e `@freecorps/ember-testing`.
- Language service plugin (opcional).

**Ordem sugerida:** A → B → C podem ir em sequência rápida (A é barato e destrava o resto). D e E podem se intercalar conforme a demanda do app de email e de um eventual port do groceryops.

---

## 6. Compatibilidade

- Estamos em 0.7.x: as quebras entram em minors, com notas no CHANGELOG e codemod (`ember migrate dx`) para:
  - refs por string → `api.x.y`;
  - `v.any()` → `v.unsafeAny()` (quando o usuário quiser manter o comportamento);
  - `client.mutation(ref, args, opts)` (assinatura inalterada quando `args` existe);
  - `optimisticUpdates`/`queries` com chaves string → pares tipados.
- O `manifest.json` ganha `formatVersion: 2` (shard, errors, rotas HTTP, refinamentos). O runtime lê as versões 1 e 2 durante uma release.
- O `api.d.ts` gerado continua estruturalmente compatível com o `FunctionReference` antigo durante a transição: os campos novos têm defaults.

---

## 7. Decisões em aberto (para o autor do projeto)

1. **Erros: inferência por padrão ou declaração obrigatória?** Proposta: inferir por padrão; `--strict` exige a declaração nas funções públicas.
2. **Sintaxe de erro:** `throw errors.X(data)` (funciona em helpers) e/ou `ctx.fail.X(data)` (checado no tipo)? Proposta: as duas, com `throw` como principal.
3. **Onde moram os erros:** `ember/errors.ts` por convenção (um registro global, como o `appError.ts` do groceryops) ou `defineErrors` em qualquer módulo? Proposta: qualquer módulo, com códigos únicos checados pelo codegen.
4. **Shard da função:** `shard: { room: "roomId" }` (declarativo, vai para o manifest) ou `shardKey: (args) => …` (closure, que o cliente não consegue rodar sem importar o servidor)? Proposta: declarativo.
5. **Manter `useQuery` idêntico ao Convex** (valor ou `undefined`, lança no boundary) e somar `useQueryState`, ou mudar o padrão? Proposta: manter (migração fácil a partir do Convex) e somar.
6. **Pré-validação no cliente:** opt-in (manifest no bundle) ou padrão? Proposta: opt-in, com padrão ligado só para a fila offline.
7. **Zod/Valibot em `args`:** vale o pacote `ember-zod` desde já? Proposta: não; primeiro o Standard Schema de saída.
