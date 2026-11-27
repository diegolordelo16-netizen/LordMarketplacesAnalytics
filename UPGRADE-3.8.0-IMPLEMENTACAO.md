# LordMarketplacesAnalytics 3.8.0 — etapas incrementais, debug e pendências

Data: 26/11/2026
Base: ZIP 3.6.0 com as melhorias incrementais listadas abaixo.

## Etapas implementadas nesta rodada

### 1. Histórico e ferramentas locais de SEO
- `kpi.history` monta série diária usando o último snapshot de cada anúncio por dia; snapshots agregados de conta podem complementar/sobrescrever as métricas correspondentes.
- Campos ausentes permanecem `null`, não zero.
- Sugestões de termos são extraídas dos títulos do catálogo da própria conta. Não são autocomplete de marketplace e não incluem volume externo.
- Clusters de keyword usam similaridade lexical local (`TOKEN_OVERLAP_LOCAL`), não embeddings semânticos.
- Visibilidade e canibalização são calculadas apenas a partir de SERPs anteriormente capturadas e registradas.

### 2. Feedback de resultados dos agentes
- Feedback aceita/rejeita/implementado/falhou, com motivo.
- A marcação IMPLEMENTADO exige métricas antes/depois, quantidade de amostra e fonte.
- Após pelo menos três resultados positivos mensurados, cria/atualiza playbook local.
- A validação é observacional e não causal; não treina pesos do Gemini nem um modelo proprietário.

### 3. Paginação de coleta assistida
- Ação explícita do usuário para percorrer até cinco páginas de anúncios numa aba temporária.
- Somente link “próxima” visível, HTTPS, mesmo host/rota e hosts permitidos.
- Interrompe em autenticação ausente, CAPTCHA/desafio, ciclo ou destino inesperado.
- Não é crawler irrestrito, não navega todas as áreas da conta e não agenda coleta contínua.

### 4. Amazon Seller Central Brasil — leitura limitada
- Content script e adapter de inventário visível adicionados.
- Sem endpoint privado, cookies, tokens, mutações ou publicação.
- Capacidade permanece PARCIAL; seletores e autenticação precisam de teste com conta Seller Central real.
- Ads, pedidos, devoluções, perguntas e reputação da Amazon não foram declarados suportados.

### 5. Isolamento SKU por conta
- Migration 007 substitui unicidade global de `sku_code` por unicidade composta `(account_id, sku_code)`.
- IDs, dados e referências são preservados; captura associa o anúncio ao SKU dentro da conta correta.

### 6. Snapshots agregados de conta
- Migration 008 cria `account_snapshots` com marketplace, página, timestamps, métricas, origem e evidência.
- Captura pode gravar métricas de dashboard, Ads, pedidos, estoque, devoluções, perguntas e reputação sem inventar `listingId`.
- Registra proveniência por métrica.

### 7. Dashboard executivo consolidado
- `kpi.dashboard` lê snapshots agregados por conta para os últimos 30 dias.
- Métricas da própria conta têm precedência para o indicador correspondente; o restante usa a soma de anúncios somente quando há cobertura completa.
- O consolidado é calculado pela soma das contas, evitando duplicar os totais de conta com as linhas dos anúncios.
- Métricas ausentes permanecem `null`; cobertura de snapshots da conta aparece separadamente.

### 8. Relatórios e conectores
- Relatório `KPIS` inclui snapshots de anúncios e agregados de conta identificados por `entityType`.
- Conectores que exigem credenciais e não têm conexão confirmada não podem ser marcados como habilitados.
- Não foram criados fluxos OAuth/API que não pudessem ser autenticados e verificados neste ambiente.

### 9. Métricas de receita líquida e taxas observadas; análise por produto
- Schemas listing e account permitem `netRevenue`, `commission`, `fixedFee`, `shippingFee`, `tax` e `marketplaceFee` em BRL.
- Content scripts ML/Shopee capturam esses campos apenas com rótulos explícitos; rótulo de origem segue em evidence.
- Snapshots, histórico, dashboard e comparação passam a exibir taxas quando a cobertura de dados é completa; ausências seguem nulas.
- `analysis.run` e a tela de agentes aceitam `catalogProductId`; consulta cruza SKU e produto canônico dentro da conta, sem misturar lojas.
- Limite: rótulos e seletores precisam de homologação com contas reais; ausência de um campo na página não é inferida.

### 10. Regressão, versão e documentação
- Versão 3.8.0 alinhada entre package, lockfile, extensão, painel, serviço e instalador.
- Matriz individual atualizada para 365 itens: 170 implementados no código, 160 parciais/não comprovados e 35 não implementados/não funcionais.

## Debug executado / a executar

| Verificação | Estado nesta entrega |
|---|---|
| JavaScript/MJS/CJS `node --check` | Passou nos scripts alterados e nas verificações JS já realizadas |
| Parser TypeScript | Passou: 50 arquivos, zero erros sintáticos; não substitui `tsc --noEmit` |
| Build da extensão MV3 | Passou via `node scripts/build-extension.mjs` |
| Migrations 001–008 | Exercitadas com SQLite nativo; `integrity_check=ok` e `foreign_key_check=0` na validação anterior |
| Mesmo SKU em contas diferentes | Teste isolado após migration 007 |
| Vitest | Não executado: `vitest` ausente; os testes adicionados não foram aprovados nesta execução |
| Typecheck semântico | Bloqueado pela falta de dependências npm/@types no ambiente |
| Build do agente e Native Host | Bloqueado se `esbuild` não estiver instalado |
| Chrome/Edge com seller logado | Não executado sem sessões reais |
| Amazon Seller Central | Não homologado com conta real |

## Limitações conhecidas e não mascaradas

1. Integrações oficiais e OAuth para Mercado Livre, Shopee, Amazon, GA4, Search Console e Trends não estão conectadas/homologadas. A ativação é bloqueada quando requer credenciais ausentes.
2. Captura é DOM observacional; não garante coleta de todos os relatórios, filtros, intervalos, painéis, contas ou mudanças de layout.
3. Amazon só possui leitura parcial do inventário visível e requer validação de seletores em conta real.
4. Publicação/salvamento automático, rollback remoto, alteração de preço/estoque/imagem/Ads e duplicação não estão liberados. Tarefas de título/descrição permanecem draft assistido com revisão manual.
5. AUTO_PILOT/AUTO_ASSISTED contínuos, sincronização multi-conta agendada, scheduler de coleta multi-área e relatórios automáticos completos não estão concluídos.
6. SEO externo, volumes de busca, autocomplete, ranking amplo e dados competitivos externos dependem de fonte externa permitida; as métricas locais são explicitamente observacionais.
7. Testes Vitest, typecheck, builds completos e homologação de navegador devem rodar em um ambiente com `npm ci` bem-sucedido e contas de vendedor autorizadas.

## Critério de conclusão

Esta versão fecha os incrementos locais que podem ser implementados e testados sem credenciais externas. Não é honesto declarar os 365 requisitos concluídos: a classificação individual e as dependências remanescentes estão em `docs/AUDITORIA-RECURSIVA-365-REQUISITOS.md`.


### Tentativa de recuperação das dependências
- `npm ci --prefer-offline --no-audit --no-fund` não completou dentro da janela de execução e não instalou os bins necessários.
- `npm view vitest@2.1.8` retornou `EAI_AGAIN registry.npmjs.org`; sem rede DNS, Vitest/esbuild não puderam ser obtidos.
