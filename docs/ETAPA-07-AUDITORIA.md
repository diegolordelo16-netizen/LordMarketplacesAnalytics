# Etapa 07 — IA, aprendizado e automações (em execução)

Base: candidata 3.15.0, commit 4214c5b7d3d6124149a2de7500b4a965a9f83fe6, CI 219 aprovada. Branch 3.16.0 de desenvolvimento; não é release.

## Primeira revisão
- Corrigido retorno prematuro do painel que escondia feedback e resultados das recomendações.
- Execução individual e conjunta usa análise real por loja/anúncio, não contexto vazio do navegador. Filtro por agente, paginação do serviço e seleção de ID externo no escopo da conta.
- Janela de captura explícita e compatível exigida antes de consumir KPIs; ausências não viram zero. Margem usa registro realizado do intervalo exato com custos confirmados; não usar estimativa como lucro real.
- AI Director não prioriza ação de tráfego sem margem confirmada; nenhuma ação final com baixa confiança. Estimativa de impacto desabilitada neste fluxo por falta de evidência causal.
- Recomendação persistida para revisão humana; nenhuma ação remota nova.

Pendências: workspace Gemini com contexto e histórico, deduplicação de feedback/playbooks, evidências externas SEO nos agentes, automação e auditoria de auto-upgrade, validação real separada.

## Segunda revisão
- Feedback idempotente, última observação por recomendação e playbook segregado por loja/agente/ação; resultados negativos rebaixam o padrão. Evidência observacional, sem causalidade.
- Workspace usa capturas numéricas e referências SEO da loja, com confirmação explícita, histórico por usuário/loja e indisponibilidade real quando não há chave. Memória segregada e indicadores de custo/tokens de 24h.
- Paginação conectada ao painel. Restam revisão de evidências SEO no Director, automação e auto-upgrade, homologação externa.


## Terceira revisão — integração da base 3.15.0 e evolução 3.16.0
- PR #11 usa a revisão final de código da etapa 06 (b5266f88), mantém os 14 arquivos do PR #10 e preserva as migrations 044 e 045. CI 224 aprovada apenas para o PR #10 anterior.
- Evidência DataForSEO dos últimos 30 dias vinculada à conta e ao título do anúncio, com ID, escopo, volume/dificuldade e data. Não é posição nem demanda interna. Agentes não inventam impacto financeiro ou receita Ads zero; baixa confiança não gera ação final. Simulação declarada separada de analysis.run.
- Playbook observacional por conta/agente/ação retorna como evidência, não autorização; mínimo três sucessos e 75% de taxa observada. Debate externo requer confirmação.
- Gemini serializa chamadas, verifica orçamento global e por conta e aplica cooldown após erro de cota/autorização. Consumo continua estimado; rede incerta não comprova cobrança.
- Análises agendadas percorrem páginas em uma transação e registram cobertura; escopos acima de 3000 anúncios são recusados, exigindo divisão. Ciclo limita trabalho. Nenhuma nova escrita comercial automática.
- Auto-upgrade: correções de validação e hunks, revisão/exportação de diff com código atual e consentimento explícito. IPC não declara aplicação/rollback fictícios. A aplicação de upgrade na instalação exige build/release validado; fluxo completo de instalação e rollback de código continua pendente (requisito 245).
- Sete casos de regressão adicionados em local-agent.test.ts. Executados seis cenários direcionados via extração/adaptação sintática das funções puras (Ads/Director, SEO, hunks), não equivalentes à suíte TypeScript/Vitest. Sintaxe JS do painel conferida. Não executar API paga ou contas reais.
- CI integral do PR #11 não disponível nesta sessão (workflow limita PRs à master e não há execução do SHA novo). Pendem typecheck, build, regressões, smoke e validação integral das novas migrations. A etapa 06 também permanece sem nova CI. Não declarar etapa 07 integralmente encerrada nem publicar em master sem revisão.
