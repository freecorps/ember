# Migrar do Convex: `ember migrate convex`

> PLAN §22 L9. Código em `packages/cli/src/migrate/`; testes em `packages/cli/test/migrate-convex.test.ts`, sobre um app Convex de fixture (`packages/cli/test/fixtures/convex-app/convex`) e a árvore esperada (`expected/`).

O Ember segue a API do Convex (D2), com uma diferença que toca quase toda linha de servidor: **queries e mutations são síncronas por dentro** (D6). `ctx.db.get`, as cadeias de query, `ctx.runQuery`, `ctx.runMutation`, `ctx.storage.getUrl`, `ctx.scheduler.*` e `ctx.auth.getUserIdentity()` devolvem o valor, não uma Promise. Num app com milhares de `await ctx.db...`, o codemod faz essa troca de forma mecânica e lista o que precisa de alguém para decidir.

```sh
ember migrate convex [--src convex] [--out ember | --in-place] [--dry-run] [--force] [--report report.md] [--check] [--verify]
```

- `--src` (padrão `convex`) e `--out` (padrão `ember`): copia a árvore mantendo os caminhos (o caminho do módulo é o nome da função: `convex/lib/teams.ts` → `ember/lib/teams.ts`). `--out` cheio é recusado sem `--force`. `--in-place` reescreve a própria pasta (apague antes o `_generated/` do Convex).
- `--dry-run`: analisa e imprime o relatório, sem gravar nada.
- `--report arquivo.md`: grava o relatório no arquivo e imprime só o resumo (sem a flag, o relatório inteiro vai para o stdout).
- `--check`: termina com código 1 enquanto houver itens **manuais** (para o CI acompanhar a migração).
- `--verify`: depois de gravar, roda `ember codegen` e `tsc --noEmit` na pasta convertida e lista os erros que sobraram (só os dos arquivos convertidos; usa o `tsconfig.json` da pasta, se houver).

Depois: um `ember.json` na raiz com `"functionsDir"` apontando para a pasta convertida (`ember init` cria um), `ember codegen` e `tsc --noEmit`. `await` que sobrou sobre um valor que já não é Promise não quebra nada; a regra `@typescript-eslint/await-thenable` aponta cada um.

## Como decide o que fica síncrono

Usa a API do compilador TypeScript (a mesma dependência do codegen, sem ts-morph), com um `Program` sobre a pasta inteira: os símbolos resolvem entre módulos, então `ctx` pode ter qualquer nome, `const { db } = ctx` e `const db = ctx.db` são seguidos, e uma chamada `helper(ctx)` chega à declaração do helper mesmo por import. O pacote `convex` não precisa estar instalado nem o `_generated/` do Convex presente: os tipos de ctx são reconhecidos pelo nome quando a declaração está fora do projeto, e o checker de tipos só é consultado para um `await` que nenhuma regra cobre.

**Candidatas** a ficar síncronas:

- handlers de `query`, `internalQuery`, `mutation`, `internalMutation` (do `_generated/server`, os genéricos do `convex/server` e os builders do `convex-helpers`: `customQuery(query, ...)`, também importados de outro módulo);
- toda função com um parâmetro tipado `QueryCtx`, `MutationCtx`, `DatabaseReader`, `DatabaseWriter` (ou os `Generic*`) ou um tipo feito deles (alias, `interface extends`, interseção, `Pick`/`Omit`, `{ db: DatabaseReader }`);
- as funções aninhadas nelas (callbacks de `.map`, closures), os triggers e middlewares do `convex-helpers`;
- as funções async que esperam uma candidata, transitivamente (um helper com tipo de parâmetro opaco que só espera helpers convertidos também vira síncrono).

**Ponto fixo:** toda candidata começa síncrona; cai a que espera (ou devolve) algo que continua Promise: I/O de verdade (`fetch`, `ctx.runAction`, timers, `new Promise`), uma função que continua async, `Promise.allSettled`/`race`, ou um valor cujo tipo é Promise (ou desconhecido). Repete até nada mudar, então cadeias de qualquer profundidade e recursão se resolvem. Uma função aninhada numa que caiu cai junto: o que fica async fica **exatamente como estava**, para alguém dividir.

**Na que fica síncrona:** sai o `await` de cada expressão, sai o `async`, `Promise<T>`/`PromiseLike<T>` no retorno vira `T`, `Promise.all([...])`/`Promise.all(xs.map(fn))` sobre valores síncronos vira o array (`await Promise.all(ids.map((id) => ctx.db.get(id)))` → `ids.map((id) => ctx.db.get(id))`), e `for await (const x of ctx.db.query(...))` vira `for (const x of ctx.db.query(...).collect())` (aviso no relatório: o laço lê tudo antes, um `break` não economiza leituras).

**Nunca mexe** em `action`, `internalAction`, `httpAction` (nem no que está dentro deles): lá o I/O é permitido e `ctx.runQuery`/`runMutation` continuam async.

## O que mais é reescrito

| Convex | Ember |
|---|---|
| `import { ... } from "convex/server" \| "convex/values"` | `@freecorps/ember-server`; nomes trocados entram como `Ember as Convex` (`QueryCtx as GenericQueryCtx`, `Identity as UserIdentity`, `DataModelFromSchema as DataModelFromSchemaDefinition`...), para o resto do arquivo não mudar; tipos de validador (`Validator`, `PropertyValidators`, `ObjectType`) vêm de `@freecorps/ember-values`; nome sem equivalente fica no import original e vai para o relatório |
| `DataModel` de `_generated/dataModel`, `components` de `_generated/api` | de `_generated/server` (os demais nomes do `_generated` são os mesmos: `Id`, `Doc`, `QueryCtx`, `MutationCtx`, `ActionCtx`, `DatabaseReader/Writer`, `api`, `internal`) |
| `ctx.db.get("tabela", id)`, `patch/replace/delete` com a tabela primeiro | `ctx.db.get(id)` etc. |
| `ctx.db.system.get(id)` / `("_storage", id)` de arquivo | `ctx.storage.getMetadata(id)` (mesmos campos do `_storage`; `sha256` em hex) |
| `ctx.db.system.get("_scheduled_functions", id)`, `.query("_scheduled_functions").collect()` | `ctx.scheduler.get(id)`, `ctx.scheduler.list({ limit: 1000 })` (L7, PR #90; outras cadeias sobre `_scheduled_functions` e `_storage` vão para o relatório) |
| `v.id("_storage")`, `Id<"_storage">`, `Doc<"_storage">` | `v.file()` (o refcount de arquivos segue os campos `v.file()`), `FileId`, `FileMetadata` |
| `v.id("_scheduled_functions")`, `Id<"_scheduled_functions">` | `v.string()`, `string` |
| `v.record(chaves, valores)`, `v.bigint()` | `v.record(valores)` (chaves que não eram `v.string()` vão para o relatório), `v.int64()` |
| `throw new ConvexError("NOT_FOUND")`, `new ConvexError({ code: "not-found", ... })` | `throw errors.NotFound(payload)`, com `ember/errors.ts` gerado: um `defineErrors` com cada código distinto em PascalCase, `data: v.any() /* refine */` e uma mensagem tirada do payload. O payload é o mesmo que o Convex lançava, então o cliente que lê `error.data` continua igual. Sem código (template, variável) → `errors.AppError(payload)`, listado para revisão |
| `e instanceof ConvexError` | `isAppError(e)`; `ConvexError` ainda usado como tipo vira `AppError` |
| `cronJobs()`, `{ hourUTC, minuteUTC }`, `dayOfWeek: "monday"`, `interval({ seconds: 300 })` | `cronJobs({ shard: "global:main" })`, `{ hour, minute }` (fuso padrão UTC, como no Convex), `dayOfWeek: 1`, `{ minutes: 5 }` (segundos que não fecham minuto → relatório) |
| `convex-helpers` `Triggers`: `triggers.register("t", fn)` + `customMutation(mutation, customCtx(triggers.wrapDB))` | `export const tTrigger = (ctx: TriggerCtx, change: Change<"t">) => ...` no mesmo módulo, `ember/triggers.ts` gerado com `defineTriggers({ t: [tTrigger] })`, e o builder volta a ser o `mutation` (triggers são nativos, L2) |
| `customQuery(query, customCtx(fn))`, `customQuery(query, { args, input })` | `query.use((ctx) => ({ ctx: fn(ctx) }))`, `query.use({ args, handler })` (só o `ctx` devolvido é usado; o handler recebe todos os argumentos) |
| `import ... from "convex-test"` | `@freecorps/ember-testing/convex-test` (L8) |

`schema.ts`, `crons.ts` e `http.ts` passam pelas mesmas regras (imports, validadores). `auth.config.ts` (providers do Convex) e `convex.config.ts` (componentes) **não** são copiados: no Ember o primeiro é Better Auth (`defineAuth`) e o segundo é `ember.config.ts` (`defineApp().use(...)`). Arquivos que não são código vão como estão.

## O relatório

Markdown, em inglês como o resto do CLI: resumo com contagens (funções convertidas, `await` removidos, cada reescrita), depois:

- **Needs a decision** (manual, o que faz `--check` falhar): helpers que misturam banco e I/O (dividir: a parte de banco síncrona, o I/O numa action, por exemplo `ctx.scheduler.runAfter(0, ...)` a partir da mutation), handlers que continuam async e o motivo (com a linha de cada `await` que impede), `await` em Promise desconhecida, helper que recebe `QueryCtx | ActionCtx`, `fetch` dentro de mutation, `.then()` sobre chamada que ficou síncrona, APIs sem equivalente (`ctx.db.system.query("_storage")`, nomes do `convex/server` que o Ember não tem, `convex-helpers` sem forma automática com uma sugestão, pacotes `@convex-dev/*` com o equivalente do Ember quando existe), `auth.config.ts`, `convex.config.ts`;
- **To review**: `ConvexError` sem código, middlewares convertidos, `ctx.storage.generateUploadUrl()` (no Ember devolve um ticket `{ url, headers, ... }`), campos da identidade que no Ember estão em `claims` (`identity.email` → `identity.claims?.email`; `tokenIdentifier` → `` `${issuer}|${subject}` ``), `ctx.vectorSearch`;
- **"use node" files** com os imports de cada um (insumo do spike L13);
- os códigos de erro gerados, os triggers extraídos, e o que mudou em cada arquivo.

## Limites conhecidos

- O que é decidido pelo nome do tipo (`QueryCtx`...) assume os nomes do Convex. Um parâmetro sem tipo (`ctx`) só é seguido dentro de handlers e de funções que já são candidatas.
- `Promise.all` só some quando é trivialmente seguro (array literal, `xs.map(fn)` com `fn` síncrona, ou uma `const` disso); o resto mantém a função async e aparece no relatório.
- `v.any()` no Ember é `unknown` (D13): código que lia um campo `v.any()` sem estreitar aparece no `tsc`.
- O codemod é idempotente: rodar de novo sobre a saída não muda nada.
