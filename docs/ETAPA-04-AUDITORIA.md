# Etapa 04 — Dashboard e indicadores

Base: master 3.12.0 (ac59f94). Candidata: 3.13.0. Escopo: 24 requisitos do Plano-Execucao-LordMarketplacesAnalytics.md. CI 110 aprovada para 94bdfca; os commits subsequentes exigem nova CI. Homologação exclusivamente real dispensada para avanço, não executada.

| ID | Requisito | Implementação e limite |
|---|---|---|
| 66 | Faturamento total | kpi.dashboard GMV observado; cobertura e recência; não equivale a período financeiro conciliado. |
| 67 | Total de vendas | Unidades vendidas em KPIs/histórico; ausente fica nulo. |
| 68 | Total de pedidos | kpi.dashboard/orders; ausência não é zero. |
| 69 | Ticket médio | GMV/pedidos, denominador positivo; razão observada, janela da origem pode ser desconhecida. |
| 80 | Lucro realizado quando possível | finance.realized.summary/list, painel e histórico; sobreposição e escopos misturados retornam nulo; cobertura contábil não comprovada. |
| 86 | Histórico de todos os indicadores | kpi.history: observações e razões disponíveis, separação por loja e filtros; lucro em histórico próprio. Indicadores sem fonte verificável não são inventados. |
| 87 | Gráficos de evolução | SVG com datas reais, lacunas e seletor de métricas. |
| 88 | Hoje vs ontem | Atalho UTC; hoje parcial, sem alerta verificado para janela aberta. |
| 89 | 7 dias vs anteriores | Dias completos UTC; comparação de snapshots e filtros compatíveis. |
| 90 | 30 dias vs anteriores | Dias completos UTC; mesmas salvaguardas. |
| 91 | Mês atual vs anterior | Dias completos equivalentes limitados ao menor mês; primeiro dia sem janela completa. |
| 94 | Comparação entre marketplaces | kpi.compare por conta e kpi.compare.detail agrupado por marketplace. |
| 97 | Quedas de vendas | GMV/pedidos caem 10% ou mais com filtros compatíveis; sinal, não causa. |
| 98 | Aumento de custos | Custos individuais sobem 10% ou mais; não somar taxas que possam se sobrepor. |
| 99 | Perda de conversão | Queda de 1 p.p., pelo menos 100 visitas em cada observação comparável. |
| 100 | Campanhas deficitárias | Sinal de investimento acima da receita atribuída da campanha com janela explícita; prejuízo contábil requer margem e demais custos efetivos. |
| 101 | Potencial de crescimento | Pedidos aumentam 10% (base de pelo menos 10), conversão não inferior e estoque positivo; hipótese, não previsão. |
| 327 | Funcionalidades na interface | Telas de executivo, comparações, inteligência, coleta e demais módulos existentes; auditoria de handlers não comprova que todos os IPCs tenham fluxo integral de UI. |
| 329 | Filtro marketplace | Executivo e comparação, também aplicado ao histórico. |
| 330 | Filtro conta | Seletor global e comparação; escopo financeiro explicitado. |
| 331 | Filtro período | Recência de captura 1/7/30/90/365 dias e intervalos personalizados no comparativo; período da origem separado. |
| 332 | Filtro SKU/anúncio | IDs internos em executivo e comparação, filtros SQL e exclusão de totais gerais. |
| 338 | Explicação de fórmulas | Cartão de fórmulas no executivo e distinção de cobertura/observações. |
| 343 | Nenhum botão sem funcionamento | Auditoria estática: 97 ações declaradas com handler ou tratamento explícito. Testes VM de filtros, gráficos e presets; teste integral de interação humana não executado. |

## Validação
- Vitest: isolamento, ausência de dados, recência, compatibilidade de filtros, diagnósticos, campanha e conflitos de lucro.
- Regressões Node: atalhos UTC, lacunas do gráfico, métricas adicionais e escopo do executivo.
- CI final: executar e verificar todos os jobs; nenhum resultado pendente é aprovação.
- Critérios não comprovados: conciliação financeira com relatórios reais, completude das interfaces externas, períodos de origem em snapshots antigos, cobertura integral de todo IPC por interface e teste real de cada botão. O usuário dispensou testes exclusivamente reais para avanço, não autorizou inventar dados.
- Decisões técnicas: UTC para janelas de captura, thresholds conservadores e uso de IDs internos. A master permanece 3.12.0 até aprovação da etapa 04.
