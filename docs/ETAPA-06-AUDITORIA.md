# Progresso da atualização até 4.0.0

| Etapa | Estado verificado | Evidência ou pendência |
|---|---|---|
| 00 — Diagnóstico | Integrada | Auditoria de requisitos disponível no repositório. |
| 01 — Validação | Integrada | PR #1. |
| 02 — Segurança e estabilidade | Integrada | PR #2. |
| 03 — Extensão e coleta | Integrada com limites | PR #3, 3.12.0. Consultar `ETAPA-03-PENDENCIAS.md` para cobertura de interfaces e homologação. |
| 04 — Dashboard e KPIs | Integrada | PR #4, 3.13.0 em master. |
| 05 — Financeiro, publicidade, estoque e anúncios | Parcial em revisão | PR #5, CI #182 aprovada. A matriz da etapa identifica os quatro requisitos parciais. |
| 06 — Concorrência, SEO e pós-venda | Em execução | Primeira entrega de pós-venda. Concorrência e SEO têm fluxos existentes a auditar. |
| 07 — IA e automações | A auditar | Agentes, memória e propostas já existem. Validar cobertura e operação assistida. |
| 08 — Conectores e relatórios | A auditar | Conferir suporte efetivo por conector, escopo e formato de relatório. |
| 09 — Windows e homologação | A auditar | Conferir empacotamento e executar homologação em Windows. |
| 10 — Auditoria final 4.0.0 | Pendente | Consolidar cobertura dos requisitos e evidência de validação antes de versionar. |

## Entrega inicial de pós-venda

O painel apresenta o volume observado por tipo e fonte nos últimos 30 dias, a média das avaliações com nota explícita, o histórico de reputação capturado para a loja e motivos de devolução recorrentes quando o texto registrado coincide. A contagem descreve os registros locais do período. Notas ausentes permanecem vazias e a cobertura parcial das capturas permanece visível.

Novos relatos manuais usam a fonte `F_USER_INPUT`. A migração 035 corrige registros antigos quando o log da operação identifica sua origem manual. A gravação direta exige uma conta ativa e valida o vínculo de anúncios à mesma loja.

## Revisão da visibilidade SEO

A presença e o share Top 20 usam capturas com posições válidas e sem empates de posição. Capturas vazias ou ambíguas são contabilizadas separadamente no painel. O registro do cálculo é transacional.

## Comparativo de concorrentes

O histórico de cada relação no painel mostra as diferenças observadas de preço, frete e prazo, o patrocínio informado e a contagem de arquivos idênticos por hash. Campos sem observação ficam vazios. A resposta é descartada se o usuário trocar a loja, o produto ou o filtro enquanto a consulta está em andamento.

A comparação utiliza uma única captura recente identificada por data e ID. Capturas antigas ficam no histórico, campos ausentes continuam sem valor e a consulta do painel verifica a loja selecionada.


## Pesquisa de volume do Google Ads

O OpenSEO, licenciado sob MIT, usa o DataForSEO em seus fluxos de pesquisa. O painel SEO & Keywords adota a consulta de volume via contrato público do provedor. A implementação usa o serviço local existente.

O operador informa as credenciais da API e confirma uma consulta paga de até 20 termos. O painel mostra volume médio mensal, concorrência em Google Ads, índice de concorrência e até 12 observações mensais. A consulta usa Brasil e português. Resultados ausentes permanecem vazios. O custo exibido vem da resposta do provedor. As credenciais são transitórias.

A consulta fornece sinal de demanda no Google. A visibilidade e a demanda dos marketplaces continuam baseadas nas fontes próprias já existentes. A validação automatizada usa respostas simuladas do provedor.

Referências

- [OpenSEO no commit revisado](https://github.com/every-app/open-seo/tree/6f68494e92a695db17f4b22da25e84b9bf1e582c)
- [Licença MIT do OpenSEO](https://github.com/every-app/open-seo/blob/6f68494e92a695db17f4b22da25e84b9bf1e582c/LICENSE)
- [Documentação DataForSEO Search Volume Live](https://docs.dataforseo.com/v3/keywords_data/google_ads/search_volume/live/)
