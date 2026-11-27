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
