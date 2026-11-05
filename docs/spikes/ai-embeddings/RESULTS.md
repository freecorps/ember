# Teste 11 / R10 — modelo de embedding padrão em pt-BR

Rodado em 2026-11-04 na conta FreeCorps (`<ACCOUNT_ID>`), Workers AI pela REST API (`POST /ai/run/<model>`), token
da CLI (OAuth do wrangler), sem criar recursos. Script: `bench.ts`; dados: `dataset.ts`; saída crua:
`evidence/run-2026-11-04.json`.

## Conjunto

- 30 documentos curtos de domínios reais de um inbox de suporte (cobrança, logística, RH, produto, e-mail, LGPD).
- 30 consultas, **uma relevante por consulta**, escritas com outras palavras: sinônimos ("devolução" × "reembolso"),
  fala informal ("quando cai o VR?"), sem acento ("nao consigo entrar"), siglas ("NF", "e-CNPJ"), inglês misturado
  ("too many requests"). Vários documentos são quase-acertos de propósito (d05 × d06 × d27, d03 × d24).
- Métricas: Recall@1, Recall@3, MRR@10 (similaridade de cosseno), dimensões, latência do lado do cliente
  (Campinas → Cloudflare, inclui o RTT).
- Linha de base: BM25 com o mesmo tokenizer do `.searchIndex()` (sem stemming) — mostra que o conjunto exige
  semântica.

## Resultado

| Modelo | Variante | Dims | R@1 | R@3 | MRR@10 | 1 consulta (mediana) | lote de 30 docs |
|---|---|---|---|---|---|---|---|
| BM25 (tokenizer do searchIndex) | — | — | 0,233 | 0,400 | 0,340 | — | — |
| `@cf/baai/bge-m3` | texto puro | 1024 | **0,933** | **1,000** | **0,967** | 317 ms | 1,5 s |
| `@cf/google/embeddinggemma-300m` | prompts de busca (`task: search result \| query:` / `title: none \| text:`) | 768 | **0,933** | **1,000** | **0,967** | 382 ms | 0,7 s |
| `@cf/google/embeddinggemma-300m` | texto puro | 768 | 0,900 | 0,933 | 0,931 | 363 ms | 1,1 s |
| `@cf/qwen/qwen3-embedding-0.6b` | `queries` (com instrução) / `documents` | 1024 | 0,867 | 0,967 | 0,921 | 2,6 s | 1,9 s |
| `@cf/qwen/qwen3-embedding-0.6b` | texto puro | 1024 | 0,733 | 0,967 | 0,853 | 462 ms | 1,5 s |

Erros dos dois primeiros (posição do documento relevante):
- bge-m3: "preciso da NF da minha compra" → 2º; "fiquei doente, como justifico a falta" → 2º.
- embeddinggemma (prompts): "preciso da NF da minha compra" → 2º; "quando cai o VR?" → 2º.

## Decisão

**Padrão: `@cf/baai/bge-m3`** (para `.vectorIndex({ embed })` e para as instâncias de `.aiSearchIndex()`).

- Empata em qualidade com o embeddinggemma no nosso conjunto e fica bem acima do qwen3 (MRR 0,967 × 0,921) e do
  BM25 (0,340).
- É GA (o embeddinggemma está marcado `beta` no catálogo) e tem preço publicado ($0,0118 por milhão de tokens).
- Não depende de prompt: o embeddinggemma perde 3,6 pontos de MRR sem os prompts de busca, e um erro de template no
  código do usuário passaria despercebido.
- Contexto de 60k tokens no Workers AI (no AI Search, 512 tokens por chunk); 1024 dimensões cabem no limite do
  Vectorize (32–1536).
- O qwen3 é o padrão do AI Search, mas foi o pior aqui e o mais lento por consulta com instrução (2,6 s).

Configurável por índice: `embed: { field, model }` e `aiSearchIndex(..., { embeddingModel })`. O runtime usa a forma
de entrada documentada de cada modelo (`queries`/`documents` no qwen3, prompts no embeddinggemma, `text` nos outros).

Limitações: 30 pares é pouco para separar bge-m3 de embeddinggemma; o empate deve ser revisto com o tráfego real do
serviço de email (follow-up). Latências medidas do Brasil, com RTT incluído.
