# LordMarketplacesAnalytics 3.10.2 — implementação incremental

**Data:** 27/11/2026 | **Base:** `LordMarketplacesAnalytics-3.10.1-upgraded.zip` | **Nova migration:** 012

## Etapas executadas

### Etapa 1 — Banco e contratos
- Migration 012 adiciona defaults idempotentes para Mercado Livre, Shopee e Amazon e catálogo inicial de oito conectores opcionais.
- Contratos IPC já existentes foram conectados às novas capacidades; migrações 010–012 preservam checksums e são aplicadas em ordem.
- Limites de conectores são explícitos: catálogo/configuração local não significa integração ativa.

### Etapa 2 — Coleta e sincronização
- Captura visível de reclamações e motivos de devolução no Mercado Livre e Shopee, com redação de PII e deduplicação por referência externa.
- A sincronização em lote percorre contas ativas por ID e só usa abas do mesmo marketplace cuja identidade visível coincide; contas sem aba correspondente são marcadas como ignoradas. Nenhuma sessão é alternada.
- A captura de oferta registra frete grátis/valor quando identificado, prazo textual visível, rótulo patrocinado visível e até dez URLs de imagens visíveis.

### Etapa 3 — Financeiro e concorrência
- Lucro realizado calcula receita líquida menos custos efetivos informados e exige evidência; dados manuais são rotulados `REALIZED_FROM_REPORTED_INPUT`, não como captura automática.
- Comparação competitiva inclui frete e prazo; imagens são comparadas apenas por hash idêntico quando os hashes existem. Similaridade visual continua `NOT_COMPUTED`.

### Etapa 4 — Operação e automação
- Modos persistidos `AUTO_PILOT`, `AUTO_ASSISTED` e `MANUAL_GUIDED`, com política invariável: `publish=false`, `campaignExecution=false`, aprovação humana e verificação pós-salvamento obrigatórias.
- Agendamento de análises e relatórios JSON roda em ciclos limitados a cinco trabalhos por minuto e impede ciclos concorrentes.
- O painel lateral agora expõe sincronização multi-conta, configuração do modo e agendamento de análises/relatórios.
- Propostas de campanha/ofertas podem ser criadas e revisadas localmente; a aprovação não autoriza uma escrita remota sem adapter seguro.

### Etapa 5 — Importação e recuperação
- PDF digital pode ser interpretado de forma conservadora e enviado ao staging. OCR, tabelas complexas e fontes CMap permanecem fora do escopo.
- Verificação pós-alteração registra valor observado fornecido pelo verificador; não prova por si só que o serviço clicou em salvar. O plano de rollback é somente leitura.

## Classificação dos 27 itens anteriormente ausentes

| ID | Capacidade | Estado 3.10.2 | Observação |
|---:|---|---|---|
| 46–47 | Reclamações e motivos de devolução | Parcial | Captura de texto visível em Mercado Livre/Shopee; Amazon e todas as rotas exigem homologação. |
| 52–53 | Sincronização de múltiplas contas e marketplaces habilitados | Parcial | Lote por conta/marketplace e painel; depende das abas já abertas e da identidade detectável. |
| 80 | Lucro realizado | Parcial | Cálculo local a partir de valores reais informados/importados com evidência; sem conciliação automática completa. |
| 128 | Comparar frete e prazo | Parcial | Captura visível e comparação quando ambos os lados possuem dados. |
| 130 | Comparar imagens | Parcial | URL visível e hash idêntico quando fornecido; sem percepção de similaridade. |
| 132 | Identificar anúncios patrocinados | Parcial | Detecta rótulos textuais visíveis em páginas suportadas. |
| 178–179 | Preparar/executar alterações de campanhas | Parcial | Propostas e revisão; execução remota bloqueada até adapter/homologação. |
| 195 | Criar variações de ofertas | Parcial | Variações persistidas como propostas, não publicadas. |
| 246–248 | Modos de operação | Parcial | Modos persistidos; autonomia limitada a análise/sugestões, sem escrita remota. |
| 256 | Agendamento de análises | Parcial | Agendamento, execução periódica e registro no banco; Vitest/runtime não validados aqui. |
| 258 | Relatórios automáticos | Parcial | Relatório JSON gerado e armazenado; exportação automática CSV/XLSX não habilitada. |
| 284 | Publicar alterações autorizadas | **Não implementado** | Sem adapter e homologação real, publicação continua desativada. |
| 287 | Verificar alterações salvas ponta a ponta | Parcial | Registra observação/URL e compara; não há leitura após salvar automatizada. |
| 289 | Reverter alterações | Parcial | Plano de rollback read-only; escrita reversa ainda indisponível. |
| 292 | Importar PDF | Parcial | Texto digital para staging; sem OCR/CMap e com revisão manual obrigatória. |
| 293–299 | APIs oficiais, serviços externos, Trends, GA4, Search Console, SEO e inteligência marketplace | Parcial | Catálogo e configuração local; adapters OAuth/API e testes de conexão não implementados. |

**Classificação resultante:** 174 implementados no código, 190 parciais/não comprovados e 1 não implementado (365 no total). O estado “parcial” não significa pronto para produção.

## Limitações/pendências externas

1. API oficial e OAuth (Mercado Livre, Shopee, Amazon SP-API, GA4, Search Console, fornecedores SEO/inteligência) exigem credenciais, escopos e adapters específicos que não estão implementados.
2. Não houve teste em conta real de vendedor nem Chrome/Edge real.
3. Não houve publicação nem edição remota de campanha/oferta.
4. Lucro realizado é baseado em conciliação/entrada ou importação revisada, não em sincronização de todos os extratos.
5. PDF digitalizado requer OCR externo; PDF com codificação de fonte CMap pode resultar em texto parcial.

## Artefatos

- `packages/local-agent/migrations/012_default_marketplaces_connectors.sql`
- `packages/local-agent/src/importers/pdf.ts`
- `packages/extension/panel/panel.html`, `panel.js`, `panel.css`
- `packages/extension/content/mercado-livre.js`, `shopee.js`
- `packages/local-agent/test/local-agent.test.ts`, `tabular.test.ts`
- `packages/extension/test/extension.test.ts`
