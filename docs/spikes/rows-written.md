# Linhas escritas por operação (rows written)

A Cloudflare cobra **US$ 1 por milhão de linhas escritas** no SQLite do Durable Object. O benchmark contra o Convex
(PR #14, `docs/spikes/remote/convex-vs-ember.md`) estimou ~6–8 linhas por insert a partir do DDL e chegou a uma
marginal de escrita de ~US$ 6–8 por milhão de inserts, contra US$ 2 do Convex. Este documento mede o número de
verdade, mostra de onde vem cada linha e o que mudou para cortar.

## Como foi medido

- **Contador:** `cursor.rowsWritten` de cada `ctx.storage.sql.exec`, o contador que a Cloudflare expõe para acompanhar a cobrança. A conferência com o analytics da conta está na última seção.
  O `DoSqlDriver` soma todos os cursores do shard, e `Shard.inspect().rows` expõe o total da instância.
- **Teste:** `packages/runtime/test/rows-written.test.ts` mede a diferença do contador em volta de cada operação, com a
  média de 40 execuções. Cada execução é um lote próprio de group commit, o pior caso: sob carga, o custo por commit se
  divide pelo lote. Antes de medir, o teste aquece o shard além da janela do change log (270 versões), então os números
  são do regime estável. Para ver a tabela: `bunx --bun vitest run test/rows-written.test.ts --reporter=verbose`.
- **Antes:** o mesmo teste rodou sobre `origin/main` (8ceaf8e), com só o `inspect().rows` acrescentado.
- **O que o workerd conta** (sonda no mesmo runtime):
  - `INSERT` conta 1 linha mais 1 por entrada de índice. Um índice `UNIQUE` em coluna conta, inclusive para `NULL`.
  - `UPDATE` conta 1, mais 1 por índice cuja chave mudou.
  - `DELETE` conta 1 por linha apagada, com índices ou sem.
  - Upsert (`ON CONFLICT DO UPDATE`) e `INSERT OR REPLACE` contam 1.
  - `DROP TABLE` conta 0, qualquer que seja o número de linhas. `CREATE TABLE` conta 2.
  - Índice parcial `WHERE k IS NOT NULL` não escreve nada quando `k` é `NULL`.

## Resultado

| Operação | Antes | Depois |
|---|---:|---:|
| Insert, 0 índices de usuário (WebSocket, com dedup) | 8 (+1 depois)¹ | **5** |
| Insert, 0 índices de usuário (HTTP, sem dedup) | 6 | **4** |
| Insert, 1 índice + índice de busca (WebSocket) | 10 (+1)¹ | **7** |
| Insert, 3 índices de usuário (WebSocket) | 11 (+1)¹ | **8** |
| Patch de campo com índice de busca (WebSocket) | 10 (+1)¹ | **7** |
| Delete, 1 índice + índice de busca (WebSocket) | 7 (+1)¹ | **4** |
| Início de subscription | 2 | **0** (1 em cliente sem `ident`) |
| Resume de subscription na reconexão | 1 | **0** |
| Fim de subscription | 1 | **0** |
| Mutation que agenda 1 job para daqui a 60 s (sem insert) | 6 (+1)¹ | **4** |
| Agendar 1 job e rodá-lo (o job insere 1 linha) | 13 (+1)¹ | **9** |

¹ A linha de dedup era apagada pela manutenção 7 dias depois: +1 linha por mutation com dedup, fora da medição. Agora
a limpeza é um `DROP TABLE` e não custa nada.

**Em dinheiro, por milhão de inserts via WebSocket:** numa tabela sem índice de usuário, de ~US$ 9 para **US$ 5**.
No caso do PR #14 (um índice `by_n`), de ~US$ 10 para **US$ 6**. Sob carga, o upsert do change log se divide pelo
lote de group commit (97 mutations por commit no bench B2), e o piso fica em **4 linhas** por insert via WebSocket
(3 via HTTP). O Convex cobra US$ 2 por milhão de chamadas.

### De onde vinham as 8 (+1) linhas de um insert via WebSocket

| Linha | Antes | Depois |
|---|---:|---:|
| Documento | 1 | 1 |
| Índice único de `_id` (engine) | 1 | 1 |
| Índice de `_creationTime` (engine) | 1 | 1 |
| Linha de dedup `_ember_dedup` | 1 | 1 (`_ember_dedup_<n>`) |
| Índice `_ember_dedup_at` (só para a limpeza) | 1 | 0 |
| `DELETE` da limpeza de dedup (7 dias depois) | 1 | 0 (`DROP TABLE`) |
| Meta `version` | 1 | 0 |
| Insert no change log | 1 | 1 (upsert no anel) |
| `DELETE` do change log além de 256 versões | 1 | 0 |
| **Total** | **9** | **5** |

## O que mudou

1. **Dedup em tabelas de geração** (`_ember_dedup_<n>`). A dedup protege o reenvio de mutations pelo cliente: na
   reconexão, na fila offline restaurada e na troca de líder entre abas. Também protege as chaves do auth outbox.
   - **Como funciona:** uma linha por mutation, `WITHOUT ROWID`, com a chave primária `(identity, client_id, mid)` e
     sem índice secundário. Grava na geração mais nova e procura nas duas mais novas (leitura custa US$ 0,001/M). A
     manutenção horária abre uma geração nova quando a atual faz 7 dias e apaga a anterior com `DROP TABLE`.
   - **Troca:** a janela deixa de ser "exatamente 7 dias" e passa a ser "de 7 a 14 dias". Tudo continua gravado na
     transação dos efeitos, então vale depois de reinício e hibernação. O contrato está em
     `docs/design/contracts.md`.
   - **Alternativas descartadas:**
     - *Marca d'água por cliente*, ou seja, o maior `(clientId, seq)`: não guarda o resultado de cada `mid`, e o
       reenvio precisa devolver o `value` original, por exemplo o id inserido. Os `mid`s também não são números
       sequenciais no protocolo.
     - *Mapa de resultados recentes numa linha por cliente:* reescreve um JSON que cresce a cada mutation.
     - *Só em memória:* perde o exactly-once quando o DO reinicia.
   - **Migração:** a tabela antiga `_ember_dedup` (runtime < 3) vale como geração 0 até a primeira rotação.
2. **Change log em anel** (`_ember_changes`, `slot = version % changeLogVersions`). É um upsert por commit no lugar de
   insert, `DELETE` do excedente e meta `version`. A versão do shard é a da entrada mais nova (o anel guarda pelo
   menos 1). O `resume` lê as versões depois da do cliente e exige todas, como antes. O upgrade copia as últimas N
   entradas de `_ember_changelog` e apaga a tabela antiga.
3. **Subscriptions no anexo do socket.** `serializeAttachment` sobrevive à hibernação e não é cobrado como linha. Cada
   socket guarda `[qid, fn, args]` das suas subscriptions até 16 KB. As que não cabem, como args enormes, vão para
   `_ember_subs` como antes. Ao acordar, o shard refaz o registro pelos dois. Cada qid fica em um só dos dois: ao
   passar da tabela para o anexo (ou no `unsub`) a linha é apagada. O shard sabe em memória quais qids têm linha, então
   o caso comum (nada na tabela) não faz consulta nem escreve linha. Uma linha que duplica um qid do anexo (dado de
   versão anterior) é apagada ao acordar e o anexo vale.
4. **Feature `ident` do protocolo (v1.1).** O `resume` precisava saber sob qual identidade o cliente recebeu o valor, e
   para isso o shard gravava `_ember_sub_ident` a cada `snap`. Agora o `snap` leva `ik`, uma marca de 53 bits da
   identidade, e o cliente a devolve em `resume.ik`.
   - **Segurança:** a marca não é segredo. Forjá-la só deixa o cliente com um valor que ele já tem. Um cliente honesto
     que trocou de conta devolve a marca da conta antiga e recebe `snap` completo.
   - **Compatibilidade:** clientes sem a feature continuam no caminho antigo, e servidores antigos não confirmam a
     feature, então o cliente não manda `ik`.
   - **Reconexão com pipelining:** o `sub` sai antes do `ready`, então o cliente manda `ik` sempre que tem a marca
     (só um servidor com `ident` da mesma época a deu). Se o `ready` não confirma `ident` (runtime revertido), o
     servidor recusou esses `sub`s e o cliente os reenvia sem a marca.
5. **`_jobs.dedup_key` com índice único parcial** (`WHERE dedup_key IS NOT NULL`). A coluna `UNIQUE` gravava uma
   entrada de índice também para o `NULL` da maioria dos jobs. O upgrade reconstrói `_jobs` uma vez.

## O que não mudou (e por quê)

- **Índices de usuário:** 1 linha por índice em insert, e em update quando a chave muda. É o custo de ter o índice e
  não há como evitar.
- **Índice de busca (FTS5):** um insert numa tabela com `searchIndex` custa +1 linha além do índice `db`.
- **Índices de `_id` e `_creationTime` (engine):** saíram depois, com o armazenamento compacto (seção abaixo).
- **Outbox de índices externos** (`_ember_ext_outbox`): linha + índice `(sent, sent_at)` por documento escrito, mais
  o ack. Só existe com Vectorize/AI Search e não foi alterado.
- **Outbox do Auth** (`_ember_outbox`, no DO `Auth`): linha + índice único de `key`, por mudança de usuário. É raro e
  não foi alterado.
- **Bookmarks, meta da manutenção e catálogo:** algumas linhas por hora por shard ativo. É desprezível.

## Não confirmado na Cloudflare

O passo de conferir com um Worker `ember-spike-rows-*` e o GraphQL de analytics (`durableObjectsStorageGroups`,
`rowsWritten`) não foi feito. A mesma API recusou a consulta por limite de orçamento no PR #14, Os números acima vêm do contador do runtime
(workerd local), não da fatura. Vale repetir quando a API responder.

## Armazenamento compacto (sem os índices do engine)

O `_rowid` de cada documento passou a ser o `_creationTime` em microssegundos, e o id passou a carregar esse rowid
(contrato em `docs/design/contracts.md`, "Armazenamento compacto"). Ler por id e por ordem de criação virou leitura
por chave primária, e os dois índices do engine deixaram de existir. Medido pelo mesmo teste
(`packages/runtime/test/rows-written.test.ts`):

| Operação | PR #15 | Compacto |
|---|---:|---:|
| Insert, 0 índices de usuário (WebSocket, com dedup) | 5 | **3** |
| Insert, 0 índices de usuário (HTTP, sem dedup) | 4 | **2** |
| Insert, 1 índice + índice de busca (WebSocket) | 7 | **5** |
| Insert, 3 índices de usuário (WebSocket) | 8 | **6** |
| Patch de campo com índice de busca (WebSocket) | 7 | **6** |
| Delete, 1 índice + índice de busca (WebSocket) | 4 | 4 |
| Mutation que agenda 1 job para daqui a 60 s | 4 | 4 |
| Agendar 1 job e rodá-lo (o job insere 1 linha) | 9 | **7** |

- **Das 3 linhas de um insert via WebSocket**, restam o documento, a linha de dedup e o upsert do change log (este se
  divide pelo lote sob carga).
- **Tabelas existentes** são convertidas pelo `migrate()` no primeiro boot com o runtime novo, numa transação por tabela
  (até 100 mil linhas). Os ids antigos continuam válidos por um índice parcial que linhas novas não tocam.

## Resultado no anel do change log (feature `ack`)

O resultado de uma mutation do socket passou a ir na linha do change log do seu commit, que já é gravada, e o
cliente confirma com `{t:"ack", mids}` quando tira a mutation da fila. Só resultados nunca confirmados viram linha de
dedup, no reuso do slot do anel (contrato em `docs/design/contracts.md`, "Feature `ack`").

| Operação | Compacto | Compacto + `ack` |
|---|---:|---:|
| Insert, 0 índices de usuário (WebSocket) | 3 | **2** |
| Insert, 0 índices de usuário (HTTP) | 2 | 2 |

- **Um insert via WebSocket**, de 5 linhas no PR #15 para **2**: o documento e o upsert do change log. Sob carga, o
  upsert se divide pelo lote de group commit, e o piso fica em ~1 linha.
- **Em dinheiro, por milhão de inserts:** US$ 2 a uma mutation por commit, perto de US$ 1 sob carga. O Convex cobra
  US$ 2 por milhão de chamadas, mais I/O.

