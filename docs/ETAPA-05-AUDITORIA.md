# Etapa 05 — Auditoria dos requisitos

Base 3.13.0 (master b439433). Candidata 3.14.0 na branch validation/3.14.0-etapa-05. Metadados da candidata sincronizados em 3.14.0; integração depende da CI e do escopo concluído.

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
| 179 | Executar alterações autorizadas | **PARCIAL**: orçamento diário, pausa, reativação e ROAS objetivo assistidos no Mercado Livre, com autorização única, limites por loja e nova leitura independente da aba. Outros tipos de alteração e adaptadores de escrita dos demais marketplaces não concluídos. |
| 182 | Gestão de variações | **PARCIAL**: edição assistida de preço e estoque; API legada de criação, estoque e remoção restrita; verificações de titularidade, baseline e releitura. Edição de atributos de famílias User Products e outros marketplaces ainda não concluída. |
| 185 | Sugestões de imagens | Prévia de arquivo local decodificado, resolução, enquadramento, texto alternativo e checklist de revisão; não certifica adequação às regras do marketplace. |
| 187 | Preparar troca de capa | Rascunho vinculado a anúncio, snapshot inicial e hash da imagem da mesma conta; prévia e aprovação. Upload remoto não implementado. |
| 194 | Duplicar anúncios quando permitido | **PARCIAL**: executor de clique único do Mercado Livre; alerta novo explícito com ambos os IDs mais nova captura pode vincular a cópia. Sem ambos os IDs, permanece candidato. Cobertura de outros fluxos e marketplaces pendente. |
| 195 | Criar variações de ofertas | **PARCIAL**: criação assistida, criação legada pela API oficial e nova condição de venda para User Product existente (mesmo estoque compartilhado). Validação de conta, categoria, lista completa de ofertas, ID novo e releitura. Criação de novo produto físico na família e adaptadores adicionais pendentes. |
| 196 | Medir resultados | **IMPLEMENTADO no escopo de operações com evidência**: janelas encerradas equivalentes; variação legada, campanhas, cópia vinculada e oferta UP confirmada, com escopos explícitos; candidatos sem prova não viram operações confirmadas. Não atribui causalidade. |
| 197 | Monitorar estoque | inventory.dashboard, recência, histórico e armazéns; sem somar SKU compartilhado. |
| 198 | Risco de ruptura | Estoque zero ou cobertura observada <=7 dias, somente com janela de vendas explícita para calcular cobertura. |
| 203 | Cruzar estoque e Ads | Sinal de estoque zero e gasto positivo no mesmo snapshot, sem afirmar simultaneidade. |
| 205 | Perguntas pendentes | Indicadores explícitos por anúncio e snapshots da área de perguntas. |
| 206 | Problemas operacionais | Histórico de áreas e sinais de estoque, perguntas, devoluções e reputação; depende de captura disponível. |

## Debug e verificação
- CI 137 aprovada (primeira tela Ads).
- CI 147 falhou no TypeScript (TS2698 no spread de linha SQLite); corrigido em 78d7fb1.
- CI 153 aprovada em da63a79: 340 Vitest, 30 regressões, 581/581 verificações estáticas, 31 migrações, 181 objetos, zero violações FK e zero vulnerabilidades npm detectadas.
- CI 180 aprovada em b7116b4 para a execução assistida, com regressões em DOM simulado.
- A migration 034 acrescenta conferência por captura aos relatos manuais de duplicação e variação. A edição exige preço, estoque e rótulo de origem e de destino correspondentes. Criação e duplicação registram candidatos observados mesmo quando o ID é novo no histórico local.
- Limites adotados: UTC, recência e período de origem separados, teto de consulta de snapshots, cobertura de estoque de sete dias como sinal inicial, confirmação explícita de custos e conta verificada.
- Não se efetuou nenhuma alteração real em campanhas ou anúncios. A aprovação do desenvolvimento não autoriza alterações financeiras remotas. Homologação real dispensada como portão em etapas anteriores, não executada nesta etapa.
- Não declarar os 24 requisitos integralmente concluídos: 179, 182, 194 e 195 permanecem parcialmente implementados no que se refere à escrita remota. Nenhum seletor ou resultado de execução será simulado.
- Master 3.13.0 preservada. Não iniciar etapa 06 sem concluir/aceitar limitações da etapa 05.

## Changelog da candidata 3.14.0

- O painel permite medir alterações assistidas de orçamento e edição de variação com leitura posterior correspondente. Capturas parciais, futuras ou com janelas ainda em curso quando coletadas ficam fora da comparação. Uma captura recente incompatível não esconde pares anteriores elegíveis.
- A edição assistida de variação confere preço e estoque em nova aba sem repetir a gravação. A tentativa guarda os IDs das capturas e o painel mostra o antes/depois da própria variação. Uma captura incompleta ou com contexto divergente mantém a conferência pendente.
- O executor recusa o botão de outro anúncio ou formulário aninhado. A conferência de duplicação rejeita um anúncio que já tinha capturas anteriores à tentativa.
- A medição consulta o snapshot exato do candidato de criação ou duplicação. O painel exibe seu estado observado e mantém a confirmação da operação pendente. A homologação em conta real fica para depois da implementação técnica, conforme autorização do usuário.
- A criação assistida também busca um candidato único em nova leitura do editor. A conferência mantém o status de candidato e impede associar a mesma entidade a duas operações da loja.
- A duplicação assistida compara os IDs visíveis imediatamente antes do clique com uma leitura nova no mesmo recorte da loja. Um único anúncio compatível pode ser registrado como candidato. A conferência não aciona diálogos nem repete a gravação.
- A migração 036 registra o estado inicial e o estado aprovado. Pausa e reativação exigem formulário dedicado, orçamento constante dentro do teto configurado e conferência do status e do orçamento em nova aba. A migração 035 já está reservada no PR da etapa 06.
- A migração 037 registra a criação pela API oficial de variações legadas. A proposta aprovada informa atributos e IDs das imagens. O executor compara o apelido autenticado e a titularidade do anúncio, aplica os limites da loja, reserva a operação antes do POST e guarda o ID retornado. O GET separado confirma preço, estoque, atributos e imagens. Se a resposta se perder, a operação fica pendente e não repete a escrita.
- A migração 038 registra a remoção de variação legada pela API oficial. A execução exige uma proposta específica, preço correspondente, estoque zero, nenhuma venda e outra variação no anúncio. A confirmação depende de uma nova leitura da lista do anúncio e a remoção nunca é reenviada automaticamente.

- Migration 039: edição de estoque por API em variação legada ativa, com preço mantido, baseline aprovado, lista completa de IDs, reserva única e dupla releitura. Adicionada proteção de conflito entre publicação de tarefas e tentativas assistidas pendentes. Homologação real dispensada; CI do novo SHA deve ser verificada.

- Medição de operações confirmadas pela API: mantém o estado exato da variação e compara métricas do anúncio inteiro em janelas compatíveis, fora do intervalo de execução. Teste com janela ausente e janela válida. Não atribui causalidade.

- Migration 040: alteração assistida do ROAS objetivo, em centésimos de multiplicador (100–3500), com orçamento mantido, autorização de uso único, formulário dedicado, leitura em documento novo e regressão simulada. Não testada em conta real.

- Duplicação: confirmação explícita fresca com os dois IDs, vinculada à tentativa por token e conferida por nova captura da mesma loja. Sem confirmação inequívoca, permanece candidato. Quando vinculada, compara original antes e cópia depois em janelas equivalentes; não demonstra causalidade. Testes simulados incluem recusa de ID divergente.

- CI 207 e 208 aprovadas: versão 3.14.0, ROAS objetivo, duplicação vinculada e comparação da cópia. CI 203 encontrou erros TS2532 corrigidos; CI 205 detectou teste com versão antiga fixa, substituído por comparação com o package.json.
- Migração 041: oferta adicional de UP existente, com condição de venda diferente, estoque compartilhado inalterado, titularidade do vendedor, consulta completa limitada a 50 ofertas, aprovação e reserva transacional, ID de resposta e leitura independente. Bloqueio de repetição por UP/tipo de publicação, incluindo propostas distintas. Sem homologação real. Referência oficial: https://developers.mercadolivre.com.br/pt_br/preco-variacao .
