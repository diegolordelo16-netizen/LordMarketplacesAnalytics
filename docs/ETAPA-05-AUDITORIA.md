# Etapa 05 — Auditoria dos requisitos

Base 3.13.0 (master b439433). Candidata 3.14.0 na branch validation/3.14.0-etapa-05. Metadados de distribuição ainda 3.13.0.

| ID | Requisito | Evidência de implementação e limite |
|---|---|---|
| 161 | Margem negativa | finance.profitability, registros por anúncio em período exato, todos os custos explicitados; NO_DATA/CONFLICT quando ausentes. |
| 165 | Rentabilidade entre produtos | Agrupamento pelo produto vinculado à conta, margem e cobertura de anúncios; não somar subtotais desconhecidos. |
| 166 | Campanhas Ads | ads.dashboard e tela própria por conta, campanha e anúncio. |
| 167 | Investimento | Valor observado por entidade e janela; não soma campanhas com seus anúncios. |
| 168 | Cliques e impressões | Métricas observadas, CTR e CPC com denominadores válidos. |
| 169 | ROAS | Receita atribuída/investimento positivo. |
| 170 | ACoS | Investimento/receita atribuída positiva. |
| 171 | TACoS | GMV e investimento de conta com janelas e filtros explícitos compatíveis, nulo caso contrário. |
| 172 | Campanhas deficitárias | ads.reconcile e migration 031, lucro atribuído registrado de receita líquida e custos explícitos da mesma campanha/snapshot; não prova lucro incremental. |
| 173 | Anúncios para mais investimento | Sinal de revisão com receita atribuída superior ao gasto, pedidos atribuídos, estoque positivo e lucro registrado positivo; não ordem de aumento. |
| 174 | Orçamento sem resultado | Gasto positivo e receita atribuída explicitamente zero em janela reconhecida; dado ausente não é zero. |
| 178 | Preparar alterações de campanha | Rascunho local com baseline, alterações, motivo e revisão por super_admin. |
| 179 | Executar alterações autorizadas | **PARCIAL**: aprovação, execução manual pelo vendedor e recibo HUMAN_REPORTED. Executor remoto automatizado de campanhas ainda não implementado; não há verificação independente de alterações remotas. |
| 182 | Gestão de variações | **PARCIAL**: CRUD de rascunhos e revisão local; CRUD remoto depende de adaptador real. |
| 185 | Sugestões de imagens | Prévia de arquivo local decodificado, resolução, enquadramento, texto alternativo e checklist de revisão; não certifica adequação às regras do marketplace. |
| 187 | Preparar troca de capa | Rascunho vinculado a anúncio, snapshot inicial e hash da imagem da mesma conta; prévia e aprovação. Upload remoto não implementado. |
| 194 | Duplicar anúncios quando permitido | **PARCIAL**: proposta e revisão local; permissão de duplicação e execução remota não verificadas. |
| 195 | Criar variações de ofertas | **PARCIAL**: criação e edição de proposta local; publicação remota não implementada. |
| 196 | Medir resultados | operation.measure: antes/depois após relato manual, janelas encerradas, não sobrepostas, iguais e filtros compatíveis; não prova causalidade ou execução. Duplicação não tem ID novo verificável. |
| 197 | Monitorar estoque | inventory.dashboard, recência, histórico e armazéns; sem somar SKU compartilhado. |
| 198 | Risco de ruptura | Estoque zero ou cobertura observada <=7 dias, somente com janela de vendas explícita para calcular cobertura. |
| 203 | Cruzar estoque e Ads | Sinal de estoque zero e gasto positivo no mesmo snapshot, sem afirmar simultaneidade. |
| 205 | Perguntas pendentes | Indicadores explícitos por anúncio e snapshots da área de perguntas. |
| 206 | Problemas operacionais | Histórico de áreas e sinais de estoque, perguntas, devoluções e reputação; depende de captura disponível. |

## Debug e verificação
- CI 137 aprovada (primeira tela Ads).
- CI 147 falhou no TypeScript (TS2698 no spread de linha SQLite); corrigido em 78d7fb1.
- CI 153 aprovada em da63a79: 340 Vitest, 30 regressões, 581/581 verificações estáticas, 31 migrações, 181 objetos, zero violações FK e zero vulnerabilidades npm detectadas.
- Revisões de isolamento e transição atômica de propostas em 6a25bb1 e commits posteriores exigem CI final própria.
- Limites adotados: UTC, recência e período de origem separados, teto de consulta de snapshots, cobertura de estoque de sete dias como sinal inicial, confirmação explícita de custos e conta verificada.
- Não se efetuou nenhuma alteração real em campanhas ou anúncios. A aprovação do desenvolvimento não autoriza alterações financeiras remotas. Homologação real dispensada como portão em etapas anteriores, não executada nesta etapa.
- Não declarar os 24 requisitos integralmente concluídos: 179, 182, 194 e 195 permanecem parcialmente implementados no que se refere à escrita remota. Nenhum seletor ou resultado de execução será simulado.
- Master 3.13.0 preservada. Não iniciar etapa 06 sem concluir/aceitar limitações da etapa 05.
