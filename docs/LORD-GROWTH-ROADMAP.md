# Lord Growth Intelligence — plano incremental
Base: 3.19.0, commit e559f22e69b655dd44c6c7b20b21f7267adace81. Numeração proposta; não é release.
## Backlog (IDs da proposta comercial)
| Etapa | Versão alvo | Funções |
|---|---|---|
| 11 | 3.20.0 | 01 Radar de vendas perdidas; 32 árvore de causas; 02 simulador por anúncio; 03 funil; 05 produtos subaproveitados; 33 priorização |
| 12 | 3.21.0 | 06 Product Hunter; 07 mercados mal atendidos; 08 tendências; 09 oportunidades entre canais; 10 novos concorrentes; 11 reclamações concorrentes |
| 13 | 3.22.0 | 12 elasticidade; 13 vantagem competitiva; 14 guerra de preços; 15 descontos desperdiçados |
| 14 | 3.23.0 | 16 orçamento Ads; 17 saturação; 18 horários; 19 dependência de Ads; 20 escala |
| 15 | 3.24.0 | 04 engenharia reversa de anúncios; 21 auditor visual; 22 intenção; 23 atributos comerciais |
| 16 | 3.25.0 | 25 matriz de portfólio; 26 previsão SKU; 27 capital em estoque; 28 kits; 29 lacunas; 30 ciclo de vida |
| 17 | 3.26.0 | 31 simulador digital; 34 metas; 35 memória lucrativa; 40 lançamentos |
| 18 | 3.27.0 | 24 simulador de busca; 36 share of search; 37 Buy Box; 38 força comercial; 39 benchmark |
| 19 | 3.28.0 | 41 sazonalidade; 42 frete; 43 reputação; 47 capital imobilizado; 50 saúde preditiva |
| 20 | 3.29.0 | 44 recompra; 45 coortes; 46 fornecedores; 48 expansão; 49 regiões |
## Etapa 11
Primeira entrega: decomposição de GMV por tráfego, conversão e ticket (média das seis ordens de substituição, em centavos); radar de quedas observadas por anúncio. Somente comparações verificadas pelo serviço existente, sem inferência causal. Queda histórica não é receita recuperável. Não somar perdas individuais como perda líquida da loja; cobertura integral não comprovada. Sem denominadores válidos, apenas a variação de GMV é exibida. Janela padrão: sete dias completos UTC versus sete anteriores. Sem alteração remota.
Segunda entrega: cenários de recuperação de tráfego ou conversão (25%, 50% e 100% da diferença histórica), com ticket constante, amostra mínima de 100 visitas e 10 pedidos nos dois períodos; hipóteses alternativas e não aditivas. Limite pelo estoque observado e mix de unidades quando conhecidos; estoque zero bloqueia projeções. Sem estoque/mix conhecidos, não priorizar. Sinal de tráfego subaproveitado: visitas pelo menos 20% inferiores às anteriores e conversão não inferior; não implica alta conversão relativa ao mercado, rentabilidade ou demanda futura. Painel de oportunidades, ranking por GMV incremental no cenário de 25% e simulação de contribuição com margem e custo explícitos do operador. Funil parcial: visitas e pedidos com períodos compatíveis; impressões totais, carrinhos e checkout ausentes no contrato, não imputados. Testes unitários e regressão IPC acrescentados.
Validação: CI 46081477006 aprovou apenas a primeira entrega (head f661fbd); segunda entrega requer CI própria. Pendentes: coleta de etapas adicionais do funil onde efetivamente expostas, priorização financeira em lote com custos e margens conciliados, verificação de UI e validação da nova CI. Nenhuma versão estável 3.20.0 publicada.
## Portões comuns
Reutilizar coleta e IPC; dados ausentes não são zero; não atribuir causalidade a observações; estimativas identificadas com premissas e incerteza; isolar conta e escopo; verificar testes unitários, integração, build, auditoria e CI Linux/Windows antes de integrar. Dados reais e homologação externa são separados. Nenhuma mutação comercial automática sem política explícita.
